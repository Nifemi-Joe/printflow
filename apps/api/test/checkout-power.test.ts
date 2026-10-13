import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { Client, createUser, onboardUniversity, openShop, publishCampusCard, registerStudent, startHarness, type Campus, type Harness, type ShopSetup } from "./harness.js";

let h: Harness;
let uni: Campus;
let shop: ShopSetup;
let pdfBytes: Buffer;

beforeAll(async () => {
  h = await startHarness({}, "printflow_checkout_test");
  const p = await createUser(h, "co-platform", { platformRole: "PLATFORM_ADMIN" });
  uni = await onboardUniversity(h, await Client.login(h, p.email), "co-uni");
  await publishCampusCard(uni);
  shop = await openShop(h, uni, "Checkout Test Shop");
  const dir = mkdtempSync(join(tmpdir(), "pf-co-"));
  await makePdf(join(dir, "a.pdf"), 2);
  pdfBytes = readFileSync(join(dir, "a.pdf"));
}, 120_000);

afterAll(async () => {
  await h.close();
});

async function unpaidOrder(label: string) {
  const st = await registerStudent(h, uni, label);
  const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
  await h.drain();
  const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shop.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
  const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": `co-${label}-${Date.now()}-xxx` });
  return { ...st, quote: q.body, orderId: o.body.id as string };
}

describe("payment methods: card, bank transfer, USSD", () => {
  it("quotes list the methods on offer", async () => {
    const a = await unpaidOrder("methods-quote");
    expect(a.quote.paymentMethods).toEqual(["CARD", "BANK_TRANSFER", "USSD"]);
  });

  it("a student pays by bank transfer: the choice is recorded, and so is what was actually used", async () => {
    const a = await unpaidOrder("transfer");
    const pay = await a.client.post(`/v1/orders/${a.orderId}/payments`, { method: "BANK_TRANSFER" });
    expect(pay.status).toBe(201);
    expect(pay.body.methods).toEqual(["BANK_TRANSFER"]);
    expect(pay.body.checkoutUrl).toMatch(/\?method=BANK_TRANSFER$/);
    const page = await a.client.get(`/v1/test-payments/${pay.body.reference}`);
    expect(page.body).toMatchObject({ requestedMethod: "BANK_TRANSFER", simulated: { bankTransfer: { accountNumber: "0000000000" } } });
    await a.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
    const d = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(d.body.status).toBe("PAID");
    expect(d.body.payments.at(-1)).toMatchObject({ requestedMethod: "BANK_TRANSFER", paidWith: "BANK_TRANSFER", status: "SUCCEEDED" });
    const r = await a.client.get(`/v1/orders/${a.orderId}/receipt`);
    expect(r.body).toMatchObject({ paidWith: "BANK_TRANSFER", paidWithLabel: "Bank transfer" });
  });

  it("USSD works the same way; with no choice every method is offered", async () => {
    const a = await unpaidOrder("ussd");
    const any = await a.client.post(`/v1/orders/${a.orderId}/payments`, {});
    expect(any.body.methods).toEqual(["CARD", "BANK_TRANSFER", "USSD"]);
    expect(any.body.checkoutUrl).not.toContain("?method=");
    const pay = await a.client.post(`/v1/orders/${a.orderId}/payments`, { method: "USSD" });
    await a.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success", method: "USSD" });
    const d = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(d.body.payments.find((p: { status: string }) => p.status === "SUCCEEDED")).toMatchObject({ paidWith: "USSD" });
    // Starting a second checkout abandoned the first; only one payment succeeded.
    expect(d.body.payments.filter((p: { status: string }) => p.status === "ABANDONED")).toHaveLength(1);
  });

  it("refuses unknown methods and methods switched off by the operator", async () => {
    const a = await unpaidOrder("badmethod");
    expect((await a.client.post(`/v1/orders/${a.orderId}/payments`, { method: "CASH" })).status).toBe(400);
    const cardOnly = await startHarness({ PAYMENT_METHODS: "CARD" }, "printflow_cardonly_test");
    try {
      const p = await createUser(cardOnly, "card-platform", { platformRole: "PLATFORM_ADMIN" });
      const u = await onboardUniversity(cardOnly, await Client.login(cardOnly, p.email), "card-uni");
      await publishCampusCard(u);
      const s = await openShop(cardOnly, u, "Card Shop");
      const st = await registerStudent(cardOnly, u, "cardonly");
      const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
      for (let i = 0; i < 5 && (await cardOnly.drain()) > 0; i++);
      const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: s.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
      expect(q.body.paymentMethods).toEqual(["CARD"]);
      const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: s.pickupLocationId }, { "Idempotency-Key": `cardonly-${Date.now()}-xxxx` });
      const r = await st.client.post(`/v1/orders/${o.body.id}/payments`, { method: "USSD" });
      expect(r.body.error.code).toBe("METHOD_UNAVAILABLE");
    } finally {
      await cardOnly.close();
    }
  }, 60_000);

  it("a channel claim in an unsigned webhook changes nothing", async () => {
    const a = await unpaidOrder("forgedchannel");
    const pay = await a.client.post(`/v1/orders/${a.orderId}/payments`, { method: "CARD" });
    const raw = JSON.stringify({ id: "test_evt_forged_channel_1", event: "charge.success", reference: pay.body.reference, amount: a.quote.totalKobo, currency: "NGN", channel: "ussd" });
    const r = await request(h.app.getHttpServer()).post("/v1/webhooks/test").set("content-type", "application/json").set("x-test-signature", "0".repeat(128)).send(raw);
    expect(r.status).toBe(403);
    expect((await a.client.get(`/v1/orders/${a.orderId}`)).body.status).toBe("AWAITING_PAYMENT");
  });
});

