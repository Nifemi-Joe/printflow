import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyWalletToOrder, refundOrder, transitionOrder, walletBalance, withTransaction } from "../../packages/data/src/index.js";
import { createOrder, expectDbError, FAKE_HASH, freshDatabase, initiatePayment, readyDocument, seedWorld, type World } from "./helpers.js";

/**
 * The wallet's money rules are enforced by the database itself, so a bug in the API
 * can never create, lose or duplicate wallet money. These tests go straight at SQL.
 */
let db: pg.Pool;
let w: World;

beforeAll(async () => {
  db = await freshDatabase("printflow_wallet_db_test");
  w = await seedWorld(db, "Wallet");
});
afterAll(async () => {
  await db.end();
});

async function succeededTopup(userId: string, universityId: string, amountKobo: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO wallet_topups (user_id, university_id, provider, provider_reference, amount_kobo) VALUES ($1, $2, 'TEST', $3, $4) RETURNING id`,
    [userId, universityId, `pft_${randomUUID().replace(/-/g, "")}`, amountKobo],
  );
  await db.query(`UPDATE wallet_topups SET status = 'SUCCEEDED', confirmed_amount_kobo = amount_kobo, confirmed_at = now() WHERE id = $1`, [rows[0]!.id]);
  return rows[0]!.id;
}

async function credit(userId: string, amountKobo: number): Promise<void> {
  const t = await succeededTopup(userId, w.universityId, amountKobo);
  await db.query(`INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, topup_id, idempotency_key) VALUES ($1, $2, 'TOPUP', $3, $4, $5)`, [
    userId,
    w.universityId,
    amountKobo,
    t,
    `topup:${t}`,
  ]);
}

async function newStudent(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO users (email, full_name, password_hash) VALUES ($1, 'Wallet Student', $2) RETURNING id`, [`ws.${randomUUID()}@example.test`, FAKE_HASH]);
  await db.query(`INSERT INTO student_profiles (user_id, university_id, campus_id) VALUES ($1, $2, $3)`, [rows[0]!.id, w.universityId, w.campusId]);
  return rows[0]!.id;
}

