"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Shop {
  id: string;
  name: string;
  status: string;
  acceptingOrders: boolean;
  campus: string;
  owner: string | null;
  queueLength: number;
  createdAt: string;
}

const ACTIONS: Record<string, Array<{ action: string; label: string; tone: string }>> = {
  PENDING_APPROVAL: [
    { action: "approve", label: "Approve", tone: "primary" },
    { action: "remove", label: "Decline", tone: "danger" },
  ],
  APPROVED: [
    { action: "suspend", label: "Suspend", tone: "danger" },
    { action: "remove", label: "Remove", tone: "danger" },
  ],
  SUSPENDED: [
    { action: "reinstate", label: "Reinstate", tone: "primary" },
    { action: "remove", label: "Remove", tone: "danger" },
  ],
};

export default function AdminShops() {
  const { universityId } = useParams<{ universityId: string }>();
  const { data, error, loading, reload } = useData<{ items: Shop[] }>(`/admin/universities/${universityId}/shops`);
  const [actionError, setActionError] = useState<unknown>(null);

  return (
    <>
      <PageHead title="Shops" />
      <ErrorNotice error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="No shops yet">Print shops apply from the PrintFlow website. Their applications appear here for approval.</Empty>
      ) : (
        <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Shop</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">In queue</th>
                <th scope="col">Applied</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    <div className="muted">
                      {s.campus}
                      {s.owner ? `, owner ${s.owner}` : ""}
                    </div>
                  </td>
                  <td>
                    <StatusPill status={s.status} label={s.status === "PENDING_APPROVAL" ? "Waiting for approval" : s.status === "APPROVED" ? (s.acceptingOrders ? "Open" : "Approved, closed") : s.status.toLowerCase()} />
                  </td>
                  <td className="num">{s.queueLength}</td>
                  <td>{when(s.createdAt)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {(ACTIONS[s.status] ?? []).map((a) => (
                        <button
                          key={a.action}
                          className={`btn btn-small btn-${a.tone}`}
                          onClick={async () => {
                            const reason = window.prompt(`${a.label} ${s.name}: reason for the record`);
                            if (!reason || reason.trim().length < 3) return;
                            setActionError(null);
                            try {
                              await api(`/admin/universities/${universityId}/shops/${s.id}/status`, { method: "POST", body: { action: a.action, reason } });
                              await reload();
                            } catch (e) {
                              setActionError(e);
                            }
                          }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
