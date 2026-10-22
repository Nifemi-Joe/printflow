import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { z } from "zod";
import { CONTROLLERS } from "./app.js";
import { Schemas } from "./http/schemas.js";

type Auth = "public" | "user" | "student" | "shop" | "university" | "platform" | "signature" | "signed-link";

interface RouteDoc {
  summary: string;
  tag: string;
  auth: Auth;
  /** Shop permission or university role needed, for documentation. */
  requires?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  /** Raw upload body instead of JSON. */
  upload?: boolean;
  idempotent?: boolean;
}

const D = (tag: string, auth: Auth, summary: string, extra: Partial<RouteDoc> = {}): RouteDoc => ({ tag, auth, summary, ...extra });

/** Documentation for every route, keyed "METHOD /path". Completeness is enforced by a test. */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  "GET /v1/health": D("System", "public", "Liveness probe"),
  "GET /v1/ready": D("System", "public", "Readiness probe (checks the database)"),

  "POST /v1/auth/register": D("Auth", "public", "Register a student account (sends an email verification link)", { body: Schemas.RegisterStudent }),
  "POST /v1/auth/login": D("Auth", "public", "Sign in with email or verified phone + password. Web clients receive an HttpOnly cookie; mobile clients receive a bearer token", { body: Schemas.Login }),
  "POST /v1/auth/otp/request": D("Auth", "public", "Text a 6-digit sign-in code to a verified phone (same 202 answer for any number; 1 per minute per number)", { body: Schemas.PhoneOnly }),
  "POST /v1/auth/otp/verify": D("Auth", "public", "Sign in with a phone and the texted code (5 tries per code, single use, 10-minute expiry)", { body: Schemas.OtpSignIn }),
  "POST /v1/auth/logout": D("Auth", "user", "Sign out this session"),
  "POST /v1/auth/logout-all": D("Auth", "user", "Sign out every session for this account"),
  "GET /v1/auth/session": D("Auth", "public", "Session probe: { authenticated: false } or the same body as /auth/me"),
  "GET /v1/auth/me": D("Auth", "user", "Current user, roles, MFA state and CSRF token"),
  "POST /v1/auth/verify-email": D("Auth", "public", "Confirm an email address", { body: Schemas.Token }),
  "POST /v1/auth/verify-email/resend": D("Auth", "user", "Resend the verification email"),
  "POST /v1/auth/password-reset/request": D("Auth", "public", "Request a reset link by email, or a code by SMS to a verified phone (always 202)", { body: Schemas.ResetRequest }),
  "POST /v1/auth/password-reset/confirm": D("Auth", "public", "Set a new password with an emailed token or a texted code; signs out all sessions", { body: Schemas.ResetConfirm }),
  "POST /v1/auth/password/change": D("Auth", "user", "Change password; signs out other sessions", { body: Schemas.ChangePassword }),
  "POST /v1/auth/mfa/totp/setup": D("Auth", "user", "Begin authenticator (TOTP) enrolment"),
  "POST /v1/auth/mfa/totp/confirm": D("Auth", "user", "Confirm TOTP enrolment with a code", { body: Schemas.MfaCode }),
  "POST /v1/auth/mfa/verify": D("Auth", "user", "Verify this session with a TOTP code (required for staff)", { body: Schemas.MfaCode }),
  "PATCH /v1/me/profile": D("Auth", "user", "Update name and campus details (phone changes go through /me/phone)", { body: Schemas.UpdateProfile }),
  "POST /v1/me/phone": D("Auth", "user", "Set or change my phone number (local Nigerian formats accepted) and text a verification code", { body: Schemas.PhoneOnly }),
  "POST /v1/me/phone/verify": D("Auth", "user", "Verify my phone number with the texted code", { body: Schemas.PhoneCode }),

  "GET /v1/universities": D("Catalogue", "public", "Active universities"),
  "GET /v1/universities/{universityId}": D("Catalogue", "public", "University with campuses and departments"),
  "GET /v1/universities/{universityId}/shops": D("Catalogue", "public", "Approved shops with pickup points, reported device status and queue estimates", {
    query: z.object({ campusId: z.string().uuid().optional() }),
  }),
  "GET /v1/shops/{shopId}/price-list": D("Catalogue", "public", "The exact price list the quote engine uses for this shop"),

  "POST /v1/documents": D("Documents", "student", "Upload a PDF or DOCX as the raw request body (X-Filename header, max 50 MB)", { upload: true }),
  "POST /v1/documents/{assetId}/versions": D("Documents", "student", "Upload a replacement version", { upload: true }),
  "GET /v1/documents": D("Documents", "student", "My documents with their latest version"),
  "GET /v1/documents/{assetId}": D("Documents", "student", "A document and all its versions"),
  "GET /v1/documents/versions/{versionId}/previews/{page}": D("Documents", "student", "Short-lived link to a page preview image"),
  "GET /v1/documents/versions/{versionId}/print-file": D("Documents", "student", "Short-lived link to the print-ready PDF"),
  "DELETE /v1/documents/{assetId}": D("Documents", "student", "Delete a document (files purged once no active order needs them)"),

  "POST /v1/quotes": D("Orders", "student", "Get an exact server-side price for a document, shop and print spec", { body: Schemas.CreateQuote }),
  "GET /v1/quotes/{quoteId}": D("Orders", "student", "Read a quote"),
  "POST /v1/orders": D("Orders", "student", "Confirm an order from an unexpired quote (price frozen)", { body: Schemas.CreateOrder, idempotent: true }),
  "GET /v1/orders": D("Orders", "student", "My orders (cursor pagination)", { query: Pagination() }),
  "GET /v1/orders/{orderId}": D("Orders", "student", "Order detail: status timeline, queue position, payments, refunds"),
  "POST /v1/orders/{orderId}/cancel": D("Orders", "student", "Cancel (before the shop accepts). Paid money is refunded to the wallet (instant, default) or back to the card/bank (refundTo: PROVIDER); wallet money always returns to the wallet", { body: Schemas.CancelOrder }),
  "POST /v1/orders/{orderId}/payments": D("Payments", "student", "Pay the frozen order total. useWallet applies the wallet balance first (print credit, then cash); if it covers everything the order is paid at once, otherwise checkout opens for the rest by card, bank transfer or USSD (503 when checkout is not configured)", { body: Schemas.StartPayment }),
  "POST /v1/orders/{orderId}/pickup-code": D("Orders", "student", "Generate a one-time pickup code (replaces any previous code)"),
  "GET /v1/orders/{orderId}/receipt": D("Orders", "student", "Receipt for a paid order"),
  "POST /v1/orders/{orderId}/disputes": D("Orders", "student", "Open a dispute", { body: Schemas.OpenDispute }),
  "GET /v1/notifications": D("Notifications", "user", "My notifications"),
  "POST /v1/notifications/{id}/read": D("Notifications", "user", "Mark one notification read"),
  "POST /v1/notifications/read-all": D("Notifications", "user", "Mark all notifications read"),
  "POST /v1/privacy-requests": D("Privacy", "user", "Request a data export or erasure", { body: Schemas.PrivacyRequest }),
  "GET /v1/privacy-requests": D("Privacy", "user", "My privacy requests"),
  "GET /v1/privacy-requests/{requestId}/download": D("Privacy", "user", "Short-lived link to a completed data export"),

  "POST /v1/webhooks/paystack": D("Payments", "signature", "Paystack webhook (HMAC-SHA512 of raw body in x-paystack-signature)"),
  "POST /v1/webhooks/test": D("Payments", "signature", "TEST provider webhook (non-production only)"),
  "GET /v1/shops/{shopId}/verification": D("Provider", "shop", "What has been proven about who runs this shop, what is left to do, and the limits that apply", { requires: "shop owner" }),
  "POST /v1/shops/{shopId}/verification/undertaking": D("Provider", "shop", "Accept the confidentiality undertaking (required before a student-run shop can take orders)", { body: Schemas.AcceptUndertaking, requires: "shop owner" }),
  "POST /v1/shops/{shopId}/verification/email": D("Provider", "shop", "Email a 6-digit code to an address on the university's student-mail domain", { body: Schemas.ProviderEmail, requires: "shop owner" }),
  "POST /v1/shops/{shopId}/verification/email/confirm": D("Provider", "shop", "Confirm the emailed code, which proves a university email address", { body: Schemas.PhoneCode, requires: "shop owner" }),
  "POST /v1/shops/{shopId}/verification/matric": D("Provider", "shop", "Submit a matric number: matched against the university's roll where it uploaded one, otherwise sent to the university to confirm", { body: Schemas.ProviderMatric, requires: "shop owner" }),
  "GET /v1/admin/universities/{universityId}/providers": D("University", "university", "Print shops and how far each one's identity has been proven; waiting=true shows only those needing a decision", { query: Schemas.ProviderListQuery }),
  "GET /v1/admin/universities/{universityId}/providers/{shopId}": D("University", "university", "One provider: level, every check with its evidence, and undertakings accepted"),
  "POST /v1/admin/universities/{universityId}/providers/{shopId}/decide": D("University", "university", "Pass or reject a check waiting on the university, or vouch for a provider outright", { body: Schemas.DecideProviderCheck }),
  "POST /v1/admin/universities/{universityId}/providers/{shopId}/revoke": D("University", "university", "Withdraw a check, and optionally stop the shop trading", { body: Schemas.RevokeProviderCheck }),
  "PUT /v1/admin/universities/{universityId}/providers/roll": D("University", "university", "Replace the student roll so matric numbers verify themselves; only the matric number and a keyed hash of each surname are stored", { body: Schemas.StudentRoll }),

  "GET /v1/me/wallet": D("Wallet", "student", "My wallet: balance (cash and print credit), limits, pending top-ups and recent activity"),
  "GET /v1/me/wallet/entries": D("Wallet", "student", "My wallet statement, newest first (page with before=<id>)", { query: Schemas.WalletStatementQuery }),
  "POST /v1/me/wallet/topups": D("Wallet", "student", "Start a top-up by card, bank transfer or USSD; credited when the provider confirms it", { body: Schemas.WalletTopup }),
  "GET /v1/me/wallet/topups/{reference}": D("Wallet", "student", "Status of one of my top-ups"),
  "GET /v1/admin/universities/{universityId}/wallet/credit": D("University", "university", "Print credit granted to students, and how much is unspent"),
  "POST /v1/admin/universities/{universityId}/wallet/credit": D("University", "university", "Give a student print credit (by email or matric number)", { body: Schemas.PromoCredit, idempotent: true, requires: "UNIVERSITY_ADMIN or UNIVERSITY_FINANCE" }),
  "POST /v1/admin/universities/{universityId}/wallet/credit/revoke": D("University", "university", "Take back unspent print credit (cash is never touched)", { body: Schemas.PromoCredit, idempotent: true, requires: "UNIVERSITY_ADMIN or UNIVERSITY_FINANCE" }),
  "GET /v1/test-payments/{reference}": D("Payments", "student", "TEST checkout: order payment or wallet top-up details (non-production only)"),
  "POST /v1/test-payments/{reference}/complete": D("Payments", "student", "TEST checkout: simulate the provider result via a signed webhook", { body: Schemas.CompleteTestPayment }),
  "GET /v1/files/{token}": D("Files", "signed-link", "Download an object with a short-lived signed token (LOCAL storage driver)"),

  "POST /v1/shops": D("Shop", "user", "Apply to register a print shop (pending university approval)", { body: Schemas.ApplyShop }),
  "GET /v1/shops/{shopId}": D("Shop", "shop", "Shop profile and my permissions"),
  "PATCH /v1/shops/{shopId}": D("Shop", "shop", "Update hours, location note, accepting orders", { requires: "catalogue.manage", body: Schemas.UpdateShop }),
  "POST /v1/shops/{shopId}/pickup-locations": D("Shop", "shop", "Add a pickup location", { requires: "catalogue.manage", body: Schemas.PickupLocation }),
  "PATCH /v1/shops/{shopId}/pickup-locations/{locationId}": D("Shop", "shop", "Rename or deactivate a pickup location", { requires: "catalogue.manage", body: Schemas.UpdatePickupLocation }),
  "GET /v1/shops/{shopId}/queue": D("Shop", "shop", "Live work queue with allowed actions", { requires: "orders.view" }),
  "GET /v1/shops/{shopId}/orders": D("Shop", "shop", "Order history", { requires: "orders.view", query: Schemas.OrderListQuery }),
  "GET /v1/shops/{shopId}/orders/{orderId}": D("Shop", "shop", "Job detail", { requires: "orders.view" }),
  "POST /v1/shops/{shopId}/orders/{orderId}/transitions": D("Shop", "shop", "Accept, reject, start, pause, resume, report failure, send to QA", { requires: "per transition", body: Schemas.Transition }),
  "POST /v1/shops/{shopId}/orders/{orderId}/quality-checks": D("Shop", "shop", "Record QA; PASS marks ready, FAIL sends back for reprint", { requires: "orders.qa", body: Schemas.QualityCheck }),
  "POST /v1/shops/{shopId}/orders/{orderId}/document-link": D("Shop", "shop", "Short-lived link to the job's print file (audited)", { requires: "documents.download" }),
  "POST /v1/shops/{shopId}/orders/{orderId}/collect": D("Shop", "shop", "Verify the student's pickup code and mark collected", { requires: "orders.collect", body: Schemas.Collect }),
  "POST /v1/shops/{shopId}/sync": D("Shop", "shop", "Reconcile actions drafted offline (version-checked, idempotent)", { requires: "per action", body: Schemas.SyncActions }),
  "PUT /v1/shops/{shopId}/power": D("Shop", "shop", "Report the shop's power: light on, generator on, or light out with an expected return time (audited)", { requires: "orders.produce", body: Schemas.ShopPower }),
  "GET /v1/shops/{shopId}/devices": D("Shop", "shop", "Printers and their manually reported status", { requires: "orders.view" }),
  "POST /v1/shops/{shopId}/devices": D("Shop", "shop", "Add a printer", { requires: "devices.manage", body: Schemas.Device }),
  "PATCH /v1/shops/{shopId}/devices/{deviceId}": D("Shop", "shop", "Report printer status or rename", { requires: "orders.produce / devices.manage", body: Schemas.UpdateDevice }),
  "GET /v1/shops/{shopId}/staff": D("Shop", "shop", "Staff and permissions", { requires: "staff.manage" }),
  "POST /v1/shops/{shopId}/staff": D("Shop", "shop", "Add a staff member (cannot grant permissions you lack)", { requires: "staff.manage", body: Schemas.AddStaff }),
  "PATCH /v1/shops/{shopId}/staff/{membershipId}": D("Shop", "shop", "Change a staff member's role or permissions", { requires: "staff.manage", body: Schemas.UpdateStaff }),
  "DELETE /v1/shops/{shopId}/staff/{membershipId}": D("Shop", "shop", "Remove a staff member", { requires: "staff.manage" }),
  "GET /v1/shops/{shopId}/rate-cards": D("Shop", "shop", "Shop price lists and agreed bounds (merchant-controlled mode)", { requires: "pricing.manage" }),
  "POST /v1/shops/{shopId}/rate-cards": D("Shop", "shop", "Draft a new price list version", { requires: "pricing.manage", body: Schemas.RateCardDraft }),
  "POST /v1/shops/{shopId}/rate-cards/{rateCardId}/publish": D("Shop", "shop", "Publish a draft (validated against the agreement)", { requires: "pricing.manage" }),
  "GET /v1/shops/{shopId}/reports/summary": D("Shop", "shop", "Orders, revenue, turnaround, QA", { requires: "reports.view", query: Schemas.DateRange }),
  "GET /v1/shops/{shopId}/reports/reconciliation": D("Shop", "shop", "Daily payments vs refunds vs collected value", { requires: "reports.view", query: Schemas.DateRange }),

  "GET /v1/admin/universities/{universityId}/overview": D("University", "university", "Dashboard overview"),
  "PATCH /v1/admin/universities/{universityId}/settings": D("University", "university", "Pricing mode, quote lifetime, retention, welcome credit, and the student-provider policy (whether students may run shops, their email domains, matric format, order cap and renewal period)", { body: Schemas.UniversitySettings }),
  "GET /v1/admin/universities/{universityId}/campuses": D("University", "university", "Campuses and departments"),
  "POST /v1/admin/universities/{universityId}/campuses": D("University", "university", "Add a campus", { body: Schemas.Campus }),
  "PATCH /v1/admin/universities/{universityId}/campuses/{campusId}": D("University", "university", "Update a campus", { body: Schemas.UpdateCampus }),
  "POST /v1/admin/universities/{universityId}/campuses/{campusId}/departments": D("University", "university", "Add a department", { body: Schemas.Department }),
  "GET /v1/admin/universities/{universityId}/shops": D("University", "university", "All shops"),
  "POST /v1/admin/universities/{universityId}/shops/{shopId}/status": D("University", "university", "Approve, suspend, reinstate or remove a shop", { body: Schemas.ShopStatusAction }),
  "GET /v1/admin/universities/{universityId}/rate-cards": D("University", "university", "Campus rate cards, overrides and bounds"),
  "POST /v1/admin/universities/{universityId}/rate-cards": D("University", "university", "Draft a campus rate card version", { body: Schemas.RateCardDraft }),
  "POST /v1/admin/universities/{universityId}/rate-cards/{rateCardId}/publish": D("University", "university", "Publish a campus rate card"),
  "POST /v1/admin/universities/{universityId}/rate-cards/{rateCardId}/retire": D("University", "university", "Retire a campus rate card"),
  "POST /v1/admin/universities/{universityId}/price-overrides": D("University", "university", "Approve a shop-specific price override", { body: Schemas.Override }),
  "DELETE /v1/admin/universities/{universityId}/price-overrides/{overrideId}": D("University", "university", "Revoke an override"),
  "PUT /v1/admin/universities/{universityId}/price-bounds": D("University", "university", "Set agreed price ranges for merchant-controlled pricing", { body: Schemas.PriceBounds }),
  "GET /v1/admin/universities/{universityId}/orders": D("University", "university", "Monitor orders", { query: Schemas.OrderListQuery }),
  "GET /v1/admin/universities/{universityId}/orders/{orderId}": D("University", "university", "Order detail"),
  "POST /v1/admin/universities/{universityId}/orders/{orderId}/refund": D("University", "university", "Refund an order to the student's wallet (default, instant) or back to the card/bank", { body: Schemas.AdminRefund }),
  "POST /v1/admin/universities/{universityId}/orders/{orderId}/refund-retry": D("University", "university", "Re-issue a refund the payment provider refused (remaining amount only), through the provider again or to the wallet", { body: Schemas.RetryRefund }),
  "GET /v1/admin/universities/{universityId}/disputes": D("University", "university", "Disputes"),
  "POST /v1/admin/universities/{universityId}/disputes/{disputeId}/resolve": D("University", "university", "Review or resolve a dispute", { body: Schemas.ResolveDispute }),
  "GET /v1/admin/universities/{universityId}/staff": D("University", "university", "University staff"),
  "POST /v1/admin/universities/{universityId}/staff": D("University", "university", "Add university staff", { body: Schemas.UniversityStaff }),
  "DELETE /v1/admin/universities/{universityId}/staff/{staffId}": D("University", "university", "Remove university staff"),
  "GET /v1/admin/universities/{universityId}/audit-log": D("University", "university", "Audit log", { query: Pagination() }),
  "GET /v1/admin/universities/{universityId}/privacy-requests": D("University", "university", "Privacy requests"),
  "POST /v1/admin/universities/{universityId}/privacy-requests/{requestId}": D("University", "university", "Handle a privacy request", { body: Schemas.HandlePrivacy }),
  "GET /v1/admin/universities/{universityId}/reports/summary": D("University", "university", "Per-shop report", { query: Schemas.DateRange }),

  "GET /v1/platform/universities": D("Platform", "platform", "All universities"),
  "POST /v1/platform/universities": D("Platform", "platform", "Onboard a university", { body: Schemas.CreateUniversity }),
  "POST /v1/platform/users/mfa-reset": D("Platform", "platform", "Clear a user's authenticator after out-of-band identity checks; signs them out everywhere (audited)", { body: Schemas.ResetMfa }),
  "PATCH /v1/platform/universities/{universityId}": D("Platform", "platform", "Activate/suspend, set platform fees", { body: Schemas.UpdateUniversity }),
  "POST /v1/platform/universities/{universityId}/admins": D("Platform", "platform", "Assign a university administrator", { body: Schemas.AssignAdmin }),
  "GET /v1/platform/health": D("Platform", "platform", "Jobs, dead letters, webhook failures"),
  "GET /v1/platform/webhooks": D("Platform", "platform", "Recent provider webhooks", { query: Pagination() }),
};

