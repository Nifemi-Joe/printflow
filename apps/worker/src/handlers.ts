import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { applyPaymentEvent, enqueueJob, expireDueChecks, transitionOrder, withTransaction, type JobRow } from "../../../packages/data/src/index.js";
import { DocumentRejectedError, prepareDocument, type ProcessingTools, type Scanner } from "../../../packages/documents/src/index.js";
import type { Mailer, PaymentProvider, SmsSender } from "../../../packages/providers/src/index.js";
import { objectKeys, type ObjectStorage } from "../../../packages/storage/src/index.js";

export interface WorkerDeps {
  pool: Pool;
  log: Logger;
  storage: ObjectStorage;
  scanner: Scanner;
  tools: ProcessingTools;
  mailer: Mailer;
  sms: SmsSender;
  payments: PaymentProvider | null;
  webUrl: string;
}

/** Order events worth an SMS (it costs money and interrupts): only ones the student must act on. */
const SMS_STATUSES = new Set(["READY_FOR_PICKUP", "REJECTED", "REFUNDED"]);

/** Thrown for failures that retrying cannot fix. */
export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function notifyUser(d: WorkerDeps, userId: string, kind: string, title: string, body: string, orderId: string | null = null) {
  await d.pool.query(`INSERT INTO notifications (user_id, kind, title, body, order_id) VALUES ($1, $2, $3, $4, $5)`, [userId, kind, title, body, orderId]);
}

// ---------------------------------------------------------------- documents

