import { describe, expect, it } from "vitest";
import { addKobo, applyBasisPoints, formatNaira, MoneyError, multiplyKobo } from "../src/index.js";

describe("money", () => {
  it("rejects fractional kobo anywhere", () => {
    expect(() => addKobo(100, 0.5)).toThrow(MoneyError);
    expect(() => multiplyKobo(10.1, 2)).toThrow(MoneyError);
    expect(() => multiplyKobo(10, 1.5)).toThrow(MoneyError);
    expect(() => multiplyKobo(10, -1)).toThrow(MoneyError);
  });

  it("does not suffer float drift", () => {
    expect(addKobo(10, 20)).toBe(30);
    expect(addKobo(...Array.from({ length: 1000 }, () => 1))).toBe(1000);
  });

  it("rejects overflow beyond safe integers", () => {
    expect(() => multiplyKobo(Number.MAX_SAFE_INTEGER, 2)).toThrow(MoneyError);
  });

  it("applies basis points with round-half-up", () => {
    expect(applyBasisPoints(1_001, 150)).toBe(15); // 15.015
    expect(applyBasisPoints(1_000, 150)).toBe(15); // 15.0
    expect(applyBasisPoints(100, 50)).toBe(1); // 0.5 -> 1
    expect(applyBasisPoints(99, 50)).toBe(0); // 0.495 -> 0
    expect(applyBasisPoints(123_456, 0)).toBe(0);
    expect(applyBasisPoints(123_456, 10_000)).toBe(123_456);
    expect(() => applyBasisPoints(100, 10_001)).toThrow(MoneyError);
    expect(() => applyBasisPoints(100, 1.5)).toThrow(MoneyError);
  });

  it("formats naira", () => {
    expect(formatNaira(0)).toBe("₦0.00");
    expect(formatNaira(5)).toBe("₦0.05");
    expect(formatNaira(123_456_789)).toBe("₦1,234,567.89");
    expect(formatNaira(-2_050)).toBe("-₦20.50");
  });
});
