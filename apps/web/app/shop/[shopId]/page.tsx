"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PowerControl, type Power } from "@/components/Power";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { relative, SPEC_LABEL } from "@/lib/format";
import { actionLabel, loadDrafts, saveDrafts, type Draft } from "@/lib/shop-actions";
import { useData } from "@/lib/use-data";

interface QueueItem {
  id: string;
  reference: string;
  status: string;
  version: number;
  position: number;
  totalSheets: number;
  studentName: string;
  pickupLocation: string;
  enqueuedAt: string;
  spec: { copies: number; paperSize: string; colourMode: string; sides: string; finishingCodes: string[] };
  actions: string[];
}
interface Queue {
  items: QueueItem[];
  readyForPickup: Array<{ id: string; reference: string; studentName: string; pickupLocation: string; statusChangedAt: string }>;
  summary: { jobs: number; sheets: number; estimatedMinutesToClear: number | null; activeDevices: number };
  power: Power | null;
}

export default function QueuePage() {
  const { shopId } = useParams<{ shopId: string }>();
  const { data, error, loading, reload } = useData<Queue>(`/shops/${shopId}/queue`, { pollMs: 5000 });
  const { me } = useSession();
  const canReportPower = Boolean(me?.shopMemberships.find((m) => m.shopId === shopId)?.permissions.includes("orders.produce"));
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [online, setOnline] = useState(true);
  const [syncReport, setSyncReport] = useState<Array<{ reference: string; outcome: string; message?: string }>>([]);
  const [actionError, setActionError] = useState<unknown>(null);
  const [collect, setCollect] = useState<{ id: string; reference: string } | null>(null);
  const [collectMsg, setCollectMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDrafts(loadDrafts(shopId));
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [shopId]);

  const sync = useCallback(async () => {
    const pending = loadDrafts(shopId);
    if (!pending.length) return;
    try {
      const r = await api<{ results: Array<{ clientActionId: string; outcome: string; error?: { message: string } }> }>(`/shops/${shopId}/sync`, {
        method: "POST",
        body: { actions: pending.map(({ reference: _r, ...a }) => a) },
      });
      setSyncReport(
        r.results.map((res) => ({
          reference: pending.find((p) => p.clientActionId === res.clientActionId)?.reference ?? "",
          outcome: res.outcome,
          message: res.error?.message,
        })),
      );
      // Only drop drafts the server has answered for; unanswered ones stay queued.
      const answered = new Set(r.results.map((x) => x.clientActionId));
      const left = pending.filter((p) => !answered.has(p.clientActionId));
      saveDrafts(shopId, left);
      setDrafts(left);
      await reload();
    } catch {
      /* still offline: keep drafts */
    }
  }, [shopId, reload]);

  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);

  async function act(item: QueueItem, to: string) {
    const meta = actionLabel(item.status, to);
    let reason: string | undefined;
    if (meta.needsReason) {
      const r = window.prompt(`${meta.label}: give a short reason the student will see`);
      if (!r || r.trim().length < 3) return;
      reason = r.trim();
    }
    setActionError(null);
    try {
      await api(`/shops/${shopId}/orders/${item.id}/transitions`, { method: "POST", body: { to, reason, expectedVersion: item.version } });
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "OFFLINE") {
        const d: Draft = { clientActionId: `draft-${crypto.randomUUID()}`, orderId: item.id, reference: item.reference, to, expectedVersion: item.version, reason, draftedAt: new Date().toISOString() };
        const next = [...loadDrafts(shopId), d];
        saveDrafts(shopId, next);
        setDrafts(next);
      } else {
        setActionError(e);
        await reload();
      }
    }
  }

  return (
    <>
      <PageHead title="Queue">
        {data && (
          <span className="muted">
            {data.summary.jobs} job{data.summary.jobs === 1 ? "" : "s"}, {data.summary.sheets} sheets
            {data.summary.estimatedMinutesToClear ? `, about ${data.summary.estimatedMinutesToClear} min to clear` : ""}
          </span>
        )}
      </PageHead>

      {data && online && <PowerControl shopId={shopId} power={data.power} onSaved={reload} canReport={canReportPower} />}

      {!online && (
        <div className="notice notice-warn" role="status">
          <p>You are offline. Actions you take are saved on this device as drafts and sent when you reconnect. They have not happened yet.</p>
        </div>
      )}
      {drafts.length > 0 && (
        <div className="sheet" role="status" style={{ marginBottom: "1.5rem" }}>
          <h3>Waiting to send ({drafts.length})</h3>
          {drafts.map((d) => (
            <div key={d.clientActionId} className="ticket-line">
              <span className="num">{d.reference}</span>
              <span>{actionLabel("", d.to).label}, not yet confirmed</span>
            </div>
          ))}
          <button className="btn btn-quiet btn-small" style={{ marginTop: "0.75rem" }} onClick={sync} disabled={!online}>
            Send now
          </button>
        </div>
      )}
      {syncReport.length > 0 && (
        <div className="notice" role="status">
          {syncReport.map((s, i) => (
            <p key={i}>
              {s.reference}: {s.outcome === "APPLIED" ? "confirmed by the server" : s.outcome === "CONFLICT" ? `not applied, the order changed in the meantime (${s.message})` : `not applied (${s.message})`}
            </p>
          ))}
          <button className="btn btn-quiet btn-small" onClick={() => setSyncReport([])}>
            Dismiss
          </button>
        </div>
      )}
      <ErrorNotice error={error ?? actionError} onRetry={reload} />

      {loading ? (
        <Skeleton lines={6} />
      ) : (
        <div className="grid-2" style={{ alignItems: "start" }}>
          <section aria-labelledby="work-title">
            <h2 id="work-title" style={{ fontSize: "var(--t-xl)" }}>
              To do
            </h2>
            {!data?.items.length ? (
              <Empty title="The queue is clear">New paid jobs appear here automatically.</Empty>
            ) : (
              <div className="stack">
                {data.items.map((q) => (
                  <article key={q.id} className="sheet" aria-label={`Job ${q.reference}`}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <Link href={`/shop/${shopId}/orders/${q.id}`}>
                        <strong className="num">
                          #{q.position} {q.reference}
                        </strong>
                      </Link>
                      <StatusPill status={q.status} />
                    </div>
                    <p style={{ margin: "0.5rem 0" }}>
                      {q.totalSheets} sheets: {q.spec.copies} × {q.spec.paperSize} {SPEC_LABEL[q.spec.colourMode]?.toLowerCase()}, {SPEC_LABEL[q.spec.sides]?.toLowerCase()}
                      {q.spec.finishingCodes.length > 0 && `, ${q.spec.finishingCodes.join(", ").toLowerCase().replace(/_/g, " ")}`}
                    </p>
                    <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                      {q.studentName}, collecting at {q.pickupLocation}. Paid {relative(q.enqueuedAt)}.
                    </p>
                    <div className="row">
                      {q.actions
                        .filter((a) => a !== "READY_FOR_PICKUP")
                        .map((a) => {
                          const m = actionLabel(q.status, a);
                          return (
                            <button key={a} className={`btn btn-small btn-${m.tone}`} onClick={() => act(q, a)}>
                              {m.label}
                            </button>
                          );
                        })}
                      {q.status === "QUALITY_CHECK" && (
                        <Link className="btn btn-small btn-primary" href={`/shop/${shopId}/orders/${q.id}#qa`}>
                          Check quality
                        </Link>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="ready-title">
            <h2 id="ready-title" style={{ fontSize: "var(--t-xl)" }}>
              Ready for pickup
            </h2>
            {collectMsg && (
              <div className={`notice ${collectMsg.ok ? "" : "notice-error"}`} role="alert">
                <p>{collectMsg.text}</p>
              </div>
            )}
            {!data?.readyForPickup.length ? (
              <Empty title="Nothing waiting">Finished jobs wait here until the student shows their code.</Empty>
            ) : (
              <div className="sheet">
                {data.readyForPickup.map((r) => (
                  <div key={r.id} style={{ padding: "0.75rem 0", borderBottom: "1px solid var(--rule)" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span>
                        <strong className="num">{r.reference}</strong> {r.studentName}
                      </span>
                      <button className="btn btn-primary btn-small" onClick={() => (setCollect(r), setCollectMsg(null))}>
                        Hand over
                      </button>
                    </div>
                    {collect?.id === r.id && (
                      <form
                        className="row"
                        style={{ marginTop: "0.75rem" }}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const code = String(new FormData(e.currentTarget).get("code")).replace(/\s/g, "");
                          try {
                            await api(`/shops/${shopId}/orders/${r.id}/collect`, { method: "POST", body: { code } });
                            setCollectMsg({ ok: true, text: `${r.reference} handed over to ${r.studentName}.` });
                            setCollect(null);
                            await reload();
                          } catch (err) {
                            setCollectMsg({ ok: false, text: err instanceof ApiError ? err.message : "Could not verify the code." });
                          }
                        }}
                      >
                        <label className="sr-only" htmlFor={`code-${r.id}`}>
                          Student&apos;s pickup code
                        </label>
                        <input id={`code-${r.id}`} name="code" inputMode="numeric" pattern="\d{3}\s?\d{3}" placeholder="6-digit code" autoComplete="off" required style={{ width: 160 }} autoFocus />
                        <button className="btn btn-primary btn-small" type="submit">
                          Verify and hand over
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
