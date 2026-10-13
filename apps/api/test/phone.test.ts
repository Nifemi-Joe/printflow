import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { Client, createUser, onboardUniversity, openShop, PASSWORD, publishCampusCard, registerStudent, startHarness, uniqueEmail, type Campus, type Harness, type ShopSetup } from "./harness.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let h: Harness;
let uni: Campus;
let shop: ShopSetup;
let pdfBytes: Buffer;

let seq = 0;
/** A fresh Nigerian mobile number in local format, e.g. 0803 123 4567. */
function newNumber(): { local: string; e164: string } {
  const n = `${(Math.floor(Date.now() / 7) % 1e5).toString().padStart(5, "0")}${(seq++ % 100).toString().padStart(2, "0")}`;
  return { local: `0803${n}`, e164: `+234803${n}` };
}

beforeAll(async () => {
  h = await startHarness({}, "printflow_phone_test");
  const p = await createUser(h, "phone-platform", { platformRole: "PLATFORM_ADMIN" });
  const platform = await Client.login(h, p.email);
  uni = await onboardUniversity(h, platform, "phone-uni");
  await publishCampusCard(uni);
  shop = await openShop(h, uni, "Phone Test Shop");
  const dir = mkdtempSync(join(tmpdir(), "pf-phone-"));
  await makePdf(join(dir, "a.pdf"), 2);
  pdfBytes = readFileSync(join(dir, "a.pdf"));
}, 120_000);

afterAll(async () => {
  await h.close();
});

/** Registers without verifying anything. */
async function register(phone?: string) {
  const email = uniqueEmail("phone");
  const agent = request.agent(h.app.getHttpServer());
  const res = await agent
    .post("/v1/auth/register")
    .send({ email, password: PASSWORD, fullName: "Phone Student", universityId: uni.universityId, campusId: uni.campusId, ...(phone ? { phone } : {}) });
  const client = new Client(h, agent);
  client.csrf = res.body.csrfToken;
  return { res, client, email };
}

describe("phone numbers at registration", () => {
  it("accepts local formats, stores E.164 and texts a verification code", async () => {
    const n = newNumber();
    const { res } = await register(n.local);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ phone: n.e164, phoneVerified: false });
    expect(res.body.phoneCode).toMatchObject({ sentTo: expect.stringContaining("•••"), expiresInSeconds: 600 });
    expect(h.sms.lastCode(n.e164)).toMatch(/^\d{6}$/);
    const row = await h.pool.query(`SELECT code_hash FROM phone_otps WHERE phone = $1`, [n.e164]);
    expect(row.rows[0].code_hash).not.toContain(h.sms.lastCode(n.e164));
  });

  it("rejects invalid numbers and numbers already in use", async () => {
    const bad = await register("0601234567");
    expect(bad.res.status).toBe(400);
    const n = newNumber();
    await register(n.local);
    const dup = await register(`+234 ${n.e164.slice(4, 7)} ${n.e164.slice(7)}`);
    expect(dup.res.body.error.code).toBe("PHONE_TAKEN");
  });
});