describe("wallet ledger invariants", () => {
  it("every student gets an empty wallet, created with their profile", async () => {
    const id = await newStudent();
    expect(await walletBalance(db, id)).toEqual({ cashKobo: 0, promoKobo: 0, totalKobo: 0 });
  });

  it("balances cannot be edited directly, only through ledger entries", async () => {
    const id = await newStudent();
    await expectDbError(db.query(`UPDATE wallets SET cash_kobo = 1000000 WHERE user_id = $1`, [id]), "only through wallet_entries");
    await expectDbError(db.query(`DELETE FROM wallets WHERE user_id = $1`, [id]), /append-only|not allowed|cannot/);
  });

  it("ledger entries are append-only", async () => {
    const id = await newStudent();
    await credit(id, 10_000);
    await expectDbError(db.query(`UPDATE wallet_entries SET cash_kobo = 999999 WHERE user_id = $1`, [id]), /append-only|not allowed|cannot/);
    await expectDbError(db.query(`DELETE FROM wallet_entries WHERE user_id = $1`, [id]), /append-only|not allowed|cannot/);
  });

  it("a top-up credit must match a succeeded top-up, exactly once", async () => {
    const id = await newStudent();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO wallet_topups (user_id, university_id, provider, provider_reference, amount_kobo) VALUES ($1, $2, 'TEST', $3, 50000) RETURNING id`,
      [id, w.universityId, `pft_${randomUUID().replace(/-/g, "")}`],
    );
    const insert = (amount: number, key: string) =>
      db.query(`INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, topup_id, idempotency_key) VALUES ($1, $2, 'TOPUP', $3, $4, $5)`, [id, w.universityId, amount, rows[0]!.id, key]);
    await expectDbError(insert(50_000, `t1-${randomUUID()}`), "must match a succeeded top-up");
    await db.query(`UPDATE wallet_topups SET status = 'SUCCEEDED', confirmed_amount_kobo = 50000, confirmed_at = now() WHERE id = $1`, [rows[0]!.id]);
    await expectDbError(insert(90_000, `t2-${randomUUID()}`), "must match a succeeded top-up");
    await insert(50_000, `t3-${randomUUID()}`);
    await expectDbError(insert(50_000, `t4-${randomUUID()}`), /duplicate key|unique/);
    expect((await walletBalance(db, id)).cashKobo).toBe(50_000);
  });

  it("a duplicate entry skipped by ON CONFLICT never moves the balance", async () => {
    const id = await newStudent();
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO wallet_entries (user_id, university_id, kind, promo_kobo, idempotency_key, note) VALUES ($1, $2, 'WELCOME_CREDIT', 5000, $3, 'Welcome credit') ON CONFLICT DO NOTHING`,
        [id, w.universityId, `welcome:${id}`],
      );
    }
    expect((await walletBalance(db, id)).promoKobo).toBe(5_000);
  });

  it("the balance can never go below zero, even under concurrent spending", async () => {
    const id = await newStudent();
    const doc = await readyDocument(db, id, w.universityId);
    const me = { ...w, studentUserId: id, documentVersionId: doc.documentVersionId, documentSha256: doc.documentSha256 };
    const orders = await Promise.all([createOrder(db, me), createOrder(db, me), createOrder(db, me)]);
    await credit(id, orders[0]!.totalKobo + 100);
    // Three orders race for a balance that covers one.
    const results = await Promise.allSettled(orders.map((o) => withTransaction(db, (c) => applyWalletToOrder(c, { orderId: o.orderId, userId: id, lowBalanceKobo: 0 }))));
    const applied = results.map((r) => (r.status === "fulfilled" ? r.value.appliedKobo : 0));
    expect(applied.reduce((a, b) => a + b, 0)).toBe(orders[0]!.totalKobo + 100);
    expect((await walletBalance(db, id)).totalKobo).toBe(0);
    // A direct over-spend is refused by the database.
    await expectDbError(
      db.query(`INSERT INTO wallet_entries (user_id, university_id, kind, promo_kobo, idempotency_key, note, created_by) VALUES ($1, $2, 'PROMO_REVOKE', -1, $3, 'x', $4)`, [id, w.universityId, `s-${randomUUID()}`, w.adminUserId]),
      "insufficient wallet balance",
    );
  });

  it("an order can take from the wallet once, only while awaiting payment, and never more than its total", async () => {
    await credit(w.studentUserId, 100_000);
    const o = await createOrder(db, w);
    const take = (cash: number, key: string) =>
      db.query(`INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, order_id, idempotency_key) VALUES ($1, $2, 'ORDER_PAYMENT', $3, $4, $5)`, [
        w.studentUserId,
        w.universityId,
        -cash,
        o.orderId,
        key,
      ]);
    await expectDbError(take(o.totalKobo + 1, `p1-${randomUUID()}`), "exceeds order total");
    await take(1_000, `p2-${randomUUID()}`);
    await expectDbError(take(1_000, `p3-${randomUUID()}`), /duplicate key|unique/);
    // The provider payment must be exactly the remainder.
    await expectDbError(initiatePayment(db, o.orderId, o.totalKobo, w.universityId), "does not equal the amount due");
    await initiatePayment(db, o.orderId, o.totalKobo - 1_000, w.universityId);
  });

  it("an order cannot be marked paid unless wallet + provider money covers the whole total", async () => {
    await credit(w.studentUserId, 100_000);
    const o = await createOrder(db, w);
    await withTransaction(db, (c) => applyWalletToOrder(c, { orderId: o.orderId, userId: w.studentUserId, lowBalanceKobo: 0 }));
    const partial = await createOrder(db, w);
    await db.query(`INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, order_id, idempotency_key) VALUES ($1, $2, 'ORDER_PAYMENT', -100, $3, $4)`, [
      w.studentUserId,
      w.universityId,
      partial.orderId,
      `partial-${randomUUID()}`,
    ]);
    await expectDbError(
      withTransaction(db, (c) => transitionOrder(c, { orderId: partial.orderId, to: "PAID", scope: { kind: "SYSTEM" }, actorUserId: null })),
      "not paid in full",
    );
    const full = await withTransaction(db, (c) => transitionOrder(c, { orderId: o.orderId, to: "PAID", scope: { kind: "SYSTEM" }, actorUserId: null }));
    expect(full.status).toBe("PAID");
  });

  it("returns can never exceed what an order took, and promo never comes back as cash", async () => {
    const id = w.studentUserId;
    const before = await walletBalance(db, id);
    await db.query(
      `INSERT INTO wallet_entries (user_id, university_id, kind, promo_kobo, idempotency_key, note, created_by) VALUES ($1, $2, 'PROMO_GRANT', 2000, $3, 'Raffle', $4)`,
      [id, w.universityId, `g-${randomUUID()}`, w.adminUserId],
    );
    const o = await createOrder(db, w);
    const r = await withTransaction(db, (c) => applyWalletToOrder(c, { orderId: o.orderId, userId: id, lowBalanceKobo: 0 }));
    expect(r.appliedKobo).toBe(o.totalKobo);
    await withTransaction(db, (c) => transitionOrder(c, { orderId: o.orderId, to: "PAID", scope: { kind: "SYSTEM" }, actorUserId: null }));
    const ret = (cash: number, promo: number) =>
      db.query(`INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, promo_kobo, order_id, idempotency_key) VALUES ($1, $2, 'ORDER_RETURN', $3, $4, $5, $6)`, [
        id,
        w.universityId,
        cash,
        promo,
        o.orderId,
        `r-${randomUUID()}`,
      ]);
    // Promo (2,000) was spent first, so only total-2,000 came from cash.
    await expectDbError(ret(o.totalKobo, 0), "exceeds what this order took");
    await expectDbError(ret(0, 2_001), "exceeds what this order took");
    // The real refund path returns each bucket exactly.
    const res = await withTransaction(db, async (c) => {
      await c.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [o.orderId]);
      return refundOrder(c, { orderId: o.orderId, destination: "WALLET", reason: "Shop closed", idempotencyKey: `rf-${o.orderId}`, requestedBy: null });
    });
    expect(res.toWalletKobo).toBe(o.totalKobo);
    const after = await walletBalance(db, id);
    expect(after).toEqual({ cashKobo: before.cashKobo, promoKobo: before.promoKobo + 2_000, totalKobo: before.totalKobo + 2_000 });
    // Running the same refund again is a no-op.
    const again = await withTransaction(db, (c) => refundOrder(c, { orderId: o.orderId, destination: "WALLET", reason: "Shop closed", idempotencyKey: `rf-${o.orderId}`, requestedBy: null }));
    expect(again.replayed).toBe(true);
    expect(await walletBalance(db, id)).toEqual(after);
  });

  it("wallet refunds of card money are instant and capped by the card payment", async () => {
    const o = await createOrder(db, w);
    const ref = await initiatePayment(db, o.orderId, o.totalKobo, w.universityId);
    await db.query(`UPDATE payments SET status = 'SUCCEEDED', confirmed_amount_kobo = amount_kobo, confirmed_at = now() WHERE provider_reference = $1`, [ref]);
    const pay = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE provider_reference = $1`, [ref])).rows[0]!.id;
    await expectDbError(
      db.query(`INSERT INTO refunds (payment_id, order_id, university_id, amount_kobo, reason, idempotency_key, destination) VALUES ($1, $2, $3, 100, 'test', $4, 'WALLET')`, [pay, o.orderId, w.universityId, `x-${randomUUID()}`]),
      /refunds_wallet_is_instant|check constraint/,
    );
    await expectDbError(
      db.query(
        `INSERT INTO refunds (payment_id, order_id, university_id, amount_kobo, reason, idempotency_key, destination, status, completed_at) VALUES ($1, $2, $3, $4, 'test', $5, 'WALLET', 'SUCCEEDED', now())`,
        [pay, o.orderId, w.universityId, o.totalKobo + 1, `y-${randomUUID()}`],
      ),
      "would exceed payment",
    );
  });

  it("wallets stay within the hard ceiling", async () => {
    const id = await newStudent();
    await credit(id, 50_000_000);
    await credit(id, 50_000_000);
    await expectDbError(credit(id, 10_000), "wallet limit");
  });
});
