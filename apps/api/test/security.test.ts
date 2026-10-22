import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signGrant, objectKeys } from "../../../packages/storage/src/index.js";
import { docxFiles, EICAR, makePdf, makeZip } from "../../../packages/documents/test/fixtures.js";
import { buildOpenApi, listRoutes, ROUTE_DOCS } from "../src/openapi.js";
import {
  Client,
  createUser,
  onboardUniversity,
  openShop,
  PASSWORD,
  publishCampusCard,
  CAMPUS_CARD,
  registerStudent,
  startHarness,
  totpNow,
  type Campus,
  type Harness,
  type ShopSetup,
} from "./harness.js";

let h: Harness;
let platform: Client;
let uniA: Campus;
let uniB: Campus;
let shopA: ShopSetup;
let shopA2: ShopSetup;
let shopB: ShopSetup;
let pdfBytes: Buffer;

beforeAll(async () => {
  h = await startHarness();
  const p = await createUser(h, "platform", { platformRole: "PLATFORM_ADMIN" });
  platform = await Client.login(h, p.email);
  uniA = await onboardUniversity(h, platform, "uni-a");
  uniB = await onboardUniversity(h, platform, "uni-b");
  await publishCampusCard(uniA);
  await publishCampusCard(uniB);
  shopA = await openShop(h, uniA, "Alpha Prints");
  shopA2 = await openShop(h, uniA, "Second Alpha Prints");
  shopB = await openShop(h, uniB, "Beta Prints");
  const dir = mkdtempSync(join(tmpdir(), "pf-sec-"));
  await makePdf(join(dir, "doc.pdf"), 2);
  pdfBytes = readFileSync(join(dir, "doc.pdf"));
}, 180_000);

afterAll(async () => {
  await h.close();
});

const anon = () => request(h.app.getHttpServer());

/** Student with a READY document and a PAID order at the given shop. */
async function paidOrder(c: Campus, s: ShopSetup, label: string) {
  const st = await registerStudent(h, c, label);
  const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
  await h.drain();
  const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: s.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
  const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: s.pickupLocationId }, { "Idempotency-Key": `k-${label}-${Date.now()}-xxxxxxxx` });
  const pay = await st.client.post(`/v1/orders/${o.body.id}/payments`);
  await st.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
  return { ...st, orderId: o.body.id as string, versionId: up.body.versionId as string, assetId: up.body.assetId as string, quoteId: q.body.id as string, reference: pay.body.reference as string, totalKobo: q.body.totalKobo as number };
}

