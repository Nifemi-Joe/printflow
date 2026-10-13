import { expect, test } from "@playwright/test";
import { axe, passMfa, SHOTS, signIn, watch } from "./helpers";

/** Visits every dashboard screen for each role, at each viewport size. */
test.describe.configure({ mode: "serial" });

test("student screens", async ({ page }, info) => {
  const problems = watch(page);
  await signIn(page, "student@demo.printflow.test");
  await page.waitForURL("**/student/**");
  for (const [path, heading] of [
    ["/student/documents", "Documents"],
    ["/student/print", "Print something"],
    ["/student/orders", "Orders"],
    ["/student/notifications", "Notifications"],
    ["/account", "Account"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SHOTS}/student${path.replace(/\//g, "-")}-${info.project.name}.png`, fullPage: true });
    await axe(page, path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  expect(problems).toEqual([]);
});

test("shop screens", async ({ page }, info) => {
  const problems = watch(page);
  await signIn(page, "shop@demo.printflow.test");
  await passMfa(page, "shop@demo.printflow.test");
  await page.waitForURL("**/shop/**");
  const base = new URL(page.url()).pathname.split("/").slice(0, 3).join("/");
  for (const [sub, heading] of [
    ["", "Queue"],
    ["/history", "Order history"],
    ["/devices", "Printers"],
    ["/staff", "Staff"],
    ["/pricing", "Prices"],
    ["/reports", "Reports"],
    ["/settings", "Faculty Print Hub (demo)"],
  ] as const) {
    await page.goto(`${base}${sub}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SHOTS}/shop${sub.replace(/\//g, "-") || "-queue"}-${info.project.name}.png`, fullPage: true });
    await axe(page, `shop${sub}`);
  }
  expect(problems).toEqual([]);
});

test("university admin screens", async ({ page }, info) => {
  const problems = watch(page);
  await signIn(page, "admin@demo.printflow.test");
  await passMfa(page, "admin@demo.printflow.test");
  await page.waitForURL("**/admin/**");
  const base = new URL(page.url()).pathname;
  for (const [sub, heading] of [
    ["", "Demo University (sample data)"],
    ["/shops", "Shops"],
    ["/pricing", "Prices"],
    ["/orders", "Orders"],
    ["/disputes", "Disputes"],
    ["/staff", "Staff"],
    ["/audit", "Audit log"],
    ["/privacy", "Privacy requests"],
    ["/settings", "Settings and campuses"],
  ] as const) {
    await page.goto(`${base}${sub}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SHOTS}/admin${sub.replace(/\//g, "-") || "-overview"}-${info.project.name}.png`, fullPage: true });
    await axe(page, `admin${sub}`);
  }
  expect(problems).toEqual([]);
});

test("platform screen", async ({ page }, info) => {
  const problems = watch(page);
  await signIn(page, "platform@demo.printflow.test");
  await passMfa(page, "platform@demo.printflow.test");
  await page.waitForURL("**/platform");
  await expect(page.getByRole("heading", { level: 1, name: "Platform" })).toBeVisible();
  await expect(page.getByText("test mode (no real money)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/platform-${info.project.name}.png`, fullPage: true });
  await axe(page, "platform");
  expect(problems).toEqual([]);
});

test("mobile navigation drawer works with the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "drawer only exists at phone width");
  await signIn(page, "student@demo.printflow.test");
  await page.waitForURL("**/student/**");
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("navigation", { name: "My printing" }).getByRole("link", { name: "Print something" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Print something" })).toBeVisible();
});
