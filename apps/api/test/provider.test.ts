import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePdf } from "../../../packages/documents/test/fixtures.js";
import { reverifyProviders } from "../../worker/src/handlers.js";
import { Client, createUser, onboardUniversity, openShop, publishCampusCard, registerStudent, startHarness, type Campus, type Harness, type ShopSetup } from "./harness.js";

let h: Harness;
let uni: Campus;
let other: Campus;
let business: ShopSetup;
let pdf: Buffer;

const DOMAIN = "students.wp-uni.test";

beforeAll(async () => {
  h = await startHarness({ STUDENT_ROLL_PEPPER: "roll-pepper-for-tests-0123456789abcdef" }, "printflow_provider_test");
  const p = await createUser(h, "pv-platform", { platformRole: "PLATFORM_ADMIN" });
  const platform = await Client.login(h, p.email);
  uni = await onboardUniversity(h, platform, "pv-uni");
  other = await onboardUniversity(h, platform, "pv-other");
  await publishCampusCard(uni);
  business = await openShop(h, uni, "Faculty Business Printers");
  const dir = mkdtempSync(join(tmpdir(), "pf-pv-"));
  await makePdf(join(dir, "a.pdf"), 1);
  pdf = readFileSync(join(dir, "a.pdf"));
}, 120_000);
afterAll(async () => {
  await h.close();
});

const settings = (body: object) => uni.admin.patch(`/v1/admin/universities/${uni.universityId}/settings`, body);

/** A student with a printer: applies, is approved to trade, and opens. */
async function studentProvider(label: string, opts: { undertaking?: boolean; open?: boolean } = {}) {
  const user = await createUser(h, label);
  const owner = await Client.login(h, user.email);
  const applied = await owner.post("/v1/shops", { universityId: uni.universityId, campusId: uni.campusId, name: `${label} Hostel Printing`, kind: "STUDENT_RUN" });
  if (applied.status !== 201) throw new Error(JSON.stringify(applied.body));
  const shopId = applied.body.id as string;
  await uni.admin.post(`/v1/admin/universities/${uni.universityId}/shops/${shopId}/status`, { action: "approve", reason: "Student provider pilot" });
  if (opts.undertaking !== false) await owner.post(`/v1/shops/${shopId}/verification/undertaking`, { version: 1, agree: true });
  const pl = await owner.post(`/v1/shops/${shopId}/pickup-locations`, { name: "Room 14, Block C" });
  const dev = await owner.post(`/v1/shops/${shopId}/devices`, { label: "HP DeskJet" });
  await owner.patch(`/v1/shops/${shopId}/devices/${dev.body.id}`, { reportedStatus: "AVAILABLE" });
  if (opts.open !== false) {
    const open = await owner.patch(`/v1/shops/${shopId}`, { acceptingOrders: true });
    if (open.status !== 200) throw new Error(JSON.stringify(open.body));
  }
  return { user, owner, shopId, pickupLocationId: pl.body.id as string };
}

/** Confirms a university email address for a shop, end to end. */
async function verifyEmail(p: { owner: Client; shopId: string; email: string }) {
  const sent = await p.owner.post(`/v1/shops/${p.shopId}/verification/email`, { email: p.email });
  if (sent.status !== 202) throw new Error(JSON.stringify(sent.body));
  const code = /\b(\d{6})\b/.exec(h.mailer.last(p.email)!.text)![1]!;
  return p.owner.post(`/v1/shops/${p.shopId}/verification/email/confirm`, { code });
}

async function quoteFor(student: Awaited<ReturnType<typeof registerStudent>>, shopId: string, copies = 1) {
  const up = await student.client.upload("/v1/documents", pdf, "doc.pdf");
  await h.drain();
  const q = await student.client.post("/v1/quotes", { documentVersionId: up.body.versionId, shopId, spec: { copies, paperSize: "A4", colourMode: "BW", sides: "SINGLE" } });
  if (q.status !== 201) throw new Error(JSON.stringify(q.body));
  return q.body;
}

