import type { PriceBounds, RateCard, ServiceFeePolicy } from "../src/index.js";

export const UNI = "11111111-1111-4111-8111-111111111111";
export const SHOP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SHOP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Prices are illustrative test fixtures only, not real campus prices. */
export function campusCard(overrides: Partial<RateCard> = {}): RateCard {
  return {
    id: "rc-campus-v1",
    universityId: UNI,
    shopId: null,
    version: 1,
    currency: "NGN",
    sheetPrices: [
      { paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheet: 2_000 },
      { paperSize: "A4", colourMode: "BW", sides: "DOUBLE", pricePerSheet: 3_500 },
      { paperSize: "A4", colourMode: "COLOUR", sides: "SINGLE", pricePerSheet: 10_000 },
      { paperSize: "A4", colourMode: "COLOUR", sides: "DOUBLE", pricePerSheet: 18_000 },
      { paperSize: "A3", colourMode: "BW", sides: "SINGLE", pricePerSheet: 5_000 },
    ],
    finishing: [
      { code: "SPIRAL_BIND", name: "Spiral binding", unit: "PER_COPY", price: 50_000, paperSizes: ["A4"] },
      { code: "STAPLE", name: "Stapling", unit: "PER_COPY", price: 1_000 },
      { code: "LAMINATE", name: "Lamination", unit: "PER_SHEET", price: 15_000 },
      { code: "EXPRESS", name: "Express handling", unit: "PER_ORDER", price: 20_000 },
    ],
    oddPageDuplexPolicy: "CHARGE_FULL_SHEET",
    minimumCharge: 0,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    ...overrides,
  };
}

export const NO_FEE: ServiceFeePolicy = { fixed: 0, bps: 0 };

export const BOUNDS: PriceBounds = {
  sheet: [
    { paperSize: "A4", colourMode: "BW", sides: "SINGLE", min: 1_000, max: 5_000 },
    { paperSize: "A4", colourMode: "BW", sides: "DOUBLE", min: 2_000, max: 8_000 },
    { paperSize: "A4", colourMode: "COLOUR", sides: "SINGLE", min: 5_000, max: 20_000 },
    { paperSize: "A4", colourMode: "COLOUR", sides: "DOUBLE", min: 9_000, max: 36_000 },
    { paperSize: "A3", colourMode: "BW", sides: "SINGLE", min: 3_000, max: 10_000 },
  ],
  finishingMax: 100_000,
};
