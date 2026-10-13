import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, passMfa, signIn, watch } from "./helpers";

/**
 * Regression: a newly added shop operator signed in and landed on the Account page
 * with no two-step sign-in and no way back to the shop. Staff must set up two-step
 * sign-in before any signed-in page, a "next" link must not skip it, and the menu
 * must show only what the person can use.
 */
test("new shop staff must set up two-step sign-in before any page, then see their shop", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "flow runs once");
  const email = `new.operator.${Date.now()}@example.test`;

  // 1. Someone creates an ordinary account.
  const visitor = await browser.newPage();
  await visitor.goto("/register");
  await visitor.getByLabel("Full name").fill("New Operator");
  await visitor.getByLabel("Email").fill(email);
  await visitor.getByLabel("Password").fill(PASSWORD);
  await visitor.getByLabel("University").selectOption({ label: "Demo University (sample data)" });
  await visitor.getByLabel("Campus").selectOption({ index: 1 });
  await visitor.getByRole("button", { name: "Create account" }).click();
  await visitor.waitForURL("**/verify**");
  await visitor.close();

  // 2. The shop owner adds them as an operator.
  const owner = await browser.newPage();
  await signIn(owner, "shop@demo.printflow.test");
  await passMfa(owner, "shop@demo.printflow.test");
  await owner.waitForURL(/\/shop\/[\w-]+/);
  const shopId = /\/shop\/([\w-]+)/.exec(owner.url())![1]!;
  const added = await owner.evaluate(
      async ({ shopId, email }) => {
        const s = await (await fetch("/api/v1/auth/session")).json();
        const r = await fetch(`/api/v1/shops/${shopId}/staff`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrfToken },
          body: JSON.stringify({ email, role: "OPERATOR" }),
        });
        return r.status;
      },
      { shopId, email },
  );
  expect(added).toBe(201);
  await owner.close();

  // 3. The new operator signs in from a link to the Account page.
  const page: Page = await browser.newPage();
  const problems = watch(page);
  await page.goto("/login?next=/account");
  await page.getByLabel("Email or phone number").fill(email);
  await page.locator("input#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/mfa**");
  await expect(page.getByRole("heading", { name: "Set up two-step sign-in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign out" })).toBeVisible();

  // No signed-in page can be reached first.
  for (const path of ["/account", "/shop", `/shop/${shopId}`, "/dashboard"]) {
    await page.goto(path);
    await page.waitForURL("**/mfa**");
  }

  // 4. Set it up; they continue to the page they last asked for.
  await passMfa(page, email);
  await page.waitForURL(`**/shop/${shopId}`);
  const nav = page.getByRole("navigation", { name: /Faculty Print Hub/ });
  await expect(nav.getByRole("link", { name: "Queue" })).toBeVisible();
  // An operator cannot manage staff, prices, reports or settings, so those are not offered.
  for (const hidden of ["Staff", "Prices", "Reports", "Shop settings"]) await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);

  // 5. From the Account page there is a way back to the shop, and no duplicate "Account" item.
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByText("An authenticator app is set up for this account.")).toBeVisible();
  const workspaces = page.getByRole("navigation", { name: "Workspaces" });
  await workspaces.getByRole("link", { name: /Faculty Print Hub/ }).click();
  await page.waitForURL(`**/shop/${shopId}`);
  await expect(page.getByRole("heading", { name: /queue/i }).first()).toBeVisible();
  expect(problems).toEqual([]);
});

/**
 * Regression: after one person signed out, the next person to sign in on the same
 * browser was sent to the previous person's last page ("University administrator
 * access is required", "You are not a member of this shop").
 */
test("signing in after someone else signs out starts at your own home page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "flow runs once");
  const problems = watch(page);

  // The shop owner works on a settings page, then signs out.
  await signIn(page, "shop@demo.printflow.test");
  await passMfa(page, "shop@demo.printflow.test");
  await page.waitForURL(/\/shop\/[\w-]+/);
  const shopPage = `${new URL(page.url()).pathname}/settings`;
  await page.goto(shopPage);
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Sign out" }).click();
  await page.waitForURL((u) => u.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBeNull();

  // A student signs in on the same browser and lands on their own page.
  await page.getByLabel("Email or phone number").fill("student@demo.printflow.test");
  await page.locator("input#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/student/orders");

  // A leftover link to someone else's workspace is ignored at sign-in.
  await page.goto("about:blank");
  await page.context().clearCookies();
  await page.goto(`/login?next=${encodeURIComponent(shopPage)}`);
  await page.getByLabel("Email or phone number").fill("student@demo.printflow.test");
  await page.locator("input#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/student/orders");

  // Opening it directly explains the situation instead of showing API errors.
  await page.goto(shopPage);
  await expect(page.getByRole("heading", { name: "This page isn't part of your account" })).toBeVisible();
  await expect(page.getByText("You are not a member of this shop")).toHaveCount(0);
  await page.getByRole("link", { name: "Go to your home page" }).click();
  await page.waitForURL("**/student/orders");
  expect(problems).toEqual([]);

  // When the session ends while a page is open, the next request sends them to sign in.
  await page.context().clearCookies();
  await page.reload();
  await page.waitForURL((u) => u.pathname === "/login" && u.searchParams.get("next") === "/student/orders");
});