const order = (student: Awaited<ReturnType<typeof registerStudent>>, quoteId: string, pickupLocationId: string, body: object = {}) =>
  student.client.post("/v1/orders", { quoteId, pickupLocationId, ...body }, { "Idempotency-Key": `pv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });

const levelOf = async (shopId: string) => (await h.pool.query<{ l: string }>(`SELECT verification_level AS l FROM shops WHERE id = $1`, [shopId])).rows[0]!.l;

describe("student-run providers: getting on", () => {
  it("are refused until the university takes them", async () => {
    const user = await createUser(h, "pv-early");
    const owner = await Client.login(h, user.email);
    const r = await owner.post("/v1/shops", { universityId: uni.universityId, campusId: uni.campusId, name: "Too Early Printing", kind: "STUDENT_RUN" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/does not take student-run print shops/);
    // A registered business is unaffected.
    expect((await owner.post("/v1/shops", { universityId: uni.universityId, campusId: uni.campusId, name: "Early Business Printing" })).status).toBe(201);
  });

  it("the university opens the scheme with its own domains, matric format and cap", async () => {
    const r = await settings({
      studentProvidersAllowed: true,
      studentEmailDomains: [DOMAIN],
      matricPattern: "^[0-9]{2}/[0-9]{6}$",
      studentProviderCapKobo: 150_000,
      providerReverifyDays: 180,
    });
    expect(r.status).toBe(200);
    expect(r.body.university).toMatchObject({ studentProvidersAllowed: true, studentEmailDomains: [DOMAIN], matricPattern: "^[0-9]{2}/[0-9]{6}$", studentProviderCapKobo: 150_000 });
    expect((await settings({ studentEmailDomains: ["not a domain"] })).status).toBe(400);
  });

  it("cannot take a single order until the owner accepts the confidentiality undertaking", async () => {
    const p = await studentProvider("pv-undertaking", { undertaking: false, open: false });
    const refused = await p.owner.patch(`/v1/shops/${p.shopId}`, { acceptingOrders: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/confidentiality undertaking/);

    const status = await p.owner.get(`/v1/shops/${p.shopId}/verification`);
    expect(status.body.undertaking).toMatchObject({ required: true, accepted: false, version: 1 });
    expect(status.body.undertaking.text).toMatch(/delete every copy/);
    expect(status.body.next[0]).toMatchObject({ step: "UNDERTAKING" });

    expect((await p.owner.post(`/v1/shops/${p.shopId}/verification/undertaking`, { version: 99, agree: true })).status).toBe(409);
    expect((await p.owner.post(`/v1/shops/${p.shopId}/verification/undertaking`, { version: 1, agree: true })).status).toBe(200);
    expect((await p.owner.patch(`/v1/shops/${p.shopId}`, { acceptingOrders: true })).status).toBe(200);

    // What was signed is kept, with the wording's hash so a later edit is provable.
    const signed = await h.pool.query<{ version: number; text_sha256: string }>(`SELECT version, text_sha256 FROM provider_undertakings WHERE shop_id = $1`, [p.shopId]);
    expect(signed.rows[0]!.version).toBe(1);
    expect(signed.rows[0]!.text_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("only the owner can drive verification", async () => {
    const p = await studentProvider("pv-owneronly");
    const staff = await createUser(h, "pv-helper");
    await p.owner.post(`/v1/shops/${p.shopId}/staff`, { email: staff.email, role: "OPERATOR" });
    const helper = await Client.login(h, staff.email);
    expect((await helper.get(`/v1/shops/${p.shopId}/verification`)).status).toBe(403);
    expect((await helper.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "21/123456" })).status).toBe(403);
  });
});

describe("student-run providers: proving who they are", () => {
  it("a university email address raises the level, and only an address on their domain counts", async () => {
    const p = await studentProvider("pv-email");
    expect(await levelOf(p.shopId)).toBe("UNVERIFIED");

    const wrong = await p.owner.post(`/v1/shops/${p.shopId}/verification/email`, { email: "someone@gmail.com" });
    expect(wrong.body.error.code).toBe("EMAIL_DOMAIN");
    // A lookalike domain that merely ends with the real one is not the real one.
    expect((await p.owner.post(`/v1/shops/${p.shopId}/verification/email`, { email: `me@evil-${DOMAIN}` })).body.error.code).toBe("EMAIL_DOMAIN");

    const email = `ada.okonkwo@${DOMAIN}`;
    const sent = await p.owner.post(`/v1/shops/${p.shopId}/verification/email`, { email });
    expect(sent.status).toBe(202);
    // The code is emailed, never returned.
    expect(JSON.stringify(sent.body)).not.toMatch(/\d{6}/);

    const wrongCode = await p.owner.post(`/v1/shops/${p.shopId}/verification/email/confirm`, { code: "000000" });
    expect(["CODE_INVALID", "CODE_LOCKED"]).toContain(wrongCode.body.error.code);
    expect(await levelOf(p.shopId)).toBe("UNVERIFIED");

    const code = /\b(\d{6})\b/.exec(h.mailer.last(email)!.text)![1]!;
    const ok = await p.owner.post(`/v1/shops/${p.shopId}/verification/email/confirm`, { code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ verified: true, level: "EMAIL_VERIFIED" });
    expect(ok.body.badge.label).toBe("Student email only");
    expect(await levelOf(p.shopId)).toBe("EMAIL_VERIFIED");

    // The same code cannot be used twice.
    expect((await p.owner.post(`/v1/shops/${p.shopId}/verification/email/confirm`, { code })).status).toBe(422);
  });

  it("one university address cannot stand for two shops", async () => {
    const email = `shared.${Date.now()}@${DOMAIN}`;
    const first = await studentProvider("pv-share-a");
    expect((await verifyEmail({ owner: first.owner, shopId: first.shopId, email })).status).toBe(200);
    const second = await studentProvider("pv-share-b");
    const r = await second.owner.post(`/v1/shops/${second.shopId}/verification/email`, { email });
    expect(r.body.error.code).toBe("EMAIL_IN_USE");
  });

  it("a matric number is format-checked, then goes to the university when there is no roll", async () => {
    const p = await studentProvider("pv-matric");
    const bad = await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "ABC-1" });
    expect(bad.body.error.code).toBe("MATRIC_FORMAT");

    const sent = await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: " 21/123456 " });
    expect(sent.body).toMatchObject({ outcome: "PENDING_REVIEW", matricNumber: "21/123456", level: "UNVERIFIED" });

    // It shows up in the university's queue.
    const queue = await uni.admin.get(`/v1/admin/universities/${uni.universityId}/providers?waiting=true`);
    expect(queue.body.items.find((i: { id: string }) => i.id === p.shopId)).toMatchObject({ waitingChecks: 1, kind: "STUDENT_RUN" });

    const decided = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/decide`, {
      check: "MATRIC_NUMBER",
      decision: "PASS",
      confirmedWith: "STUDENT_RECORDS",
      note: "Found in the 2021 intake register",
    });
    expect(decided.status).toBe(200);
    expect(decided.body.level).toBe("MATRIC_VERIFIED");
    expect(decided.body.badge.label).toBe("Verified student");
    const check = decided.body.checks.find((c: { kind: string }) => c.kind === "MATRIC_NUMBER");
    expect(check).toMatchObject({ status: "PASSED", subject: "21/123456", decidedByName: expect.any(String) });
    expect(check.expiresAt).toBeTruthy();
  });

  it("a rejected matric number leaves the shop where it was, with the reason recorded", async () => {
    const p = await studentProvider("pv-rejected");
    await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "21/999999" });
    const r = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/decide`, {
      check: "MATRIC_NUMBER",
      decision: "REJECT",
      note: "No such number in our records",
    });
    expect(r.body.level).toBe("UNVERIFIED");
    expect(r.body.checks[0]).toMatchObject({ status: "FAILED", note: "No such number in our records" });
  });

  it("with a roll uploaded, a matching matric number verifies itself and a wrong surname does not", async () => {
    const p = await studentProvider("pv-roll");
    const me = await h.pool.query<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [p.user.id]);
    const surname = me.rows[0]!.full_name.split(" ").pop()!;

    const upload = await uni.admin.put(`/v1/admin/universities/${uni.universityId}/providers/roll`, {
      rows: [
        { matricNumber: "21/400001", surname },
        { matricNumber: "21/400002", surname: "Someoneelse" },
      ],
    });
    expect(upload.body).toMatchObject({ stored: 2 });
    // Names are not kept, only the matric number and a keyed hash.
    const stored = await h.pool.query<{ matric_number: string; surname_hash: string }>(`SELECT matric_number, surname_hash FROM university_student_roll WHERE university_id = $1 ORDER BY matric_number`, [uni.universityId]);
    expect(stored.rows.map((r) => r.matric_number)).toEqual(["21/400001", "21/400002"]);
    expect(stored.rows[0]!.surname_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored.rows)).not.toContain(surname);

    const mine = await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "21/400001" });
    expect(mine.body).toMatchObject({ outcome: "VERIFIED", level: "MATRIC_VERIFIED" });

    // Someone else's number with my surname goes to a person instead of passing.
    const q = await studentProvider("pv-roll-2");
    const theirs = await q.owner.post(`/v1/shops/${q.shopId}/verification/matric`, { matricNumber: "21/400002" });
    expect(theirs.body.outcome).toBe("PENDING_REVIEW");
    expect(await levelOf(q.shopId)).toBe("UNVERIFIED");
    // A number that is not on the roll at all also goes to a person.
    const r = await studentProvider("pv-roll-3");
    expect((await r.owner.post(`/v1/shops/${r.shopId}/verification/matric`, { matricNumber: "21/400009" })).body.outcome).toBe("PENDING_REVIEW");
  });

  it("a verified matric number cannot be claimed by a second shop", async () => {
    const p = await studentProvider("pv-dup-matric");
    await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "21/555001" });
    await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/decide`, { check: "MATRIC_NUMBER", decision: "PASS", note: "Confirmed with the faculty office" });
    const q = await studentProvider("pv-dup-matric-2");
    expect((await q.owner.post(`/v1/shops/${q.shopId}/verification/matric`, { matricNumber: "21/555001" })).body.error.code).toBe("MATRIC_IN_USE");
  });

  it("a shop's level cannot be written directly, only earned through checks", async () => {
    const p = await studentProvider("pv-nocheat");
    await expect(h.pool.query(`UPDATE shops SET verification_level = 'UNIVERSITY_APPROVED' WHERE id = $1`, [p.shopId])).rejects.toThrow(/follows its checks/);
    await expect(h.pool.query(`UPDATE shops SET kind = 'BUSINESS' WHERE id = $1`, [p.shopId])).rejects.toThrow(/kind is fixed/);
  });

  it("another university's staff can neither see nor decide these providers", async () => {
    const p = await studentProvider("pv-tenant");
    expect((await other.admin.get(`/v1/admin/universities/${uni.universityId}/providers`)).status).toBe(403);
    expect((await other.admin.get(`/v1/admin/universities/${other.universityId}/providers/${p.shopId}`)).status).toBe(404);
    expect((await other.admin.post(`/v1/admin/universities/${other.universityId}/providers/${p.shopId}/decide`, { check: "MATRIC_NUMBER", decision: "PASS", note: "Not mine to approve" })).status).toBe(404);
  });
});

