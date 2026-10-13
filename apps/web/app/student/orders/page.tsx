"use client";

import Link from "next/link";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, relative } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Row {
  id: string;
  reference: string;
  status: string;
  totalKobo: string;
  created_at: string;
  shopName: string;
  documentTitle: string;
}

export default function OrdersPage() {
  const first = useData<{ items: Row[]; nextCursor: string | null }>("/orders", { pollMs: 10_000 });
  const [more, setMore] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const next = cursor === undefined ? first.data?.nextCursor : cursor;
  const rows = [...(first.data?.items ?? []), ...more];

  return (
    <>
      <PageHead title="Orders">
        <Link href="/student/print" className="btn btn-primary">
          Print something
        </Link>
      </PageHead>
      <ErrorNotice error={first.error} onRetry={first.reload} />
      {first.loading ? (
        <Skeleton lines={5} />
      ) : rows.length === 0 ? (
        <Empty title="No orders yet" action={<Link className="btn btn-primary" href="/student/print">Print something</Link>}>
          Your orders and their progress through the shop appear here.
        </Empty>
      ) : (
        <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table className="stack-sm">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Shop</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Total</th>
                <th scope="col">Placed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/student/orders/${o.id}`}>
                      <strong>{o.documentTitle}</strong>
                    </Link>
                    <div className="muted num">{o.reference}</div>
                  </td>
                  <td data-label="Shop">{o.shopName}</td>
                  <td>
                    <StatusPill status={o.status} />
                  </td>
                  <td className="num" data-label="Total">{naira(o.totalKobo)}</td>
                  <td data-label="Placed">{relative(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button
          className="btn btn-quiet"
          style={{ marginTop: "1rem" }}
          onClick={async () => {
            const page = await api<{ items: Row[]; nextCursor: string | null }>(`/orders?cursor=${encodeURIComponent(next)}`);
            setMore((m) => [...m, ...page.items]);
            setCursor(page.nextCursor);
          }}
        >
          Show older orders
        </button>
      )}
    </>
  );
}
