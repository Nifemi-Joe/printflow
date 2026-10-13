"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { naira, STATUS_LABEL, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

export default function History() {
  const { shopId } = useParams<{ shopId: string }>();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState("");
  const { data, error, loading, reload } = useData<{ items: Array<{ id: string; reference: string; status: string; totalKobo: string; totalSheets: number; created_at: string }>; nextCursor: string | null }>(
    `/shops/${shopId}/orders?limit=25${status ? `&status=${status}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  return (
    <>
      <PageHead title="Order history">
        <label className="sr-only" htmlFor="status">
          Filter by status
        </label>
        <select id="status" value={status} onChange={(e) => (setStatus(e.target.value), setCursor(""))} style={{ width: 220 }}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL)
            .filter(([k]) => k !== "AWAITING_PAYMENT")
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
      </PageHead>
      <ErrorNotice error={error} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="No orders match">Try a different status.</Empty>
      ) : (
        <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Sheets</th>
                <th scope="col" className="num">Order value</th>
                <th scope="col">Placed</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link className="num" href={`/shop/${shopId}/orders/${o.id}`}>
                      {o.reference}
                    </Link>
                  </td>
                  <td>
                    <StatusPill status={o.status} />
                  </td>
                  <td className="num">{o.totalSheets}</td>
                  <td className="num">{naira(o.totalKobo)}</td>
                  <td>{when(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: "1rem" }}>
        {cursor && (
          <button className="btn btn-quiet" onClick={() => setCursor("")}>
            Back to newest
          </button>
        )}
        {data?.nextCursor && (
          <button className="btn btn-quiet" onClick={() => setCursor(data.nextCursor!)}>
            Older orders
          </button>
        )}
      </div>
    </>
  );
}
