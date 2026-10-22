"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api, newIdempotencyKey } from "@/lib/api";
import { naira, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Credit {
    items: Array<{ id: number; kind: string; amountKobo: number; note: string | null; createdAt: string; studentName: string; studentEmail: string; byName: string | null }>;
    grantedNetKobo: number;
    unspentKobo: number;
    maxGrantKobo: number;
}

interface Overview {
    university: { welcomeCreditKobo: number };
    myRole: string;
    wallet: { studentCashKobo: number; studentPromoKobo: number; topUpsLast30DaysKobo: number; spentLast30DaysKobo: number };
}

const KIND: Record<string, string> = { PROMO_GRANT: "Given", PROMO_REVOKE: "Taken back", WELCOME_CREDIT: "Welcome credit" };

/**
 * Print credit: money the university gives students to spend on printing (welcome
 * credit, rewards, raffles). It is used before the student's own money and is never
 * paid out as cash.
 */
export default function PrintCredit() {
    const { universityId } = useParams<{ universityId: string }>();
    const base = `/admin/universities/${universityId}`;
    const list = useData<Credit>(`${base}/wallet/credit`);
    const ov = useData<Overview>(`${base}/overview`);
    const [msg, setMsg] = useState<string | null>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [by, setBy] = useState<"email" | "matric">("email");
    const [busy, setBusy] = useState(false);

    if (list.loading || ov.loading) return <Skeleton lines={6} />;
    const canEdit = ov.data?.myRole !== "UNIVERSITY_SUPPORT";

    const submit = async (form: HTMLFormElement, revoke: boolean) => {
        const f = new FormData(form);
        const who = String(f.get("who") ?? "").trim();
        const amountKobo = Math.round(Number(f.get("amount")) * 100);
        setBusy(true);
        setMsg(null);
        setActionError(null);
        try {
            const r = await api<{ student: { name: string }; amountKobo: number; studentCreditKobo: number }>(`${base}/wallet/credit${revoke ? "/revoke" : ""}`, {
                method: "POST",
                body: { ...(by === "email" ? { email: who } : { matricNumber: who }), amountKobo, note: String(f.get("note") ?? "") },
                headers: { "Idempotency-Key": newIdempotencyKey() },
            });
            setMsg(`${revoke ? "Took back" : "Gave"} ${naira(r.amountKobo)} ${revoke ? "from" : "to"} ${r.student.name}. Their unspent credit is now ${naira(r.studentCreditKobo)}.`);
            form.reset();
            await list.reload();
            await ov.reload();
        } catch (e) {
            setActionError(e);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <PageHead title="Print credit" />
            <p className="muted">Credit you give students is spent on printing before their own money, and is never paid out as cash.</p>
            {msg && (
                <div className="notice" role="status">
                    <p>{msg}</p>
                </div>
            )}
            <ErrorNotice error={list.error ?? ov.error ?? actionError} />

            <div className="grid-2" style={{ alignItems: "start" }}>
                <div>
                    {canEdit && (
                        <form
                            className="sheet"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                                void submit(e.currentTarget, submitter?.value === "revoke");
                            }}
                        >
                            <h2 style={{ fontSize: "var(--t-xl)" }}>Give credit to a student</h2>
                            <div className="choice-row" role="radiogroup" aria-label="Find the student by" style={{ marginBottom: "var(--space-3)" }}>
                                <label className="choice">
                                    <input type="radio" name="by" checked={by === "email"} onChange={() => setBy("email")} />
                                    <span>Email</span>
                                </label>
                                <label className="choice">
                                    <input type="radio" name="by" checked={by === "matric"} onChange={() => setBy("matric")} />
                                    <span>Matric number</span>
                                </label>
                            </div>
                            <div className="field">
                                <label htmlFor="who">{by === "email" ? "Student's email" : "Student's matric number"}</label>
                                <input id="who" name="who" type={by === "email" ? "email" : "text"} required />
                            </div>
                            <div className="field">
                                <label htmlFor="amount">Amount (₦)</label>
                                <input id="amount" name="amount" type="number" min={1} max={(list.data?.maxGrantKobo ?? 1_000_000) / 100} step={1} required />
                            </div>
                            <div className="field">
                                <label htmlFor="note">Reason (the student sees this)</label>
                                <input id="note" name="note" minLength={3} maxLength={300} required placeholder="Exam week thank-you" />
                            </div>
                            <div className="row">
                                <button className="btn btn-primary" type="submit" value="grant" disabled={busy}>
                                    Give credit
                                </button>
                                <button className="btn btn-quiet" type="submit" value="revoke" disabled={busy}>
                                    Take back unspent credit
                                </button>
                            </div>
                        </form>
                    )}

                    {canEdit && (
                        <form
                            className="sheet"
                            style={{ marginTop: "1.5rem" }}
                            onSubmit={(e) => {
                                e.preventDefault();
                                const f = new FormData(e.currentTarget);
                                setActionError(null);
                                setMsg(null);
                                api(`${base}/settings`, { method: "PATCH", body: { welcomeCreditKobo: Math.round(Number(f.get("welcome")) * 100) } })
                                    .then(() => {
                                        setMsg("Welcome credit saved.");
                                        return ov.reload();
                                    })
                                    .catch(setActionError);
                            }}
                        >
                            <h2 style={{ fontSize: "var(--t-xl)" }}>Welcome credit</h2>
                            <p className="muted">Given once to each new student when they confirm their phone number. Set to 0 to switch it off.</p>
                            <div className="field">
                                <label htmlFor="welcome">Amount (₦)</label>
                                <input id="welcome" name="welcome" type="number" min={0} max={5000} step={1} defaultValue={(ov.data?.university.welcomeCreditKobo ?? 0) / 100} />
                            </div>
                            <button className="btn btn-primary" type="submit">
                                Save welcome credit
                            </button>
                        </form>
                    )}
                </div>

                <div>
                    {ov.data && (
                        <div className="ticket" style={{ marginBottom: "1.5rem" }}>
                            <h2 style={{ fontSize: "var(--t-xl)" }}>Student wallets</h2>
                            <div className="ticket-line">
                                <span>Students&apos; own money held</span>
                                <span className="num">{naira(ov.data.wallet.studentCashKobo)}</span>
                            </div>
                            <div className="ticket-line">
                                <span>Unspent print credit</span>
                                <span className="num">{naira(ov.data.wallet.studentPromoKobo)}</span>
                            </div>
                            <div className="ticket-line">
                                <span>Top-ups, last 30 days</span>
                                <span className="num">{naira(ov.data.wallet.topUpsLast30DaysKobo)}</span>
                            </div>
                            <div className="ticket-line">
                                <span>Spent on printing, last 30 days</span>
                                <span className="num">{naira(ov.data.wallet.spentLast30DaysKobo)}</span>
                            </div>
                        </div>
                    )}
                    <div className="sheet">
                        <h2 style={{ fontSize: "var(--t-xl)" }}>Recent credit</h2>
                        {!list.data?.items.length ? (
                            <p className="muted">No credit given yet.</p>
                        ) : (
                            <ul className="plain-list" aria-label="Recent credit">
                                {list.data.items.map((i) => (
                                    <li key={i.id} className="ticket-line">
                    <span>
                      <strong>{KIND[i.kind] ?? i.kind}</strong> {i.studentName}
                        {i.note && i.kind !== "WELCOME_CREDIT" && <span className="muted"> {i.note}</span>}
                        <br />
                      <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                        {when(i.createdAt)}
                          {i.byName ? `, by ${i.byName}` : ""}
                      </span>
                    </span>
                                        <span className="num">{naira(i.amountKobo)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