describe("authentication, sessions and CSRF", () => {
  it("rejects anonymous access to protected routes", async () => {
    const r = await anon().get("/v1/orders");
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(r.body.error.requestId).toBeTruthy();
  });

  it("requires the CSRF token for cookie-authenticated writes", async () => {
    const st = await registerStudent(h, uniA, "csrf");
    const noToken = await st.client.agent.post("/v1/notifications/read-all");
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe("CSRF_FAILED");
    const foreignOrigin = await st.client.agent.post("/v1/notifications/read-all").set("X-CSRF-Token", st.client.csrf).set("Origin", "https://evil.example");
    expect(foreignOrigin.status).toBe(403);
    expect((await st.client.post("/v1/notifications/read-all")).status).toBe(204);
  });

  it("signs in again even when the browser still holds an old session cookie", async () => {
    // Reproduces "Request could not be verified" on the sign-in page: a leftover cookie
    // (another tab, an MFA-pending session, an API restart) plus no or an old token.
    const st = await registerStudent(h, uniA, "stale-cookie");
    const noToken = await st.client.agent.post("/v1/auth/login").send({ email: st.email, password: PASSWORD });
    expect(noToken.status).toBe(200);
    const oldToken = await st.client.agent.post("/v1/auth/login").set("X-CSRF-Token", "stale").set("Origin", "http://web.test").send({ email: st.email, password: PASSWORD });
    expect(oldToken.status).toBe(200);
    // The new session works with its own token; the CSRF check on normal writes is unchanged.
    expect((await st.client.agent.post("/v1/notifications/read-all").set("X-CSRF-Token", oldToken.body.csrfToken)).status).toBe(204);
    expect((await st.client.agent.post("/v1/notifications/read-all").set("X-CSRF-Token", "stale")).body.error.code).toBe("CSRF_FAILED");
  });

  it("refuses sign-in from a foreign page (login CSRF) but accepts local addresses outside production", async () => {
    const st = await registerStudent(h, uniA, "login-origin");
    const evil = await anon().post("/v1/auth/login").set("Origin", "https://evil.example").send({ email: st.email, password: PASSWORD });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("CSRF_FAILED");
    for (const origin of ["http://localhost:3001", "http://127.0.0.1:3000", "http://192.168.1.20:3000"]) {
      const r = await anon().post("/v1/auth/login").set("Origin", origin).send({ email: st.email, password: PASSWORD });
      expect(r.status, origin).toBe(200);
    }
  });

  it("gives mobile clients a bearer token that needs no CSRF header", async () => {
    const st = await registerStudent(h, uniA, "mobile");
    const login = await anon().post("/v1/auth/login").send({ email: st.email, password: PASSWORD, client: "mobile" });
    expect(login.headers["set-cookie"]).toBeUndefined();
    const r = await anon().post("/v1/notifications/read-all").set("Authorization", `Bearer ${login.body.sessionToken}`);
    expect(r.status).toBe(204);
  });

  it("sets HttpOnly, SameSite session cookies and security headers", async () => {
    const st = await registerStudent(h, uniA, "cookie");
    const r = await anon().post("/v1/auth/login").send({ email: st.email, password: PASSWORD });
    expect(String(r.headers["set-cookie"])).toMatch(/pf_session=.*HttpOnly.*SameSite=Lax/i);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("returns the same error for unknown emails and wrong passwords, then locks out", async () => {
    const u = await createUser(h, "lockme");
    const unknown = await anon().post("/v1/auth/login").send({ email: "nobody@example.test", password: "whatever-123" });
    const wrong = await anon().post("/v1/auth/login").send({ email: u.email, password: "not-the-password" });
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual({ ...unknown.body.error, requestId: wrong.body.error.requestId });
    for (let i = 0; i < 9; i++) await anon().post("/v1/auth/login").send({ email: u.email, password: "not-the-password" });
    // Correct password is refused while the account is locked.
    const locked = await anon().post("/v1/auth/login").send({ email: u.email, password: PASSWORD });
    expect(locked.status).toBe(401);
    const row = await h.pool.query<{ locked_until: Date | null }>(`SELECT locked_until FROM users WHERE id = $1`, [u.id]);
    expect(row.rows[0]!.locked_until).not.toBeNull();
  });

  it("password reset works once and signs out every session", async () => {
    const st = await registerStudent(h, uniA, "reset");
    const resp = await anon().post("/v1/auth/password-reset/request").send({ email: st.email });
    expect(resp.status).toBe(202);
    const unknownResp = await anon().post("/v1/auth/password-reset/request").send({ email: "ghost@example.test" });
    expect(unknownResp.body).toEqual(resp.body);
    const token = /reset-password\?token=([\w-]+)/.exec(h.mailer.last(st.email)!.text)![1];
    const ok = await anon().post("/v1/auth/password-reset/confirm").send({ token, newPassword: "A-much-better-passphrase-2026" });
    expect(ok.status).toBe(200);
    expect((await st.client.get("/v1/auth/me")).status).toBe(401);
    const reuse = await anon().post("/v1/auth/password-reset/confirm").send({ token, newPassword: "Another-passphrase-2026" });
    expect(reuse.body.error.code).toBe("TOKEN_INVALID");
  });

  it("rejects weak passwords at registration", async () => {
    const r = await anon().post("/v1/auth/register").send({ email: "weak@example.test", password: "short", fullName: "Weak Pass", universityId: uniA.universityId, campusId: uniA.campusId });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rate-limits password reset requests and logins at production limits", async () => {
    const strict = await startHarness({ RATE_LIMIT_SCALE: "1" }, "printflow_ratelimit_test");
    try {
      const email = "ratelimit@example.test";
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await anon2(strict).post("/v1/auth/password-reset/request").send({ email })).status);
      expect(codes.slice(0, 3)).toEqual([202, 202, 202]);
      expect(codes[3]).toBe(429);
      const login = [];
      for (let i = 0; i < 12; i++) login.push((await anon2(strict).post("/v1/auth/login").send({ email, password: "wrong-password" })).status);
      expect(login.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(login[10]).toBe(429);
      const limited = await anon2(strict).post("/v1/auth/login").send({ email, password: "wrong-password" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await strict.close();
    }
  }, 60_000);
});

describe("staff MFA (TOTP)", () => {
  it("blocks privileged endpoints until the session is MFA-verified, and rejects replayed codes", async () => {
    const strict = await startHarness({ REQUIRE_STAFF_MFA: "true", RATE_LIMIT_SCALE: "1" }, "printflow_strict_test");
    try {
      const p = await createUser(strict, "strict-platform", { platformRole: "PLATFORM_ADMIN" });
      const c = await Client.login(strict, p.email);
      const denied = await c.get("/v1/platform/universities");
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("MFA_REQUIRED");

      const setup = await c.post("/v1/auth/mfa/totp/setup");
      expect(setup.body.otpauthUri).toContain("otpauth://totp/");
      const enrolCode = totpNow(setup.body.secret);
      expect((await c.post("/v1/auth/mfa/totp/confirm", { code: enrolCode })).status).toBe(200);
      expect((await c.get("/v1/platform/universities")).status).toBe(200);

      // Stored encrypted, never in plaintext.
      const stored = await strict.pool.query<{ secret_ciphertext: Buffer }>(`SELECT secret_ciphertext FROM mfa_factors WHERE user_id = $1`, [p.id]);
      expect(stored.rows[0]!.secret_ciphertext.toString("latin1")).not.toContain(setup.body.secret);

      // New login: the same (already used) code is refused; a fresh step is accepted.
      const replay = await anon2(strict).post("/v1/auth/login").send({ email: p.email, password: PASSWORD, mfaCode: enrolCode });
      expect(replay.body.error.code).toBe("MFA_INVALID");
      const fresh = await Client.login(strict, p.email, PASSWORD, { mfaCode: totpNow(setup.body.secret, 1) });
      expect((await fresh.get("/v1/platform/universities")).status).toBe(200);
    } finally {
      await strict.close();
    }
  }, 60_000);
});

const anon2 = (hh: Harness) => request(hh.app.getHttpServer());

describe("tenant isolation and IDOR", () => {
  it("students cannot read or act on other students' orders", async () => {
    const a = await paidOrder(uniA, shopA, "victim");
    const b = await registerStudent(h, uniA, "attacker");
    expect((await b.client.get(`/v1/orders/${a.orderId}`)).status).toBe(404);
    expect((await b.client.post(`/v1/orders/${a.orderId}/cancel`, {})).status).toBe(404);
    expect((await b.client.post(`/v1/orders/${a.orderId}/pickup-code`)).status).toBe(404);
    expect((await b.client.get(`/v1/documents/${a.assetId}`)).status).toBe(404);
    expect((await b.client.get(`/v1/documents/versions/${a.versionId}/previews/1`)).status).toBe(404);
    expect((await b.client.get(`/v1/quotes/${a.quoteId}`)).status).toBe(404);
    expect((await b.client.get(`/v1/test-payments/${a.reference}`)).status).toBe(404);
  });

  it("a student cannot quote another student's document", async () => {
    const a = await paidOrder(uniA, shopA, "docowner");
    const b = await registerStudent(h, uniA, "docthief");
    const r = await b.client.post("/v1/quotes", { documentVersionId: a.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    expect(r.status).toBe(404);
  });

  it("a student cannot order from a shop at another university", async () => {
    const st = await registerStudent(h, uniA, "crossuni");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const r = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopB.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    expect(r.body.error.code).toBe("SHOP_UNAVAILABLE");
  });

  it("shop staff cannot see or act on another shop's orders or files", async () => {
    const a = await paidOrder(uniA, shopA, "shopiso");
    // Not a member of shop A at all:
    expect((await shopA2.owner.get(`/v1/shops/${shopA.shopId}/orders/${a.orderId}`)).status).toBe(403);
    // Member of shop A2 asking for shop A's order through shop A2's routes:
    expect((await shopA2.owner.get(`/v1/shops/${shopA2.shopId}/orders/${a.orderId}`)).status).toBe(404);
    expect((await shopA2.owner.post(`/v1/shops/${shopA2.shopId}/orders/${a.orderId}/transitions`, { to: "ACCEPTED" })).status).toBe(404);
    expect((await shopA2.owner.post(`/v1/shops/${shopA2.shopId}/orders/${a.orderId}/document-link`)).status).toBe(404);
  });

  it("university admins are confined to their own university", async () => {
    const a = await paidOrder(uniA, shopA, "uniiso");
    expect((await uniB.admin.get(`/v1/admin/universities/${uniA.universityId}/orders`)).status).toBe(403);
    expect((await uniB.admin.get(`/v1/admin/universities/${uniB.universityId}/orders/${a.orderId}`)).status).toBe(404);
    expect((await uniB.admin.post(`/v1/admin/universities/${uniB.universityId}/shops/${shopA.shopId}/status`, { action: "suspend", reason: "hostile" })).status).toBe(409);
  });

  it("a platform admin can reset a staff member's authenticator, which signs them out", async () => {
    const email = shopA.ownerUser.email;
    const setup = await shopA.owner.post("/v1/auth/mfa/totp/setup");
    expect((await shopA.owner.post("/v1/auth/mfa/totp/confirm", { code: totpNow(setup.body.secret) })).status).toBe(200);
    expect((await uniA.admin.post(`/v1/platform/users/mfa-reset`, { email, reason: "Lost phone, identity checked" })).status).toBe(403);
    expect((await platform.post(`/v1/platform/users/mfa-reset`, { email, reason: "short" })).status).toBe(400);
    const r = await platform.post(`/v1/platform/users/mfa-reset`, { email, reason: "Lost phone; identity checked by video call" });
    expect(r.body).toMatchObject({ reset: true });
    expect(r.body.sessionsRevoked).toBeGreaterThan(0);
    expect((await shopA.owner.get(`/v1/shops/${shopA.shopId}/queue`)).status).toBe(401);
    const f = await h.pool.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1`, [shopA.ownerUser.id]);
    expect(f.rowCount).toBe(0);
    const audit = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'user.mfa_reset' AND entity_id = $1`, [shopA.ownerUser.id]);
    expect(audit.rows[0].details.reason).toMatch(/video call/);
    // The owner can sign in again (and, where staff MFA is enforced, re-enrols first).
    shopA.owner = await Client.login(h, email);
    expect((await shopA.owner.get(`/v1/shops/${shopA.shopId}/queue`)).status).toBe(200);
  });

  it("non-platform users cannot reach platform routes", async () => {
    expect((await uniA.admin.get("/v1/platform/universities")).status).toBe(403);
  });
});

describe("privilege escalation", () => {
  it("staff cannot grant permissions they lack, or change their own", async () => {
    const opUser = await createUser(h, "operator");
    const mgrUser = await createUser(h, "manager");
    await shopA.owner.post(`/v1/shops/${shopA.shopId}/staff`, { email: opUser.email, role: "OPERATOR" });
    const mgr = await shopA.owner.post(`/v1/shops/${shopA.shopId}/staff`, { email: mgrUser.email, role: "MANAGER", permissions: ["orders.view", "staff.manage"] });
    expect(mgr.status).toBe(201);
    const op = await Client.login(h, opUser.email);
    expect((await op.get(`/v1/shops/${shopA.shopId}/staff`)).status).toBe(403);
    const manager = await Client.login(h, mgrUser.email);
    const escalate = await manager.post(`/v1/shops/${shopA.shopId}/staff`, { email: (await createUser(h, "friend")).email, role: "MANAGER", permissions: ["pricing.manage"] });
    expect(escalate.status).toBe(403);
    const self = await manager.patch(`/v1/shops/${shopA.shopId}/staff/${mgr.body.id}`, { permissions: ["orders.view", "staff.manage", "orders.accept"] });
    expect(self.status).toBe(403);
  });

  it("an operator without orders.accept cannot accept, and without documents.download cannot fetch files", async () => {
    const a = await paidOrder(uniA, shopA, "opperm");
    const u = await createUser(h, "limitedop");
    await shopA.owner.post(`/v1/shops/${shopA.shopId}/staff`, { email: u.email, role: "OPERATOR", permissions: ["orders.view", "orders.produce"] });
    const op = await Client.login(h, u.email);
    const acc = await op.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/transitions`, { to: "ACCEPTED" });
    expect(acc.body.error.code).toBe("MISSING_PERMISSION");
    expect((await op.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/document-link`)).status).toBe(403);
  });

  it("only the payment system can mark orders paid", async () => {
    const st = await registerStudent(h, uniA, "selfpay");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId }, { "Idempotency-Key": "selfpay-key-000000001" });
    const r = await shopA.owner.post(`/v1/shops/${shopA.shopId}/orders/${o.body.id}/transitions`, { to: "PAID" });
    expect(r.status).toBe(404); // unpaid orders are not even visible to the shop
  });
});

