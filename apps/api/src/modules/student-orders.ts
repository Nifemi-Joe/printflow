import { devConsole } from "../infra/dev-console.js";
import { CHANNEL_LABELS } from "../infra/payment-provider.js";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import {
  cancellationEligibility,
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from "../../../../packages/domain/src/index.js";
import {
  applyWalletToOrder,
  enqueueJob,
  needsAcknowledgement,
  providerTrust,
  issuePickupToken,
  queuePosition,
  transitionOrder,
  walletBalance,
  walletOnOrder,
  withTransaction,
} from "../../../../packages/data/src/index.js";
import { calculateQuote, formatNaira, printSpecHash, type PricingMode } from "../../../../packages/pricing/src/index.js";
import { checkoutMode, type AppConfig } from "../config.js";
import { Access, audit } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { decodeCursor, page, parse, Pagination, uuid } from "../http/validate.js";
import type { PaymentProvider } from "../infra/payment-provider.js";
import { CONFIG, PAYMENT_PROVIDER, PG_POOL, STORAGE } from "../infra/tokens.js";
import type { ObjectStorage } from "../../../../packages/storage/src/index.js";
import { z } from "zod";
import { resolveShopPricing, shopQueueEstimate } from "./pricing-data.js";

const REF_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function newOrderReference(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `PF-${s}`;
}

/** Idempotent execution of a mutating request, keyed per user. */
export async function idempotent<T>(pool: Pool, userId: string, key: string | undefined, requestBody: unknown, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!key || !/^[\w-]{16,128}$/.test(key)) throw Errors.badRequest("an Idempotency-Key header (16-128 characters) is required");
  const requestHash = createHash("sha256").update(JSON.stringify(requestBody ?? null)).digest("hex");
  return withTransaction(pool, async (c) => {
    const ins = await c.query(`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key`, [userId, key, requestHash]);
    if (!ins.rowCount) {
      const prior = await c.query<{ request_hash: string; response_body: T | null }>(`SELECT request_hash, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE`, [userId, key]);
      const p = prior.rows[0]!;
      if (p.request_hash !== requestHash) throw Errors.conflict("this Idempotency-Key was used with a different request", "IDEMPOTENCY_MISMATCH");
      if (p.response_body !== null) return p.response_body;
      throw Errors.conflict("an identical request is still being processed", "IDEMPOTENCY_IN_PROGRESS");
    }
    const result = await fn(c);
    await c.query(`UPDATE idempotency_keys SET response_status = 200, response_body = $3 WHERE user_id = $1 AND key = $2`, [userId, key, JSON.stringify(result)]);
    return result;
  });
}

