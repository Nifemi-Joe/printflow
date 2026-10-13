"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PhoneVerify } from "@/components/PhoneVerify";
import { ErrorNotice, PageHead, StatusPill } from "@/components/ui";
import { api, toBrowserUrl } from "@/lib/api";
import { when } from "@/lib/format";
import { mfaPending, useSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

export default function Account() {
  const { me, refresh } = useSession();
  const router = useRouter();
  const privacy = useData<{ items: Array<{ id: string; kind: string; status: string; note: string | null; createdAt: string }> }>(me && !mfaPending(me) ? "/privacy-requests" : null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await refresh();
      await privacy.reload();
    } catch (e) {
      setError(e);
    }
  };

  return (
      <AppShell title="Account" items={[]}>
        <PageHead title="Account" />
        {msg && (
            <div className="notice" role="status">
              <p>{msg}</p>
            </div>
        )}
        <ErrorNotice error={error} />
        {me && (
            <div className="grid-2" style={{ alignItems: "start" }}>
              <form
                  className="sheet"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void run(() => api("/me/profile", { method: "PATCH", body: { fullName: f.get("fullName"), ...(me.student ? { matricNumber: f.get("matric") || null } : {}) } }), "Profile saved.");
                  }}
              >
                <h2 style={{ fontSize: "var(--t-xl)" }}>Profile</h2>
                <p className="muted">
                  {me.user.email} {me.user.emailVerified ? "" : <>(not confirmed yet, <a href="/verify">confirm</a>)</>}
                  {me.student && (
                      <>
                        <br />
                        {me.student.universityName}, {me.student.campusName}
                      </>
                  )}
                </p>
                <div className="field">
                  <label htmlFor="fullName">Full name</label>
                  <input id="fullName" name="fullName" defaultValue={me.user.fullName} required />
                </div>
                {me.student && (
                    <div className="field">
                      <label htmlFor="matric">Matric number</label>
                      <input id="matric" name="matric" defaultValue={me.student.matricNumber ?? ""} />
                    </div>
                )}
                <button className="btn btn-primary" type="submit">
                  Save profile
                </button>
              </form>

              <form
                  className="sheet"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const f = new FormData(form);
                    void run(async () => {
                      await api("/auth/password/change", { method: "POST", body: { currentPassword: f.get("current"), newPassword: f.get("next") } });
                      form.reset();
                    }, "Password changed. Other devices have been signed out.");
                  }}
              >
                <h2 style={{ fontSize: "var(--t-xl)" }}>Password</h2>
                <div className="field">
                  <label htmlFor="current">Current password</label>
                  <input id="current" name="current" type="password" autoComplete="current-password" required />
                </div>
                <div className="field">
                  <label htmlFor="next">New password</label>
                  <input id="next" name="next" type="password" autoComplete="new-password" minLength={10} required />
                </div>
                <button className="btn btn-primary" type="submit">
                  Change password
                </button>
                <p style={{ marginTop: "1rem" }}>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => run(async () => { await api("/auth/logout-all", { method: "POST" }); router.replace("/login"); }, "Signed out everywhere.")}>
                    Sign out on every device
                  </button>
                </p>
              </form>

              <div className="sheet">
                <h2 style={{ fontSize: "var(--t-xl)" }}>Phone number</h2>
                <p className="muted">Sign in with a texted code, reset your password by text, and get a text when your prints are ready.</p>
                <PhoneVerify phone={me.user.phone} verified={me.user.phoneVerified} onVerified={async () => (await refresh(), setMsg("Phone number confirmed."))} />
              </div>

              <div className="sheet">
                <h2 style={{ fontSize: "var(--t-xl)" }}>Two-step sign-in</h2>
                <p>{me.mfa.totpEnrolled ? "An authenticator app is set up for this account." : "Add an authenticator app for extra protection. Staff accounts must have one."}</p>
                {!me.mfa.totpEnrolled && (
                    <a className="btn btn-quiet" href="/mfa">
                      Set up an authenticator
                    </a>
                )}
              </div>

              <div className="sheet">
                <h2 style={{ fontSize: "var(--t-xl)" }}>Your data</h2>
                <p className="muted">Download everything we hold about you, or ask your university to erase your account. Erasure is possible once no orders are in progress.</p>
                <div className="row">
                  <button className="btn btn-quiet" onClick={() => run(() => api("/privacy-requests", { method: "POST", body: { kind: "EXPORT" } }), "Export requested. It will appear below when ready.")}>
                    Request a data export
                  </button>
                  <button
                      className="btn btn-danger"
                      onClick={() => {
                        if (window.confirm("Ask for your account to be erased? This cannot be undone once completed.")) void run(() => api("/privacy-requests", { method: "POST", body: { kind: "ERASURE" } }), "Erasure requested. Your university will process it.");
                      }}
                  >
                    Request erasure
                  </button>
                </div>
                {privacy.data?.items.map((p) => (
                    <div key={p.id} className="ticket-line">
                <span>
                  {p.kind === "EXPORT" ? "Data export" : "Erasure"} <span className="muted">{when(p.createdAt)}</span> {p.note && <span className="muted">{p.note}</span>}
                </span>
                      <span className="row">
                  <StatusPill status={p.status === "COMPLETED" ? "SUCCEEDED" : p.status === "REJECTED" ? "FAILED" : "PENDING"} label={p.status.toLowerCase().replace("_", " ")} />
                        {p.kind === "EXPORT" && p.status === "COMPLETED" && (
                            <button
                                className="btn btn-quiet btn-small"
                                onClick={async () => {
                                  const r = await api<{ url: string }>(`/privacy-requests/${p.id}/download`);
                                  window.location.assign(toBrowserUrl(r.url));
                                }}
                            >
                              Download
                            </button>
                        )}
                </span>
                    </div>
                ))}
              </div>
            </div>
        )}
      </AppShell>
  );
}
