import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrderStatus, ShopPermission } from "../../packages/domain/src/index.js";
import {
  applyPaymentEvent,
  claimJobs,
  completeJob,
  ConflictError,
  failJob,
  issuePickupToken,
  NotFoundError,
  queuePosition,
  redeemPickupCode,
  requestRefund,
  RuleViolationError,
  transitionOrder,
  verifyPaystackSignature,
  withTransaction,
  type PaymentEvent,
} from "../../packages/data/src/index.js";
import { createOrder, expectDbError, freshDatabase, initiatePayment, PEPPER, seedWorld, type World } from "./helpers.js";

let db: pg.Pool;
let alpha: World;
let beta: World;

const OWNER_PERMS: ShopPermission[] = ["orders.view", "orders.accept", "orders.produce", "orders.qa", "orders.collect"];
const OPERATOR_PERMS: ShopPermission[] = ["orders.view", "orders.produce"];

beforeAll(async () => {
  db = await freshDatabase();
  alpha = await seedWorld(db, "Alpha");
  beta = await seedWorld(db, "Beta");
});
afterAll(async () => {
  await db.end();
});

function successEvent(reference: string, amountKobo: number, eventId = `evt_${reference}`): PaymentEvent {
  return { provider: "TEST", eventId, eventType: "charge.success", reference, amountKobo, currency: "NGN", signatureValid: true, payload: { reference } };
}

async function paidOrder(w: World) {
  const o = await createOrder(db, w);
  const ref = await initiatePayment(db, o.orderId, o.totalKobo, w.universityId);
  const outcome = await withTransaction(db, (c) => applyPaymentEvent(c, successEvent(ref, o.totalKobo)));
  expect(outcome).toBe("PAID");
  return { ...o, reference: ref };
}

const shop = (w: World) => ({ kind: "SHOP" as const, shopId: w.shopId });
const statusOf = async (orderId: string) => (await db.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId])).rows[0]!.status;

async function moveTo(orderId: string, w: World, path: Array<[OrderStatus, string?]>) {
  for (const [to, reason] of path) {
    await withTransaction(db, (c) =>
      transitionOrder(c, { orderId, to, scope: shop(w), actorUserId: w.ownerUserId, permissions: OWNER_PERMS, ...(reason ? { reason } : {}) }),
    );
  }
}

describe("complete order journey (data layer)", () => {
  it("quote → order → test payment → queue → accept → print → QA → pickup code → collection", async () => {
    const { orderId, totalKobo } = await paidOrder(alpha);
    expect(await statusOf(orderId)).toBe("PAID");
    expect(await queuePosition(db, orderId)).toBeGreaterThanOrEqual(1);

    await moveTo(orderId, alpha, [["ACCEPTED"], ["PRINTING"], ["QUALITY_CHECK"]]);
    await db.query(`INSERT INTO quality_checks (order_id, shop_id, checked_by, result, sheets_counted) VALUES ($1, $2, $3, 'PASS', 10)`, [orderId, alpha.shopId, alpha.ownerUserId]);
    await moveTo(orderId, alpha, [["READY_FOR_PICKUP"]]);
    expect(await queuePosition(db, orderId)).toBeNull();

    const { code } = await withTransaction(db, (c) => issuePickupToken(c, { orderId, pepper: PEPPER }));
    expect(code).toMatch(/^\d{6}$/);
    const stored = await db.query(`SELECT code_hash FROM pickup_tokens WHERE order_id = $1`, [orderId]);
    expect(JSON.stringify(stored.rows)).not.toContain(code);

    const result = await withTransaction(db, (c) =>
      redeemPickupCode(c, { orderId, shopId: alpha.shopId, staffUserId: alpha.ownerUserId, permissions: OWNER_PERMS, candidate: code, pepper: PEPPER }),
    );
    expect(result).toEqual({ ok: true });
    expect(await statusOf(orderId)).toBe("COLLECTED");

    const events = await db.query<{ to_status: string }>(`SELECT to_status FROM order_events WHERE order_id = $1 ORDER BY id`, [orderId]);
    expect(events.rows.map((e) => e.to_status)).toEqual(["PAID", "ACCEPTED", "PRINTING", "QUALITY_CHECK", "READY_FOR_PICKUP", "COLLECTED"]);
    const payment = await db.query<{ status: string; confirmed_amount_kobo: string }>(`SELECT status, confirmed_amount_kobo FROM payments WHERE order_id = $1`, [orderId]);
    expect(payment.rows[0]).toEqual({ status: "SUCCEEDED", confirmed_amount_kobo: String(totalKobo) });

    const notes = await db.query<{ kind: string }>(`SELECT kind FROM notifications WHERE order_id = $1 ORDER BY id`, [orderId]);
    expect(notes.rows.map((n) => n.kind)).toEqual(["order.paid", "order.accepted", "order.printing", "order.ready_for_pickup", "order.collected"]);
  });
});

