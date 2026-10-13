import { expect, test, type Page } from "@playwright/test";
import { axe, passMfa, PASSWORD, SHOTS, signIn, smsCode, twoPagePdf, watch } from "./helpers";

/** No horizontal scrolling at this viewport. */
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

function freshPhone() {
  const n = `${Date.now() % 10_000_000}`.padStart(7, "0");
  return { local: `0809${n}`, e164: `+234809${n}` };
}

test("a new student signs up with a phone, confirms it by SMS, and signs in with a code", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "flow runs once; layouts are checked below");
  const problems = watch(page);
  const phone = freshPhone();

  await page.goto("/register");
  await page.getByLabel("Full name").fill("Phone First Student");
  await page.getByLabel("Email").fill(`phone.first.${Date.now()}@example.test`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("University").selectOption({ label: "Demo University (sample data)" });
  await page.getByLabel("Campus").selectOption({ index: 1 });
  await page.getByLabel(/Phone number/).fill(phone.local);
  const sentAfter = Date.now() - 1000;
  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL("**/verify**");
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  // The code was texted at sign-up, so the page goes straight to code entry.
  await expect(page.getByText(/We sent a code to \+234 809/)).toBeVisible();
  const code = await smsCode(phone.e164, sentAfter);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm number" }).click();
  await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/verify-done-desktop.png`, fullPage: true });
  await axe(page, "verify");

  // Sign out, then sign in with only the phone and a texted code.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("radio", { name: "Text me a code" }).check();
  await page.getByLabel("Phone number").fill(phone.local);
  const codeAfter = Date.now() - 1000;
  await page.getByRole("button", { name: "Text me a sign-in code" }).click();
  const signInCode = await smsCode(phone.e164, codeAfter);
  await page.getByLabel("6-digit code").fill(signInCode);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/student/**");
  expect(problems.filter((p) => !/429/.test(p))).toEqual([]);
});

test("the shop reports a power cut, and a student pays by bank transfer", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "flow runs once; layouts are checked below");
  const shopCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const studentCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const shop = await shopCtx.newPage();
  const student = await studentCtx.newPage();
  const hProblems = watch(shop);
  const sProblems = watch(student);

  // --- shop: light out, back in two hours
  await signIn(shop, "shop@demo.printflow.test");
  await passMfa(shop, "shop@demo.printflow.test");
  await shop.waitForURL("**/shop/**");
  const power = shop.locator("section[aria-labelledby='power-title']");
  await power.getByLabel("Note for students").fill("NEPA took light; generator being fixed");
  await power.getByRole("button", { name: "Light out" }).click();
  await power.getByRole("button", { name: "In 2 hours" }).click();
  await expect(power.getByText(/Light out, back about/)).toBeVisible();
  await shop.screenshot({ path: `${SHOTS}/shop-power-outage-desktop.png`, fullPage: true });
  await axe(shop, "shop queue with power");

  // --- student sees it, and pays by bank transfer
  await signIn(student, "student@demo.printflow.test");
  await student.waitForURL("**/student/**");
  await student.goto("/student/documents");
  await student.locator("input[type=file]").setInputFiles(twoPagePdf());
  await expect(student.getByText("Ready to print").first()).toBeVisible({ timeout: 60_000 });
  await student.goto("/student/print");
  await student.getByLabel("Document").selectOption({ index: 1 });
  const shopChoice = student.locator("label.choice", { hasText: "Faculty Print Hub" });
  await expect(shopChoice.getByText(/Light out, back about/)).toBeVisible();
  await expect(shopChoice.getByText("NEPA took light")).toBeVisible();
  await shopChoice.locator("input").check();
  await student.getByRole("button", { name: "Get exact price" }).click();
  await expect(student.getByText(/has reported no power/)).toBeVisible();
  await student.getByRole("radio", { name: /Bank transfer/ }).check();
  await student.screenshot({ path: `${SHOTS}/student-pay-method-desktop.png`, fullPage: true });
  await axe(student, "pay with");
  await student.getByRole("button", { name: /Confirm and pay/ }).click();
  await student.waitForURL("**/checkout/test/**method=BANK_TRANSFER");
  await expect(student.getByText("Account number", { exact: true })).toBeVisible();
  await expect(student.getByText("0000000000")).toBeVisible();
  await student.screenshot({ path: `${SHOTS}/checkout-bank-transfer-desktop.png`, fullPage: true });
  await student.getByRole("button", { name: "Simulate: I've sent the transfer" }).click();
  await student.waitForURL("**/student/orders/**");
  await expect(student.getByText("Paid by Bank transfer")).toBeVisible();

  // --- shop: light back on
  await shop.reload();
  await power.getByRole("button", { name: "Light on" }).click();
  await expect(power.getByText("Light on")).toBeVisible();

  expect(sProblems).toEqual([]);
  expect(hProblems).toEqual([]);
  await shopCtx.close();
  await studentCtx.close();
});

test("new sign-in, reset and offline screens fit this screen and pass axe", async ({ page }, info) => {
  const problems = watch(page);
  const size = info.project.name;
  await page.goto("/login");
  await page.getByRole("radio", { name: "Text me a code" }).check();
  await expect(page.getByLabel("Phone number")).toBeVisible();
  await noOverflow(page);
  await axe(page, "login by code");
  await page.screenshot({ path: `${SHOTS}/login-sms-${size}.png`, fullPage: true });

  await page.goto("/forgot-password");
  await page.getByRole("radio", { name: "By text message" }).check();
  await noOverflow(page);
  await axe(page, "reset by text");
  await page.screenshot({ path: `${SHOTS}/reset-sms-${size}.png`, fullPage: true });

  await page.goto("/offline");
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await noOverflow(page);
  await axe(page, "offline");
  expect(problems).toEqual([]);
});

test("installable: manifest, icons and a service worker that works offline", async ({ page, request }, info) => {
  await page.goto("/");
  const href = await page.locator("link[rel=manifest]").getAttribute("href");
  expect(href).toBeTruthy();
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({ name: "PrintFlow", display: "standalone", start_url: "/dashboard?source=app", theme_color: "#05402d" });
  for (const icon of manifest.icons as Array<{ src: string; sizes: string; purpose: string }>) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"]).toBe("image/png");
  }
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
  expect(await page.locator("link[rel=apple-touch-icon]").count()).toBeGreaterThan(0);

  // The worker installs and takes control.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.goto("/login?next=%2Fstudent%2Forders");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => fetch("/api/v1/health").then((r) => r.status));

  // What it keeps: the offline page and visited page shells (without query strings), never the API.
  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname + new URL(req.url).search);
    return out;
  });
  expect(cached).toContain("/offline");
  expect(cached).toContain("/login");
  expect(cached.some((u) => u.startsWith("/api/"))).toBe(false);
  expect(cached.some((u) => u.includes("?"))).toBe(false);
  await page.screenshot({ path: `${SHOTS}/installable-${info.project.name}.png` });
  // Offline behaviour is unit-tested in apps/web/test/sw.test.ts: Playwright's offline
  // emulation does not apply to requests made by a service worker.
});
