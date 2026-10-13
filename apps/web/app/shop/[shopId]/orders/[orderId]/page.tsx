"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api, toBrowserUrl } from "@/lib/api";
import { naira, SPEC_LABEL, STATUS_LABEL, when } from "@/lib/format";
import { actionLabel } from "@/lib/shop-actions";
import { useData } from "@/lib/use-data";

interface Job {
  id: string;
  reference: string;
  status: string;
  version: number;
  shopRevenueKobo: string;
  totalSheets: number;
  pageCount: number;
  documentPageSize: string | null;
  documentTitle: string;
  documentVersion: number;
  printSha256: string;
  studentName: string;
  pickupLocation: string;
  spec: { copies: number; paperSize: string; colourMode: string; sides: string; pageRanges?: string; finishingCodes: string[]; selectedPages: number[] };
  actions: string[];
  canDownload: boolean;
  events: Array<{ to: string; reason: string | null; actorName: string | null; device: string | null; at: string }>;
  qualityChecks: Array<{ result: string; issues: string[]; sheetsCounted: number | null; notes: string | null; checkedBy: string; checkedAt: string }>;
}

const ISSUES = [
  ["PAGE_COUNT_MISMATCH", "Wrong number of sheets"],
  ["MISSING_PAGES", "Missing pages"],
  ["WRONG_PAPER_SIZE", "Wrong paper size"],
  ["WRONG_COLOUR_MODE", "Wrong colour"],
  ["WRONG_SIDES", "Wrong sides"],
  ["PRINT_DEFECT", "Smudges, streaks or faint print"],
  ["FINISHING_DEFECT", "Binding or stapling problem"],
  ["OTHER", "Something else"],
] as const;

