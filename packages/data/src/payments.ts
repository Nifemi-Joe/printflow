import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NotFoundError, RuleViolationError } from "./errors.js";
import { transitionOrder } from "./orders.js";
import type { Queryable } from "./tx.js";
import { creditTopup, naira, noRefundInFlight, notifyWallet, refundOrder, type RefundDestination } from "./wallet.js";

/**
 * Paystack signs the raw request body with HMAC-SHA512 using the secret key and
 * sends the hex digest in the x-paystack-signature header. The raw bytes must be
 * used; re-serialised JSON will not match.
 */
export function verifyPaystackSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !/^[a-f0-9]{128}$/i.test(signatureHeader) || secret.length === 0) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  const given = Buffer.from(signatureHeader, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface PaymentEvent {
  provider: "PAYSTACK" | "TEST";
  eventId: string;
  eventType: "charge.success" | "charge.failed" | "refund.processed" | "refund.failed" | string;
  reference: string;
  /** Amount the provider says it collected, in kobo. */
  amountKobo: number;
  currency: string;
  signatureValid: boolean;
  payload: unknown;
  /** How the payer paid, normalised (CARD, BANK_TRANSFER, USSD, …), when the provider says. */
  channel?: string | null;
}

export type WebhookOutcome =
  | "DUPLICATE"
  | "REJECTED_SIGNATURE"
  | "UNKNOWN_REFERENCE"
  | "AMOUNT_MISMATCH"
  | "ALREADY_FINAL"
  | "PAID"
  | "PAID_LATE_REFUND_REQUESTED"
  | "FAILED_RECORDED"
  | "REFUND_COMPLETED"
  | "REFUND_FAILED"
  | "IGNORED_EVENT_TYPE"
  | "TOPUP_CREDITED"
  | "TOPUP_FAILED"
  | "CREDITED_TO_WALLET";

/**
 * Records a provider webhook in the inbox and applies it at most once.
 * Run in a transaction. Unsigned events are stored for forensics and never acted on.
 */
export async function applyPaymentEvent(db: Queryable, ev: PaymentEvent): Promise<WebhookOutcome> {
  // Unsigned events are stored for forensics under a unique id, so a forged event
  // can never occupy (and thereby suppress) the id of a genuine one.
  const storedId = ev.signatureValid ? ev.eventId : `unverified:${randomUUID()}`;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO payment_webhook_events (provider, event_id, event_type, signature_valid, payload)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [ev.provider, storedId, ev.eventType, ev.signatureValid, JSON.stringify({ claimedEventId: ev.eventId, payload: ev.payload })],
  );
  const inboxId = inserted.rows[0]?.id;
  if (!inboxId) return "DUPLICATE";

  const finish = async (outcome: WebhookOutcome, error?: string) => {
    await db.query(`UPDATE payment_webhook_events SET processed_at = now(), processing_error = $2 WHERE id = $1`, [inboxId, error ?? null]);
    return outcome;
  };

  if (!ev.signatureValid) return finish("REJECTED_SIGNATURE", "invalid signature");

  if (ev.eventType === "refund.processed" || ev.eventType === "refund.failed") {
    return finish(await applyRefundEvent(db, ev));
  }
  if (ev.eventType !== "charge.success" && ev.eventType !== "charge.failed") return finish("IGNORED_EVENT_TYPE");

  const { rows } = await db.query<{ id: string; order_id: string; amount_kobo: string; status: string }>(
    `SELECT id, order_id, amount_kobo, status FROM payments WHERE provider = $1 AND provider_reference = $2 FOR UPDATE`,
    [ev.provider, ev.reference],
  );
  const payment = rows[0];
  if (!payment) return finish(...(await applyTopupEvent(db, ev)));

  // Money for a checkout the student had left (they started another, or the order
  // ended). It is never kept by us and never lost: it goes to their wallet.
  if ((payment.status === "ABANDONED" || payment.status === "FAILED") && ev.eventType === "charge.success") {
    if (ev.currency !== "NGN" || !Number.isSafeInteger(ev.amountKobo) || BigInt(ev.amountKobo) !== BigInt(payment.amount_kobo)) {
      return finish("AMOUNT_MISMATCH", `provider amount ${ev.amountKobo} ${ev.currency} != expected ${payment.amount_kobo} NGN`);
    }
    const o = await db.query<{ student_user_id: string; university_id: string; reference: string }>(
      `SELECT student_user_id, university_id, reference FROM orders WHERE id = $1`,
      [payment.order_id],
    );
    const ins = await db.query(
      `INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, payment_id, idempotency_key, note)
       VALUES ($1, $2, 'UNMATCHED_PAYMENT', $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [o.rows[0]!.student_user_id, o.rows[0]!.university_id, ev.amountKobo, payment.id, `unmatched:${payment.id}`, `Earlier checkout for ${o.rows[0]!.reference}`],
    );
    if (ins.rowCount) {
      await notifyWallet(db, {
        userId: o.rows[0]!.student_user_id,
        kind: "wallet.unmatched_payment",
        title: "Payment added to your wallet",
        body: `We received ${naira(ev.amountKobo)} for an earlier checkout of ${o.rows[0]!.reference} that you had moved on from. It's in your PrintFlow wallet.`,
        sms: true,
      });
    }
    return finish("CREDITED_TO_WALLET");
  }
  if (payment.status !== "INITIATED") return finish("ALREADY_FINAL");

  if (ev.eventType === "charge.failed") {
    await db.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [payment.id]);
    return finish("FAILED_RECORDED");
  }

  if (ev.currency !== "NGN" || !Number.isSafeInteger(ev.amountKobo) || BigInt(ev.amountKobo) !== BigInt(payment.amount_kobo)) {
    // Never mark paid on a mismatch; leave for reconciliation.
    return finish("AMOUNT_MISMATCH", `provider amount ${ev.amountKobo} ${ev.currency} != expected ${payment.amount_kobo} NGN`);
  }

  await db.query(`UPDATE payments SET status = 'SUCCEEDED', confirmed_amount_kobo = $2, confirmed_at = now(), channel = COALESCE($3, channel) WHERE id = $1`, [
    payment.id,
    ev.amountKobo,
    ev.channel ?? null,
  ]);

  const order = await db.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [payment.order_id]);
  if (order.rows[0]?.status === "AWAITING_PAYMENT") {
    await transitionOrder(db, { orderId: payment.order_id, to: "PAID", scope: { kind: "SYSTEM" }, actorUserId: null });
    return finish("PAID");
  }

  // Money arrived after the order expired or was cancelled: refund it, never keep it.
  const refund = await requestRefund(db, {
    orderId: payment.order_id,
    paymentId: payment.id,
    amountKobo: ev.amountKobo,
    reason: `Payment received after order was ${order.rows[0]?.status ?? "closed"}`,
    idempotencyKey: `late-payment:${payment.id}`,
    requestedBy: null,
  });
  await enqueueRefund(db, refund.refundId);
  return finish("PAID_LATE_REFUND_REQUESTED");
}

