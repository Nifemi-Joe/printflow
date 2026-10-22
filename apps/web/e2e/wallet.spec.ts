import { expect, test, type Page } from "@playwright/test";
import { axe, passMfa, PASSWORD, SHOTS, signIn, smsCode, twoPagePdf, watch } from "./helpers";

function freshPhone() {
    const n = `${(Date.now() + 3) % 10_000_000}`.padStart(7, "0");
    return { local: `0808${n}`, e164: `+234808${n}` };
}

/** A brand-new student with a confirmed phone, so this test owns its wallet. */
async function newStudent(page: Page) {
    const phone = freshPhone();
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Wallet Student");
    await page.getByLabel("Email").fill(`wallet.${Date.now()}@example.test`);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("University").selectOption({ label: "Demo University (sample data)" });
    await page.getByLabel("Campus").selectOption({ index: 1 });
    await page.getByLabel(/Phone number/).fill(phone.local);
    const after = Date.now() - 1000;
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/verify**");
    await page.getByLabel("6-digit code").fill(await smsCode(phone.e164, after));
    await page.getByRole("button", { name: "Confirm number" }).click();
    await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible();
}

test("a student tops up, pays a print from the wallet, cancels, and gets the money back instantly", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "flow runs once; layout is checked at every size below");
    const problems = watch(page);
    await newStudent(page);

    // --- top up ₦2,000 by bank transfer (simulated checkout)
    await page.goto("/student/wallet");
    await expect(page.getByTestId("wallet-balance")).toHaveText("₦0.00");
    await expect(page.getByText(/cannot be withdrawn/)).toBeVisible();
    await page.getByRole("button", { name: "₦2,000", exact: true }).click();
    await page.getByRole("radio", { name: /Bank transfer/ }).check();
    await axe(page, "wallet");
    await page.getByRole("button", { name: "Top up ₦2,000" }).click();
    await page.waitForURL("**/checkout/test/**");
    await expect(page.getByText("PrintFlow wallet")).toBeVisible();
    await page.getByRole("button", { name: "Simulate: I've sent the transfer" }).click();
    await page.waitForURL("**/student/wallet?topup=**");
    await expect(page.getByText("₦2,000.00 added to your wallet.")).toBeVisible();
    await expect(page.getByTestId("wallet-balance")).toHaveText("₦2,000.00");
    await page.screenshot({ path: `${SHOTS}/student-wallet-desktop.png`, fullPage: true });

    // --- print something and pay from the wallet: no checkout page at all
    await page.goto("/student/documents");
    await page.locator("input[type=file]").setInputFiles(twoPagePdf());
    await expect(page.getByText("Ready to print").first()).toBeVisible({ timeout: 60_000 });
    await page.goto("/student/print");
    await page.getByLabel("Document").selectOption({ index: 1 });
    await page.locator("label.choice", { hasText: "Faculty Print Hub" }).locator("input").check();
    await page.getByRole("button", { name: "Get exact price" }).click();
    await expect(page.getByText("Use my wallet (₦2,000.00)")).toBeVisible();
    await page.getByRole("button", { name: /Confirm and pay .* from wallet/ }).click();
    await page.waitForURL("**/student/orders/**");
    await expect(page.getByText("Paid from your wallet")).toBeVisible();
    await expect(page.getByText(/Paid, waiting for the shop/).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/student-paid-from-wallet-desktop.png`, fullPage: true });

    // --- cancel: the money is back in the wallet straight away
    await page.getByRole("button", { name: "Cancel and refund" }).click();
    await expect(page.getByText(/goes back to your wallet straight away/)).toBeVisible();
    await page.getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(page.getByText(/is back in your/)).toBeVisible();
    await page.goto("/student/wallet");
    await expect(page.getByTestId("wallet-balance")).toHaveText("₦2,000.00");
    const activity = page.getByRole("list", { name: "Wallet activity" });
    await expect(activity.getByText("Returned from an order")).toBeVisible();
    await expect(activity.getByText("Paid for printing")).toBeVisible();
    await expect(activity.getByText("Top-up")).toBeVisible();
    expect(problems).toEqual([]);
});

test("the university gives a student print credit", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "flow runs once");
    const studentCtx = await browser.newContext();
    const student = await studentCtx.newPage();
    await newStudent(student);
    const email = await student.evaluate(async () => ((await (await fetch("/api/v1/auth/session")).json()) as { user: { email: string } }).user.email);

    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const problems = watch(admin);
    await signIn(admin, "admin@demo.printflow.test");
    await passMfa(admin, "admin@demo.printflow.test");
    await admin.waitForURL("**/admin/**");
    await admin.getByRole("link", { name: "Print credit" }).click();
    await admin.getByLabel("Student's email").fill(email);
    await admin.getByLabel("Amount (₦)").first().fill("300");
    await admin.getByLabel("Reason (the student sees this)").fill("Exam week thank-you");
    await admin.getByRole("button", { name: "Give credit" }).click();
    await expect(admin.getByText(/Gave ₦300.00 to Wallet Student/)).toBeVisible();
    await expect(admin.getByRole("list", { name: "Recent credit" }).getByText("Exam week thank-you").first()).toBeVisible();
    await axe(admin, "print credit");
    await admin.screenshot({ path: `${SHOTS}/admin-print-credit-desktop.png`, fullPage: true });

    await student.goto("/student/wallet");
    await expect(student.getByTestId("wallet-balance")).toHaveText("₦300.00");
    await expect(student.getByText("Print credit from your university", { exact: true })).toBeVisible();
    expect(problems).toEqual([]);
    await studentCtx.close();
    await adminCtx.close();
});

test("the wallet page fits this screen and passes axe", async ({ page }, info) => {
    const problems = watch(page);
    await signIn(page, "student@demo.printflow.test");
    await page.waitForURL("**/student/**");
    await page.goto("/student/wallet");
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await axe(page, "wallet");
    await page.screenshot({ path: `${SHOTS}/student-wallet-${info.project.name}.png`, fullPage: true });
    expect(problems).toEqual([]);
});