describe("authorization and tenant isolation in state changes", () => {
  it("shops cannot see unpaid orders at all", async () => {
    const { orderId } = await createOrder(db, alpha);
    await expect(
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "PAID", scope: shop(alpha), actorUserId: alpha.ownerUserId, permissions: OWNER_PERMS })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("another shop cannot see or act on the order (indistinguishable from not found)", async () => {
    const { orderId } = await paidOrder(alpha);
    await expect(
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "ACCEPTED", scope: shop(beta), actorUserId: beta.ownerUserId, permissions: OWNER_PERMS })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("another university's admin cannot act on the order", async () => {
    const { orderId } = await paidOrder(alpha);
    await expect(
      withTransaction(db, (c) =>
        transitionOrder(c, { orderId, to: "REFUND_PENDING", scope: { kind: "UNIVERSITY", universityId: beta.universityId }, actorUserId: beta.adminUserId, reason: "test refund" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a different student cannot cancel someone else's order", async () => {
    const { orderId } = await createOrder(db, alpha);
    await expect(
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "CANCELLED", scope: { kind: "STUDENT", studentUserId: beta.studentUserId }, actorUserId: beta.studentUserId })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an operator without orders.accept cannot accept", async () => {
    const { orderId } = await paidOrder(alpha);
    await expect(
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "ACCEPTED", scope: shop(alpha), actorUserId: alpha.operatorUserId, permissions: OPERATOR_PERMS })),
    ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
  });

  it("a student cannot mark their own order paid", async () => {
    const { orderId } = await createOrder(db, alpha);
    await expect(
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "PAID", scope: { kind: "STUDENT", studentUserId: alpha.studentUserId }, actorUserId: alpha.studentUserId })),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
  });

  it("students can cancel unpaid orders but not accepted ones", async () => {
    const unpaid = await createOrder(db, alpha);
    const r = await withTransaction(db, (c) =>
      transitionOrder(c, { orderId: unpaid.orderId, to: "CANCELLED", scope: { kind: "STUDENT", studentUserId: alpha.studentUserId }, actorUserId: alpha.studentUserId }),
    );
    expect(r.status).toBe("CANCELLED");

    const paid = await paidOrder(alpha);
    await moveTo(paid.orderId, alpha, [["ACCEPTED"]]);
    await expect(
      withTransaction(db, (c) =>
        transitionOrder(c, { orderId: paid.orderId, to: "REFUND_PENDING", scope: { kind: "STUDENT", studentUserId: alpha.studentUserId }, actorUserId: alpha.studentUserId, reason: "changed my mind" }),
      ),
    ).rejects.toBeInstanceOf(RuleViolationError);
  });

  it("a shop rejection automatically opens a full refund", async () => {
    const o = await paidOrder(alpha);
    const r = await withTransaction(db, (c) =>
      transitionOrder(c, { orderId: o.orderId, to: "REJECTED", scope: shop(alpha), actorUserId: alpha.ownerUserId, permissions: OWNER_PERMS, reason: "Out of A4 paper today" }),
    );
    expect(r.status).toBe("REFUND_PENDING");
    const refunds = await db.query<{ amount_kobo: string }>(`SELECT amount_kobo FROM refunds WHERE order_id = $1`, [o.orderId]);
    expect(refunds.rows.map((x) => Number(x.amount_kobo))).toEqual([o.totalKobo]);
    const job = await db.query(`SELECT 1 FROM jobs WHERE kind = 'REFUND_PROCESS' AND payload->>'refundId' IS NOT NULL`);
    expect(job.rowCount).toBeGreaterThan(0);
  });
});

describe("concurrency", () => {
  it("two staff accepting simultaneously: exactly one succeeds", async () => {
    const { orderId } = await paidOrder(alpha);
    const attempt = () => withTransaction(db, (c) => transitionOrder(c, { orderId, to: "ACCEPTED", scope: shop(alpha), actorUserId: alpha.ownerUserId, permissions: OWNER_PERMS }));
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const accepted = await db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND to_status = 'ACCEPTED'`, [orderId]);
    expect(accepted.rowCount).toBe(1);
  });

  it("accept vs student cancellation race: exactly one wins", async () => {
    const { orderId } = await paidOrder(alpha);
    const results = await Promise.allSettled([
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "ACCEPTED", scope: shop(alpha), actorUserId: alpha.ownerUserId, permissions: OWNER_PERMS })),
      withTransaction(db, (c) =>
        transitionOrder(c, { orderId, to: "REFUND_PENDING", scope: { kind: "STUDENT", studentUserId: alpha.studentUserId }, actorUserId: alpha.studentUserId, reason: "no longer needed" }),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("stale clients get a conflict via optimistic versioning", async () => {
    const { orderId } = await paidOrder(alpha);
    const v = (await db.query<{ row_version: number }>(`SELECT row_version FROM orders WHERE id = $1`, [orderId])).rows[0]!.row_version;
    await withTransaction(db, (c) => transitionOrder(c, { orderId, to: "ACCEPTED", scope: shop(alpha), actorUserId: alpha.ownerUserId, permissions: OWNER_PERMS, expectedVersion: v }));
    await expect(
      withTransaction(db, (c) => transitionOrder(c, { orderId, to: "PRINTING", scope: shop(alpha), actorUserId: alpha.ownerUserId, permissions: OWNER_PERMS, expectedVersion: v })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("queue positions are consistent under concurrent payments", async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, () => createOrder(db, beta)));
    await Promise.all(
      orders.map(async (o) => {
        const ref = await initiatePayment(db, o.orderId, o.totalKobo, beta.universityId);
        await withTransaction(db, (c) => applyPaymentEvent(c, successEvent(ref, o.totalKobo)));
      }),
    );
    const positions = await Promise.all(orders.map((o) => queuePosition(db, o.orderId)));
    const sorted = [...positions].sort((a, b) => a! - b!);
    expect(new Set(positions).size).toBe(6);
    expect(sorted[sorted.length - 1]! - sorted[0]!).toBe(5);
  });
});

describe("payments", () => {
  it("duplicate webhook deliveries are applied once", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    const ev = successEvent(ref, o.totalKobo, "evt-dup-1");
    const outcomes = await Promise.all([1, 2, 3].map(() => withTransaction(db, (c) => applyPaymentEvent(c, ev)).catch((e: Error) => e.message)));
    expect(outcomes.filter((x) => x === "PAID")).toHaveLength(1);
    expect(outcomes.filter((x) => x !== "PAID").every((x) => x === "DUPLICATE" || /duplicate key/.test(String(x)))).toBe(true);
    const paidEvents = await db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND to_status = 'PAID'`, [o.orderId]);
    expect(paidEvents.rowCount).toBe(1);
  });

  it("a second success event for an already-paid payment is ignored", async () => {
    const o = await paidOrder(alpha);
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, successEvent(o.reference, o.totalKobo, "evt-second")))).toBe("ALREADY_FINAL");
  });

  it("unsigned events are stored but never acted on", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    const outcome = await withTransaction(db, (c) => applyPaymentEvent(c, { ...successEvent(ref, o.totalKobo, "evt-forged"), signatureValid: false }));
    expect(outcome).toBe("REJECTED_SIGNATURE");
    expect(await statusOf(o.orderId)).toBe("AWAITING_PAYMENT");
  });

  it("a forged event cannot suppress the genuine event with the same id", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    const ev = successEvent(ref, o.totalKobo, "evt-poison-1");
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, { ...ev, signatureValid: false }))).toBe("REJECTED_SIGNATURE");
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, ev))).toBe("PAID");
  });

  it("underpayment is never marked paid", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, successEvent(ref, o.totalKobo - 100)))).toBe("AMOUNT_MISMATCH");
    const s = await db.query<{ status: string }>(`SELECT status FROM payments WHERE provider_reference = $1`, [ref]);
    expect(s.rows[0]!.status).toBe("INITIATED");
  });

  it("failed payments are recorded and the order stays unpaid", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, { ...successEvent(ref, o.totalKobo), eventType: "charge.failed" }))).toBe("FAILED_RECORDED");
    expect(await statusOf(o.orderId)).toBe("AWAITING_PAYMENT");
  });

  it("payments must equal the order total", async () => {
    const o = await createOrder(db, alpha);
    await expectDbError(initiatePayment(db, o.orderId, o.totalKobo + 1, alpha.universityId), "does not equal order total");
  });

  it("money arriving after an order expired is refunded, not kept", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    await withTransaction(db, (c) => transitionOrder(c, { orderId: o.orderId, to: "EXPIRED", scope: { kind: "SYSTEM" }, actorUserId: null }));
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, successEvent(ref, o.totalKobo)))).toBe("PAID_LATE_REFUND_REQUESTED");
    const r = await db.query<{ amount_kobo: string }>(`SELECT amount_kobo FROM refunds WHERE order_id = $1`, [o.orderId]);
    expect(Number(r.rows[0]!.amount_kobo)).toBe(o.totalKobo);
  });

  it("provider refund confirmation completes the refund and the order", async () => {
    const o = await paidOrder(alpha);
    await withTransaction(db, (c) =>
      transitionOrder(c, { orderId: o.orderId, to: "REFUND_PENDING", scope: { kind: "UNIVERSITY", universityId: alpha.universityId }, actorUserId: alpha.adminUserId, reason: "Shop closed" }),
    );
    const refund = (await db.query<{ id: string }>(`SELECT id FROM refunds WHERE order_id = $1`, [o.orderId])).rows[0]!;
    await db.query(`UPDATE refunds SET status = 'PROCESSING', provider_refund_reference = $2 WHERE id = $1`, [refund.id, `rf_${refund.id}`]);
    const ev: PaymentEvent = { provider: "TEST", eventId: `evt_rf_${refund.id}`, eventType: "refund.processed", reference: `rf_${refund.id}`, amountKobo: o.totalKobo, currency: "NGN", signatureValid: true, payload: {} };
    expect(await withTransaction(db, (c) => applyPaymentEvent(c, ev))).toBe("REFUND_COMPLETED");
    expect(await statusOf(o.orderId)).toBe("REFUNDED");
  });

  it("verifies Paystack HMAC-SHA512 signatures over the raw body", () => {
    const body = Buffer.from('{"event":"charge.success","data":{"reference":"x"}}');
    const sig = createHmac("sha512", "sk_test_secret").update(body).digest("hex");
    expect(verifyPaystackSignature(body, sig, "sk_test_secret")).toBe(true);
    expect(verifyPaystackSignature(body, sig, "sk_test_other")).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(body.toString() + " "), sig, "sk_test_secret")).toBe(false);
    expect(verifyPaystackSignature(body, undefined, "sk_test_secret")).toBe(false);
    expect(verifyPaystackSignature(body, "zz", "sk_test_secret")).toBe(false);
  });
});