describe("verifying a phone", () => {
  it("a verified phone alone is enough to place orders", async () => {
    const n = newNumber();
    const { client } = await register(n.local);
    const up = await client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const quote = () => client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shop.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const blocked = await client.post("/v1/orders", { quoteId: (await quote()).body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": `phone-blocked-${Date.now()}` });
    expect(blocked.body.error.code).toBe("CONTACT_NOT_VERIFIED");

    const v = await client.post("/v1/me/phone/verify", { code: h.sms.lastCode(n.e164) });
    expect(v.body).toMatchObject({ verified: true, phone: n.e164 });
    expect((await client.get("/v1/auth/me")).body.user).toMatchObject({ phoneVerified: true, emailVerified: false });
    const ok = await client.post("/v1/orders", { quoteId: (await quote()).body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": `phone-ok-${Date.now()}-x` });
    expect(ok.status).toBe(201);
  });

  it("five wrong codes burn the code; a new code works; codes are single-use", async () => {
    const n = newNumber();
    const { client } = await register(n.local);
    const right = h.sms.lastCode(n.e164)!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await client.post("/v1/me/phone/verify", { code: wrong })).body.error.code).toBe("CODE_INVALID");
    expect((await client.post("/v1/me/phone/verify", { code: wrong })).body.error.code).toBe("CODE_LOCKED");
    expect((await client.post("/v1/me/phone/verify", { code: right })).body.error.code).toBe("CODE_LOCKED");

    const again = await client.post("/v1/me/phone", { phone: n.local });
    expect(again.status).toBe(202);
    const fresh = h.sms.lastCode(n.e164)!;
    expect((await client.post("/v1/me/phone/verify", { code: fresh })).status).toBe(200);
    expect((await client.post("/v1/me/phone/verify", { code: fresh })).body.error.code).toBe("CODE_EXPIRED");
  });

  it("expired codes are refused", async () => {
    const n = newNumber();
    const { client } = await register(n.local);
    const code = h.sms.lastCode(n.e164)!;
    await h.pool.query(`ALTER TABLE phone_otps DISABLE TRIGGER phone_otps_guard`);
    await h.pool.query(`UPDATE phone_otps SET expires_at = created_at + interval '1 second' WHERE phone = $1`, [n.e164]);
    await h.pool.query(`ALTER TABLE phone_otps ENABLE TRIGGER phone_otps_guard`);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await client.post("/v1/me/phone/verify", { code })).body.error.code).toBe("CODE_EXPIRED");
  });

  it("changing the number resets verification, and another account's number is refused", async () => {
    const a = newNumber();
    const b = newNumber();
    const { client } = await register(a.local);
    await client.post("/v1/me/phone/verify", { code: h.sms.lastCode(a.e164) });
    const change = await client.post("/v1/me/phone", { phone: b.local });
    expect(change.status).toBe(202);
    expect((await client.get("/v1/auth/me")).body.user).toMatchObject({ phone: b.e164, phoneVerified: false });
    // The old number's code cannot verify the new number.
    expect((await client.post("/v1/me/phone/verify", { code: h.sms.lastCode(a.e164) })).status).toBe(422);
    expect((await client.post("/v1/me/phone/verify", { code: h.sms.lastCode(b.e164) })).status).toBe(200);

    const other = await register();
    expect((await other.client.post("/v1/me/phone", { phone: b.local })).body.error.code).toBe("PHONE_TAKEN");
  });

  it("the profile endpoint cannot set a phone without verification", async () => {
    const { client } = await register();
    const r = await client.patch("/v1/me/profile", { fullName: "New Name", phone: "+2348039999999" });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ fullName: "New Name", phone: null });
  });
});

describe("signing in with a phone", () => {
  async function verifiedStudent() {
    const n = newNumber();
    const { client, email } = await register(n.local);
    await client.post("/v1/me/phone/verify", { code: h.sms.lastCode(n.e164) });
    return { n, client, email };
  }

  it("phone + password works once the phone is verified", async () => {
    const n = newNumber();
    const { client } = await register(n.local);
    const before = await request(h.app.getHttpServer()).post("/v1/auth/login").send({ phone: n.local, password: PASSWORD });
    expect(before.status).toBe(401);
    await client.post("/v1/me/phone/verify", { code: h.sms.lastCode(n.e164) });
    const after = await request(h.app.getHttpServer()).post("/v1/auth/login").send({ phone: n.local, password: PASSWORD, client: "mobile" });
    expect(after.status).toBe(200);
    expect(after.body.sessionToken).toBeTruthy();
    const both = await request(h.app.getHttpServer()).post("/v1/auth/login").send({ phone: n.local, email: "x@example.test", password: PASSWORD });
    expect(both.status).toBe(400);
  });

  it("an SMS code signs in; unknown numbers get the same answer and no text", async () => {
    const { n } = await verifiedStudent();
    const unknown = newNumber();
    const sentBefore = h.sms.sent.length;
    const r1 = await request(h.app.getHttpServer()).post("/v1/auth/otp/request").send({ phone: unknown.local });
    expect(h.sms.sent.length).toBe(sentBefore);
    const r2 = await request(h.app.getHttpServer()).post("/v1/auth/otp/request").send({ phone: n.local });
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(Object.keys(r1.body).sort()).toEqual(Object.keys(r2.body).sort());
    expect(r1.body.message).toBe(r2.body.message);
    const code = h.sms.lastCode(n.e164)!;
    expect(h.sms.last(n.e164)!.text).toMatch(/sign-in code/);

    const wrong = await request(h.app.getHttpServer()).post("/v1/auth/otp/verify").send({ phone: n.local, code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CODE");
    const agent = request.agent(h.app.getHttpServer());
    const ok = await agent.post("/v1/auth/otp/verify").send({ phone: n.local, code });
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]?.[0]).toMatch(/pf_session=.*HttpOnly/);
    expect((await agent.get("/v1/auth/me")).body.user.phone).toBe(n.e164);
    const replay = await request(h.app.getHttpServer()).post("/v1/auth/otp/verify").send({ phone: n.local, code });
    expect(replay.status).toBe(401);
    const audited = await h.pool.query(`SELECT 1 FROM audit_log WHERE action = 'auth.sms_sign_in' AND entity_id = $1`, [ok.body.user.id]);
    expect(audited.rowCount).toBe(1);
  });

  it("a verification code cannot be used to sign in", async () => {
    const n = newNumber();
    const { client } = await register(n.local);
    await client.post("/v1/me/phone", { phone: n.local }).catch(() => undefined);
    const verifyCode = h.sms.lastCode(n.e164)!;
    const r = await request(h.app.getHttpServer()).post("/v1/auth/otp/verify").send({ phone: n.local, code: verifyCode });
    expect(r.status).toBe(401);
  });

  it("resets a password with an SMS code and signs out other devices", async () => {
    const { n, client } = await verifiedStudent();
    const req = await request(h.app.getHttpServer()).post("/v1/auth/password-reset/request").send({ phone: n.local });
    expect(req.status).toBe(202);
    const code = h.sms.lastCode(n.e164)!;
    const confirm = await request(h.app.getHttpServer()).post("/v1/auth/password-reset/confirm").send({ phone: n.local, code, newPassword: "A-brand-new-passphrase-9" });
    expect(confirm.status).toBe(200);
    expect((await client.get("/v1/auth/me")).status).toBe(401);
    const login = await request(h.app.getHttpServer()).post("/v1/auth/login").send({ phone: n.local, password: "A-brand-new-passphrase-9" });
    expect(login.status).toBe(200);
    const reuse = await request(h.app.getHttpServer()).post("/v1/auth/password-reset/confirm").send({ phone: n.local, code, newPassword: "Another-new-passphrase-9" });
    expect(reuse.body.error.code).toBe("TOKEN_INVALID");
  });

  it("texts students with a verified phone when their order is ready", async () => {
    const { n, client } = await verifiedStudent();
    const up = await client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shop.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shop.pickupLocationId }, { "Idempotency-Key": `phone-ready-${Date.now()}-xx` });
    const pay = await client.post(`/v1/orders/${o.body.id}/payments`);
    await client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
    const t = (to: string) => shop.owner.post(`/v1/shops/${shop.shopId}/orders/${o.body.id}/transitions`, { to });
    await t("ACCEPTED");
    await t("PRINTING");
    await t("QUALITY_CHECK");
    await shop.owner.post(`/v1/shops/${shop.shopId}/orders/${o.body.id}/quality-checks`, { result: "PASS", sheetsCounted: 2 });
    const before = h.sms.sent.filter((m) => m.to === n.e164).length;
    await h.drain();
    const texts = h.sms.sent.filter((m) => m.to === n.e164);
    // Only "ready" is texted; accepted/printing are not.
    expect(texts.length - before).toBe(1);
    expect(texts.at(-1)!.text).toMatch(/ready/i);
  });
});

