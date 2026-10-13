import { Body, Controller, Get, HttpCode, Inject, Injectable, Patch, Post, Req, Res } from "@nestjs/common";
import argon2 from "argon2";
import type { Response } from "express";
import type { Pool } from "pg";
import { withTransaction } from "../../../../packages/data/src/index.js";
import type { AppConfig } from "../config.js";
import { audit, Access } from "../http/access.js";
import { SESSION_COOKIE, type PfRequest } from "../http/context.js";
import {
  base32Decode,
  csrfTokenFor,
  decryptSecret,
  encryptSecret,
  hotp,
  newTotpSecret,
  otpauthUri,
  randomToken,
  sha256,
  TOTP_STEP_SECONDS,
  totpStep,
  verifyTotp,
} from "../http/crypto.js";
import { devConsole } from "../infra/dev-console.js";
import { ApiError, Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { parse } from "../http/validate.js";
import type { Mailer } from "../infra/mailer.js";
import type { SmsSender } from "../infra/sms.js";
import { CONFIG, MAILER, PG_POOL, SMS } from "../infra/tokens.js";
import { PhoneCodes } from "./phone.js";

const ARGON2 = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const STUDENT_SESSION_DAYS = 14;
const STAFF_SESSION_HOURS = 12;
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  readonly dummyHash: Promise<string>;

  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(CONFIG) private readonly cfg: AppConfig,
      @Inject(MAILER) private readonly mailer: Mailer,
  ) {
    // Verified against when the email is unknown, so timing doesn't reveal accounts.
    this.dummyHash = argon2.hash(randomToken(), ARGON2);
  }

  hashPassword(p: string): Promise<string> {
    return argon2.hash(p, ARGON2);
  }

  async isStaff(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ staff: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM shop_memberships WHERE user_id = $1 AND revoked_at IS NULL)
                  OR EXISTS (SELECT 1 FROM university_staff WHERE user_id = $1 AND revoked_at IS NULL)
                  OR EXISTS (SELECT 1 FROM users WHERE id = $1 AND platform_role IS NOT NULL) AS staff`,
        [userId],
    );
    return rows[0]!.staff;
  }

  async createSession(userId: string, req: PfRequest, mfaVerified: boolean): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const staff = await this.isStaff(userId);
    const expiresAt = new Date(Date.now() + (staff ? STAFF_SESSION_HOURS * 3_600_000 : STUDENT_SESSION_DAYS * 86_400_000));
    await this.pool.query(
        `INSERT INTO sessions (user_id, token_hash, mfa_verified_at, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, sha256(token), mfaVerified ? new Date() : null, req.ip ?? null, (req.header("user-agent") ?? "").slice(0, 512), expiresAt],
    );
    return { token, expiresAt };
  }

  setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: this.cfg.cookieSecure, sameSite: "lax", path: "/", expires: expiresAt });
  }

  async sendEmailVerification(userId: string, email: string): Promise<void> {
    const token = randomToken(32);
    await this.pool.query(
        `INSERT INTO account_recovery_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'EMAIL_VERIFY', $2, now() + interval '24 hours')`,
        [userId, sha256(token)],
    );
    await this.mailer.send({
      to: email,
      subject: "Confirm your PrintFlow email",
      text: `Confirm your email address: ${this.cfg.PUBLIC_WEB_URL}/verify-email?token=${token}\nThis link expires in 24 hours.`,
    });
  }

  async consumeToken(purpose: "PASSWORD_RESET" | "EMAIL_VERIFY", token: string): Promise<string> {
    const { rows } = await this.pool.query<{ user_id: string }>(
        `UPDATE account_recovery_tokens SET used_at = now()
         WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
           RETURNING user_id`,
        [sha256(token), purpose],
    );
    if (!rows[0]) throw Errors.rule("this link is invalid or has expired", "TOKEN_INVALID");
    return rows[0].user_id;
  }

  async describe(userId: string) {
    const [user, student, shops, uni, mfa] = await Promise.all([
      this.pool.query(
          `SELECT id, email, full_name AS "fullName", phone, platform_role AS "platformRole", email_verified_at IS NOT NULL AS "emailVerified",
                  phone_verified_at IS NOT NULL AS "phoneVerified"
           FROM users WHERE id = $1`,
          [userId],
      ),
      this.pool.query(
          `SELECT sp.university_id AS "universityId", u.name AS "universityName", sp.campus_id AS "campusId", c.name AS "campusName",
                  sp.department_id AS "departmentId", sp.matric_number AS "matricNumber"
           FROM student_profiles sp JOIN universities u ON u.id = sp.university_id JOIN campuses c ON c.id = sp.campus_id
           WHERE sp.user_id = $1`,
          [userId],
      ),
      this.pool.query(
          `SELECT m.id AS "membershipId", m.shop_id AS "shopId", s.name AS "shopName", s.status AS "shopStatus", m.university_id AS "universityId",
                  m.role, m.permissions
           FROM shop_memberships m JOIN shops s ON s.id = m.shop_id WHERE m.user_id = $1 AND m.revoked_at IS NULL AND s.status <> 'REMOVED'
           ORDER BY s.name`,
          [userId],
      ),
      this.pool.query(
          `SELECT us.university_id AS "universityId", u.name AS "universityName", us.role
           FROM university_staff us JOIN universities u ON u.id = us.university_id WHERE us.user_id = $1 AND us.revoked_at IS NULL`,
          [userId],
      ),
      this.pool.query(`SELECT confirmed_at IS NOT NULL AS confirmed FROM mfa_factors WHERE user_id = $1 AND kind = 'TOTP'`, [userId]),
    ]);
    return {
      user: user.rows[0],
      student: student.rows[0] ?? null,
      shopMemberships: shops.rows,
      universityRoles: uni.rows,
      mfa: { totpEnrolled: Boolean(mfa.rows[0]?.confirmed) },
    };
  }

  /**
   * Development only (DEV_CONSOLE): prints the current authenticator code, so staff
   * two-step sign-in can be tested without an authenticator app.
   */
  printTotp(email: string, secretB32: string, why: string): void {
    if (!this.cfg.devConsole) return;
    const key = base32Decode(secretB32);
    const step = totpStep();
    const left = TOTP_STEP_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_STEP_SECONDS);
    devConsole(`authenticator code (${why})`, [
      { label: "Account", value: email },
      { label: "Code", value: hotp(key, step) },
      { label: "Valid for", value: `${left}s more` },
      { label: "Next code", value: hotp(key, step + 1) },
      { label: "Secret", value: secretB32 },
    ]);
  }

  /** Development only: looks up the user's authenticator and prints its current code. */
  async printTotpFor(userId: string, why: string): Promise<void> {
    if (!this.cfg.devConsole) return;
    const { rows } = await this.pool.query<{ email: string; secret_ciphertext: Buffer }>(
        `SELECT u.email, f.secret_ciphertext FROM mfa_factors f JOIN users u ON u.id = f.user_id WHERE f.user_id = $1 AND f.kind = 'TOTP'`,
        [userId],
    );
    if (rows[0]) this.printTotp(rows[0].email, decryptSecret(this.cfg.MFA_ENCRYPTION_KEY, rows[0].secret_ciphertext), why);
  }

  /** Creates a session after a successful first factor and shapes the sign-in response. */
  async signedIn(userId: string, req: PfRequest, res: Response, client: "web" | "mobile", mfaCode: string | undefined) {
    await this.pool.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId]);
    const mfa = await this.pool.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [userId]);
    let mfaVerified = false;
    if (mfa.rowCount && mfaCode) {
      mfaVerified = await this.verifyMfaCode(userId, mfaCode);
      if (!mfaVerified) {
        await this.printTotpFor(userId, "that code was wrong; use this one");
        throw Errors.rule("the authenticator code is incorrect", "MFA_INVALID");
      }
    }
    const s = await this.createSession(userId, req, mfaVerified);
    if (client === "web") this.setSessionCookie(res, s.token, s.expiresAt);
    const staff = await this.isStaff(userId);
    if (staff && this.cfg.REQUIRE_STAFF_MFA && mfa.rowCount && !mfaVerified) await this.printTotpFor(userId, "sign-in");
    return {
      ...(await this.describe(userId)),
      csrfToken: csrfTokenFor(this.cfg.SESSION_SECRET, s.token),
      session: { expiresAt: s.expiresAt, mfaVerified, mfaRequired: staff && this.cfg.REQUIRE_STAFF_MFA, mfaEnrolled: Boolean(mfa.rowCount) },
      ...(client === "mobile" ? { sessionToken: s.token } : {}),
    };
  }

  async verifyMfaCode(userId: string, code: string): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string; secret_ciphertext: Buffer; last_used_step: string | null; confirmed_at: Date | null }>(
          `SELECT id, secret_ciphertext, last_used_step, confirmed_at FROM mfa_factors WHERE user_id = $1 AND kind = 'TOTP' FOR UPDATE`,
          [userId],
      );
      const f = rows[0];
      if (!f) return false;
      const step = verifyTotp(decryptSecret(this.cfg.MFA_ENCRYPTION_KEY, f.secret_ciphertext), code);
      // Each code is accepted once: replaying a code (or an older one) fails.
      if (step === null || (f.last_used_step !== null && step <= Number(f.last_used_step))) return false;
      await c.query(`UPDATE mfa_factors SET last_used_step = $2, confirmed_at = COALESCE(confirmed_at, now()) WHERE id = $1`, [f.id, step]);
      return true;
    });
  }
}