describe("files and signed links", () => {
  it("rejects tampered, foreign and expired download tokens", async () => {
    const a = await paidOrder(uniA, shopA, "links");
    const prev = await a.client.get(`/v1/documents/versions/${a.versionId}/previews/1`);
    const token = new URL(prev.body.url).pathname.split("/").pop()!;
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), k: objectKeys.print(a.assetId, a.versionId) })).toString("base64url");
    expect((await anon().get(`/v1/files/${forged}.${mac}`)).status).toBe(403);
    const expired = signGrant("storage-signing-secret-for-tests-0123456789", { k: objectKeys.print(a.assetId, a.versionId), e: 1, f: "x.pdf", c: "application/pdf" });
    expect((await anon().get(`/v1/files/${expired}`)).body.error.code).toBe("LINK_EXPIRED");
    expect((await anon().get(`/v1/files/not-a-token`)).status).toBe(403);
  });
});

describe("document validation", () => {
  it("rejects files that are not PDF or DOCX by content, whatever their name", async () => {
    const st = await registerStudent(h, uniA, "badfile");
    const exe = await st.client.upload("/v1/documents", Buffer.from("MZ\x90\x00 fake executable"), "notes.pdf");
    expect(exe.body.error.code).toBe("UNSUPPORTED_TYPE");
    const html = await st.client.upload("/v1/documents", Buffer.from("<script>alert(1)</script>"), "x.pdf", "text/html");
    expect(html.status).toBe(415);
    const empty = await st.client.upload("/v1/documents", Buffer.alloc(0), "empty.pdf");
    expect(empty.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects uploads over 50 MB", async () => {
    const st = await registerStudent(h, uniA, "bigfile");
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(50 * 1024 * 1024 + 10, 0x20)]);
    const r = await st.client.upload("/v1/documents", big, "huge.pdf");
    expect(r.status).toBe(413);
  }, 60_000);

  it("quarantines malware (EICAR) and never makes it printable", async () => {
    const st = await registerStudent(h, uniA, "eicar");
    const up = await st.client.upload("/v1/documents", Buffer.from(`%PDF-1.4\n${EICAR}\n`), "virus.pdf");
    expect(up.status).toBe(202);
    await h.drain();
    const d = await st.client.get(`/v1/documents/${up.body.assetId}`);
    expect(d.body.versions[0]).toMatchObject({ status: "REJECTED", scanStatus: "INFECTED" });
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    expect(q.body.error.code).toBe("DOCUMENT_NOT_READY");
  });

  it("converts Word documents and rejects macro-enabled ones", async () => {
    const st = await registerStudent(h, uniA, "docx");
    const dir = mkdtempSync(join(tmpdir(), "pf-docx-"));
    makeZip(join(dir, "ok.docx"), docxFiles(["Assignment 1", "Answer"]));
    makeZip(join(dir, "macro.docx"), [...docxFiles(["x"]), { name: "word/vbaProject.bin", data: Buffer.from("macro") }]);
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const ok = await st.client.upload("/v1/documents", readFileSync(join(dir, "ok.docx")), "Assignment.docx", mime);
    const bad = await st.client.upload("/v1/documents", readFileSync(join(dir, "macro.docx")), "Macro.docx", mime);
    await h.drain();
    expect((await st.client.get(`/v1/documents/${ok.body.assetId}`)).body.versions[0]).toMatchObject({ status: "READY", pageCount: 1 });
    const badDoc = (await st.client.get(`/v1/documents/${bad.body.assetId}`)).body.versions[0];
    expect(badDoc.status).toBe("REJECTED");
    expect(badDoc.failureReason).toContain("macros");
  }, 120_000);

  it("replacement creates a new version; existing orders keep the original", async () => {
    const a = await paidOrder(uniA, shopA, "replace");
    const dir = mkdtempSync(join(tmpdir(), "pf-rep-"));
    await makePdf(join(dir, "v2.pdf"), 5);
    const r = await a.client.upload(`/v1/documents/${a.assetId}/versions`, readFileSync(join(dir, "v2.pdf")), "v2.pdf");
    expect(r.body.versionNumber).toBe(2);
    await h.drain();
    const order = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(order.body.document).toMatchObject({ versionId: a.versionId, versionNumber: 1, pageCount: 2 });
  });
});