export default function JobPage() {
  const { shopId, orderId } = useParams<{ shopId: string; orderId: string }>();
  const { data: j, error, loading, reload } = useData<Job>(`/shops/${shopId}/orders/${orderId}`, { pollMs: 10_000 });
  const devices = useData<{ items: Array<{ id: string; label: string; reportedStatus: string }> }>(`/shops/${shopId}/devices`);
  const [device, setDevice] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton lines={8} />;
  if (!j) return <ErrorNotice error={error} onRetry={reload} />;

  return (
    <>
      <PageHead title={j.reference}>
        <StatusPill status={j.status} />
      </PageHead>
      <ErrorNotice error={actionError} />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div>
          <div className="ticket">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Job ticket</h2>
            <div className="ticket-line">
              <span>Document</span>
              <span>
                {j.documentTitle} (v{j.documentVersion}, {j.pageCount} pages{j.documentPageSize ? `, ${j.documentPageSize}` : ""})
              </span>
            </div>
            <div className="ticket-line">
              <span>Pages</span>
              <span>{j.spec.pageRanges || "All"}</span>
            </div>
            <div className="ticket-line">
              <span>Copies</span>
              <span className="num">{j.spec.copies}</span>
            </div>
            <div className="ticket-line">
              <span>Paper</span>
              <span>
                {j.spec.paperSize}, {SPEC_LABEL[j.spec.colourMode]}, {SPEC_LABEL[j.spec.sides]}
              </span>
            </div>
            <div className="ticket-line">
              <span>Finishing</span>
              <span>{j.spec.finishingCodes.length ? j.spec.finishingCodes.join(", ").toLowerCase().replace(/_/g, " ") : "None"}</span>
            </div>
            <div className="ticket-line">
              <span>For</span>
              <span>
                {j.studentName}, at {j.pickupLocation}
              </span>
            </div>
            <div className="ticket-total">
              <span>{j.totalSheets} sheets</span>
              <span className="num">{naira(j.shopRevenueKobo)}</span>
            </div>
            <p className="muted" style={{ fontSize: "var(--t-xs)", wordBreak: "break-all", marginTop: "0.75rem" }}>
              File fingerprint (SHA-256): {j.printSha256}
            </p>
          </div>

          {j.canDownload && (
            <p style={{ marginTop: "1.5rem" }}>
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await api<{ url: string }>(`/shops/${shopId}/orders/${orderId}/document-link`, { method: "POST" });
                    window.location.assign(toBrowserUrl(r.url));
                  })
                }
              >
                Download print file
              </button>{" "}
              <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                Links last two minutes. Downloads are logged.
              </span>
            </p>
          )}
        </div>

        <div>
          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Actions</h2>
            {(j.actions.includes("PRINTING") || j.status === "PRINTING") && devices.data && devices.data.items.length > 0 && (
              <div className="field">
                <label htmlFor="device">Printer</label>
                <select id="device" value={device} onChange={(e) => setDevice(e.target.value)}>
                  <option value="">Not recorded</option>
                  {devices.data.items.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label} ({d.reportedStatus.toLowerCase().replace(/_/g, " ")})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="row">
              {j.actions
                .filter((a) => a !== "READY_FOR_PICKUP")
                .map((to) => {
                  const m = actionLabel(j.status, to);
                  return (
                    <button
                      key={to}
                      className={`btn btn-${m.tone}`}
                      disabled={busy}
                      onClick={() => {
                        let reason: string | undefined;
                        if (m.needsReason) {
                          const r = window.prompt(`${m.label}: give a short reason the student will see`);
                          if (!r || r.trim().length < 3) return;
                          reason = r.trim();
                        }
                        void run(() => api(`/shops/${shopId}/orders/${orderId}/transitions`, { method: "POST", body: { to, reason, expectedVersion: j.version, deviceId: device || undefined } }));
                      }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              {j.actions.length === 0 && <p className="muted">Nothing to do on this job right now.</p>}
            </div>
          </div>

          {j.status === "QUALITY_CHECK" && (
            <form
              id="qa"
              className="sheet"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const issues = f.getAll("issues").map(String);
                const counted = f.get("sheets") ? Number(f.get("sheets")) : undefined;
                void run(() =>
                  api(`/shops/${shopId}/orders/${orderId}/quality-checks`, {
                    method: "POST",
                    body: { result: issues.length ? "FAIL" : "PASS", issues, sheetsCounted: counted, notes: String(f.get("notes") || "") || undefined, expectedVersion: j.version },
                  }),
                );
              }}
            >
              <h2 style={{ fontSize: "var(--t-xl)" }}>Quality check</h2>
              <div className="field">
                <label htmlFor="sheets">Sheets counted</label>
                <input id="sheets" name="sheets" type="number" min={0} placeholder={String(j.totalSheets)} />
                <span className="hint">Expected {j.totalSheets}. A different count is recorded as a mismatch and the job goes back for reprinting.</span>
              </div>
              <fieldset>
                <legend>Problems found (leave empty if the job is right)</legend>
                {ISSUES.map(([code, label]) => (
                  <label key={code} className="row" style={{ marginBottom: "0.4rem" }}>
                    <input type="checkbox" name="issues" value={code} /> {label}
                  </label>
                ))}
              </fieldset>
              <div className="field">
                <label htmlFor="notes">Notes</label>
                <textarea id="notes" name="notes" maxLength={1000} />
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                Record check
              </button>
            </form>
          )}

          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>History</h2>
            <ol className="timeline">
              {j.events.map((e, i) => (
                <li key={i}>
                  <strong>{STATUS_LABEL[e.to] ?? e.to}</strong> <span className="muted">{when(e.at)}</span>
                  <div className="muted">
                    {e.actorName ?? "PrintFlow"}
                    {e.device ? ` on ${e.device}` : ""}
                    {e.reason ? `: ${e.reason}` : ""}
                  </div>
                </li>
              ))}
            </ol>
            {j.qualityChecks.map((q, i) => (
              <p key={i} className="muted">
                Quality check by {q.checkedBy}: <StatusPill status={q.result === "PASS" ? "SUCCEEDED" : "FAILED"} label={q.result === "PASS" ? "passed" : "failed"} /> {q.issues.join(", ").toLowerCase().replace(/_/g, " ")} {q.notes}
              </p>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