@Controller("v1")
export class StudentOrdersController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(Access) private readonly access: Access,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  // ---------------------------------------------------------------- quotes

  @Post("quotes")
  @HttpCode(201)
  async createQuote(@Req() req: PfRequest, @Body() body: unknown) {
    const st = await this.access.student(req);
    await this.limiter.hit(`quote:${st.auth.userId}`, 120, 3600);
    const input = parse(Schemas.CreateQuote, body);

    const doc = await this.pool.query<{ page_count: number; print_sha256: string; processing_status: string; files_purged_at: Date | null; university_id: string }>(
      `SELECT v.page_count, v.print_sha256, v.processing_status, v.files_purged_at, v.university_id
         FROM document_versions v JOIN document_assets a ON a.id = v.asset_id
        WHERE v.id = $1 AND a.owner_user_id = $2 AND a.deleted_at IS NULL`,
      [input.documentVersionId, st.auth.userId],
    );
    const d = doc.rows[0];
    if (!d) throw Errors.notFound("document version");
    if (d.processing_status !== "READY" || d.files_purged_at) throw Errors.rule("this document is not ready to print yet", "DOCUMENT_NOT_READY");

    const shop = await this.pool.query<{ university_id: string; pricing_mode: PricingMode; fee_fixed: string; fee_bps: number; ttl: number }>(
      `SELECT s.university_id, u.pricing_mode, u.service_fee_fixed_kobo AS fee_fixed, u.service_fee_bps AS fee_bps, u.quote_ttl_seconds AS ttl
         FROM shops s JOIN universities u ON u.id = s.university_id
        WHERE s.id = $1 AND s.status = 'APPROVED' AND s.accepting_orders AND u.status = 'ACTIVE'`,
      [input.shopId],
    );
    const s = shop.rows[0];
    if (!s || s.university_id !== st.universityId) throw Errors.rule("this shop is not taking orders from your university right now", "SHOP_UNAVAILABLE");

    const pricing = await resolveShopPricing(this.pool, s.university_id, input.shopId, s.pricing_mode);
    const spec = { ...input.spec, documentPageCount: d.page_count, finishingCodes: input.spec.finishingCodes };
    const quote = calculateQuote(spec, pricing, { fixed: Number(s.fee_fixed), bps: s.fee_bps });
    const specHash = printSpecHash(spec, d.print_sha256);

    const { rows } = await this.pool.query<{ id: string; expires_at: Date; created_at: Date }>(
      `INSERT INTO quotes (university_id, shop_id, student_user_id, document_version_id, document_sha256, rate_card_id, rate_card_version,
         pricing_mode, spec, spec_hash, lines, subtotal_kobo, service_fee_kobo, total_kobo, total_sheets, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now() + make_interval(secs => $16))
       RETURNING id, expires_at, created_at`,
      [
        s.university_id,
        input.shopId,
        st.auth.userId,
        input.documentVersionId,
        d.print_sha256,
        quote.rateCardId,
        quote.rateCardVersion,
        s.pricing_mode,
        JSON.stringify({ ...spec, selectedPages: quote.selectedPages, appliedOverrides: quote.appliedOverrides }),
        specHash,
        JSON.stringify(quote.lines),
        quote.subtotal,
        quote.serviceFee,
        quote.total,
        quote.totalSheets,
        s.ttl,
      ],
    );
    return await this.presentQuote({ id: rows[0]!.id, expiresAt: rows[0]!.expires_at, createdAt: rows[0]!.created_at, ...quote, shopId: input.shopId, documentVersionId: input.documentVersionId, spec });
  }

  private async presentQuote(q: { id: string; expiresAt: Date; createdAt: Date; lines: Array<{ code: string; description: string; quantity: number; unitPrice: number; amount: number }>; subtotal: number; serviceFee: number; total: number; totalSheets: number; rateCardVersion: number; shopId: string; documentVersionId: string; spec: unknown }) {
    return {
      id: q.id,
      shopId: q.shopId,
      documentVersionId: q.documentVersionId,
      spec: q.spec,
      rateCardVersion: q.rateCardVersion,
      totalSheets: q.totalSheets,
      lines: q.lines.map((l) => ({ ...l, display: formatNaira(l.amount) })),
      subtotalKobo: q.subtotal,
      serviceFeeKobo: q.serviceFee,
      totalKobo: q.total,
      display: { subtotal: formatNaira(q.subtotal), serviceFee: formatNaira(q.serviceFee), total: formatNaira(q.total) },
      currency: "NGN",
      createdAt: q.createdAt,
      expiresAt: q.expiresAt,
      checkout: checkoutMode(this.cfg),
      paymentMethods: this.cfg.PAYMENT_METHODS,
      provider: await this.providerSummary(q.shopId),
    };
  }

  /** Who is behind a shop, in the shape every student-facing screen uses. */
  private async providerSummary(shopId: string) {
    const t = await providerTrust(this.pool, shopId);
    return {
      kind: t.kind,
      level: t.level,
      badge: t.badge,
      orderCapKobo: t.limits.orderCapKobo,
      /** The student must tick a box before ordering from this shop. */
      needsAcknowledgement: needsAcknowledgement(t),
    };
  }

  @Get("quotes/:quoteId")
  async getQuote(@Req() req: PfRequest, @Param("quoteId") quoteIdRaw: string) {
    const st = await this.access.student(req);
    const { rows } = await this.pool.query<{
      id: string; expires_at: Date; created_at: Date; lines: Array<{ code: string; description: string; quantity: number; unitPrice: number; amount: number }>;
      subtotal_kobo: string; service_fee_kobo: string; total_kobo: string; total_sheets: number; rate_card_version: number; shop_id: string; document_version_id: string; spec: unknown;
    }>(`SELECT * FROM quotes WHERE id = $1 AND student_user_id = $2`, [parse(uuid, quoteIdRaw), st.auth.userId]);
    const q = rows[0];
    if (!q) throw Errors.notFound("quote");
    return await this.presentQuote({
      id: q.id,
      expiresAt: q.expires_at,
      createdAt: q.created_at,
      lines: q.lines,
      subtotal: Number(q.subtotal_kobo),
      serviceFee: Number(q.service_fee_kobo),
      total: Number(q.total_kobo),
      totalSheets: q.total_sheets,
      rateCardVersion: q.rate_card_version,
      shopId: q.shop_id,
      documentVersionId: q.document_version_id,
      spec: q.spec,
    });
  }

  // ---------------------------------------------------------------- orders

  @Post("orders")
  @HttpCode(201)
  async createOrder(@Req() req: PfRequest, @Body() body: unknown) {
    const st = await this.access.student(req);
    const input = parse(Schemas.CreateOrder, body);
    // Either confirmed contact is enough: many students check SMS long before email.
    if (this.cfg.REQUIRE_EMAIL_VERIFICATION && !st.auth.emailVerified && !st.auth.phoneVerified) {
      throw Errors.rule("confirm your email address or phone number before placing orders", "CONTACT_NOT_VERIFIED");
    }
    return idempotent(this.pool, st.auth.userId, req.header("idempotency-key"), input, async (c) => {
      const q = await c.query<{ shop_id: string; total_kobo: string; spec_hash: string; document_version_id: string; expires_at: Date }>(
        `SELECT shop_id, total_kobo, spec_hash, document_version_id, expires_at FROM quotes WHERE id = $1 AND student_user_id = $2`,
        [input.quoteId, st.auth.userId],
      );
      const quote = q.rows[0];
      if (!quote) throw Errors.notFound("quote");
      if (quote.expires_at <= new Date()) throw Errors.gone("this quote has expired; get a fresh price", "QUOTE_EXPIRED");
      const pl = await c.query(`SELECT 1 FROM pickup_locations WHERE id = $1 AND shop_id = $2 AND is_active`, [input.pickupLocationId, quote.shop_id]);
      if (!pl.rowCount) throw Errors.rule("choose a pickup location offered by this shop", "INVALID_PICKUP_LOCATION");
      if (input.reprintOfOrderId) {
        const prior = await c.query(`SELECT 1 FROM orders WHERE id = $1 AND student_user_id = $2`, [input.reprintOfOrderId, st.auth.userId]);
        if (!prior.rowCount) throw Errors.notFound("original order");
      }
      // A student-run shop whose identity is not fully proven: the student has to have
      // been told, and the order is capped. The database re-checks both.
      const trust = await providerTrust(c, quote.shop_id);
      const ack = needsAcknowledgement(trust);
      if (ack && !input.acknowledgeUnverifiedProvider) {
        throw Errors.rule(`${trust.badge.detail} Confirm you are happy to use them before ordering.`, "PROVIDER_NOT_VERIFIED");
      }
      if (ack && trust.limits.orderCapKobo !== null && Number(quote.total_kobo) > trust.limits.orderCapKobo) {
        throw Errors.rule(
          `${trust.name} can take orders up to ${formatNaira(trust.limits.orderCapKobo)} until their matric number is verified. Choose a verified shop for this job.`,
          "PROVIDER_ORDER_CAP",
        );
      }
      const ins = await c.query<{ id: string; reference: string; payment_due_at: Date }>(
        `INSERT INTO orders (reference, university_id, shop_id, student_user_id, pickup_location_id, quote_id, document_version_id, spec_hash,
                             total_kobo, payment_due_at, reprint_of_order_id, unverified_ack_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10), $11, CASE WHEN $12::boolean THEN now() END)
         RETURNING id, reference, payment_due_at`,
        [newOrderReference(), st.universityId, quote.shop_id, st.auth.userId, input.pickupLocationId, input.quoteId, quote.document_version_id, quote.spec_hash, quote.total_kobo, this.cfg.PAYMENT_WINDOW_MINUTES, input.reprintOfOrderId ?? null, ack],
      );
      const o = ins.rows[0]!;
      await c.query(`INSERT INTO order_events (order_id, university_id, from_status, to_status, actor_kind, actor_user_id) VALUES ($1, $2, NULL, 'AWAITING_PAYMENT', 'STUDENT', $3)`, [
        o.id,
        st.universityId,
        st.auth.userId,
      ]);
      await enqueueJob(c, "ORDER_EXPIRE", { orderId: o.id }, { dedupeKey: `expire:${o.id}`, runAfter: o.payment_due_at });
      return { id: o.id, reference: o.reference, status: "AWAITING_PAYMENT", totalKobo: Number(quote.total_kobo), paymentDueAt: o.payment_due_at };
    });
  }

  @Get("orders")
  async listOrders(@Req() req: PfRequest, @Query() query: unknown) {
    const st = await this.access.student(req);
    const { limit, cursor } = parse(Pagination, query);
    const cur = decodeCursor(cursor);
    const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
      `SELECT o.id, o.reference, o.status, o.total_kobo AS "totalKobo", o.created_at, o.status_changed_at AS "statusChangedAt",
              s.name AS "shopName", a.title AS "documentTitle"
         FROM orders o JOIN shops s ON s.id = o.shop_id
         JOIN document_versions v ON v.id = o.document_version_id JOIN document_assets a ON a.id = v.asset_id
        WHERE o.student_user_id = $1 AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2, $3::uuid))
        ORDER BY o.created_at DESC, o.id DESC LIMIT $4`,
      [st.auth.userId, cur?.createdAt ?? null, cur?.id ?? null, limit + 1],
    );
    const p = page(rows, limit);
    return { items: p.items.map((r) => ({ ...r, statusLabel: ORDER_STATUS_LABELS[(r as unknown as { status: OrderStatus }).status] })), nextCursor: p.nextCursor };
  }

  @Get("orders/:orderId")
  async getOrder(@Req() req: PfRequest, @Param("orderId") orderIdRaw: string) {
    const st = await this.access.student(req);
    return this.orderDetail(parse(uuid, orderIdRaw), st.auth.userId);
  }

  async orderDetail(orderId: string, studentUserId: string) {
    const { rows } = await this.pool.query<Record<string, unknown> & { status: OrderStatus; shop_id: string; id: string }>(
      `SELECT o.id, o.reference, o.status, o.row_version, o.total_kobo, o.created_at, o.status_changed_at, o.payment_due_at, o.shop_id,
              o.reprint_of_order_id, o.unverified_ack_at, s.name AS shop_name, pl.name AS pickup_location, q.spec, q.lines, q.subtotal_kobo, q.service_fee_kobo,
              q.total_sheets, q.rate_card_version, a.title AS document_title, v.id AS document_version_id, v.version_number, v.page_count
         FROM orders o JOIN shops s ON s.id = o.shop_id JOIN pickup_locations pl ON pl.id = o.pickup_location_id
         JOIN quotes q ON q.id = o.quote_id JOIN document_versions v ON v.id = o.document_version_id JOIN document_assets a ON a.id = v.asset_id
        WHERE o.id = $1 AND o.student_user_id = $2`,
      [orderId, studentUserId],
    );
    const o = rows[0];
    if (!o) throw Errors.notFound("order");
    const [fromWallet, balance] = await Promise.all([walletOnOrder(this.pool, orderId), walletBalance(this.pool, studentUserId).catch(() => null)]);
    const returnedToWallet = await this.pool.query<{ n: string }>(
      `SELECT COALESCE(sum(cash_kobo + promo_kobo), 0) AS n FROM wallet_entries WHERE order_id = $1 AND kind IN ('ORDER_RETURN', 'CARD_REFUND')`,
      [orderId],
    );
    const [events, payments, refunds, disputes, position, estimate] = await Promise.all([
      this.pool.query(`SELECT from_status AS "from", to_status AS "to", reason, occurred_at AS "at" FROM order_events WHERE order_id = $1 ORDER BY id`, [orderId]),
      this.pool.query(`SELECT provider, provider_reference AS reference, amount_kobo AS "amountKobo", status, requested_channel AS "requestedMethod", channel AS "paidWith",
                created_at AS "createdAt", confirmed_at AS "confirmedAt" FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId]),
      this.pool.query(`SELECT id, amount_kobo AS "amountKobo", status, destination, reason, requested_at AS "requestedAt", completed_at AS "completedAt" FROM refunds WHERE order_id = $1 ORDER BY requested_at`, [orderId]),
      this.pool.query(`SELECT id, category, status, description, resolution_note AS "resolutionNote", opened_at AS "openedAt" FROM disputes WHERE order_id = $1 ORDER BY opened_at`, [orderId]),
      queuePosition(this.pool, orderId),
      shopQueueEstimate(this.pool, o.shop_id, orderId),
    ]);
    return {
      id: o.id,
      reference: o.reference,
      status: o.status,
      statusLabel: ORDER_STATUS_LABELS[o.status],
      version: o.row_version,
      totalKobo: Number(o.total_kobo),
      display: { total: formatNaira(Number(o.total_kobo)), subtotal: formatNaira(Number(o.subtotal_kobo)), serviceFee: formatNaira(Number(o.service_fee_kobo)) },
      lines: o.lines,
      spec: o.spec,
      totalSheets: o.total_sheets,
      rateCardVersion: o.rate_card_version,
      shop: { id: o.shop_id, name: o.shop_name },
      provider: { ...(await this.providerSummary(o.shop_id as string)), acknowledgedAt: o.unverified_ack_at },
      pickupLocation: o.pickup_location,
      document: { title: o.document_title, versionId: o.document_version_id, versionNumber: o.version_number, pageCount: o.page_count },
      reprintOfOrderId: o.reprint_of_order_id,
      createdAt: o.created_at,
      statusChangedAt: o.status_changed_at,
      paymentDueAt: o.payment_due_at,
      cancellation: cancellationEligibility(o.status),
      queue: position === null ? null : { position, jobsAhead: estimate.jobsAhead, estimatedMinutes: estimate.estimatedMinutes, basis: estimate.basis },
      canRequestPickupCode: o.status === "READY_FOR_PICKUP",
      events: events.rows,
      payments: payments.rows,
      paymentMethods: this.cfg.PAYMENT_METHODS,
      wallet: {
        enabled: this.cfg.WALLET_ENABLED,
        /** What the wallet covers on this order (0 once given back). */
        appliedKobo: fromWallet.totalKobo,
        /** Left to pay by card, transfer or USSD. */
        amountDueKobo: Math.max(0, Number(o.total_kobo) - fromWallet.totalKobo),
        returnedKobo: Number(returnedToWallet.rows[0]!.n),
        balanceKobo: balance?.totalKobo ?? 0,
      },
      refunds: refunds.rows,
      disputes: disputes.rows,
    };
  }

  @Post("orders/:orderId/cancel")
  @HttpCode(200)
  async cancel(@Req() req: PfRequest, @Param("orderId") orderIdRaw: string, @Body() body: unknown) {
    const st = await this.access.student(req);
    const orderId = parse(uuid, orderIdRaw);
    const { reason, refundTo } = parse(Schemas.CancelOrder, body ?? {});
    await withTransaction(this.pool, async (c) => {
      const cur = await c.query<{ status: OrderStatus }>(`SELECT status FROM orders WHERE id = $1 AND student_user_id = $2 FOR UPDATE`, [orderId, st.auth.userId]);
      if (!cur.rows[0]) throw Errors.notFound("order");
      const elig = cancellationEligibility(cur.rows[0].status);
      if (elig === "NOT_ELIGIBLE") throw Errors.rule("this order can no longer be cancelled because the shop has started on it", "NOT_CANCELLABLE");
      await transitionOrder(c, {
        orderId,
        to: elig === "CANCEL_NO_CHARGE" ? "CANCELLED" : "REFUND_PENDING",
        scope: { kind: "STUDENT", studentUserId: st.auth.userId },
        actorUserId: st.auth.userId,
        reason,
        requestId: req.id,
        refundTo,
      });
      if (elig === "CANCEL_NO_CHARGE") await c.query(`UPDATE payments SET status = 'ABANDONED' WHERE order_id = $1 AND status = 'INITIATED'`, [orderId]);
    });
    return this.orderDetail(orderId, st.auth.userId);
  }

  @Post("orders/:orderId/payments")
  @HttpCode(201)
  async startPayment(@Req() req: PfRequest, @Param("orderId") orderIdRaw: string, @Body() body: unknown) {
    const st = await this.access.student(req);
    const orderId = parse(uuid, orderIdRaw);
    const { method, useWallet } = parse(Schemas.StartPayment, body ?? {});
    if (useWallet && !this.cfg.WALLET_ENABLED) throw Errors.rule("the wallet is switched off", "WALLET_DISABLED");
    if (method && !this.cfg.PAYMENT_METHODS.includes(method)) {
      throw Errors.rule("this payment method is not offered; choose another", "METHOD_UNAVAILABLE");
    }
    const channels = method ? [method] : this.cfg.PAYMENT_METHODS;
    const mode = checkoutMode(this.cfg);
    await this.limiter.hit(`pay:${st.auth.userId}`, 20, 3600);
    const reference = `pf_${randomUUID().replace(/-/g, "")}`;

    const result = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ status: string; total_kobo: string; university_id: string; payment_due_at: Date; reference: string }>(
        `SELECT status, total_kobo, university_id, payment_due_at, reference FROM orders WHERE id = $1 AND student_user_id = $2 FOR UPDATE`,
        [orderId, st.auth.userId],
      );
      const o = rows[0];
      if (!o) throw Errors.notFound("order");
      if (o.status !== "AWAITING_PAYMENT") throw Errors.rule("this order is not awaiting payment", "NOT_PAYABLE");
      if (o.payment_due_at <= new Date()) throw Errors.gone("the payment window for this order has closed", "PAYMENT_WINDOW_CLOSED");

      // Wallet first (promo, then cash); once applied it stays on this order until it is paid or ends.
      if (useWallet) await applyWalletToOrder(c, { orderId, userId: st.auth.userId, lowBalanceKobo: this.cfg.WALLET_LOW_BALANCE_KOBO });
      const fromWallet = (await walletOnOrder(c, orderId)).totalKobo;
      const due = Number(o.total_kobo) - fromWallet;

      // Any earlier checkout for this order is superseded (if it is paid anyway, that money goes to the wallet).
      await c.query(`UPDATE payments SET status = 'ABANDONED' WHERE order_id = $1 AND status = 'INITIATED'`, [orderId]);

      if (due === 0) {
        await transitionOrder(c, { orderId, to: "PAID", scope: { kind: "SYSTEM" }, actorUserId: null, requestId: req.id });
        await audit(c, { universityId: o.university_id, actorUserId: st.auth.userId, actorKind: "STUDENT", action: "payment.wallet", entityType: "order", entityId: orderId, requestId: req.id, details: { walletKobo: fromWallet } });
        return { paidFromWallet: true as const, due, fromWallet, o };
      }

      if (mode === "DISABLED" || !this.provider) {
        throw Errors.unavailable("checkout is not available: payments have not been configured for this installation", "CHECKOUT_DISABLED");
      }
      // The amount is what the wallet does not cover; the DB trigger re-checks it.
      await c.query(
        `INSERT INTO payments (order_id, university_id, provider, provider_reference, amount_kobo, requested_channel) VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, o.university_id, this.provider.name, reference, due, method ?? null],
      );
      await audit(c, { universityId: o.university_id, actorUserId: st.auth.userId, actorKind: "STUDENT", action: "payment.initiated", entityType: "order", entityId: orderId, requestId: req.id, details: { reference, provider: this.provider.name, method: method ?? "ANY", walletKobo: fromWallet } });
      return { paidFromWallet: false as const, due, fromWallet, o };
    });

    if (result.paidFromWallet) {
      if (this.cfg.devConsole) {
        devConsole("paid from wallet", [
          { label: "Order", value: result.o.reference },
          { label: "Wallet", value: `₦${(result.fromWallet / 100).toFixed(2)}` },
        ]);
      }
      return { paidFromWallet: true, walletKobo: result.fromWallet, amountKobo: 0, orderId, mode, methods: channels, paymentDueAt: result.o.payment_due_at };
    }
    const emailResult = z.string().email().safeParse(st.auth.email?.trim());

    if (!emailResult.success) {
      throw Errors.badRequest(
          "A valid email address is required before payment",
          "PAYMENT_EMAIL_REQUIRED",
      );
    }
    console.log(emailResult);
    const email = emailResult.data.toLowerCase();


    const init = await this.provider!.initialize({
      reference,
      amountKobo: result.due,
      email: "nifemi1big@gmail.com",
      callbackUrl: `${this.cfg.PUBLIC_WEB_URL}/student/orders/${orderId}`,
      channels,
    });
    if (this.cfg.devConsole) {
      console.log(mode);
      devConsole(`checkout link (${mode === "TEST" ? "simulated payment" : "Paystack"})`, [
        { label: "Order", value: orderId },
        { label: "Amount", value: `₦${(result.due / 100).toFixed(2)}` },
        ...(result.fromWallet ? [{ label: "From wallet", value: `₦${(result.fromWallet / 100).toFixed(2)}` }] : []),
        { label: "Method", value: method ?? channels.join(", ") },
        { label: "Reference", value: reference },
        { label: "Link", value: init.checkoutUrl },
      ]);
    }
    return {
      paidFromWallet: false,
      reference,
      checkoutUrl: init.checkoutUrl,
      mode,
      amountKobo: result.due,
      walletKobo: result.fromWallet,
      methods: channels,
      paymentDueAt: result.o.payment_due_at,
    };
  }

  @Post("orders/:orderId/pickup-code")
  @HttpCode(201)
  async pickupCode(@Req() req: PfRequest, @Param("orderId") orderIdRaw: string) {
    const st = await this.access.student(req);
    const orderId = parse(uuid, orderIdRaw);
    await this.limiter.hit(`pickup-code:${orderId}`, 5, 3600);
    const t = await withTransaction(this.pool, (c) =>
      issuePickupToken(c, { orderId, pepper: this.cfg.PICKUP_CODE_PEPPER, scope: { kind: "STUDENT", studentUserId: st.auth.userId } }),
    );
    if (this.cfg.devConsole) {
      devConsole("pickup code", [
        { label: "Order", value: orderId },
        { label: "Code", value: t.code },
        { label: "Expires", value: new Date(t.expiresAt).toISOString() },
      ]);
    }
    // Shown once to the student; only its HMAC is stored.
    return { code: t.code, expiresAt: t.expiresAt, note: "Show this code at the counter. Generating a new code cancels the previous one." };
  }

  @Get("orders/:orderId/receipt")
  async receipt(@Req() req: PfRequest, @Param("orderId") orderIdRaw: string) {
    const st = await this.access.student(req);
    const d = await this.orderDetail(parse(uuid, orderIdRaw), st.auth.userId);
    const paid = (d.payments as Array<{ status: string; confirmedAt: Date; reference: string; provider: string; paidWith: string | null }>).find((p) => p.status === "SUCCEEDED");
    if (!paid) throw Errors.rule("a receipt is available once payment is confirmed", "NOT_PAID");
    return {
      receiptNumber: `R-${d.reference}`,
      orderReference: d.reference,
      issuedTo: { name: st.auth.fullName, email: "nifemi1big@gmail.com" },
      shop: d.shop,
      paidAt: paid.confirmedAt,
      paymentReference: paid.reference,
      provider: paid.provider,
      paidWith: paid.paidWith,
      paidWithLabel: paid.paidWith ? (CHANNEL_LABELS[paid.paidWith] ?? paid.paidWith) : null,
      lines: d.lines,
      totals: d.display,
      totalKobo: d.totalKobo,
      refunds: d.refunds,
      rateCardVersion: d.rateCardVersion,
      testMode: paid.provider === "TEST",
    };
  }

  @Post("orders/:orderId/disputes")
  @HttpCode(201)
  async dispute(@Req() req: PfRequest, @Param("orderId") orderIdRaw: string, @Body() body: unknown) {
    const st = await this.access.student(req);
    const orderId = parse(uuid, orderIdRaw);
    const input = parse(Schemas.OpenDispute, body);
    const o = await this.pool.query<{ university_id: string; status: string }>(`SELECT university_id, status FROM orders WHERE id = $1 AND student_user_id = $2`, [orderId, st.auth.userId]);
    if (!o.rows[0]) throw Errors.notFound("order");
    if (o.rows[0].status === "AWAITING_PAYMENT" || o.rows[0].status === "CANCELLED" || o.rows[0].status === "EXPIRED") {
      throw Errors.rule("disputes can only be opened on paid orders", "NOT_DISPUTABLE");
    }
    const { rows } = await this.pool.query(
      `INSERT INTO disputes (order_id, university_id, opened_by, category, description) VALUES ($1, $2, $3, $4, $5) RETURNING id, status, opened_at AS "openedAt"`,
      [orderId, o.rows[0].university_id, st.auth.userId, input.category, input.description],
    );
    await audit(this.pool, { universityId: o.rows[0].university_id, actorUserId: st.auth.userId, actorKind: "STUDENT", action: "dispute.opened", entityType: "order", entityId: orderId, requestId: req.id });
    return rows[0];
  }

  // ---------------------------------------------------------------- notifications & privacy

  @Get("notifications")
  async notifications(@Req() req: PfRequest) {
    const a = this.access.user(req);
    const { rows } = await this.pool.query(
      `SELECT id, kind, title, body, order_id AS "orderId", read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [a.userId],
    );
    const unread = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [a.userId]);
    return { items: rows, unread: Number(unread.rows[0]!.n) };
  }

  @Post("notifications/:id/read")
  @HttpCode(204)
  async markRead(@Req() req: PfRequest, @Param("id") idRaw: string) {
    const a = this.access.user(req);
    const id = parse(z.coerce.number().int().positive(), idRaw);
    await this.pool.query(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`, [id, a.userId]);
  }

  @Post("notifications/read-all")
  @HttpCode(204)
  async markAllRead(@Req() req: PfRequest) {
    const a = this.access.user(req);
    await this.pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [a.userId]);
  }

  @Post("privacy-requests")
  @HttpCode(201)
  async privacyRequest(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    const { kind } = parse(Schemas.PrivacyRequest, body);
    const sp = await this.pool.query<{ university_id: string }>(`SELECT university_id FROM student_profiles WHERE user_id = $1`, [a.userId]);
    const { rows } = await this.pool.query(
      `INSERT INTO privacy_requests (user_id, university_id, kind) VALUES ($1, $2, $3) RETURNING id, kind, status, created_at AS "createdAt"`,
      [a.userId, sp.rows[0]?.university_id ?? null, kind],
    );
    if (kind === "EXPORT") await enqueueJob(this.pool, "PRIVACY_EXPORT", { requestId: (rows[0] as { id: string }).id }, { dedupeKey: `privacy:${(rows[0] as { id: string }).id}` });
    return rows[0];
  }

  @Get("privacy-requests/:requestId/download")
  async privacyDownload(@Req() req: PfRequest, @Param("requestId") idRaw: string) {
    const a = this.access.user(req);
    const { rows } = await this.pool.query<{ export_storage_key: string | null; status: string }>(
      `SELECT export_storage_key, status FROM privacy_requests WHERE id = $1 AND user_id = $2 AND kind = 'EXPORT'`,
      [parse(uuid, idRaw), a.userId],
    );
    const r = rows[0];
    if (!r) throw Errors.notFound("privacy request");
    if (r.status !== "COMPLETED" || !r.export_storage_key) throw Errors.rule("your export is not ready yet", "NOT_READY");
    const url = await this.storage.signedDownloadUrl(r.export_storage_key, { ttlSeconds: this.cfg.SIGNED_URL_TTL_SECONDS, filename: "printflow-data-export.json", contentType: "application/json" });
    return { url, expiresInSeconds: this.cfg.SIGNED_URL_TTL_SECONDS };
  }

  @Get("privacy-requests")
  async privacyRequests(@Req() req: PfRequest) {
    const a = this.access.user(req);
    const { rows } = await this.pool.query(
      `SELECT id, kind, status, note, created_at AS "createdAt", completed_at AS "completedAt" FROM privacy_requests WHERE user_id = $1 ORDER BY created_at DESC`,
      [a.userId],
    );
    return { items: rows };
  }
}
