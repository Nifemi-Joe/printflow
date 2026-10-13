import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { Client, createUser, onboardUniversity, openShop, publishCampusCard, registerStudent, startHarness, totpNow, type Campus, type Harness, type ShopSetup } from "./harness.js";

let h: Harness;
let out: string[] = [];

beforeAll(async () => {
  h = await startHarness({ DEV_CONSOLE: "true", REQUIRE_STAFF_MFA: "true" }, "printflow_devconsole_test");
}, 120_000);
afterAll(async () => {
  await h.close();
});

function capture() {
  out = [];
  return vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
}

describe("development console: authenticator codes", () => {
  it("prints a working authenticator code at setup, at sign-in and after a wrong code", async () => {
    const p = await createUser(h, "dev-platform", { platformRole: "PLATFORM_ADMIN" });
    const platform = await Client.login(h, p.email);
    const spy = capture();
    const setup = await platform.post("/v1/auth/mfa/totp/setup");
    spy.mockRestore();
    const printed = out.join("");
    expect(printed).toContain("authenticator code (setup");
    expect(printed).toContain(setup.body.secret);
    const code = /Code\s+(\d{6})/.exec(printed)![1]!;
    expect([totpNow(setup.body.secret, -1), totpNow(setup.body.secret), totpNow(setup.body.secret, 1)]).toContain(code);
    expect((await platform.post("/v1/auth/mfa/totp/confirm", { code })).status).toBe(200);

    // Signing in again as staff prints the current code for the second step.
    const spy2 = capture();
    const again = await Client.login(h, p.email);
    spy2.mockRestore();
    expect(out.join("")).toContain("authenticator code (sign-in)");
    // A wrong code prints the right one.
    const spy3 = capture();
    const wrong = await again.post("/v1/auth/mfa/verify", { code: "000000" === totpNow(setup.body.secret) ? "111111" : "000000" });
    spy3.mockRestore();
    expect(wrong.body.error.code).toBe("MFA_INVALID");
    expect(out.join("")).toContain("that code was wrong; use this one");
  });
});

describe("development console: checkout", () => {
  let h2: Harness;
  let uni: Campus;
  let shop: ShopSetup;
  let pdf: Buffer;

  beforeAll(async () => {
    h2 = await startHarness({ DEV_CONSOLE: "true" }, "printflow_devconsole_pay_test");
    const p = await createUser(h2, "devpay-platform", { platformRole: "PLATFORM_ADMIN" });
    uni = await onboardUniversity(h2, await Client.login(h2, p.email), "devpay-uni");
    await publishCampusCard(uni);
    shop = await openShop(h2, uni, "Dev Console Shop");
    const dir = mkdtempSync(join(tmpdir(), "pf-dev-"));
    await makePdf(join(dir, "a.pdf"), 1);
    pdf = readFileSync(join(dir, "a.pdf"));
  }, 120_000);
  afterAll(async () => {
    await h2.close();
  });

  it("prints the checkout link with the method and amount", async () => {
    const st = await registerStudent(h2, uni, "devpay-student");
    const up = await st.client.upload("/v1/documents", pdf, "doc.pdf");
    await h2.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shop.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": `devpay-${Date.now()}-xxxx` });
    const spy = capture();
    const pay = await st.client.post(`/v1/orders/${o.body.id}/payments`, { method: "USSD" });
    spy.mockRestore();
    expect(pay.status).toBeLessThan(300);
    const printed = out.join("");
    expect(printed).toContain("checkout link");
    expect(printed).toContain(pay.body.reference);
    expect(printed).toContain(pay.body.checkoutUrl);
    expect(printed).toMatch(/Method\s+USSD/);
  });
});
