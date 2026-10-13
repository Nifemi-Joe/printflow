import { describe, expect, it } from "vitest";
import { describePower, formatPhone, generateOtp, hashOtp, maskPhone, normalizePhone, otpMatches, PhoneError, validateBackAt } from "../src/index.js";

describe("normalizePhone", () => {
  it.each([
    ["08012345678", "+2348012345678"],
    ["8012345678", "+2348012345678"],
    ["2348012345678", "+2348012345678"],
    ["+234 801 234 5678", "+2348012345678"],
    ["+234 (0) 801-234-5678", "+2348012345678"],
    ["0703 123 4567", "+2347031234567"],
    ["09161234567", "+2349161234567"],
    ["0044 7700 900123", "+447700900123"],
    ["+447700900123", "+447700900123"],
  ])("%s → %s", (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });

  it.each(["", "abc", "0801234567", "080123456789", "06012345678", "+234 601 234 5678", "+0123", "08012+345678", "+12"])("rejects %j", (input) => {
    expect(() => normalizePhone(input)).toThrow(PhoneError);
  });

  it("formats and masks for display", () => {
    expect(formatPhone("+2348012345678")).toBe("+234 801 234 5678");
    expect(maskPhone("+2348012345678")).toBe("+234 801 ••• 5678");
    expect(maskPhone("+447700900123")).toBe("+44 ••• 0123");
  });
});

describe("one-time codes", () => {
  it("are six digits and bound to phone and purpose", () => {
    const code = generateOtp();
    expect(code).toMatch(/^\d{6}$/);
    const h = hashOtp("secret", "+2348012345678", "SIGN_IN", code);
    expect(otpMatches("secret", "+2348012345678", "SIGN_IN", code, h)).toBe(true);
    expect(otpMatches("secret", "+2348012345679", "SIGN_IN", code, h)).toBe(false);
    expect(otpMatches("secret", "+2348012345678", "VERIFY_PHONE", code, h)).toBe(false);
    expect(otpMatches("other", "+2348012345678", "SIGN_IN", code, h)).toBe(false);
    expect(otpMatches("secret", "+2348012345678", "SIGN_IN", "12345", h)).toBe(false);
  });

  it("are spread across the whole range", () => {
    const seen = new Set(Array.from({ length: 2000 }, generateOtp));
    expect(seen.size).toBeGreaterThan(1900);
    expect([...seen].some((c) => c.startsWith("0"))).toBe(true);
  });
});

describe("shop power", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  it("describes each state and whether printing is possible", () => {
    expect(describePower({ status: "GRID", backAt: null, note: null, updatedAt: now }, now)).toMatchObject({ label: "Light on", canPrint: true, stale: false });
    expect(describePower({ status: "GENERATOR", backAt: null, note: "Fuel till 6pm", updatedAt: now }, now)).toMatchObject({ label: "Generator on", canPrint: true, note: "Fuel till 6pm" });
    expect(describePower({ status: "UNKNOWN", backAt: null, note: null, updatedAt: null }, now)).toMatchObject({ canPrint: null, stale: true });
  });
  it("flags an outage whose expected return has passed, and old reports", () => {
    const out = describePower({ status: "OUTAGE", backAt: new Date("2026-10-12T09:00:00Z"), note: null, updatedAt: new Date("2026-10-12T08:00:00Z") }, now);
    expect(out).toMatchObject({ label: "Light out", canPrint: false, overdue: true, stale: false });
    expect(describePower({ status: "GRID", backAt: null, note: null, updatedAt: new Date("2026-10-11T22:00:00Z") }, now).stale).toBe(true);
  });
  it("only accepts return times within the next 48 hours", () => {
    expect(() => validateBackAt(new Date("2026-10-12T14:00:00Z"), now)).not.toThrow();
    expect(() => validateBackAt(new Date("2026-10-12T09:59:00Z"), now)).toThrow(/future/);
    expect(() => validateBackAt(new Date("2026-10-15T10:00:00Z"), now)).toThrow(/48 hours/);
  });
});
