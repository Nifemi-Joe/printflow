/**
 * Shop power, as reported by shop staff. Power cuts decide whether a Nigerian
 * print shop can work at all, so students see this next to every shop.
 * It is never sensed automatically and the UI always says who reported it, when.
 */

export const POWER_STATUSES = ["UNKNOWN", "GRID", "GENERATOR", "OUTAGE"] as const;
export type PowerStatus = (typeof POWER_STATUSES)[number];

export const POWER_LABELS: Record<PowerStatus, string> = {
  UNKNOWN: "Power not reported",
  GRID: "Light on",
  GENERATOR: "Generator on",
  OUTAGE: "Light out",
};

/** A report older than this is shown as possibly out of date. */
export const POWER_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** An expected return time can be at most this far ahead. */
export const POWER_BACK_AT_MAX_AHEAD_MS = 48 * 60 * 60 * 1000;

export interface PowerReport {
  status: PowerStatus;
  backAt: Date | null;
  note: string | null;
  updatedAt: Date | null;
}

export interface PowerView {
  status: PowerStatus;
  label: string;
  /** Can the shop print right now, as far as anyone has said? */
  canPrint: boolean | null;
  backAt: string | null;
  /** The expected return time has passed without an update. */
  overdue: boolean;
  note: string | null;
  updatedAt: string | null;
  stale: boolean;
}

export function describePower(r: PowerReport, now = new Date()): PowerView {
  const stale = r.updatedAt === null || now.getTime() - r.updatedAt.getTime() > POWER_STALE_AFTER_MS;
  return {
    status: r.status,
    label: POWER_LABELS[r.status],
    canPrint: r.status === "UNKNOWN" ? null : r.status !== "OUTAGE",
    backAt: r.status === "OUTAGE" && r.backAt ? r.backAt.toISOString() : null,
    overdue: r.status === "OUTAGE" && r.backAt !== null && r.backAt.getTime() < now.getTime(),
    note: r.note,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    stale,
  };
}

/** Validates an expected return time for an outage. */
export function validateBackAt(backAt: Date, now = new Date()): void {
  if (Number.isNaN(backAt.getTime())) throw new RangeError("invalid time");
  if (backAt.getTime() <= now.getTime()) throw new RangeError("the expected return time must be in the future");
  if (backAt.getTime() - now.getTime() > POWER_BACK_AT_MAX_AHEAD_MS) throw new RangeError("the expected return time must be within 48 hours");
}
