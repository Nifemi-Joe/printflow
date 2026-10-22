import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { Client, createUser, onboardUniversity, openShop, publishCampusCard, registerStudent, startHarness, type Campus, type Harness, type ShopSetup } from "./harness.js";

let h: Harness;
let uni: Campus;
let other: Campus;
let shop: ShopSetup;
let pdf: Buffer;

beforeAll(async () => {
    h = await startHarness({ WALLET_LOW_BALANCE_KOBO: "50000" }, "printflow_wallet_test");
    const p = await createUser(h, "w-platform", { platformRole: "PLATFORM_ADMIN" });
    const platform = await Client.login(h, p.email);
    uni = await onboardUniversity(h, platform, "w-uni");
    other = await onboardUniversity(h, platform, "w-other");
    await publishCampusCard(uni);
    shop = await openShop(h, uni, "Wallet Test Shop");
    const dir = mkdtempSync(join(tmpdir(), "pf-w-"));
    await makePdf(join(dir, "a.pdf"), 2);
    pdf = readFileSync(join(dir, "a.pdf"));
}, 120_000);
afterAll(async () => {
    await h.close();
});

type Student = Awaited<ReturnType<typeof registerStudent>>;

async function order(st: Student, copies = 1) {
    const up = await st.client.upload("/v1/documents", pdf, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shop.shopId, spec: { copies, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": `w-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    expect(o.status).toBe(201);
    return { id: o.body.id as string, totalKobo: Number(q.body.totalKobo) };
}

async function topUp(st: Student, amountKobo: number, outcome: "success" | "failed" = "success") {
    const t = await st.client.post("/v1/me/wallet/topups", { amountKobo, method: "BANK_TRANSFER" });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const done = await st.client.post(`/v1/test-payments/${t.body.reference}/complete`, { outcome });
    expect(done.status).toBe(200);
    return t.body.reference as string;
}

const wallet = async (st: Student) => (await st.client.get("/v1/me/wallet")).body;
const grant = (amountKobo: number, email: string, note = "Exam week thank-you") =>
    uni.admin.post(`/v1/admin/universities/${uni.universityId}/wallet/credit`, { email, amountKobo, note }, { "Idempotency-Key": `grant-${Date.now()}-${Math.random().toString(36).slice(2)}` });

describe("wallet: top-ups", () => {
    it("a new student has an empty wallet with the spend-only terms", async () => {
        const st = await registerStudent(h, uni, "w-new");
        const w = await wallet(st);
        expect(w).toMatchObject({ cashKobo: 0, promoKobo: 0, totalKobo: 0, entries: [], topUp: { available: true } });
        expect(w.terms).toMatch(/cannot be withdrawn/);
    });

    it("credits a top-up only when the provider confirms it, once, and texts the student", async () => {
        const st = await registerStudent(h, uni, "w-topup");
        await h.pool.query(`UPDATE users SET phone = '+2348031112233', phone_verified_at = now() WHERE id = $1`, [st.userId]);
        const t = await st.client.post("/v1/me/wallet/topups", { amountKobo: 200_000, method: "USSD" });
        expect(t.body).toMatchObject({ amountKobo: 200_000, methods: ["USSD"], mode: "TEST" });
        expect(t.body.checkoutUrl).toContain(`/checkout/test/${t.body.reference}`);
        // Started is not paid.
        expect((await wallet(st)).totalKobo).toBe(0);
        const detail = await st.client.get(`/v1/test-payments/${t.body.reference}`);
        expect(detail.body).toMatchObject({ kind: "TOPUP", amountKobo: 200_000, returnTo: `/student/wallet?topup=${t.body.reference}` });

        const done = await st.client.post(`/v1/test-payments/${t.body.reference}/complete`, { outcome: "success" });
        expect(done.body.outcome).toBe("TOPUP_CREDITED");
        const w = await wallet(st);
        expect(w).toMatchObject({ cashKobo: 200_000, promoKobo: 0, totalKobo: 200_000 });
        expect(w.entries[0]).toMatchObject({ kind: "TOPUP", amountKobo: 200_000, label: "Top-up" });
        expect((await st.client.get(`/v1/me/wallet/topups/${t.body.reference}`)).body).toMatchObject({ status: "SUCCEEDED", paidWith: "USSD" });

        // A replayed provider event changes nothing.
        const again = await st.client.post(`/v1/test-payments/${t.body.reference}/complete`, { outcome: "success" });
        expect(again.body.outcome).toBe("ALREADY_FINAL");
        expect((await wallet(st)).totalKobo).toBe(200_000);

        await h.drain();
        expect(h.sms.sent.some((m) => m.to === "+2348031112233" && /₦2,000 added to your PrintFlow wallet/.test(m.text))).toBe(true);
    });

    it("a failed top-up adds nothing; a later success for it still lands", async () => {
        const st = await registerStudent(h, uni, "w-failed");
        const t = await st.client.post("/v1/me/wallet/topups", { amountKobo: 50_000 });
        await st.client.post(`/v1/test-payments/${t.body.reference}/complete`, { outcome: "failed" });
        expect((await wallet(st)).totalKobo).toBe(0);
        await st.client.post(`/v1/test-payments/${t.body.reference}/complete`, { outcome: "success" });
        expect((await wallet(st)).totalKobo).toBe(50_000);
    });

    it("enforces top-up limits and the wallet ceiling, counting top-ups still being paid", async () => {
        const st = await registerStudent(h, uni, "w-limits");
        const small = await st.client.post("/v1/me/wallet/topups", { amountKobo: 5_000 });
        expect(small.body.error.code).toBe("TOPUP_AMOUNT");
        const kobo = await st.client.post("/v1/me/wallet/topups", { amountKobo: 10_050 });
        expect(kobo.body.error.code).toBe("TOPUP_AMOUNT");
        const big = await st.client.post("/v1/me/wallet/topups", { amountKobo: h.cfg.WALLET_TOPUP_MAX_KOBO + 100 });
        expect(big.body.error.code).toBe("TOPUP_AMOUNT");
        // Fill to the ceiling with pending top-ups, then one more is refused.
        let left = h.cfg.WALLET_MAX_BALANCE_KOBO;
        while (left > 0) {
            const amt = Math.min(left, h.cfg.WALLET_TOPUP_MAX_KOBO);
            expect((await st.client.post("/v1/me/wallet/topups", { amountKobo: amt })).status).toBe(201);
            left -= amt;
        }
        const over = await st.client.post("/v1/me/wallet/topups", { amountKobo: 10_000 });
        expect(over.body.error.code).toBe("WALLET_LIMIT");
    });

    it("wallets belong to students only; staff and anonymous callers are refused", async () => {
        expect((await shop.owner.get("/v1/me/wallet")).status).toBe(403);
        expect((await request(h.app.getHttpServer()).get("/v1/me/wallet")).status).toBe(401);
    });
});

describe("wallet: paying for prints", () => {
    it("pays an order entirely from the wallet: no checkout, straight into the queue", async () => {
        const st = await registerStudent(h, uni, "w-full");
        await topUp(st, 100_000);
        const o = await order(st);
        const pay = await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        expect(pay.status).toBe(201);
        expect(pay.body).toMatchObject({ paidFromWallet: true, walletKobo: o.totalKobo, amountKobo: 0 });
        expect(pay.body.checkoutUrl).toBeUndefined();
        const d = await st.client.get(`/v1/orders/${o.id}`);
        expect(d.body.status).toBe("PAID");
        expect(d.body.wallet).toMatchObject({ appliedKobo: o.totalKobo, amountDueKobo: 0, balanceKobo: 100_000 - o.totalKobo });
        // The shop sees it as an ordinary paid job.
        const q = await shop.owner.get(`/v1/shops/${shop.shopId}/queue`);
        expect(JSON.stringify(q.body)).toContain(o.id);
        // Paying again is refused; the balance is untouched.
        expect((await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true })).body.error.code).toBe("NOT_PAYABLE");
        expect((await wallet(st)).totalKobo).toBe(100_000 - o.totalKobo);
    });

    it("split payment: the wallet covers part, the card pays the rest, and both are needed", async () => {
        const st = await registerStudent(h, uni, "w-split");
        await topUp(st, 10_000);
        const o = await order(st, 3);
        expect(o.totalKobo).toBeGreaterThan(10_000);
        const pay = await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true, method: "CARD" });
        expect(pay.body).toMatchObject({ paidFromWallet: false, walletKobo: 10_000, amountKobo: o.totalKobo - 10_000 });
        expect((await wallet(st)).totalKobo).toBe(0);
        let d = await st.client.get(`/v1/orders/${o.id}`);
        expect(d.body.status).toBe("AWAITING_PAYMENT");
        expect(d.body.wallet).toMatchObject({ appliedKobo: 10_000, amountDueKobo: o.totalKobo - 10_000 });
        // Opening a new checkout keeps the wallet part and charges only the rest.
        const again = await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        expect(again.body.amountKobo).toBe(o.totalKobo - 10_000);
        await st.client.post(`/v1/test-payments/${again.body.reference}/complete`, { outcome: "success" });
        d = await st.client.get(`/v1/orders/${o.id}`);
        expect(d.body.status).toBe("PAID");
        expect(d.body.payments.find((p: { status: string }) => p.status === "SUCCEEDED").amountKobo).toBe(String(o.totalKobo - 10_000));
    });

    it("money for a checkout the student moved on from goes to their wallet, never lost or double-counted", async () => {
        const st = await registerStudent(h, uni, "w-stray");
        const o = await order(st);
        const first = await st.client.post(`/v1/orders/${o.id}/payments`, { method: "BANK_TRANSFER" });
        const second = await st.client.post(`/v1/orders/${o.id}/payments`, { method: "CARD" });
        await st.client.post(`/v1/test-payments/${second.body.reference}/complete`, { outcome: "success" });
        // The abandoned bank transfer arrives later anyway.
        const late = await st.client.post(`/v1/test-payments/${first.body.reference}/complete`, { outcome: "success" });
        expect(late.body.outcome).toBe("CREDITED_TO_WALLET");
        expect((await st.client.get(`/v1/orders/${o.id}`)).body.status).toBe("PAID");
        const w = await wallet(st);
        expect(w.cashKobo).toBe(o.totalKobo);
        expect(w.entries[0]).toMatchObject({ kind: "UNMATCHED_PAYMENT" });
    });

    it("promo credit is spent before cash", async () => {
        const st = await registerStudent(h, uni, "w-order");
        await topUp(st, 100_000);
        expect((await grant(3_000, st.email)).status).toBe(201);
        const o = await order(st);
        await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        const w = await wallet(st);
        expect(w).toMatchObject({ promoKobo: 0, cashKobo: 100_000 - (o.totalKobo - 3_000) });
    });

    it("without useWallet the balance is left alone", async () => {
        const st = await registerStudent(h, uni, "w-nowallet");
        await topUp(st, 100_000);
        const o = await order(st);
        const pay = await st.client.post(`/v1/orders/${o.id}/payments`, {});
        expect(pay.body).toMatchObject({ paidFromWallet: false, walletKobo: 0, amountKobo: o.totalKobo });
        expect((await wallet(st)).totalKobo).toBe(100_000);
    });

    it("concurrent spends can never take the balance below zero", async () => {
        const st = await registerStudent(h, uni, "w-race");
        const a = await order(st);
        const b = await order(st);
        // Enough for one order, not both.
        const funds = Math.max(10_000, Math.ceil((Math.max(a.totalKobo, b.totalKobo) + 100) / 100) * 100);
        expect(funds).toBeLessThan(a.totalKobo + b.totalKobo);
        await topUp(st, funds);
        const results = await Promise.all([
            st.client.post(`/v1/orders/${a.id}/payments`, { useWallet: true }),
            st.client.post(`/v1/orders/${b.id}/payments`, { useWallet: true }),
        ]);
        const w = await wallet(st);
        expect(w.totalKobo).toBeGreaterThanOrEqual(0);
        const fromWallet = results.reduce((s, r) => s + (r.body.walletKobo ?? 0), 0);
        expect(fromWallet).toBe(funds - w.totalKobo);
    });

    it("sends a low-balance text when a payment takes the balance under the threshold", async () => {
        const st = await registerStudent(h, uni, "w-low");
        await h.pool.query(`UPDATE users SET phone = '+2348034445566', phone_verified_at = now() WHERE id = $1`, [st.userId]);
        const o = await order(st);
        const funds = Math.ceil(o.totalKobo / 100) * 100 + 45_000; // before >= ₦500 (the threshold), after < ₦500
        await topUp(st, funds);
        await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        await h.drain();
        expect(h.sms.sent.some((m) => m.to === "+2348034445566" && /Your PrintFlow wallet has ₦[\d,.]+ left/.test(m.text))).toBe(true);
    });
});

