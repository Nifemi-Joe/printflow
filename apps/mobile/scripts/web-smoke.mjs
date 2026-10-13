/**
 * Smoke test of the operator and student mobile screens, run against the
 * react-native-web export at a phone viewport. It drives a real API + worker
 * (TEST payment provider) — see docs/TESTING.md.
 *
 *   EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo export --platform web --output-dir dist-web
 *   (serve dist-web on :8081 with SPA fallback; API CORS_ORIGINS must include it)
 *   node apps/mobile/scripts/web-smoke.mjs
 *
 * Needs the demo seed (DEMO_PASSWORD) and an operator without MFA enrolled
 * (the script enrols it, exactly as a new operator would).
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const req = createRequire(join(root, "apps/web/package.json"));
const { chromium } = req("@playwright/test");
const { PDFDocument, StandardFonts } = createRequire(join(root, "packages/documents/package.json"))("pdf-lib");

const API = process.env.API ?? "http://localhost:4000";
const APP = process.env.APP ?? "http://localhost:8081";
const PASSWORD = process.env.DEMO_PASSWORD;
const OUT = join(root, "docs/qa/screenshots/mobile");
if (!PASSWORD) throw new Error("set DEMO_PASSWORD");
mkdirSync(OUT, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function call(token, path, init = {}) {
  const res = await fetch(`${API}/v1${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body && !init.raw ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.raw ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

function totp(secretB32, offset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretB32.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function paidOrder() {
  const login = await fetch(`${API}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "student@demo.printflow.test", password: PASSWORD, client: "mobile" }),
  }).then((r) => r.json());
  const t = login.sessionToken;
  const me = await call(t, "/auth/me");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([595.28, 841.89]).drawText(`Mobile smoke page ${i}`, { x: 72, y: 760, size: 18, font });
  const pdf = Buffer.from(await doc.save());
  const up = await call(t, "/documents", { method: "POST", raw: pdf, headers: { "content-type": "application/pdf", "x-filename": "mobile-smoke.pdf", "x-title": "Mobile smoke notes" } });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const d = await call(t, `/documents/${up.assetId}`);
    ready = d.versions[0].status === "READY";
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  assert(ready, "worker prepared the uploaded PDF");
  const shops = await call(t, `/universities/${me.student.universityId}/shops`);
  const shop = shops.items.find((s) => s.acceptingOrders);
  const quote = await call(t, "/quotes", { method: "POST", body: { documentVersionId: up.versionId, shopId: shop.id, spec: { copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE", finishingCodes: [] } } });
  const order = await call(t, "/orders", { method: "POST", body: { quoteId: quote.id, pickupLocationId: shop.pickupLocations[0].id }, headers: { "idempotency-key": `smoke-${Date.now()}-abcdefgh` } });
  const pay = await call(t, `/orders/${order.id}/payments`, { method: "POST" });
  const reference = pay.checkoutUrl.split("/").pop();
  await call(t, `/test-payments/${reference}/complete`, { method: "POST", body: { outcome: "success" } });
  let status = "";
  for (let i = 0; i < 20 && status !== "PAID"; i++) {
    status = (await call(t, `/orders/${order.id}`)).status;
    if (status !== "PAID") await new Promise((r) => setTimeout(r, 500));
  }
  assert(status === "PAID", "simulated payment moved the order to PAID");
  return { token: t, order: { ...order, reference: (await call(t, `/orders/${order.id}`)).reference } };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
const consoleErrors = [];
async function phone() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const noOverflow = async (page, what) => assert((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${what}: no horizontal overflow`);

// TOTP secrets for demo staff, shared with the web E2E helpers so codes are never replayed.
const MFA_FILE = "/tmp/pf-e2e-mfa.json";
const mfaState = () => (existsSync(MFA_FILE) ? JSON.parse(readFileSync(MFA_FILE, "utf8")) : {});
async function freshCode(email) {
  const st = mfaState()[email];
  // Wait for a time step newer than the last one used for this account.
  while (Math.floor(Date.now() / 30_000) <= (st.lastStep ?? 0)) await new Promise((r) => setTimeout(r, 1000));
  const s = mfaState();
  s[email] = { ...s[email], lastStep: Math.floor(Date.now() / 30_000) };
  writeFileSync(MFA_FILE, JSON.stringify(s));
  return totp(st.secret);
}

async function signIn(page, email, { staff = false } = {}) {
  await page.goto(`${APP}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (!staff) return;
  const codeField = page.getByLabel("Code from your authenticator app");
  const setup = page.getByRole("button", { name: "Start setup" });
  await codeField.or(setup).first().waitFor();
  if (await setup.isVisible()) {
    // New staff are sent to MFA enrolment before any shop data loads.
    await setup.click();
    const secret = (await page.getByText(/^([A-Z2-7]{4} ){3,}[A-Z2-7]{1,4}$/).first().textContent()).replace(/\s/g, "");
    await shot(page, "staff-mfa-setup");
    const s = mfaState();
    s[email] = { secret, lastStep: 0 };
    writeFileSync(MFA_FILE, JSON.stringify(s));
    await page.getByLabel("6-digit code").fill(await freshCode(email));
    await page.getByRole("button", { name: "Finish setup" }).click();
    assert(true, `${email} enrolled in MFA on first sign-in`);
  } else {
    await codeField.fill(await freshCode(email));
    await page.getByRole("button", { name: "Sign in" }).click();
  }
}

console.log("Preparing a paid order through the API…");
const { token: studentToken, order } = await paidOrder();

/** Latest SMS code the API "sent" (LOG driver writes it to the API log). */
async function smsCodeFor(e164, after) {
  const file = process.env.E2E_API_LOG ?? "/tmp/pfqa/api.log";
  for (let i = 0; i < 40; i++) {
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").reverse() : [];
    for (const line of lines) {
      try {
        const l = JSON.parse(line);
        const t = typeof l.time === "string" ? Date.parse(l.time) : l.time ?? 0;
        if (l.sms?.to === e164 && t >= after) return /\b(\d{6})\b/.exec(l.sms.text)[1];
      } catch {
        /* not JSON */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no SMS code for ${e164}`);
}

console.log("Student screens");
{
  const page = await phone();
  // Sign in with only a phone number and a texted code (the demo student's phone is confirmed).
  await page.goto(`${APP}/login`);
  await page.getByRole("radio", { name: "Text me a code" }).click();
  await page.getByLabel("Phone number").fill("0803 000 0001");
  const after = Date.now() - 1000;
  await page.getByRole("button", { name: "Text me a sign-in code" }).click();
  await page.getByText(/a code is on its way/).waitFor();
  await shot(page, "student-login-sms");
  await page.getByLabel("6-digit code").fill(await smsCodeFor("+2348030000001", after));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText(order.reference).first().waitFor({ timeout: 20_000 });
  assert(true, "student sees the new order in Orders");
  await noOverflow(page, "student orders");
  await shot(page, "student-orders");
  await page.getByText("Mobile smoke notes").first().click();
  await page.getByText(/(Number \d+|Next) in the queue/).first().waitFor();
  assert(true, "order detail shows the queue position");
  await shot(page, "student-order-detail");
  await page.goBack();
  await page.getByText("Documents", { exact: true }).last().click();
  await page.getByText("Ready to print").first().waitFor();
  await noOverflow(page, "student documents");
  await shot(page, "student-documents");

  // Print: shops show their power, and the price offers card, bank transfer and USSD.
  await page.getByText("Print", { exact: true }).last().click();
  await page.getByRole("radio", { name: /Mobile smoke notes/ }).first().click();
  await page.getByRole("radio", { name: /Faculty Print Hub/ }).first().click();
  await page.getByText(/^(Light on|Generator on|Light out)/).first().waitFor();
  assert(true, "student sees the shop's power status");
  await page.getByRole("button", { name: "Get exact price" }).click();
  await page.getByRole("radio", { name: /Bank transfer/ }).waitFor();
  await page.getByRole("radio", { name: /Bank transfer/ }).click();
  assert((await page.getByRole("radio", { name: /USSD/ }).count()) === 1, "price offers card, bank transfer and USSD");
  await noOverflow(page, "student pay with");
  await shot(page, "student-pay-with");
  await page.context().close();
}

console.log("Operator screens (MFA + permissions)");
{
  const page = await phone();
  await signIn(page, "operator@demo.printflow.test", { staff: true });
  await page.getByText(order.reference).first().waitFor({ timeout: 20_000 });
  assert(true, "operator reaches the queue after MFA and sees the paid order");
  assert((await page.getByRole("button", { name: "Accept" }).count()) === 0, "operator without orders.accept gets no Accept button");
  await page.getByText("Waiting for a manager to accept this job.").first().waitFor();
  await noOverflow(page, "operator queue");
  await shot(page, "operator-queue");
  await page.getByText("Printers", { exact: true }).last().click();
  await page.getByText(/doesn't read printer status automatically/).waitFor();
  // Operators report power cuts: light out, back in two hours.
  await page.getByLabel("Note for students (optional)").fill("Generator being repaired");
  await page.getByRole("button", { name: "Light out" }).click();
  await page.getByRole("button", { name: "In 2 hours" }).click();
  await page.getByText(/Light out, back about/).first().waitFor();
  assert(true, "operator reports a power cut with an expected return time");
  await noOverflow(page, "operator printers");
  await shot(page, "operator-power");
  await page.getByRole("button", { name: "Light on" }).click();
  await page.getByText(/^Light on$/).first().waitFor();
  assert(true, "operator reports power back");
  await page.context().close();
}

console.log("Shop owner: production, offline drafts, QA and collection");
{
  const page = await phone();
  await signIn(page, "shop@demo.printflow.test", { staff: true });
  await page.getByText(order.reference).first().waitFor({ timeout: 20_000 });
  const card = page.getByTestId(`queue-${order.reference}`);
  await card.getByRole("button", { name: "Accept" }).click();
  await card.getByRole("button", { name: "Start printing" }).waitFor();
  assert(true, "Accept applied online");

  // Offline: the action becomes a draft and is clearly labelled as not sent.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.getByText(/You are offline/).waitFor({ timeout: 10_000 });
  await card.getByRole("button", { name: "Start printing" }).click();
  await page.getByText(new RegExp(`${order.reference}: Accepted to Printing`)).waitFor();
  await page.getByText(/change(s)? not sent yet/).waitFor();
  await page.getByText(/Draft, not sent: Printing/).waitFor();
  assert(true, "offline action is stored as an unsent draft");
  await shot(page, "shop-offline-draft");
  let serverStatus = (await call(studentToken, `/orders/${order.id}`)).status;
  assert(serverStatus === "ACCEPTED", "server state unchanged while the draft is unsent");

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  try {
    await page.getByText(/\d+ changes? saved/).waitFor({ timeout: 20_000 });
  } catch (e) {
    await shot(page, "debug-reconnect");
    console.log(await page.evaluate(() => document.body.innerText.slice(0, 600)));
    throw e;
  }
  serverStatus = (await call(studentToken, `/orders/${order.id}`)).status;
  assert(serverStatus === "PRINTING", "draft reconciled through /sync on reconnect");
  await shot(page, "shop-synced");

  await card.getByRole("button", { name: "Printed, check it" }).click();
  await card.getByRole("button", { name: "Passed, ready to collect" }).click();
  await page.getByTestId(`ready-${order.reference}`).getByRole("button", { name: "Collect with code" }).waitFor();
  assert(true, "QA pass moves the job to waiting for collection");

  const code = await call(studentToken, `/orders/${order.id}/pickup-code`, { method: "POST" });
  await page.getByTestId(`ready-${order.reference}`).getByRole("button", { name: "Collect with code" }).click();
  await page.getByLabel("Pickup code").fill(code.code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Hand over order" }).click();
  await page.getByRole("alert").or(page.getByText(/code/i).filter({ hasText: /incorrect|wrong|invalid|not valid/i })).first().waitFor();
  assert(true, "wrong pickup code is refused");
  await shot(page, "shop-collect-wrong-code");
  await page.getByLabel("Pickup code").fill(code.code);
  await page.getByRole("button", { name: "Hand over order" }).click();
  await page.getByText(/handed to/).waitFor();
  serverStatus = (await call(studentToken, `/orders/${order.id}`)).status;
  assert(serverStatus === "COLLECTED", "correct pickup code collects the order");
  await shot(page, "shop-collected");

  await page.context().close();
}

await browser.close();
// 4xx responses are asserted on above; ERR_INTERNET_DISCONNECTED is the deliberate offline phase.
const relevant = consoleErrors.filter((e) => !/Failed to load resource: (the server responded with a status of 4\d\d|net::ERR_INTERNET_DISCONNECTED)/.test(e));
if (relevant.length) console.log("Console errors:\n" + relevant.join("\n"));
assert(relevant.length === 0, "no unexpected console errors");
console.log(`Screenshots in ${OUT}`);
