import { describe, expect, it } from "vitest";
import {
  calculateQuote,
  printSpecHash,
  QuoteError,
  RateCardError,
  resolvePricing,
  type PrintSpec,
  type ShopPriceOverride,
} from "../src/index.js";
import { BOUNDS, campusCard, NO_FEE, SHOP_A, SHOP_B } from "./fixtures.js";

const base: PrintSpec = {
  documentPageCount: 10,
  copies: 1,
  paperSize: "A4",
  colourMode: "BW",
  sides: "SINGLE",
  finishingCodes: [],
};

const pricing = { card: campusCard(), overrides: [] };

describe("calculateQuote", () => {
  it("prices single-sided B&W per sheet", () => {
    const q = calculateQuote(base, pricing, NO_FEE);
    expect(q.totalSheets).toBe(10);
    expect(q.subtotal).toBe(20_000);
    expect(q.total).toBe(20_000);
    expect(q.rateCardId).toBe("rc-campus-v1");
    expect(q.rateCardVersion).toBe(1);
  });

  it("multiplies by copies", () => {
    const q = calculateQuote({ ...base, copies: 3 }, pricing, NO_FEE);
    expect(q.totalSheets).toBe(30);
    expect(q.total).toBe(60_000);
  });

  it("respects page ranges", () => {
    const q = calculateQuote({ ...base, pageRanges: "1-3,7" }, pricing, NO_FEE);
    expect(q.selectedPages).toEqual([1, 2, 3, 7]);
    expect(q.total).toBe(8_000);
  });

  it("prices double-sided even page counts per duplex sheet", () => {
    const q = calculateQuote({ ...base, sides: "DOUBLE" }, pricing, NO_FEE);
    expect(q.sheetsPerCopy).toBe(5);
    expect(q.total).toBe(17_500);
  });

  it("odd duplex pages: CHARGE_FULL_SHEET", () => {
    const q = calculateQuote({ ...base, documentPageCount: 7, sides: "DOUBLE", copies: 2 }, pricing, NO_FEE);
    expect(q.sheetsPerCopy).toBe(4);
    expect(q.totalSheets).toBe(8);
    expect(q.total).toBe(8 * 3_500);
  });

  it("odd duplex pages: CHARGE_AS_SINGLE_SIDED", () => {
    const card = campusCard({ oddPageDuplexPolicy: "CHARGE_AS_SINGLE_SIDED" });
    const q = calculateQuote({ ...base, documentPageCount: 7, sides: "DOUBLE", copies: 2 }, { card, overrides: [] }, NO_FEE);
    expect(q.totalSheets).toBe(8);
    expect(q.total).toBe(3 * 2 * 3_500 + 2 * 2_000);
    expect(q.lines).toHaveLength(2);
  });

  it("odd duplex single page with simplex policy has no zero-quantity duplex line", () => {
    const card = campusCard({ oddPageDuplexPolicy: "CHARGE_AS_SINGLE_SIDED" });
    const q = calculateQuote({ ...base, documentPageCount: 1, sides: "DOUBLE" }, { card, overrides: [] }, NO_FEE);
    expect(q.lines).toHaveLength(1);
    expect(q.total).toBe(2_000);
  });

  it("prices colour and A3 from their own lines", () => {
    expect(calculateQuote({ ...base, colourMode: "COLOUR" }, pricing, NO_FEE).total).toBe(100_000);
    expect(calculateQuote({ ...base, paperSize: "A3" }, pricing, NO_FEE).total).toBe(50_000);
  });

  it("refuses configurations the card does not offer", () => {
    expect(() => calculateQuote({ ...base, paperSize: "A3", colourMode: "COLOUR" }, pricing, NO_FEE)).toThrow(QuoteError);
  });

  it("charges finishing by unit", () => {
    const q = calculateQuote({ ...base, copies: 2, finishingCodes: ["SPIRAL_BIND", "LAMINATE", "EXPRESS"] }, pricing, NO_FEE);
    const byCode = Object.fromEntries(q.lines.map((l) => [l.code, l]));
    expect(byCode.FINISH_SPIRAL_BIND?.quantity).toBe(2);
    expect(byCode.FINISH_LAMINATE?.quantity).toBe(20);
    expect(byCode.FINISH_EXPRESS?.quantity).toBe(1);
    expect(q.subtotal).toBe(40_000 + 2 * 50_000 + 20 * 15_000 + 20_000);
  });

  it("rejects unknown, duplicate or size-incompatible finishing", () => {
    expect(() => calculateQuote({ ...base, finishingCodes: ["GOLD_FOIL"] }, pricing, NO_FEE)).toThrow("not offered");
    expect(() => calculateQuote({ ...base, finishingCodes: ["STAPLE", "STAPLE"] }, pricing, NO_FEE)).toThrow("more than once");
    expect(() => calculateQuote({ ...base, paperSize: "A3", finishingCodes: ["SPIRAL_BIND"] }, pricing, NO_FEE)).toThrow("not available for A3");
  });

  it("applies a minimum charge as an explicit line", () => {
    const card = campusCard({ minimumCharge: 10_000 });
    const q = calculateQuote({ ...base, documentPageCount: 1 }, { card, overrides: [] }, NO_FEE);
    expect(q.subtotal).toBe(10_000);
    expect(q.lines.at(-1)?.code).toBe("MINIMUM_CHARGE");
    expect(q.lines.at(-1)?.amount).toBe(8_000);
  });

  it("adds fixed + percentage service fee on the subtotal", () => {
    const q = calculateQuote(base, pricing, { fixed: 5_000, bps: 150 });
    expect(q.subtotal).toBe(20_000);
    expect(q.serviceFee).toBe(5_000 + 300);
    expect(q.total).toBe(25_300);
  });

  it("line amounts always sum to the subtotal", () => {
    for (let pages = 1; pages <= 25; pages++) {
      for (const sides of ["SINGLE", "DOUBLE"] as const) {
        const q = calculateQuote(
          { ...base, documentPageCount: pages, sides, copies: 3, finishingCodes: ["STAPLE", "LAMINATE"] },
          { card: campusCard({ minimumCharge: 15_000, oddPageDuplexPolicy: "CHARGE_AS_SINGLE_SIDED" }), overrides: [] },
          { fixed: 1_000, bps: 75 },
        );
        expect(q.lines.reduce((s, l) => s + l.amount, 0)).toBe(q.subtotal);
        expect(q.subtotal + q.serviceFee).toBe(q.total);
        for (const l of q.lines) expect(l.amount).toBe(l.unitPrice * l.quantity);
      }
    }
  });

  it("enforces copy and size limits", () => {
    expect(() => calculateQuote({ ...base, copies: 0 }, pricing, NO_FEE)).toThrow(QuoteError);
    expect(() => calculateQuote({ ...base, copies: 501 }, pricing, NO_FEE)).toThrow(QuoteError);
    expect(() => calculateQuote({ ...base, copies: 1.5 }, pricing, NO_FEE)).toThrow(QuoteError);
    expect(() => calculateQuote({ ...base, documentPageCount: 2_001 }, pricing, NO_FEE)).toThrow(QuoteError);
    expect(() => calculateQuote({ ...base, documentPageCount: 2_000, copies: 500 }, pricing, NO_FEE)).toThrow("sheets");
  });

  it("applies university-approved shop overrides and records them", () => {
    const overrides: ShopPriceOverride[] = [
      { shopId: SHOP_A, rateCardId: "rc-campus-v1", kind: "SHEET", paperSize: "A4", colourMode: "BW", sides: "SINGLE", price: 1_500, approvedBy: "admin-1" },
      { shopId: SHOP_A, rateCardId: "rc-campus-v1", kind: "FINISHING", finishingCode: "STAPLE", price: 500, approvedBy: "admin-1" },
    ];
    const q = calculateQuote({ ...base, finishingCodes: ["STAPLE"] }, { card: campusCard(), overrides }, NO_FEE);
    expect(q.total).toBe(10 * 1_500 + 500);
    expect(q.appliedOverrides).toHaveLength(2);
  });
});

