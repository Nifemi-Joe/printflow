"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { TrustBadge, type Trust } from "@/components/Trust";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Row {
  id: string;
  name: string;
  kind: "BUSINESS" | "STUDENT_RUN";
  status: string;
  level: Trust["level"];
  acceptingOrders: boolean;
  campusName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  waitingChecks: number;
  renewalDue: string | null;
  ordersTaken: number;
}

interface Check {
  id: string;
  kind: "STUDENT_EMAIL" | "MATRIC_NUMBER" | "UNIVERSITY_REVIEW";
  status: string;
  subject: string;
  note: string | null;
  evidence: Record<string, unknown>;
  decidedAt: string | null;
  expiresAt: string | null;
  decidedByName: string | null;
}

interface Detail extends Trust {
  name: string;
  shopId: string;
  undertakingAccepted: boolean;
  checks: Check[];
  undertakings: Array<{ version: number; acceptedAt: string; name: string }>;
}

const CHECK_LABEL: Record<Check["kind"], string> = {
  STUDENT_EMAIL: "University email",
  MATRIC_NUMBER: "Matric number",
  UNIVERSITY_REVIEW: "University review",
};

/**
 * The university's view of who is printing for its students: what has been proven about
 * each provider, what is waiting on a decision, and the record of every decision made.
 */
