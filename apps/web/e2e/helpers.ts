import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo-Password-2026";
export const SHOTS = process.env.SHOTS_DIR ?? "../../docs/qa/screenshots";

/** Collects console errors and failed requests so every test can assert there were none. */
export function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    // Navigations away from a page abort its in-flight polling; that is not a failure.
    if (!/ERR_ABORTED/.test(f)) problems.push(`requestfailed: ${r.method()} ${r.url()} ${f}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`http ${r.status()}: ${r.url()}`);
  });
  return problems;
}

export async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`)).toEqual([]);
}

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.locator("input#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

function b32decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/\s/g, "")) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, offset = 0): string {
  const counter = Math.floor(Date.now() / 30_000) + offset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", b32decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1]! & 0xf;
  return (((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!).toString().slice(-6).padStart(6, "0");
}

// Persisted across Playwright workers/projects: each account enrols only once.
const STATE = join(tmpdir(), "pf-e2e-mfa.json");
type MfaState = Record<string, { secret: string; lastStep: number }>;
const load = (): MfaState => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as MfaState) : {});
const save = (s: MfaState) => writeFileSync(STATE, JSON.stringify(s));

/** Completes staff MFA: enrols on first use, then verifies with a fresh code. */
export async function passMfa(page: Page, email: string) {
  // Enrolled staff are asked for the code on the sign-in form; others go to /mfa.
  const inline = page.getByLabel("Code from your authenticator app");
  await Promise.race([page.waitForURL(/\/mfa|\/shop\/|\/admin\/|\/platform/), inline.waitFor({ state: "visible" })]);
  if (await inline.isVisible().catch(() => false)) {
    const st = load();
    const entry = st[email];
    if (!entry) throw new Error(`no TOTP secret known for ${email}`);
    if (entry.lastStep >= Math.floor(Date.now() / 30_000)) await page.waitForTimeout((30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000);
    entry.lastStep = Math.floor(Date.now() / 30_000);
    save(st);
    await inline.fill(totp(entry.secret));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    return;
  }
  if (!page.url().includes("/mfa")) return;
  const start = page.getByRole("button", { name: "Start setup" });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    const key = (await page.locator(".ticket").first().innerText()).replace(/\s/g, "");
    const st = load();
    st[email] = { secret: key, lastStep: -1 };
    save(st);
  }
  const st = load();
  const entry = st[email];
  if (!entry) throw new Error(`no TOTP secret known for ${email}; delete ${STATE} and reset MFA for this account`);
  // Codes are single-use: wait for a step this account has not used yet.
  if (entry.lastStep >= Math.floor(Date.now() / 30_000)) await page.waitForTimeout((30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000);
  const secret = entry.secret;
  entry.lastStep = Math.floor(Date.now() / 30_000);
  save(st);
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: /Verify|Finish setup/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/mfa"));
}


/**
 * The latest SMS code the API "sent" to a number. In development the API uses the
 * LOG SMS driver, which writes messages to its log; E2E_API_LOG points at that file.
 */
export async function smsCode(phoneE164: string, after = 0): Promise<string> {
  const file = process.env.E2E_API_LOG ?? "/tmp/pfqa/api.log";
  for (let i = 0; i < 40; i++) {
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const l = JSON.parse(lines[j]!) as { time?: number | string; sms?: { to: string; text: string } };
        const t = typeof l.time === "string" ? Date.parse(l.time) : (l.time ?? 0);
        if (l.sms?.to === phoneE164 && t >= after) {
          const m = /\b(\d{6})\b/.exec(l.sms.text);
          if (m) return m[1]!;
        }
      } catch {
        /* not JSON */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no SMS code found for ${phoneE164} in ${file}`);
}

/** A small, valid 2-page PDF built by hand (no extra tooling needed). */
export function twoPagePdf(): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Length 52 >>\nstream\nBT /F1 24 Tf 72 760 Td (PrintFlow browser test 1) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Length 52 >>\nstream\nBT /F1 24 Tf 72 760 Td (PrintFlow browser test 2) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const dir = mkdtempSync(join(tmpdir(), "pf-e2e-"));
  const p = join(dir, `Browser test notes ${Date.now()}.pdf`);
  writeFileSync(p, pdf);
  return p;
}