describe("limits and availability", () => {
  it("one code per minute per number, applied identically to unknown numbers", async () => {
    const strict = await startHarness({ RATE_LIMIT_SCALE: "1" }, "printflow_phone_strict_test");
    try {
      const p = await createUser(strict, "strict-platform", { platformRole: "PLATFORM_ADMIN" });
      const u = await onboardUniversity(strict, await Client.login(strict, p.email), "strict-uni");
      const n = newNumber();
      const agent = request.agent(strict.app.getHttpServer());
      const reg = await agent.post("/v1/auth/register").send({ email: uniqueEmail("strict"), password: PASSWORD, fullName: "Strict Student", universityId: u.universityId, campusId: u.campusId, phone: n.local });
      const client = new Client(strict, agent);
      client.csrf = reg.body.csrfToken;
      expect((await client.post("/v1/me/phone", { phone: n.local })).status).toBe(429);

      const unknown = newNumber();
      const first = await request(strict.app.getHttpServer()).post("/v1/auth/otp/request").send({ phone: unknown.local });
      const second = await request(strict.app.getHttpServer()).post("/v1/auth/otp/request").send({ phone: unknown.local });
      expect(first.status).toBe(202);
      expect(second.status).toBe(429);
      expect(second.headers["retry-after"]).toBeTruthy();
    } finally {
      await strict.close();
    }
  }, 60_000);

  it("phone features say so plainly when SMS is switched off", async () => {
    const off = await startHarness({ SMS_DRIVER: "NONE" }, "printflow_nosms_test");
    try {
      const r = await request(off.app.getHttpServer()).post("/v1/auth/otp/request").send({ phone: "08031234567" });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("SMS_UNAVAILABLE");
    } finally {
      await off.close();
    }
  }, 60_000);
});

describe("existing email flows still work", () => {
  it("email registration and verification are unchanged", async () => {
    const st = await registerStudent(h, uni, "email-still");
    expect((await st.client.get("/v1/auth/me")).body.user).toMatchObject({ emailVerified: true, phoneVerified: false, phone: null });
  });
});
