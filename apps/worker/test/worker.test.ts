import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClamdScanner } from "../../../packages/documents/src/index.js";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { objectKeys } from "../../../packages/storage/src/index.js";
import { Client, createUser, onboardUniversity, openShop, publishCampusCard, registerStudent, startHarness, type Campus, type Harness, type ShopSetup } from "../../api/test/harness.js";
import { purgeRetention } from "../src/handlers.js";
import { drainOnce, schedulePeriodic } from "../src/runner.js";

let h: Harness;
let campus: Campus;
let shop: ShopSetup;
let pdf: Buffer;

beforeAll(async () => {
  h = await startHarness({}, "printflow_worker_test");
  const p = await createUser(h, "wplatform", { platformRole: "PLATFORM_ADMIN" });
  campus = await onboardUniversity(h, await Client.login(h, p.email), "worker-uni");
  await publishCampusCard(campus);
  shop = await openShop(h, campus, "Worker Prints");
  const dir = mkdtempSync(join(tmpdir(), "pf-w-"));
  await makePdf(join(dir, "a.pdf"), 2);
  pdf = readFileSync(join(dir, "a.pdf"));
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe("document processing resilience", () => {
  it("never marks a document clean when the scanner is down; gives up as FAILED after retries", async () => {
    const st = await registerStudent(h, campus, "scannerdown");
    const up = await st.client.upload("/v1/documents", pdf, "a.pdf");
    const real = h.worker.scanner;
    h.worker.scanner = new ClamdScanner("127.0.0.1", 1, 500);
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await h.pool.query(`UPDATE jobs SET run_after = now() WHERE dedupe_key = $1`, [`doc:${up.body.versionId}`]);
        await drainOnce(h.worker, "w1", 10);
        const v = await h.pool.query<{ processing_status: string; scan_status: string }>(`SELECT processing_status, scan_status FROM document_versions WHERE id = $1`, [up.body.versionId]);
        expect(v.rows[0]!.scan_status).toBe("PENDING");
        expect(v.rows[0]!.processing_status).toBe(attempt < 3 ? "PROCESSING" : "FAILED");
      }
      const job = await h.pool.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE dedupe_key = $1`, [`doc:${up.body.versionId}`]);
      expect(job.rows[0]).toEqual({ status: "DEAD", attempts: 3 });
    } finally {
      h.worker.scanner = real;
    }
  });
});

describe("retention", () => {
  it("purges files only after every order using them has finished and the retention period has passed", async () => {
    const st = await registerStudent(h, campus, "retention");
    const up = await st.client.upload("/v1/documents", pdf, "a.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shop.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": "retention-key-0000001" });
    const pay = await st.client.post(`/v1/orders/${o.body.id}/payments`);
    await st.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });

    // Deleting the document while the order is active must not remove its files.
    await st.client.delete(`/v1/documents/${up.body.assetId}`);
    await purgeRetention(h.worker, null);
    const printKey = objectKeys.print(up.body.assetId, up.body.versionId);
    expect(await h.storage.exists(printKey)).toBe(true);

    // Finish the order, then age it past the retention period.
    const t = (to: string) => shop.owner.post(`/v1/shops/${shop.shopId}/orders/${o.body.id}/transitions`, { to });
    await t("ACCEPTED");
    await t("PRINTING");
    await t("QUALITY_CHECK");
    await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${o.body.id}/quality-checks`, { result: "PASS" });
    const code = await st.client.post(`/v1/orders/${o.body.id}/pickup-code`);
    await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${o.body.id}/collect`, { code: code.body.code });
    await purgeRetention(h.worker, null);
    expect(await h.storage.exists(printKey)).toBe(true); // still inside the retention window

    await h.pool.query(`ALTER TABLE orders DISABLE TRIGGER orders_update_guard`);
    await h.pool.query(`UPDATE orders SET status_changed_at = now() - interval '400 days' WHERE id = $1`, [o.body.id]);
    await h.pool.query(`ALTER TABLE orders ENABLE TRIGGER orders_update_guard`);
    expect(await purgeRetention(h.worker, null)).toBeGreaterThanOrEqual(1);
    expect(await h.storage.exists(printKey)).toBe(false);
    expect(await h.storage.exists(objectKeys.original(up.body.assetId, up.body.versionId))).toBe(false);
    const v = await h.pool.query<{ files_purged_at: Date | null }>(`SELECT files_purged_at FROM document_versions WHERE id = $1`, [up.body.versionId]);
    expect(v.rows[0]!.files_purged_at).not.toBeNull();
  });

  it("periodic scheduling is deduplicated across workers", async () => {
    const now = new Date();
    await Promise.all([schedulePeriodic(h.worker, now), schedulePeriodic(h.worker, now), schedulePeriodic(h.worker, now)]);
    const { rows } = await h.pool.query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE kind = 'RECONCILE_PAYMENTS' AND created_at > now() - interval '1 minute'`);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
