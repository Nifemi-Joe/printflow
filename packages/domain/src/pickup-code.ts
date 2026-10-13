import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const PICKUP_CODE_LENGTH = 6;
export const PICKUP_CODE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
export const PICKUP_MAX_ATTEMPTS = 5;

/** Cryptographically random numeric code, uniform over 000000-999999. */
export function generatePickupCode(): string {
  return randomInt(0, 10 ** PICKUP_CODE_LENGTH).toString().padStart(PICKUP_CODE_LENGTH, "0");
}

/**
 * Only this hash is stored. It is bound to the order and token so a code leaked
 * for one order is useless for any other, and the pepper keeps a DB dump from
 * being brute-forced offline over a 10^6 space.
 */
export function hashPickupCode(pepper: string, orderId: string, tokenId: string, code: string): string {
  if (pepper.length < 32) throw new Error("pickup code pepper must be at least 32 characters");
  return createHmac("sha256", pepper).update(`${orderId}:${tokenId}:${code}`).digest("hex");
}

export function pickupCodeMatches(expectedHashHex: string, pepper: string, orderId: string, tokenId: string, candidate: string): boolean {
  if (!/^\d{6}$/.test(candidate)) return false;
  const actual = Buffer.from(hashPickupCode(pepper, orderId, tokenId, candidate), "hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type PickupVerdict =
  | { ok: true }
  | { ok: false; reason: "EXPIRED" | "USED" | "REVOKED" | "LOCKED" | "WRONG_CODE"; attemptsRemaining: number };

export interface PickupTokenState {
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  failedAttempts: number;
}

/**
 * Pure decision. The caller must run it while holding a row lock on the token and
 * persist the attempt in the same transaction.
 */
export function evaluatePickupAttempt(
  token: PickupTokenState,
  ctx: { pepper: string; orderId: string; tokenId: string; candidate: string; now: Date },
): PickupVerdict {
  const remaining = Math.max(0, PICKUP_MAX_ATTEMPTS - token.failedAttempts);
  if (token.usedAt) return { ok: false, reason: "USED", attemptsRemaining: 0 };
  if (token.revokedAt) return { ok: false, reason: "REVOKED", attemptsRemaining: 0 };
  if (remaining === 0) return { ok: false, reason: "LOCKED", attemptsRemaining: 0 };
  if (ctx.now >= token.expiresAt) return { ok: false, reason: "EXPIRED", attemptsRemaining: remaining };
  if (!pickupCodeMatches(token.codeHash, ctx.pepper, ctx.orderId, ctx.tokenId, ctx.candidate)) {
    return { ok: false, reason: "WRONG_CODE", attemptsRemaining: remaining - 1 };
  }
  return { ok: true };
}
