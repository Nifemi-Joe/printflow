import pg from "pg";
import pino from "pino";
import { ClamdScanner, NoopDevScanner } from "../../../packages/documents/src/index.js";
import { LogMailer, LogSms, NoneMailer, NoneSms, PaystackProvider, SmtpMailer, TermiiSms, TestPaymentProvider } from "../../../packages/providers/src/index.js";
import { createStorage } from "../../../packages/storage/src/index.js";
import { loadWorkerConfig } from "./config.js";
import type { WorkerDeps } from "./handlers.js";
import { runForever } from "./runner.js";

const cfg = loadWorkerConfig();
const devConsole = cfg.NODE_ENV !== "production" && (cfg.DEV_CONSOLE ?? true);
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "printflow-worker", worker: cfg.WORKER_ID }, redact: ["*.password", "*.token", "*.code", "mail.text", "sms.text"] });

if (cfg.SCANNER === "NONE") log.warn("SCANNER=NONE: uploads are NOT scanned for malware (development only)");

const deps: WorkerDeps = {
  pool: new pg.Pool({ connectionString: cfg.DATABASE_URL, max: cfg.WORKER_CONCURRENCY + 2 }),
  log,
  storage: createStorage({ ...cfg, PUBLIC_API_URL: cfg.PUBLIC_API_URL }),
  scanner: cfg.SCANNER === "CLAMAV" ? new ClamdScanner(cfg.CLAMD_HOST, cfg.CLAMD_PORT) : new NoopDevScanner(),
  tools: { soffice: cfg.SOFFICE_BIN, qpdf: cfg.QPDF_BIN, pdftoppm: cfg.PDFTOPPM_BIN, timeoutMs: cfg.PROCESSING_TIMEOUT_MS },
  // Notification jobs retry on failure, so the worker sends directly.
  mailer:
      cfg.EMAIL_DRIVER === "SMTP"
          ? new SmtpMailer({ url: cfg.SMTP_URL!, from: cfg.EMAIL_FROM, requireTls: cfg.SMTP_REQUIRE_TLS })
          : cfg.EMAIL_DRIVER === "LOG"
              ? new LogMailer(log, devConsole)
              : new NoneMailer(),
  sms:
      cfg.SMS_DRIVER === "TERMII"
          ? new TermiiSms({ apiKey: cfg.TERMII_API_KEY!, senderId: cfg.TERMII_SENDER_ID!, baseUrl: cfg.TERMII_BASE_URL, channel: cfg.TERMII_CHANNEL })
          : cfg.SMS_DRIVER === "LOG"
              ? new LogSms(log, devConsole)
              : new NoneSms(),
  payments:
      cfg.PAYMENT_PROVIDER === "PAYSTACK" && cfg.PAYSTACK_SECRET_KEY
          ? new PaystackProvider(cfg.PAYSTACK_SECRET_KEY)
          : cfg.PAYMENT_PROVIDER === "TEST"
              ? new TestPaymentProvider(cfg.PUBLIC_WEB_URL, "unused-by-worker")
              : null,
  webUrl: cfg.PUBLIC_WEB_URL,
};

const controller = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info({ sig }, "stopping after current jobs");
    controller.abort();
  });
}

log.info({ scanner: deps.scanner.name, storage: deps.storage.driver, concurrency: cfg.WORKER_CONCURRENCY }, "PrintFlow worker started");
await runForever(deps, { workerId: cfg.WORKER_ID, pollMs: cfg.POLL_INTERVAL_MS, concurrency: cfg.WORKER_CONCURRENCY, scheduler: cfg.RUN_SCHEDULER, signal: controller.signal });
await deps.pool.end();
