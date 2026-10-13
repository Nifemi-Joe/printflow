import { expect, test } from "@playwright/test";
import { axe, SHOTS, watch } from "./helpers";

test.describe("landing page", () => {
  test("renders, has no console errors or failed requests, and passes axe", async ({ page }, info) => {
    const problems = watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Print your notes without the queue." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start printing" }).first()).toBeVisible();
    await page.waitForTimeout(3500); // allow the idle-time 3D load
    await page.screenshot({ path: `${SHOTS}/landing-hero-${info.project.name}.png` });
    await page.screenshot({ path: `${SHOTS}/landing-full-${info.project.name}.png`, fullPage: true });
    await axe(page, "landing");
    // No horizontal overflow at any size.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(problems).toEqual([]);
  });

  test("loads the 3D printer when WebGL is available, and scrolling stays native", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/");
    await expect(page.locator(".hero-visual[data-mode='3d'] canvas")).toBeVisible({ timeout: 15_000 });
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.scrollY);
    expect(after).toBeGreaterThan(before + 300); // the scene never captures the wheel
    expect(problems).toEqual([]);
  });

  test("uses the static illustration with reduced motion", async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: info.project.use.viewport ?? undefined });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForTimeout(3000);
    await expect(page.locator(".hero-visual[data-mode='static'] svg")).toBeVisible();
    await expect(page.locator(".hero-visual canvas")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/landing-reduced-motion-${info.project.name}.png` });
    await ctx.close();
  });

  test("falls back to the static illustration without WebGL", async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/.test(type)) return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForTimeout(3000);
    await expect(page.locator(".hero-visual[data-mode='static'] svg")).toBeVisible();
    await ctx.close();
  });

  test("the price demo updates and labels itself as an example", async ({ page }) => {
    await page.goto("/");
    const ticket = page.locator(".demo-ticket");
    await expect(ticket.getByText("₦476.30")).toBeVisible();
    await page.getByLabel("Copies").fill("2");
    await expect(ticket.getByText("₦902.60")).toBeVisible();
    await expect(page.getByText("These are example prices.")).toBeVisible();
  });

  test("auth pages are accessible", async ({ page }) => {
    for (const path of ["/login", "/register", "/forgot-password"]) {
      await page.goto(path);
      await axe(page, path);
    }
  });
});