describe("resolvePricing", () => {
  const at = new Date("2026-06-01T00:00:00Z");

  it("university mode uses the latest effective campus card", () => {
    const v1 = campusCard();
    const v2 = campusCard({ id: "rc-campus-v2", version: 2, effectiveFrom: new Date("2026-05-01T00:00:00Z") });
    const future = campusCard({ id: "rc-campus-v3", version: 3, effectiveFrom: new Date("2027-01-01T00:00:00Z") });
    const r = resolvePricing({ mode: "UNIVERSITY_CONTROLLED", shopId: SHOP_A, at, universityCards: [v1, v2, future], shopCards: [], overrides: [], bounds: null });
    expect(r.card.id).toBe("rc-campus-v2");
  });

  it("university mode only applies overrides for this shop and card", () => {
    const ov: ShopPriceOverride = { shopId: SHOP_B, rateCardId: "rc-campus-v1", kind: "FINISHING", finishingCode: "STAPLE", price: 1, approvedBy: "x" };
    const r = resolvePricing({ mode: "UNIVERSITY_CONTROLLED", shopId: SHOP_A, at, universityCards: [campusCard()], shopCards: [], overrides: [ov], bounds: null });
    expect(r.overrides).toEqual([]);
  });

  it("ignores expired cards and fails closed when nothing is effective", () => {
    const expired = campusCard({ effectiveTo: new Date("2026-03-01T00:00:00Z") });
    expect(() =>
      resolvePricing({ mode: "UNIVERSITY_CONTROLLED", shopId: SHOP_A, at, universityCards: [expired], shopCards: [], overrides: [], bounds: null }),
    ).toThrow(RateCardError);
  });

  it("merchant mode uses the shop's own card within bounds", () => {
    const shopCard = campusCard({ id: "rc-shop-a", shopId: SHOP_A });
    const r = resolvePricing({ mode: "MERCHANT_CONTROLLED", shopId: SHOP_A, at, universityCards: [campusCard()], shopCards: [shopCard], overrides: [], bounds: BOUNDS });
    expect(r.card.id).toBe("rc-shop-a");
  });

  it("merchant mode never uses another shop's card", () => {
    const shopCard = campusCard({ id: "rc-shop-b", shopId: SHOP_B });
    expect(() =>
      resolvePricing({ mode: "MERCHANT_CONTROLLED", shopId: SHOP_A, at, universityCards: [], shopCards: [shopCard], overrides: [], bounds: BOUNDS }),
    ).toThrow("shop has no effective rate card");
  });

  it("merchant mode rejects prices outside the agreement", () => {
    const greedy = campusCard({ id: "rc-shop-a", shopId: SHOP_A, sheetPrices: [{ paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheet: 9_999 }] });
    expect(() =>
      resolvePricing({ mode: "MERCHANT_CONTROLLED", shopId: SHOP_A, at, universityCards: [], shopCards: [greedy], overrides: [], bounds: BOUNDS }),
    ).toThrow("outside the agreed range");
  });

  it("merchant mode requires bounds", () => {
    const shopCard = campusCard({ id: "rc-shop-a", shopId: SHOP_A });
    expect(() =>
      resolvePricing({ mode: "MERCHANT_CONTROLLED", shopId: SHOP_A, at, universityCards: [], shopCards: [shopCard], overrides: [], bounds: null }),
    ).toThrow("bounds");
  });

  it("validates card structure", () => {
    expect(() => calculateQuote(base, { card: campusCard({ sheetPrices: [] }), overrides: [] }, NO_FEE)).toThrow(RateCardError);
    const dup = campusCard();
    expect(() =>
      calculateQuote(base, { card: { ...dup, sheetPrices: [...dup.sheetPrices, dup.sheetPrices[0]!] }, overrides: [] }, NO_FEE),
    ).toThrow("duplicate");
  });
});

describe("printSpecHash", () => {
  const sha = "a".repeat(64);
  it("is stable under finishing order and whitespace", () => {
    const a = printSpecHash({ ...base, pageRanges: "1-3, 5", finishingCodes: ["STAPLE", "EXPRESS"] }, sha);
    const b = printSpecHash({ ...base, pageRanges: "1-3,5", finishingCodes: ["EXPRESS", "STAPLE"] }, sha);
    expect(a).toBe(b);
  });
  it("changes when the document version or spec changes", () => {
    const a = printSpecHash(base, sha);
    expect(printSpecHash(base, "b".repeat(64))).not.toBe(a);
    expect(printSpecHash({ ...base, copies: 2 }, sha)).not.toBe(a);
  });
  it("rejects malformed digests", () => {
    expect(() => printSpecHash(base, "xyz")).toThrow();
  });
});
