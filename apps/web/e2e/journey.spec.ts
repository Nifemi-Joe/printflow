import { expect, test } from "@playwright/test";
import { axe, passMfa, SHOTS, signIn, twoPagePdf, watch } from "./helpers";

// The full journey runs once (desktop); screenshots of each screen are taken at the project's size.
test("student orders, shop prints and hands over, entirely through the UI", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "journey runs once; layout screenshots come from the other suites");
  const studentCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const shopCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const student = await studentCtx.newPage();
  const shop = await shopCtx.newPage();
  const sProblems = watch(student);
  const hProblems = watch(shop);

  // --- student uploads
  await signIn(student, "student@demo.printflow.test");
  await student.waitForURL("**/student/**");
  await student.goto("/student/documents");
  const file = twoPagePdf();
  await student.locator("input[type=file]").setInputFiles(file);
  await expect(student.locator("[aria-live=polite]").getByText("Uploaded", { exact: true })).toBeVisible();
  const row = student.locator("tr", { hasText: "Browser test notes" }).first();
  await expect(row.getByText("Ready to print")).toBeVisible({ timeout: 60_000 });
  await student.screenshot({ path: `${SHOTS}/student-documents.png`, fullPage: true });
  await axe(student, "documents");

  // --- preview
  await row.getByRole("button", { name: "Preview" }).click();
  await expect(student.getByRole("dialog").locator("img").first()).toBeVisible();
  await expect.poll(async () => student.getByRole("dialog").locator("img").first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await student.getByRole("button", { name: "Close" }).click();

  // --- quote and pay
  await row.getByRole("link", { name: "Print" }).click();
  await student.getByRole("radio", { name: /Faculty Print Hub/ }).check();
  await student.getByLabel("Copies").fill("2");
  await student.getByLabel(/Stapling/).check();
  await student.getByRole("button", { name: "Get exact price" }).click();
  const ticket = student.locator(".ticket");
  // 2 pages × 2 copies × ₦20 + stapling 2 × ₦10 = ₦100; fee ₦50 + 1.5% (₦1.50) = ₦51.50
  await expect(ticket.locator(".ticket-total")).toContainText("₦151.50");
  await student.screenshot({ path: `${SHOTS}/student-quote.png`, fullPage: true });
  await axe(student, "print wizard");
  await student.getByRole("button", { name: /Confirm and pay/ }).click();
  await student.waitForURL("**/checkout/test/**");
  await expect(student.getByText("simulated checkout for testing")).toBeVisible();
  await student.getByRole("button", { name: "Simulate successful payment" }).click();
  await student.waitForURL("**/student/orders/**");
  await expect(student.getByText("Next in the queue").or(student.getByText(/Number \d+ in the queue/))).toBeVisible();
  const orderUrl = student.url();
  await student.screenshot({ path: `${SHOTS}/student-order-paid.png`, fullPage: true });

  // --- shop owner (staff MFA enrolment + verification)
  await signIn(shop, "shop@demo.printflow.test");
  await passMfa(shop, "shop@demo.printflow.test");
  await shop.waitForURL("**/shop/**");
  const job = shop.locator("article", { hasText: "4 sheets" }).first();
  await expect(job).toBeVisible();
  await shop.screenshot({ path: `${SHOTS}/shop-queue.png`, fullPage: true });
  await axe(shop, "shop queue");
  await job.getByRole("button", { name: "Accept" }).click();
  await expect(job.getByRole("button", { name: "Start printing" })).toBeVisible();
  await job.getByRole("button", { name: "Start printing" }).click();
  await expect(job.getByRole("button", { name: "Send to quality check" })).toBeVisible();
  await job.getByRole("button", { name: "Send to quality check" }).click();
  await job.getByRole("link", { name: "Check quality" }).click();
  await expect(shop.getByRole("heading", { name: "Quality check" })).toBeVisible();
  const download = shop.waitForEvent("download");
  await shop.getByRole("button", { name: "Download print file" }).click();
  expect((await download).suggestedFilename()).toMatch(/^PF-[0-9A-Z]{8}\.pdf$/);
  await shop.getByLabel("Sheets counted").fill("4");
  await shop.screenshot({ path: `${SHOTS}/shop-job-qa.png`, fullPage: true });
  await shop.getByRole("button", { name: "Record check" }).click();
  await expect(shop.locator(".page-head .pill")).toHaveText("Ready for pickup");

  // --- student gets a pickup code
  await student.goto(orderUrl);
  await student.getByRole("button", { name: "Show my pickup code" }).click();
  const codeText = (await student.locator(".pickup-code").innerText()).replace(/\s/g, "");
  expect(codeText).toMatch(/^\d{6}$/);
  await student.screenshot({ path: `${SHOTS}/student-pickup-code.png`, fullPage: true });

  // --- shop hands over: wrong code refused, right code accepted
  await shop.goto(shop.url().replace(/\/orders\/.*$/, ""));
  const ready = shop.locator("section[aria-labelledby='ready-title']");
  const readyRow = ready.locator("div", { hasText: /PF-/ }).filter({ has: shop.getByRole("button", { name: "Hand over" }) }).last();
  await readyRow.getByRole("button", { name: "Hand over" }).click();
  await ready.getByPlaceholder("6-digit code").fill(codeText === "000000" ? "111111" : "000000");
  await ready.getByRole("button", { name: "Verify and hand over" }).click();
  await expect(ready.getByRole("alert")).toContainText("incorrect");
  await ready.getByPlaceholder("6-digit code").fill(codeText);
  await ready.getByRole("button", { name: "Verify and hand over" }).click();
  await expect(ready.getByRole("alert")).toContainText("handed over");

  await student.reload();
  await expect(student.locator(".page-head .pill")).toHaveText("Collected");
  await student.screenshot({ path: `${SHOTS}/student-order-collected.png`, fullPage: true });

  expect(sProblems).toEqual([]);
  expect(hProblems.filter((p) => !/422/.test(p))).toEqual([]);
  await studentCtx.close();
  await shopCtx.close();
});
