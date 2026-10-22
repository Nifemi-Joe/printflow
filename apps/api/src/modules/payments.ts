import { createHmac, randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { applyPaymentEvent, verifyPaystackSignature, withTransaction, type PaymentEvent, type WebhookOutcome } from "../../../../packages/data/src/index.js";
import { verifyGrant, type ObjectStorage } from "../../../../packages/storage/src/index.js";
import { checkoutMode, type AppConfig } from "../config.js";
import { Access } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { parse } from "../http/validate.js";
import { normalizeChannel, type PaymentProvider } from "../infra/payment-provider.js";
import { CONFIG, LOGGER, PAYMENT_PROVIDER, PG_POOL, STORAGE } from "../infra/tokens.js";
import { z } from "zod";

const PaystackEvent = z.object({
  event: z.string().max(100),
  data: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        reference: z.string().max(200).optional(),
        refund_reference: z.string().max(200).optional(),
        transaction_reference: z.string().max(200).optional(),
        amount: z.number().int().optional(),
        currency: z.string().max(5).optional(),
        channel: z.string().max(40).optional(),
      })
      .passthrough(),
});

const TestEvent = z.object({
  id: z.string().min(8).max(100),
  event: z.enum(["charge.success", "charge.failed", "refund.processed", "refund.failed"]),
  reference: z.string().max(200),
  amount: z.number().int(),
  currency: z.string().max(5),
  channel: z.enum(["card", "bank_transfer", "ussd"]).optional(),
});

@Injectable()
export class WebhookProcessor {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(CONFIG) private readonly cfg: AppConfig,
      @Inject(LOGGER) private readonly log: Logger,
  ) {}

  testEnabled(): boolean {
    return this.cfg.PAYMENT_PROVIDER === "TEST" && this.cfg.NODE_ENV !== "production";
  }

  signTest(raw: Buffer): string {
    return createHmac("sha512", this.cfg.TEST_WEBHOOK_SECRET).update(raw).digest("hex");
  }

  async paystack(raw: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
    const signatureValid = Boolean(this.cfg.PAYSTACK_SECRET_KEY) && verifyPaystackSignature(raw, signature, this.cfg.PAYSTACK_SECRET_KEY ?? "");
    let parsed: z.infer<typeof PaystackEvent>;
    try {
      parsed = PaystackEvent.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw Errors.badRequest("malformed webhook body");
    }
    const isRefund = parsed.event.startsWith("refund.");
    const ev: PaymentEvent = {
      provider: "PAYSTACK",
      eventId: `${parsed.event}:${String(parsed.data.id ?? parsed.data.reference ?? randomUUID())}`,
      eventType: parsed.event,
      reference: isRefund ? String(parsed.data.id ?? parsed.data.refund_reference ?? "") : (parsed.data.reference ?? ""),
      amountKobo: parsed.data.amount ?? -1,
      currency: parsed.data.currency ?? "",
      signatureValid,
      payload: parsed,
      channel: isRefund ? null : normalizeChannel(parsed.data.channel),
    };
    const outcome = await withTransaction(this.pool, (c) => applyPaymentEvent(c, ev));
    this.log.info({ provider: "PAYSTACK", eventType: ev.eventType, outcome }, "payment webhook");
    return outcome;
  }

  async test(raw: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
    if (!this.testEnabled()) throw Errors.notFound("route");
    const expected = this.signTest(raw);
    const signatureValid = typeof signature === "string" && signature.length === expected.length && verifyPaystackSignature(raw, signature, this.cfg.TEST_WEBHOOK_SECRET);
    const parsed = parse(TestEvent, JSON.parse(raw.toString("utf8")));
    const ev: PaymentEvent = {
      provider: "TEST",
      eventId: parsed.id,
      eventType: parsed.event,
      reference: parsed.reference,
      amountKobo: parsed.amount,
      currency: parsed.currency,
      signatureValid,
      payload: parsed,
      channel: normalizeChannel(parsed.channel),
    };
    const outcome = await withTransaction(this.pool, (c) => applyPaymentEvent(c, ev));
    this.log.info({ provider: "TEST", eventType: ev.eventType, outcome }, "payment webhook");
    return outcome;
  }
}

@Controller("v1/webhooks")
export class WebhooksController {
  constructor(@Inject(WebhookProcessor) private readonly hooks: WebhookProcessor) {}

  /** Paystack calls this. 200 is returned for anything stored, so the provider stops retrying. */
  @Post("paystack")
  @HttpCode(200)
  async paystack(@Req() req: PfRequest) {
    if (!req.rawBody) throw Errors.badRequest("expected a JSON body");
    const outcome = await this.hooks.paystack(req.rawBody, req.header("x-paystack-signature"));
    if (outcome === "REJECTED_SIGNATURE") throw Errors.forbidden("invalid signature");
    return { received: true };
  }