describe("what students see and can do", () => {
  it("an unverified provider is held back from the list until the student asks, and is labelled when shown", async () => {
    const p = await studentProvider("pv-listing");
    const st = await registerStudent(h, uni, "pv-looker");

    const plain = await st.client.get(`/v1/universities/${uni.universityId}/shops`);
    expect(plain.body.items.find((s: { id: string }) => s.id === p.shopId)).toBeUndefined();
    expect(plain.body.hiddenUnverified).toBeGreaterThan(0);
    // The approved business is listed, and says so.
    expect(plain.body.items.find((s: { id: string }) => s.id === business.shopId).trust).toMatchObject({ kind: "BUSINESS", level: "UNIVERSITY_APPROVED" });

    const all = await st.client.get(`/v1/universities/${uni.universityId}/shops?includeUnverified=true`);
    const shown = all.body.items.find((s: { id: string }) => s.id === p.shopId);
    expect(shown.trust).toMatchObject({ kind: "STUDENT_RUN", level: "UNVERIFIED" });
    expect(shown.trust.badge).toMatchObject({ label: "Not verified", tone: "warn" });
    expect(shown.trust.badge.detail).toMatch(/Avoid sending anything private/);
    expect(shown.trust.limits).toMatchObject({ needsAcknowledgement: true, orderCapKobo: 150_000, listedByDefault: false });

    // Confirming a university email is enough to be offered, with a softer badge.
    await verifyEmail({ owner: p.owner, shopId: p.shopId, email: `listed.${Date.now()}@${DOMAIN}` });
    const after = await st.client.get(`/v1/universities/${uni.universityId}/shops`);
    expect(after.body.items.find((s: { id: string }) => s.id === p.shopId).trust.badge).toMatchObject({ label: "Student email only", tone: "caution" });
  });

  it("ordering from an unproven provider needs the student to say yes, and is capped", async () => {
    const p = await studentProvider("pv-ordering");
    await verifyEmail({ owner: p.owner, shopId: p.shopId, email: `ordering.${Date.now()}@${DOMAIN}` });
    const st = await registerStudent(h, uni, "pv-orderer");

    const q = await quoteFor(st, p.shopId);
    expect(q.provider).toMatchObject({ kind: "STUDENT_RUN", level: "EMAIL_VERIFIED", needsAcknowledgement: true, orderCapKobo: 150_000 });

    const silent = await order(st, q.id, p.pickupLocationId);
    expect(silent.status).toBe(422);
    expect(silent.body.error.code).toBe("PROVIDER_NOT_VERIFIED");

    const agreed = await order(st, q.id, p.pickupLocationId, { acknowledgeUnverifiedProvider: true });
    expect(agreed.status).toBe(201);
    const detail = await st.client.get(`/v1/orders/${agreed.body.id}`);
    expect(detail.body.provider).toMatchObject({ level: "EMAIL_VERIFIED", needsAcknowledgement: true });
    expect(detail.body.provider.acknowledgedAt).toBeTruthy();

    // A job worth more than the cap belongs at a verified shop.
    const big = await quoteFor(st, p.shopId, 100);
    expect(Number(big.totalKobo)).toBeGreaterThan(150_000);
    const refused = await order(st, big.id, p.pickupLocationId, { acknowledgeUnverifiedProvider: true });
    expect(refused.body.error.code).toBe("PROVIDER_ORDER_CAP");
    // The same job is fine at the approved business.
    const atBusiness = await quoteFor(st, business.shopId, 100);
    expect((await order(st, atBusiness.id, business.pickupLocationId)).status).toBe(201);
  });

  it("the database refuses an unacknowledged or oversized order even if the API is bypassed", async () => {
    const p = await studentProvider("pv-dbguard");
    const st = await registerStudent(h, uni, "pv-dbguard-student");
    const q = await quoteFor(st, p.shopId);
    const insert = (ack: boolean, totalKobo: number) =>
      h.pool.query(
        `INSERT INTO orders (reference, university_id, shop_id, student_user_id, pickup_location_id, quote_id, document_version_id, spec_hash, total_kobo, payment_due_at, unverified_ack_at)
         SELECT 'PF-' || upper(substr(md5(random()::text), 1, 8)), $1::uuid, $2::uuid, $3::uuid, $4::uuid, q.id, q.document_version_id, q.spec_hash,
                $5::bigint, now() + interval '30 minutes', CASE WHEN $6::boolean THEN now() END
           FROM quotes q WHERE q.id = $7::uuid`,
        [uni.universityId, p.shopId, st.userId, p.pickupLocationId, String(totalKobo), ack, q.id],
      );
    await expect(insert(false, Number(q.totalKobo))).rejects.toThrow(/must acknowledge/);
    await expect(insert(true, 150_001)).rejects.toThrow(/limited to 150000 kobo/);
  });

  it("once the matric number is verified the limits fall away", async () => {
    const p = await studentProvider("pv-trusted");
    await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "21/777001" });
    await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/decide`, { check: "MATRIC_NUMBER", decision: "PASS", note: "Checked against the register" });

    const st = await registerStudent(h, uni, "pv-trusting");
    const q = await quoteFor(st, p.shopId, 100);
    expect(q.provider).toMatchObject({ level: "MATRIC_VERIFIED", needsAcknowledgement: false, orderCapKobo: null });
    expect((await order(st, q.id, p.pickupLocationId)).status).toBe(201);
    const listed = await st.client.get(`/v1/universities/${uni.universityId}/shops`);
    expect(listed.body.items.find((s: { id: string }) => s.id === p.shopId).trust.badge.tone).toBe("good");
  });
});

describe("keeping verification honest over time", () => {
  it("withdrawing a check drops the level at once, and the student is asked again", async () => {
    const p = await studentProvider("pv-revoke");
    await p.owner.post(`/v1/shops/${p.shopId}/verification/matric`, { matricNumber: "21/888001" });
    await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/decide`, { check: "MATRIC_NUMBER", decision: "PASS", note: "Confirmed" });
    const st = await registerStudent(h, uni, "pv-revoke-student");
    expect((await quoteFor(st, p.shopId)).provider.needsAcknowledgement).toBe(false);

    const r = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/revoke`, { check: "MATRIC_NUMBER", reason: "Student has left the university" });
    expect(r.body.level).toBe("UNVERIFIED");
    expect((await quoteFor(st, p.shopId)).provider.needsAcknowledgement).toBe(true);
    const audit = await h.pool.query(`SELECT 1 FROM audit_log WHERE action = 'provider.check_revoked' AND entity_id = $1`, [p.shopId]);
    expect(audit.rowCount).toBe(1);
  });

  it("suspending a provider stops it trading and withdraws everything proven about it", async () => {
    const p = await studentProvider("pv-suspend");
    await verifyEmail({ owner: p.owner, shopId: p.shopId, email: `suspend.${Date.now()}@${DOMAIN}` });
    const r = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/revoke`, { suspend: true, reason: "Reported for keeping a copy of a document" });
    expect(r.body).toMatchObject({ level: "UNVERIFIED" });
    const shop = await h.pool.query<{ status: string; accepting_orders: boolean }>(`SELECT status, accepting_orders FROM shops WHERE id = $1`, [p.shopId]);
    expect(shop.rows[0]).toMatchObject({ status: "SUSPENDED", accepting_orders: false });
    const st = await registerStudent(h, uni, "pv-suspend-student");
    expect((await st.client.get(`/v1/universities/${uni.universityId}/shops?includeUnverified=true`)).body.items.find((s: { id: string }) => s.id === p.shopId)).toBeUndefined();
  });

  it("checks lapse on their renewal date, and the owner is told", async () => {
    const p = await studentProvider("pv-renew");
    await verifyEmail({ owner: p.owner, shopId: p.shopId, email: `renew.${Date.now()}@${DOMAIN}` });
    expect(await levelOf(p.shopId)).toBe("EMAIL_VERIFIED");

    await h.pool.query(`UPDATE provider_verifications SET decided_at = now() - interval '200 days', expires_at = now() - interval '1 day' WHERE shop_id = $1 AND status = 'PASSED'`, [p.shopId]);
    const n = await reverifyProviders(h.worker);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await levelOf(p.shopId)).toBe("UNVERIFIED");

    const notice = await h.pool.query<{ title: string }>(`SELECT title FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [p.user.id]);
    expect(notice.rows[0]!.title).toBe("Confirm you are still a student");
    // Running it again changes nothing.
    expect(await reverifyProviders(h.worker)).toBe(0);
  });

  it("an approved business carries the university's own review, and loses it when suspended", async () => {
    const shop = await openShop(h, uni, "Second Business Printers");
    expect(await levelOf(shop.shopId)).toBe("UNIVERSITY_APPROVED");
    const checks = await h.pool.query<{ kind: string; status: string }>(`SELECT kind, status FROM provider_verifications WHERE shop_id = $1`, [shop.shopId]);
    expect(checks.rows).toEqual([{ kind: "UNIVERSITY_REVIEW", status: "PASSED" }]);

    await uni.admin.post(`/v1/admin/universities/${uni.universityId}/shops/${shop.shopId}/status`, { action: "suspend", reason: "Closed for the holidays" });
    expect(await levelOf(shop.shopId)).toBe("UNVERIFIED");
  });

  it("a university admin can vouch for a provider in person, which is recorded as such", async () => {
    const p = await studentProvider("pv-vouch");
    const r = await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${p.shopId}/decide`, {
      check: "UNIVERSITY_REVIEW",
      decision: "PASS",
      subject: "Ada Obi, 21/300100",
      confirmedWith: "ID_CARD_IN_PERSON",
      note: "Student ID card seen at the faculty office",
    });
    expect(r.body.level).toBe("UNIVERSITY_APPROVED");
    expect(r.body.badge.label).toBe("Student, university approved");
    const check = r.body.checks.find((c: { kind: string }) => c.kind === "UNIVERSITY_REVIEW");
    expect(check.evidence).toMatchObject({ method: "ADMIN", confirmedWith: "ID_CARD_IN_PERSON" });
    // Vouching needs a name: it is the strongest claim the product makes about a person.
    const q = await studentProvider("pv-vouch-2");
    expect((await uni.admin.post(`/v1/admin/universities/${uni.universityId}/providers/${q.shopId}/decide`, { check: "UNIVERSITY_REVIEW", decision: "PASS", note: "No name given" })).status).toBe(400);
  });
});
