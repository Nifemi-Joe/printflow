import { createHash } from "node:crypto";
import type { PrintSpec } from "./types.js";

/**
 * Deterministic fingerprint of what the student asked for, bound to the exact
 * document version. A confirmed order must match the quote's fingerprint; any
 * change to spec or document requires a fresh quote.
 */
export function printSpecHash(spec: PrintSpec, documentVersionSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(documentVersionSha256)) {
    throw new Error("documentVersionSha256 must be a lowercase hex SHA-256 digest");
  }
  const canonical = JSON.stringify([
    documentVersionSha256,
    spec.documentPageCount,
    (spec.pageRanges ?? "").replace(/\s+/g, ""),
    spec.copies,
    spec.paperSize,
    spec.colourMode,
    spec.sides,
    [...spec.finishingCodes].sort(),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