/** A charge event whose reference is a wallet top-up rather than an order payment. */
async function applyTopupEvent(db: Queryable, ev: PaymentEvent): Promise<[WebhookOutcome, string?]> {
  const { rows } = await db.query<{ id: string; status: string; amount_kobo: string }>(
    `SELECT id, status, amount_kobo FROM wallet_topups WHERE provider = $1 AND provider_reference = $2 FOR UPDATE`,
    [ev.provider, ev.reference],
  );
  const t = rows[0];
  if (!t) return ["UNKNOWN_REFERENCE", "no payment or top-up with this reference"];
  if (ev.eventType === "charge.failed") {
    if (t.status !== "INITIATED") return ["ALREADY_FINAL"];
    await db.query(`UPDATE wallet_topups SET status = 'FAILED' WHERE id = $1`, [t.id]);
    return ["TOPUP_FAILED"];
  }
  if (t.status === "SUCCEEDED") return ["ALREADY_FINAL"];
  if (ev.currency !== "NGN" || !Number.isSafeInteger(ev.amountKobo) || BigInt(ev.amountKobo) !== BigInt(t.amount_kobo)) {
    return ["AMOUNT_MISMATCH", `provider amount ${ev.amountKobo} ${ev.currency} != top-up ${t.amount_kobo} NGN`];
  }
  await creditTopup(db, t.id, ev.amountKobo, ev.channel ?? null);
  return ["TOPUP_CREDITED"];
}

async function applyRefundEvent(db: Queryable, ev: PaymentEvent): Promise<WebhookOutcome> {
  const { rows } = await db.query<{ id: string; order_id: string; status: string }>(
    `SELECT id, order_id, status FROM refunds WHERE provider_refund_reference = $1 FOR UPDATE`,
    [ev.reference],
  );
  const refund = rows[0];
  if (!refund) return "UNKNOWN_REFERENCE";
  if (refund.status === "SUCCEEDED" || refund.status === "FAILED") return "ALREADY_FINAL";
  if (ev.eventType === "refund.failed") {
    await db.query(`UPDATE refunds SET status = 'FAILED', completed_at = now() WHERE id = $1`, [refund.id]);
    return "REFUND_FAILED";
  }
  await db.query(`UPDATE refunds SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`, [refund.id]);
  const order = await db.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [refund.order_id]);
  const open = await db.query(`SELECT 1 FROM refunds WHERE order_id = $1 AND status IN ('REQUESTED', 'PROCESSING')`, [refund.order_id]);
  if (order.rows[0]?.status === "REFUND_PENDING" && open.rowCount === 0) {
    await transitionOrder(db, { orderId: refund.order_id, to: "REFUNDED", scope: { kind: "SYSTEM" }, actorUserId: null });
  }
  return "REFUND_COMPLETED";
}

