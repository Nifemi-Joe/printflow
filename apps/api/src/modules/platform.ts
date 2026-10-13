import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Pool } from "pg";
import { withTransaction } from "../../../../packages/data/src/index.js";
import { checkoutMode, type AppConfig } from "../config.js";
import { Access, audit } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { Schemas } from "../http/schemas.js";
import { parse, Pagination, uuid } from "../http/validate.js";
import { CONFIG, PG_POOL } from "../infra/tokens.js";

@Controller("v1/platform")
export class PlatformController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Access) private readonly access: Access,
  ) {}

  @Get("universities")
  async universities(@Req() req: PfRequest) {
    this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
    const { rows } = await this.pool.query(
      `SELECT u.id, u.slug, u.name, u.status, u.pricing_mode AS "pricingMode", u.service_fee_fixed_kobo AS "serviceFeeFixedKobo", u.service_fee_bps AS "serviceFeeBps",
              (SELECT count(*)::int FROM shops s WHERE s.university_id = u.id AND s.status = 'APPROVED') AS "approvedShops",
              (SELECT count(*)::int FROM student_profiles sp WHERE sp.university_id = u.id) AS students,
              (SELECT count(*)::int FROM orders o WHERE o.university_id = u.id AND o.created_at > now() - interval '30 days') AS "ordersLast30Days",
              EXISTS (SELECT 1 FROM rate_cards r WHERE r.university_id = u.id AND r.status = 'PUBLISHED') AS "hasPublishedPricing"
         FROM universities u ORDER BY u.name`,
    );
    return { items: rows };
  }

  /**
   * Clears a user's authenticator after their identity has been verified out of
   * band (lost phone). Signs them out everywhere; they re-enrol at next sign-in.
   * Platform admins cannot reset their own factor.
   */
  @Post("users/mfa-reset")
  @HttpCode(200)
  async resetMfa(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.platform(req);
    const input = parse(Schemas.ResetMfa, body);
    return withTransaction(this.pool, async (c) => {
      const u = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status <> 'DELETED' FOR UPDATE`, [input.email]);
      const user = u.rows[0];
      if (!user) throw Errors.notFound("user");
      if (user.id === a.userId) throw Errors.forbidden("ask another platform administrator to reset your own authenticator");
      const removed = await c.query(`DELETE FROM mfa_factors WHERE user_id = $1`, [user.id]);
      const revoked = await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
      await audit(c, { actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "user.mfa_reset", entityType: "user", entityId: user.id, requestId: req.id, ip: req.ip, details: { reason: input.reason } });
      return { reset: (removed.rowCount ?? 0) > 0, sessionsRevoked: revoked.rowCount ?? 0 };
    });
  }

  @Post("universities")
  @HttpCode(201)
  async create(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.platform(req);
    const input = parse(Schemas.CreateUniversity, body);
    const { rows } = await this.pool.query(`INSERT INTO universities (slug, name) VALUES ($1, $2) RETURNING id, slug, name, status`, [input.slug, input.name]);
    await audit(this.pool, { universityId: (rows[0] as { id: string }).id, actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "university.created", entityType: "university", entityId: (rows[0] as { id: string }).id, requestId: req.id });
    return rows[0];
  }

  @Patch("universities/:universityId")
  async update(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const a = this.access.platform(req);
    const id = parse(uuid, uid);
    const input = parse(Schemas.UpdateUniversity, body);
    if (input.status === "ACTIVE") {
      const ready = await this.pool.query(`SELECT 1 FROM campuses WHERE university_id = $1 AND is_active`, [id]);
      if (!ready.rowCount) throw Errors.rule("add at least one campus before activating a university", "NOT_READY");
    }
    const { rows } = await this.pool.query(
      `UPDATE universities SET status = COALESCE($2, status), service_fee_fixed_kobo = COALESCE($3, service_fee_fixed_kobo), service_fee_bps = COALESCE($4, service_fee_bps)
        WHERE id = $1 RETURNING id, slug, name, status, service_fee_fixed_kobo AS "serviceFeeFixedKobo", service_fee_bps AS "serviceFeeBps"`,
      [id, input.status ?? null, input.serviceFeeFixedKobo ?? null, input.serviceFeeBps ?? null],
    );
    if (!rows[0]) throw Errors.notFound("university");
    await audit(this.pool, { universityId: id, actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "university.updated", entityType: "university", entityId: id, requestId: req.id, details: input });
    return rows[0];
  }

  @Post("universities/:universityId/admins")
  @HttpCode(201)
  async assignAdmin(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const a = this.access.platform(req);
    const id = parse(uuid, uid);
    const { email } = parse(Schemas.AssignAdmin, body);
    return withTransaction(this.pool, async (c) => {
      const u = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status = 'ACTIVE'`, [email]);
      if (!u.rows[0]) throw Errors.rule("ask this person to create a PrintFlow account first", "USER_NOT_FOUND");
      const { rows } = await c.query(`INSERT INTO university_staff (user_id, university_id, role) VALUES ($1, $2, 'UNIVERSITY_ADMIN') RETURNING id, role`, [u.rows[0].id, id]);
      await audit(c, { universityId: id, actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "university_admin.assigned", entityType: "user", entityId: u.rows[0].id, requestId: req.id });
      return rows[0];
    });
  }

  /** Operational health: job backlog, dead jobs, webhook failures. */
  @Get("health")
  async health(@Req() req: PfRequest) {
    this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
    const [jobs, dead, hooks, docs] = await Promise.all([
      this.pool.query(`SELECT kind, status, count(*)::int AS n FROM jobs GROUP BY kind, status ORDER BY kind, status`),
      this.pool.query(`SELECT id, kind, attempts, last_error AS "lastError", finished_at AS "finishedAt" FROM jobs WHERE status = 'DEAD' ORDER BY id DESC LIMIT 20`),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE NOT signature_valid)::int AS "invalidSignatures", count(*) FILTER (WHERE processing_error IS NOT NULL AND signature_valid)::int AS "processingErrors",
                count(*)::int AS total FROM payment_webhook_events WHERE received_at > now() - interval '24 hours'`,
      ),
      this.pool.query(`SELECT processing_status AS status, count(*)::int AS n FROM document_versions WHERE created_at > now() - interval '24 hours' GROUP BY processing_status`),
    ]);
    return { checkout: checkoutMode(this.cfg), jobs: jobs.rows, deadJobs: dead.rows, webhooksLast24h: hooks.rows[0], documentsLast24h: docs.rows };
  }

  @Get("webhooks")
  async webhooks(@Req() req: PfRequest, @Query() query: unknown) {
    this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
    const { limit } = parse(Pagination, query);
    const { rows } = await this.pool.query(
      `SELECT id, provider, event_id AS "eventId", event_type AS "eventType", signature_valid AS "signatureValid", processing_error AS "processingError",
              received_at AS "receivedAt", processed_at AS "processedAt" FROM payment_webhook_events ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return { items: rows };
  }
}
