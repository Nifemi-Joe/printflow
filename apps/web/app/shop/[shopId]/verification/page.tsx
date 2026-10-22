"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { TrustBadge, type Trust } from "@/components/Trust";
import { ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Check {
  id: string;
  kind: "STUDENT_EMAIL" | "MATRIC_NUMBER" | "UNIVERSITY_REVIEW";
  status: "PENDING" | "PASSED" | "FAILED" | "EXPIRED" | "REVOKED";
  subject: string;
  note: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  decidedByName: string | null;
}

interface Verification extends Trust {
  shopId: string;
  undertaking: { required: boolean; accepted: boolean; version: number; text: string };
  studentEmailDomains: string[];
  matricPattern: string | null;
  renewEveryDays: number;
  next: Array<{ step: string; label: string }>;
  checks: Check[];
}

const CHECK_LABEL: Record<Check["kind"], string> = {
  STUDENT_EMAIL: "University email",
  MATRIC_NUMBER: "Matric number",
  UNIVERSITY_REVIEW: "University review",
};

/**
 * How a shop owner proves who they are. Student-run shops start with nothing proven and
 * work up; the page says plainly what each step unlocks, because the limits are real.
 */
export default function Verification() {
  const { shopId } = useParams<{ shopId: string }>();
  const { data: v, error, loading, reload } = useData<Verification>(`/shops/${shopId}/verification`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setActionError(null);
    setMsg(null);
    try {
      const m = await fn();
      if (typeof m === "string") setMsg(m);
      await reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton lines={6} />;
  if (!v) return <ErrorNotice error={error} onRetry={reload} />;
  const student = v.kind === "STUDENT_RUN";
  const passed = (k: Check["kind"]) => v.checks.some((c) => c.kind === k && c.status === "PASSED");

  return (
    <>
      <PageHead title="Verification">
        <TrustBadge trust={v} />
      </PageHead>
      <p className="muted">{v.badge.detail}</p>
      {msg && (
        <div className="notice" role="status">
          <p>{msg}</p>
        </div>
      )}
      <ErrorNotice error={actionError} />

      {!student ? (
        <div className="sheet">
          <h2 style={{ fontSize: "var(--t-xl)" }}>Registered print shop</h2>
          <p>Your university checked this shop when it approved you, so students see it as an approved shop. There is nothing for you to do here.</p>
        </div>
      ) : (
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            {v.limits?.needsAcknowledgement && (
              <div className="notice notice-warn">
                <p>
                  <strong>Students are warned about your shop.</strong> Until your matric number is confirmed, orders here are capped at{" "}
                  {v.limits.orderCapKobo !== null ? naira(v.limits.orderCapKobo) : "a limit set by your university"}, and every student has to tick a box saying they
                  understand who you are. Finishing the steps below removes both.
                </p>
              </div>
            )}

            {!v.undertaking.accepted && (
              <form
                className="sheet"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api(`/shops/${shopId}/verification/undertaking`, { method: "POST", body: { version: v.undertaking.version, agree: true } });
                    return "Thank you. You can now open your shop for orders.";
                  });
                }}
              >
                <h2 style={{ fontSize: "var(--t-xl)" }}>1. Confidentiality undertaking</h2>
                <p className="muted">You will be handling other students&apos; private documents. Read this and agree before you can take any orders.</p>
                <pre
                  className="sheet"
                  style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", background: "var(--paper)", margin: "var(--space-3) 0", padding: "var(--space-4)" }}
                >
                  {v.undertaking.text}
                </pre>
                <label className="choice" style={{ display: "block", marginBottom: "var(--space-3)" }}>
                  <input type="checkbox" required />
                  <span style={{ padding: "var(--space-3) var(--space-4)" }}>I have read this and I agree to it</span>
                </label>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Agree and continue
                </button>
              </form>
            )}

            {v.undertaking.accepted && !passed("STUDENT_EMAIL") && v.studentEmailDomains.length > 0 && (
              <form
                className="sheet"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void run(async () => {
                    if (!emailSentTo) {
                      const r = await api<{ sentTo: string }>(`/shops/${shopId}/verification/email`, { method: "POST", body: { email: f.get("email") } });
                      setEmailSentTo(r.sentTo);
                      return `We sent a 6-digit code to ${r.sentTo}. It expires in 10 minutes.`;
                    }
                    await api(`/shops/${shopId}/verification/email/confirm`, { method: "POST", body: { code: f.get("code") } });
                    setEmailSentTo(null);
                    return "Your university email is confirmed. Students now see your shop in the list.";
                  });
                }}
              >
                <h2 style={{ fontSize: "var(--t-xl)" }}>2. Your university email</h2>
                <p className="muted">
                  This proves you study here. Use your address ending in {v.studentEmailDomains.map((d) => `@${d}`).join(" or ")}. It gets your shop listed, but orders stay
                  capped until step 3.
                </p>
                {!emailSentTo ? (
                  <div className="field">
                    <label htmlFor="email">University email address</label>
                    <input id="email" name="email" type="email" required placeholder={`you@${v.studentEmailDomains[0]}`} />
                  </div>
                ) : (
                  <div className="field">
                    <label htmlFor="code">6-digit code</label>
                    <input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
                  </div>
                )}
                <div className="row">
                  <button className="btn btn-primary" type="submit" disabled={busy}>
                    {emailSentTo ? "Confirm code" : "Email me a code"}
                  </button>
                  {emailSentTo && (
                    <button className="btn btn-quiet" type="button" onClick={() => setEmailSentTo(null)}>
                      Use a different address
                    </button>
                  )}
                </div>
              </form>
            )}

            {v.undertaking.accepted && !passed("MATRIC_NUMBER") && (
              <form
                className="sheet"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void run(async () => {
                    const r = await api<{ outcome: string; message: string }>(`/shops/${shopId}/verification/matric`, { method: "POST", body: { matricNumber: f.get("matric") } });
                    return r.message;
                  });
                }}
              >
                <h2 style={{ fontSize: "var(--t-xl)" }}>3. Your matric number</h2>
                <p className="muted">
                  This is the step that removes the cap and the warning students see. If your university has given us its student list, it is instant; otherwise they check it
                  by hand.
                </p>
                <div className="field">
                  <label htmlFor="matric">Matric number</label>
                  <input id="matric" name="matric" required minLength={3} maxLength={40} />
                  {v.matricPattern && (
                    <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                      Your university&apos;s format: {v.matricPattern.replace(/[\^$]/g, "")}
                    </p>
                  )}
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Submit for checking
                </button>
              </form>
            )}

            {v.next.length === 0 && (
              <div className="sheet">
                <h2 style={{ fontSize: "var(--t-xl)" }}>Nothing left to do</h2>
                <p>Your identity is confirmed and your shop has no extra limits. You will be asked to confirm again every {v.renewEveryDays} days.</p>
              </div>
            )}
          </div>

          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Your checks</h2>
            {v.checks.length === 0 ? (
              <p className="muted">Nothing has been checked yet.</p>
            ) : (
              <ul className="plain-list" aria-label="Verification checks">
                {v.checks.map((c) => (
                  <li key={c.id} className="ticket-line">
                    <span>
                      <strong>{CHECK_LABEL[c.kind]}</strong> <StatusPill status={c.status} />
                      <br />
                      <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                        {c.subject}
                        {c.decidedAt ? `, ${when(c.decidedAt)}` : ""}
                        {c.decidedByName ? `, by ${c.decidedByName}` : ""}
                        {c.status === "PASSED" && c.expiresAt ? `. Renew by ${when(c.expiresAt)}` : ""}
                        {c.note ? `. ${c.note}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
