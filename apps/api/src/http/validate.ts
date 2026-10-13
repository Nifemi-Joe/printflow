import { z } from "zod";
import { ApiError, Errors } from "./errors.js";

/** Parses untrusted input; throws a 400 with field-level details on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_FAILED", "some fields are invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

export const uuid = z.string().uuid();

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque cursor returned as nextCursor by the previous page. */
  cursor: z.string().max(200).optional(),
});

/** Keyset cursor over (created_at, id) — stable under concurrent inserts. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    if (Number.isNaN(Date.parse(createdAt)) || !uuid.safeParse(id).success) throw new Error("bad");
    return { createdAt, id };
  } catch {
    throw Errors.badRequest("invalid cursor");
  }
}

export function page<T extends { created_at: Date; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}
