"use client";

import { useState } from "react";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { clock, relative } from "@/lib/format";

export interface Power {
  status: "UNKNOWN" | "GRID" | "GENERATOR" | "OUTAGE";
  label: string;
  canPrint: boolean | null;
  backAt: string | null;
  overdue: boolean;
  note: string | null;
  updatedAt: string | null;
  stale: boolean;
  updatedBy?: string | null;
}

const PILL: Record<Power["status"], string> = { GRID: "pill-go", GENERATOR: "pill-go", OUTAGE: "pill-bad", UNKNOWN: "" };

/** One line a student can read at a glance: "Light out · back about 2:00 pm". */
export function powerSummary(p: Power): string {
  if (p.status === "OUTAGE") {
    if (p.backAt && !p.overdue) return `Light out, back about ${clock(p.backAt)}`;
    if (p.backAt && p.overdue) return `Light out (expected back ${clock(p.backAt)}, no update since)`;
    return "Light out";
  }
  return p.label;
}

export function PowerBadge({ power, showWho }: { power: Power | null | undefined; showWho?: boolean }) {
  if (!power || power.status === "UNKNOWN") return null;
  return (
    <span className="power-badge">
      <span className={`pill ${PILL[power.status]}`}>{powerSummary(power)}</span>
      {power.note && <span className="muted"> {power.note}</span>}
      {power.updatedAt && (
        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
          {" "}
          {power.stale ? "Reported " : "Updated "}
          {relative(power.updatedAt)}
          {showWho && power.updatedBy ? ` by ${power.updatedBy}` : ""}
          {power.stale ? ", may be out of date" : ""}
        </span>
      )}
    </span>
  );
}

const QUICK_BACK = [
  { label: "In 1 hour", hours: 1 },
  { label: "In 2 hours", hours: 2 },
  { label: "In 4 hours", hours: 4 },
];

/** Shop staff report the shop's power. Students see this next to the shop. */
export function PowerControl({ shopId, power, onSaved, canReport }: { shopId: string; power: Power | null | undefined; onSaved: () => unknown; canReport: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [askBack, setAskBack] = useState(false);
  const [note, setNote] = useState("");
  const [backTime, setBackTime] = useState("");

  const save = async (status: Power["status"], backAt?: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/shops/${shopId}/power`, { method: "PUT", body: { status, ...(backAt ? { backAt } : {}), ...(note.trim() ? { note: note.trim() } : {}) } });
      setAskBack(false);
      setNote("");
      setBackTime("");
      await onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const atTime = () => {
    // "14:00" today (or tomorrow if already past), Lagos time = UTC+1.
    const [h, m] = backTime.split(":").map(Number);
    const now = new Date();
    const lagosNow = new Date(now.getTime() + 60 * 60_000);
    const t = new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), lagosNow.getUTCDate(), (h ?? 0) - 1, m ?? 0));
    if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString();
  };

  return (
    <section className="sheet" aria-labelledby="power-title">
      <h2 id="power-title" style={{ fontSize: "var(--t-xl)" }}>
        Power
      </h2>
      <p>
        <PowerBadge power={power} showWho />
        {(!power || power.status === "UNKNOWN") && <span className="muted">Not reported yet. Students see what you set here.</span>}
      </p>
      <ErrorNotice error={error} />
      {canReport && (
        <>
          <div className="field">
            <label htmlFor="power-note">Note for students (optional)</label>
            <input id="power-note" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Diesel until 6pm" />
          </div>
          <div className="row">
            <button className="btn btn-quiet" disabled={busy} aria-pressed={power?.status === "GRID"} onClick={() => void save("GRID")}>
              Light on
            </button>
            <button className="btn btn-quiet" disabled={busy} aria-pressed={power?.status === "GENERATOR"} onClick={() => void save("GENERATOR")}>
              Generator on
            </button>
            <button className="btn btn-danger" disabled={busy} aria-pressed={power?.status === "OUTAGE"} onClick={() => setAskBack(true)}>
              Light out
            </button>
          </div>
          {askBack && (
            <div style={{ marginTop: "var(--space-4)" }}>
              <p>
                <strong>When do you expect power back?</strong>
              </p>
              <div className="row">
                {QUICK_BACK.map((q) => (
                  <button key={q.hours} className="btn btn-quiet btn-small" disabled={busy} onClick={() => void save("OUTAGE", new Date(Date.now() + q.hours * 3600_000).toISOString())}>
                    {q.label}
                  </button>
                ))}
                <button className="btn btn-quiet btn-small" disabled={busy} onClick={() => void save("OUTAGE", null)}>
                  Not sure
                </button>
              </div>
              <form
                className="row"
                style={{ marginTop: "var(--space-3)", alignItems: "flex-end" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (backTime) void save("OUTAGE", atTime());
                }}
              >
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="power-back">Back at</label>
                  <input id="power-back" type="time" value={backTime} onChange={(e) => setBackTime(e.target.value)} />
                </div>
                <button className="btn btn-danger btn-small" type="submit" disabled={busy || !backTime}>
                  Set light out
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </section>
  );
}
