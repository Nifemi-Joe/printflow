import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import type { Pool } from "pg";
import { formatNaira } from "../../../../packages/pricing/src/index.js";
import { Errors } from "../http/errors.js";
import { parse, uuid } from "../http/validate.js";
import { PG_POOL } from "../infra/tokens.js";
import { resolveShopPricing, shopPower, shopQueueEstimate } from "./pricing-data.js";
import { z } from "zod";

/** Public, read-only information students need before signing up or ordering. */
@Controller("v1")
export class CatalogueController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get("universities")
  async universities() {
    const { rows } = await this.pool.query(`SELECT id, slug, name FROM universities WHERE status = 'ACTIVE' ORDER BY name`);
    return { items: rows };
  }

  @Get("universities/:universityId")
  async university(@Param("universityId") universityIdRaw: string) {
    const universityId = parse(uuid, universityIdRaw);
    const uni = await this.pool.query(
      `SELECT id, slug, name, pricing_mode AS "pricingMode", document_retention_days AS "documentRetentionDays",
              service_fee_fixed_kobo AS "serviceFeeFixedKobo", service_fee_bps AS "serviceFeeBps"
         FROM universities WHERE id = $1 AND status = 'ACTIVE'`,
      [universityId],
    );
    if (!uni.rows[0]) throw Errors.notFound("university");
    const campuses = await this.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM campuses WHERE university_id = $1 AND is_active ORDER BY name`,
      [universityId],
    );
    const departments = await this.pool.query<{ id: string; name: string; campus_id: string }>(
      `SELECT id, name, campus_id FROM departments WHERE university_id = $1 ORDER BY name`,
      [universityId],
    );
    return {
      ...uni.rows[0],
      campuses: campuses.rows.map((c) => ({ ...c, departments: departments.rows.filter((d) => d.campus_id === c.id).map(({ id, name }) => ({ id, name })) })),
    };
  }

  @Get("universities/:universityId/shops")
  async shops(@Param("universityId") universityIdRaw: string, @Query() q: unknown) {
    const universityId = parse(uuid, universityIdRaw);
    const { campusId } = parse(z.object({ campusId: uuid.optional() }), q);
    const { rows } = await this.pool.query<{ id: string; name: string; campus_id: string; campus_name: string; accepting_orders: boolean; location_note: string | null; opening_hours: unknown }>(
      `SELECT s.id, s.name, s.campus_id, c.name AS campus_name, s.accepting_orders, s.location_note, s.opening_hours
         FROM shops s JOIN campuses c ON c.id = s.campus_id JOIN universities u ON u.id = s.university_id
        WHERE s.university_id = $1 AND s.status = 'APPROVED' AND u.status = 'ACTIVE' AND ($2::uuid IS NULL OR s.campus_id = $2)
        ORDER BY s.name`,
      [universityId, campusId ?? null],
    );
    const items = await Promise.all(
      rows.map(async (s) => {
        const [pickup, devices, estimate, power] = await Promise.all([
          this.pool.query(`SELECT id, name FROM pickup_locations WHERE shop_id = $1 AND is_active ORDER BY name`, [s.id]),
          this.pool.query<{ reported_status: string; n: string }>(
            `SELECT reported_status, count(*) AS n FROM devices WHERE shop_id = $1 GROUP BY reported_status`,
            [s.id],
          ),
          shopQueueEstimate(this.pool, s.id),
          shopPower(this.pool, s.id),
        ]);
        return {
          id: s.id,
          name: s.name,
          campus: { id: s.campus_id, name: s.campus_name },
          acceptingOrders: s.accepting_orders,
          locationNote: s.location_note,
          openingHours: s.opening_hours,
          pickupLocations: pickup.rows,
          // Device status is manually reported by shop staff, never live telemetry.
          devicesReported: Object.fromEntries(devices.rows.map((d) => [d.reported_status, Number(d.n)])),
          queue: { jobsAhead: estimate.jobsAhead, sheetsAhead: estimate.sheetsAhead, estimatedMinutes: estimate.estimatedMinutes, basis: estimate.basis },
          // Reported by shop staff (light on / generator / light out), never sensed.
          power,
        };
      }),
    );
    return { items };
  }

  /** Transparent, public price list for a shop: exactly what the quote engine will use. */
  @Get("shops/:shopId/price-list")
  async priceList(@Param("shopId") shopIdRaw: string) {
    const shopId = parse(uuid, shopIdRaw);
    const { rows } = await this.pool.query<{ university_id: string; pricing_mode: "UNIVERSITY_CONTROLLED" | "MERCHANT_CONTROLLED"; service_fee_fixed_kobo: string; service_fee_bps: number }>(
      `SELECT s.university_id, u.pricing_mode, u.service_fee_fixed_kobo, u.service_fee_bps FROM shops s JOIN universities u ON u.id = s.university_id
        WHERE s.id = $1 AND s.status = 'APPROVED' AND u.status = 'ACTIVE'`,
      [shopId],
    );
    const shop = rows[0];
    if (!shop) throw Errors.notFound("shop");
    try {
      const { card, overrides } = await resolveShopPricing(this.pool, shop.university_id, shopId, shop.pricing_mode);
      const sheetPrice = (s: (typeof card.sheetPrices)[number]) =>
        overrides.find((o) => o.kind === "SHEET" && o.paperSize === s.paperSize && o.colourMode === s.colourMode && o.sides === s.sides)?.price ?? s.pricePerSheet;
      return {
        configured: true,
        pricingMode: shop.pricing_mode,
        rateCard: { id: card.id, version: card.version, effectiveFrom: card.effectiveFrom, effectiveTo: card.effectiveTo },
        oddPageDuplexPolicy: card.oddPageDuplexPolicy,
        minimumChargeKobo: card.minimumCharge,
        serviceFee: { fixedKobo: Number(shop.service_fee_fixed_kobo), bps: shop.service_fee_bps },
        sheetPrices: card.sheetPrices.map((s) => ({ ...s, pricePerSheet: sheetPrice(s), display: formatNaira(sheetPrice(s)) })),
        finishing: card.finishing.map((f) => {
          const price = overrides.find((o) => o.kind === "FINISHING" && o.finishingCode === f.code)?.price ?? f.price;
          return { ...f, price, display: formatNaira(price) };
        }),
      };
    } catch {
      return { configured: false, pricingMode: shop.pricing_mode, message: "This shop has no published price list yet, so it cannot take orders." };
    }
  }
}