describe("wallet: refunds", () => {
    it("cancelling a wallet-paid order gives the money back to the wallet at once", async () => {
        const st = await registerStudent(h, uni, "w-cancel");
        await topUp(st, 100_000);
        const o = await order(st);
        await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        const c = await st.client.post(`/v1/orders/${o.id}/cancel`, { reason: "Printed elsewhere", refundTo: "PROVIDER" });
        // Wallet money always returns to the wallet, whatever the card choice.
        expect(c.body.status).toBe("REFUNDED");
        expect((await wallet(st)).cashKobo).toBe(100_000);
    });

    it("split-paid order refunded: wallet part to the wallet, card part to where the student chose", async () => {
        const st = await registerStudent(h, uni, "w-splitrefund");
        await topUp(st, 10_000);
        const o = await order(st, 3);
        const pay = await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        await st.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
        const c = await st.client.post(`/v1/orders/${o.id}/cancel`, { reason: "Changed my mind", refundTo: "PROVIDER" });
        expect(c.body.status).toBe("REFUND_PENDING");
        expect((await wallet(st)).cashKobo).toBe(10_000);
        await h.drain();
        const d = await st.client.get(`/v1/orders/${o.id}`);
        expect(d.body.status).toBe("REFUNDED");
        expect(d.body.refunds).toEqual([expect.objectContaining({ amountKobo: String(o.totalKobo - 10_000), destination: "PROVIDER", status: "SUCCEEDED" })]);
    });

    it("card money refunded to the wallet is usable immediately", async () => {
        const st = await registerStudent(h, uni, "w-cardtowallet");
        const o = await order(st);
        const pay = await st.client.post(`/v1/orders/${o.id}/payments`, {});
        await st.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
        const c = await st.client.post(`/v1/orders/${o.id}/cancel`, { reason: "Wrong file" });
        expect(c.body.status).toBe("REFUNDED");
        const w = await wallet(st);
        expect(w.cashKobo).toBe(o.totalKobo);
        expect(w.entries[0]).toMatchObject({ kind: "CARD_REFUND", label: "Refund", amountKobo: o.totalKobo });
        // ...and pays for the next order.
        const next = await order(st);
        expect((await st.client.post(`/v1/orders/${next.id}/payments`, { useWallet: true })).body.paidFromWallet).toBe(true);
    });

    it("an unpaid order that expires releases the wallet part it was holding", async () => {
        const st = await registerStudent(h, uni, "w-expire");
        await topUp(st, 10_000);
        const o = await order(st, 3);
        await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        expect((await wallet(st)).totalKobo).toBe(0);
        await h.pool.query(`ALTER TABLE orders DISABLE TRIGGER orders_update_guard`);
        await h.pool.query(`UPDATE orders SET payment_due_at = now() - interval '1 minute' WHERE id = $1`, [o.id]);
        await h.pool.query(`ALTER TABLE orders ENABLE TRIGGER orders_update_guard`);
        await h.pool.query(`UPDATE jobs SET run_after = now() WHERE dedupe_key = $1`, [`expire:${o.id}`]);
        await h.drain();
        expect((await st.client.get(`/v1/orders/${o.id}`)).body.status).toBe("EXPIRED");
        expect((await wallet(st)).cashKobo).toBe(10_000);
    });

    it("a partial dispute refund returns the student's own money first, never more than was paid", async () => {
        const st = await registerStudent(h, uni, "w-dispute");
        await topUp(st, 10_000);
        await grant(2_000, st.email);
        const o = await order(st, 3);
        const pay = await st.client.post(`/v1/orders/${o.id}/payments`, { useWallet: true });
        await st.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
        const d = await st.client.post(`/v1/orders/${o.id}/disputes`, { category: "QUALITY", description: "Page 2 smudged and unreadable" });
        const r = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/disputes/${d.body.id}/resolve`, { status: "RESOLVED_REFUND", note: "Page 2 reprint not possible", refundKobo: 12_000 });
        expect(r.status).toBe(200);
        // 10,000 wallet cash first, then 2,000 of the card part (to the wallet by default); promo untouched.
        const w = await wallet(st);
        expect(w).toMatchObject({ cashKobo: 12_000, promoKobo: 0 });
        // A full refund now returns exactly the rest, including the promo part as promo.
        await uni.admin.post(`/v1/admin/universities/${uni.universityId}/orders/${o.id}/refund`, { reason: "Shop closed" });
        const after = await wallet(st);
        expect(after).toMatchObject({ cashKobo: o.totalKobo - 2_000, promoKobo: 2_000 });
        expect((await st.client.get(`/v1/orders/${o.id}`)).body.status).toBe("REFUNDED");
    });
});

describe("wallet: print credit", () => {
    it("university finance can grant and take back unspent credit; it shows on the student's wallet", async () => {
        const st = await registerStudent(h, uni, "w-promo");
        const g = await grant(5_000, st.email, "Library week");
        expect(g.body).toMatchObject({ amountKobo: 5_000, studentCreditKobo: 5_000 });
        expect((await wallet(st)).entries[0]).toMatchObject({ kind: "PROMO_GRANT", label: "Print credit", note: "Library week" });
        const tooMuch = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/wallet/credit/revoke`, { email: st.email, amountKobo: 9_000, note: "Mistake" }, { "Idempotency-Key": `rv-${Date.now()}-xxxxxxxxxx` });
        expect(tooMuch.body.error.code).toBe("PROMO_ALREADY_SPENT");
        const rv = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/wallet/credit/revoke`, { email: st.email, amountKobo: 5_000, note: "Granted to the wrong student" }, { "Idempotency-Key": `rv-${Date.now()}-yyyyyyyyyy` });
        expect(rv.body.studentCreditKobo).toBe(0);
        const list = await uni.admin.get(`/v1/admin/universities/${uni.universityId}/wallet/credit`);
        expect(list.body.items.slice(0, 2).map((i: { kind: string }) => i.kind)).toEqual(["PROMO_REVOKE", "PROMO_GRANT"]);
        const audit = await h.pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'wallet.credit%' ORDER BY id`, [st.userId]);
        expect(audit.rows.map((r) => r.action)).toEqual(["wallet.credit_granted", "wallet.credit_revoked"]);
    });

    it("a replayed grant (same Idempotency-Key) is applied once", async () => {
        const st = await registerStudent(h, uni, "w-promo-idem");
        const key = `grant-idem-${Date.now()}-abc`;
        const body = { email: st.email, amountKobo: 1_000, note: "Raffle winner" };
        await uni.admin.post(`/v1/admin/universities/${uni.universityId}/wallet/credit`, body, { "Idempotency-Key": key });
        await uni.admin.post(`/v1/admin/universities/${uni.universityId}/wallet/credit`, body, { "Idempotency-Key": key });
        expect((await wallet(st)).promoKobo).toBe(1_000);
    });

    it("credit cannot be given to students of another university, by shops, or above the limit", async () => {
        const st = await registerStudent(h, other, "w-foreign");
        expect((await grant(1_000, st.email)).status).toBe(404);
        expect((await shop.owner.post(`/v1/admin/universities/${uni.universityId}/wallet/credit`, { email: st.email, amountKobo: 1_000, note: "x".repeat(5) }, { "Idempotency-Key": `x-${Date.now()}-zzzzzzzz` })).status).toBe(403);
        const mine = await registerStudent(h, uni, "w-cap");
        expect((await grant(h.cfg.PROMO_GRANT_MAX_KOBO + 100, mine.email)).body.error.code).toBe("GRANT_TOO_LARGE");
    });

    it("welcome credit is given once, when the student confirms a phone number", async () => {
        await uni.admin.patch(`/v1/admin/universities/${uni.universityId}/settings`, { welcomeCreditKobo: 20_000 });
        const st = await registerStudent(h, uni, "w-welcome");
        expect((await wallet(st)).promoKobo).toBe(0);
        await st.client.post("/v1/me/phone", { phone: "08037778899" });
        const code = /\b(\d{6})\b/.exec(h.sms.sent.filter((m) => m.to === "+2348037778899").at(-1)!.text)![1];
        const v = await st.client.post("/v1/me/phone/verify", { code });
        expect(v.body.welcomeCreditKobo).toBe(20_000);
        expect((await wallet(st)).promoKobo).toBe(20_000);
        // Changing and re-confirming the number does not grant it again.
        await st.client.post("/v1/me/phone", { phone: "08037778800" });
        const code2 = /\b(\d{6})\b/.exec(h.sms.sent.filter((m) => m.to === "+2348037778800").at(-1)!.text)![1];
        expect((await st.client.post("/v1/me/phone/verify", { code: code2 })).body.welcomeCreditKobo).toBe(0);
        expect((await wallet(st)).promoKobo).toBe(20_000);
        await uni.admin.patch(`/v1/admin/universities/${uni.universityId}/settings`, { welcomeCreditKobo: 0 });
    });

    it("the university overview reports wallet money held for students", async () => {
        const ov = await uni.admin.get(`/v1/admin/universities/${uni.universityId}/overview`);
        expect(ov.body.wallet.studentCashKobo).toBeGreaterThan(0);
        expect(ov.body.wallet.topUpsLast30DaysKobo).toBeGreaterThan(0);
    });
});
