"use client";

import Link from "next/link";
import { Empty, ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Note {
  id: string;
  title: string;
  body: string;
  orderId: string | null;
  readAt: string | null;
  createdAt: string;
}

export default function Notifications() {
  const { data, error, loading, reload } = useData<{ items: Note[]; unread: number }>("/notifications", { pollMs: 15_000 });
  return (
    <>
      <PageHead title="Notifications">
        {data && data.unread > 0 && (
          <button
            className="btn btn-quiet"
            onClick={async () => {
              await api("/notifications/read-all", { method: "POST" });
              await reload();
            }}
          >
            Mark all as read
          </button>
        )}
      </PageHead>
      <ErrorNotice error={error} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="Nothing new">We let you know here when your documents are ready and your orders move along.</Empty>
      ) : (
        <div className="sheet">
          {data.items.map((n) => (
            <div key={n.id} style={{ padding: "0.9rem 0", borderBottom: "1px solid var(--rule)", fontWeight: n.readAt ? 400 : 700 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{n.title}</span>
                <span className="muted" style={{ fontWeight: 400 }}>
                  {relative(n.createdAt)}
                </span>
              </div>
              <p className="muted" style={{ fontWeight: 400, margin: "0.25rem 0 0" }}>
                {n.body} {n.orderId && <Link href={`/student/orders/${n.orderId}`}>Open order</Link>}
              </p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
