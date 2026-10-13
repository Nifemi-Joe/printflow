"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Dispute {
  id: string;
  reference: string;
  category: string;
  description: string;
  status: string;
  resolutionNote: string | null;
  openedAt: string;
  openedBy: string;
  shopName: string;
  orderTotalKobo: string;
}

const CATEGORY: Record<string, string> = { QUALITY: "Print quality", NOT_RECEIVED: "Not received", WRONG_SPEC: "Wrong specification", OVERCHARGED: "Charged incorrectly", OTHER: "Other" };

export default function Disputes() {
  const { universityId } = useParams<{ universityId: string }>();
  const { data, error, loading, reload } = useData<{ items: Dispute[] }>(`/admin/universities/${universityId}/disputes`);
  const [actionError, setActionError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHead title="Disputes" />
      <ErrorNotice error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="No disputes">When a student reports a problem with an order, it appears here.</Empty>
      ) : (
        <div className="stack">
          {data.items.map((d) => {
            const active = ["OPEN", "UNDER_REVIEW"].includes(d.status);
            return (
              <div key={d.id} className="sheet">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>
                    {CATEGORY[d.category]}: <span className="num">{d.reference}</span>
                  </strong>
                  <StatusPill status={active ? "PENDING" : "SUCCEEDED"} label={d.status.toLowerCase().replace(/_/g, " ")} />
                </div>
                <p className="muted">
                  {d.openedBy} at {d.shopName}, {when(d.openedAt)}. Order total {naira(d.orderTotalKobo)}.
                </p>
                <p>{d.description}</p>
                {d.resolutionNote && <p className="muted">Resolution: {d.resolutionNote}</p>}
                {active && (
                  <>
                    <button className="btn btn-quiet btn-small" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}>
                      Respond
                    </button>
                    {open === d.id && (
                      <form
                        style={{ marginTop: "1rem" }}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          const status = String(f.get("status"));
                          setActionError(null);
                          try {
                            await api(`/admin/universities/${universityId}/disputes/${d.id}/resolve`, {
                              method: "POST",
                              body: { status, note: f.get("note"), ...(status === "RESOLVED_REFUND" ? { refundKobo: Math.round(Number(f.get("amount")) * 100) } : {}) },
                            });
                            setOpen(null);
                            await reload();
                          } catch (err) {
                            setActionError(err);
                          }
                        }}
                      >
                        <div className="field">
                          <label htmlFor={`st-${d.id}`}>Outcome</label>
                          <select id={`st-${d.id}`} name="status">
                            <option value="UNDER_REVIEW">Still reviewing</option>
                            <option value="RESOLVED_REFUND">Refund the student</option>
                            <option value="RESOLVED_REPRINT">Shop reprints the job</option>
                            <option value="RESOLVED_NO_ACTION">No action needed</option>
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor={`amt-${d.id}`}>Refund amount (₦), if refunding</label>
                          <input id={`amt-${d.id}`} name="amount" inputMode="decimal" pattern="\d+(\.\d{1,2})?" />
                        </div>
                        <div className="field">
                          <label htmlFor={`note-${d.id}`}>Note to the student</label>
                          <textarea id={`note-${d.id}`} name="note" required minLength={3} />
                        </div>
                        <button className="btn btn-primary" type="submit">
                          Save outcome
                        </button>
                      </form>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
