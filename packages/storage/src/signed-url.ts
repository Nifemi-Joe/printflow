import { createHmac, timingSafeEqual } from "node:crypto";
import { assertSafeKey } from "./keys.js";

/**
 * Stateless, short-lived download grant for the local storage driver: the API
 * serves /v1/files/<token> and only streams the single object the token names.
 */
export interface DownloadGrant {
  /** object key */
  k: string;
  /** expiry, unix seconds */
  e: number;
  /** download filename (sanitised) */
  f: string;
  /** content type */
  c: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signGrant(secret: string, grant: DownloadGrant): string {
  assertSafeKey(grant.k);
  const payload = b64(JSON.stringify(grant));
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export type GrantVerdict = { ok: true; grant: DownloadGrant } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export function verifyGrant(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): GrantVerdict {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 2048) return { ok: false, reason: "MALFORMED" };
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const given = Buffer.from(parts[1], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "BAD_SIGNATURE" };
  let grant: DownloadGrant;
  try {
    grant = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as DownloadGrant;
    assertSafeKey(grant.k);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (!Number.isInteger(grant.e) || grant.e < nowSeconds) return { ok: false, reason: "EXPIRED" };
  return { ok: true, grant };
}

/** Makes a filename safe for Content-Disposition (ASCII, no quotes, no path). */
export function safeDownloadName(name: string, fallback = "document.pdf"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}
