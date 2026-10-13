import { addKobo, applyBasisPoints, assertNonNegativeKobo, multiplyKobo, type Kobo } from "./money.js";
import { parsePageRanges } from "./page-ranges.js";
import { RateCardError, sheetKey, validateRateCard, type ResolvedPricing } from "./rate-card.js";
import type { PrintSpec, Quote, QuoteLine, ServiceFeePolicy, ShopPriceOverride } from "./types.js";

export class QuoteError extends Error {
  override readonly name = "QuoteError";
}

export const LIMITS = {
  maxCopies: 500,
  maxDocumentPages: 2_000,
  maxTotalSheets: 50_000,
  maxFinishingServices: 10,
} as const;

/**
 * Calculates an exact quote. This is the only place a price is computed; clients
 * display what it returns and never send totals back.
 */
export function calculateQuote(spec: PrintSpec, pricing: ResolvedPricing, fee: ServiceFeePolicy): Quote {
  const { card, overrides } = pricing;
  validateRateCard(card);
  assertNonNegativeKobo(fee.fixed, "service fee");

  if (!Number.isSafeInteger(spec.copies) || spec.copies < 1 || spec.copies > LIMITS.maxCopies) {
    throw new QuoteError(`copies must be between 1 and ${LIMITS.maxCopies}`);
  }
  if (spec.documentPageCount > LIMITS.maxDocumentPages) {
    throw new QuoteError(`documents are limited to ${LIMITS.maxDocumentPages} pages`);
  }
  if (spec.finishingCodes.length > LIMITS.maxFinishingServices) {
    throw new QuoteError("too many finishing services selected");
  }
  if (new Set(spec.finishingCodes).size !== spec.finishingCodes.length) {
    throw new QuoteError("a finishing service was selected more than once");
  }

  const selectedPages = parsePageRanges(spec.pageRanges, spec.documentPageCount);
  const pagesPerCopy = selectedPages.length;

  const sheetLine = card.sheetPrices.find(
    (s) => s.paperSize === spec.paperSize && s.colourMode === spec.colourMode && s.sides === spec.sides,
  );
  if (!sheetLine) {
    throw new QuoteError(`this shop does not offer ${sheetKey(spec)} printing`);
  }

  const appliedOverrides: string[] = [];
  const sheetOverride = overrides.find(
    (o) =>
      o.kind === "SHEET" &&
      o.paperSize === spec.paperSize &&
      o.colourMode === spec.colourMode &&
      o.sides === spec.sides,
  );
  const sheetPrice: Kobo = sheetOverride ? assertNonNegativeKobo(sheetOverride.price) : sheetLine.pricePerSheet;
  if (sheetOverride) appliedOverrides.push(overrideId(sheetOverride));

  const lines: QuoteLine[] = [];
  let sheetsPerCopy: number;

  if (spec.sides === "SINGLE") {
    sheetsPerCopy = pagesPerCopy;
    lines.push(printLine(spec, sheetsPerCopy * spec.copies, sheetPrice));
  } else {
    const fullDuplexSheets = Math.floor(pagesPerCopy / 2);
    const hasOddPage = pagesPerCopy % 2 === 1;
    sheetsPerCopy = fullDuplexSheets + (hasOddPage ? 1 : 0);

    if (!hasOddPage || card.oddPageDuplexPolicy === "CHARGE_FULL_SHEET") {
      lines.push(printLine(spec, sheetsPerCopy * spec.copies, sheetPrice));
    } else {
      if (fullDuplexSheets > 0) lines.push(printLine(spec, fullDuplexSheets * spec.copies, sheetPrice));
      const simplex = card.sheetPrices.find(
        (s) => s.paperSize === spec.paperSize && s.colourMode === spec.colourMode && s.sides === "SINGLE",
      );
      if (!simplex) {
        throw new RateCardError(
          `odd-page policy charges the last page as single-sided but ${spec.paperSize}/${spec.colourMode}/SINGLE has no price`,
        );
      }
      lines.push({
        code: `PRINT_${spec.paperSize}_${spec.colourMode}_SINGLE_LAST_PAGE`,
        description: `Final odd page, ${spec.paperSize} ${label(spec.colourMode)}, single-sided`,
        quantity: spec.copies,
        unitPrice: simplex.pricePerSheet,
        amount: multiplyKobo(simplex.pricePerSheet, spec.copies),
      });
    }
  }

  const totalSheets = sheetsPerCopy * spec.copies;
  if (totalSheets > LIMITS.maxTotalSheets) {
    throw new QuoteError(`orders are limited to ${LIMITS.maxTotalSheets} sheets`);
  }

  for (const code of spec.finishingCodes) {
    const service = card.finishing.find((f) => f.code === code);
    if (!service) throw new QuoteError(`finishing service ${code} is not offered`);
    if (service.paperSizes && !service.paperSizes.includes(spec.paperSize)) {
      throw new QuoteError(`${service.name} is not available for ${spec.paperSize}`);
    }
    const ov = overrides.find((o) => o.kind === "FINISHING" && o.finishingCode === code);
    const unitPrice = ov ? assertNonNegativeKobo(ov.price) : service.price;
    if (ov) appliedOverrides.push(overrideId(ov));
    const quantity =
      service.unit === "PER_ORDER" ? 1 : service.unit === "PER_COPY" ? spec.copies : totalSheets;
    lines.push({
      code: `FINISH_${code}`,
      description: service.name,
      quantity,
      unitPrice,
      amount: multiplyKobo(unitPrice, quantity),
    });
  }

  let subtotal = addKobo(...lines.map((l) => l.amount));
  if (card.minimumCharge > 0 && subtotal < card.minimumCharge) {
    const topUp = card.minimumCharge - subtotal;
    lines.push({
      code: "MINIMUM_CHARGE",
      description: "Minimum order charge adjustment",
      quantity: 1,
      unitPrice: topUp,
      amount: topUp,
    });
    subtotal = card.minimumCharge;
  }

  const serviceFee = addKobo(fee.fixed, applyBasisPoints(subtotal, fee.bps));
  const total = addKobo(subtotal, serviceFee);

  return {
    rateCardId: card.id,
    rateCardVersion: card.version,
    currency: "NGN",
    selectedPages,
    pagesPerCopy,
    sheetsPerCopy,
    totalSheets,
    lines,
    subtotal,
    serviceFee,
    total,
    appliedOverrides,
  };
}

function printLine(spec: PrintSpec, sheets: number, unitPrice: Kobo): QuoteLine {
  return {
    code: `PRINT_${spec.paperSize}_${spec.colourMode}_${spec.sides}`,
    description: `${spec.paperSize} ${label(spec.colourMode)}, ${spec.sides === "SINGLE" ? "single" : "double"}-sided sheets`,
    quantity: sheets,
    unitPrice,
    amount: multiplyKobo(unitPrice, sheets),
  };
}

function label(mode: PrintSpec["colourMode"]): string {
  return mode === "BW" ? "black & white" : "colour";
}

function overrideId(o: ShopPriceOverride): string {
  return o.kind === "SHEET"
    ? `${o.rateCardId}:${o.shopId}:SHEET:${o.paperSize}/${o.colourMode}/${o.sides}`
    : `${o.rateCardId}:${o.shopId}:FINISHING:${o.finishingCode}`;
}
