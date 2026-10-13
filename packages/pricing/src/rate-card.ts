import { assertNonNegativeKobo, MoneyError } from "./money.js";
import {
  COLOUR_MODES,
  PAPER_SIZES,
  SIDES,
  type PriceBounds,
  type PricingMode,
  type RateCard,
  type ShopPriceOverride,
  type SheetPrice,
} from "./types.js";

export class RateCardError extends Error {
  override readonly name = "RateCardError";
}

const FINISHING_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** Structural validation that applies to every rate card regardless of mode. */
export function validateRateCard(card: RateCard): void {
  if (!Number.isSafeInteger(card.version) || card.version < 1) {
    throw new RateCardError("rate card version must be a positive integer");
  }
  if (card.currency !== "NGN") throw new RateCardError("only NGN rate cards are supported");
  if (card.effectiveTo && card.effectiveTo <= card.effectiveFrom) {
    throw new RateCardError("effectiveTo must be after effectiveFrom");
  }
  try {
    assertNonNegativeKobo(card.minimumCharge, "minimumCharge");
  } catch (e) {
    throw new RateCardError((e as MoneyError).message);
  }
  if (card.sheetPrices.length === 0) throw new RateCardError("rate card has no sheet prices");

  const keys = new Set<string>();
  for (const sp of card.sheetPrices) {
    if (!PAPER_SIZES.includes(sp.paperSize)) throw new RateCardError(`unknown paper size ${sp.paperSize}`);
    if (!COLOUR_MODES.includes(sp.colourMode)) throw new RateCardError(`unknown colour mode ${sp.colourMode}`);
    if (!SIDES.includes(sp.sides)) throw new RateCardError(`unknown sides ${sp.sides}`);
    try {
      assertNonNegativeKobo(sp.pricePerSheet, "pricePerSheet");
    } catch (e) {
      throw new RateCardError((e as MoneyError).message);
    }
    if (sp.pricePerSheet === 0) {
      throw new RateCardError(`sheet price for ${sheetKey(sp)} is zero; remove the line to disable it`);
    }
    const key = sheetKey(sp);
    if (keys.has(key)) throw new RateCardError(`duplicate sheet price for ${key}`);
    keys.add(key);
  }

  const codes = new Set<string>();
  for (const f of card.finishing) {
    if (!FINISHING_CODE.test(f.code)) throw new RateCardError(`invalid finishing code "${f.code}"`);
    if (codes.has(f.code)) throw new RateCardError(`duplicate finishing code ${f.code}`);
    codes.add(f.code);
    try {
      assertNonNegativeKobo(f.price, `finishing ${f.code} price`);
    } catch (e) {
      throw new RateCardError((e as MoneyError).message);
    }
  }
}

/** Merchant-controlled cards must stay inside platform/university bounds. */
export function validateAgainstBounds(card: RateCard, bounds: PriceBounds): void {
  for (const sp of card.sheetPrices) {
    const bound = bounds.sheet.find(
      (b) => b.paperSize === sp.paperSize && b.colourMode === sp.colourMode && b.sides === sp.sides,
    );
    if (!bound) {
      throw new RateCardError(`no price agreement covers ${sheetKey(sp)}; it cannot be offered`);
    }
    if (sp.pricePerSheet < bound.min || sp.pricePerSheet > bound.max) {
      throw new RateCardError(
        `${sheetKey(sp)} price ${sp.pricePerSheet} is outside the agreed range ${bound.min}-${bound.max} kobo`,
      );
    }
  }
  for (const f of card.finishing) {
    if (f.price > bounds.finishingMax) {
      throw new RateCardError(`finishing ${f.code} exceeds the maximum of ${bounds.finishingMax} kobo`);
    }
  }
}

export function sheetKey(sp: Pick<SheetPrice, "paperSize" | "colourMode" | "sides">): string {
  return `${sp.paperSize}/${sp.colourMode}/${sp.sides}`;
}

export function isEffective(card: RateCard, at: Date): boolean {
  return card.effectiveFrom <= at && (card.effectiveTo === null || at < card.effectiveTo);
}

export interface ResolvedPricing {
  card: RateCard;
  overrides: readonly ShopPriceOverride[];
}

/**
 * Picks the rate card that governs a shop's quote according to the university's
 * explicitly configured pricing mode. Never falls back silently between modes.
 */
export function resolvePricing(params: {
  mode: PricingMode;
  shopId: string;
  at: Date;
  universityCards: readonly RateCard[];
  shopCards: readonly RateCard[];
  overrides: readonly ShopPriceOverride[];
  bounds: PriceBounds | null;
}): ResolvedPricing {
  const { mode, shopId, at } = params;

  if (mode === "UNIVERSITY_CONTROLLED") {
    const card = latestEffective(params.universityCards.filter((c) => c.shopId === null), at);
    if (!card) throw new RateCardError("no effective university rate card; pricing is not configured");
    const overrides = params.overrides.filter((o) => o.shopId === shopId && o.rateCardId === card.id);
    return { card, overrides };
  }

  const card = latestEffective(params.shopCards.filter((c) => c.shopId === shopId), at);
  if (!card) throw new RateCardError("shop has no effective rate card; pricing is not configured");
  if (!params.bounds) throw new RateCardError("merchant pricing requires agreed price bounds");
  validateAgainstBounds(card, params.bounds);
  return { card, overrides: [] };
}

function latestEffective(cards: readonly RateCard[], at: Date): RateCard | undefined {
  return cards
    .filter((c) => isEffective(c, at))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.version - a.version)[0];
}