export async function processDocument(d: WorkerDeps, job: JobRow): Promise<void> {
  const versionId = String(job.payload.versionId);
  const { rows } = await d.pool.query<{ asset_id: string; storage_key: string; processing_status: string; owner_user_id: string; title: string }>(
      `SELECT v.asset_id, v.storage_key, v.processing_status, a.owner_user_id, a.title
       FROM document_versions v JOIN document_assets a ON a.id = v.asset_id WHERE v.id = $1`,
      [versionId],
  );
  const v = rows[0];
  if (!v) throw new PermanentJobError(`document version ${versionId} not found`);
  if (v.processing_status === "READY" || v.processing_status === "REJECTED") return;
  await d.pool.query(`UPDATE document_versions SET processing_status = 'PROCESSING' WHERE id = $1`, [versionId]);

  const work = await mkdtemp(join(tmpdir(), "pf-job-"));
  try {
    const original = join(work, "original");
    await d.storage.downloadToFile(v.storage_key, original);

    // 1. Malware scan of the untouched upload, before any parser sees it.
    const scan = await d.scanner.scanFile(original);
    if (scan.verdict === "ERROR") throw new Error(`scanner unavailable: ${scan.error}`);
    if (scan.verdict === "INFECTED") {
      await d.pool.query(
          `UPDATE document_versions SET scan_status = 'INFECTED', scan_engine = $2, processing_status = 'REJECTED', failure_reason = 'This file was flagged by our malware scanner and cannot be printed.' WHERE id = $1`,
          [versionId, scan.engine],
      );
      await d.storage.delete(v.storage_key);
      await d.pool.query(
          `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, details) VALUES ('SYSTEM', 'document.malware_detected', 'document_version', $1, $2)`,
          [versionId, JSON.stringify({ signature: scan.signature, engine: scan.engine })],
      );
      await notifyUser(d, v.owner_user_id, "document.rejected", "Document rejected", `"${v.title}" was flagged by our malware scanner and was deleted.`);
      return;
    }

    // 2. Validate, convert (DOCX), normalise, count pages, render previews.
    let prepared;
    try {
      prepared = await prepareDocument(original, work, d.tools);
    } catch (e) {
      if (e instanceof DocumentRejectedError) {
        await d.pool.query(`UPDATE document_versions SET scan_status = 'CLEAN', scan_engine = $2, processing_status = 'REJECTED', failure_reason = $3 WHERE id = $1`, [
          versionId,
          scan.engine,
          e.message.slice(0, 500),
        ]);
        await notifyUser(d, v.owner_user_id, "document.rejected", "We could not use this document", `"${v.title}": ${e.message}`);
        return;
      }
      throw e;
    }

    // 3. Store the print rendition and previews, then flip to READY in one update.
    const printKey = objectKeys.print(v.asset_id, versionId);
    await d.storage.putFile(printKey, prepared.printPdfPath, "application/pdf");
    for (const [i, p] of prepared.previewPaths.entries()) {
      await d.storage.putFile(objectKeys.preview(v.asset_id, versionId, i + 1), p, "image/png");
    }
    const printSha = await sha256File(prepared.printPdfPath);
    await d.pool.query(
        `UPDATE document_versions SET scan_status = 'CLEAN', scan_engine = $2, detected_type = $3, page_count = $4, page_size = $5,
                                      print_storage_key = $6, print_sha256 = $7, preview_pages = $8, processing_status = 'READY', failure_reason = NULL
         WHERE id = $1`,
        [versionId, scan.engine, prepared.detectedType, prepared.pageCount, prepared.pageSize, printKey, printSha, prepared.previewPaths.length],
    );
    await notifyUser(d, v.owner_user_id, "document.ready", "Document ready", `"${v.title}" is ready to print (${prepared.pageCount} page${prepared.pageCount === 1 ? "" : "s"}).`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Called when DOCUMENT_PROCESS gives up: never leave a version stuck in PROCESSING. */
export async function documentGaveUp(d: WorkerDeps, job: JobRow, error: string): Promise<void> {
  await d.pool.query(
      `UPDATE document_versions SET processing_status = 'FAILED', failure_reason = $2 WHERE id = $1 AND processing_status IN ('PENDING', 'PROCESSING')`,
      [String(job.payload.versionId), `Processing failed: ${error}`.slice(0, 500)],
  );
}

// ---------------------------------------------------------------- orders & money

export async function expireOrder(d: WorkerDeps, job: JobRow): Promise<void> {
  const orderId = String(job.payload.orderId);
  await withTransaction(d.pool, async (c) => {
    const { rows } = await c.query<{ status: string; due: boolean }>(`SELECT status, payment_due_at <= now() AS due FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const o = rows[0];
    if (!o || o.status !== "AWAITING_PAYMENT" || !o.due) return;
    await transitionOrder(c, { orderId, to: "EXPIRED", scope: { kind: "SYSTEM" }, actorUserId: null, reason: "Payment window closed" });
    await c.query(`UPDATE payments SET status = 'ABANDONED' WHERE order_id = $1 AND status = 'INITIATED'`, [orderId]);
  });
}

/** Safety net: expire any unpaid orders whose individual job was missed. */
export async function sweepExpiredOrders(d: WorkerDeps): Promise<number> {
  const { rows } = await d.pool.query<{ id: string }>(`SELECT id FROM orders WHERE status = 'AWAITING_PAYMENT' AND payment_due_at <= now() LIMIT 500`);
  for (const r of rows) await expireOrder(d, { id: "sweep", kind: "ORDER_EXPIRE", payload: { orderId: r.id }, attempts: 1, max_attempts: 1 });
  return rows.length;
}

export async function processRefund(d: WorkerDeps, job: JobRow): Promise<void> {
  const refundId = String(job.payload.refundId);
  const { rows } = await d.pool.query<{ status: string; amount_kobo: string; provider: string; provider_reference: string; provider_refund_reference: string | null }>(
      `SELECT r.status, r.amount_kobo, p.provider, p.provider_reference, r.provider_refund_reference FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1`,
      [refundId],
  );
  const r = rows[0];
  if (!r) throw new PermanentJobError(`refund ${refundId} not found`);
  if (r.status !== "REQUESTED") return;
  if (!d.payments || d.payments.name !== r.provider) {
    throw new Error(`no ${r.provider} payment provider configured for refunds`);
  }
  const { providerRefundReference } = await d.payments.refund({ transactionReference: r.provider_reference, amountKobo: Number(r.amount_kobo) });
  await d.pool.query(`UPDATE refunds SET status = 'PROCESSING', provider_refund_reference = $2 WHERE id = $1 AND status = 'REQUESTED'`, [refundId, providerRefundReference]);

  // The TEST provider has no real gateway to call back, so its completion event
  // is applied here. Real providers confirm by webhook.
  if (r.provider === "TEST") {
    await withTransaction(d.pool, (c) =>
        applyPaymentEvent(c, {
          provider: "TEST",
          eventId: `test_refund_${refundId}`,
          eventType: "refund.processed",
          reference: providerRefundReference,
          amountKobo: Number(r.amount_kobo),
          currency: "NGN",
          signatureValid: true,
          payload: { simulated: true, refundId },
        }),
    );
  }
}

/** Finds INITIATED payments and wallet top-ups whose webhook never arrived and asks the provider. */
export async function reconcilePayments(d: WorkerDeps): Promise<void> {
  if (!d.payments || d.payments.name !== "PAYSTACK" || !("verify" in d.payments)) return;
  const provider = d.payments as PaymentProvider & { verify(ref: string): Promise<{ status: string; amountKobo: number; currency: string; id: string }> };
  const { rows } = await d.pool.query<{ provider_reference: string }>(
      `SELECT provider_reference FROM payments WHERE provider = 'PAYSTACK' AND status = 'INITIATED' AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '2 days'
       UNION ALL
      SELECT provider_reference FROM wallet_topups WHERE provider = 'PAYSTACK' AND status = 'INITIATED' AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '2 days'
        LIMIT 100`,
  );
  for (const p of rows) {
    try {
      const v = await provider.verify(p.provider_reference);
      if (v.status !== "success" && v.status !== "failed") continue;
      await withTransaction(d.pool, (c) =>
          applyPaymentEvent(c, {
            provider: "PAYSTACK",
            eventId: `charge.${v.status}:${v.id}`,
            eventType: v.status === "success" ? "charge.success" : "charge.failed",
            reference: p.provider_reference,
            amountKobo: v.amountKobo,
            currency: v.currency,
            // Obtained by our authenticated call to the provider, not from an inbound request.
            signatureValid: true,
            payload: { source: "reconciliation" },
          }),
      );
    } catch (e) {
      d.log.warn({ err: e, reference: p.provider_reference }, "reconciliation lookup failed");
    }
  }
}

/**
 * Lapses provider verification checks whose renewal date has passed, so a provider who
 * has graduated or left stops being described to students as a current student. The
 * owner is told, because the drop costs them orders.
 */
export async function reverifyProviders(d: WorkerDeps): Promise<number> {
  const expired = await withTransaction(d.pool, (c) => expireDueChecks(c));
  for (const e of expired) {
    const { rows } = await d.pool.query<{ user_id: string; name: string; level: string }>(
        `SELECT sm.user_id, s.name, s.verification_level AS level FROM shops s
                                                                         JOIN shop_memberships sm ON sm.shop_id = s.id AND sm.role = 'OWNER' AND sm.revoked_at IS NULL
         WHERE s.id = $1 ORDER BY sm.id LIMIT 1`,
        [e.shopId],
    );
    const owner = rows[0];
    if (!owner) continue;
    await notifyUser(
        d,
        owner.user_id,
        "provider.reverify_due",
        "Confirm you are still a student",
        `${owner.name}: your verification has reached its renewal date, so your shop now shows as less verified to students. Confirm your university email and matric number again in Verification to restore it.`,
    );
    await enqueueJob(d.pool, "NOTIFY", { userId: owner.user_id, link: "/shop" });
  }
  if (expired.length) d.log.info({ expired: expired.length }, "provider verification checks lapsed");
  return expired.length;
}

// ---------------------------------------------------------------- notifications

export async function sendNotification(d: WorkerDeps, job: JobRow): Promise<void> {
  const userId = String(job.payload.userId);
  const { rows } = await d.pool.query<{ email: string; status: string; phone: string | null; phone_verified: boolean }>(
      `SELECT email, status, phone, phone_verified_at IS NOT NULL AS phone_verified FROM users WHERE id = $1`,
      [userId],
  );
  const u = rows[0];
  if (!u || u.status !== "ACTIVE") return;
  // Wallet notices name their notification; order notices take the latest for the order.
  const n = job.payload.notificationId
      ? await d.pool.query<{ title: string; body: string }>(`SELECT title, body FROM notifications WHERE id = $1 AND user_id = $2`, [Number(job.payload.notificationId), userId])
      : await d.pool.query<{ title: string; body: string }>(
          `SELECT title, body FROM notifications WHERE user_id = $1 AND ($2::uuid IS NULL OR order_id = $2) ORDER BY id DESC LIMIT 1`,
          [userId, job.payload.orderId ? String(job.payload.orderId) : null],
      );
  if (!n.rows[0]) return;
  const path = typeof job.payload.link === "string" && job.payload.link.startsWith("/") ? job.payload.link : `/student/orders${job.payload.orderId ? `/${String(job.payload.orderId)}` : ""}`;
  const link = `${d.webUrl}${path}`;
  await d.mailer.send({
    to: u.email,
    subject: `PrintFlow: ${n.rows[0].title}`,
    text: `${n.rows[0].body}\n\n${job.payload.link ? "Open your wallet" : "View your order"}: ${link}`,
  });
  // SMS is best-effort and sent once: a gateway failure must not make the job
  // retry and repeat the email.
  const wantsSms = job.payload.sms === true || SMS_STATUSES.has(String(job.payload.status ?? ""));
  if (u.phone && u.phone_verified && wantsSms) {
    try {
      await d.sms.send({ to: u.phone, text: `PrintFlow: ${n.rows[0].body} ${link}`.slice(0, 300) });
    } catch (e) {
      d.log.warn({ err: { message: (e as Error).message }, jobId: job.id }, "order sms not delivered");
    }
  }
}

// ---------------------------------------------------------------- retention & privacy

/** Deletes files that no active order needs and whose retention period has passed. */
export async function purgeRetention(d: WorkerDeps, job: JobRow | null): Promise<number> {
  const assetFilter = job?.payload.assetId ? String(job.payload.assetId) : null;
  const { rows } = await d.pool.query<{ id: string; asset_id: string; storage_key: string; print_storage_key: string | null; preview_pages: number | null }>(
      `SELECT v.id, v.asset_id, v.storage_key, v.print_storage_key, v.preview_pages
       FROM document_versions v JOIN document_assets a ON a.id = v.asset_id JOIN universities u ON u.id = v.university_id
       WHERE v.files_purged_at IS NULL AND ($1::uuid IS NULL OR v.asset_id = $1)
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.document_version_id = v.id AND o.status NOT IN ('COLLECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'))
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.document_version_id = v.id AND o.status_changed_at > now() - make_interval(days => u.document_retention_days))
         AND (a.deleted_at IS NOT NULL OR v.processing_status IN ('REJECTED', 'FAILED')
         OR v.created_at < now() - make_interval(days => u.document_retention_days))
         LIMIT 500`,
      [assetFilter],
  );
  for (const v of rows) {
    const keys = [v.storage_key, v.print_storage_key, ...Array.from({ length: v.preview_pages ?? 0 }, (_, i) => objectKeys.preview(v.asset_id, v.id, i + 1))].filter((k): k is string => Boolean(k));
    for (const k of keys) await d.storage.delete(k);
    await d.pool.query(`UPDATE document_versions SET files_purged_at = now() WHERE id = $1`, [v.id]);
  }
  if (rows.length) d.log.info({ purged: rows.length }, "retention purge");
  return rows.length;
}

export async function privacyExport(d: WorkerDeps, job: JobRow): Promise<void> {
  const requestId = String(job.payload.requestId);
  const req = await d.pool.query<{ user_id: string; status: string }>(`SELECT user_id, status FROM privacy_requests WHERE id = $1 AND kind = 'EXPORT'`, [requestId]);
  const r = req.rows[0];
  if (!r || r.status === "COMPLETED") return;
  const uid = r.user_id;
  const q = async (sql: string) => (await d.pool.query(sql, [uid])).rows;
  const data = {
    generatedAt: new Date().toISOString(),
    profile: await q(`SELECT u.email, u.full_name, u.phone, u.created_at, sp.matric_number, sp.university_id, sp.campus_id FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`),
    documents: await q(`SELECT a.title, v.version_number, v.original_filename, v.page_count, v.created_at, v.files_purged_at FROM document_assets a JOIN document_versions v ON v.asset_id = a.id WHERE a.owner_user_id = $1`),
    orders: await q(`SELECT o.reference, o.status, o.total_kobo, o.created_at, q.spec, q.lines FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.student_user_id = $1`),
    payments: await q(`SELECT p.provider_reference, p.amount_kobo, p.status, p.created_at FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.student_user_id = $1`),
    wallet: await q(`SELECT cash_kobo, promo_kobo, updated_at FROM wallets WHERE user_id = $1`),
    walletEntries: await q(`SELECT kind, cash_kobo, promo_kobo, order_id, note, created_at FROM wallet_entries WHERE user_id = $1 ORDER BY id`),
    walletTopups: await q(`SELECT provider_reference, amount_kobo, status, channel, created_at, confirmed_at FROM wallet_topups WHERE user_id = $1 ORDER BY created_at`),
    disputes: await q(`SELECT category, description, status, opened_at FROM disputes WHERE opened_by = $1`),
    notifications: await q(`SELECT title, body, created_at FROM notifications WHERE user_id = $1`),
  };
  const key = objectKeys.export(uid);
  await d.storage.putBuffer(key, Buffer.from(JSON.stringify(data, null, 2)), "application/json");
  await d.pool.query(`UPDATE privacy_requests SET status = 'COMPLETED', export_storage_key = $2, completed_at = now() WHERE id = $1`, [requestId, key]);
  await notifyUser(d, uid, "privacy.export_ready", "Your data export is ready", "Download it from your account's privacy page. The link expires shortly after you open it.");
}

const UNUSABLE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$ZXJhc2VkLWFjY291bnQ$ZXJhc2VkLWFjY291bnQtbm8tbG9naW4";

export async function privacyErase(d: WorkerDeps, job: JobRow): Promise<void> {
  const requestId = String(job.payload.requestId);
  const outcome = await withTransaction(d.pool, async (c) => {
    const req = await c.query<{ user_id: string; status: string }>(`SELECT user_id, status FROM privacy_requests WHERE id = $1 AND kind = 'ERASURE' FOR UPDATE`, [requestId]);
    const r = req.rows[0];
    if (!r || r.status === "COMPLETED" || r.status === "REJECTED") return null;
    const active = await c.query(`SELECT 1 FROM orders WHERE student_user_id = $1 AND status NOT IN ('COLLECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED') LIMIT 1`, [r.user_id]);
    if (active.rowCount) {
      await c.query(`UPDATE privacy_requests SET status = 'REJECTED', note = 'Erasure is not possible while orders are in progress. Submit again once they are complete.', completed_at = now() WHERE id = $1`, [requestId]);
      return { userId: r.user_id, erased: false };
    }
    await c.query(`UPDATE document_assets SET deleted_at = COALESCE(deleted_at, now()), title = 'Deleted document' WHERE owner_user_id = $1`, [r.user_id]);
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [r.user_id]);
    await c.query(`DELETE FROM mfa_factors WHERE user_id = $1`, [r.user_id]);
    await c.query(`UPDATE student_profiles SET matric_number = NULL WHERE user_id = $1`, [r.user_id]);
    // Financial records (orders, payments, refunds) are kept as required for accounting,
    // but no longer identify the person.
    await c.query(`UPDATE users SET email = $2, full_name = 'Deleted user', phone = NULL, password_hash = $3, status = 'DELETED' WHERE id = $1`, [
      r.user_id,
      `deleted+${r.user_id}@deleted.invalid`,
      UNUSABLE_HASH,
    ]);
    await c.query(`DELETE FROM notifications WHERE user_id = $1`, [r.user_id]);
    await c.query(`UPDATE privacy_requests SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [requestId]);
    return { userId: r.user_id, erased: true };
  });
  if (outcome?.erased) {
    const assets = await d.pool.query<{ id: string }>(`SELECT id FROM document_assets WHERE owner_user_id = $1`, [outcome.userId]);
    for (const a of assets.rows) await enqueueJob(d.pool, "RETENTION_PURGE", { assetId: a.id }, { dedupeKey: `purge-asset:${a.id}:${randomUUID()}` });
  }
}
