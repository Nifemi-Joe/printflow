import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { devConsole } from "../infra/dev-console.js";
import { csrfTokenFor, safeEqual, sha256 } from "./crypto.js";
import { ApiExceptionFilter, Errors } from "./errors.js";

export const SESSION_COOKIE = "pf_session";

export interface AuthContext {
  userId: string;
  sessionId: string;
  sessionToken: string;
  via: "COOKIE" | "BEARER";
  mfaVerified: boolean;
  platformRole: "PLATFORM_ADMIN" | "PLATFORM_SUPPORT" | null;
  email: string;
  fullName: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface PfRequest extends Request {
  id: string;
  cookies: Record<string, string>;
  auth?: AuthContext;
  rawBody?: Buffer;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes that start a session or act without one. A browser may still hold an old
 * session cookie when it calls them (signed in in another tab, API restarted, an
 * MFA-pending session). These requests do not use that session, so a stale cookie
 * or CSRF token must not block signing in: the cookie is ignored instead.
 */
const SIGN_IN_ROUTES = new Set([
  "/v1/auth/register",
  "/v1/auth/login",
  "/v1/auth/otp/request",
  "/v1/auth/otp/verify",
  "/v1/auth/verify-email",
  "/v1/auth/password-reset/request",
  "/v1/auth/password-reset/confirm",
]);

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * Whether a browser Origin may make cookie-authenticated changes. Always: the
 * configured CORS_ORIGINS and the web app's own origin (PUBLIC_WEB_URL). Outside
 * production also any localhost or private-network address, so opening the web
 * app on 127.0.0.1, another port or the machine's LAN IP works while testing.
 */
export function originAllowed(cfg: AppConfig, origin: string): boolean {
  if (cfg.corsOrigins.includes(origin)) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin === new URL(cfg.PUBLIC_WEB_URL).origin || u.origin === new URL(cfg.PUBLIC_API_URL).origin) return true;
  return cfg.NODE_ENV !== "production" && (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOST.test(u.hostname);
}

function explainCsrf(cfg: AppConfig, log: Logger, req: Request, reason: string, hint: string) {
  log.warn({ path: req.path, origin: req.header("origin") ?? null, reason }, "csrf check failed");
  if (cfg.devConsole) {
    devConsole("request refused (CSRF_FAILED)", [
      { label: "Request", value: `${req.method} ${req.path}` },
      { label: "Origin", value: req.header("origin") ?? "(none)" },
      { label: "Why", value: reason },
      { label: "Fix", value: hint },
    ]);
  }
}

/** Request id, security headers, CORS allowlist and cookie parsing. */
export function baseMiddleware(cfg: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = req as PfRequest;
    const incoming = req.header("x-request-id");
    r.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", r.id);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Cache-Control", "no-store");
    if (cfg.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    const origin = req.header("origin");
    if (origin && originAllowed(cfg, origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token,Idempotency-Key,X-Request-Id,X-Filename,X-Title");
        res.setHeader("Access-Control-Max-Age", "600");
        res.status(204).end();
        return;
      }
    } else if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    r.cookies = parseCookies(req.header("cookie"));
    next();
  };
}

/**
 * Resolves the caller from the session cookie (web) or bearer token (mobile).
 * Cookie-authenticated unsafe requests must carry X-CSRF-Token and, when the
 * browser sends one, an allowed Origin.
 */
export function authMiddleware(cfg: AppConfig, pool: Pool, log: Logger) {
  const filter = new ApiExceptionFilter(log);
  return async (req: Request, res: Response, next: NextFunction) => {
    const r = req as PfRequest;
    try {
      const bearer = /^Bearer ([\w-]{20,200})$/.exec(req.header("authorization") ?? "")?.[1];
      const signIn = UNSAFE.has(req.method) && SIGN_IN_ROUTES.has(req.path);
      const origin = req.header("origin");

      // Sign-in routes have no session to protect, but a hostile page must not be able
      // to sign a visitor into someone else's account (login CSRF), so a browser Origin
      // must still be allowed. Native apps send no Origin.
      if (signIn && !bearer && origin && !originAllowed(cfg, origin)) {
        explainCsrf(cfg, log, req, `origin ${origin} is not allowed`, `add ${origin} to CORS_ORIGINS (comma-separated) and restart the API`);
        throw Errors.csrf();
      }
      // A leftover cookie is irrelevant to signing in; ignore it rather than refuse.
      const cookie = signIn ? undefined : r.cookies[SESSION_COOKIE];
      const token = bearer ?? cookie;
      if (!token) return next();
      const via = bearer ? "BEARER" : "COOKIE";

      const { rows } = await pool.query<{
        session_id: string;
        user_id: string;
        mfa_verified_at: Date | null;
        last_seen_at: Date;
        platform_role: AuthContext["platformRole"];
        email: string;
        full_name: string;
        email_verified_at: Date | null;
        phone_verified_at: Date | null;
      }>(
          `SELECT s.id AS session_id, s.user_id, s.mfa_verified_at, s.last_seen_at, u.platform_role, u.email, u.full_name, u.email_verified_at, u.phone_verified_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'ACTIVE'`,
          [sha256(token)],
      );
      const s = rows[0];
      if (!s) {
        // Unknown/expired token: treat as anonymous; clear a stale cookie.
        if (via === "COOKIE") res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cfg.cookieSecure ? "; Secure" : ""}`);
        return next();
      }

      if (via === "COOKIE" && UNSAFE.has(req.method) && !req.path.startsWith("/v1/webhooks/")) {
        if (origin && !originAllowed(cfg, origin)) {
          explainCsrf(cfg, log, req, `origin ${origin} is not allowed`, `add ${origin} to CORS_ORIGINS (comma-separated) and restart the API`);
          throw Errors.csrf();
        }
        const sent = req.header("x-csrf-token") ?? "";
        if (!safeEqual(sent, csrfTokenFor(cfg.SESSION_SECRET, token))) {
          explainCsrf(
              cfg,
              log,
              req,
              sent ? "X-CSRF-Token does not match this session (the page has an old token)" : "no X-CSRF-Token header was sent",
              "the web app now refreshes the token and retries once; reload the page if it persists",
          );
          throw Errors.csrf();
        }
      }

      r.auth = {
        userId: s.user_id,
        sessionId: s.session_id,
        sessionToken: token,
        via,
        mfaVerified: s.mfa_verified_at !== null,
        platformRole: s.platform_role,
        email: s.email,
        fullName: s.full_name,
        emailVerified: s.email_verified_at !== null,
        phoneVerified: s.phone_verified_at !== null,
      };
      if (Date.now() - s.last_seen_at.getTime() > 5 * 60_000) {
        pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [s.session_id]).catch(() => undefined);
      }
      next();
    } catch (e) {
      filter.catch(e, { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as never);
    }
  };
}
