import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Pool } from "pg";
import {
  allowedNextStatuses,
  ORDER_STATUS_LABELS,
  ROLE_DEFAULT_PERMISSIONS,
  validateBackAt,
  type OrderStatus,
  type ShopPermission,
} from "../../../../packages/domain/src/index.js";
import { ConflictError, redeemPickupCode, transitionOrder, withTransaction } from "../../../../packages/data/src/index.js";
import { validateAgainstBounds, validateRateCard } from "../../../../packages/pricing/src/index.js";
import type { ObjectStorage } from "../../../../packages/storage/src/index.js";
import type { AppConfig } from "../config.js";
import { Access, audit, type ShopMembership } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors, toApiError } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { decodeCursor, page, parse, uuid } from "../http/validate.js";
import { CONFIG, PG_POOL, STORAGE } from "../infra/tokens.js";
import { loadBounds, loadRateCards, shopPower, shopQueueEstimate } from "./pricing-data.js";
import { insertRateCardDraft } from "./rate-card-write.js";

/** Statuses in which staff may download the job's file. */
const DOWNLOADABLE: readonly OrderStatus[] = ["ACCEPTED", "PRINTING", "PAUSED", "PRINT_FAILED", "QUALITY_CHECK"];

@Controller("v1")
export class ShopController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(Access) private readonly access: Access,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private staffAudit(m: ShopMembership, req: PfRequest, action: string, entityType: string, entityId: string, details?: Record<string, unknown>) {
    return audit(this.pool, { universityId: m.universityId, shopId: m.shopId, actorUserId: m.auth.userId, actorKind: "SHOP_STAFF", action, entityType, entityId, requestId: req.id, ip: req.ip, details });
  }

  // ---------------------------------------------------------------- shop profile

  /** Any signed-in user may apply to register a shop; it stays PENDING_APPROVAL until the university approves. */
  @Post("shops")
  @HttpCode(201)
  async apply(@Req() req: PfRequest, @Body() body: unknown) {
    const a = this.access.user(req);
    await this.limiter.hit(`shop-apply:${a.userId}`, 3, 86_400);
    const input = parse(Schemas.ApplyShop, body);
    return withTransaction(this.pool, async (c) => {
      const campus = await c.query(`SELECT 1 FROM campuses c JOIN universities u ON u.id = c.university_id WHERE c.id = $1 AND c.university_id = $2 AND u.status <> 'SUSPENDED'`, [
        input.campusId,
        input.universityId,
      ]);
      if (!campus.rowCount) throw Errors.rule("choose a campus of this university", "INVALID_CAMPUS");
      const s = await c.query<{ id: string }>(`INSERT INTO shops (university_id, campus_id, name, location_note) VALUES ($1, $2, $3, $4) RETURNING id`, [
        input.universityId,
        input.campusId,
        input.name,
        input.locationNote ?? null,
      ]);
      const shopId = s.rows[0]!.id;
      await c.query(`INSERT INTO shop_memberships (user_id, shop_id, university_id, role, permissions) VALUES ($1, $2, $3, 'OWNER', $4)`, [
        a.userId,
        shopId,
        input.universityId,
        ROLE_DEFAULT_PERMISSIONS.OWNER,
      ]);
      await audit(c, { universityId: input.universityId, shopId, actorUserId: a.userId, actorKind: "SHOP_STAFF", action: "shop.applied", entityType: "shop", entityId: shopId, requestId: req.id });
      return { id: shopId, status: "PENDING_APPROVAL" };
    });
  }

  @Get("shops/:shopId")
  async profile(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw));
    const s = await this.pool.query(
      `SELECT s.id, s.name, s.status, s.accepting_orders AS "acceptingOrders", s.location_note AS "locationNote", s.opening_hours AS "openingHours",
              s.campus_id AS "campusId", c.name AS "campusName", u.name AS "universityName", u.pricing_mode AS "pricingMode"
         FROM shops s JOIN campuses c ON c.id = s.campus_id JOIN universities u ON u.id = s.university_id WHERE s.id = $1`,
      [m.shopId],
    );
    const pl = await this.pool.query(`SELECT id, name, is_active AS "isActive" FROM pickup_locations WHERE shop_id = $1 ORDER BY name`, [m.shopId]);
    return { ...s.rows[0], pickupLocations: pl.rows, power: await shopPower(this.pool, m.shopId), me: { role: m.role, permissions: m.permissions } };
  }

  @Patch("shops/:shopId")
  async updateProfile(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "catalogue.manage");
    const input = parse(Schemas.UpdateShop, body);
    if (input.acceptingOrders) {
      const st = await this.pool.query<{ status: string }>(`SELECT status FROM shops WHERE id = $1`, [m.shopId]);
      if (st.rows[0]?.status !== "APPROVED") throw Errors.rule("the university must approve this shop before it can take orders", "SHOP_NOT_APPROVED");
    }
    await this.pool.query(
      `UPDATE shops SET accepting_orders = COALESCE($2, accepting_orders), opening_hours = COALESCE($3, opening_hours),
              location_note = CASE WHEN $4::boolean THEN $5 ELSE location_note END WHERE id = $1`,
      [m.shopId, input.acceptingOrders ?? null, input.openingHours ? JSON.stringify(input.openingHours) : null, input.locationNote !== undefined, input.locationNote ?? null],
    );
    await this.staffAudit(m, req, "shop.updated", "shop", m.shopId, { fields: Object.keys(input) });
    return this.profile(req, m.shopId);
  }

  @Post("shops/:shopId/pickup-locations")
  @HttpCode(201)
  async addPickup(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "catalogue.manage");
    const { name } = parse(Schemas.PickupLocation, body);
    const { rows } = await this.pool.query(`INSERT INTO pickup_locations (university_id, shop_id, name) VALUES ($1, $2, $3) RETURNING id, name, is_active AS "isActive"`, [
      m.universityId,
      m.shopId,
      name,
    ]);
    return rows[0];
  }

  @Patch("shops/:shopId/pickup-locations/:locationId")
  async updatePickup(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("locationId") idRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "catalogue.manage");
    const input = parse(Schemas.UpdatePickupLocation, body);
    const { rows } = await this.pool.query(
      `UPDATE pickup_locations SET name = COALESCE($3, name), is_active = COALESCE($4, is_active) WHERE id = $1 AND shop_id = $2 RETURNING id, name, is_active AS "isActive"`,
      [parse(uuid, idRaw), m.shopId, input.name ?? null, input.isActive ?? null],
    );
    if (!rows[0]) throw Errors.notFound("pickup location");
    return rows[0];
  }

  // ---------------------------------------------------------------- queue & orders

  @Get("shops/:shopId/queue")
  async queue(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.view");
    const { rows } = await this.pool.query<{ status: OrderStatus } & Record<string, unknown>>(
      `SELECT o.id, o.reference, o.status, o.row_version AS version, o.status_changed_at AS "statusChangedAt", qe.enqueued_at AS "enqueuedAt",
              qe.priority, q.total_sheets AS "totalSheets", q.spec, pl.name AS "pickupLocation", u.full_name AS "studentName"
         FROM queue_entries qe JOIN orders o ON o.id = qe.order_id JOIN quotes q ON q.id = o.quote_id
         JOIN pickup_locations pl ON pl.id = o.pickup_location_id JOIN users u ON u.id = o.student_user_id
        WHERE qe.shop_id = $1 ORDER BY qe.priority DESC, qe.enqueued_at, qe.order_id`,
      [m.shopId],
    );
    const ready = await this.pool.query(
      `SELECT o.id, o.reference, o.status, o.row_version AS version, o.status_changed_at AS "statusChangedAt", u.full_name AS "studentName", pl.name AS "pickupLocation"
         FROM orders o JOIN users u ON u.id = o.student_user_id JOIN pickup_locations pl ON pl.id = o.pickup_location_id
        WHERE o.shop_id = $1 AND o.status = 'READY_FOR_PICKUP' ORDER BY o.status_changed_at`,
      [m.shopId],
    );
    const [estimate, power] = await Promise.all([shopQueueEstimate(this.pool, m.shopId), shopPower(this.pool, m.shopId)]);
    return {
      power,
      items: rows.map((r, i) => ({ ...r, position: i + 1, statusLabel: ORDER_STATUS_LABELS[r.status], actions: allowedNextStatuses(r.status, "SHOP_STAFF", m.permissions) })),
      readyForPickup: ready.rows,
      summary: { jobs: rows.length, sheets: estimate.sheetsAhead, estimatedMinutesToClear: estimate.estimatedMinutes, basis: estimate.basis, activeDevices: estimate.activeDevices },
    };
  }

  @Get("shops/:shopId/orders")
  async orders(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Query() query: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.view");
    const q = parse(Schemas.OrderListQuery, query);
    const cur = decodeCursor(q.cursor);
    const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
      `SELECT o.id, o.reference, o.status, o.total_kobo AS "totalKobo", o.created_at, o.status_changed_at AS "statusChangedAt", qt.total_sheets AS "totalSheets"
         FROM orders o JOIN quotes qt ON qt.id = o.quote_id
        WHERE o.shop_id = $1 AND o.status <> 'AWAITING_PAYMENT' AND ($2::text IS NULL OR o.status = $2)
          AND ($3::timestamptz IS NULL OR (o.created_at, o.id) < ($3, $4::uuid))
        ORDER BY o.created_at DESC, o.id DESC LIMIT $5`,
      [m.shopId, q.status ?? null, cur?.createdAt ?? null, cur?.id ?? null, q.limit + 1],
    );
    return page(rows, q.limit);
  }

  @Get("shops/:shopId/orders/:orderId")
  async order(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("orderId") orderIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.view");
    const orderId = parse(uuid, orderIdRaw);
    const { rows } = await this.pool.query<{ status: OrderStatus } & Record<string, unknown>>(
      `SELECT o.id, o.reference, o.status, o.row_version AS version, o.total_kobo AS "totalKobo", o.created_at AS "createdAt", o.status_changed_at AS "statusChangedAt",
              q.spec, q.lines, q.total_sheets AS "totalSheets", q.subtotal_kobo AS "shopRevenueKobo", pl.name AS "pickupLocation",
              u.full_name AS "studentName", a.title AS "documentTitle", v.page_count AS "pageCount", v.page_size AS "documentPageSize",
              v.print_sha256 AS "printSha256", v.version_number AS "documentVersion", o.reprint_of_order_id AS "reprintOfOrderId"
         FROM orders o JOIN quotes q ON q.id = o.quote_id JOIN pickup_locations pl ON pl.id = o.pickup_location_id
         JOIN users u ON u.id = o.student_user_id JOIN document_versions v ON v.id = o.document_version_id JOIN document_assets a ON a.id = v.asset_id
        WHERE o.id = $1 AND o.shop_id = $2 AND o.status <> 'AWAITING_PAYMENT'`,
      [orderId, m.shopId],
    );
    const o = rows[0];
    if (!o) throw Errors.notFound("order");
    const [events, qc] = await Promise.all([
      this.pool.query(
        `SELECT e.from_status AS "from", e.to_status AS "to", e.reason, e.actor_kind AS "actorKind", u.full_name AS "actorName", d.label AS device, e.occurred_at AS "at"
           FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id LEFT JOIN devices d ON d.id = e.device_id WHERE e.order_id = $1 ORDER BY e.id`,
        [orderId],
      ),
      this.pool.query(
        `SELECT qc.result, qc.issues, qc.sheets_counted AS "sheetsCounted", qc.notes, u.full_name AS "checkedBy", qc.checked_at AS "checkedAt"
           FROM quality_checks qc JOIN users u ON u.id = qc.checked_by WHERE qc.order_id = $1 ORDER BY qc.checked_at`,
        [orderId],
      ),
    ]);
    return {
      ...o,
      statusLabel: ORDER_STATUS_LABELS[o.status],
      actions: allowedNextStatuses(o.status, "SHOP_STAFF", m.permissions),
      canDownload: m.permissions.includes("documents.download") && DOWNLOADABLE.includes(o.status),
      events: events.rows,
      qualityChecks: qc.rows,
    };
  }

  @Post("shops/:shopId/orders/:orderId/transitions")
  @HttpCode(200)
  async transition(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("orderId") orderIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.view");
    const input = parse(Schemas.Transition, body);
    if (input.to === "READY_FOR_PICKUP" || input.to === "COLLECTED") {
      throw Errors.rule(input.to === "COLLECTED" ? "collection requires the student's pickup code" : "record a quality check to mark the job ready", "USE_DEDICATED_ACTION");
    }
    if (input.deviceId) await this.assertDevice(m.shopId, input.deviceId);
    const r = await withTransaction(this.pool, (c) =>
      transitionOrder(c, {
        orderId: parse(uuid, orderIdRaw),
        to: input.to,
        scope: { kind: "SHOP", shopId: m.shopId },
        actorUserId: m.auth.userId,
        permissions: m.permissions,
        reason: input.reason,
        expectedVersion: input.expectedVersion,
        deviceId: input.deviceId,
        requestId: req.id,
      }),
    );
    return { id: r.id, status: r.status, version: r.row_version, statusLabel: ORDER_STATUS_LABELS[r.status] };
  }

  private async assertDevice(shopId: string, deviceId: string) {
    const d = await this.pool.query(`SELECT 1 FROM devices WHERE id = $1 AND shop_id = $2`, [deviceId, shopId]);
    if (!d.rowCount) throw Errors.rule("that printer does not belong to this shop", "INVALID_DEVICE");
  }

  @Post("shops/:shopId/orders/:orderId/quality-checks")
  @HttpCode(201)
  async qualityCheck(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("orderId") orderIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.qa");
    const orderId = parse(uuid, orderIdRaw);
    const input = parse(Schemas.QualityCheck, body);
    if (input.result === "FAIL" && input.issues.length === 0) throw Errors.rule("list what was wrong", "ISSUES_REQUIRED");
    const r = await withTransaction(this.pool, async (c) => {
      const cur = await c.query<{ status: OrderStatus; total_sheets: number }>(
        `SELECT o.status, q.total_sheets FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.id = $1 AND o.shop_id = $2 FOR UPDATE OF o`,
        [orderId, m.shopId],
      );
      if (!cur.rows[0]) throw Errors.notFound("order");
      if (cur.rows[0].status !== "QUALITY_CHECK") throw Errors.rule("the job must be in quality check", "NOT_IN_QA");
      // A sheet-count mismatch is always recorded as an issue, even if staff pass it.
      const issues = [...input.issues];
      if (input.sheetsCounted !== undefined && input.sheetsCounted !== cur.rows[0].total_sheets && !issues.includes("PAGE_COUNT_MISMATCH")) issues.push("PAGE_COUNT_MISMATCH");
      const result = input.result === "PASS" && issues.includes("PAGE_COUNT_MISMATCH") ? "FAIL" : input.result;
      await c.query(`INSERT INTO quality_checks (order_id, shop_id, checked_by, result, issues, sheets_counted, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        orderId,
        m.shopId,
        m.auth.userId,
        result,
        issues,
        input.sheetsCounted ?? null,
        input.notes ?? null,
      ]);
      return transitionOrder(c, {
        orderId,
        to: result === "PASS" ? "READY_FOR_PICKUP" : "PRINTING",
        scope: { kind: "SHOP", shopId: m.shopId },
        actorUserId: m.auth.userId,
        permissions: m.permissions,
        reason: result === "PASS" ? undefined : `Reprint after QA: ${issues.join(", ")}${input.notes ? ` — ${input.notes}` : ""}`,
        expectedVersion: input.expectedVersion,
        requestId: req.id,
      });
    });
    return { id: r.id, status: r.status, version: r.row_version, statusLabel: ORDER_STATUS_LABELS[r.status] };
  }

  /** Short-lived, single-object link to the print-ready file. Every issue is audited. */
  @Post("shops/:shopId/orders/:orderId/document-link")
  @HttpCode(201)
  async documentLink(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("orderId") orderIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "documents.download");
    const orderId = parse(uuid, orderIdRaw);
    await this.limiter.hit(`doc-link:${m.auth.userId}`, 120, 3600);
    const { rows } = await this.pool.query<{ status: OrderStatus; reference: string; print_storage_key: string; files_purged_at: Date | null }>(
      `SELECT o.status, o.reference, v.print_storage_key, v.files_purged_at FROM orders o JOIN document_versions v ON v.id = o.document_version_id
        WHERE o.id = $1 AND o.shop_id = $2`,
      [orderId, m.shopId],
    );
    const o = rows[0];
    if (!o) throw Errors.notFound("order");
    if (!DOWNLOADABLE.includes(o.status)) throw Errors.rule("accept the job before downloading its file", "NOT_DOWNLOADABLE");
    if (o.files_purged_at) throw Errors.gone("this file has been deleted under the retention policy", "PURGED");
    const url = await this.storage.signedDownloadUrl(o.print_storage_key, { ttlSeconds: this.cfg.SIGNED_URL_TTL_SECONDS, filename: `${o.reference}.pdf`, contentType: "application/pdf" });
    await this.staffAudit(m, req, "document.download_link_issued", "order", orderId);
    return { url, expiresInSeconds: this.cfg.SIGNED_URL_TTL_SECONDS };
  }

  @Post("shops/:shopId/orders/:orderId/collect")
  @HttpCode(200)
  async collect(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("orderId") orderIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.collect");
    const orderId = parse(uuid, orderIdRaw);
    await this.limiter.hit(`collect:${m.shopId}`, 120, 60);
    const { code } = parse(Schemas.Collect, body);
    // Committed even on failure so the attempt counter persists.
    const r = await withTransaction(this.pool, (c) =>
      redeemPickupCode(c, { orderId, shopId: m.shopId, staffUserId: m.auth.userId, permissions: m.permissions, candidate: code, pepper: this.cfg.PICKUP_CODE_PEPPER }),
    );
    if (!r.ok) {
      const messages: Record<typeof r.reason, string> = {
        ALREADY_COLLECTED: "this order has already been collected",
        NOT_READY: "this order is not ready for pickup",
        NO_ACTIVE_CODE: "the student has not generated a pickup code yet",
        EXPIRED: "this pickup code has expired; ask the student to generate a new one",
        USED: "this pickup code has already been used",
        REVOKED: "this pickup code was replaced by a newer one",
        LOCKED: "too many wrong attempts; ask the student to generate a new code",
        WRONG_CODE: "the code is incorrect",
      };
      throw Errors.rule(messages[r.reason], `PICKUP_${r.reason}`);
    }
    return { collected: true };
  }

  /**
   * Offline-safe reconciliation. The operator app queues actions while offline
   * and sends them here. Each action applies only if the order is still at the
   * version the operator saw; otherwise it is reported as a conflict with the
   * current state. Nothing is reported as applied unless it committed.
   */
  @Post("shops/:shopId/sync")
  @HttpCode(200)
  async sync(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.view");
    const { actions } = parse(Schemas.SyncActions, body);
    const results = [];
    for (const a of actions) {
      const seen = await this.pool.query<{ response_body: unknown }>(`SELECT response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [m.auth.userId, `sync-${a.clientActionId}`]);
      if (seen.rows[0]?.response_body) {
        results.push(seen.rows[0].response_body);
        continue;
      }
      let result: Record<string, unknown>;
      try {
        if (a.to === "READY_FOR_PICKUP" || a.to === "COLLECTED") throw Errors.rule("this action must be done online", "ONLINE_ONLY");
        const r = await withTransaction(this.pool, async (c) => {
          const out = await transitionOrder(c, {
            orderId: a.orderId,
            to: a.to,
            scope: { kind: "SHOP", shopId: m.shopId },
            actorUserId: m.auth.userId,
            permissions: m.permissions,
            reason: a.reason,
            expectedVersion: a.expectedVersion,
            deviceId: a.deviceId,
            requestId: req.id,
          });
          const res = { clientActionId: a.clientActionId, outcome: "APPLIED", status: out.status, version: out.row_version };
          await c.query(`INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body) VALUES ($1, $2, 'sync', 200, $3)`, [
            m.auth.userId,
            `sync-${a.clientActionId}`,
            JSON.stringify(res),
          ]);
          return res;
        });
        result = r;
      } catch (e) {
        const cur = await this.pool.query<{ status: string; row_version: number }>(`SELECT status, row_version FROM orders WHERE id = $1 AND shop_id = $2`, [a.orderId, m.shopId]);
        const err = toApiError(e);
        result = {
          clientActionId: a.clientActionId,
          outcome: e instanceof ConflictError ? "CONFLICT" : "REJECTED",
          error: { code: err.code, message: err.message },
          current: cur.rows[0] ? { status: cur.rows[0].status, version: cur.rows[0].row_version } : null,
        };
      }
      results.push(result);
    }
    return { results };
  }

  // ---------------------------------------------------------------- power

  /**
   * Staff report the shop's power: light on, generator on, or light out (with an
   * optional expected return time). Students see it next to the shop. It is a
   * report, never a sensor reading, and the UI says who reported it and when.
   */
  @Put("shops/:shopId/power")
  async reportPower(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.produce");
    const input = parse(Schemas.ShopPower, body);
    await this.limiter.hit(`power:${m.shopId}`, 60, 3600);
    let backAt: Date | null = null;
    if (input.backAt) {
      backAt = new Date(input.backAt);
      try {
        validateBackAt(backAt);
      } catch (e) {
        throw Errors.rule((e as Error).message, "INVALID_BACK_AT");
      }
    }
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `UPDATE shops SET power_status = $2, power_back_at = $3, power_note = $4, power_updated_at = now(), power_updated_by = $5 WHERE id = $1`,
        [m.shopId, input.status, backAt, input.note || null, m.auth.userId],
      );
      await audit(c, {
        universityId: m.universityId,
        shopId: m.shopId,
        actorUserId: m.auth.userId,
        actorKind: "SHOP_STAFF",
        action: "shop.power_reported",
        entityType: "shop",
        entityId: m.shopId,
        requestId: req.id,
        details: { status: input.status, backAt: backAt?.toISOString() ?? null },
      });
    });
    return shopPower(this.pool, m.shopId);
  }

  // ---------------------------------------------------------------- devices

  @Get("shops/:shopId/devices")
  async devices(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "orders.view");
    const { rows } = await this.pool.query(
      `SELECT d.id, d.label, d.capabilities, d.reported_status AS "reportedStatus", d.status_reported_at AS "statusReportedAt", u.full_name AS "reportedBy"
         FROM devices d LEFT JOIN users u ON u.id = d.status_reported_by WHERE d.shop_id = $1 ORDER BY d.label`,
      [m.shopId],
    );
    return { items: rows, note: "Statuses are reported manually by staff." };
  }

  @Post("shops/:shopId/devices")
  @HttpCode(201)
  async addDevice(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "devices.manage");
    const input = parse(Schemas.Device, body);
    const { rows } = await this.pool.query(
      `INSERT INTO devices (shop_id, university_id, label, capabilities) VALUES ($1, $2, $3, $4) RETURNING id, label, capabilities, reported_status AS "reportedStatus"`,
      [m.shopId, m.universityId, input.label, JSON.stringify(input.capabilities)],
    );
    await this.staffAudit(m, req, "device.added", "device", (rows[0] as { id: string }).id);
    return rows[0];
  }

  @Patch("shops/:shopId/devices/:deviceId")
  async updateDevice(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("deviceId") deviceIdRaw: string, @Body() body: unknown) {
    const shopId = parse(uuid, shopIdRaw);
    const input = parse(Schemas.UpdateDevice, body);
    // Reporting status is an operator task; renaming needs devices.manage.
    const m = await this.access.shop(req, shopId, input.label ? "devices.manage" : "orders.produce");
    const { rows } = await this.pool.query(
      `UPDATE devices SET label = COALESCE($3, label),
              reported_status = COALESCE($4, reported_status),
              status_reported_at = CASE WHEN $4::text IS NULL THEN status_reported_at ELSE now() END,
              status_reported_by = CASE WHEN $4::text IS NULL THEN status_reported_by ELSE $5 END
        WHERE id = $1 AND shop_id = $2
        RETURNING id, label, reported_status AS "reportedStatus", status_reported_at AS "statusReportedAt"`,
      [parse(uuid, deviceIdRaw), m.shopId, input.label ?? null, input.reportedStatus ?? null, m.auth.userId],
    );
    if (!rows[0]) throw Errors.notFound("device");
    await this.staffAudit(m, req, "device.updated", "device", (rows[0] as { id: string }).id, input);
    return rows[0];
  }

  // ---------------------------------------------------------------- staff

  @Get("shops/:shopId/staff")
  async staff(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "staff.manage");
    const { rows } = await this.pool.query(
      `SELECT m.id, m.role, m.permissions, u.full_name AS "fullName", u.email, m.created_at AS "createdAt",
              EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS "mfaEnrolled"
         FROM shop_memberships m JOIN users u ON u.id = m.user_id WHERE m.shop_id = $1 AND m.revoked_at IS NULL ORDER BY m.role, u.full_name`,
      [m.shopId],
    );
    return { items: rows };
  }

  @Post("shops/:shopId/staff")
  @HttpCode(201)
  async addStaff(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "staff.manage");
    const input = parse(Schemas.AddStaff, body);
    const u = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status = 'ACTIVE'`, [input.email]);
    if (!u.rows[0]) throw Errors.rule("ask this person to create a PrintFlow account first", "USER_NOT_FOUND");
    const permissions = this.capPermissions(m, input.permissions ?? ROLE_DEFAULT_PERMISSIONS[input.role]);
    const { rows } = await this.pool.query(
      `INSERT INTO shop_memberships (user_id, shop_id, university_id, role, permissions) VALUES ($1, $2, $3, $4, $5) RETURNING id, role, permissions`,
      [u.rows[0].id, m.shopId, m.universityId, input.role, permissions],
    );
    await this.staffAudit(m, req, "staff.added", "shop_membership", (rows[0] as { id: string }).id, { role: input.role, permissions });
    return rows[0];
  }

  /** Nobody can grant permissions they do not hold themselves (no privilege escalation). */
  private capPermissions(m: ShopMembership, wanted: readonly ShopPermission[]): ShopPermission[] {
    const extra = wanted.filter((p) => !m.permissions.includes(p));
    if (extra.length) throw Errors.forbidden(`you cannot grant permissions you do not hold: ${extra.join(", ")}`);
    return [...new Set(wanted)];
  }

  @Patch("shops/:shopId/staff/:membershipId")
  async updateStaff(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("membershipId") idRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "staff.manage");
    const input = parse(Schemas.UpdateStaff, body);
    const target = await this.pool.query<{ role: string; user_id: string }>(`SELECT role, user_id FROM shop_memberships WHERE id = $1 AND shop_id = $2 AND revoked_at IS NULL`, [
      parse(uuid, idRaw),
      m.shopId,
    ]);
    const t = target.rows[0];
    if (!t) throw Errors.notFound("staff member");
    if (t.role === "OWNER") throw Errors.forbidden("the owner's access cannot be changed here");
    if (t.user_id === m.auth.userId) throw Errors.forbidden("you cannot change your own permissions");
    const permissions = input.permissions ? this.capPermissions(m, input.permissions) : null;
    const { rows } = await this.pool.query(
      `UPDATE shop_memberships SET role = COALESCE($3, role), permissions = COALESCE($4, permissions) WHERE id = $1 AND shop_id = $2 RETURNING id, role, permissions`,
      [parse(uuid, idRaw), m.shopId, input.role ?? null, permissions],
    );
    await this.staffAudit(m, req, "staff.updated", "shop_membership", parse(uuid, idRaw), input);
    return rows[0];
  }

  @Delete("shops/:shopId/staff/:membershipId")
  @HttpCode(204)
  async removeStaff(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("membershipId") idRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "staff.manage");
    const r = await this.pool.query(`UPDATE shop_memberships SET revoked_at = now() WHERE id = $1 AND shop_id = $2 AND role <> 'OWNER' AND revoked_at IS NULL`, [
      parse(uuid, idRaw),
      m.shopId,
    ]);
    if (!r.rowCount) throw Errors.notFound("staff member");
    await this.staffAudit(m, req, "staff.removed", "shop_membership", parse(uuid, idRaw));
  }

  // ---------------------------------------------------------------- merchant pricing

  @Get("shops/:shopId/rate-cards")
  async rateCards(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "pricing.manage");
    const [cards, bounds, mode] = await Promise.all([
      loadRateCards(this.pool, { universityId: m.universityId, shopId: m.shopId, publishedOnly: false }),
      loadBounds(this.pool, m.universityId),
      this.pool.query<{ pricing_mode: string }>(`SELECT pricing_mode FROM universities WHERE id = $1`, [m.universityId]),
    ]);
    return { pricingMode: mode.rows[0]!.pricing_mode, items: cards, bounds };
  }

  @Post("shops/:shopId/rate-cards")
  @HttpCode(201)
  async draftRateCard(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Body() body: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "pricing.manage");
    const mode = await this.pool.query<{ pricing_mode: string }>(`SELECT pricing_mode FROM universities WHERE id = $1`, [m.universityId]);
    if (mode.rows[0]!.pricing_mode !== "MERCHANT_CONTROLLED") throw Errors.forbidden("your university sets prices centrally; shops cannot publish their own price lists");
    const input = parse(Schemas.RateCardDraft, body);
    const id = await withTransaction(this.pool, (c) => insertRateCardDraft(c, { universityId: m.universityId, shopId: m.shopId, createdBy: m.auth.userId, draft: input }));
    await this.staffAudit(m, req, "rate_card.drafted", "rate_card", id);
    return { id, status: "DRAFT" };
  }

  @Post("shops/:shopId/rate-cards/:rateCardId/publish")
  @HttpCode(200)
  async publishRateCard(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Param("rateCardId") idRaw: string) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "pricing.manage");
    const id = parse(uuid, idRaw);
    const cards = await loadRateCards(this.pool, { universityId: m.universityId, shopId: m.shopId, publishedOnly: false });
    const card = cards.find((c) => c.id === id);
    if (!card) throw Errors.notFound("rate card");
    if (card.status !== "DRAFT") throw Errors.conflict("only drafts can be published", "NOT_DRAFT");
    validateRateCard(card);
    const bounds = await loadBounds(this.pool, m.universityId);
    if (!bounds) throw Errors.rule("your university has not set the agreed price ranges yet", "NO_PRICE_AGREEMENT");
    validateAgainstBounds(card, bounds);
    await this.pool.query(`UPDATE rate_cards SET status = 'PUBLISHED', published_at = now(), published_by = $2 WHERE id = $1 AND status = 'DRAFT'`, [id, m.auth.userId]);
    await this.staffAudit(m, req, "rate_card.published", "rate_card", id, { version: card.version });
    return { id, status: "PUBLISHED", version: card.version };
  }

  // ---------------------------------------------------------------- reports

  @Get("shops/:shopId/reports/summary")
  async summary(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Query() query: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "reports.view");
    const { from, to } = parse(Schemas.DateRange, query);
    const range = [from ?? new Date(Date.now() - 30 * 86_400_000).toISOString(), to ?? new Date().toISOString()];
    const [byStatus, money, turnaround, qa] = await Promise.all([
      this.pool.query(`SELECT status, count(*)::int AS n FROM orders WHERE shop_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY status ORDER BY status`, [m.shopId, ...range]),
      this.pool.query<{ collected_revenue: string; paid_orders: string; fees: string }>(
        `SELECT COALESCE(sum(q.subtotal_kobo) FILTER (WHERE o.status = 'COLLECTED'), 0) AS collected_revenue,
                count(*) FILTER (WHERE o.status NOT IN ('AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED')) AS paid_orders,
                COALESCE(sum(q.service_fee_kobo) FILTER (WHERE o.status = 'COLLECTED'), 0) AS fees
           FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.shop_id = $1 AND o.created_at >= $2 AND o.created_at < $3`,
        [m.shopId, ...range],
      ),
      this.pool.query<{ median_minutes: number | null; p90_minutes: number | null }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mins) AS median_minutes, percentile_cont(0.9) WITHIN GROUP (ORDER BY mins) AS p90_minutes FROM (
           SELECT extract(epoch FROM (r.occurred_at - p.occurred_at)) / 60 AS mins FROM orders o
             JOIN LATERAL (SELECT occurred_at FROM order_events WHERE order_id = o.id AND to_status = 'PAID' ORDER BY id LIMIT 1) p ON true
             JOIN LATERAL (SELECT occurred_at FROM order_events WHERE order_id = o.id AND to_status = 'READY_FOR_PICKUP' ORDER BY id DESC LIMIT 1) r ON true
            WHERE o.shop_id = $1 AND o.created_at >= $2 AND o.created_at < $3) t`,
        [m.shopId, ...range],
      ),
      this.pool.query<{ pass: string; fail: string }>(
        `SELECT count(*) FILTER (WHERE result = 'PASS') AS pass, count(*) FILTER (WHERE result = 'FAIL') AS fail FROM quality_checks WHERE shop_id = $1 AND checked_at >= $2 AND checked_at < $3`,
        [m.shopId, ...range],
      ),
    ]);
    const t = turnaround.rows[0];
    return {
      range: { from: range[0], to: range[1] },
      ordersByStatus: byStatus.rows,
      paidOrders: Number(money.rows[0]!.paid_orders),
      collectedRevenueKobo: Number(money.rows[0]!.collected_revenue),
      platformFeesKobo: Number(money.rows[0]!.fees),
      turnaround: { medianMinutes: t?.median_minutes === null || t?.median_minutes === undefined ? null : Math.round(t.median_minutes), p90Minutes: t?.p90_minutes === null || t?.p90_minutes === undefined ? null : Math.round(t.p90_minutes) },
      qualityChecks: { pass: Number(qa.rows[0]!.pass), fail: Number(qa.rows[0]!.fail) },
    };
  }

  /** Money in vs. work done, per day: payments confirmed, refunds, and collected order value. */
  @Get("shops/:shopId/reports/reconciliation")
  async reconciliation(@Req() req: PfRequest, @Param("shopId") shopIdRaw: string, @Query() query: unknown) {
    const m = await this.access.shop(req, parse(uuid, shopIdRaw), "reports.view");
    const { from, to } = parse(Schemas.DateRange, query);
    const range = [from ?? new Date(Date.now() - 30 * 86_400_000).toISOString(), to ?? new Date().toISOString()];
    const { rows } = await this.pool.query(
      `WITH days AS (SELECT generate_series(date_trunc('day', $2::timestamptz), date_trunc('day', $3::timestamptz), interval '1 day') AS day)
       SELECT d.day::date AS day,
              COALESCE((SELECT sum(p.amount_kobo) FROM payments p JOIN orders o ON o.id = p.order_id
                         WHERE o.shop_id = $1 AND p.status = 'SUCCEEDED' AND date_trunc('day', p.confirmed_at) = d.day), 0)::bigint AS "paymentsKobo",
              COALESCE((SELECT sum(r.amount_kobo) FROM refunds r JOIN orders o ON o.id = r.order_id
                         WHERE o.shop_id = $1 AND r.status = 'SUCCEEDED' AND date_trunc('day', r.completed_at) = d.day), 0)::bigint AS "refundsKobo",
              COALESCE((SELECT sum(q.subtotal_kobo) FROM orders o JOIN quotes q ON q.id = o.quote_id
                         WHERE o.shop_id = $1 AND o.status = 'COLLECTED' AND date_trunc('day', o.status_changed_at) = d.day), 0)::bigint AS "collectedRevenueKobo",
              (SELECT count(*) FROM orders o WHERE o.shop_id = $1 AND o.status = 'COLLECTED' AND date_trunc('day', o.status_changed_at) = d.day)::int AS "collectedOrders"
         FROM days d ORDER BY d.day`,
      [m.shopId, ...range],
    );
    const unmatched = await this.pool.query(
      `SELECT e.id, e.event_type AS "eventType", e.processing_error AS error, e.received_at AS "receivedAt" FROM payment_webhook_events e
        WHERE e.processing_error IS NOT NULL AND e.signature_valid AND e.received_at >= $1 AND e.received_at < $2 ORDER BY e.id DESC LIMIT 20`,
      range,
    );
    return { range: { from: range[0], to: range[1] }, days: rows.map((r) => ({ ...r, paymentsKobo: Number(r.paymentsKobo), refundsKobo: Number(r.refundsKobo), collectedRevenueKobo: Number(r.collectedRevenueKobo) })), unmatchedProviderEvents: unmatched.rows };
  }
}