function Pagination() {
  return z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() });
}

export function listRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const ctrl of CONTROLLERS) {
    const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? "").replace(/^\/|\/$/g, "");
    for (const key of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = (ctrl.prototype as unknown as Record<string, unknown>)[key];
      if (typeof fn !== "function" || key === "constructor") continue;
      const sub = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (sub === undefined || method === undefined) continue;
      const path = `/${[base, String(sub).replace(/^\/|\/$/g, "")].filter(Boolean).join("/")}`.replace(/:(\w+)/g, "{$1}");
      out.push({ method: RequestMethod[method], path });
    }
  }
  return out;
}

const ERROR = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" }, details: {}, requestId: { type: "string" } },
    },
  },
};

function jsonSchema(s: z.ZodType): unknown {
  return z.toJSONSchema(s, { unrepresentable: "any", io: "input" });
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of listRoutes()) {
    const doc = ROUTE_DOCS[`${r.method} ${r.path}`];
    if (!doc) continue;
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const security =
        doc.auth === "public" || doc.auth === "signature" || doc.auth === "signed-link"
            ? []
            : [{ cookieSession: [], csrf: [] }, { bearer: [] }];
    const op: Record<string, unknown> = {
      tags: [doc.tag],
      summary: doc.summary,
      description: [
        `Access: **${doc.auth}**${doc.requires ? ` (requires \`${doc.requires}\`)` : ""}.`,
        ["shop", "university", "platform"].includes(doc.auth) ? "Staff sessions must be MFA-verified." : "",
        doc.idempotent ? "Requires an `Idempotency-Key` header (16-128 chars); retries return the original result." : "",
      ]
          .filter(Boolean)
          .join(" "),
      parameters: [
        ...params,
        ...(doc.query ? Object.entries((jsonSchema(doc.query) as { properties?: Record<string, unknown> }).properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: false, schema })) : []),
        ...(doc.idempotent ? [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 16, maxLength: 128 } }] : []),
        ...(doc.upload ? [{ name: "X-Filename", in: "header", required: true, schema: { type: "string" } }] : []),
      ],
      security,
      responses: {
        "2XX": { description: "Success" },
        "400": { description: "Validation failed", content: { "application/json": { schema: ERROR } } },
        "401": { description: "Not signed in", content: { "application/json": { schema: ERROR } } },
        "403": { description: "Forbidden, CSRF failure or MFA required", content: { "application/json": { schema: ERROR } } },
        "404": { description: "Not found (also returned for resources outside your tenant)", content: { "application/json": { schema: ERROR } } },
        "409": { description: "Conflict (stale version, duplicate)", content: { "application/json": { schema: ERROR } } },
        "422": { description: "Business rule violation", content: { "application/json": { schema: ERROR } } },
        "429": { description: "Rate limited (see Retry-After)", content: { "application/json": { schema: ERROR } } },
      },
    };
    if (doc.body) op.requestBody = { required: true, content: { "application/json": { schema: jsonSchema(doc.body) } } };
    if (doc.upload) {
      op.requestBody = {
        required: true,
        content: {
          "application/pdf": { schema: { type: "string", format: "binary" } },
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { schema: { type: "string", format: "binary" } },
        },
      };
    }
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "PrintFlow API",
      version: "0.2.0",
      description:
          "Digital printing for Nigerian universities. All money is integer kobo (1 NGN = 100 kobo). Prices are only ever computed by the server. Errors use { error: { code, message, details?, requestId } }.",
    },
    servers: [{ url: "http://localhost:4000" }],
    components: {
      securitySchemes: {
        cookieSession: { type: "apiKey", in: "cookie", name: "pf_session" },
        csrf: { type: "apiKey", in: "header", name: "X-CSRF-Token", description: "Required with cookie sessions on POST/PUT/PATCH/DELETE; returned by /v1/auth/me and login" },
        bearer: { type: "http", scheme: "bearer", description: "Mobile clients (login with client=mobile)" },
      },
    },
    paths,
  };
}
