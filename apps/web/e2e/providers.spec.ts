import { expect, test, type Page } from "@playwright/test";
import { axe, passMfa, PASSWORD, SHOTS, signIn, watch } from "./helpers";

const HOSTEL = "Block C Room 14 (student, demo)";
const DOMAIN = "students.demo.printflow.test";

async function newAccount(page: Page, label: string) {
    const email = `${label}.${Date.now()}@example.test`;
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Chidi Nwosu");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("University").selectOption({ label: "Demo University (sample data)" });
    await page.getByLabel("Campus").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/verify**");
    return email;
}

/** Opens the demo student provider in the university's review screen. */
async function openDemoProvider(admin: Page) {
    await admin.goto("/admin");
    await admin.getByRole("link", { name: "Who prints here" }).click();
    await expect(admin.getByRole("heading", { name: "Print shops and students" })).toBeVisible();
    await admin.getByRole("button").filter({ hasText: HOSTEL }).click();
    await expect(admin.getByRole("heading", { name: HOSTEL })).toBeVisible();
}

test("a student registers their own printer and works through verification", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "flow runs once; layouts are checked below");
    const problems = watch(page);
    const email = await newAccount(page, "provider");

    // --- apply as a student with a printer, not a business
    await page.goto("/shop/apply");
    await page.getByRole("radio", { name: /I am a student with my own printer/ }).check();
    await expect(page.getByText(/how far your identity has been confirmed/)).toBeVisible();
    await page.getByLabel("Shop name").fill(`Hostel Printing ${Date.now()}`);
    // "University" also matches the radio labels above, so target the field itself.
    await page.locator("select#uni").selectOption({ label: "Demo University (sample data)" });
    await page.getByLabel("Campus").selectOption({ index: 0 });
    await page.screenshot({ path: `${SHOTS}/provider-apply-desktop.png`, fullPage: true });
    await page.getByRole("button", { name: "Send for approval" }).click();

    // --- registering makes them shop staff, so two-step sign-in comes first, and says why
    await page.waitForURL("**/mfa**");
    await expect(page.getByText(/Your shop is registered/)).toBeVisible();
    await passMfa(page, email);

    // --- and then they land on verification, which leads with the undertaking
    await page.waitForURL("**/verification");
    await expect(page.getByRole("heading", { name: "1. Confidentiality undertaking" })).toBeVisible();
    await expect(page.getByText(/delete every copy/)).toBeVisible();
    await axe(page, "provider verification");
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Agree and continue" }).click();
    await expect(page.getByText("You can now open your shop for orders.")).toBeVisible();

    // --- the university email step is next, and only their university's domain counts
    await expect(page.getByRole("heading", { name: "2. Your university email" })).toBeVisible();
    await expect(page.getByText(new RegExp(`@${DOMAIN}`)).first()).toBeVisible();
    await page.getByLabel("University email address").fill("someone@gmail.com");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByText(/use your university address/i)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/provider-verification-desktop.png`, fullPage: true });
    // The refused address above is answered with a 422, which the browser logs.
    expect(problems.filter((p) => !/422/.test(p))).toEqual([]);
});

test("a provider's level drives what students see, from warning to verified and back", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "flow runs once; layouts are checked below");
    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const problems = watch(admin);
    await signIn(admin, "admin@demo.printflow.test");
    await passMfa(admin, "admin@demo.printflow.test");
    await admin.waitForURL("**/admin/**");

    // --- start from a known place: the demo provider's matric number is not confirmed
    await openDemoProvider(admin);
    const withdraw = admin.getByRole("listitem").filter({ hasText: "Matric number" }).getByRole("button", { name: "Withdraw" });
    if (await withdraw.isVisible().catch(() => false)) {
        admin.once("dialog", (d) => void d.accept("Resetting for a test run"));
        await withdraw.click();
        await expect(admin.getByText(/Withdrew matric number/)).toBeVisible();
    }
    await expect(admin.getByText("Student email only").first()).toBeVisible();

    // --- a student sees the warning and the cap, and cannot order until they agree
    const studentCtx = await browser.newContext();
    const student = await studentCtx.newPage();
    const studentProblems = watch(student);
    await signIn(student, "student@demo.printflow.test");
    await student.waitForURL("**/student/**");
    await student.goto("/student/print");
    const hostel = student.locator("label.choice", { hasText: HOSTEL });
    await expect(hostel.getByText("Student email only")).toBeVisible();
    await expect(student.locator("label.choice", { hasText: "Faculty Print Hub" }).getByText("Approved print shop")).toBeVisible();

    await student.getByLabel("Document").selectOption({ index: 1 });
    await hostel.locator("input").check();
    await student.getByRole("button", { name: "Get exact price" }).click();
    const notice = student.getByRole("note");
    await expect(notice.getByText(/is a student, not a registered shop/)).toBeVisible();
    await expect(notice.getByText(/capped at ₦2,000/)).toBeVisible();
    const confirm = student.getByRole("button", { name: /Confirm and pay/ });
    await expect(confirm).toBeDisabled();
    await student.screenshot({ path: `${SHOTS}/provider-unverified-warning-desktop.png`, fullPage: true });
    await axe(student, "unverified provider warning");
    await notice.getByRole("checkbox").check();
    await expect(confirm).toBeEnabled();

    // --- the provider submits their matric number
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await signIn(owner, "hostel@demo.printflow.test");
    await passMfa(owner, "hostel@demo.printflow.test");
    await owner.goto("/shop");
    await owner.getByRole("link", { name: "Verification" }).click();
    await owner.waitForURL("**/verification");
    const matricField = owner.getByLabel("Matric number");
    await matricField.waitFor({ timeout: 15_000 });
    await matricField.fill("21/123456");
    await owner.getByRole("button", { name: "Submit for checking" }).click();
    await expect(owner.getByText(/will check this against their records/)).toBeVisible();
    await ownerCtx.close();

    // --- the university confirms it against their records
    await openDemoProvider(admin);
    await expect(admin.getByRole("heading", { name: "Waiting on you" })).toBeVisible();
    await expect(admin.getByText("21/123456").first()).toBeVisible();
    await admin.screenshot({ path: `${SHOTS}/admin-providers-desktop.png`, fullPage: true });
    await axe(admin, "provider review");
    await admin.getByLabel("How did you confirm it?").selectOption("STUDENT_RECORDS");
    await admin.getByLabel("What did you check?").fill("Found in the 2021 intake register");
    await admin.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(admin.getByText(/no longer carries the warning/)).toBeVisible();

    // --- the student side changes at once: no warning, no cap
    await student.goto("/student/print");
    await expect(student.locator("label.choice", { hasText: HOSTEL }).getByText("Verified student")).toBeVisible();
    await student.getByLabel("Document").selectOption({ index: 1 });
    await student.locator("label.choice", { hasText: HOSTEL }).locator("input").check();
    await student.getByRole("button", { name: "Get exact price" }).click();
    await expect(student.getByRole("button", { name: /Confirm and pay/ })).toBeEnabled();
    await expect(student.getByRole("note")).toHaveCount(0);
    await student.screenshot({ path: `${SHOTS}/provider-verified-desktop.png`, fullPage: true });

    // --- withdrawing it puts the warning straight back, and leaves the demo data as found
    admin.once("dialog", (d) => void d.accept("Student has left the university"));
    await admin.getByRole("listitem").filter({ hasText: "Matric number" }).getByRole("button", { name: "Withdraw" }).click();
    await expect(admin.getByText(/Withdrew matric number/)).toBeVisible();
    await student.goto("/student/print");
    await expect(student.locator("label.choice", { hasText: HOSTEL }).getByText("Student email only")).toBeVisible();

    expect(problems).toEqual([]);
    expect(studentProblems).toEqual([]);
    await studentCtx.close();
    await adminCtx.close();
});

test("the provider trust badge fits every screen and passes axe", async ({ page }, info) => {
    const problems = watch(page);
    await signIn(page, "student@demo.printflow.test");
    await page.waitForURL("**/student/**");
    await page.goto("/student/print");
    await expect(page.locator("label.choice", { hasText: "Faculty Print Hub" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await axe(page, "shop picker with trust");
    await page.screenshot({ path: `${SHOTS}/provider-shop-picker-${info.project.name}.png`, fullPage: true });
    expect(problems).toEqual([]);
});
