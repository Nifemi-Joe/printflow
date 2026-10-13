import type { z } from "zod";
import type { Queryable } from "../../../../packages/data/src/index.js";
import type { Schemas } from "../http/schemas.js";

type Draft = z.infer<typeof Schemas.RateCardDraft>;

/** Inserts a DRAFT rate card at the next version for its scope (campus or one shop). */
export async function insertRateCardDraft(db: Queryable, p: { universityId: string; shopId: string | null; createdBy: string; draft: Draft }): Promise<string> {
  // Serialise version allocation per scope.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rate-card:${p.universityId}:${p.shopId ?? "campus"}`]);
  const v = await db.query<{ n: number }>(
    `SELECT COALESCE(max(version), 0) + 1 AS n FROM rate_cards WHERE university_id = $1 AND ${p.shopId ? "shop_id = $2" : "shop_id IS NULL"}`,
    p.shopId ? [p.universityId, p.shopId] : [p.universityId],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO rate_cards (university_id, shop_id, version, odd_page_duplex_policy, minimum_charge_kobo, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [p.universityId, p.shopId, v.rows[0]!.n, p.draft.oddPageDuplexPolicy, p.draft.minimumChargeKobo, p.draft.effectiveFrom, p.draft.effectiveTo ?? null, p.createdBy],
  );
  const id = rows[0]!.id;
  for (const s of p.draft.sheetPrices) {
    await db.query(`INSERT INTO rate_card_sheet_prices (rate_card_id, paper_size, colour_mode, sides, price_per_sheet_kobo) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      s.paperSize,
      s.colourMode,
      s.sides,
      s.pricePerSheetKobo,
    ]);
  }
  for (const f of p.draft.finishing) {
    await db.query(`INSERT INTO rate_card_finishing (rate_card_id, code, name, unit, price_kobo, paper_sizes) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id,
      f.code,
      f.name,
      f.unit,
      f.priceKobo,
      f.paperSizes ?? null,
    ]);
  }
  return id;
}
