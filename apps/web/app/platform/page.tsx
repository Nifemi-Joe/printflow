"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { naira } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Uni {
  id: string;
  slug: string;
  name: string;
  status: string;
  serviceFeeFixedKobo: string;
  serviceFeeBps: number;
  approvedShops: number;
  students: number;
  ordersLast30Days: number;
  hasPublishedPricing: boolean;
}
interface Health {
  checkout: string;
  jobs: Array<{ kind: string; status: string; n: number }>;
  deadJobs: Array<{ id: string; kind: string; lastError: string }>;
  webhooksLast24h: { invalidSignatures: number; processingErrors: number; total: number };
}

export default function Platform() {
  const unis = useData<{ items: Uni[] }>("/platform/universities");
  const health = useData<Health>("/platform/health", { pollMs: 30_000 });
  const [actionError, setActionError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setActionError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await unis.reload();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <AppShell staff title="Platform" items={[{ href: "/platform", label: "Universities and health" }]}>
      <PageHead title="Platform" />
      {msg && (
        <div className="notice" role="status">
          <p>{msg}</p>
        </div>
      )}
      <ErrorNotice error={unis.error ?? actionError} onRetry={unis.reload} />

      {health.data && (
        <div className="sheet" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ fontSize: "var(--t-xl)" }}>Health</h2>
          <p>
            Checkout: <strong>{health.data.checkout === "LIVE" ? "live payments" : health.data.checkout === "TEST" ? "test mode (no real money)" : "switched off"}</strong>. Webhooks in the last 24 hours: {health.data.webhooksLast24h.total} received,{" "}
            {health.data.webhooksLast24h.invalidSignatures} with bad signatures, {health.data.webhooksLast24h.processingErrors} that could not be matched.
          </p>
          {health.data.deadJobs.length > 0 ? (
            <div className="notice notice-error">
              <p>{health.data.deadJobs.length} background jobs have failed permanently:</p>
              <ul>
                {health.data.deadJobs.map((j) => (
                  <li key={j.id}>
                    {j.kind.toLowerCase().replace(/_/g, " ")}: {j.lastError}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">No failed background jobs.</p>
          )}
        </div>
      )}

      {unis.loading ? (
        <Skeleton />
      ) : (
        <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">University</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Shops</th>
                <th scope="col" className="num">Students</th>
                <th scope="col" className="num">Orders (30 days)</th>
                <th scope="col">Service fee</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {unis.data?.items.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    <div className="muted">{u.hasPublishedPricing ? "Prices published" : "No prices published"}</div>
                  </td>
                  <td>
                    <StatusPill status={u.status === "ACTIVE" ? "APPROVED" : u.status === "SUSPENDED" ? "SUSPENDED" : "PENDING"} label={u.status.toLowerCase()} />
                  </td>
                  <td className="num">{u.approvedShops}</td>
                  <td className="num">{u.students}</td>
                  <td className="num">{u.ordersLast30Days}</td>
                  <td>
                    {naira(u.serviceFeeFixedKobo)} + {(u.serviceFeeBps / 100).toFixed(2)}%
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {u.status !== "ACTIVE" && (
                        <button className="btn btn-primary btn-small" onClick={() => run(() => api(`/platform/universities/${u.id}`, { method: "PATCH", body: { status: "ACTIVE" } }), `${u.name} is live.`)}>
                          Go live
                        </button>
                      )}
                      {u.status === "ACTIVE" && (
                        <button className="btn btn-danger btn-small" onClick={() => window.confirm(`Suspend ${u.name}? Students will not be able to order.`) && run(() => api(`/platform/universities/${u.id}`, { method: "PATCH", body: { status: "SUSPENDED" } }), "Suspended.")}>
                          Suspend
                        </button>
                      )}
                      <button
                        className="btn btn-quiet btn-small"
                        onClick={() => {
                          const email = window.prompt(`Email of the new administrator for ${u.name}`);
                          if (email) void run(() => api(`/platform/universities/${u.id}/admins`, { method: "POST", body: { email } }), "Administrator added.");
                        }}
                      >
                        Add admin
                      </button>
                      <button
                        className="btn btn-quiet btn-small"
                        onClick={() => {
                          const fixed = window.prompt("Fixed service fee per order (₦)", (Number(u.serviceFeeFixedKobo) / 100).toFixed(2));
                          const pct = fixed === null ? null : window.prompt("Percentage service fee (e.g. 1.5)", (u.serviceFeeBps / 100).toString());
                          if (fixed !== null && pct !== null)
                            void run(() => api(`/platform/universities/${u.id}`, { method: "PATCH", body: { serviceFeeFixedKobo: Math.round(Number(fixed) * 100), serviceFeeBps: Math.round(Number(pct) * 100) } }), "Fees updated for new quotes.");
                        }}
                      >
                        Fees
                      </button>
                    </div>
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
          const f = new FormData(form);
          void run(async () => {
            await api("/platform/universities", { method: "POST", body: { name: f.get("name"), slug: f.get("slug") } });
            form.reset();
          }, "University created. Add an administrator and a campus, then go live.");
        }}
      >
        <div className="field" style={{ margin: 0, flex: 2, minWidth: 220 }}>
          <label htmlFor="u-name">New university</label>
          <input id="u-name" name="name" required minLength={2} placeholder="University of Lagos" />
        </div>
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 140 }}>
          <label htmlFor="u-slug">Short name</label>
          <input id="u-slug" name="slug" required pattern="[a-z0-9][a-z0-9-]{1,62}" placeholder="unilag" />
        </div>
        <button className="btn btn-primary" type="submit">
          Create
        </button>
      </form>

      <form
        className="sheet"
        style={{ marginTop: "1.5rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const email = String(f.get("email"));
          if (!window.confirm(`Remove the authenticator for ${email} and sign them out everywhere?`)) return;
          void run(async () => {
            await api("/platform/users/mfa-reset", { method: "POST", body: { email, reason: f.get("reason") } });
            form.reset();
          }, `Authenticator removed for ${email}. They set up a new one at their next sign-in.`);
        }}
      >
        <h2 style={{ fontSize: "var(--t-xl)" }}>Reset two-factor authentication</h2>
        <p className="muted">For staff who lost their authenticator. Confirm who they are by a separate channel first; the reason is kept in the audit log.</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <label htmlFor="mfa-email">Email</label>
            <input id="mfa-email" name="email" type="email" required autoComplete="off" />
          </div>
          <div className="field" style={{ margin: 0, flex: 2, minWidth: 220 }}>
            <label htmlFor="mfa-reason">How you confirmed their identity</label>
            <input id="mfa-reason" name="reason" required minLength={10} maxLength={1000} placeholder="Video call with their university ID" />
          </div>
          <button className="btn btn-danger" type="submit">
            Reset
          </button>
        </div>
      </form>
    </AppShell>
  );
}
