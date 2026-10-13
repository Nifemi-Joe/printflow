import { describePower, estimateQueue, type PowerStatus, type QueueEstimate } from "../../../../packages/domain/src/index.js";
import type { Queryable } from "../../../../packages/data/src/index.js";
import {
  resolvePricing,
  type FinishingService,
  type PriceBounds,
  type PricingMode,
  type RateCard,
  type ResolvedPricing,
  type ShopPriceOverride,
} from "../../../../packages/pricing/src/index.js";

interface CardRow {
  id: string;
  university_id: string;
  shop_id: string | null;
  version: number;
  status: string;
  odd_page_duplex_policy: RateCard["oddPageDuplexPolicy"];
  minimum_charge_kobo: string;
  effective_from: Date;
  effective_to: Date | null;
  published_at: Date | null;
  created_at: Date;
}

/** Loads rate cards (with their lines) into the pricing engine's shape. */
export async function loadRateCards(db: Queryable, where: { universityId: string; shopId?: string | null; publishedOnly: boolean }): Promise<Array<RateCard & { status: string; publishedAt: Date | null }>> {
  const params: unknown[] = [where.universityId];
  let filter = "";
  if (where.shopId === null) filter += " AND shop_id IS NULL";
  else if (where.shopId) {
    params.push(where.shopId);
    filter += ` AND shop_id = $${params.length}`;
  }
  if (where.publishedOnly) filter += " AND status = 'PUBLISHED'";
  const cards = await db.query<CardRow>(`SELECT * FROM rate_cards WHERE university_id = $1 ${filter} ORDER BY version DESC`, params);
  if (cards.rows.length === 0) return [];
  const ids = cards.rows.map((c) => c.id);
  const [sheets, finishing] = await Promise.all([
    db.query<{ rate_card_id: string; paper_size: RateCard["sheetPrices"][number]["paperSize"]; colour_mode: "BW" | "COLOUR"; sides: "SINGLE" | "DOUBLE"; price_per_sheet_kobo: string }>(
      `SELECT * FROM rate_card_sheet_prices WHERE rate_card_id = ANY($1) ORDER BY paper_size, colour_mode, sides`,
      [ids],
    ),
    db.query<{ rate_card_id: string; code: string; name: string; unit: FinishingService["unit"]; price_kobo: string; paper_sizes: FinishingService["paperSizes"] | null }>(
      `SELECT * FROM rate_card_finishing WHERE rate_card_id = ANY($1) ORDER BY code`,
      [ids],
    ),
  ]);
  return cards.rows.map((c) => ({
    id: c.id,
    universityId: c.university_id,
    shopId: c.shop_id,
    version: c.version,
    currency: "NGN" as const,
    status: c.status,
    publishedAt: c.published_at,
    oddPageDuplexPolicy: c.odd_page_duplex_policy,
    minimumCharge: Number(c.minimum_charge_kobo),
    effectiveFrom: c.effective_from,
    effectiveTo: c.effective_to,
    sheetPrices: sheets.rows
      .filter((s) => s.rate_card_id === c.id)
      .map((s) => ({ paperSize: s.paper_size, colourMode: s.colour_mode, sides: s.sides, pricePerSheet: Number(s.price_per_sheet_kobo) })),
    finishing: finishing.rows
      .filter((f) => f.rate_card_id === c.id)
      .map((f) => ({ code: f.code, name: f.name, unit: f.unit, price: Number(f.price_kobo), ...(f.paper_sizes ? { paperSizes: f.paper_sizes } : {}) })),
  }));
}

export async function loadBounds(db: Queryable, universityId: string): Promise<PriceBounds | null> {
  const { rows } = await db.query<{ paper_size: PriceBounds["sheet"][number]["paperSize"]; colour_mode: "BW" | "COLOUR"; sides: "SINGLE" | "DOUBLE"; min_kobo: string; max_kobo: string }>(
    `SELECT * FROM price_bounds WHERE university_id = $1`,
    [universityId],
  );
  if (rows.length === 0) return null;
  return {
    sheet: rows.map((r) => ({ paperSize: r.paper_size, colourMode: r.colour_mode, sides: r.sides, min: Number(r.min_kobo), max: Number(r.max_kobo) })),
    // Finishing ceiling: platform rule, 20,000 NGN per line.
    finishingMax: 2_000_000,
  };
}

