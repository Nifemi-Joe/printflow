import pino, { type Logger } from "pino";

/**
 * Structured JSON logs. Anything that could carry a credential, a pickup code
 * or document content is redacted before it is written.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-csrf-token']",
  "req.headers['x-paystack-signature']",
  "*.password",
  "*.newPassword",
  "*.token",
  "*.code",
  "*.secret",
  "*.sessionToken",
  "*.pickupCode",
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "printflow-api" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
