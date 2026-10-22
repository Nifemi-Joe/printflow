"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";

export default function UniSettings() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const ov = useData<{
    university: {
      quoteTtlSeconds: number;
      documentRetentionDays: number;
      studentProvidersAllowed: boolean;
      studentEmailDomains: string[];
      matricPattern: string | null;
      studentProviderCapKobo: number;
      providerReverifyDays: number;
    };
  }>(`${base}/overview`);
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
                const domains = String(f.get("domains") ?? "")
                    .split(/[\s,]+/)
                    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
                    .filter(Boolean);
                void run(
                    () =>
                        api(`${base}/settings`, {
                          method: "PATCH",
                          body: {
                            studentProvidersAllowed: f.get("allowed") === "on",
                            studentEmailDomains: domains,
                            matricPattern: String(f.get("matric") ?? "").trim() || null,
                            studentProviderCapKobo: Math.round(Number(f.get("cap")) * 100),
                            providerReverifyDays: Number(f.get("renew")),
                          },
                        }),
                    "Student provider settings saved.",
                );
              }}
          >
            <h2 style={{ fontSize: "var(--t-xl)" }}>Students who print for others</h2>
            <p className="muted">
              Students with their own printers can serve their hostel or faculty. PrintFlow confirms who they are, shows students how far that got, and limits what is not
              confirmed.
            </p>
            <label className="choice" style={{ display: "block", marginBottom: "var(--space-4)" }}>
              <input type="checkbox" name="allowed" defaultChecked={ov.data?.university.studentProvidersAllowed} />
              <span style={{ padding: "var(--space-3) var(--space-4)" }}>Let students register their own printers</span>
            </label>
            <div className="field">
              <label htmlFor="domains">Your student email domains</label>
              <input id="domains" name="domains" defaultValue={(ov.data?.university.studentEmailDomains ?? []).join(", ")} placeholder="students.unilag.edu.ng" />
              <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                Separate several with commas. A code sent to one of these proves someone studies here.
              </p>
            </div>
            <div className="field">
              <label htmlFor="matric">Matric number format</label>
              <input id="matric" name="matric" defaultValue={ov.data?.university.matricPattern ?? ""} placeholder="^[0-9]{2}/[0-9]{6}$" />
              <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                A pattern their matric number must match, so obvious nonsense never reaches you. Leave empty to accept anything.
              </p>
            </div>
            <div className="field">
              <label htmlFor="cap">Order cap before a matric number is confirmed (₦)</label>
              <input id="cap" name="cap" type="number" min={100} max={1_000_000} step={1} defaultValue={(ov.data?.university.studentProviderCapKobo ?? 200000) / 100} />
            </div>
            <div className="field">
              <label htmlFor="renew">Ask them to confirm again every (days)</label>
              <input id="renew" name="renew" type="number" min={30} max={1095} step={1} defaultValue={ov.data?.university.providerReverifyDays ?? 365} />
            </div>
            <button className="btn btn-primary" type="submit">
              Save
            </button>
          </form>
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