export async function loadOverrides(db: Queryable, shopId: string): Promise<ShopPriceOverride[]> {
  const { rows } = await db.query<{
    shop_id: string;
    rate_card_id: string;
    kind: "SHEET" | "FINISHING";
    paper_size: ShopPriceOverride["paperSize"] | null;
    colour_mode: ShopPriceOverride["colourMode"] | null;
    sides: ShopPriceOverride["sides"] | null;
    finishing_code: string | null;
    price_kobo: string;
    approved_by: string;
  }>(`SELECT * FROM shop_price_overrides WHERE shop_id = $1 AND revoked_at IS NULL`, [shopId]);
  return rows.map((r) => ({
    shopId: r.shop_id,
    rateCardId: r.rate_card_id,
    kind: r.kind,
    ...(r.paper_size ? { paperSize: r.paper_size } : {}),
    ...(r.colour_mode ? { colourMode: r.colour_mode } : {}),
    ...(r.sides ? { sides: r.sides } : {}),
    ...(r.finishing_code ? { finishingCode: r.finishing_code } : {}),
    price: Number(r.price_kobo),
    approvedBy: r.approved_by,
  }));
}

/** Resolves the pricing that governs this shop right now, per the university's mode. */
export async function resolveShopPricing(db: Queryable, universityId: string, shopId: string, mode: PricingMode, at = new Date()): Promise<ResolvedPricing> {
  const [universityCards, shopCards, overrides, bounds] = await Promise.all([
    mode === "UNIVERSITY_CONTROLLED" ? loadRateCards(db, { universityId, shopId: null, publishedOnly: true }) : Promise.resolve([]),
    mode === "MERCHANT_CONTROLLED" ? loadRateCards(db, { universityId, shopId, publishedOnly: true }) : Promise.resolve([]),
    mode === "UNIVERSITY_CONTROLLED" ? loadOverrides(db, shopId) : Promise.resolve([]),
    mode === "MERCHANT_CONTROLLED" ? loadBounds(db, universityId) : Promise.resolve(null),
  ]);
  return resolvePricing({ mode, shopId, at, universityCards, shopCards, overrides, bounds });
}

/** Queue estimate for a shop from its own recent production history. */
export async function shopQueueEstimate(db: Queryable, shopId: string, forOrderId?: string): Promise<QueueEstimate & { activeDevices: number }> {
  const [ahead, samples, devices] = await Promise.all([
    db.query<{ order_id: string; total_sheets: number }>(
      `SELECT qe.order_id, q.total_sheets FROM queue_entries qe JOIN orders o ON o.id = qe.order_id JOIN quotes q ON q.id = o.quote_id
        WHERE qe.shop_id = $1 ORDER BY qe.priority DESC, qe.enqueued_at, qe.order_id`,
      [shopId],
    ),
    db.query<{ sheets: number; seconds: number }>(
      `SELECT q.total_sheets AS sheets,
              extract(epoch FROM (r.occurred_at - p.occurred_at))::int AS seconds
         FROM orders o JOIN quotes q ON q.id = o.quote_id
         JOIN LATERAL (SELECT occurred_at FROM order_events WHERE order_id = o.id AND to_status = 'PRINTING' ORDER BY id LIMIT 1) p ON true
         JOIN LATERAL (SELECT occurred_at FROM order_events WHERE order_id = o.id AND to_status = 'READY_FOR_PICKUP' ORDER BY id DESC LIMIT 1) r ON true
        WHERE o.shop_id = $1 AND o.status IN ('READY_FOR_PICKUP', 'COLLECTED') AND o.status_changed_at > now() - interval '30 days'
        ORDER BY o.status_changed_at DESC LIMIT 50`,
      [shopId],
    ),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM devices WHERE shop_id = $1 AND reported_status IN ('AVAILABLE', 'BUSY')`, [shopId]),
  ]);
  const rows = ahead.rows;
  const idx = forOrderId ? rows.findIndex((r) => r.order_id === forOrderId) : -1;
  const before = idx >= 0 ? rows.slice(0, idx) : rows;
  const own = idx >= 0 ? rows[idx]!.total_sheets : 0;
  const activeDevices = Number(devices.rows[0]?.n ?? 0);
  return {
    ...estimateQueue({
      sheetsAheadPerJob: before.map((r) => r.total_sheets),
      ownSheets: own,
      samples: samples.rows.map((s) => ({ sheets: s.sheets, productionSeconds: s.seconds })),
      activeDevices,
    }),
    activeDevices,
  };
}

/** The shop's power report, as students and staff see it. */
export async function shopPower(pool: Queryable, shopId: string) {
  const { rows } = await pool.query<{ power_status: PowerStatus; power_back_at: Date | null; power_note: string | null; power_updated_at: Date | null; updated_by: string | null }>(
    `SELECT s.power_status, s.power_back_at, s.power_note, s.power_updated_at, u.full_name AS updated_by
       FROM shops s LEFT JOIN users u ON u.id = s.power_updated_by WHERE s.id = $1`,
    [shopId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...describePower({ status: r.power_status, backAt: r.power_back_at, note: r.power_note, updatedAt: r.power_updated_at }),
    updatedBy: r.updated_by,
  };
}