  @Post("test")
  @HttpCode(200)
  async test(@Req() req: PfRequest) {
    if (!req.rawBody) throw Errors.badRequest("expected a JSON body");
    const outcome = await this.hooks.test(req.rawBody, req.header("x-test-signature"));
    if (outcome === "REJECTED_SIGNATURE") throw Errors.forbidden("invalid signature");
    return { received: true, outcome };
  }
}

/**
 * Simulated checkout for development and automated tests (PAYMENT_PROVIDER=TEST).
 * It produces a signed provider event and pushes it through the real webhook
 * path; there is no shortcut that marks an order paid.
 */
@Controller("v1/test-payments")
export class TestPaymentsController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(Access) private readonly access: Access,
      @Inject(WebhookProcessor) private readonly hooks: WebhookProcessor,
  ) {}

  /** An order payment or a wallet top-up started by this student with the TEST provider. */
  private async owned(req: PfRequest, reference: string) {
    if (!this.hooks.testEnabled()) throw Errors.notFound("route");
    const a = this.access.user(req);
    const { rows } = await this.pool.query<{ amount_kobo: string; status: string; order_id: string; order_reference: string; shop_name: string; requested_channel: string | null }>(
        `SELECT p.amount_kobo, p.status, p.order_id, o.reference AS order_reference, s.name AS shop_name, p.requested_channel
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN shops s ON s.id = o.shop_id
         WHERE p.provider = 'TEST' AND p.provider_reference = $1 AND o.student_user_id = $2`,
        [reference, a.userId],
    );
    if (rows[0]) return { ...rows[0], kind: "ORDER" as const, returnTo: `/student/orders/${rows[0].order_id}` };
    const t = await this.pool.query<{ amount_kobo: string; status: string; requested_channel: string | null }>(
        `SELECT amount_kobo, status, requested_channel FROM wallet_topups WHERE provider = 'TEST' AND provider_reference = $1 AND user_id = $2`,
        [reference, a.userId],
    );
    if (!t.rows[0]) throw Errors.notFound("payment");
    return { ...t.rows[0], kind: "TOPUP" as const, order_id: null, order_reference: "Wallet top-up", shop_name: "PrintFlow wallet", returnTo: `/student/wallet?topup=${reference}` };
  }

  @Get(":reference")
  async get(@Req() req: PfRequest, @Param("reference") reference: string) {
    const p = await this.owned(req, reference);
    const label = p.kind === "TOPUP" ? reference.slice(-8).toUpperCase() : p.order_reference;
    return {
      reference,
      kind: p.kind,
      amountKobo: Number(p.amount_kobo),
      status: p.status,
      orderId: p.order_id,
      orderReference: p.order_reference,
      shopName: p.shop_name,
      requestedMethod: p.requested_channel,
      returnTo: p.returnTo,
      testMode: true,
      // What a real checkout would show for each method. Clearly fake: nothing here is a real account or code.
      simulated: {
        bankTransfer: { bank: "Test Bank (simulated)", accountNumber: "0000000000", accountName: `PrintFlow ${label}`, note: "Not a real account. In live mode Paystack shows a one-time account number." },
        ussd: { code: `*000*${label.replace(/\W/g, "")}#`, note: "Not a real code. In live mode Paystack shows your bank's USSD code." },
      },
    };
  }

  @Post(":reference/complete")
  @HttpCode(200)
  async complete(@Req() req: PfRequest, @Param("reference") reference: string, @Body() body: unknown) {
    const p = await this.owned(req, reference);
    const { outcome, method } = parse(Schemas.CompleteTestPayment, body);
    const used = (method ?? p.requested_channel ?? "CARD").toLowerCase();
    const raw = Buffer.from(
        JSON.stringify({
          id: `test_evt_${randomUUID()}`,
          event: outcome === "success" ? "charge.success" : "charge.failed",
          reference,
          amount: Number(p.amount_kobo),
          currency: "NGN",
          channel: used,
        }),
    );
    const result = await this.hooks.test(raw, this.hooks.signTest(raw));
    return { outcome: result, orderId: p.order_id, kind: p.kind, returnTo: p.returnTo };
  }
}

