import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCode, extractLinks, formatDevBlock } from "../src/dev-console.js";
import { LogMailer } from "../src/mailer.js";
import { LogSms } from "../src/sms.js";

const silent = pino({ level: "silent" });

function captureStdout() {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  return { text: () => out.join(""), restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe("dev console", () => {
  it("draws an aligned box with every value in full", () => {
    const url = "http://localhost:3000/verify-email?token=abcdefghijklmnopqrstuvwxyz0123456789";
    const box = formatDevBlock("email", [
      { label: "To", value: "a@b.co" },
      { label: "Link", value: url },
    ]);
    const lines = box.split("\n");
    expect(lines[0]).toMatch(/^┌─ PrintFlow dev ─ email ─+┐$/);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(box).toContain(url);
  });

  it("finds links and codes", () => {
    expect(extractLinks("Open https://x.test/a?b=1. Or http://y.test/c")).toEqual(["https://x.test/a?b=1.", "http://y.test/c"]);
    expect(extractCode("Your PrintFlow sign-in code is 042117. It expires in 10 minutes.")).toBe("042117");
    expect(extractCode("no code here 12345")).toBeNull();
  });

  it("the LOG email driver prints the link to the terminal", async () => {
    const cap = captureStdout();
    await new LogMailer(silent).send({ to: "s@uni.test", subject: "Confirm your PrintFlow email", text: "Confirm your email address: http://localhost:3000/verify-email?token=tok123\nThis link expires in 24 hours." });
    cap.restore();
    expect(cap.text()).toContain("email (not sent)");
    expect(cap.text()).toContain("http://localhost:3000/verify-email?token=tok123");
    expect(cap.text()).toContain("Confirm your PrintFlow email");
  });

  it("the LOG SMS driver prints the code to the terminal", async () => {
    const cap = captureStdout();
    await new LogSms(silent).send({ to: "+2348031234567", text: "Your PrintFlow verification code is 908172. It expires in 10 minutes." });
    cap.restore();
    expect(cap.text()).toMatch(/Code\s+908172/);
    expect(cap.text()).toContain("+2348031234567");
  });

  it("prints nothing when switched off", async () => {
    const cap = captureStdout();
    await new LogMailer(silent, false).send({ to: "a@b.co", subject: "s", text: "http://x.test" });
    await new LogSms(silent, false).send({ to: "+2348031234567", text: "code 123456" });
    cap.restore();
    expect(cap.text()).toBe("");
  });
});
