import type { Kobo } from "./money.js";

export const PAPER_SIZES = ["A4", "A3", "A5", "LETTER", "LEGAL"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const COLOUR_MODES = ["BW", "COLOUR"] as const;
export type ColourMode = (typeof COLOUR_MODES)[number];

export const SIDES = ["SINGLE", "DOUBLE"] as const;
export type Sides = (typeof SIDES)[number];

export const PRICING_MODES = ["UNIVERSITY_CONTROLLED", "MERCHANT_CONTROLLED"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/** How finishing services are charged. */
export type FinishingUnit = "PER_ORDER" | "PER_COPY" | "PER_SHEET";

/**
 * On double-sided jobs with an odd page count the last sheet has one blank side.
 * The policy must be explicit so students see why they pay what they pay.
 */
export type OddPageDuplexPolicy = "CHARGE_FULL_SHEET" | "CHARGE_AS_SINGLE_SIDED";

export interface SheetPrice {
  paperSize: PaperSize;
  colourMode: ColourMode;
  sides: Sides;
  /** Price for one physical sheet printed in this configuration. */
  pricePerSheet: Kobo;
}

export interface FinishingService {
  code: string;
  name: string;
  unit: FinishingUnit;
  price: Kobo;
  /** If set, the service is only offered for these paper sizes. */
  paperSizes?: readonly PaperSize[];
}

export interface ServiceFeePolicy {
  /** Fixed platform fee per order. */
  fixed: Kobo;
  /** Percentage fee on the print + finishing subtotal, in basis points. */
  bps: number;
}

export interface RateCard {
  id: string;
  universityId: string;
  /** null for a campus-wide (university) card, set for a shop's own card. */
  shopId: string | null;
  version: number;
  currency: "NGN";
  sheetPrices: readonly SheetPrice[];
  finishing: readonly FinishingService[];
  oddPageDuplexPolicy: OddPageDuplexPolicy;
  /** Orders below this subtotal are raised to it. 0 disables. */
  minimumCharge: Kobo;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** University-approved override of a single line on the campus card for one shop. */
export interface ShopPriceOverride {
  shopId: string;
  rateCardId: string;
  kind: "SHEET" | "FINISHING";
  paperSize?: PaperSize;
  colourMode?: ColourMode;
  sides?: Sides;
  finishingCode?: string;
  price: Kobo;
  approvedBy: string;
}

/** Platform rules that bound merchant-set prices. */
export interface PriceBounds {
  sheet: ReadonlyArray<{
    paperSize: PaperSize;
    colourMode: ColourMode;
    sides: Sides;
    min: Kobo;
    max: Kobo;
  }>;
  finishingMax: Kobo;
}

export interface PrintSpec {
  /** Pages in the immutable document version, as counted by the server. */
  documentPageCount: number;
  /** e.g. "1-3,5,9-12". Empty or undefined means all pages. */
  pageRanges?: string;
  copies: number;
  paperSize: PaperSize;
  colourMode: ColourMode;
  sides: Sides;
  finishingCodes: readonly string[];
}

export interface QuoteLine {
  code: string;
  description: string;
  quantity: number;
  unitPrice: Kobo;
  amount: Kobo;
}

export interface Quote {
  rateCardId: string;
  rateCardVersion: number;
  currency: "NGN";
  selectedPages: number[];
  pagesPerCopy: number;
  sheetsPerCopy: number;
  totalSheets: number;
  lines: QuoteLine[];
  /** Print + finishing, after minimum charge adjustment. */
  subtotal: Kobo;
  serviceFee: Kobo;
  total: Kobo;
  /** Override ids applied, for audit. */
  appliedOverrides: string[];
}