/**
 * Settles a payment by asking the provider, rather than waiting to be told.
 *
 * A webhook is the authority on what happened, but it is delivered to us — and
 * it may be slow, blocked, or undeliverable (nothing can reach a laptop running
 * on localhost). The student, meanwhile, is looking at the order they have just
 * paid for. So when they come back from the provider's checkout, the page asks
 * here, we ask the provider over our own authenticated connection, and the
 * answer goes through exactly the same path a webhook would take: same
 * `applyPaymentEvent`, same idempotency, same ledger. There is no shortcut that
 * marks an order paid without the provider saying so.
 */
@Controller("v1/payments")
export class PaymentsController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(Access) private readonly access: Access,
      @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
      @Inject(RateLimiter) private readonly limiter: RateLimiter,
      @Inject(LOGGER) private readonly log: Logger,
  ) {}

  @Post(":reference/verify")
  @HttpCode(200)
  async verify(@Req() req: PfRequest, @Param("reference") reference: string) {
    const a = this.access.user(req);
    // Each call costs us a request to the provider, so it is bounded per person.
    await this.limiter.hit(`payment-verify:user:${a.userId}`, 40, 300);

    const mine = await this.pool.query<{ kind: string; status: string; order_id: string | null }>(
        `SELECT 'ORDER' AS kind, p.status, p.order_id
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.provider_reference = $1 AND o.student_user_id = $2
       UNION ALL
       SELECT 'TOPUP' AS kind, t.status, NULL AS order_id
         FROM wallet_topups t
        WHERE t.provider_reference = $1 AND t.user_id = $2`,
        [reference, a.userId],
    );
    const row = mine.rows[0];
    // Someone else's reference is indistinguishable from one that never existed.
    if (!row) throw Errors.notFound("payment");

    const settled = row.status === "SUCCEEDED" || row.status === "FAILED";
    if (settled || !this.provider?.verify) {
      return { reference, kind: row.kind, status: row.status, orderId: row.order_id, checked: false };
    }

    let v: { status: string; amountKobo: number; currency: string; id: string };
    try {
      v = await this.provider.verify(reference);
    } catch (e) {
      // The provider is the authority; if we cannot reach it we say so rather
      // than guessing, and the reconciliation job will try again later.
      this.log.warn({ err: e, reference }, "payment verification lookup failed");
      throw Errors.unavailable("we could not reach the payment provider; this will settle on its own shortly", "VERIFY_UNAVAILABLE");
    }

    if (v.status === "success" || v.status === "failed") {
      await withTransaction(this.pool, (c) =>
          applyPaymentEvent(c, {
            provider: "PAYSTACK",
            eventId: `charge.${v.status}:${v.id}`,
            eventType: v.status === "success" ? "charge.success" : "charge.failed",
            reference,
            amountKobo: v.amountKobo,
            currency: v.currency,
            // Our own authenticated call to the provider, not an inbound request.
            signatureValid: true,
            payload: { source: "verify-on-return" },
          }),
      );
    }

    const after = await this.pool.query<{ status: string }>(
        row.kind === "ORDER"
            ? `SELECT status FROM payments WHERE provider_reference = $1`
            : `SELECT status FROM wallet_topups WHERE provider_reference = $1`,
        [reference],
    );
    return { reference, kind: row.kind, status: after.rows[0]?.status ?? row.status, orderId: row.order_id, checked: true, providerStatus: v.status };
  }
}

/** Streams objects for the LOCAL storage driver against a short-lived signed grant. */
@Controller("v1/files")
export class FilesController {
  constructor(
      @Inject(CONFIG) private readonly cfg: AppConfig,
      @Inject(STORAGE) private readonly storage: ObjectStorage,
      @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Get(":token")
  async download(@Req() req: PfRequest, @Param("token") token: string, @Res() res: Response) {
    if (this.storage.driver !== "LOCAL" || !this.cfg.STORAGE_SIGNING_SECRET) throw Errors.notFound("route");
    await this.limiter.hit(`files:ip:${req.ip}`, 300, 60);
    const v = verifyGrant(this.cfg.STORAGE_SIGNING_SECRET, token);
    if (!v.ok) throw v.reason === "EXPIRED" ? Errors.gone("this link has expired; request a new one", "LINK_EXPIRED") : Errors.forbidden("invalid link");
    const stream = await this.storage.getStream(v.grant.k).catch(() => {
      throw Errors.notFound("file");
    });
    res.setHeader("Content-Type", v.grant.c);
    res.setHeader("Content-Disposition", `${v.grant.c === "image/png" ? "inline" : "attachment"}; filename="${v.grant.f}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    stream.pipe(res);
  }
}

@Controller("v1")
export class HealthController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    await this.pool.query("SELECT 1");
    return { status: "ready", checkout: checkoutMode(this.cfg), storage: this.cfg.STORAGE_DRIVER };
  }
}