"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { when } from "@/lib/format";
import { useData } from "@/lib/use-data";

export default function PrivacyRequests() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const { data, error, loading, reload } = useData<{ items: Array<{ id: string; kind: string; status: string; note: string | null; createdAt: string; userName: string; email: string }> }>(`${base}/privacy-requests`);
  const [actionError, setActionError] = useState<unknown>(null);
  const handle = async (id: string, status: string) => {
    const note = window.prompt(status === "REJECTED" ? "Why is this request being declined?" : "Note for the record (optional)") ?? undefined;
    setActionError(null);
    try {
      await api(`${base}/privacy-requests/${id}`, { method: "POST", body: { status, note: note || undefined } });
      await reload();
    } catch (e) {
      setActionError(e);
    }
  };
  return (
    <>
      <PageHead title="Privacy requests" />
      <p className="muted">Exports are prepared automatically. Erasure runs once you confirm it, and is refused automatically while the person has orders in progress. Payment records are kept without their name.</p>
      <ErrorNotice error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="No requests" />
      ) : (
        <div className="sheet">
          {data.items.map((p) => (
            <div key={p.id} className="ticket-line">
              <span>
                <strong>{p.kind === "EXPORT" ? "Data export" : "Erasure"}</strong> for {p.userName} <span className="muted">({p.email}), {when(p.createdAt)}</span>
                {p.note && <div className="muted">{p.note}</div>}
              </span>
              <span className="row">
                <StatusPill status={p.status === "COMPLETED" ? "SUCCEEDED" : p.status === "REJECTED" ? "FAILED" : "PENDING"} label={p.status.toLowerCase().replace("_", " ")} />
                {p.kind === "ERASURE" && ["RECEIVED", "IN_PROGRESS"].includes(p.status) && (
                  <>
                    <button className="btn btn-danger btn-small" onClick={() => window.confirm(`Erase ${p.userName}'s account? This cannot be undone.`) && handle(p.id, "COMPLETED")}>
                      Erase account
                    </button>
                    <button className="btn btn-quiet btn-small" onClick={() => handle(p.id, "REJECTED")}>
                      Decline
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
