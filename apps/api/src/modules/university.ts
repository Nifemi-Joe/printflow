import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Pool } from "pg";
import { ORDER_STATUS_LABELS, type OrderStatus } from "../../../../packages/domain/src/index.js";
import { enqueueJob, passCheck, refundOrder, retryFailedRefund, transitionOrder, withTransaction } from "../../../../packages/data/src/index.js";
import { validateRateCard } from "../../../../packages/pricing/src/index.js";
import { Access, audit, type UniversityStaffContext } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { Schemas } from "../http/schemas.js";
import { decodeCursor, page, parse, Pagination, uuid } from "../http/validate.js";
import { PG_POOL } from "../infra/tokens.js";
import { loadBounds, loadRateCards } from "./pricing-data.js";
import { insertRateCardDraft } from "./rate-card-write.js";

@Controller("v1/admin/universities/:universityId")
export class UniversityAdminController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(Access) private readonly access: Access,
  ) {}

  private ctx(req: PfRequest, raw: string, roles?: UniversityStaffContext["role"][]) {
    return this.access.university(req, parse(uuid, raw), roles);
  }

  private log(u: UniversityStaffContext, req: PfRequest, action: string, entityType: string, entityId: string, details?: Record<string, unknown>, shopId?: string) {
    return audit(this.pool, { universityId: u.universityId, shopId: shopId ?? null, actorUserId: u.auth.userId, actorKind: "UNIVERSITY_ADMIN", action, entityType, entityId, requestId: req.id, ip: req.ip, details });
  }

  // ---------------------------------------------------------------- overview & settings

  @Get("overview")
  async overview(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]);
    const [uni, shops, orders, money, disputes, privacy] = await Promise.all([
      this.pool.query(
        `SELECT id, slug, name, status, pricing_mode AS "pricingMode", quote_ttl_seconds AS "quoteTtlSeconds", document_retention_days AS "documentRetentionDays",
                service_fee_fixed_kobo AS "serviceFeeFixedKobo", service_fee_bps AS "serviceFeeBps", welcome_credit_kobo::int AS "welcomeCreditKobo",
                student_providers_allowed AS "studentProvidersAllowed", student_email_domains AS "studentEmailDomains", matric_pattern AS "matricPattern",
                student_provider_cap_kobo::int AS "studentProviderCapKobo", provider_reverify_days AS "providerReverifyDays" FROM universities WHERE id = $1`,
        [u.universityId],
      ),
      this.pool.query(`SELECT status, count(*)::int AS n FROM shops WHERE university_id = $1 GROUP BY status`, [u.universityId]),
      this.pool.query(`SELECT status, count(*)::int AS n FROM orders WHERE university_id = $1 AND created_at > now() - interval '30 days' GROUP BY status`, [u.universityId]),
      this.pool.query<{ paid: string; refunded: string }>(
        `SELECT COALESCE((SELECT sum(amount_kobo) FROM payments WHERE university_id = $1 AND status = 'SUCCEEDED' AND confirmed_at > now() - interval '30 days'), 0) AS paid,
                COALESCE((SELECT sum(amount_kobo) FROM refunds WHERE university_id = $1 AND status = 'SUCCEEDED' AND completed_at > now() - interval '30 days'), 0) AS refunded`,
        [u.universityId],
      ),
      this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM disputes WHERE university_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')`, [u.universityId]),
      this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM privacy_requests WHERE university_id = $1 AND status IN ('RECEIVED', 'IN_PROGRESS')`, [u.universityId]),
    ]);
    const providers = await this.pool.query<{ waiting: string; student_run: string; unverified: string }>(
      `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM provider_verifications v WHERE v.shop_id = s.id AND v.status = 'PENDING')) AS waiting,
              count(*) FILTER (WHERE s.kind = 'STUDENT_RUN') AS student_run,
              count(*) FILTER (WHERE s.kind = 'STUDENT_RUN' AND s.verification_level = 'UNVERIFIED' AND s.accepting_orders) AS unverified
         FROM shops s WHERE s.university_id = $1 AND s.status = 'APPROVED'`,
      [u.universityId],
    );
    // Wallet money held for students (a liability: it is owed as printing) and recent flows.
    const wallet = await this.pool.query<{ cash: string; promo: string; topups: string; spent: string }>(
      `SELECT COALESCE((SELECT sum(cash_kobo) FROM wallets WHERE university_id = $1), 0) AS cash,
              COALESCE((SELECT sum(promo_kobo) FROM wallets WHERE university_id = $1), 0) AS promo,
              COALESCE((SELECT sum(cash_kobo) FROM wallet_entries WHERE university_id = $1 AND kind = 'TOPUP' AND created_at > now() - interval '30 days'), 0) AS topups,
              COALESCE((SELECT -sum(cash_kobo + promo_kobo) FROM wallet_entries WHERE university_id = $1 AND kind IN ('ORDER_PAYMENT', 'ORDER_RETURN') AND created_at > now() - interval '30 days'), 0) AS spent`,
      [u.universityId],
    );
    const cards = await loadRateCards(this.pool, { universityId: u.universityId, shopId: null, publishedOnly: true });
    return {
      university: uni.rows[0],
      myRole: u.role,
      shopsByStatus: shops.rows,
      ordersLast30DaysByStatus: orders.rows,
      paymentsLast30DaysKobo: Number(money.rows[0]!.paid),
      refundsLast30DaysKobo: Number(money.rows[0]!.refunded),
      openDisputes: Number(disputes.rows[0]!.n),
      openPrivacyRequests: Number(privacy.rows[0]!.n),
      publishedCampusRateCards: cards.length,
      providers: {
        waitingChecks: Number(providers.rows[0]!.waiting),
        studentRun: Number(providers.rows[0]!.student_run),
        unverifiedTrading: Number(providers.rows[0]!.unverified),
      },
      wallet: {
        studentCashKobo: Number(wallet.rows[0]!.cash),
        studentPromoKobo: Number(wallet.rows[0]!.promo),
        topUpsLast30DaysKobo: Number(wallet.rows[0]!.topups),
        spentLast30DaysKobo: Number(wallet.rows[0]!.spent),
      },
    };
  }

  @Patch("settings")
  async settings(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const input = parse(Schemas.UniversitySettings, body);
    await this.pool.query(
      `UPDATE universities SET pricing_mode = COALESCE($2, pricing_mode), quote_ttl_seconds = COALESCE($3, quote_ttl_seconds),
              document_retention_days = COALESCE($4, document_retention_days), welcome_credit_kobo = COALESCE($5, welcome_credit_kobo),
              student_providers_allowed = COALESCE($6, student_providers_allowed),
              student_email_domains = COALESCE($7, student_email_domains),
              matric_pattern = CASE WHEN $8::boolean THEN $9 ELSE matric_pattern END,
              student_provider_cap_kobo = COALESCE($10, student_provider_cap_kobo),
              provider_reverify_days = COALESCE($11, provider_reverify_days)
        WHERE id = $1`,
      [
        u.universityId,
        input.pricingMode ?? null,
        input.quoteTtlSeconds ?? null,
        input.documentRetentionDays ?? null,
        input.welcomeCreditKobo ?? null,
        input.studentProvidersAllowed ?? null,
        input.studentEmailDomains ?? null,
        input.matricPattern !== undefined,
        input.matricPattern ?? null,
        input.studentProviderCapKobo ?? null,
        input.providerReverifyDays ?? null,
      ],
    );
    await this.log(u, req, "university.settings_changed", "university", u.universityId, input);
    return this.overview(req, uid);
  }

  // ---------------------------------------------------------------- campuses

  @Get("campuses")
  async campuses(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_SUPPORT"]);
    const c = await this.pool.query(`SELECT id, name, is_active AS "isActive" FROM campuses WHERE university_id = $1 ORDER BY name`, [u.universityId]);
    const d = await this.pool.query<{ id: string; name: string; campus_id: string }>(`SELECT id, name, campus_id FROM departments WHERE university_id = $1 ORDER BY name`, [u.universityId]);
    return { items: c.rows.map((x: { id: string }) => ({ ...x, departments: d.rows.filter((y) => y.campus_id === x.id).map(({ id, name }) => ({ id, name })) })) };
  }

  @Post("campuses")
  @HttpCode(201)
  async addCampus(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const { name } = parse(Schemas.Campus, body);
    const { rows } = await this.pool.query(`INSERT INTO campuses (university_id, name) VALUES ($1, $2) RETURNING id, name, is_active AS "isActive"`, [u.universityId, name]);
    await this.log(u, req, "campus.created", "campus", (rows[0] as { id: string }).id);
    return rows[0];
  }

  @Patch("campuses/:campusId")
  async updateCampus(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("campusId") cid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const input = parse(Schemas.UpdateCampus, body);
    const { rows } = await this.pool.query(
      `UPDATE campuses SET name = COALESCE($3, name), is_active = COALESCE($4, is_active) WHERE id = $1 AND university_id = $2 RETURNING id, name, is_active AS "isActive"`,
      [parse(uuid, cid), u.universityId, input.name ?? null, input.isActive ?? null],
    );
    if (!rows[0]) throw Errors.notFound("campus");
    await this.log(u, req, "campus.updated", "campus", parse(uuid, cid), input);
    return rows[0];
  }

  @Post("campuses/:campusId/departments")
  @HttpCode(201)
  async addDepartment(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("campusId") cid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const { name } = parse(Schemas.Department, body);
    const { rows } = await this.pool.query(`INSERT INTO departments (university_id, campus_id, name) VALUES ($1, $2, $3) RETURNING id, name`, [u.universityId, parse(uuid, cid), name]);
    return rows[0];
  }

  // ---------------------------------------------------------------- shops

  @Get("shops")
  async shops(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_SUPPORT", "UNIVERSITY_FINANCE"]);
    const { rows } = await this.pool.query(
      `SELECT s.id, s.name, s.status, s.accepting_orders AS "acceptingOrders", c.name AS campus, s.created_at AS "createdAt", s.approved_at AS "approvedAt",
              (SELECT u.full_name FROM shop_memberships m JOIN users u ON u.id = m.user_id WHERE m.shop_id = s.id AND m.role = 'OWNER' AND m.revoked_at IS NULL) AS owner,
              (SELECT count(*)::int FROM queue_entries q WHERE q.shop_id = s.id) AS "queueLength"
         FROM shops s JOIN campuses c ON c.id = s.campus_id WHERE s.university_id = $1 ORDER BY s.status, s.name`,
      [u.universityId],
    );
    return { items: rows };
  }

  @Post("shops/:shopId/status")
  @HttpCode(200)
  async shopStatus(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("shopId") sid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const shopId = parse(uuid, sid);
    const { action, reason } = parse(Schemas.ShopStatusAction, body);
    const NEXT: Record<typeof action, string> = { approve: "APPROVED", suspend: "SUSPENDED", reinstate: "APPROVED", remove: "REMOVED" };
    const FROM: Record<typeof action, string[]> = { approve: ["PENDING_APPROVAL"], suspend: ["APPROVED"], reinstate: ["SUSPENDED"], remove: ["PENDING_APPROVAL", "APPROVED", "SUSPENDED"] };
    const next = NEXT[action];
    const allowedFrom = FROM[action];
    const { rows } = await this.pool.query(
      `UPDATE shops SET status = $3,
              accepting_orders = CASE WHEN $3 = 'APPROVED' THEN accepting_orders ELSE false END,
              approved_at = CASE WHEN $3 = 'APPROVED' THEN COALESCE(approved_at, now()) ELSE approved_at END,
              approved_by = CASE WHEN $3 = 'APPROVED' THEN COALESCE(approved_by, $4) ELSE approved_by END
        WHERE id = $1 AND university_id = $2 AND status = ANY($5) RETURNING id, status`,
      [shopId, u.universityId, next, u.auth.userId, allowedFrom],
    );
    if (!rows[0]) throw Errors.conflict(`cannot ${action} this shop from its current status`, "INVALID_SHOP_STATUS");
    // Approving a registered business is the identity review: the university has seen the
    // premises and the paperwork. A student-run shop is different — approving it lets them
    // trade, but what is known about the person still comes only from their own checks.
    const kind = await this.pool.query<{ kind: string; name: string }>(`SELECT kind, name FROM shops WHERE id = $1`, [shopId]);
    if (action === "approve" && kind.rows[0]?.kind === "BUSINESS") {
      const { rows: policy } = await this.pool.query<{ provider_reverify_days: number }>(`SELECT provider_reverify_days FROM universities WHERE id = $1`, [u.universityId]);
      await withTransaction(this.pool, (c) =>
        passCheck(c, {
          shopId,
          universityId: u.universityId,
          kind: "UNIVERSITY_REVIEW",
          subject: kind.rows[0]!.name,
          evidence: { method: "ADMIN", confirmedWith: "BUSINESS_APPROVAL" },
          decidedBy: u.auth.userId,
          validForDays: policy[0]!.provider_reverify_days,
          note: reason,
        }),
      );
    }
    if (action === "suspend" || action === "remove") {
      await withTransaction(this.pool, (c) =>
        c.query(`UPDATE provider_verifications SET status = 'REVOKED', decided_by = $2, decided_at = now(), note = $3 WHERE shop_id = $1 AND status = 'PASSED'`, [
          shopId,
          u.auth.userId,
          `Shop ${action}d: ${reason}`.slice(0, 1000),
        ]),
      );
    }
    await this.log(u, req, `shop.${action}`, "shop", shopId, { reason }, shopId);
    return rows[0];
  }

  // ---------------------------------------------------------------- pricing

  @Get("rate-cards")
  async rateCards(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE"]);
    const [campus, overrides, bounds] = await Promise.all([
      loadRateCards(this.pool, { universityId: u.universityId, shopId: null, publishedOnly: false }),
      this.pool.query(
        `SELECT o.id, o.shop_id AS "shopId", s.name AS "shopName", o.rate_card_id AS "rateCardId", o.kind, o.paper_size AS "paperSize", o.colour_mode AS "colourMode",
                o.sides, o.finishing_code AS "finishingCode", o.price_kobo AS "priceKobo", o.approved_at AS "approvedAt"
           FROM shop_price_overrides o JOIN shops s ON s.id = o.shop_id WHERE o.university_id = $1 AND o.revoked_at IS NULL ORDER BY s.name`,
        [u.universityId],
      ),
      loadBounds(this.pool, u.universityId),
    ]);
    return { campusCards: campus, overrides: overrides.rows, bounds };
  }

  @Post("rate-cards")
  @HttpCode(201)
  async draft(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const input = parse(Schemas.RateCardDraft, body);
    const id = await withTransaction(this.pool, (c) => insertRateCardDraft(c, { universityId: u.universityId, shopId: null, createdBy: u.auth.userId, draft: input }));
    await this.log(u, req, "rate_card.drafted", "rate_card", id);
    return { id, status: "DRAFT" };
  }

  @Post("rate-cards/:rateCardId/publish")
  @HttpCode(200)
  async publish(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("rateCardId") rid: string) {
    const u = await this.ctx(req, uid);
    const id = parse(uuid, rid);
    const card = (await loadRateCards(this.pool, { universityId: u.universityId, shopId: null, publishedOnly: false })).find((c) => c.id === id);
    if (!card) throw Errors.notFound("rate card");
    if (card.status !== "DRAFT") throw Errors.conflict("only drafts can be published", "NOT_DRAFT");
    validateRateCard(card);
    await this.pool.query(`UPDATE rate_cards SET status = 'PUBLISHED', published_at = now(), published_by = $2 WHERE id = $1 AND status = 'DRAFT'`, [id, u.auth.userId]);
    await this.log(u, req, "rate_card.published", "rate_card", id, { version: card.version, effectiveFrom: card.effectiveFrom });
    return { id, status: "PUBLISHED", version: card.version };
  }

  @Post("rate-cards/:rateCardId/retire")
  @HttpCode(200)
  async retire(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("rateCardId") rid: string) {
    const u = await this.ctx(req, uid);
    const id = parse(uuid, rid);
    const { rows } = await this.pool.query(
      `UPDATE rate_cards SET status = 'RETIRED', effective_to = COALESCE(effective_to, GREATEST(now(), effective_from + interval '1 second'))
        WHERE id = $1 AND university_id = $2 AND status = 'PUBLISHED' RETURNING id, status`,
      [id, u.universityId],
    );
    if (!rows[0]) throw Errors.conflict("only published cards can be retired", "NOT_PUBLISHED");
    await this.log(u, req, "rate_card.retired", "rate_card", id);
    return rows[0];
  }

  @Post("price-overrides")
  @HttpCode(201)
  async addOverride(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const o = parse(Schemas.Override, body);
    const { rows } = await this.pool.query(
      `INSERT INTO shop_price_overrides (university_id, shop_id, rate_card_id, kind, paper_size, colour_mode, sides, finishing_code, price_kobo, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        u.universityId,
        o.shopId,
        o.rateCardId,
        o.kind,
        o.kind === "SHEET" ? o.paperSize : null,
        o.kind === "SHEET" ? o.colourMode : null,
        o.kind === "SHEET" ? o.sides : null,
        o.kind === "FINISHING" ? o.finishingCode : null,
        o.priceKobo,
        u.auth.userId,
      ],
    );
    const id = (rows[0] as { id: string }).id;
    await this.log(u, req, "price_override.approved", "shop_price_override", id, o, o.shopId);
    return { id };
  }

  @Delete("price-overrides/:overrideId")
  @HttpCode(204)
  async revokeOverride(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("overrideId") oid: string) {
    const u = await this.ctx(req, uid);
    const r = await this.pool.query(`UPDATE shop_price_overrides SET revoked_at = now() WHERE id = $1 AND university_id = $2 AND revoked_at IS NULL`, [parse(uuid, oid), u.universityId]);
    if (!r.rowCount) throw Errors.notFound("override");
    await this.log(u, req, "price_override.revoked", "shop_price_override", parse(uuid, oid));
  }

  @Put("price-bounds")
  async bounds(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const { bounds } = parse(Schemas.PriceBounds, body);
    await withTransaction(this.pool, async (c) => {
      await c.query(`DELETE FROM price_bounds WHERE university_id = $1`, [u.universityId]);
      for (const b of bounds) {
        await c.query(`INSERT INTO price_bounds (university_id, paper_size, colour_mode, sides, min_kobo, max_kobo, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
          u.universityId,
          b.paperSize,
          b.colourMode,
          b.sides,
          b.minKobo,
          b.maxKobo,
          u.auth.userId,
        ]);
      }
    });
    await this.log(u, req, "price_bounds.updated", "university", u.universityId, { count: bounds.length });
    return { bounds: await loadBounds(this.pool, u.universityId) };
  }

  // ---------------------------------------------------------------- orders, refunds, disputes

  @Get("orders")
  async orders(@Req() req: PfRequest, @Param("universityId") uid: string, @Query() query: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]);
    const q = parse(Schemas.OrderListQuery, query);
    const cur = decodeCursor(q.cursor);
    const { rows } = await this.pool.query<{ id: string; created_at: Date; status: OrderStatus }>(
      `SELECT o.id, o.reference, o.status, o.total_kobo AS "totalKobo", o.created_at, o.status_changed_at AS "statusChangedAt", s.name AS "shopName", us.full_name AS "studentName"
         FROM orders o JOIN shops s ON s.id = o.shop_id JOIN users us ON us.id = o.student_user_id
        WHERE o.university_id = $1 AND ($2::text IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.shop_id = $3)
          AND ($4::timestamptz IS NULL OR (o.created_at, o.id) < ($4, $5::uuid))
        ORDER BY o.created_at DESC, o.id DESC LIMIT $6`,
      [u.universityId, q.status ?? null, q.shopId ?? null, cur?.createdAt ?? null, cur?.id ?? null, q.limit + 1],
    );
    const p = page(rows, q.limit);
    return { items: p.items.map((r) => ({ ...r, statusLabel: ORDER_STATUS_LABELS[r.status] })), nextCursor: p.nextCursor };
  }

  @Get("orders/:orderId")
  async order(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("orderId") oid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]);
    const orderId = parse(uuid, oid);
    const o = await this.pool.query(
      `SELECT o.id, o.reference, o.status, o.total_kobo AS "totalKobo", o.created_at AS "createdAt", s.name AS "shopName", us.full_name AS "studentName", us.email AS "studentEmail",
              q.lines, q.spec, q.rate_card_version AS "rateCardVersion"
         FROM orders o JOIN shops s ON s.id = o.shop_id JOIN users us ON us.id = o.student_user_id JOIN quotes q ON q.id = o.quote_id
        WHERE o.id = $1 AND o.university_id = $2`,
      [orderId, u.universityId],
    );
    if (!o.rows[0]) throw Errors.notFound("order");
    const [events, payments, refunds, disputes] = await Promise.all([
      this.pool.query(`SELECT from_status AS "from", to_status AS "to", actor_kind AS "actorKind", reason, occurred_at AS "at" FROM order_events WHERE order_id = $1 ORDER BY id`, [orderId]),
      this.pool.query(`SELECT provider, provider_reference AS reference, amount_kobo AS "amountKobo", status, confirmed_at AS "confirmedAt" FROM payments WHERE order_id = $1`, [orderId]),
      this.pool.query(`SELECT id, amount_kobo AS "amountKobo", status, destination, reason, requested_at AS "requestedAt" FROM refunds WHERE order_id = $1`, [orderId]),
      this.pool.query(`SELECT id, category, status, description FROM disputes WHERE order_id = $1`, [orderId]),
    ]);
    const wallet = await this.pool.query<{ taken: string; returned: string }>(
      `SELECT COALESCE(-sum(cash_kobo + promo_kobo) FILTER (WHERE kind = 'ORDER_PAYMENT'), 0) AS taken,
              COALESCE(sum(cash_kobo + promo_kobo) FILTER (WHERE kind IN ('ORDER_RETURN', 'CARD_REFUND')), 0) AS returned
         FROM wallet_entries WHERE order_id = $1`,
      [orderId],
    );
    return {
      ...o.rows[0],
      events: events.rows,
      payments: payments.rows,
      refunds: refunds.rows,
      disputes: disputes.rows,
      wallet: { paidKobo: Number(wallet.rows[0]!.taken), returnedKobo: Number(wallet.rows[0]!.returned) },
    };
  }

  @Post("orders/:orderId/refund")
  @HttpCode(200)
  async refund(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("orderId") oid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE"]);
    const { reason, refundTo } = parse(Schemas.AdminRefund, body);
    const r = await withTransaction(this.pool, (c) =>
      transitionOrder(c, { orderId: parse(uuid, oid), to: "REFUND_PENDING", scope: { kind: "UNIVERSITY", universityId: u.universityId }, actorUserId: u.auth.userId, reason, requestId: req.id, refundTo }),
    );
    return { id: r.id, status: r.status };
  }

  /** Re-issues a refund the payment provider refused, for whatever is still unrefunded. */
  @Post("orders/:orderId/refund-retry")
  @HttpCode(201)
  async retryRefund(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("orderId") oid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE"]);
    const { reason, refundTo } = parse(Schemas.RetryRefund, body);
    const orderId = parse(uuid, oid);
    return withTransaction(this.pool, async (c) => {
      const r = await retryFailedRefund(c, { orderId, universityId: u.universityId, reason, requestedBy: u.auth.userId, destination: refundTo });
      await audit(c, { universityId: u.universityId, actorUserId: u.auth.userId, actorKind: "UNIVERSITY_ADMIN", action: "refund.retried", entityType: "order", entityId: orderId, requestId: req.id, ip: req.ip, details: { refundId: r.refundId, amountKobo: r.amountKobo, destination: r.destination } });
      return r;
    });
  }

  @Get("disputes")
  async disputes(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_SUPPORT", "UNIVERSITY_FINANCE"]);
    const { rows } = await this.pool.query(
      `SELECT d.id, d.order_id AS "orderId", o.reference, d.category, d.description, d.status, d.resolution_note AS "resolutionNote", d.opened_at AS "openedAt",
              us.full_name AS "openedBy", s.name AS "shopName", o.total_kobo AS "orderTotalKobo"
         FROM disputes d JOIN orders o ON o.id = d.order_id JOIN users us ON us.id = d.opened_by JOIN shops s ON s.id = o.shop_id
        WHERE d.university_id = $1 ORDER BY (d.status IN ('OPEN', 'UNDER_REVIEW')) DESC, d.opened_at DESC LIMIT 200`,
      [u.universityId],
    );
    return { items: rows };
  }

  @Post("disputes/:disputeId/resolve")
  @HttpCode(200)
  async resolve(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("disputeId") did: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]);
    const input = parse(Schemas.ResolveDispute, body);
    if (input.status === "RESOLVED_REFUND" && !input.refundKobo) throw Errors.badRequest("refundKobo is required to resolve with a refund");
    if (input.status === "RESOLVED_REFUND" && u.role === "UNIVERSITY_SUPPORT") throw Errors.forbidden("support staff cannot issue refunds");
    const disputeId = parse(uuid, did);
    await withTransaction(this.pool, async (c) => {
      const d = await c.query<{ order_id: string; status: string }>(`SELECT order_id, status FROM disputes WHERE id = $1 AND university_id = $2 FOR UPDATE`, [disputeId, u.universityId]);
      if (!d.rows[0]) throw Errors.notFound("dispute");
      if (!["OPEN", "UNDER_REVIEW"].includes(d.rows[0].status)) throw Errors.conflict("this dispute is already closed", "DISPUTE_CLOSED");
      const final = input.status !== "UNDER_REVIEW";
      await c.query(
        `UPDATE disputes SET status = $2, resolution_note = $3, resolved_by = CASE WHEN $4 THEN $5::uuid END, resolved_at = CASE WHEN $4 THEN now() END WHERE id = $1`,
        [disputeId, input.status, input.note, final, u.auth.userId],
      );
      if (input.status === "RESOLVED_REFUND") {
        await c.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [d.rows[0].order_id]);
        const r = await refundOrder(c, {
          orderId: d.rows[0].order_id,
          amountKobo: input.refundKobo!,
          destination: input.refundTo,
          reason: `Dispute resolution: ${input.note}`.slice(0, 1000),
          idempotencyKey: `dispute:${disputeId}`,
          requestedBy: u.auth.userId,
        });
        if (r.toWalletKobo + r.toProviderKobo === 0 && !r.replayed) throw Errors.rule("this order has nothing left to refund", "NOT_PAID");
      }
      await audit(c, { universityId: u.universityId, actorUserId: u.auth.userId, actorKind: "UNIVERSITY_ADMIN", action: "dispute.updated", entityType: "dispute", entityId: disputeId, requestId: req.id, details: { status: input.status, refundKobo: input.refundKobo, refundTo: input.status === "RESOLVED_REFUND" ? input.refundTo : undefined } });
    });
    return { id: disputeId, status: input.status };
  }

  // ---------------------------------------------------------------- staff, audit, privacy, reports

  @Get("staff")
  async staff(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid);
    const { rows } = await this.pool.query(
      `SELECT s.id, s.role, us.full_name AS "fullName", us.email, s.created_at AS "createdAt",
              EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = us.id AND f.confirmed_at IS NOT NULL) AS "mfaEnrolled"
         FROM university_staff s JOIN users us ON us.id = s.user_id WHERE s.university_id = $1 AND s.revoked_at IS NULL ORDER BY s.role, us.full_name`,
      [u.universityId],
    );
    return { items: rows };
  }

  @Post("staff")
  @HttpCode(201)
  async addStaff(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid);
    const input = parse(Schemas.UniversityStaff, body);
    const target = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status = 'ACTIVE'`, [input.email]);
    if (!target.rows[0]) throw Errors.rule("ask this person to create a PrintFlow account first", "USER_NOT_FOUND");
    const { rows } = await this.pool.query(`INSERT INTO university_staff (user_id, university_id, role) VALUES ($1, $2, $3) RETURNING id, role`, [target.rows[0].id, u.universityId, input.role]);
    await this.log(u, req, "university_staff.added", "university_staff", (rows[0] as { id: string }).id, { role: input.role });
    return rows[0];
  }

  @Delete("staff/:staffId")
  @HttpCode(204)
  async removeStaff(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("staffId") sid: string) {
    const u = await this.ctx(req, uid);
    const r = await this.pool.query(`UPDATE university_staff SET revoked_at = now() WHERE id = $1 AND university_id = $2 AND user_id <> $3 AND revoked_at IS NULL`, [
      parse(uuid, sid),
      u.universityId,
      u.auth.userId,
    ]);
    if (!r.rowCount) throw Errors.notFound("staff member");
    await this.log(u, req, "university_staff.removed", "university_staff", parse(uuid, sid));
  }

  @Get("audit-log")
  async auditLog(@Req() req: PfRequest, @Param("universityId") uid: string, @Query() query: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE"]);
    const { limit, cursor } = parse(Pagination, query);
    if (cursor && !/^\d{1,19}$/.test(cursor)) throw Errors.badRequest("invalid cursor");
    const { rows } = await this.pool.query<{ id: string; occurred_at: Date }>(
      `SELECT a.id, a.occurred_at, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.actor_kind AS "actorKind", us.full_name AS "actorName", a.details, s.name AS "shopName"
         FROM audit_log a LEFT JOIN users us ON us.id = a.actor_user_id LEFT JOIN shops s ON s.id = a.shop_id
        WHERE a.university_id = $1 AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
      [u.universityId, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.id) : null };
  }

  @Get("privacy-requests")
  async privacy(@Req() req: PfRequest, @Param("universityId") uid: string) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_SUPPORT"]);
    const { rows } = await this.pool.query(
      `SELECT p.id, p.kind, p.status, p.note, p.created_at AS "createdAt", p.completed_at AS "completedAt", us.full_name AS "userName", us.email
         FROM privacy_requests p JOIN users us ON us.id = p.user_id WHERE p.university_id = $1 ORDER BY p.created_at DESC LIMIT 200`,
      [u.universityId],
    );
    return { items: rows };
  }

  @Post("privacy-requests/:requestId")
  @HttpCode(200)
  async handlePrivacy(@Req() req: PfRequest, @Param("universityId") uid: string, @Param("requestId") rid: string, @Body() body: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN"]);
    const input = parse(Schemas.HandlePrivacy, body);
    const id = parse(uuid, rid);
    const r = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ kind: string; status: string }>(`SELECT kind, status FROM privacy_requests WHERE id = $1 AND university_id = $2 FOR UPDATE`, [id, u.universityId]);
      const p = rows[0];
      if (!p) throw Errors.notFound("privacy request");
      if (p.status === "COMPLETED" || p.status === "REJECTED") throw Errors.conflict("this request is closed", "CLOSED");
      // Erasure is executed by the worker, which refuses while the user has active orders.
      const status = p.kind === "ERASURE" && input.status === "COMPLETED" ? "IN_PROGRESS" : input.status;
      await c.query(`UPDATE privacy_requests SET status = $2, note = COALESCE($3, note), handled_by = $4, completed_at = CASE WHEN $2 IN ('COMPLETED', 'REJECTED') THEN now() END WHERE id = $1`, [
        id,
        status,
        input.note ?? null,
        u.auth.userId,
      ]);
      if (p.kind === "ERASURE" && input.status === "COMPLETED") await enqueueJob(c, "PRIVACY_ERASE", { requestId: id }, { dedupeKey: `erase:${id}` });
      await audit(c, { universityId: u.universityId, actorUserId: u.auth.userId, actorKind: "UNIVERSITY_ADMIN", action: "privacy_request.handled", entityType: "privacy_request", entityId: id, requestId: req.id, details: { status } });
      return { id, status };
    });
    return r;
  }

  @Get("reports/summary")
  async report(@Req() req: PfRequest, @Param("universityId") uid: string, @Query() query: unknown) {
    const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE"]);
    const { from, to } = parse(Schemas.DateRange, query);
    const range = [from ?? new Date(Date.now() - 30 * 86_400_000).toISOString(), to ?? new Date().toISOString()];
    const { rows } = await this.pool.query(
      `SELECT s.id AS "shopId", s.name AS "shopName",
              count(o.*) FILTER (WHERE o.status NOT IN ('AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED'))::int AS "paidOrders",
              count(o.*) FILTER (WHERE o.status = 'COLLECTED')::int AS "collectedOrders",
              COALESCE(sum(q.subtotal_kobo) FILTER (WHERE o.status = 'COLLECTED'), 0)::bigint AS "collectedRevenueKobo",
              COALESCE(sum(q.service_fee_kobo) FILTER (WHERE o.status = 'COLLECTED'), 0)::bigint AS "platformFeesKobo",
              (SELECT count(*) FROM disputes d JOIN orders o2 ON o2.id = d.order_id WHERE o2.shop_id = s.id AND d.opened_at >= $2 AND d.opened_at < $3)::int AS disputes
         FROM shops s LEFT JOIN orders o ON o.shop_id = s.id AND o.created_at >= $2 AND o.created_at < $3 LEFT JOIN quotes q ON q.id = o.quote_id
        WHERE s.university_id = $1 GROUP BY s.id ORDER BY s.name`,
      [u.universityId, ...range],
    );
    return { range: { from: range[0], to: range[1] }, shops: rows.map((r) => ({ ...r, collectedRevenueKobo: Number(r.collectedRevenueKobo), platformFeesKobo: Number(r.platformFeesKobo) })) };
  }
}