export async function enqueueRefund(db: Queryable, refundId: string): Promise<void> {
  await db.query(`INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('REFUND_PROCESS', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`, [
    JSON.stringify({ refundId }),
    `refund:${refundId}`,
  ]);
}

export async function requestRefund(
  db: Queryable,
  params: {
    orderId: string;
    paymentId: string;
    amountKobo: number;
    reason: string;
    idempotencyKey: string;
    requestedBy: string | null;
  },
): Promise<{ refundId: string; created: boolean }> {
  if (!Number.isSafeInteger(params.amountKobo) || params.amountKobo <= 0) {
    throw new RuleViolationError("refund amount must be a positive whole number of kobo", "INVALID_AMOUNT");
  }
  const existing = await db.query<{ id: string; payment_id: string; amount_kobo: string }>(
    `SELECT id, payment_id, amount_kobo FROM refunds WHERE idempotency_key = $1`,
    [params.idempotencyKey],
  );
  if (existing.rows[0]) {
    const r = existing.rows[0];
    if (r.payment_id !== params.paymentId || Number(r.amount_kobo) !== params.amountKobo) {
      throw new RuleViolationError("idempotency key reused with different parameters", "IDEMPOTENCY_MISMATCH");
    }
    return { refundId: r.id, created: false };
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO refunds (payment_id, order_id, university_id, amount_kobo, reason, idempotency_key, requested_by)
     SELECT p.id, p.order_id, p.university_id, $3, $4, $5, $6 FROM payments p WHERE p.id = $1 AND p.order_id = $2
     RETURNING id`,
    [params.paymentId, params.orderId, params.amountKobo, params.reason, params.idempotencyKey, params.requestedBy],
  );
  if (!rows[0]) throw new RuleViolationError("payment does not belong to this order", "PAYMENT_ORDER_MISMATCH");
  return { refundId: rows[0].id, created: true };
}

/**
 * Re-issues a refund after the provider definitively refused the previous one
 * (status FAILED). Only for orders still in REFUND_PENDING with no refund in
 * flight; the amount is whatever has not been refunded yet, so the database cap
 * still guarantees the student can never be refunded more than they paid. It can go
 * back through the provider again, or to the student's wallet (instant).
 */
export async function retryFailedRefund(
  db: Queryable,
  params: { orderId: string; universityId: string; reason: string; requestedBy: string; destination?: RefundDestination },
): Promise<{ refundId: string | null; amountKobo: number; destination: RefundDestination }> {
  const order = await db.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1 AND university_id = $2 FOR UPDATE`, [params.orderId, params.universityId]);
  if (!order.rows[0]) throw new NotFoundError("order");
  if (order.rows[0].status !== "REFUND_PENDING") throw new RuleViolationError("only orders waiting for a refund can have it retried", "NOT_REFUND_PENDING");
  const counts = await db.query<{ open: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS open, count(*) FILTER (WHERE status = 'FAILED') AS failed FROM refunds WHERE order_id = $1`,
    [params.orderId],
  );
  if (Number(counts.rows[0]!.open) > 0) throw new RuleViolationError("a refund is already in progress for this order", "REFUND_IN_PROGRESS");
  if (Number(counts.rows[0]!.failed) === 0) throw new RuleViolationError("there is no failed refund to retry", "NO_FAILED_REFUND");
  const destination = params.destination ?? "PROVIDER";
  const r = await refundOrder(db, {
    orderId: params.orderId,
    destination,
    reason: params.reason,
    idempotencyKey: `order-refund-retry:${params.orderId}:${counts.rows[0]!.failed}`,
    requestedBy: params.requestedBy,
  });
  const amount = r.toWalletKobo + r.toProviderKobo;
  if (amount <= 0) throw new RuleViolationError("nothing is left to refund on this order", "NOTHING_TO_REFUND");
  if (await noRefundInFlight(db, params.orderId)) {
    await transitionOrder(db, { orderId: params.orderId, to: "REFUNDED", scope: { kind: "SYSTEM" }, actorUserId: null });
  }
  return { refundId: r.providerRefundId, amountKobo: amount, destination };
}
