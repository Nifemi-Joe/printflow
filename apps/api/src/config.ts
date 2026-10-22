import { z } from "zod";

const bool = z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1");

const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

/**
 * All runtime configuration, validated once at startup. The process refuses to
 * start with an unsafe combination (e.g. test payments or no malware scanning
 * in production) instead of silently degrading.
 */
export const ConfigSchema = z
    .object({
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
        PORT: z.coerce.number().int().min(1).max(65535).default(4000),
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
        DATABASE_URL: z.string().url(),
        DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),

        PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
        PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),
        /** Comma-separated browser origins allowed to call the API with credentials. */
        CORS_ORIGINS: z.string().default("http://localhost:3000"),
        /** Set when the API sits behind exactly one trusted reverse proxy. */
        TRUST_PROXY: bool.default(false),
        COOKIE_SECURE: bool.optional(),

        SESSION_SECRET: secret(32),
        PICKUP_CODE_PEPPER: secret(32),
        /** base64 of 32 random bytes; encrypts TOTP secrets at rest (AES-256-GCM). */
        MFA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be base64 of exactly 32 bytes"),
        REQUIRE_STAFF_MFA: bool.default(true),
        REQUIRE_EMAIL_VERIFICATION: bool.default(true),

        STORAGE_DRIVER: z.enum(["LOCAL", "S3"]).default("LOCAL"),
        STORAGE_DIR: z.string().default("./storage-data"),
        STORAGE_SIGNING_SECRET: z.string().optional(),
        S3_ENDPOINT: z.string().optional(),
        S3_REGION: z.string().optional(),
        S3_BUCKET: z.string().optional(),
        S3_ACCESS_KEY_ID: z.string().optional(),
        S3_SECRET_ACCESS_KEY: z.string().optional(),
        SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(120),
        UPLOAD_TMP_DIR: z.string().optional(),

        PAYMENT_PROVIDER: z.enum(["NONE", "TEST", "PAYSTACK"]).default("NONE"),
        PAYMENTS_LIVE_ENABLED: bool.default(false),
        PAYSTACK_SECRET_KEY: z.string().optional(),
        /** HMAC secret for the TEST provider's simulated webhooks (non-production only). */
        TEST_WEBHOOK_SECRET: z.string().default("test-webhook-secret-not-for-production-use"),
        PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

        /** Student wallet (spend-only balance). Amounts in kobo: 10000 = ₦100. */
        WALLET_ENABLED: bool.default(true),
        WALLET_MAX_BALANCE_KOBO: z.coerce.number().int().min(100_000).max(100_000_000).default(10_000_000),
        WALLET_TOPUP_MIN_KOBO: z.coerce.number().int().min(10_000).max(50_000_000).default(10_000),
        WALLET_TOPUP_MAX_KOBO: z.coerce.number().int().min(10_000).max(50_000_000).default(5_000_000),
        /** A text is sent when a payment takes the balance below this. 0 turns it off. */
        WALLET_LOW_BALANCE_KOBO: z.coerce.number().int().min(0).max(10_000_000).default(30_000),
        /** Largest single print-credit grant a university admin can make. */
        PROMO_GRANT_MAX_KOBO: z.coerce.number().int().min(100).max(10_000_000).default(1_000_000),

        /**
         * Key that surnames in an uploaded student roll are hashed with, so matric numbers
         * can verify themselves without PrintFlow holding a copy of the student register.
         * Only needed by universities that upload a roll. Changing it invalidates those rolls.
         */
        STUDENT_ROLL_PEPPER: secret(32).optional(),

        EMAIL_DRIVER: z.enum(["SMTP", "LOG", "CAPTURE", "NONE"]).default("LOG"),
        /** smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465. */
        SMTP_URL: z.string().optional(),
        SMTP_REQUIRE_TLS: bool.default(true),
        /** SMS for phone verification, sign-in codes and pickup alerts. */
        SMS_DRIVER: z.enum(["TERMII", "LOG", "CAPTURE", "NONE"]).default("LOG"),
        TERMII_API_KEY: z.string().optional(),
        TERMII_SENDER_ID: z.string().regex(/^[A-Za-z0-9 ]{3,11}$|^\+?\d{6,15}$/, "3–11 letters/digits, or a number").optional(),
        TERMII_BASE_URL: z.string().url().default("https://api.ng.termii.com"),
        TERMII_CHANNEL: z.enum(["dnd", "generic"]).default("dnd"),
        /** Checkout methods students may choose (Paystack channels). */
        PAYMENT_METHODS: z
            .string()
            .default("CARD,BANK_TRANSFER,USSD")
            .transform((v) => [...new Set(v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))])
            .pipe(z.array(z.enum(["CARD", "BANK_TRANSFER", "USSD"])).min(1, "enable at least one payment method")),
        /**
         * Print links and codes (email links, SMS codes, authenticator codes, pickup codes,
         * test checkout links) to the terminal. Defaults to on outside production; refused in production.
         */
        DEV_CONSOLE: bool.optional(),
        /** Multiplies every rate limit. Must be 1 in production; raised only in test suites. */
        RATE_LIMIT_SCALE: z.coerce.number().int().min(1).max(1000).default(1),
        EMAIL_FROM: z.string().default("PrintFlow <no-reply@printflow.local>"),
    })
    .superRefine((c, ctx) => {
        if (c.WALLET_TOPUP_MIN_KOBO > c.WALLET_TOPUP_MAX_KOBO) {
            ctx.addIssue({ code: "custom", path: ["WALLET_TOPUP_MIN_KOBO"], message: "must not be more than WALLET_TOPUP_MAX_KOBO" });
        }
        if (c.WALLET_TOPUP_MAX_KOBO > c.WALLET_MAX_BALANCE_KOBO) {
            ctx.addIssue({ code: "custom", path: ["WALLET_TOPUP_MAX_KOBO"], message: "must not be more than WALLET_MAX_BALANCE_KOBO" });
        }
        if (c.STORAGE_DRIVER === "LOCAL" && (!c.STORAGE_SIGNING_SECRET || c.STORAGE_SIGNING_SECRET.length < 32)) {
            ctx.addIssue({ code: "custom", path: ["STORAGE_SIGNING_SECRET"], message: "required (32+ chars) for LOCAL storage" });
        }
        if (c.NODE_ENV === "production") {
            if (c.PAYMENT_PROVIDER === "TEST") ctx.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"], message: "TEST payments are not allowed in production" });
            // LOG would write one-time verification and reset links into the logs, and NONE breaks sign-up.
            if (c.EMAIL_DRIVER !== "SMTP") ctx.addIssue({ code: "custom", path: ["EMAIL_DRIVER"], message: "production needs EMAIL_DRIVER=SMTP" });
            // LOG would write sign-in codes into the logs.
            if (c.SMS_DRIVER === "LOG" || c.SMS_DRIVER === "CAPTURE") ctx.addIssue({ code: "custom", path: ["SMS_DRIVER"], message: "production needs SMS_DRIVER=TERMII (or NONE to switch phone features off)" });
            if (!c.SMTP_REQUIRE_TLS) ctx.addIssue({ code: "custom", path: ["SMTP_REQUIRE_TLS"], message: "email must be sent over TLS in production" });
            if (c.RATE_LIMIT_SCALE !== 1) ctx.addIssue({ code: "custom", path: ["RATE_LIMIT_SCALE"], message: "rate limits cannot be relaxed in production" });
            if (!c.REQUIRE_STAFF_MFA) ctx.addIssue({ code: "custom", path: ["REQUIRE_STAFF_MFA"], message: "staff MFA cannot be disabled in production" });
            if (c.COOKIE_SECURE === false) ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "cookies must be Secure in production" });
            if (c.DEV_CONSOLE === true) ctx.addIssue({ code: "custom", path: ["DEV_CONSOLE"], message: "codes and links must never be printed in production" });
        }
        if (c.SMS_DRIVER === "TERMII" && (!c.TERMII_API_KEY || !c.TERMII_SENDER_ID)) {
            ctx.addIssue({ code: "custom", path: ["TERMII_API_KEY"], message: "TERMII_API_KEY and TERMII_SENDER_ID are required when SMS_DRIVER=TERMII" });
        }
        if (c.EMAIL_DRIVER === "SMTP" && !c.SMTP_URL) ctx.addIssue({ code: "custom", path: ["SMTP_URL"], message: "required when EMAIL_DRIVER=SMTP" });
        if (c.PAYMENTS_LIVE_ENABLED && (c.PAYMENT_PROVIDER !== "PAYSTACK" || !c.PAYSTACK_SECRET_KEY)) {
            ctx.addIssue({ code: "custom", path: ["PAYMENTS_LIVE_ENABLED"], message: "live payments need PAYMENT_PROVIDER=PAYSTACK and PAYSTACK_SECRET_KEY" });
        }
    });

export type AppConfig = z.infer<typeof ConfigSchema> & { corsOrigins: string[]; cookieSecure: boolean; devConsole: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = ConfigSchema.safeParse(env);
    if (!parsed.success) {
        const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
        throw new Error(`Invalid configuration:\n${lines}`);
    }
    const c = parsed.data;
    return {
        ...c,
        corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
        cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === "production",
        devConsole: c.NODE_ENV !== "production" && (c.DEV_CONSOLE ?? true),
    };
}

/** Whether checkout may proceed at all with this configuration. */
export function checkoutMode(c: AppConfig): "LIVE" | "TEST" | "DISABLED" {
    if (c.PAYMENT_PROVIDER === "PAYSTACK" && c.PAYMENTS_LIVE_ENABLED && c.PAYSTACK_SECRET_KEY) return "LIVE";
    if (c.PAYMENT_PROVIDER === "TEST" && c.NODE_ENV !== "production") return "TEST";
    return "DISABLED";
}
