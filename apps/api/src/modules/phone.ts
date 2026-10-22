import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { Pool } from "pg";
import {
  generateOtp,
  hashOtp,
  maskPhone,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  otpMatches,
  type OtpPurpose,
} from "../../../../packages/domain/src/index.js";
import { grantWelcomeCredit, withTransaction, type Queryable } from "../../../../packages/data/src/index.js";
import type { AppConfig } from "../config.js";
import { Access, audit } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { ApiError, Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { parse } from "../http/validate.js";
import type { SmsSender } from "../infra/sms.js";
import { CONFIG, PG_POOL, SMS } from "../infra/tokens.js";

export interface CodeSent {
  sentTo: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

/**
 * One-time SMS codes for verifying a phone and for signing in.
 * Codes are 6 digits, stored only as an HMAC bound to phone and purpose, valid
 * for 10 minutes, burned after 5 wrong tries, usable once; a new code replaces
 * any earlier one for the same phone and purpose.
 */
export class PhoneCodes {
  constructor(
      private readonly pool: Pool,
      private readonly cfg: AppConfig,
      private readonly sms: SmsSender,
      private readonly limiter: RateLimiter,
  ) {}

  get available(): boolean {
    return this.sms.name !== "none";
  }

  assertAvailable(): void {
    if (!this.available) throw Errors.unavailable("text messages are not switched on yet; use your email instead", "SMS_UNAVAILABLE");
  }

  /** Per-number limits. Applied identically whether or not the number has an account. */
  async throttle(phone: string): Promise<void> {
    await this.limiter.hit(`otp-cooldown:${phone}`, 1, OTP_RESEND_COOLDOWN_MS / 1000);
    await this.limiter.hit(`otp-send:${phone}`, 5, 3600);
  }

  async issue(db: Queryable, p: { phone: string; userId: string | null; purpose: OtpPurpose }): Promise<CodeSent> {
    const code = generateOtp();
    await db.query(`UPDATE phone_otps SET revoked_at = now() WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND revoked_at IS NULL`, [p.phone, p.purpose]);
    await db.query(
        `INSERT INTO phone_otps (phone, user_id, purpose, code_hash, max_attempts, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
        [p.phone, p.userId, p.purpose, hashOtp(this.cfg.SESSION_SECRET, p.phone, p.purpose, code), OTP_MAX_ATTEMPTS, OTP_TTL_MS / 1000],
    );
    const what = p.purpose === "SIGN_IN" ? "sign-in" : "verification";
    await this.sms.send({ to: p.phone, text: `Your PrintFlow ${what} code is ${code}. It expires in 10 minutes. Never share it; PrintFlow will never ask you for it.` });
    return this.receipt(p.phone);
  }

  receipt(phone: string): CodeSent {
    return { sentTo: maskPhone(phone), expiresInSeconds: OTP_TTL_MS / 1000, resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
  }

  /**
   * Checks a code. Wrong guesses are counted even though the caller gets an
   * error, so the attempt limit cannot be bypassed by failing the request.
   * Returns the user the code was issued for (sign-in) or null.
   */
  async consume(p: { phone: string; purpose: OtpPurpose; code: string; userId?: string }): Promise<string | null> {
    const outcome = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string | null; code_hash: string; attempts: number; max_attempts: number; expired: boolean }>(
          `SELECT id, user_id, code_hash, attempts, max_attempts, expires_at <= now() AS expired
           FROM phone_otps
           WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND revoked_at IS NULL
             AND ($3::uuid IS NULL OR user_id = $3)
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [p.phone, p.purpose, p.userId ?? null],
      );
      const otp = rows[0];
      if (!otp || otp.expired) return { ok: false as const, reason: "EXPIRED" as const };
      if (otp.attempts >= otp.max_attempts) return { ok: false as const, reason: "LOCKED" as const };
      if (!otpMatches(this.cfg.SESSION_SECRET, p.phone, p.purpose, p.code, otp.code_hash)) {
        await c.query(`UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
        return { ok: false as const, reason: otp.attempts + 1 >= otp.max_attempts ? ("LOCKED" as const) : ("WRONG" as const) };
      }
      await c.query(`UPDATE phone_otps SET consumed_at = now() WHERE id = $1`, [otp.id]);
      return { ok: true as const, userId: otp.user_id };
    });
    if (outcome.ok) return outcome.userId;
    if (outcome.reason === "LOCKED") throw new ApiError(422, "CODE_LOCKED", "too many wrong attempts; request a new code");
    if (outcome.reason === "EXPIRED") throw new ApiError(422, "CODE_EXPIRED", "this code has expired or was replaced; request a new code");
    throw new ApiError(422, "CODE_INVALID", "that code is not correct");
  }
}

@Controller("v1/me/phone")
export class PhoneController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(CONFIG) private readonly cfg: AppConfig,
      @Inject(Access) private readonly access: Access,
      @Inject(RateLimiter) private readonly limiter: RateLimiter,
      @Inject(SMS) private readonly sms: SmsSender,
  ) {}

  private get codes() {
    return new PhoneCodes(this.pool, this.cfg, this.sms, this.limiter);
  }

  /** Sets (or changes) my phone number and texts a verification code to it. */
  @Post()
  @HttpCode(202)
  async set(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    const { phone } = parse(Schemas.PhoneOnly, body);
    const codes = this.codes;
    codes.assertAvailable();
    await this.limiter.hit(`phone-set:${a.userId}`, 10, 3600);
    await codes.throttle(phone);
    return withTransaction(this.pool, async (c) => {
      const taken = await c.query(`SELECT 1 FROM users WHERE phone = $1 AND id <> $2 AND status <> 'DELETED'`, [phone, a.userId]);
      if (taken.rowCount) throw Errors.conflict("this number is already used by another account", "PHONE_TAKEN");
      const cur = await c.query<{ phone: string | null; verified: boolean }>(`SELECT phone, phone_verified_at IS NOT NULL AS verified FROM users WHERE id = $1 FOR UPDATE`, [a.userId]);
      if (cur.rows[0]?.phone === phone && cur.rows[0].verified) return { alreadyVerified: true, sentTo: null };
      if (cur.rows[0]?.phone !== phone) {
        // A new number starts unverified.
        await c.query(`UPDATE users SET phone = $2, phone_verified_at = NULL WHERE id = $1`, [a.userId, phone]);
      }
      const sent = await codes.issue(c, { phone, userId: a.userId, purpose: "VERIFY_PHONE" });
      return { alreadyVerified: false, ...sent };
    });
  }

  /** Confirms my phone number with the code texted to it. */
  @Post("verify")
  @HttpCode(200)
  async verify(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    const { code } = parse(Schemas.PhoneCode, body);
    await this.limiter.hit(`phone-verify:${a.userId}`, 20, 3600);
    const { rows } = await this.pool.query<{ phone: string | null }>(`SELECT phone FROM users WHERE id = $1`, [a.userId]);
    const phone = rows[0]?.phone;
    if (!phone) throw Errors.rule("add a phone number first", "NO_PHONE");
    await this.codes.consume({ phone, purpose: "VERIFY_PHONE", code, userId: a.userId });
    const welcomeCreditKobo = await withTransaction(this.pool, async (c) => {
      const r = await c.query(`UPDATE users SET phone_verified_at = now() WHERE id = $1 AND phone = $2`, [a.userId, phone]);
      if (!r.rowCount) throw Errors.conflict("your phone number changed; request a new code", "PHONE_CHANGED");
      await audit(c, { actorUserId: a.userId, actorKind: "STUDENT", action: "auth.phone_verified", entityType: "user", entityId: a.userId, requestId: req.id });
      // A university's welcome credit is given once, on a confirmed phone (cheap emails cannot farm it).
      return this.cfg.WALLET_ENABLED ? grantWelcomeCredit(c, a.userId) : 0;
    });
    return { verified: true, phone, welcomeCreditKobo };
  }
}