export default function Providers() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const [waitingOnly, setWaitingOnly] = useState(false);
  const list = useData<{ items: Row[] }>(`${base}/providers${waitingOnly ? "?waiting=true" : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useData<Detail>(open ? `${base}/providers/${open}` : null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setActionError(null);
    setMsg(null);
    try {
      setMsg(await fn());
      await detail.reload();
      await list.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  if (list.loading) return <Skeleton lines={6} />;
  const waiting = list.data?.items.filter((i) => i.waitingChecks > 0).length ?? 0;

  return (
    <>
      <PageHead title="Print shops and students">
        <label className="choice">
          <input type="checkbox" checked={waitingOnly} onChange={(e) => setWaitingOnly(e.target.checked)} />
          <span>Only those waiting on me</span>
        </label>
      </PageHead>
      <p className="muted">
        Students can print with a registered shop or with another student who owns a printer. Confirming a student&apos;s identity removes the warning and the order cap
        students see on their shop.
      </p>
      {waiting > 0 && !waitingOnly && (
        <div className="notice notice-warn">
          <p>
            {waiting} provider{waiting === 1 ? "" : "s"} waiting for you to confirm something.
          </p>
        </div>
      )}
      {msg && (
        <div className="notice" role="status">
          <p>{msg}</p>
        </div>
      )}
      <ErrorNotice error={list.error ?? detail.error ?? actionError} />

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="stack">
          {list.data?.items.length === 0 ? (
            <Empty title="No print shops yet">Shops and students apply from the PrintFlow website.</Empty>
          ) : (
            list.data?.items.map((r) => (
              <button key={r.id} className={`sheet ${open === r.id ? "sheet-selected" : ""}`} style={{ textAlign: "left", width: "100%", cursor: "pointer" }} onClick={() => setOpen(r.id)}>
                <strong>{r.name}</strong> <span className="muted">{r.campusName}</span>
                <br />
                <TrustBadge trust={{ kind: r.kind, level: r.level, badge: badgeFor(r) }} />
                {r.waitingChecks > 0 && <span className="pill pill-warn"> {r.waitingChecks} waiting</span>}
                {r.status !== "APPROVED" && <StatusPill status={r.status} />}
                <br />
                <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                  {r.ownerName ?? "No owner"} {r.ownerEmail ? `(${r.ownerEmail})` : ""}. {r.ordersTaken} order{r.ordersTaken === 1 ? "" : "s"} taken.
                  {r.renewalDue ? ` Renewal due ${when(r.renewalDue)}.` : ""}
                </span>
              </button>
            ))
          )}
        </div>

        <div>
          {!open || !detail.data ? (
            <Empty title="Choose a provider">See what has been proven about them, and decide anything waiting on you.</Empty>
          ) : (
            <>
              <div className="sheet">
                <h2 style={{ fontSize: "var(--t-xl)" }}>{detail.data.name}</h2>
                <p>
                  <TrustBadge trust={detail.data} showDetail />
                </p>
                {detail.data.kind === "STUDENT_RUN" && (
                  <p className="muted">
                    Confidentiality undertaking: {detail.data.undertakingAccepted ? "accepted" : "not accepted, so this shop cannot take orders"}.
                    {detail.data.limits?.orderCapKobo !== null && detail.data.limits?.orderCapKobo !== undefined
                      ? ` Orders capped at ${naira(detail.data.limits.orderCapKobo)}.`
                      : ""}
                  </p>
                )}
                <ul className="plain-list" aria-label="Checks">
                  {detail.data.checks.map((c) => (
                    <li key={c.id} className="ticket-line">
                      <span>
                        <strong>{CHECK_LABEL[c.kind]}</strong> <StatusPill status={c.status} />
                        <br />
                        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                          {c.subject}
                          {c.decidedAt ? `, ${when(c.decidedAt)}` : ""}
                          {c.decidedByName ? `, by ${c.decidedByName}` : ""}
                          {typeof c.evidence?.method === "string" ? `, ${String(c.evidence.method).toLowerCase().replace(/_/g, " ")}` : ""}
                          {c.note ? `. ${c.note}` : ""}
                        </span>
                      </span>
                      {c.status === "PASSED" && (
                        <button
                          className="btn btn-quiet btn-small"
                          disabled={busy}
                          onClick={() => {
                            const reason = window.prompt("Why are you withdrawing this? The student sees their shop drop back.");
                            if (!reason || reason.trim().length < 3) return;
                            void act(async () => {
                              await api(`${base}/providers/${open}/revoke`, { method: "POST", body: { check: c.kind, reason } });
                              return `Withdrew ${CHECK_LABEL[c.kind].toLowerCase()}.`;
                            });
                          }}
                        >
                          Withdraw
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {detail.data.checks.some((c) => c.status === "PENDING") && (
                <form
                  className="sheet"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                    const pending = detail.data!.checks.find((c) => c.status === "PENDING")!;
                    void act(async () => {
                      await api(`${base}/providers/${open}/decide`, {
                        method: "POST",
                        body: { check: pending.kind, decision: submitter?.value === "reject" ? "REJECT" : "PASS", confirmedWith: f.get("how"), note: f.get("note") },
                      });
                      return submitter?.value === "reject" ? "Rejected, and the student has been told nothing changed." : "Confirmed. Their shop no longer carries the warning.";
                    });
                  }}
                >
                  <h2 style={{ fontSize: "var(--t-xl)" }}>Waiting on you</h2>
                  {detail.data.checks
                    .filter((c) => c.status === "PENDING")
                    .map((c) => (
                      <p key={c.id}>
                        <strong>{CHECK_LABEL[c.kind]}:</strong> <span className="num">{c.subject}</span>
                        {c.evidence?.rollChecked === true && c.evidence?.rollMatched === false ? (
                          <span className="muted"> — this did not match your uploaded student list, so please check by hand.</span>
                        ) : (
                          <span className="muted"> — check this against your student records.</span>
                        )}
                      </p>
                    ))}
                  <div className="field">
                    <label htmlFor="how">How did you confirm it?</label>
                    <select id="how" name="how" defaultValue="STUDENT_RECORDS">
                      <option value="STUDENT_RECORDS">Checked our student records</option>
                      <option value="DEPARTMENT_CONFIRMED">Their department confirmed it</option>
                      <option value="ID_CARD_IN_PERSON">Saw their student ID in person</option>
                      <option value="OTHER">Another way</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="note">What did you check?</label>
                    <input id="note" name="note" required minLength={3} maxLength={1000} placeholder="Found in the 2021 intake register" />
                  </div>
                  <div className="row">
                    <button className="btn btn-primary" type="submit" value="pass" disabled={busy}>
                      Confirm
                    </button>
                    <button className="btn btn-danger" type="submit" value="reject" disabled={busy}>
                      Reject
                    </button>
                  </div>
                </form>
              )}

              <form
                className="sheet"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act(async () => {
                    await api(`${base}/providers/${open}/decide`, {
                      method: "POST",
                      body: { check: "UNIVERSITY_REVIEW", decision: "PASS", subject: f.get("who"), confirmedWith: "ID_CARD_IN_PERSON", note: f.get("vnote") },
                    });
                    return "Vouched for. Students see this as university approved.";
                  });
                }}
              >
                <h2 style={{ fontSize: "var(--t-xl)" }}>Vouch for this provider</h2>
                <p className="muted">The strongest thing you can say about a provider: you have met them and seen their ID. Use it sparingly.</p>
                <div className="field">
                  <label htmlFor="who">Who did you meet?</label>
                  <input id="who" name="who" required minLength={1} maxLength={200} placeholder="Ada Obi, 21/300100" />
                </div>
                <div className="field">
                  <label htmlFor="vnote">How did you confirm their identity?</label>
                  <input id="vnote" name="vnote" required minLength={3} maxLength={1000} placeholder="Student ID card seen at the faculty office" />
                </div>
                <div className="row">
                  <button className="btn btn-primary" type="submit" disabled={busy}>
                    Vouch for them
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt("Why are you stopping this provider? This closes their shop and withdraws everything proven about them.");
                      if (!reason || reason.trim().length < 3) return;
                      void act(async () => {
                        await api(`${base}/providers/${open}/revoke`, { method: "POST", body: { suspend: true, reason } });
                        return "Stopped. Their shop is closed and no longer listed.";
                      });
                    }}
                  >
                    Stop this provider
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The list endpoint returns the level; the wording comes from the same rules as everywhere else. */
function badgeFor(r: Row): Trust["badge"] {
  if (r.kind === "BUSINESS") {
    return r.level === "UNIVERSITY_APPROVED"
      ? { label: "Approved print shop", detail: "", tone: "good" }
      : { label: "Not checked yet", detail: "", tone: "warn" };
  }
  const BY: Record<Trust["level"], Trust["badge"]> = {
    UNIVERSITY_APPROVED: { label: "Student, university approved", detail: "", tone: "good" },
    MATRIC_VERIFIED: { label: "Verified student", detail: "", tone: "good" },
    EMAIL_VERIFIED: { label: "Student email only", detail: "", tone: "caution" },
    UNVERIFIED: { label: "Not verified", detail: "", tone: "warn" },
  };
  return BY[r.level];
}