describe("refunds", () => {
  const paymentIdOf = async (orderId: string) => (await db.query<{ id: string }>(`SELECT id FROM payments WHERE order_id = $1`, [orderId])).rows[0]!.id;

  it("are idempotent per key", async () => {
    const o = await paidOrder(alpha);
    const pid = await paymentIdOf(o.orderId);
    const params = { orderId: o.orderId, paymentId: pid, amountKobo: 1000, reason: "partial", idempotencyKey: "rf-key-0001-aaaa", requestedBy: alpha.adminUserId };
    const a = await withTransaction(db, (c) => requestRefund(c, params));
    const b = await withTransaction(db, (c) => requestRefund(c, params));
    expect(b).toEqual({ refundId: a.refundId, created: false });
    await expect(withTransaction(db, (c) => requestRefund(c, { ...params, amountKobo: 2000 }))).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("can never exceed the amount paid (sequential)", async () => {
    const o = await paidOrder(alpha);
    const pid = await paymentIdOf(o.orderId);
    const half = Math.floor(o.totalKobo / 2) + 1;
    await withTransaction(db, (c) => requestRefund(c, { orderId: o.orderId, paymentId: pid, amountKobo: half, reason: "first", idempotencyKey: "rf-seq-1-xxxxxxxxxx", requestedBy: null }));
    await expectDbError(
      withTransaction(db, (c) => requestRefund(c, { orderId: o.orderId, paymentId: pid, amountKobo: half, reason: "second", idempotencyKey: "rf-seq-2-xxxxxxxxxx", requestedBy: null })),
      "would exceed payment",
    );
  });

  it("can never exceed the amount paid under a forced concurrent interleaving", async () => {
    const o = await paidOrder(alpha);
    const pid = await paymentIdOf(o.orderId);
    const half = Math.floor(o.totalKobo / 2) + 1; // two of these exceed the total
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await requestRefund(a, { orderId: o.orderId, paymentId: pid, amountKobo: half, reason: "race A", idempotencyKey: "rf-race-a-xxxxxxxx", requestedBy: null });
      let bSettled = false;
      const bResult = requestRefund(b, { orderId: o.orderId, paymentId: pid, amountKobo: half, reason: "race B", idempotencyKey: "rf-race-b-xxxxxxxx", requestedBy: null })
        .then(
          () => "ok",
          (e: Error) => e.message,
        )
        .finally(() => {
          bSettled = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(bSettled, "B should be blocked on the payment row lock while A is open").toBe(false);
      await a.query("COMMIT");
      expect(await bResult).toMatch(/would exceed payment/);
      await b.query("ROLLBACK");
    } finally {
      a.release();
      b.release();
    }
    const sum = await db.query<{ s: string }>(`SELECT sum(amount_kobo) AS s FROM refunds WHERE payment_id = $1`, [pid]);
    expect(Number(sum.rows[0]!.s)).toBe(half);
  });

  it("cannot refund an unpaid payment", async () => {
    const o = await createOrder(db, alpha);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, alpha.universityId);
    const pid = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE provider_reference = $1`, [ref])).rows[0]!.id;
    await expectDbError(
      withTransaction(db, (c) => requestRefund(c, { orderId: o.orderId, paymentId: pid, amountKobo: 100, reason: "nope", idempotencyKey: "rf-unpaid-xxxxxxxx", requestedBy: null })),
      "has not succeeded",
    );
  });

  it("cannot be attached to a payment from a different order", async () => {
    const a = await paidOrder(alpha);
    const b = await paidOrder(alpha);
    const pidA = await paymentIdOf(a.orderId);
    await expect(
      withTransaction(db, (c) => requestRefund(c, { orderId: b.orderId, paymentId: pidA, amountKobo: 100, reason: "mismatch", idempotencyKey: "rf-mismatch-xxxxxx", requestedBy: null })),
    ).rejects.toMatchObject({ code: "PAYMENT_ORDER_MISMATCH" });
  });
});

describe("pickup codes", () => {
  async function readyOrder(w: World) {
    const o = await paidOrder(w);
    await moveTo(o.orderId, w, [["ACCEPTED"], ["PRINTING"], ["QUALITY_CHECK"], ["READY_FOR_PICKUP"]]);
    const t = await withTransaction(db, (c) => issuePickupToken(c, { orderId: o.orderId, pepper: PEPPER }));
    return { ...o, ...t };
  }
  const redeem = (w: World, orderId: string, candidate: string, perms = OWNER_PERMS) =>
    withTransaction(db, (c) => redeemPickupCode(c, { orderId, shopId: w.shopId, staffUserId: w.ownerUserId, permissions: perms, candidate, pepper: PEPPER }));

  it("double collection race: exactly one succeeds, the other sees ALREADY_COLLECTED", async () => {
    const o = await readyOrder(alpha);
    const results = await Promise.all([redeem(alpha, o.orderId, o.code), redeem(alpha, o.orderId, o.code)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "ALREADY_COLLECTED" });
  });

  it("replaying a used code fails", async () => {
    const o = await readyOrder(alpha);
    expect(await redeem(alpha, o.orderId, o.code)).toEqual({ ok: true });
    expect(await redeem(alpha, o.orderId, o.code)).toMatchObject({ ok: false, reason: "ALREADY_COLLECTED" });
    await expectDbError(db.query(`UPDATE pickup_tokens SET used_at = NULL, used_by = NULL WHERE order_id = $1`, [o.orderId]), "spent");
  });

  it("locks after 5 wrong attempts, persisting each failure", async () => {
    const o = await readyOrder(alpha);
    const wrong = o.code === "000000" ? "111111" : "000000";
    for (let i = 4; i >= 0; i--) {
      expect(await redeem(alpha, o.orderId, wrong)).toEqual({ ok: false, reason: "WRONG_CODE", attemptsRemaining: i });
    }
    expect(await redeem(alpha, o.orderId, o.code)).toMatchObject({ ok: false, reason: "LOCKED" });
    const fails = await db.query(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'pickup.failed_attempt'`, [o.orderId]);
    expect(fails.rowCount).toBe(6);
  });

  it("re-issuing revokes the previous code", async () => {
    const o = await readyOrder(alpha);
    const fresh = await withTransaction(db, (c) => issuePickupToken(c, { orderId: o.orderId, pepper: PEPPER }));
    if (fresh.code !== o.code) {
      expect(await redeem(alpha, o.orderId, o.code)).toMatchObject({ ok: false, reason: "WRONG_CODE" });
    }
    expect(await redeem(alpha, o.orderId, fresh.code)).toEqual({ ok: true });
  });

  it("expired codes are rejected", async () => {
    const o = await readyOrder(alpha);
    const later = new Date(o.expiresAt.getTime() + 1000);
    const r = await withTransaction(db, (c) =>
      redeemPickupCode(c, { orderId: o.orderId, shopId: alpha.shopId, staffUserId: alpha.ownerUserId, permissions: OWNER_PERMS, candidate: o.code, pepper: PEPPER, now: later }),
    );
    expect(r).toMatchObject({ ok: false, reason: "EXPIRED" });
  });

  it("another shop cannot redeem, and staff without orders.collect cannot redeem", async () => {
    const o = await readyOrder(alpha);
    await expect(
      withTransaction(db, (c) => redeemPickupCode(c, { orderId: o.orderId, shopId: beta.shopId, staffUserId: beta.ownerUserId, permissions: OWNER_PERMS, candidate: o.code, pepper: PEPPER })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(redeem(alpha, o.orderId, o.code, OPERATOR_PERMS)).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
  });

  it("codes are not issued before the order is ready", async () => {
    const o = await paidOrder(alpha);
    await expect(withTransaction(db, (c) => issuePickupToken(c, { orderId: o.orderId, pepper: PEPPER }))).rejects.toMatchObject({ code: "NOT_READY" });
  });
});

describe("production failures and reprints", () => {
  it("failed print can retry, QA failure triggers reprint, unrecoverable failure goes to refund", async () => {
    const o = await paidOrder(alpha);
    await moveTo(o.orderId, alpha, [["ACCEPTED"], ["PRINTING"], ["PAUSED", "Out of toner"], ["PRINTING"], ["PRINT_FAILED", "Paper jam on Printer 1"], ["PRINTING"], ["QUALITY_CHECK"]]);
    await db.query(`INSERT INTO quality_checks (order_id, shop_id, checked_by, result, issues, sheets_counted) VALUES ($1, $2, $3, 'FAIL', ARRAY['MISSING_PAGES'], 8)`, [
      o.orderId,
      alpha.shopId,
      alpha.ownerUserId,
    ]);
    await moveTo(o.orderId, alpha, [["PRINTING", "Reprint: pages 4-5 missing"], ["PRINT_FAILED", "Device fault"], ["REFUND_PENDING", "Cannot complete job"]]);
    expect(await statusOf(o.orderId)).toBe("REFUND_PENDING");
    expect(await queuePosition(db, o.orderId)).toBeNull();
  });

  it("failing QA requires recorded issues", async () => {
    const o = await paidOrder(alpha);
    await expectDbError(
      db.query(`INSERT INTO quality_checks (order_id, shop_id, checked_by, result) VALUES ($1, $2, $3, 'FAIL')`, [o.orderId, alpha.shopId, alpha.ownerUserId]),
      "check constraint",
    );
  });
});

describe("job queue", () => {
  it("two workers never claim the same job; failures back off, then die", async () => {
    await db.query(`INSERT INTO jobs (kind, payload, max_attempts) SELECT 'RETENTION_PURGE', '{}'::jsonb, 2 FROM generate_series(1, 10)`);
    const [a, b] = await Promise.all([
      withTransaction(db, (c) => claimJobs(c, "worker-a", ["RETENTION_PURGE"], 6)),
      withTransaction(db, (c) => claimJobs(c, "worker-b", ["RETENTION_PURGE"], 6)),
    ]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);

    const first = a[0]!;
    expect(await failJob(db, first, "boom")).toBe("RETRY");
    await db.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [first.id]);
    const again = await withTransaction(db, (c) => claimJobs(c, "worker-a", ["RETENTION_PURGE"], 20));
    const reclaimed = again.find((j) => j.id === first.id)!;
    expect(reclaimed.attempts).toBe(2);
    expect(await failJob(db, reclaimed, "boom again")).toBe("DEAD");
    await completeJob(db, a[1]!.id);
    const st = await db.query<{ status: string }>(`SELECT status FROM jobs WHERE id = ANY($1) ORDER BY id`, [[first.id, a[1]!.id]]);
    expect(st.rows.map((r) => r.status).sort()).toEqual(["DEAD", "SUCCEEDED"]);
  });
});
