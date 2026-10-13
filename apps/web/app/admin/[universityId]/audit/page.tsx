"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Entry {
  id: string;
  occurred_at: string;
  action: string;
  entityType: string;
  entityId: string;
  actorKind: string;
  actorName: string | null;
  shopName: string | null;
  details: Record<string, unknown>;
}

export default function Audit() {
  const { universityId } = useParams<{ universityId: string }>();
  const [cursor, setCursor] = useState("");
  const { data, error, loading, reload } = useData<{ items: Entry[]; nextCursor: string | null }>(`/admin/universities/${universityId}/audit-log?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
  return (
    <>
      <PageHead title="Audit log" />
      <p className="muted">Every privileged and financial action, newest first. Entries cannot be edited or deleted.</p>
      <ErrorNotice error={error} onRetry={reload} />
      {loading ? (
        <Skeleton lines={8} />
      ) : (
        <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.occurred_at)}</td>
                  <td>
                    {e.actorName ?? "PrintFlow"}
                    {e.shopName && <div className="muted">{e.shopName}</div>}
                  </td>
                  <td>{e.action.replace(/[._]/g, " ")}</td>
                  <td className="muted" style={{ maxWidth: 360, wordBreak: "break-word" }}>
                    {Object.entries(e.details)
                      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: "1rem" }}>
        {cursor && (
          <button className="btn btn-quiet" onClick={() => setCursor("")}>
            Newest
          </button>
        )}
        {data?.nextCursor && (
          <button className="btn btn-quiet" onClick={() => setCursor(data.nextCursor!)}>
            Older entries
          </button>
        )}
      </div>
    </>
  );
}
