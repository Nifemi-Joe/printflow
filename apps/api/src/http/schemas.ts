import { z } from "zod";
import { COLOUR_MODES, PAPER_SIZES, PRICING_MODES, SIDES } from "../../../../packages/pricing/src/index.js";
import { normalizePhone, ORDER_STATUSES, SHOP_PERMISSIONS } from "../../../../packages/domain/src/index.js";

const id = z.string().uuid();
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "enter a valid email address");
const kobo = z.number().int().min(0).max(100_000_000_00);
const name = z.string().trim().min(2).max(200);

const COMMON_PASSWORDS = new Set(["password123", "1234567890", "qwertyuiop", "printflow123", "password1234", "iloveyou123", "abcdefghij"]);
export const Password = z
  .string()
  .min(10, "use at least 10 characters")
  .max(200)
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), "this password is too common");

const PrintSpec = z.object({
    pageRanges: z.string().max(500).optional(),
    copies: z.number().int().min(1).max(500),
    paperSize: z.enum(PAPER_SIZES),
    colourMode: z.enum(COLOUR_MODES),
    sides: z.enum(SIDES),
    finishingCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).max(10).default([]),
  });
const OpeningHours = z.partialRecord(
    z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
    z.array(z.tuple([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)])).max(4),
  );

/** Accepts local Nigerian formats (0801…, 801…, 234…) and E.164; yields E.164. */
const phoneInput = z
  .string()
  .max(32)
  .transform((v, ctx) => {
    try {
      return normalizePhone(v);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  });
const otpCode = z.string().regex(/^\d{6}$/, "enter the 6-digit code");

export const Schemas = {
  RegisterStudent: z.object({
    email,
    password: Password,
    fullName: name,
    universityId: id,
    campusId: id,
    departmentId: id.optional(),
    matricNumber: z.string().trim().min(3).max(40).optional(),
    phone: phoneInput.optional(),
    client: z.enum(["web", "mobile"]).default("web"),
  }),
  Login: z
    .object({
      email: email.optional(),
      phone: phoneInput.optional(),
      password: z.string().min(1).max(200),
      mfaCode: z.string().regex(/^\d{6}$/).optional(),
      client: z.enum(["web", "mobile"]).default("web"),
    })
    .refine((v) => Boolean(v.email) !== Boolean(v.phone), { message: "sign in with your email or your phone number", path: ["email"] }),
  PhoneOnly: z.object({ phone: phoneInput }),
  PhoneCode: z.object({ code: otpCode }),
  OtpSignIn: z.object({
    phone: phoneInput,
    code: otpCode,
    mfaCode: z.string().regex(/^\d{6}$/).optional(),
    client: z.enum(["web", "mobile"]).default("web"),
  }),
  ResetRequest: z
    .object({ email: email.optional(), phone: phoneInput.optional() })
    .refine((v) => Boolean(v.email) !== Boolean(v.phone), { message: "enter your email or your phone number", path: ["email"] }),
  Token: z.object({ token: z.string().min(20).max(200) }),
  EmailOnly: z.object({ email }),
  ResetConfirm: z.union([
    z.object({ token: z.string().min(20).max(200), newPassword: Password }),
    z.object({ phone: phoneInput, code: otpCode, newPassword: Password }),
  ]),
  ChangePassword: z.object({ currentPassword: z.string().min(1).max(200), newPassword: Password }),
  MfaCode: z.object({ code: z.string().regex(/^\d{6}$/, "enter the 6-digit code") }),
  UpdateProfile: z.object({
    fullName: name.optional(),
    campusId: id.optional(),
    departmentId: id.nullable().optional(),
    matricNumber: z.string().trim().min(3).max(40).nullable().optional(),
  }),

  PrintSpec,
  CreateQuote: z.object({
    documentVersionId: id,
    shopId: id,
    spec: PrintSpec,
  }),
  CreateOrder: z.object({ quoteId: id, pickupLocationId: id, reprintOfOrderId: id.optional() }),
  CancelOrder: z.object({ reason: z.string().trim().min(3).max(500).default("Cancelled by student") }),
  OpenDispute: z.object({
    category: z.enum(["QUALITY", "NOT_RECEIVED", "WRONG_SPEC", "OVERCHARGED", "OTHER"]),
    description: z.string().trim().min(10).max(4000),
  }),
  CompleteTestPayment: z.object({ outcome: z.enum(["success", "failed"]), method: z.enum(["CARD", "BANK_TRANSFER", "USSD"]).optional() }),
  StartPayment: z.object({ method: z.enum(["CARD", "BANK_TRANSFER", "USSD"]).optional() }).default({}),
  PrivacyRequest: z.object({ kind: z.enum(["EXPORT", "ERASURE"]) }),

  ApplyShop: z.object({ universityId: id, campusId: id, name: z.string().trim().min(2).max(120), locationNote: z.string().trim().max(500).optional() }),
  OpeningHours,
  UpdateShop: z.object({
    acceptingOrders: z.boolean().optional(),
    openingHours: OpeningHours.optional(),
    locationNote: z.string().trim().max(500).nullable().optional(),
  }),
  ShopPower: z
    .object({
      status: z.enum(["GRID", "GENERATOR", "OUTAGE"]),
      backAt: z.string().datetime({ offset: true }).nullable().optional(),
      note: z.string().trim().max(140).nullable().optional(),
    })
    .refine((v) => !v.backAt || v.status === "OUTAGE", { message: "an expected return time only applies when the light is out", path: ["backAt"] }),
  PickupLocation: z.object({ name: z.string().trim().min(2).max(200) }),
  UpdatePickupLocation: z.object({ name: z.string().trim().min(2).max(200).optional(), isActive: z.boolean().optional() }),
  Transition: z.object({
    to: z.enum(ORDER_STATUSES),
    reason: z.string().trim().max(1000).optional(),
    expectedVersion: z.number().int().min(1).optional(),
    deviceId: id.optional(),
  }),
  QualityCheck: z.object({
    result: z.enum(["PASS", "FAIL"]),
    issues: z
      .array(z.enum(["PAGE_COUNT_MISMATCH", "WRONG_PAPER_SIZE", "WRONG_COLOUR_MODE", "WRONG_SIDES", "MISSING_PAGES", "PRINT_DEFECT", "FINISHING_DEFECT", "OTHER"]))
      .max(8)
      .default([]),
    sheetsCounted: z.number().int().min(0).max(100_000).optional(),
    notes: z.string().trim().max(1000).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  }),
  Collect: z.object({ code: z.string().regex(/^\d{6}$/, "pickup codes are 6 digits") }),
  Device: z.object({ label: z.string().trim().min(1).max(80), capabilities: z.record(z.string(), z.union([z.boolean(), z.string().max(80)])).default({}) }),
  UpdateDevice: z.object({
    label: z.string().trim().min(1).max(80).optional(),
    reportedStatus: z.enum(["UNKNOWN", "AVAILABLE", "BUSY", "OUT_OF_PAPER", "OUT_OF_TONER", "FAULT", "OFFLINE"]).optional(),
  }),
  AddStaff: z.object({ email, role: z.enum(["MANAGER", "OPERATOR"]), permissions: z.array(z.enum(SHOP_PERMISSIONS)).max(20).optional() }),
  UpdateStaff: z.object({ role: z.enum(["MANAGER", "OPERATOR"]).optional(), permissions: z.array(z.enum(SHOP_PERMISSIONS)).max(20).optional() }),
  SyncActions: z.object({
    actions: z
      .array(
        z.object({
          clientActionId: z.string().regex(/^[\w-]{16,64}$/),
          orderId: id,
          to: z.enum(ORDER_STATUSES),
          expectedVersion: z.number().int().min(1),
          reason: z.string().trim().max(1000).optional(),
          deviceId: id.optional(),
          draftedAt: z.string().datetime(),
        }),
      )
      .min(1)
      .max(50),
  }),

  RateCardDraft: z.object({
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().nullable().optional(),
    oddPageDuplexPolicy: z.enum(["CHARGE_FULL_SHEET", "CHARGE_AS_SINGLE_SIDED"]).default("CHARGE_FULL_SHEET"),
    minimumChargeKobo: kobo.default(0),
    sheetPrices: z
      .array(z.object({ paperSize: z.enum(PAPER_SIZES), colourMode: z.enum(COLOUR_MODES), sides: z.enum(SIDES), pricePerSheetKobo: kobo.min(1) }))
      .min(1)
      .max(40),
    finishing: z
      .array(
        z.object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
          name: z.string().trim().min(2).max(80),
          unit: z.enum(["PER_ORDER", "PER_COPY", "PER_SHEET"]),
          priceKobo: kobo,
          paperSizes: z.array(z.enum(PAPER_SIZES)).max(5).optional(),
        }),
      )
      .max(30)
      .default([]),
  }),
  Override: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("SHEET"), shopId: id, rateCardId: id, paperSize: z.enum(PAPER_SIZES), colourMode: z.enum(COLOUR_MODES), sides: z.enum(SIDES), priceKobo: kobo }),
    z.object({ kind: z.literal("FINISHING"), shopId: id, rateCardId: id, finishingCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/), priceKobo: kobo }),
  ]),
  PriceBounds: z.object({
    bounds: z
      .array(z.object({ paperSize: z.enum(PAPER_SIZES), colourMode: z.enum(COLOUR_MODES), sides: z.enum(SIDES), minKobo: kobo.min(1), maxKobo: kobo.min(1) }))
      .max(40)
      .refine((b) => b.every((x) => x.maxKobo >= x.minKobo), "max must be at least min"),
  }),
  UniversitySettings: z.object({
    pricingMode: z.enum(PRICING_MODES).optional(),
    quoteTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    documentRetentionDays: z.number().int().min(1).max(365).optional(),
  }),
  Campus: z.object({ name }),
  UpdateCampus: z.object({ name: name.optional(), isActive: z.boolean().optional() }),
  Department: z.object({ name }),
  ShopStatusAction: z.object({ action: z.enum(["approve", "suspend", "reinstate", "remove"]), reason: z.string().trim().min(3).max(500) }),
  AdminRefund: z.object({ reason: z.string().trim().min(3).max(1000) }),
  ResolveDispute: z.object({
    status: z.enum(["UNDER_REVIEW", "RESOLVED_REFUND", "RESOLVED_REPRINT", "RESOLVED_NO_ACTION"]),
    note: z.string().trim().min(3).max(4000),
    refundKobo: kobo.min(1).optional(),
  }),
  UniversityStaff: z.object({ email, role: z.enum(["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]) }),
  HandlePrivacy: z.object({ status: z.enum(["IN_PROGRESS", "COMPLETED", "REJECTED"]), note: z.string().trim().max(2000).optional() }),

  ResetMfa: z.object({ email, reason: z.string().trim().min(10).max(1000) }),
  CreateUniversity: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), name }),
  UpdateUniversity: z.object({
    status: z.enum(["ONBOARDING", "ACTIVE", "SUSPENDED"]).optional(),
    serviceFeeFixedKobo: kobo.optional(),
    serviceFeeBps: z.number().int().min(0).max(2_000).optional(),
  }),
  AssignAdmin: z.object({ email }),

  DateRange: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  OrderListQuery: z.object({
    status: z.enum(ORDER_STATUSES).optional(),
    shopId: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  }),
} as const;

export type PrintSpecInput = z.infer<typeof Schemas.PrintSpec>;
