import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/** SMS codes: 6 digits, valid 10 minutes, 5 tries, one resend per minute. */
export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export type OtpPurpose = "VERIFY_PHONE" | "SIGN_IN";

export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, "0");
}

/**
 * Codes are stored as an HMAC bound to the phone and purpose, so a code sent to
 * one number (or for verification) can never be replayed elsewhere.
 */
export function hashOtp(secret: string, phone: string, purpose: OtpPurpose, code: string): string {
  return createHmac("sha256", secret).update(`otp:${purpose}:${phone}:${code}`).digest("hex");
}

export function otpMatches(secret: string, phone: string, purpose: OtpPurpose, code: string, storedHash: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hashOtp(secret, phone, purpose, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
