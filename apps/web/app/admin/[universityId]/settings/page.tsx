"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";

export default function UniSettings() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const ov = useData<{ university: { quoteTtlSeconds: number; documentRetentionDays: number } }>(`${base}/overview`);
  const campuses = useData<{ items: Array<{ id: string; name: string; isActive: boolean; departments: Array<{ id: string; name: string }> }> }>(`${base}/campuses`);
  const [actionError, setActionError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setActionError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await ov.reload();
      await campuses.reload();
    } catch (e) {
      setActionError(e);
    }
  };
  if (ov.loading || campuses.loading) return <Skeleton />;

  return (
    <>
      <PageHead title="Settings and campuses" />
      {msg && (
        <div className="notice" role="status">
          <p>{msg}</p>
        </div>
      )}
      <ErrorNotice error={ov.error ?? campuses.error ?? actionError} />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <form
          className="sheet"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(
              () => api(`${base}/settings`, { method: "PATCH", body: { quoteTtlSeconds: Number(f.get("ttl")) * 60, documentRetentionDays: Number(f.get("retention")) } }),
              "Settings saved.",
            );
          }}
        >
          <h2 style={{ fontSize: "var(--t-xl)" }}>Rules</h2>
          <div className="field">
            <label htmlFor="ttl">How long a quoted price is held (minutes)</label>
            <input id="ttl" name="ttl" type="number" min={1} max={1440} defaultValue={Math.round((ov.data?.university.quoteTtlSeconds ?? 1800) / 60)} />
          </div>
          <div className="field">
            <label htmlFor="retention">Keep documents for (days after the order ends)</label>
            <input id="retention" name="retention" type="number" min={1} max={365} defaultValue={ov.data?.university.documentRetentionDays ?? 30} />
          </div>
          <button className="btn btn-primary" type="submit">
            Save rules
          </button>
        </form>

        <div className="sheet">
          <h2 style={{ fontSize: "var(--t-xl)" }}>Campuses</h2>
          {campuses.data?.items.map((c) => (
            <div key={c.id} style={{ padding: "0.75rem 0", borderBottom: "1px solid var(--rule)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>
                  {c.name} {!c.isActive && <span className="muted">(closed)</span>}
                </strong>
                <button className="btn btn-quiet btn-small" onClick={() => run(() => api(`${base}/campuses/${c.id}`, { method: "PATCH", body: { isActive: !c.isActive } }), "Campus updated.")}>
                  {c.isActive ? "Close" : "Reopen"}
                </button>
              </div>
              <p className="muted" style={{ margin: "0.25rem 0" }}>
                {c.departments.length ? c.departments.map((d) => d.name).join(", ") : "No departments listed"}
              </p>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const name = String(new FormData(form).get("dept"));
                  void run(async () => {
                    await api(`${base}/campuses/${c.id}/departments`, { method: "POST", body: { name } });
                    form.reset();
                  }, "Department added.");
                }}
              >
                <label className="sr-only" htmlFor={`dept-${c.id}`}>
                  New department at {c.name}
                </label>
                <input id={`dept-${c.id}`} name="dept" placeholder="Add a department" required minLength={2} style={{ flex: 1, minWidth: 160 }} />
                <button className="btn btn-quiet btn-small" type="submit">
                  Add
                </button>
              </form>
            </div>
          ))}
          <form
            className="row"
            style={{ marginTop: "1rem" }}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const name = String(new FormData(form).get("campus"));
              void run(async () => {
                await api(`${base}/campuses`, { method: "POST", body: { name } });
                form.reset();
              }, "Campus added.");
            }}
          >
            <label className="sr-only" htmlFor="new-campus">
              New campus name
            </label>
            <input id="new-campus" name="campus" placeholder="New campus name" required minLength={2} style={{ flex: 1, minWidth: 160 }} />
            <button className="btn btn-primary btn-small" type="submit">
              Add campus
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
