import { describe, expect, it } from "vitest";
import {
  evaluatePickupAttempt,
  generatePickupCode,
  hashPickupCode,
  PICKUP_MAX_ATTEMPTS,
  pickupCodeMatches,
  type PickupTokenState,
} from "../src/index.js";

const PEPPER = "test-pepper-0123456789abcdefghijklmnop";
const ORDER = "order-1";
const TOKEN = "token-1";

function token(code: string, patch: Partial<PickupTokenState> = {}): PickupTokenState {
  return {
    codeHash: hashPickupCode(PEPPER, ORDER, TOKEN, code),
    expiresAt: new Date("2026-10-12T00:00:00Z"),
    usedAt: null,
    revokedAt: null,
    failedAttempts: 0,
    ...patch,
  };
}
const now = new Date("2026-10-11T12:00:00Z");
const ctx = (candidate: string) => ({ pepper: PEPPER, orderId: ORDER, tokenId: TOKEN, candidate, now });

describe("pickup codes", () => {
  it("generates 6-digit codes", () => {
    for (let i = 0; i < 200; i++) expect(generatePickupCode()).toMatch(/^\d{6}$/);
  });

  it("binds the hash to the order and token", () => {
    const h = hashPickupCode(PEPPER, ORDER, TOKEN, "123456");
    expect(pickupCodeMatches(h, PEPPER, ORDER, TOKEN, "123456")).toBe(true);
    expect(pickupCodeMatches(h, PEPPER, "order-2", TOKEN, "123456")).toBe(false);
    expect(pickupCodeMatches(h, PEPPER, ORDER, "token-2", "123456")).toBe(false);
    expect(pickupCodeMatches(h, PEPPER + "x", ORDER, TOKEN, "123456")).toBe(false);
  });

  it("rejects malformed candidates without hashing", () => {
    const h = hashPickupCode(PEPPER, ORDER, TOKEN, "123456");
    for (const bad of ["12345", "1234567", "12345a", " 123456", ""]) {
      expect(pickupCodeMatches(h, PEPPER, ORDER, TOKEN, bad)).toBe(false);
    }
  });

  it("refuses weak peppers", () => {
    expect(() => hashPickupCode("short", ORDER, TOKEN, "123456")).toThrow();
  });

  it("accepts a correct, live, unused code", () => {
    expect(evaluatePickupAttempt(token("042042"), ctx("042042"))).toEqual({ ok: true });
  });

  it("counts down attempts on wrong codes", () => {
    const v = evaluatePickupAttempt(token("042042", { failedAttempts: 2 }), ctx("999999"));
    expect(v).toEqual({ ok: false, reason: "WRONG_CODE", attemptsRemaining: PICKUP_MAX_ATTEMPTS - 3 });
  });

  it("locks after max attempts even with the right code", () => {
    const v = evaluatePickupAttempt(token("042042", { failedAttempts: PICKUP_MAX_ATTEMPTS }), ctx("042042"));
    expect(v).toMatchObject({ ok: false, reason: "LOCKED" });
  });

  it("rejects expired, used (replay) and revoked tokens", () => {
    expect(evaluatePickupAttempt(token("1", { expiresAt: now }), ctx("000001"))).toMatchObject({ reason: "EXPIRED" });
    expect(evaluatePickupAttempt(token("042042", { usedAt: now }), ctx("042042"))).toMatchObject({ reason: "USED" });
    expect(evaluatePickupAttempt(token("042042", { revokedAt: now }), ctx("042042"))).toMatchObject({ reason: "REVOKED" });
  });
});
