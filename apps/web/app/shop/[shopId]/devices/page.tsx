"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { useData } from "@/lib/use-data";

const STATUSES = ["AVAILABLE", "BUSY", "OUT_OF_PAPER", "OUT_OF_TONER", "FAULT", "OFFLINE"];
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export default function Devices() {
  const { shopId } = useParams<{ shopId: string }>();
  const { data, error, loading, reload } = useData<{ items: Array<{ id: string; label: string; reportedStatus: string; statusReportedAt: string | null; reportedBy: string | null }> }>(`/shops/${shopId}/devices`);
  const [actionError, setActionError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e);
    }
  };
  return (
    <>
      <PageHead title="Printers" />
      <p className="muted">Update a printer&apos;s status when it changes. Students see how many printers are working. PrintFlow does not read printers directly.</p>
      <ErrorNotice error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="No printers added">Add each printer so jobs can be recorded against it.</Empty>
      ) : (
        <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Printer</th>
                <th scope="col">Status</th>
                <th scope="col">Last update</th>
                <th scope="col">Change status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.label}</strong>
                  </td>
                  <td>
                    <StatusPill status={d.reportedStatus} label={label(d.reportedStatus)} />
                  </td>
                  <td className="muted">{d.statusReportedAt ? `${relative(d.statusReportedAt)} by ${d.reportedBy}` : "Never"}</td>
                  <td>
                    <label className="sr-only" htmlFor={`st-${d.id}`}>
                      Status of {d.label}
                    </label>
                    <select id={`st-${d.id}`} value={d.reportedStatus} onChange={(e) => run(() => api(`/shops/${shopId}/devices/${d.id}`, { method: "PATCH", body: { reportedStatus: e.target.value } }))}>
                      {d.reportedStatus === "UNKNOWN" && <option value="UNKNOWN">Unknown</option>}
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {label(s)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="sheet row"
        style={{ marginTop: "1.5rem", alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const name = String(new FormData(form).get("label"));
          void run(async () => {
            await api(`/shops/${shopId}/devices`, { method: "POST", body: { label: name } });
            form.reset();
          });
        }}
      >
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
          <label htmlFor="new-device">Add a printer</label>
          <input id="new-device" name="label" placeholder="e.g. Ricoh MP 4055 (front)" required maxLength={80} />
        </div>
        <button className="btn btn-primary" type="submit">
          Add printer
        </button>
      </form>
    </>
  );
}
