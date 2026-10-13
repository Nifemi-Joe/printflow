import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { Client, createUser, onboardUniversity, openShop, publishCampusCard, registerStudent, startHarness, type Campus, type Harness, type ShopSetup } from "./harness.js";

let h: Harness;
let campus: Campus;
let shop: ShopSetup;

beforeAll(async () => {
  h = await startHarness();
  const platformUser = await createUser(h, "platform", { platformRole: "PLATFORM_ADMIN" });
  const platform = await Client.login(h, platformUser.email);
  campus = await onboardUniversity(h, platform, "unilag");
  await publishCampusCard(campus);
  shop = await openShop(h, campus, "Faculty Print Hub");
}, 120_000);

afterAll(async () => {
  await h.close();
});

/** Follows a signed /v1/files link through the API and returns the body. */
async function fetchSigned(url: string): Promise<request.Response> {
  return request(h.app.getHttpServer())
    .get(new URL(url).pathname)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

describe("complete student → shop journey over HTTP", () => {
  it("upload → preview → quote → order → test payment → queue → accept → print → QA → notify → pickup code → collection", async () => {
    // --- student registers and uploads a 3-page PDF
    const { client: student, userId } = await registerStudent(h, campus, "ada");
    const dir = mkdtempSync(join(tmpdir(), "pf-journey-"));
    await makePdf(join(dir, "notes.pdf"), 3);
    const up = await student.upload("/v1/documents", readFileSync(join(dir, "notes.pdf")), "CSC 201 notes.pdf");
    expect(up.status).toBe(202);
    expect(up.body.status).toBe("PENDING");

    // --- worker scans (fake clamd over the real protocol), normalises, counts pages, renders previews
    await h.drain();
    const doc = await student.get(`/v1/documents/${up.body.assetId}`);
    expect(doc.body.versions[0]).toMatchObject({ status: "READY", scanStatus: "CLEAN", pageCount: 3, pageSize: "A4", previewPages: 3 });
    expect(doc.body.versions[0].scanEngine).toContain("ClamAV");

    // --- preview through a short-lived signed link
    const prev = await student.get(`/v1/documents/versions/${up.body.versionId}/previews/1`);
    expect(prev.status).toBe(200);
    const png = await fetchSigned(prev.body.url);
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect((png.body as Buffer).subarray(1, 4).toString()).toBe("PNG");

    // --- public price list is the one the engine uses
    const prices = await request(h.app.getHttpServer()).get(`/v1/shops/${shop.shopId}/price-list`);
    expect(prices.body.configured).toBe(true);

    // --- exact server-side quote: 3 pages x 2 copies A4 B&W single + stapling
    const quote = await student.post("/v1/quotes", {
      documentVersionId: up.body.versionId,
      shopId: shop.shopId,
      spec: { copies: 2, paperSize: "A4", colourMode: "BW", sides: "SINGLE", finishingCodes: ["STAPLE"] },
    });
    expect(quote.status).toBe(201);
    const subtotal = 6 * 2_000 + 2 * 1_000; // 14,000 kobo
    const fee = 5_000 + Math.floor((subtotal * 150 + 5_000) / 10_000); // fixed + 1.5%, round half up
    expect(quote.body).toMatchObject({ subtotalKobo: subtotal, serviceFeeKobo: fee, totalKobo: subtotal + fee, totalSheets: 6, checkout: "TEST" });

    // --- confirm order (idempotent)
    const key = "order-key-journey-0001";
    const order = await student.post("/v1/orders", { quoteId: quote.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": key });
    expect(order.status).toBe(201);
    const retry = await student.post("/v1/orders", { quoteId: quote.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": key });
    expect(retry.body.id).toBe(order.body.id);
    const orderId: string = order.body.id;

    // --- test payment through the signed webhook path
    const pay = await student.post(`/v1/orders/${orderId}/payments`);
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ mode: "TEST", amountKobo: subtotal + fee });
    const done = await student.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
    expect(done.body.outcome).toBe("PAID");

    let detail = await student.get(`/v1/orders/${orderId}`);
    expect(detail.body.status).toBe("PAID");
    expect(detail.body.queue.position).toBe(1);

    // --- shop sees it in the queue and accepts
    const queue = await shop.owner.get(`/v1/shops/${shop.shopId}/queue`);
    expect(queue.body.items.map((i: { id: string }) => i.id)).toContain(orderId);
    const job = queue.body.items.find((i: { id: string }) => i.id === orderId);
    expect(job.actions.sort()).toEqual(["ACCEPTED", "REJECTED"]);

    const blocked = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/document-link`);
    expect(blocked.status).toBe(422);

    const acc = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/transitions`, { to: "ACCEPTED", expectedVersion: job.version });
    expect(acc.body.status).toBe("ACCEPTED");

    // --- secure download of the assigned file: bytes match the hash bound to the order
    const link = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/document-link`);
    expect(link.status).toBe(201);
    const pdf = await fetchSigned(link.body.url);
    expect(pdf.headers["content-disposition"]).toContain("attachment");
    const shopOrder = await shop.owner.get(`/v1/shops/${shop.shopId}/orders/${orderId}`);
    expect(createHash("sha256").update(pdf.body as Buffer).digest("hex")).toBe(shopOrder.body.printSha256);

    // --- production and QA
    await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/transitions`, { to: "PRINTING", deviceId: shop.deviceId });
    await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/transitions`, { to: "QUALITY_CHECK" });
    const qa = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/quality-checks`, { result: "PASS", sheetsCounted: 6 });
    expect(qa.body.status).toBe("READY_FOR_PICKUP");

    // --- student is notified (in-app + email via the NOTIFY job)
    await h.drain();
    const notes = await student.get("/v1/notifications");
    expect(notes.body.items.map((n: { kind: string }) => n.kind)).toContain("order.ready_for_pickup");
    const studentEmail = (await h.pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0]!.email;
    expect(h.mailer.sent.some((m) => m.to === studentEmail && m.subject.includes("Ready for pickup"))).toBe(true);

    // --- pickup code; wrong code refused; right code collects; second attempt refused
    const code = await student.post(`/v1/orders/${orderId}/pickup-code`);
    expect(code.body.code).toMatch(/^\d{6}$/);
    const wrong = code.body.code === "000000" ? "111111" : "000000";
    const bad = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/collect`, { code: wrong });
    expect(bad.body.error.code).toBe("PICKUP_WRONG_CODE");
    const ok = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/collect`, { code: code.body.code });
    expect(ok.body).toEqual({ collected: true });
    const again = await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${orderId}/collect`, { code: code.body.code });
    expect(again.body.error.code).toBe("PICKUP_ALREADY_COLLECTED");

    detail = await student.get(`/v1/orders/${orderId}`);
    expect(detail.body.status).toBe("COLLECTED");
    expect(detail.body.events.map((e: { to: string }) => e.to)).toEqual(["AWAITING_PAYMENT", "PAID", "ACCEPTED", "PRINTING", "QUALITY_CHECK", "READY_FOR_PICKUP", "COLLECTED"]);

    const receipt = await student.get(`/v1/orders/${orderId}/receipt`);
    expect(receipt.body).toMatchObject({ orderReference: detail.body.reference, totalKobo: subtotal + fee, testMode: true });

    // --- the shop's report reflects it
    const report = await shop.owner.get(`/v1/shops/${shop.shopId}/reports/summary`);
    expect(report.body.collectedRevenueKobo).toBe(subtotal);
  }, 180_000);
});
