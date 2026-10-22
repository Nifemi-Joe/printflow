import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { ConflictError, NotFoundError, RuleViolationError } from "../../../../packages/data/src/index.js";
import { DocumentRejectedError } from "../../../../packages/documents/src/index.js";
import { PageRangeError, QuoteError, RateCardError } from "../../../../packages/pricing/src/index.js";

/** Errors with a stable machine-readable code and an HTTP status. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", message, details),
  unauthenticated: () => new ApiError(401, "UNAUTHENTICATED", "sign in to continue"),
  forbidden: (message = "you do not have permission to do this") => new ApiError(403, "FORBIDDEN", message),
  mfaRequired: () => new ApiError(403, "MFA_REQUIRED", "verify with your authenticator app to continue"),
  csrf: () => new ApiError(403, "CSRF_FAILED", "request could not be verified; reload and try again"),
  notFound: (what = "resource") => new ApiError(404, "NOT_FOUND", `${what} not found`),
  conflict: (message: string, code = "CONFLICT") => new ApiError(409, code, message),
  gone: (message: string, code = "GONE") => new ApiError(410, code, message),
  tooLarge: (message: string) => new ApiError(413, "PAYLOAD_TOO_LARGE", message),
  unsupported: (message: string) => new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", message),
  rule: (message: string, code: string) => new ApiError(422, code, message),
  rateLimited: (retryAfter: number) => new ApiError(429, "RATE_LIMITED", "too many requests; try again shortly", { retryAfterSeconds: retryAfter }),
  unavailable: (message: string, code = "UNAVAILABLE") => new ApiError(503, code, message),
};

interface PgError {
  code?: string;
  message: string;
  constraint?: string;
}

/** Maps every error to { error: { code, message, details?, requestId } } without leaking internals. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ZodError) {
    return new ApiError(400, "VALIDATION_FAILED", "some fields are invalid", e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (e instanceof NotFoundError) return Errors.notFound(e.message.replace(/ not found$/, ""));
  if (e instanceof ConflictError) return Errors.conflict(e.message, "STALE_VERSION");
  if (e instanceof RuleViolationError) return Errors.rule(e.message, e.code);
  if (e instanceof QuoteError || e instanceof PageRangeError) return Errors.rule(e.message, "INVALID_PRINT_SPEC");
  if (e instanceof RateCardError) return Errors.rule(e.message, "PRICING_NOT_AVAILABLE");
  if (e instanceof DocumentRejectedError) return Errors.rule(e.message, e.code);
  if (e instanceof HttpException) {
    const status = e.getStatus();
    return new ApiError(status, status === 404 ? "NOT_FOUND" : "HTTP_ERROR", status === 404 ? "route not found" : e.message);
  }
  const pg = e as PgError;
  if (typeof pg?.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) {
    const msg = pg.message.replace(/^pf: /, "");
    switch (pg.code) {
      case "P0002":
        return Errors.gone(msg, "QUOTE_EXPIRED");
      case "P0001":
      case "P0003":
      case "P0004":
        return Errors.conflict(msg, "RULE_CONFLICT");
      case "P0005":
      case "P0006":
        return Errors.rule(msg, "FINANCIAL_RULE");
      case "P0007":
        return Errors.rule("wallets are for student accounts", "NO_WALLET");
      case "P0008":
        return Errors.rule(msg, "NOT_PAYABLE");
      case "P0009":
        return Errors.rule("your wallet balance is not enough, or this would take it over its limit", "INSUFFICIENT_BALANCE");
      case "P0010":
        return Errors.conflict(msg, "STUDENT_PROVIDERS_OFF");
      case "P0011":
        return Errors.conflict(msg, "UNDERTAKING_REQUIRED");
      case "P0012":
        return Errors.rule(msg, "PROVIDER_NOT_VERIFIED");
      case "P0013":
        return Errors.rule(msg, "PROVIDER_ORDER_CAP");
      case "23505":
        return Errors.conflict("this already exists", "DUPLICATE");
      case "23503":
        return Errors.rule("a referenced item does not exist or belongs to someone else", "INVALID_REFERENCE");
      case "23514":
        return Errors.rule("a value is outside the allowed range", "CONSTRAINT_VIOLATION");
      case "22P02":
        return Errors.badRequest("malformed identifier");
    }
  }
  return new ApiError(500, "INTERNAL", "something went wrong; the team has been notified");
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const err = toApiError(exception);
    if (err.status >= 500) {
      this.log.error({ err: exception, requestId: req.id, path: req.path }, "unhandled error");
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err.code === "RATE_LIMITED") {
      const d = err.details as { retryAfterSeconds: number };
      res.setHeader("Retry-After", String(d.retryAfterSeconds));
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}), requestId: req.id } });
  }
}
