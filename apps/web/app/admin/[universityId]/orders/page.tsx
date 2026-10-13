"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, STATUS_LABEL, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Row {
  id: string;
  reference: string;
  status: string;
  totalKobo: string;
  created_at: string;
  shopName: string;
  studentName: string;
}
interface Detail {
  id: string;
  reference: string;
  status: string;
  totalKobo: string;
  studentName: string;
  studentEmail: string;
  shopName: string;
  rateCardVersion: number;
  events: Array<{ to: string; actorKind: string; reason: string | null; at: string }>;
  payments: Array<{ provider: string; reference: string; amountKobo: string; status: string }>;
  refunds: Array<{ id: string; amountKobo: string; status: string; reason: string }>;
}

export default function AdminOrders() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState("");
  const list = useData<{ items: Row[]; nextCursor: string | null }>(`${base}/orders?limit=25${status ? `&status=${status}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useData<Detail>(open ? `${base}/orders/${open}` : null);
  const [actionError, setActionError] = useState<unknown>(null);

  return (
    <>
      <PageHead title="Orders">
        <label className="sr-only" htmlFor="st">
          Filter by status
        </label>
        <select id="st" value={status} onChange={(e) => (setStatus(e.target.value), setCursor(""))} style={{ width: 220 }}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </PageHead>
      <ErrorNotice error={list.error ?? actionError} onRetry={list.reload} />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div>
          {list.loading ? (
            <Skeleton />
          ) : !list.data?.items.length ? (
            <Empty title="No orders match" />
          ) : (
            <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((o) => (
                    <tr key={o.id} aria-selected={open === o.id} style={{ background: open === o.id ? "var(--emerald-wash)" : undefined }}>
                      <td>
                        <button className="btn btn-quiet btn-small num" onClick={() => setOpen(o.id)}>
                          {o.reference}
                        </button>
                        <div className="muted">
                          {o.studentName} at {o.shopName}, {when(o.created_at)}
                        </div>
                      </td>
                      <td>
                        <StatusPill status={o.status} />
                      </td>
                      <td className="num">{naira(o.totalKobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.data?.nextCursor && (
            <button className="btn btn-quiet" style={{ marginTop: "1rem" }} onClick={() => setCursor(list.data!.nextCursor!)}>
              Older orders
            </button>
          )}
        </div>
        <div>
          {open && detail.data ? (
            <div className="sheet">
              <h2 style={{ fontSize: "var(--t-xl)" }}>{detail.data.reference}</h2>
              <p className="muted">
                {detail.data.studentName} ({detail.data.studentEmail}), {detail.data.shopName}. Price list version {detail.data.rateCardVersion}.
              </p>
              <ol className="timeline">
                {detail.data.events.map((e, i) => (
                  <li key={i}>
                    <strong>{STATUS_LABEL[e.to]}</strong> <span className="muted">{when(e.at)}, by {e.actorKind.toLowerCase().replace("_", " ")}</span>
                    {e.reason && <div className="muted">{e.reason}</div>}
                  </li>
                ))}
              </ol>
              {detail.data.payments.map((p) => (
                <div className="ticket-line" key={p.reference}>
                  <span>
                    Payment ({p.provider.toLowerCase()}) <StatusPill status={p.status} />
                  </span>
                  <span className="num">{naira(p.amountKobo)}</span>
                </div>
              ))}
              {detail.data.refunds.map((r) => (
                <div className="ticket-line" key={r.id}>
                  <span>
                    Refund: {r.reason} <StatusPill status={r.status} />
                  </span>
                  <span className="num">{naira(r.amountKobo)}</span>
                </div>
              ))}
              {detail.data.status === "REFUND_PENDING" &&
                detail.data.refunds.some((r) => r.status === "FAILED") &&
                !detail.data.refunds.some((r) => r.status === "REQUESTED" || r.status === "PROCESSING") && (
                  <div style={{ marginTop: "1rem" }}>
                    <p className="muted">The payment provider refused the last refund. Fix the cause in the provider dashboard, then send it again. Only the unrefunded amount is sent.</p>
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        const reason = window.prompt("Note for the audit log (e.g. what was fixed)");
                        if (!reason || reason.trim().length < 3) return;
                        setActionError(null);
                        try {
                          await api(`${base}/orders/${open}/refund-retry`, { method: "POST", body: { reason } });
                          await detail.reload();
                          await list.reload();
                        } catch (e) {
                          setActionError(e);
                        }
                      }}
                    >
                      Retry refund
                    </button>
                  </div>
                )}
              {["PAID", "PRINT_FAILED"].includes(detail.data.status) && (
                <button
                  className="btn btn-danger"
                  style={{ marginTop: "1rem" }}
                  onClick={async () => {
                    const reason = window.prompt("Reason for the refund (the student sees this)");
                    if (!reason || reason.trim().length < 3) return;
                    setActionError(null);
                    try {
                      await api(`${base}/orders/${open}/refund`, { method: "POST", body: { reason } });
                      await detail.reload();
                      await list.reload();
                    } catch (e) {
                      setActionError(e);
                    }
                  }}
                >
                  Refund in full
                </button>
              )}
            </div>
          ) : (
            <Empty title="Choose an order">Select an order to see its history, payments and refunds.</Empty>
          )}
        </div>
      </div>
    </>
  );
}
