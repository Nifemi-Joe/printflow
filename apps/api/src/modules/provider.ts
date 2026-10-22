import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Pool } from "pg";
import {
  acceptUndertaking,
  failCheck,
  matchRoll,
  passCheck,
  providerChecks,
  providerTrust,
  replaceRoll,
  requestCheck,
  revokeCheck,
  suspendProvider,
  withTransaction,
} from "../../../../packages/data/src/index.js";
import {
  checkMatricFormat,
  emailOnDomain,
  generateOtp,
  MatricError,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  surnameCandidates,
  surnameHash,
  UNDERTAKING_TEXT,
  UNDERTAKING_VERSION,
  undertakingSha256,
  type VerificationCheck,
} from "../../../../packages/domain/src/index.js";
import type { AppConfig } from "../config.js";
import { Access, audit, type UniversityStaffContext } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { ApiError, Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { parse, uuid } from "../http/validate.js";
import { devConsole } from "../infra/dev-console.js";
import { CONFIG, MAILER, PG_POOL } from "../infra/tokens.js";
import type { Mailer } from "../../../../packages/providers/src/index.js";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Codes sent to a provider's student email. Stored only as an HMAC bound to the shop. */
function hashEmailCode(secret: string, shopId: string, email: string, code: string): string {
  return createHmac("sha256", secret).update(`provider-email:${shopId}:${email}:${code}`).digest("hex");
}

function emailCodeMatches(secret: string, shopId: string, email: string, code: string, stored: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hashEmailCode(secret, shopId, email, code), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Identity verification for the people behind a print shop.
 *
 * A student with a printer can register in minutes, but students sending them documents
 * are told exactly what has been proven about them, and an unproven provider is limited
 * until it is. Every check that grants trust leaves a record of who decided it and on
 * what evidence.
 */
@Controller("v1/shops/:shopId/verification")
export class ProviderVerificationController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Access) private readonly access: Access,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /** Verification is about who owns the shop, so only the owner can drive it. */
  private async owner(req: PfRequest, shopIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw));
    if (m.role !== "OWNER") throw Errors.forbidden("only the shop owner can manage verification");
    return m;
  }

  private async policy(universityId: string) {
    const { rows } = await this.pool.query<{
      student_providers_allowed: boolean;
      student_email_domains: string[];
      matric_pattern: string | null;
      provider_reverify_days: number;
      student_provider_cap_kobo: string;
    }>(
      `SELECT student_providers_allowed, student_email_domains, matric_pattern, provider_reverify_days, student_provider_cap_kobo
         FROM universities WHERE id = $1`,
      [universityId],
    );
    const p = rows[0];
    if (!p) throw Errors.notFound("university");
    return p;
  }

  @Get()
  async status(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string) {
    const m = await this.owner(req, shopIdRaw);
    const [trust, checks, policy] = await Promise.all([providerTrust(this.pool, m.shopId), providerChecks(this.pool, m.shopId), this.policy(m.universityId)]);
    const passed = new Set(checks.filter((c) => c.status === "PASSED").map((c) => c.kind));
    const pending = new Set(checks.filter((c) => c.status === "PENDING").map((c) => c.kind));
    return {
      shopId: m.shopId,
      kind: trust.kind,
      level: trust.level,
      badge: trust.badge,
      limits: trust.limits,
      undertaking: {
        required: trust.kind === "STUDENT_RUN",
        accepted: trust.undertakingAccepted,
        version: UNDERTAKING_VERSION,
        text: UNDERTAKING_TEXT,
      },
      studentEmailDomains: policy.student_email_domains,
      matricPattern: policy.matric_pattern,
      renewEveryDays: policy.provider_reverify_days,
      // What the owner can do next, so the screen does not have to work it out.
      next: [
        trust.kind === "STUDENT_RUN" && !trust.undertakingAccepted ? { step: "UNDERTAKING", label: "Accept the confidentiality undertaking" } : null,
        trust.kind === "STUDENT_RUN" && !passed.has("STUDENT_EMAIL") && policy.student_email_domains.length > 0
          ? { step: "STUDENT_EMAIL", label: `Confirm a ${policy.student_email_domains[0]} email address` }
          : null,
        trust.kind === "STUDENT_RUN" && !passed.has("MATRIC_NUMBER")
          ? { step: "MATRIC_NUMBER", label: pending.has("MATRIC_NUMBER") ? "Your matric number is with the university" : "Confirm your matric number" }
          : null,
      ].filter(Boolean),
      checks: checks.map((c) => ({ ...c, evidence: undefined })),
    };
  }

  @Post("undertaking")
  @HttpCode(200)
  async undertaking(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.owner(req, shopIdRaw);
    const input = parse(Schemas.AcceptUndertaking, body);
    if (input.version !== UNDERTAKING_VERSION) throw Errors.conflict("the undertaking has changed; reload and read it again", "UNDERTAKING_VERSION");
    const sha = undertakingSha256();
    await withTransaction(this.pool, async (c) => {
      await acceptUndertaking(c, { shopId: m.shopId, universityId: m.universityId, userId: m.auth.userId, version: UNDERTAKING_VERSION, textSha256: sha, ip: req.ip ?? null });
      await audit(c, {
        universityId: m.universityId,
        shopId: m.shopId,
        actorUserId: m.auth.userId,
        actorKind: "SHOP_STAFF",
        action: "provider.undertaking_accepted",
        entityType: "shop",
        entityId: m.shopId,
        requestId: req.id,
        ip: req.ip,
        details: { version: UNDERTAKING_VERSION, textSha256: sha },
      });
    });
    return { accepted: true, version: UNDERTAKING_VERSION };
  }

  /** Sends a 6-digit code to an address on the university's student-mail domain. */
  @Post("email")
  @HttpCode(202)
  async sendEmailCode(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.owner(req, shopIdRaw);
    const { email } = parse(Schemas.ProviderEmail, body);
    const policy = await this.policy(m.universityId);
    if (policy.student_email_domains.length === 0) {
      throw Errors.unavailable("this university has not set a student email domain, so this check is not available", "NO_STUDENT_DOMAIN");
    }
    if (!emailOnDomain(email, policy.student_email_domains)) {
      throw Errors.rule(`use your university address, ending in ${policy.student_email_domains.map((d) => `@${d}`).join(" or ")}`, "EMAIL_DOMAIN");
    }
    // The same address cannot stand for two shops at once.
    const taken = await this.pool.query(
      `SELECT 1 FROM provider_verifications WHERE kind = 'STUDENT_EMAIL' AND status = 'PASSED' AND lower(subject) = lower($1) AND shop_id <> $2`,
      [email, m.shopId],
    );
    if (taken.rowCount) throw Errors.conflict("that address is already confirmed for another shop", "EMAIL_IN_USE");

    await this.limiter.hit(`provider-email-cooldown:${m.shopId}`, 1, OTP_RESEND_COOLDOWN_MS / 1000);
    await this.limiter.hit(`provider-email-send:${m.shopId}`, 5, 3600);
    const code = generateOtp();
    await withTransaction(this.pool, async (c) => {
      await c.query(`UPDATE provider_email_codes SET revoked_at = now() WHERE shop_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [m.shopId]);
      await c.query(
        `INSERT INTO provider_email_codes (shop_id, university_id, email, code_hash, max_attempts, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
        [m.shopId, m.universityId, email, hashEmailCode(this.cfg.SESSION_SECRET, m.shopId, email, code), OTP_MAX_ATTEMPTS, OTP_TTL_MS / 1000],
      );
    });
    await this.mailer.send({
      to: email,
      subject: "PrintFlow: confirm your university email",
      text: `Your PrintFlow code is ${code}.\n\nIt confirms that "${m.shopId}" is run by a student at your university, and expires in 10 minutes.\nIf you did not ask to run a print shop on PrintFlow, ignore this email and tell your university.`,
    });
    if (this.cfg.devConsole) {
      devConsole("provider email code (not sent)", [
        { label: "To", value: email },
        { label: "Code", value: code },
      ]);
    }
    return { sentTo: email, expiresInSeconds: OTP_TTL_MS / 1000, resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
  }

  @Post("email/confirm")
  @HttpCode(200)
  async confirmEmail(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.owner(req, shopIdRaw);
    const { code } = parse(Schemas.PhoneCode, body);
    await this.limiter.hit(`provider-email-verify:${m.shopId}`, 20, 3600);
    const policy = await this.policy(m.universityId);
    const email = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string; email: string; code_hash: string; attempts: number; max_attempts: number; expired: boolean }>(
        `SELECT id, email, code_hash, attempts, max_attempts, expires_at <= now() AS expired FROM provider_email_codes
          WHERE shop_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [m.shopId],
      );
      const row = rows[0];
      if (!row || row.expired) throw new ApiError(422, "CODE_EXPIRED", "this code has expired or was replaced; request a new one");
      if (row.attempts >= row.max_attempts) throw new ApiError(422, "CODE_LOCKED", "too many wrong attempts; request a new code");
      if (!emailCodeMatches(this.cfg.SESSION_SECRET, m.shopId, row.email, code, row.code_hash)) {
        await c.query(`UPDATE provider_email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        throw new ApiError(422, row.attempts + 1 >= row.max_attempts ? "CODE_LOCKED" : "CODE_INVALID", row.attempts + 1 >= row.max_attempts ? "too many wrong attempts; request a new code" : "that code is not correct");
      }
      await c.query(`UPDATE provider_email_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
      await passCheck(c, {
        shopId: m.shopId,
        universityId: m.universityId,
        kind: "STUDENT_EMAIL",
        subject: row.email,
        evidence: { method: "EMAIL_CODE", domain: row.email.slice(row.email.lastIndexOf("@") + 1) },
        decidedBy: null,
        validForDays: policy.provider_reverify_days,
      });
      await audit(c, {
        universityId: m.universityId,
        shopId: m.shopId,
        actorUserId: m.auth.userId,
        actorKind: "SHOP_STAFF",
        action: "provider.email_verified",
        entityType: "shop",
        entityId: m.shopId,
        requestId: req.id,
        ip: req.ip,
        details: { email: row.email },
      });
      return row.email;
    });
    const trust = await providerTrust(this.pool, m.shopId);
    return { verified: true, email, level: trust.level, badge: trust.badge };
  }

  /**
   * Submits a matric number. Where the university has uploaded its roll this settles
   * itself; otherwise it goes to the university to confirm against their records.
   */
  @Post("matric")
  @HttpCode(200)
  async matric(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.owner(req, shopIdRaw);
    const { matricNumber } = parse(Schemas.ProviderMatric, body);
    await this.limiter.hit(`provider-matric:${m.shopId}`, 10, 3600);
    const policy = await this.policy(m.universityId);
    let matric: string;
    try {
      matric = checkMatricFormat(matricNumber, policy.matric_pattern);
    } catch (e) {
      if (e instanceof MatricError) throw Errors.rule(e.message, e.code);
      throw e;
    }
    const claimed = await this.pool.query(
      `SELECT 1 FROM provider_verifications WHERE kind = 'MATRIC_NUMBER' AND status = 'PASSED' AND subject = $1 AND shop_id <> $2`,
      [matric, m.shopId],
    );
    if (claimed.rowCount) throw Errors.conflict("that matric number is already verified for another shop", "MATRIC_IN_USE");

    const { rows: who } = await this.pool.query<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [m.auth.userId]);
    const surnames = surnameCandidates(who[0]?.full_name ?? "");
    const matched = this.cfg.STUDENT_ROLL_PEPPER
      ? await matchRoll(this.pool, { universityId: m.universityId, matric, surnames, pepper: this.cfg.STUDENT_ROLL_PEPPER })
      : null;

    const outcome = await withTransaction(this.pool, async (c) => {
      if (matched === true) {
        await passCheck(c, {
          shopId: m.shopId,
          universityId: m.universityId,
          kind: "MATRIC_NUMBER",
          subject: matric,
          evidence: { method: "ROLL_MATCH", surnameMatched: true },
          decidedBy: null,
          validForDays: policy.provider_reverify_days,
        });
        return "VERIFIED" as const;
      }
      // No roll, or the roll disagrees: a person decides, with the reason recorded.
      await requestCheck(c, {
        shopId: m.shopId,
        universityId: m.universityId,
        kind: "MATRIC_NUMBER",
        subject: matric,
        evidence: matched === false ? { method: "ADMIN", rollChecked: true, rollMatched: false } : { method: "ADMIN", rollChecked: false },
      });
      return "PENDING_REVIEW" as const;
    });
    await audit(this.pool, {
      universityId: m.universityId,
      shopId: m.shopId,
      actorUserId: m.auth.userId,
      actorKind: "SHOP_STAFF",
      action: "provider.matric_submitted",
      entityType: "shop",
      entityId: m.shopId,
      requestId: req.id,
      ip: req.ip,
      details: { matricNumber: matric, outcome },
    });
    const trust = await providerTrust(this.pool, m.shopId);
    return {
      outcome,
      matricNumber: matric,
      level: trust.level,
      badge: trust.badge,
      message:
        outcome === "VERIFIED"
          ? "Your matric number matched your university's records."
          : "Your university will check this against their records. You can keep taking orders in the meantime, with the limits below.",
    };
  }
}

/** The university's side: the review queue, vouching, withdrawal and the student roll. */
@Controller("v1/admin/universities/:universityId/providers")
export class UniversityProvidersController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Access) private readonly access: Access,
  ) {}

  private ctx(req: PfRequest, raw: string, roles: UniversityStaffContext["role"][] = ["UNIVERSITY_ADMIN"]) {
    return this.access.university(req, parse(uuid, raw), roles);
  }

  @Get()
  async list(@Req() req: PfRequest, @Param("universityId") uid: string, @Query() query: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_SUPPORT", "UNIVERSITY_FINANCE"]);
    const { waiting } = parse(Schemas.ProviderListQuery, query ?? {});
    const { rows } = await this.pool.query(
      `SELECT s.id, s.name, s.kind, s.status, s.verification_level AS "level", s.accepting_orders AS "acceptingOrders",
              s.undertaking_accepted_at AS "undertakingAcceptedAt", c.name AS "campusName",
              o.full_name AS "ownerName", o.email AS "ownerEmail",
              (SELECT count(*)::int FROM provider_verifications v WHERE v.shop_id = s.id AND v.status = 'PENDING') AS "waitingChecks",
              (SELECT min(v.expires_at) FROM provider_verifications v WHERE v.shop_id = s.id AND v.status = 'PASSED') AS "renewalDue",
              (SELECT count(*)::int FROM orders ord WHERE ord.shop_id = s.id AND ord.status NOT IN ('AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED')) AS "ordersTaken"
         FROM shops s
         JOIN campuses c ON c.id = s.campus_id
         LEFT JOIN LATERAL (SELECT u2.full_name, u2.email FROM shop_memberships sm JOIN users u2 ON u2.id = sm.user_id
                             WHERE sm.shop_id = s.id AND sm.role = 'OWNER' AND sm.revoked_at IS NULL ORDER BY sm.id LIMIT 1) o ON true
        WHERE s.university_id = $1 AND s.status <> 'REMOVED'
          AND ($2::boolean IS NOT TRUE OR EXISTS (SELECT 1 FROM provider_verifications v WHERE v.shop_id = s.id AND v.status = 'PENDING'))
        ORDER BY (SELECT count(*) FROM provider_verifications v WHERE v.shop_id = s.id AND v.status = 'PENDING') DESC, s.kind, s.name`,
      [u.universityId, waiting ?? null],
    );
    return { items: rows };
  }

  @Get(":shopId")
  async detail(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("shopId") sid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_SUPPORT", "UNIVERSITY_FINANCE"]);
    const shopId = parse(uuid, sid);
    const owned = await this.pool.query(`SELECT 1 FROM shops WHERE id = $1 AND university_id = $2`, [shopId, u.universityId]);
    if (!owned.rowCount) throw Errors.notFound("shop");
    const [trust, checks, undertakings] = await Promise.all([
      providerTrust(this.pool, shopId),
      providerChecks(this.pool, shopId),
      this.pool.query(
        `SELECT p.version, p.accepted_at AS "acceptedAt", u2.full_name AS "name" FROM provider_undertakings p JOIN users u2 ON u2.id = p.user_id
          WHERE p.shop_id = $1 ORDER BY p.accepted_at DESC`,
        [shopId],
      ),
    ]);
    return { ...trust, checks, undertakings: undertakings.rows };
  }

  /**
   * Decides a check waiting on the university, or vouches for a provider outright.
   * A vouch is the strongest statement the product makes about a person, so it records
   * how the identity was confirmed.
   */
  @Post(":shopId/decide")
  @HttpCode(200)
  async decide(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("shopId") sid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const shopId = parse(uuid, sid);
    const input = parse(Schemas.DecideProviderCheck, body);
    const shop = await this.pool.query<{ id: string }>(`SELECT id FROM shops WHERE id = $1 AND university_id = $2`, [shopId, u.universityId]);
    if (!shop.rowCount) throw Errors.notFound("shop");
    const { rows: policy } = await this.pool.query<{ provider_reverify_days: number }>(`SELECT provider_reverify_days FROM universities WHERE id = $1`, [u.universityId]);
    const days = policy[0]!.provider_reverify_days;

    await withTransaction(this.pool, async (c) => {
      if (input.decision === "REJECT") {
        const pending = await c.query<{ id: string }>(`SELECT id FROM provider_verifications WHERE shop_id = $1 AND kind = $2 AND status = 'PENDING' FOR UPDATE`, [shopId, input.check]);
        if (!pending.rows[0]) throw Errors.rule("there is no such check waiting for a decision", "CHECK_NOT_PENDING");
        await failCheck(c, { checkId: pending.rows[0].id, decidedBy: u.auth.userId, note: input.note });
      } else {
        const pending = await c.query<{ subject: string }>(`SELECT subject FROM provider_verifications WHERE shop_id = $1 AND kind = $2 AND status = 'PENDING'`, [shopId, input.check]);
        const subject = pending.rows[0]?.subject ?? input.subject;
        if (!subject) throw Errors.badRequest("say what you confirmed (the matric number, or the name of the person you met)");
        await passCheck(c, {
          shopId,
          universityId: u.universityId,
          kind: input.check,
          subject,
          evidence: { method: "ADMIN", confirmedWith: input.confirmedWith },
          decidedBy: u.auth.userId,
          validForDays: days,
          note: input.note,
        });
      }
      await audit(c, {
        universityId: u.universityId,
        shopId,
        actorUserId: u.auth.userId,
        actorKind: "UNIVERSITY_ADMIN",
        action: input.decision === "REJECT" ? "provider.check_rejected" : "provider.check_passed",
        entityType: "shop",
        entityId: shopId,
        requestId: req.id,
        ip: req.ip,
        details: { check: input.check, note: input.note, confirmedWith: input.confirmedWith },
      });
    });
    return this.detail(req, uid, sid);
  }

  /** Withdraws what was proven, and optionally stops the shop trading. */
  @Post(":shopId/revoke")
  @HttpCode(200)
  async revoke(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("shopId") sid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const shopId = parse(uuid, sid);
    const input = parse(Schemas.RevokeProviderCheck, body);
    const shop = await this.pool.query(`SELECT 1 FROM shops WHERE id = $1 AND university_id = $2`, [shopId, u.universityId]);
    if (!shop.rowCount) throw Errors.notFound("shop");
    await withTransaction(this.pool, async (c) => {
      if (input.suspend) {
        await suspendProvider(c, { shopId, by: u.auth.userId, reason: input.reason });
      } else {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM provider_verifications WHERE shop_id = $1 AND kind = $2 AND status = 'PASSED'`, [shopId, input.check]);
        if (!rows[0]) throw Errors.rule("that check is not currently standing", "CHECK_NOT_PASSED");
        await revokeCheck(c, { checkId: rows[0].id, decidedBy: u.auth.userId, note: input.reason });
      }
      await audit(c, {
        universityId: u.universityId,
        shopId,
        actorUserId: u.auth.userId,
        actorKind: "UNIVERSITY_ADMIN",
        action: input.suspend ? "provider.suspended" : "provider.check_revoked",
        entityType: "shop",
        entityId: shopId,
        requestId: req.id,
        ip: req.ip,
        details: { check: input.suspend ? "ALL" : input.check, reason: input.reason },
      });
    });
    return this.detail(req, uid, sid);
  }

  /**
   * Replaces the university's roll, so matric numbers verify themselves. Only the matric
   * number and a keyed hash of the surname are stored: enough to confirm a claim, and not
   * a copy of the university's student register.
   */
  @Put("roll")
  @HttpCode(200)
  async roll(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    if (!this.cfg.STUDENT_ROLL_PEPPER) {
      throw Errors.unavailable("set STUDENT_ROLL_PEPPER on the API before uploading a roll; it is the key the surnames are hashed with", "NO_ROLL_PEPPER");
    }
    const input = parse(Schemas.StudentRoll, body);
    const pepper = this.cfg.STUDENT_ROLL_PEPPER;
    const batchId = randomUUID();
    const prepared = input.rows.map((r) => ({ matric: r.matricNumber.trim().toUpperCase().replace(/\s+/g, ""), surnameHash: surnameHash(pepper, r.surname) }));
    const stored = await withTransaction(this.pool, async (c) => {
      const n = await replaceRoll(c, { universityId: u.universityId, batchId, rows: prepared });
      await audit(c, {
        universityId: u.universityId,
        actorUserId: u.auth.userId,
        actorKind: "UNIVERSITY_ADMIN",
        action: "provider.roll_uploaded",
        entityType: "university",
        entityId: u.universityId,
        requestId: req.id,
        ip: req.ip,
        // The roll itself is never logged; only its size and which upload it was.
        details: { batchId, rows: n },
      });
      return n;
    });
    return {
      stored,
      batchId,
      note: "Only the matric number and a keyed hash of each surname are kept. Names are not stored, and this replaces any earlier roll.",
    };
  }
}

export const PROVIDER_CHECK_LABELS: Record<VerificationCheck, string> = {
  STUDENT_EMAIL: "University email",
  MATRIC_NUMBER: "Matric number",
  UNIVERSITY_REVIEW: "University review",
};