@Controller("v1/auth")
export class AuthController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(CONFIG) private readonly cfg: AppConfig,
      @Inject(AuthService) private readonly auth: AuthService,
      @Inject(Access) private readonly access: Access,
      @Inject(RateLimiter) private readonly limiter: RateLimiter,
      @Inject(MAILER) private readonly mailer: Mailer,
      @Inject(SMS) private readonly sms: SmsSender,
  ) {}

  private get codes() {
    return new PhoneCodes(this.pool, this.cfg, this.sms, this.limiter);
  }

  @Post("register")
  async register(@Req() req: PfRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    await this.limiter.hit(`register:ip:${req.ip}`, 10, 3600);
    const input = parse(Schemas.RegisterStudent, body);
    const hash = await this.auth.hashPassword(input.password);
    if (input.password.toLowerCase().includes(input.email.split("@")[0]!)) throw Errors.rule("your password must not contain your email name", "WEAK_PASSWORD");

    const userId = await withTransaction(this.pool, async (c) => {
      const uni = await c.query(`SELECT 1 FROM universities WHERE id = $1 AND status = 'ACTIVE'`, [input.universityId]);
      if (!uni.rowCount) throw Errors.rule("this university is not open for registration yet", "UNIVERSITY_NOT_ACTIVE");
      const exists = await c.query(`SELECT 1 FROM users WHERE email = $1 AND status <> 'DELETED'`, [input.email]);
      if (exists.rowCount) throw Errors.conflict("an account with this email already exists", "EMAIL_TAKEN");
      if (input.phone) {
        const phoneTaken = await c.query(`SELECT 1 FROM users WHERE phone = $1 AND status <> 'DELETED'`, [input.phone]);
        if (phoneTaken.rowCount) throw Errors.conflict("an account with this phone number already exists", "PHONE_TAKEN");
      }
      const u = await c.query<{ id: string }>(`INSERT INTO users (email, full_name, password_hash, phone) VALUES ($1, $2, $3, $4) RETURNING id`, [
        input.email,
        input.fullName,
        hash,
        input.phone ?? null,
      ]);
      const id = u.rows[0]!.id;
      await c.query(`INSERT INTO student_profiles (user_id, university_id, campus_id, department_id, matric_number) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        input.universityId,
        input.campusId,
        input.departmentId ?? null,
        input.matricNumber ?? null,
      ]);
      await audit(c, { universityId: input.universityId, actorUserId: id, actorKind: "STUDENT", action: "auth.registered", entityType: "user", entityId: id, requestId: req.id });
      return id;
    });
    await this.auth.sendEmailVerification(userId, input.email);
    // Text a verification code straight away, so the student can confirm by phone or email.
    let phoneCode: unknown = null;
    if (input.phone && this.codes.available) {
      try {
        await this.codes.throttle(input.phone);
        phoneCode = await this.codes.issue(this.pool, { phone: input.phone, userId, purpose: "VERIFY_PHONE" });
      } catch {
        phoneCode = null; // they can request a code again from their account
      }
    }
    const s = await this.auth.createSession(userId, req, false);
    if (input.client === "web") this.auth.setSessionCookie(res, s.token, s.expiresAt);
    res.status(201);
    return {
      ...(await this.auth.describe(userId)),
      csrfToken: csrfTokenFor(this.cfg.SESSION_SECRET, s.token),
      phoneCode,
      ...(input.client === "mobile" ? { sessionToken: s.token } : {}),
    };
  }

  @Post("login")
  @HttpCode(200)
  async login(@Req() req: PfRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = parse(Schemas.Login, body);
    const id = input.email ?? input.phone!;
    await this.limiter.hit(`login:ip:${req.ip}`, 30, 900);
    await this.limiter.hit(`login:id:${id}`, 10, 900);

    // A phone signs in only once it has been verified by SMS.
    const { rows } = await this.pool.query<{ id: string; password_hash: string; status: string; locked_until: Date | null }>(
        input.email
            ? `SELECT id, password_hash, status, locked_until FROM users WHERE email = $1 AND status <> 'DELETED'`
            : `SELECT id, password_hash, status, locked_until FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND status <> 'DELETED'`,
        [id],
    );
    const u = rows[0];
    const ok = await argon2.verify(u?.password_hash ?? (await this.auth.dummyHash), input.password).catch(() => false);
    if (!u || !ok || u.status !== "ACTIVE" || (u.locked_until && u.locked_until > new Date())) {
      if (u && !ok) {
        await this.pool.query(
            `UPDATE users SET failed_login_count = failed_login_count + 1,
                              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
             WHERE id = $1`,
            [u.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
        );
      }
      // Same response for unknown accounts, wrong passwords, locked or disabled.
      throw new ApiError(401, "INVALID_CREDENTIALS", input.email ? "email or password is incorrect" : "phone number or password is incorrect");
    }
    return this.auth.signedIn(u.id, req, res, input.client, input.mfaCode);
  }

  /**
   * Texts a sign-in code. The answer is identical whether or not the number
   * belongs to an account, and sending happens in the background, so this
   * cannot be used to discover who is registered.
   */
  @Post("otp/request")
  @HttpCode(202)
  async otpRequest(@Req() req: PfRequest, @Body() body: unknown) {
    const { phone } = parse(Schemas.PhoneOnly, body);
    const codes = this.codes;
    codes.assertAvailable();
    await this.limiter.hit(`otp-request:ip:${req.ip}`, 10, 3600);
    await codes.throttle(phone);
    const { rows } = await this.pool.query<{ id: string }>(
        `SELECT id FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND status = 'ACTIVE'`,
        [phone],
    );
    if (rows[0]) await codes.issue(this.pool, { phone, userId: rows[0].id, purpose: "SIGN_IN" });
    return { message: "if this number is verified on a PrintFlow account, we have sent a code", ...codes.receipt(phone) };
  }

  @Post("otp/verify")
  @HttpCode(200)
  async otpVerify(@Req() req: PfRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = parse(Schemas.OtpSignIn, body);
    await this.limiter.hit(`otp-verify:ip:${req.ip}`, 30, 900);
    await this.limiter.hit(`otp-verify:phone:${input.phone}`, 10, 900);
    let userId: string | null;
    try {
      userId = await this.codes.consume({ phone: input.phone, purpose: "SIGN_IN", code: input.code });
    } catch (e) {
      // Do not reveal whether a code was ever sent to this number.
      if (e instanceof ApiError && e.code === "CODE_LOCKED") throw e;
      throw new ApiError(401, "INVALID_CODE", "that code is not correct or has expired");
    }
    const u = await this.pool.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND phone = $2 AND phone_verified_at IS NOT NULL AND status = 'ACTIVE' AND (locked_until IS NULL OR locked_until < now())`,
        [userId, input.phone],
    );
    if (!u.rows[0]) throw new ApiError(401, "INVALID_CODE", "that code is not correct or has expired");
    await audit(this.pool, { actorUserId: u.rows[0].id, actorKind: "SYSTEM", action: "auth.sms_sign_in", entityType: "user", entityId: u.rows[0].id, requestId: req.id, ip: req.ip });
    return this.auth.signedIn(u.rows[0].id, req, res, input.client, input.mfaCode);
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: PfRequest, @Res({ passthrough: true }) res: Response) {
    if (req.auth) await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [req.auth.sessionId]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  @Post("logout-all")
  @HttpCode(204)
  async logoutAll(@Req() req: PfRequest, @Res({ passthrough: true }) res: Response) {
    const a = this.access.user(req);
    await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [a.userId]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  /** Session probe for public pages: never an error, so signed-out visitors see no 401s. */
  @Get("session")
  async session(@Req() req: PfRequest) {
    if (!req.auth) return { authenticated: false };
    return { authenticated: true, ...(await this.me(req)) };
  }

  @Get("me")
  async me(@Req() req: PfRequest) {
    const a = this.access.user(req);
    const staff = await this.auth.isStaff(a.userId);
    return {
      ...(await this.auth.describe(a.userId)),
      csrfToken: csrfTokenFor(this.cfg.SESSION_SECRET, a.sessionToken),
      session: { mfaVerified: a.mfaVerified, mfaRequired: staff && this.cfg.REQUIRE_STAFF_MFA },
    };
  }

  @Post("verify-email")
  @HttpCode(200)
  async verifyEmail(@Req() req: PfRequest, @Body() body: unknown) {
    await this.limiter.hit(`verify:ip:${req.ip}`, 20, 3600);
    const { token } = parse(Schemas.Token, body);
    const userId = await this.auth.consumeToken("EMAIL_VERIFY", token);
    await this.pool.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [userId]);
    return { verified: true };
  }

  @Post("verify-email/resend")
  @HttpCode(202)
  async resend(@Req() req: PfRequest) {
    const a = this.access.user(req);
    await this.limiter.hit(`verify-resend:${a.userId}`, 3, 3600);
    if (!a.emailVerified) await this.auth.sendEmailVerification(a.userId, a.email);
    return { sent: true };
  }

  @Post("password-reset/request")
  @HttpCode(202)
  async resetRequest(@Req() req: PfRequest, @Body() body: unknown) {
    const input = parse(Schemas.ResetRequest, body);
    await this.limiter.hit(`reset:ip:${req.ip}`, 10, 3600);
    if (input.phone) {
      // By phone: the same SMS sign-in code is used to set a new password.
      const codes = this.codes;
      codes.assertAvailable();
      await codes.throttle(input.phone);
      const { rows } = await this.pool.query<{ id: string }>(
          `SELECT id FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND status = 'ACTIVE'`,
          [input.phone],
      );
      if (rows[0]) await codes.issue(this.pool, { phone: input.phone, userId: rows[0].id, purpose: "SIGN_IN" });
      return { message: "if this number is verified on a PrintFlow account, we have sent a code", ...codes.receipt(input.phone) };
    }
    const email = input.email!;
    await this.limiter.hit(`reset:email:${email}`, 3, 3600);
    const { rows } = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status = 'ACTIVE'`, [email]);
    if (rows[0]) {
      const token = randomToken(32);
      await this.pool.query(
          `INSERT INTO account_recovery_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'PASSWORD_RESET', $2, now() + interval '1 hour')`,
          [rows[0].id, sha256(token)],
      );
      await this.mailer.send({
        to: email,
        subject: "Reset your PrintFlow password",
        text: `Reset your password: ${this.cfg.PUBLIC_WEB_URL}/reset-password?token=${token}\nThis link expires in 1 hour. If you did not ask for this, ignore this email.`,
      });
    }
    // Always the same answer, whether or not the account exists.
    return { message: "if an account exists for that email, a reset link has been sent" };
  }

  @Post("password-reset/confirm")
  @HttpCode(200)
  async resetConfirm(@Req() req: PfRequest, @Body() body: unknown) {
    await this.limiter.hit(`reset-confirm:ip:${req.ip}`, 20, 3600);
    const input = parse(Schemas.ResetConfirm, body);
    let userId: string;
    if ("token" in input) {
      userId = await this.auth.consumeToken("PASSWORD_RESET", input.token);
    } else {
      await this.limiter.hit(`otp-verify:phone:${input.phone}`, 10, 900);
      let owner: string | null = null;
      try {
        owner = await this.codes.consume({ phone: input.phone, purpose: "SIGN_IN", code: input.code });
      } catch (e) {
        if (e instanceof ApiError && e.code === "CODE_LOCKED") throw e;
      }
      const u = owner
          ? await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE id = $1 AND phone = $2 AND phone_verified_at IS NOT NULL AND status = 'ACTIVE'`, [owner, input.phone])
          : null;
      if (!u?.rows[0]) throw Errors.rule("that code is not correct or has expired", "TOKEN_INVALID");
      userId = u.rows[0].id;
    }
    const hash = await this.auth.hashPassword(input.newPassword);
    await withTransaction(this.pool, async (c) => {
      await c.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, hash]);
      // A reset signs out every device.
      await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await c.query(`UPDATE account_recovery_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'PASSWORD_RESET' AND used_at IS NULL`, [userId]);
      await audit(c, { actorUserId: userId, actorKind: "STUDENT", action: "auth.password_reset", entityType: "user", entityId: userId, requestId: req.id });
    });
    return { reset: true };
  }

  @Post("password/change")
  @HttpCode(200)
  async changePassword(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    const input = parse(Schemas.ChangePassword, body);
    const { rows } = await this.pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [a.userId]);
    if (!(await argon2.verify(rows[0]!.password_hash, input.currentPassword))) throw Errors.rule("current password is incorrect", "INVALID_CREDENTIALS");
    const hash = await this.auth.hashPassword(input.newPassword);
    await this.pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [a.userId, hash]);
    await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [a.userId, a.sessionId]);
    return { changed: true };
  }

  @Post("mfa/totp/setup")
  @HttpCode(200)
  async totpSetup(@Req() req: PfRequest) {
    const a = this.access.user(req);
    const existing = await this.pool.query(`SELECT confirmed_at FROM mfa_factors WHERE user_id = $1 AND kind = 'TOTP'`, [a.userId]);
    if (existing.rows[0]?.confirmed_at) throw Errors.conflict("an authenticator is already set up", "MFA_ALREADY_ENROLLED");
    const secret = newTotpSecret();
    await this.pool.query(
        `INSERT INTO mfa_factors (user_id, kind, secret_ciphertext) VALUES ($1, 'TOTP', $2)
       ON CONFLICT (user_id) WHERE kind = 'TOTP' DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, last_used_step = NULL`,
        [a.userId, encryptSecret(this.cfg.MFA_ENCRYPTION_KEY, secret)],
    );
    this.auth.printTotp(a.email, secret, "setup: add the secret to an authenticator app, or type the code");
    return { secret, otpauthUri: otpauthUri(secret, a.email) };
  }

  @Post("mfa/totp/confirm")
  @HttpCode(200)
  async totpConfirm(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    await this.limiter.hit(`mfa:${a.userId}`, 10, 300);
    const { code } = parse(Schemas.MfaCode, body);
    if (!(await this.auth.verifyMfaCode(a.userId, code))) {
      await this.auth.printTotpFor(a.userId, "that code was wrong; use this one");
      throw Errors.rule("the authenticator code is incorrect", "MFA_INVALID");
    }
    await this.pool.query(`UPDATE sessions SET mfa_verified_at = now() WHERE id = $1`, [a.sessionId]);
    await audit(this.pool, { actorUserId: a.userId, actorKind: "SYSTEM", action: "auth.mfa_enrolled", entityType: "user", entityId: a.userId, requestId: req.id });
    return { enrolled: true, mfaVerified: true };
  }

  @Post("mfa/verify")
  @HttpCode(200)
  async mfaVerify(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    await this.limiter.hit(`mfa:${a.userId}`, 10, 300);
    const { code } = parse(Schemas.MfaCode, body);
    const enrolled = await this.pool.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [a.userId]);
    if (!enrolled.rowCount) throw Errors.rule("set up an authenticator first", "MFA_NOT_ENROLLED");
    if (!(await this.auth.verifyMfaCode(a.userId, code))) {
      await this.auth.printTotpFor(a.userId, "that code was wrong; use this one");
      throw Errors.rule("the authenticator code is incorrect", "MFA_INVALID");
    }
    await this.pool.query(`UPDATE sessions SET mfa_verified_at = now() WHERE id = $1`, [a.sessionId]);
    return { mfaVerified: true };
  }
}

@Controller("v1/me")
export class MeController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(AuthService) private readonly auth: AuthService,
      @Inject(Access) private readonly access: Access,
  ) {}

  @Patch("profile")
  async update(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    const input = parse(Schemas.UpdateProfile, body);
    await withTransaction(this.pool, async (c) => {
      // Phone numbers change only through /v1/me/phone, which verifies them by SMS.
      if (input.fullName !== undefined) {
        await c.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [a.userId, input.fullName]);
      }
      if (input.campusId !== undefined || input.departmentId !== undefined || input.matricNumber !== undefined) {
        const r = await c.query(
            `UPDATE student_profiles SET campus_id = COALESCE($2, campus_id),
                  department_id = CASE WHEN $3::boolean THEN $4 ELSE department_id END,
                  matric_number = CASE WHEN $5::boolean THEN $6 ELSE matric_number END
            WHERE user_id = $1`,
            [a.userId, input.campusId ?? null, input.departmentId !== undefined, input.departmentId ?? null, input.matricNumber !== undefined, input.matricNumber ?? null],
        );
        if (!r.rowCount) throw Errors.rule("only students have a campus profile", "NOT_A_STUDENT");
      }
    });
    return this.auth.describe(a.userId);
  }
}
