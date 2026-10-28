import { z } from "zod";
import { COLOUR_MODES, PAPER_SIZES, PRICING_MODES, SIDES } from "../../../../packages/pricing/src/index.js";
import { ENQUIRY_KINDS, ENQUIRY_PRIORITIES, ENQUIRY_STATUSES, normalizePhone, ORDER_STATUSES, PRINTER_PAPER_SIZES, SHOP_PERMISSIONS } from "../../../../packages/domain/src/index.js";

const id = z.string().uuid();
const email = z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "enter a valid email address");
const kobo = z.number().int().min(0).max(100_000_000_00);
/** Where card/transfer/USSD money goes on a refund: the student's wallet (instant) or back through the provider. */
const refundTo = z.enum(["WALLET", "PROVIDER"]);

/**
 * What a provider can tell us about a printer. Every one of these is optional and
 * nullable, because none of them gate taking orders: `undefined` means "leave it
 * as it is", `null` means "I do not know", and only a real answer is stored.
 */
// `undefined` must survive the transform: it is how the client says "leave this
// alone", and collapsing it to null would silently erase a field every time
// someone renamed a printer.
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .nullish()
        .transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : v));
const printerDetailFields = {
  serialNumber: optionalText(60).optional(),
  make: optionalText(60).optional(),
  model: optionalText(60).optional(),
  colour: z.boolean().nullish().optional(),
  duplex: z.boolean().nullish().optional(),
  paperSizes: z.array(z.enum(PRINTER_PAPER_SIZES)).max(PRINTER_PAPER_SIZES.length).nullish().optional(),
  notes: optionalText(500).optional(),
};
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
  CreateOrder: z.object({
    quoteId: id,
    pickupLocationId: id,
    reprintOfOrderId: id.optional(),
    /** Required when the shop is a student-run provider whose identity is not fully proven. */
    acknowledgeUnverifiedProvider: z.boolean().default(false),
  }),
  CancelOrder: z.object({ reason: z.string().trim().min(3).max(500).default("Cancelled by student"), refundTo: refundTo.default("WALLET") }),
  OpenDispute: z.object({
    category: z.enum(["QUALITY", "NOT_RECEIVED", "WRONG_SPEC", "OVERCHARGED", "OTHER"]),
    description: z.string().trim().min(10).max(4000),
  }),
  CompleteTestPayment: z.object({ outcome: z.enum(["success", "failed"]), method: z.enum(["CARD", "BANK_TRANSFER", "USSD"]).optional() }),
  StartPayment: z.object({ method: z.enum(["CARD", "BANK_TRANSFER", "USSD"]).optional(), useWallet: z.boolean().default(false) }).default({ useWallet: false }),
  WalletTopup: z.object({ amountKobo: z.number().int().min(100).max(100_000_000), method: z.enum(["CARD", "BANK_TRANSFER", "USSD"]).optional() }),
  WalletStatementQuery: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.coerce.number().int().min(1).optional() }),
  PromoCredit: z
      .object({
        email: z.string().trim().toLowerCase().email().max(254).optional(),
        matricNumber: z.string().trim().min(3).max(40).optional(),
        amountKobo: z.number().int().min(100).max(10_000_000),
        note: z.string().trim().min(3).max(300),
      })
      .refine((v) => Boolean(v.email) !== Boolean(v.matricNumber), { message: "give the student's email or matric number (one of them)", path: ["email"] }),
  PrivacyRequest: z.object({ kind: z.enum(["EXPORT", "ERASURE"]) }),

  ApplyShop: z.object({
    universityId: id,
    campusId: id,
    name: z.string().trim().min(2).max(120),
    locationNote: z.string().trim().max(500).optional(),
    /** STUDENT_RUN is a student printing for others; it needs identity verification. */
    kind: z.enum(["BUSINESS", "STUDENT_RUN"]).default("BUSINESS"),
  }),

  // ---------------------------------------------------------------- provider verification
  AcceptUndertaking: z.object({ version: z.number().int().min(1).max(1000), agree: z.literal(true) }),
  ProviderEmail: z.object({ email: z.string().trim().toLowerCase().email().max(254) }),
  ProviderMatric: z.object({ matricNumber: z.string().trim().min(3).max(40) }),
  ProviderListQuery: z.object({ waiting: z.coerce.boolean().optional() }),
  DecideProviderCheck: z
      .object({
        check: z.enum(["STUDENT_EMAIL", "MATRIC_NUMBER", "UNIVERSITY_REVIEW"]),
        decision: z.enum(["PASS", "REJECT"]),
        /** What was confirmed, when there is no pending request to take it from. */
        subject: z.string().trim().min(1).max(200).optional(),
        /** How the identity was confirmed, for the record. */
        confirmedWith: z.enum(["STUDENT_RECORDS", "ID_CARD_IN_PERSON", "DEPARTMENT_CONFIRMED", "OTHER"]).default("STUDENT_RECORDS"),
        note: z.string().trim().min(3).max(1000),
      })
      .refine((v) => v.decision === "REJECT" || v.check !== "UNIVERSITY_REVIEW" || Boolean(v.subject), {
        message: "name the person you met",
        path: ["subject"],
      }),
  RevokeProviderCheck: z.object({
    check: z.enum(["STUDENT_EMAIL", "MATRIC_NUMBER", "UNIVERSITY_REVIEW"]).default("UNIVERSITY_REVIEW"),
    /** Also stop the shop trading, for a provider who should not continue. */
    suspend: z.boolean().default(false),
    reason: z.string().trim().min(3).max(1000),
  }),
  StudentRoll: z.object({
    rows: z
        .array(z.object({ matricNumber: z.string().trim().min(3).max(40), surname: z.string().trim().min(2).max(100) }))
        .min(1)
        .max(50_000),
  }),
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
  // Everything but the name is optional, and stays optional: a provider who knows
  // only "the HP in my room" can register it and print today. `null` is how the
  // client says "I do not know", which is a different answer from "no".
  Device: z.object({
    label: z.string().trim().min(1).max(80),
    capabilities: z.record(z.string(), z.union([z.boolean(), z.string().max(80)])).default({}),
    ...printerDetailFields,
  }),
  UpdateDevice: z.object({
    label: z.string().trim().min(1).max(80).optional(),
    reportedStatus: z.enum(["UNKNOWN", "AVAILABLE", "BUSY", "OUT_OF_PAPER", "OUT_OF_TONER", "FAULT", "OFFLINE"]).optional(),
    ...printerDetailFields,
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
    /** Print credit each new student gets once they confirm their phone number. */
    welcomeCreditKobo: z.number().int().min(0).max(500_000).optional(),
    /** Whether students with their own printers may register as providers. */
    studentProvidersAllowed: z.boolean().optional(),
    studentEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/, "that is not a domain")).max(20).optional(),
    matricPattern: z.string().trim().min(3).max(200).nullable().optional(),
    studentProviderCapKobo: z.number().int().min(10_000).max(100_000_000).optional(),
    providerReverifyDays: z.number().int().min(30).max(1095).optional(),
  }),
  Campus: z.object({ name }),
  UpdateCampus: z.object({ name: name.optional(), isActive: z.boolean().optional() }),
  Department: z.object({ name }),
  ShopStatusAction: z.object({ action: z.enum(["approve", "suspend", "reinstate", "remove"]), reason: z.string().trim().min(3).max(500) }),
  AdminRefund: z.object({ reason: z.string().trim().min(3).max(1000), refundTo: refundTo.default("WALLET") }),
  RetryRefund: z.object({ reason: z.string().trim().min(3).max(1000), refundTo: refundTo.default("PROVIDER") }),
  ResolveDispute: z.object({
    status: z.enum(["UNDER_REVIEW", "RESOLVED_REFUND", "RESOLVED_REPRINT", "RESOLVED_NO_ACTION"]),
    note: z.string().trim().min(3).max(4000),
    refundKobo: kobo.min(1).optional(),
    refundTo: refundTo.default("WALLET"),
  }),
  UniversityStaff: z.object({ email, role: z.enum(["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]) }),
  HandlePrivacy: z.object({ status: z.enum(["IN_PROGRESS", "COMPLETED", "REJECTED"]), note: z.string().trim().max(2000).optional() }),

  ResetMfa: z.object({ email, reason: z.string().trim().min(10).max(1000) }),
  CreateUniversity: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), name }),

  /**
   * The website contact form. `website` is a honeypot: it is hidden from people
   * and left empty by them, so anything in it came from something filling every
   * field it found. Nothing else here rejects a message — a real university
   * writing two short lines must always get through.
   */
  CreateEnquiry: z.object({
    kind: z.enum(ENQUIRY_KINDS),
    name: z.string().trim().min(2).max(120),
    email,
    phone: z.string().trim().min(6).max(30).optional().or(z.literal("").transform(() => undefined)),
    organisation: z.string().trim().min(2).max(200).optional().or(z.literal("").transform(() => undefined)),
    role: z.string().trim().min(2).max(120).optional().or(z.literal("").transform(() => undefined)),
    message: z.string().trim().min(10).max(4000),
    website: z.string().max(200).optional(),
  }),
  EnquiryReply: z.object({ body: z.string().trim().min(2).max(8000) }),
  EnquiryNote: z.object({ body: z.string().trim().min(2).max(8000) }),
  UpdateEnquiry: z.object({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    priority: z.enum(ENQUIRY_PRIORITIES).optional(),
    kind: z.enum(ENQUIRY_KINDS).optional(),
    assignedTo: z.string().uuid().nullish(),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  /**
   * Turns an enquiry into somewhere a shop can actually trade. `universityId`
   * attaches to a tenant we already have; otherwise one is created, and whether
   * it is created UNCLAIMED depends on who was asking.
   */
  ConvertEnquiry: z.object({
    universityId: z.string().uuid().optional(),
    universityName: name.optional(),
    campusName: name.default("Main campus"),
    ownerEmail: email.optional(),
    shopName: name.optional(),
    pricingMode: z.enum(PRICING_MODES).optional(),
    note: z.string().trim().max(500).optional(),
  }),
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