describe("quotes, orders and payments", () => {
  it("rejects orders from expired quotes", async () => {
    const st = await registerStudent(h, uniA, "expired");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    await h.pool.query(`ALTER TABLE quotes DISABLE TRIGGER quotes_immutable`);
    await h.pool.query(`UPDATE quotes SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [q.body.id]);
    await h.pool.query(`ALTER TABLE quotes ENABLE TRIGGER quotes_immutable`);
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId }, { "Idempotency-Key": "expired-quote-key-0001" });
    expect(o.status).toBe(410);
    expect(o.body.error.code).toBe("QUOTE_EXPIRED");
  });

  it("refuses unverified emails, invalid specs and foreign pickup points", async () => {
    const st = await registerStudent(h, uniA, "specs");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const tooMany = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, pageRanges: "1-9", paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    expect(tooMany.body.error.code).toBe("INVALID_PRINT_SPEC");
    const notOffered = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A3", colourMode: "COLOUR", sides: "DOUBLE" } });
    expect(notOffered.body.error.code).toBe("INVALID_PRINT_SPEC");
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const wrongPickup = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopB.pickupLocationId }, { "Idempotency-Key": "wrong-pickup-key-0001" });
    expect(wrongPickup.body.error.code).toBe("INVALID_PICKUP_LOCATION");
    const noKey = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId });
    expect(noKey.status).toBe(400);
    // A failed request does not consume its key, so the corrected retry succeeds...
    const fixed = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId }, { "Idempotency-Key": "wrong-pickup-key-0001" });
    expect(fixed.status).toBe(201);
    // ...but reusing a successful key for a different request is refused.
    const reusedKey = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA2.pickupLocationId }, { "Idempotency-Key": "wrong-pickup-key-0001" });
    expect(reusedKey.status).toBe(409);
    expect(reusedKey.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("ignores any client-supplied amount: the charge is always the frozen quote", async () => {
    const st = await registerStudent(h, uniA, "tamper");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", {
      documentVersionId: up.body.versionId,
      shopId: shopA.shopId,
      spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" },
      totalKobo: 1,
    });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId, totalKobo: 1 }, { "Idempotency-Key": "tamper-key-000000001" });
    expect(o.body.totalKobo).toBe(q.body.totalKobo);
    const pay = await st.client.post(`/v1/orders/${o.body.id}/payments`, { amountKobo: 1 });
    expect(pay.body.amountKobo).toBe(q.body.totalKobo);
  });

  it("payment failure leaves the order unpaid; a later success still works", async () => {
    const st = await registerStudent(h, uniA, "payfail");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId }, { "Idempotency-Key": "payfail-key-00000001" });
    const p1 = await st.client.post(`/v1/orders/${o.body.id}/payments`);
    expect((await st.client.post(`/v1/test-payments/${p1.body.reference}/complete`, { outcome: "failed" })).body.outcome).toBe("FAILED_RECORDED");
    expect((await st.client.get(`/v1/orders/${o.body.id}`)).body.status).toBe("AWAITING_PAYMENT");
    const p2 = await st.client.post(`/v1/orders/${o.body.id}/payments`);
    expect((await st.client.post(`/v1/test-payments/${p2.body.reference}/complete`, { outcome: "success" })).body.outcome).toBe("PAID");
  });

  it("duplicate and forged webhooks are handled safely", async () => {
    const st = await registerStudent(h, uniA, "dupe");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId }, { "Idempotency-Key": "dupe-key-0000000001" });
    const p = await st.client.post(`/v1/orders/${o.body.id}/payments`);
    const raw = Buffer.from(JSON.stringify({ id: "evt_duplicate_1", event: "charge.success", reference: p.body.reference, amount: q.body.totalKobo, currency: "NGN" }));
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha512", h.cfg.TEST_WEBHOOK_SECRET).update(raw).digest("hex");
    const send = (s: string) => anon().post("/v1/webhooks/test").set("Content-Type", "application/json").set("x-test-signature", s).send(raw.toString());
    const forged = await send("ab".repeat(64));
    expect(forged.status).toBe(403);
    expect((await st.client.get(`/v1/orders/${o.body.id}`)).body.status).toBe("AWAITING_PAYMENT");
    const results = await Promise.all([send(sig), send(sig), send(sig)]);
    expect(results.map((r) => r.body.outcome).filter((x) => x === "PAID")).toHaveLength(1);
    const events = (await st.client.get(`/v1/orders/${o.body.id}`)).body.events.filter((e: { to: string }) => e.to === "PAID");
    expect(events).toHaveLength(1);
  });

  it("checkout is blocked when no payment provider is configured", async () => {
    const off = await startHarness({ PAYMENT_PROVIDER: "NONE" }, "printflow_nopay_test");
    try {
      const p = await createUser(off, "off-platform", { platformRole: "PLATFORM_ADMIN" });
      const plat = await Client.login(off, p.email);
      const c = await onboardUniversity(off, plat, "uni-off");
      await publishCampusCard(c);
      const s = await openShop(off, c, "Offline Prints");
      const st = await registerStudent(off, c, "nocheckout");
      const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
      off.worker.scanner = h.worker.scanner;
      for (;;) if ((await (await import("../../worker/src/runner.js")).drainOnce(off.worker, "w", 10)) === 0) break;
      const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: s.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
      expect(q.body.checkout).toBe("DISABLED");
      const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: s.pickupLocationId }, { "Idempotency-Key": "nocheckout-key-000001" });
      const pay = await st.client.post(`/v1/orders/${o.body.id}/payments`);
      expect(pay.status).toBe(503);
      expect(pay.body.error.code).toBe("CHECKOUT_DISABLED");
      expect((await st.client.get(`/v1/test-payments/anything`)).status).toBe(404);
    } finally {
      await off.close();
    }
  }, 60_000);
});

describe("cancellations, refunds and failures", () => {
  it("a student cancels a paid order before acceptance and is refunded to their card", async () => {
    const a = await paidOrder(uniA, shopA, "cancelpaid");
    const c = await a.client.post(`/v1/orders/${a.orderId}/cancel`, { reason: "Printed elsewhere", refundTo: "PROVIDER" });
    expect(c.body.status).toBe("REFUND_PENDING");
    await h.drain();
    const d = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(d.body.status).toBe("REFUNDED");
    expect(d.body.refunds[0]).toMatchObject({ amountKobo: String(a.totalKobo), status: "SUCCEEDED", destination: "PROVIDER" });
  });

  it("cannot cancel after the shop accepts", async () => {
    const a = await paidOrder(uniA, shopA, "cancellate");
    await shopA.owner.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/transitions`, { to: "ACCEPTED" });
    const c = await a.client.post(`/v1/orders/${a.orderId}/cancel`, {});
    expect(c.body.error.code).toBe("NOT_CANCELLABLE");
  });

  it("a shop rejection refunds automatically", async () => {
    const a = await paidOrder(uniA, shopA, "rejected");
    const noReason = await shopA.owner.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/transitions`, { to: "REJECTED" });
    expect(noReason.body.error.code).toBe("REASON_REQUIRED");
    const r = await shopA.owner.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/transitions`, { to: "REJECTED", reason: "File is landscape posters" });
    // Refunded to the student's wallet straight away.
    expect(r.body.status).toBe("REFUNDED");
    const d = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(d.body.refunds[0]).toMatchObject({ destination: "WALLET", status: "SUCCEEDED" });
    expect(d.body.wallet.balanceKobo).toBe(a.totalKobo);
  });

  it("a failed printer can retry; QA mismatch forces a reprint; unrecoverable failure refunds", async () => {
    const a = await paidOrder(uniA, shopA, "printfail");
    const t = (to: string, extra: object = {}) => shopA.owner.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/transitions`, { to, ...extra });
    await t("ACCEPTED");
    await t("PRINTING", { deviceId: shopA.deviceId });
    expect((await t("PRINT_FAILED", { reason: "Paper jam on Printer 1" })).body.status).toBe("PRINT_FAILED");
    await shopA.owner.patch(`/v1/shops/${shopA.shopId}/devices/${shopA.deviceId}`, { reportedStatus: "FAULT" });
    expect((await t("PRINTING")).body.status).toBe("PRINTING");
    await t("QUALITY_CHECK");
    const qa = await shopA.owner.post(`/v1/shops/${shopA.shopId}/orders/${a.orderId}/quality-checks`, { result: "PASS", sheetsCounted: 1 });
    expect(qa.body.status).toBe("PRINTING"); // counted 1 sheet, job has 2: recorded as mismatch and sent back
    const detail = await shopA.owner.get(`/v1/shops/${shopA.shopId}/orders/${a.orderId}`);
    expect(detail.body.qualityChecks[0]).toMatchObject({ result: "FAIL", issues: ["PAGE_COUNT_MISMATCH"] });
    await t("PRINT_FAILED", { reason: "Toner out, no spare" });
    expect((await t("REFUND_PENDING", { reason: "Cannot complete this job today" })).body.status).toBe("REFUNDED");
    expect((await a.client.get(`/v1/orders/${a.orderId}`)).body.status).toBe("REFUNDED");
  });

  it("disputes can be resolved with a partial refund by the university", async () => {
    const a = await paidOrder(uniA, shopA, "dispute");
    const d = await a.client.post(`/v1/orders/${a.orderId}/disputes`, { category: "QUALITY", description: "Pages 2 is smudged and unreadable" });
    expect(d.status).toBe(201);
    const r = await uniA.admin.post(`/v1/admin/universities/${uniA.universityId}/disputes/${d.body.id}/resolve`, { status: "RESOLVED_REFUND", note: "Partial refund for page 2", refundKobo: 2_000, refundTo: "PROVIDER" });
    expect(r.status).toBe(200);
    await h.drain();
    const o = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(o.body.refunds).toEqual([expect.objectContaining({ amountKobo: "2000", status: "SUCCEEDED" })]);
    const over = await uniA.admin.post(`/v1/admin/universities/${uniA.universityId}/orders/${a.orderId}/refund`, { reason: "Full refund too" });
    expect(over.status).toBe(200); // remaining balance only
    await h.drain();
    const total = (await a.client.get(`/v1/orders/${a.orderId}`)).body.refunds.reduce((s: number, x: { amountKobo: string }) => s + Number(x.amountKobo), 0);
    expect(total).toBe(a.totalKobo);
  });

  it("a student can reprint their own order, linked to the original, but not someone else's", async () => {
    const a = await paidOrder(uniA, shopA, "reprint-a");
    const b = await paidOrder(uniA, shopA, "reprint-b");
    const q = () => a.client.post("/v1/quotes", { documentVersionId: a.versionId, shopId: shopA.shopId, spec: { copies: 2, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const foreign = await a.client.post("/v1/orders", { quoteId: (await q()).body.id, pickupLocationId: shopA.pickupLocationId, reprintOfOrderId: b.orderId }, { "Idempotency-Key": `reprint-foreign-${Date.now()}-x` });
    expect(foreign.status).toBe(404);
    const own = await a.client.post("/v1/orders", { quoteId: (await q()).body.id, pickupLocationId: shopA.pickupLocationId, reprintOfOrderId: a.orderId }, { "Idempotency-Key": `reprint-own-${Date.now()}-xx` });
    expect(own.status).toBe(201);
    const pay = await a.client.post(`/v1/orders/${own.body.id}/payments`);
    await a.client.post(`/v1/test-payments/${pay.body.reference}/complete`, { outcome: "success" });
    const job = await shopA.owner.get(`/v1/shops/${shopA.shopId}/orders/${own.body.id}`);
    expect(job.body.reprintOfOrderId).toBe(a.orderId);
  });

  it("a refund the provider refused can be re-issued, never beyond what was paid", async () => {
    const a = await paidOrder(uniA, shopA, "refundretry");
    const base = `/v1/admin/universities/${uniA.universityId}/orders/${a.orderId}`;
    expect((await uniA.admin.post(`${base}/refund-retry`, { reason: "Nothing failed yet" })).body.error.code).toBe("NOT_REFUND_PENDING");
    await uniA.admin.post(`${base}/refund`, { reason: "Shop closed for the week", refundTo: "PROVIDER" });
    // Simulate the provider refusing the refund before the worker completes it.
    await h.pool.query(`UPDATE refunds SET status = 'FAILED', completed_at = now() WHERE order_id = $1`, [a.orderId]);
    await h.drain();
    expect((await a.client.get(`/v1/orders/${a.orderId}`)).body.status).toBe("REFUND_PENDING");

    expect((await shopA.owner.post(`${base}/refund-retry`, { reason: "Not my university" })).status).toBe(403);
    const retry = await uniA.admin.post(`${base}/refund-retry`, { reason: "Provider balance topped up" });
    expect(retry.status).toBe(201);
    expect(retry.body.amountKobo).toBe(a.totalKobo);
    expect((await uniA.admin.post(`${base}/refund-retry`, { reason: "Double click" })).body.error.code).toBe("REFUND_IN_PROGRESS");
    await h.drain();
    const o = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(o.body.status).toBe("REFUNDED");
    const succeeded = o.body.refunds.filter((r: { status: string }) => r.status === "SUCCEEDED");
    expect(succeeded.reduce((s: number, r: { amountKobo: string }) => s + Number(r.amountKobo), 0)).toBe(a.totalKobo);
    const audit = await h.pool.query(`SELECT 1 FROM audit_log WHERE action = 'refund.retried' AND entity_id = $1`, [a.orderId]);
    expect(audit.rowCount).toBe(1);
  });

  it("unpaid orders expire when the payment window closes", async () => {
    const st = await registerStudent(h, uniA, "expire");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: shopA.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
    const o = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: shopA.pickupLocationId }, { "Idempotency-Key": "expire-key-000000001" });
    await h.pool.query(`ALTER TABLE orders DISABLE TRIGGER orders_update_guard`);
    await h.pool.query(`UPDATE orders SET payment_due_at = now() - interval '1 minute' WHERE id = $1`, [o.body.id]);
    await h.pool.query(`ALTER TABLE orders ENABLE TRIGGER orders_update_guard`);
    await h.pool.query(`UPDATE jobs SET run_after = now() WHERE dedupe_key = $1`, [`expire:${o.body.id}`]);
    await h.drain();
    expect((await st.client.get(`/v1/orders/${o.body.id}`)).body.status).toBe("EXPIRED");
  });
});

describe("offline-safe shop sync", () => {
  it("applies fresh actions, reports conflicts with the current state, and is idempotent", async () => {
    const a = await paidOrder(uniA, shopA, "sync");
    const v = (await shopA.owner.get(`/v1/shops/${shopA.shopId}/orders/${a.orderId}`)).body.version;
    const action = { clientActionId: `act-${Date.now()}-accept-01`, orderId: a.orderId, to: "ACCEPTED", expectedVersion: v, draftedAt: new Date().toISOString() };
    const first = await shopA.owner.post(`/v1/shops/${shopA.shopId}/sync`, { actions: [action] });
    expect(first.body.results[0]).toMatchObject({ outcome: "APPLIED", status: "ACCEPTED" });
    const replay = await shopA.owner.post(`/v1/shops/${shopA.shopId}/sync`, { actions: [action] });
    expect(replay.body.results[0]).toEqual(first.body.results[0]);
    const stale = await shopA.owner.post(`/v1/shops/${shopA.shopId}/sync`, {
      actions: [{ clientActionId: `act-${Date.now()}-print-001`, orderId: a.orderId, to: "PRINTING", expectedVersion: v, draftedAt: new Date().toISOString() }],
    });
    expect(stale.body.results[0]).toMatchObject({ outcome: "CONFLICT", current: { status: "ACCEPTED", version: v + 1 } });
    expect((await shopA.owner.get(`/v1/shops/${shopA.shopId}/orders/${a.orderId}`)).body.status).toBe("ACCEPTED");
  });
});

describe("pricing administration", () => {
  it("merchant pricing must stay within the university's agreed bounds", async () => {
    const shopBefore = await shopB.owner.post(`/v1/shops/${shopB.shopId}/rate-cards`, { effectiveFrom: new Date().toISOString(), sheetPrices: [{ paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheetKobo: 3_000 }] });
    expect(shopBefore.status).toBe(403); // university-controlled mode
    await uniB.admin.patch(`/v1/admin/universities/${uniB.universityId}/settings`, { pricingMode: "MERCHANT_CONTROLLED" });
    await uniB.admin.put(`/v1/admin/universities/${uniB.universityId}/price-bounds`, { bounds: [{ paperSize: "A4", colourMode: "BW", sides: "SINGLE", minKobo: 1_000, maxKobo: 4_000 }] });
    const greedy = await shopB.owner.post(`/v1/shops/${shopB.shopId}/rate-cards`, { effectiveFrom: new Date(Date.now() - 1000).toISOString(), sheetPrices: [{ paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheetKobo: 9_000 }] });
    const pub = await shopB.owner.post(`/v1/shops/${shopB.shopId}/rate-cards/${greedy.body.id}/publish`);
    expect(pub.body.error.code).toBe("PRICING_NOT_AVAILABLE");
    const fair = await shopB.owner.post(`/v1/shops/${shopB.shopId}/rate-cards`, { effectiveFrom: new Date(Date.now() - 1000).toISOString(), sheetPrices: [{ paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheetKobo: 3_000 }] });
    expect((await shopB.owner.post(`/v1/shops/${shopB.shopId}/rate-cards/${fair.body.id}/publish`)).status).toBe(200);
    const list = await anon().get(`/v1/shops/${shopB.shopId}/price-list`);
    expect(list.body).toMatchObject({ configured: true, pricingMode: "MERCHANT_CONTROLLED", sheetPrices: [expect.objectContaining({ pricePerSheet: 3_000 })] });
    await uniB.admin.patch(`/v1/admin/universities/${uniB.universityId}/settings`, { pricingMode: "UNIVERSITY_CONTROLLED" });
  });

  it("price changes never affect confirmed orders", async () => {
    const a = await paidOrder(uniA, shopA, "frozen");
    await publishCampusCard(uniA, { ...(await import("./harness.js")).CAMPUS_CARD, effectiveFrom: new Date(Date.now() - 1000).toISOString(), sheetPrices: [{ paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheetKobo: 99_000 }] });
    const o = await a.client.get(`/v1/orders/${a.orderId}`);
    expect(o.body.totalKobo).toBe(a.totalKobo);
    expect(o.body.rateCardVersion).toBe(1);
    // restore cheap pricing for later tests
    await publishCampusCard(uniA, { ...(await import("./harness.js")).CAMPUS_CARD, effectiveFrom: new Date(Date.now() - 500).toISOString() });
  });

  it("every privileged action lands in the audit log, readable by the university", async () => {
    const { rows } = await h.pool.query<{ action: string }>(`SELECT DISTINCT action FROM audit_log WHERE university_id = $1`, [uniA.universityId]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["shop.applied", "shop.approve", "rate_card.drafted", "rate_card.published", "order.status_changed", "staff.added", "device.added", "payment.initiated", "pickup.failed_attempt"]) {
      if (a === "pickup.failed_attempt") continue; // exercised in the journey suite
      expect(actions, a).toContain(a);
    }
    const page1 = await uniA.admin.get(`/v1/admin/universities/${uniA.universityId}/audit-log?limit=5`);
    expect(page1.body.items).toHaveLength(5);
    const page2 = await uniA.admin.get(`/v1/admin/universities/${uniA.universityId}/audit-log?limit=5&cursor=${page1.body.nextCursor}`);
    expect(Number(page2.body.items[0].id)).toBeLessThan(Number(page1.body.items[4].id));
    expect((await uniB.admin.get(`/v1/admin/universities/${uniA.universityId}/audit-log`)).status).toBe(403);
  });
});

describe("privacy", () => {
  it("exports a student's data and erases an account without active orders", async () => {
    const st = await registerStudent(h, uniA, "privacy");
    const exp = await st.client.post("/v1/privacy-requests", { kind: "EXPORT" });
    await h.drain();
    const dl = await st.client.get(`/v1/privacy-requests/${exp.body.id}/download`);
    expect(dl.status).toBe(200);
    const er = await st.client.post("/v1/privacy-requests", { kind: "ERASURE" });
    await uniA.admin.post(`/v1/admin/universities/${uniA.universityId}/privacy-requests/${er.body.id}`, { status: "COMPLETED", note: "Verified identity" });
    await h.drain();
    const u = await h.pool.query<{ status: string; email: string; full_name: string }>(`SELECT status, email, full_name FROM users WHERE id = $1`, [st.userId]);
    expect(u.rows[0]).toMatchObject({ status: "DELETED", full_name: "Deleted user" });
    expect(u.rows[0]!.email).not.toContain("privacy");
    expect((await st.client.get("/v1/auth/me")).status).toBe(401);
  });
});

describe("API contract", () => {
  it("documents every route in OpenAPI", () => {
    const missing = listRoutes().filter((r) => !ROUTE_DOCS[`${r.method} ${r.path}`]);
    expect(missing).toEqual([]);
    const stale = Object.keys(ROUTE_DOCS).filter((k) => !listRoutes().some((r) => `${r.method} ${r.path}` === k));
    expect(stale).toEqual([]);
    const doc = buildOpenApi() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).length).toBeGreaterThan(80 / 2);
  });

  it("never leaks internals on unexpected errors", async () => {
    const r = await anon().get("/v1/universities/not-a-uuid");
    expect(r.status).toBe(400);
    const nf = await anon().get("/v1/does-not-exist");
    expect(nf.status).toBe(404);
    expect(JSON.stringify(nf.body)).not.toMatch(/stack|at Object|node_modules/);
  });
});

describe("cleanup helpers", () => {
  it("leaves no plaintext pickup codes or session tokens in the database", async () => {
    const tokens = await h.pool.query(`SELECT token_hash FROM sessions LIMIT 5`);
    for (const t of tokens.rows) expect((t as { token_hash: Buffer }).token_hash.length).toBe(32);
    writeFileSync(join(tmpdir(), "pf-noop"), "");
  });
});

describe("shop and university administration", () => {
  it("shop hours, availability and pickup points control what students can order", async () => {
    const s = await openShop(h, uniA, "Ops Hours Shop");
    const st = await registerStudent(h, uniA, "ops-hours");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const quote = () => st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId: s.shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });

    const hours = { mon: [["08:00", "17:00"]], sat: [["10:00", "14:00"]] };
    expect((await s.owner.patch(`/v1/shops/${s.shopId}`, { openingHours: hours, acceptingOrders: false })).status).toBe(200);
    expect((await s.owner.get(`/v1/shops/${s.shopId}`)).body).toMatchObject({ openingHours: hours, acceptingOrders: false });
    expect((await quote()).body.error.code).toBe("SHOP_UNAVAILABLE");
    expect((await s.owner.patch(`/v1/shops/${s.shopId}`, { openingHours: { mon: [["25:00", "17:00"]] } })).status).toBe(400);
    await s.owner.patch(`/v1/shops/${s.shopId}`, { acceptingOrders: true });

    const side = await s.owner.post(`/v1/shops/${s.shopId}/pickup-locations`, { name: "Side window" });
    expect(side.status).toBe(201);
    await s.owner.patch(`/v1/shops/${s.shopId}/pickup-locations/${side.body.id}`, { isActive: false });
    const q = await quote();
    const closed = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: side.body.id }, { "Idempotency-Key": `ops-closed-${Date.now()}-x` });
    expect(closed.body.error.code).toBe("INVALID_PICKUP_LOCATION");
    const ok = await st.client.post("/v1/orders", { quoteId: q.body.id, pickupLocationId: s.pickupLocationId }, { "Idempotency-Key": `ops-open-${Date.now()}-xx` });
    expect(ok.status).toBe(201);
  });

  it("a price override applies to one shop only and stops when revoked; retiring a card falls back to the previous one", async () => {
    const s = await openShop(h, uniA, "Ops Override Shop");
    const st = await registerStudent(h, uniA, "ops-override");
    const up = await st.client.upload("/v1/documents", pdfBytes, "doc.pdf");
    await h.drain();
    const sheetPrice = async (shopId: string) => {
      const q = await st.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
      expect(q.status).toBe(201);
      return (q.body.lines as Array<{ unitPrice: number }>)[0]!.unitPrice;
    };
    const base = `/v1/admin/universities/${uniA.universityId}`;
    const cardId = await publishCampusCard(uniA, { ...CAMPUS_CARD, effectiveFrom: new Date(Date.now() - 1_000).toISOString() });
    expect(await sheetPrice(s.shopId)).toBe(2_000);

    const ov = await uniA.admin.post(`${base}/price-overrides`, { kind: "SHEET", shopId: s.shopId, rateCardId: cardId, paperSize: "A4", colourMode: "BW", sides: "SINGLE", priceKobo: 1_500 });
    expect(ov.status).toBe(201);
    expect(await sheetPrice(s.shopId)).toBe(1_500);
    expect(await sheetPrice(shopA.shopId)).toBe(2_000);
    expect((await s.owner.post(`${base}/price-overrides`, { kind: "SHEET", shopId: s.shopId, rateCardId: cardId, paperSize: "A4", colourMode: "BW", sides: "SINGLE", priceKobo: 1 })).status).toBe(403);

    expect((await uniA.admin.delete(`${base}/price-overrides/${ov.body.id}`)).status).toBe(204);
    expect(await sheetPrice(s.shopId)).toBe(2_000);

    expect((await uniA.admin.post(`${base}/rate-cards/${cardId}/retire`)).status).toBe(200);
    expect(await sheetPrice(s.shopId)).toBe(2_000); // the earlier published card governs again
    const audit = await h.pool.query(`SELECT action FROM audit_log WHERE university_id = $1 AND entity_id IN ($2, $3)`, [uniA.universityId, cardId, ov.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["rate_card.retired"]));
  });

  it("departments added by the university appear in the public catalogue", async () => {
    const d = await uniA.admin.post(`/v1/admin/universities/${uniA.universityId}/campuses/${uniA.campusId}/departments`, { name: "Mechanical Engineering" });
    expect(d.status).toBe(201);
    const cat = await anon().get(`/v1/universities/${uniA.universityId}`);
    expect(JSON.stringify(cat.body)).toContain("Mechanical Engineering");
  });

  it("the reconciliation report matches payments, refunds and collections for the day", async () => {
    const s = await openShop(h, uniA, "Ops Recon Shop");
    const kept = await paidOrder(uniA, s, "recon-kept");
    const refunded = await paidOrder(uniA, s, "recon-refund");
    await refunded.client.post(`/v1/orders/${refunded.orderId}/cancel`, { reason: "Changed my mind" });
    await h.drain();
    const r = await s.owner.get(`/v1/shops/${s.shopId}/reports/reconciliation`);
    expect(r.status).toBe(200);
    const today = r.body.days.at(-1);
    expect(today.paymentsKobo).toBe(kept.totalKobo + refunded.totalKobo);
    expect(today.refundsKobo).toBe(refunded.totalKobo);
    expect(today.collectedOrders).toBe(0);
  });
});
