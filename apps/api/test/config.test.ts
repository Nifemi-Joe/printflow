import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { checkoutMode, loadConfig } from "../src/config.js";
import { originAllowed } from "../src/http/context.js";

const key = Buffer.alloc(32, 7).toString("base64");
const productionApi = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@db:5432/printflow",
  SESSION_SECRET: "s".repeat(40),
  PICKUP_CODE_PEPPER: "p".repeat(40),
  MFA_ENCRYPTION_KEY: key,
  STORAGE_DRIVER: "S3",
  S3_BUCKET: "printflow",
  S3_REGION: "eu-west-1",
  EMAIL_DRIVER: "SMTP",
  SMTP_URL: "smtps://user:pass@smtp.example:465",
  SMS_DRIVER: "TERMII",
  TERMII_API_KEY: "TLkey",
  TERMII_SENDER_ID: "PrintFlow",
  PAYMENT_PROVIDER: "PAYSTACK",
  PAYSTACK_SECRET_KEY: "sk_live_x",
  PAYMENTS_LIVE_ENABLED: "true",
};

describe("API configuration", () => {
  it("accepts a complete production configuration", () => {
    const c = loadConfig(productionApi);
    expect(c.cookieSecure).toBe(true);
    expect(checkoutMode(c)).toBe("LIVE");
  });

  it.each([
    [{ PAYMENT_PROVIDER: "TEST", PAYMENTS_LIVE_ENABLED: "false" }, "PAYMENT_PROVIDER"],
    [{ EMAIL_DRIVER: "LOG" }, "EMAIL_DRIVER"],
    [{ EMAIL_DRIVER: "CAPTURE" }, "EMAIL_DRIVER"],
    [{ SMTP_REQUIRE_TLS: "false" }, "SMTP_REQUIRE_TLS"],
    [{ SMTP_URL: undefined }, "SMTP_URL"],
    [{ RATE_LIMIT_SCALE: "20" }, "RATE_LIMIT_SCALE"],
    [{ REQUIRE_STAFF_MFA: "false" }, "REQUIRE_STAFF_MFA"],
    [{ COOKIE_SECURE: "false" }, "COOKIE_SECURE"],
    [{ SESSION_SECRET: "short" }, "SESSION_SECRET"],
    [{ MFA_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }, "MFA_ENCRYPTION_KEY"],
    [{ PAYSTACK_SECRET_KEY: undefined }, "PAYMENTS_LIVE_ENABLED"],
    [{ SMS_DRIVER: "LOG" }, "SMS_DRIVER"],
    [{ SMS_DRIVER: "CAPTURE" }, "SMS_DRIVER"],
    [{ TERMII_API_KEY: undefined }, "TERMII_API_KEY"],
    [{ PAYMENT_METHODS: "CARD,CASH" }, "PAYMENT_METHODS"],
    [{ PAYMENT_METHODS: "" }, "PAYMENT_METHODS"],
    [{ DEV_CONSOLE: "true" }, "DEV_CONSOLE"],
  ])("refuses unsafe production setting %o", (patch, field) => {
    expect(() => loadConfig({ ...productionApi, ...patch } as NodeJS.ProcessEnv)).toThrow(new RegExp(field));
  });

  it("allows switching SMS off, and choosing payment methods", () => {
    expect(loadConfig({ ...productionApi, SMS_DRIVER: "NONE" }).SMS_DRIVER).toBe("NONE");
    expect(loadConfig({ ...productionApi, PAYMENT_METHODS: " bank_transfer, ussd " }).PAYMENT_METHODS).toEqual(["BANK_TRANSFER", "USSD"]);
    expect(loadConfig(productionApi).PAYMENT_METHODS).toEqual(["CARD", "BANK_TRANSFER", "USSD"]);
  });

  it("keeps checkout disabled until live payments are switched on", () => {
    expect(checkoutMode(loadConfig({ ...productionApi, PAYMENTS_LIVE_ENABLED: "false" }))).toBe("DISABLED");
    expect(checkoutMode(loadConfig({ ...productionApi, PAYMENT_PROVIDER: "NONE", PAYMENTS_LIVE_ENABLED: "false" }))).toBe("DISABLED");
  });

  it("prints codes and links to the terminal in development and test, never in production", () => {
    const dev = { ...productionApi, NODE_ENV: "development" };
    expect(loadConfig(dev).devConsole).toBe(true);
    expect(loadConfig({ ...dev, NODE_ENV: "test" }).devConsole).toBe(true);
    expect(loadConfig({ ...dev, DEV_CONSOLE: "false" }).devConsole).toBe(false);
    expect(loadConfig(productionApi).devConsole).toBe(false);
    expect(loadConfig({ ...productionApi, DEV_CONSOLE: "false" }).devConsole).toBe(false);
  });

  it("allows local browser origins outside production only", () => {
    const prod = loadConfig({ ...productionApi, CORS_ORIGINS: "https://printflow.ng", PUBLIC_WEB_URL: "https://printflow.ng", PUBLIC_API_URL: "https://printflow.ng/api" });
    const dev = loadConfig({ ...productionApi, NODE_ENV: "development", CORS_ORIGINS: "http://localhost:3000" });
    expect(originAllowed(prod, "https://printflow.ng")).toBe(true);
    for (const o of ["http://localhost:3000", "http://192.168.1.20:3000", "https://evil.example", "null"]) expect(originAllowed(prod, o), o).toBe(false);
    for (const o of ["http://localhost:3001", "http://127.0.0.1:3000", "http://10.0.0.4:8081", "http://172.20.1.1:3000", "http://192.168.1.20:3000"]) expect(originAllowed(dev, o), o).toBe(true);
    for (const o of ["https://evil.example", "http://192.168.evil.com", "http://172.32.0.1", "null", "file://"]) expect(originAllowed(dev, o), o).toBe(false);
  });

  it("requires a signing secret for local file storage", () => {
    expect(() => loadConfig({ ...productionApi, STORAGE_DRIVER: "LOCAL" })).toThrow(/STORAGE_SIGNING_SECRET/);
  });
});

describe("worker configuration", () => {
  const productionWorker = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@db:5432/printflow",
    STORAGE_DRIVER: "S3",
    SCANNER: "CLAMAV",
    EMAIL_DRIVER: "SMTP",
    SMTP_URL: "smtp://user:pass@smtp.example:587",
    SMS_DRIVER: "TERMII",
    TERMII_API_KEY: "TLkey",
    TERMII_SENDER_ID: "PrintFlow",
    PAYMENT_PROVIDER: "PAYSTACK",
    PAYSTACK_SECRET_KEY: "sk_live_x",
  };

  it("accepts a complete production configuration", () => {
    expect(loadWorkerConfig(productionWorker).SCANNER).toBe("CLAMAV");
  });

  it.each([
    [{ SCANNER: "NONE" }, "SCANNER"],
    [{ PAYMENT_PROVIDER: "TEST" }, "PAYMENT_PROVIDER"],
    [{ EMAIL_DRIVER: "LOG" }, "EMAIL_DRIVER"],
    [{ SMTP_REQUIRE_TLS: "0" }, "SMTP_REQUIRE_TLS"],
    [{ SMS_DRIVER: "LOG" }, "SMS_DRIVER"],
    [{ DEV_CONSOLE: "true" }, "DEV_CONSOLE"],
  ])("refuses unsafe production setting %o", (patch, field) => {
    expect(() => loadWorkerConfig({ ...productionWorker, ...patch })).toThrow(new RegExp(field));
  });
});