describe("shop power status", () => {
  it("staff report light on, generator or light out with a return time; students see it", async () => {
    const r1 = await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "GENERATOR", note: "Diesel till 6pm" });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: "GENERATOR", label: "Generator on", canPrint: true, note: "Diesel till 6pm", stale: false });

    const backAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    const r2 = await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "OUTAGE", backAt });
    expect(r2.body).toMatchObject({ status: "OUTAGE", label: "Light out", canPrint: false, backAt, overdue: false, note: null });
    expect(r2.body.updatedBy).toMatch(/Person/);

    const cat = await request(h.app.getHttpServer()).get(`/v1/universities/${uni.universityId}/shops`);
    expect(cat.body.items.find((s: { id: string }) => s.id === shop.shopId).power).toMatchObject({ status: "OUTAGE", backAt });
    const queue = await shop.owner.get(`/v1/shops/${shop.shopId}/queue`);
    expect(queue.body.power.status).toBe("OUTAGE");

    const r3 = await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "GRID" });
    expect(r3.body).toMatchObject({ status: "GRID", label: "Light on", backAt: null });
    const audit = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'shop.power_reported' AND shop_id = $1 ORDER BY id`, [shop.shopId]);
    expect(audit.rows.map((r) => r.details.status)).toEqual(["GENERATOR", "OUTAGE", "GRID"]);
  });

  it("validates return times and who may report", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect((await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "OUTAGE", backAt: past })).body.error.code).toBe("INVALID_BACK_AT");
    const far = new Date(Date.now() + 72 * 3600_000).toISOString();
    expect((await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "OUTAGE", backAt: far })).body.error.code).toBe("INVALID_BACK_AT");
    const soon = new Date(Date.now() + 3600_000).toISOString();
    expect((await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "GRID", backAt: soon })).status).toBe(400);
    expect((await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "SOLAR" })).status).toBe(400);
    expect((await shop.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "GRID", note: "x".repeat(141) })).status).toBe(400);

    const student = await registerStudent(h, uni, "power-student");
    expect((await student.client.put(`/v1/shops/${shop.shopId}/power`, { status: "OUTAGE" })).status).toBe(403);
    const other = await openShop(h, uni, "Other Power Shop");
    expect((await other.owner.put(`/v1/shops/${shop.shopId}/power`, { status: "OUTAGE" })).status).toBe(403);
  });
});
