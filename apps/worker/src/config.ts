import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const WorkerConfigSchema = z
    .object({
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
        DATABASE_URL: z.string().url(),
        WORKER_ID: z.string().default(`worker-${process.pid}`),
        WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
        POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
        PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
        PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),

        STORAGE_DRIVER: z.enum(["LOCAL", "S3"]).default("LOCAL"),
        STORAGE_DIR: z.string().default("./storage-data"),
        STORAGE_SIGNING_SECRET: z.string().optional(),
        S3_ENDPOINT: z.string().optional(),
        S3_REGION: z.string().optional(),
        S3_BUCKET: z.string().optional(),
        S3_ACCESS_KEY_ID: z.string().optional(),
        S3_SECRET_ACCESS_KEY: z.string().optional(),

        SCANNER: z.enum(["CLAMAV", "NONE"]).default("CLAMAV"),
        CLAMD_HOST: z.string().default("127.0.0.1"),
        CLAMD_PORT: z.coerce.number().int().default(3310),
        PROCESSING_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
        SOFFICE_BIN: z.string().default("soffice"),
        QPDF_BIN: z.string().default("qpdf"),
        PDFTOPPM_BIN: z.string().default("pdftoppm"),

        PAYMENT_PROVIDER: z.enum(["NONE", "TEST", "PAYSTACK"]).default("NONE"),
        PAYSTACK_SECRET_KEY: z.string().optional(),
        EMAIL_DRIVER: z.enum(["SMTP", "LOG", "CAPTURE", "NONE"]).default("LOG"),
        SMTP_URL: z.string().optional(),
        SMTP_REQUIRE_TLS: bool.default(true),
        EMAIL_FROM: z.string().default("PrintFlow <no-reply@printflow.local>"),
        RUN_SCHEDULER: bool.default(true),
        /** Print emailed links and texted codes to the terminal (development only). */
        DEV_CONSOLE: bool.optional(),
        SMS_DRIVER: z.enum(["TERMII", "LOG", "CAPTURE", "NONE"]).default("LOG"),
        TERMII_API_KEY: z.string().optional(),
        TERMII_SENDER_ID: z.string().optional(),
        TERMII_BASE_URL: z.string().url().default("https://api.ng.termii.com"),
        TERMII_CHANNEL: z.enum(["dnd", "generic"]).default("dnd"),
    })
    .superRefine((c, ctx) => {
        if (c.NODE_ENV === "production" && c.SCANNER === "NONE") {
            ctx.addIssue({ code: "custom", path: ["SCANNER"], message: "malware scanning cannot be disabled in production" });
        }
        if (c.EMAIL_DRIVER === "SMTP" && !c.SMTP_URL) ctx.addIssue({ code: "custom", path: ["SMTP_URL"], message: "required when EMAIL_DRIVER=SMTP" });
        if (c.NODE_ENV === "production" && c.EMAIL_DRIVER !== "SMTP") ctx.addIssue({ code: "custom", path: ["EMAIL_DRIVER"], message: "production needs EMAIL_DRIVER=SMTP" });
        if (c.NODE_ENV === "production" && !c.SMTP_REQUIRE_TLS) ctx.addIssue({ code: "custom", path: ["SMTP_REQUIRE_TLS"], message: "email must be sent over TLS in production" });
        if (c.NODE_ENV === "production" && (c.SMS_DRIVER === "LOG" || c.SMS_DRIVER === "CAPTURE")) {
            ctx.addIssue({ code: "custom", path: ["SMS_DRIVER"], message: "production needs SMS_DRIVER=TERMII (or NONE)" });
        }
        if (c.SMS_DRIVER === "TERMII" && (!c.TERMII_API_KEY || !c.TERMII_SENDER_ID)) {
            ctx.addIssue({ code: "custom", path: ["TERMII_API_KEY"], message: "TERMII_API_KEY and TERMII_SENDER_ID are required when SMS_DRIVER=TERMII" });
        }
        if (c.NODE_ENV === "production" && c.DEV_CONSOLE === true) {
            ctx.addIssue({ code: "custom", path: ["DEV_CONSOLE"], message: "codes and links must never be printed in production" });
        }
        if (c.NODE_ENV === "production" && c.PAYMENT_PROVIDER === "TEST") {
            ctx.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"], message: "TEST payments are not allowed in production" });
        }
    });

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
    const r = WorkerConfigSchema.safeParse(env);
    if (!r.success) throw new Error(`Invalid worker configuration:\n${r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    return r.data;
}
