"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { relative, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

const KIND_LABEL: Record<string, string> = { UNIVERSITY: "A university", PRINT_SHOP: "A print shop", STUDENT: "A student", OTHER: "Something else" };
const STATUS_LABEL: Record<string, string> = {
    NEW: "New",
    OPEN: "Being handled",
    WAITING_ON_THEM: "Waiting on them",
    ESCALATED: "Escalated",
    CONVERTED: "Onboarded",
    CLOSED: "Closed",
    SPAM: "Spam",
};
const STATUSES = Object.keys(STATUS_LABEL);
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

interface Row {
    id: string;
    reference: string;
    kind: string;
    status: string;
    priority: string;
    name: string;
    email: string;
    phone: string | null;
    organisation: string | null;
    role: string | null;
    createdAt: string;
    waitingHours: number;
    overdue: boolean;
    answered: boolean;
    assignedName?: string | null;
    convertedUniversityId: string | null;
}
interface Event {
    id: number;
    kind: string;
    body: string | null;
    emailed: boolean;
    createdAt: string;
    actorName: string | null;
    details: Record<string, unknown>;
}
interface Detail extends Row {
    message: string;
    thread: Event[];
    canConvert: boolean;
}

/** How long they have been waiting, said the way a person would say it. */
function Waiting({ row }: { row: Row }) {
    if (row.answered) return <span className="muted">answered in {row.waitingHours < 1 ? "under an hour" : `${Math.round(row.waitingHours)}h`}</span>;
    const text = row.waitingHours < 1 ? "just now" : `waiting ${Math.round(row.waitingHours)}h`;
    return row.overdue ? <strong style={{ color: "var(--red)" }}>{text}</strong> : <span className="muted">{text}</span>;
}

export default function Enquiries() {
    const [status, setStatus] = useState("");
    const [search, setSearch] = useState("");
    const [open, setOpen] = useState<string | null>(null);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (search.trim()) qs.set("search", search.trim());
    const list = useData<{ items: Row[]; counts: Record<string, number>; overdue: number }>(`/platform/enquiries?${qs.toString()}`, { pollMs: 60_000 });
    const detail = useData<Detail>(open ? `/platform/enquiries/${open}` : null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [convertOpen, setConvertOpen] = useState(false);

    const run = async (fn: () => Promise<string | void>) => {
        setBusy(true);
        setActionError(null);
        setMsg(null);
        try {
            const m = await fn();
            if (typeof m === "string") setMsg(m);
            await detail.reload();
            await list.reload();
        } catch (e) {
            setActionError(e);
        } finally {
            setBusy(false);
        }
    };

    const d = detail.data;

    return (
        <AppShell
            staff
            title="Platform"
            items={[
                { href: "/platform", label: "Universities and health" },
                { href: "/platform/enquiries", label: "Enquiries" },
            ]}
        >
            <PageHead title="Enquiries" />
            <p className="muted">Everyone who has contacted PrintFlow without an account. Replies are emailed to them and kept on the thread.</p>

            {(list.data?.overdue ?? 0) > 0 && (
                <div className="notice notice-warn">
                    <p>
                        <strong>
                            {list.data!.overdue} {list.data!.overdue === 1 ? "person has" : "people have"} been waiting longer than we aim for.
                        </strong>{" "}
                        Universities and print shops are answered within 8 hours, everyone else within a day.
                    </p>
                </div>
            )}
            {msg && (
                <div className="notice" role="status">
                    <p>{msg}</p>
                </div>
            )}
            <ErrorNotice error={list.error ?? detail.error ?? actionError} onRetry={list.reload} />

            <div className="row" style={{ margin: "var(--space-4) 0", flexWrap: "wrap" }}>
                <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="f-status">Show</label>
                    <select id="f-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">Everything</option>
                        {STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {STATUS_LABEL[s]} {list.data?.counts[s] ? `(${list.data.counts[s]})` : ""}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
                    <label htmlFor="f-search">Find</label>
                    <input id="f-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email, organisation or ENQ-…" />
                </div>
            </div>

            {list.loading ? (
                <Skeleton lines={6} />
            ) : (
                <div className="grid-2" style={{ alignItems: "start" }}>
                    <div className="stack">
                        {!list.data?.items.length ? (
                            <Empty title="Nothing here">No enquiries match what you are looking for.</Empty>
                        ) : (
                            list.data.items.map((r) => (
                                <button key={r.id} className={`sheet ${open === r.id ? "sheet-selected" : ""}`} style={{ textAlign: "left", width: "100%", cursor: "pointer" }} onClick={() => { setOpen(r.id); setConvertOpen(false); }}>
                                    <strong>{r.name}</strong> <span className="muted">{r.organisation ?? r.email}</span>
                                    <br />
                                    <StatusPill status={r.status} label={STATUS_LABEL[r.status]} />
                                    {r.priority === "URGENT" && <span className="pill pill-bad"> Urgent</span>}
                                    {r.priority === "HIGH" && <span className="pill pill-warn"> High</span>}
                                    <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                    {" "}
                                        {KIND_LABEL[r.kind]} · <Waiting row={r} />
                  </span>
                                    <br />
                                    <span className="muted num" style={{ fontSize: "var(--t-sm)" }}>
                    {r.reference} · {relative(r.createdAt)}
                                        {r.assignedName ? ` · ${r.assignedName}` : ""}
                  </span>
                                </button>
                            ))
                        )}
                    </div>

                    <div>
                        {!d ? (
                            <Empty title="Choose an enquiry">Read it, reply, and onboard them if that is what they need.</Empty>
                        ) : (
                            <>
                                <div className="sheet">
                                    <h2 style={{ fontSize: "var(--t-xl)", marginBottom: 0 }}>{d.name}</h2>
                                    <p className="muted num" style={{ marginTop: 0 }}>
                                        {d.reference} · {KIND_LABEL[d.kind]} · {when(d.createdAt)}
                                    </p>
                                    <p>
                                        <a href={`mailto:${d.email}`}>{d.email}</a>
                                        {d.phone ? ` · ${d.phone}` : ""}
                                        {d.organisation ? ` · ${d.organisation}` : ""}
                                        {d.role ? ` · ${d.role}` : ""}
                                    </p>
                                    <p style={{ whiteSpace: "pre-wrap" }}>{d.message}</p>

                                    <div className="row" style={{ flexWrap: "wrap", marginTop: "var(--space-4)" }}>
                                        <div className="field" style={{ margin: 0 }}>
                                            <label htmlFor="d-status">Status</label>
                                            <select id="d-status" value={d.status} disabled={busy} onChange={(e) => void run(async () => {
                                                await api(`/platform/enquiries/${d.id}`, { method: "PATCH", body: { status: e.target.value } });
                                                return `Moved to ${STATUS_LABEL[e.target.value]}.`;
                                            })}>
                                                {STATUSES.map((s) => (
                                                    <option key={s} value={s}>
                                                        {STATUS_LABEL[s]}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="field" style={{ margin: 0 }}>
                                            <label htmlFor="d-priority">Priority</label>
                                            <select id="d-priority" value={d.priority} disabled={busy} onChange={(e) => void run(async () => {
                                                await api(`/platform/enquiries/${d.id}`, { method: "PATCH", body: { priority: e.target.value } });
                                                return `Priority is now ${e.target.value.toLowerCase()}.`;
                                            })}>
                                                {PRIORITIES.map((p) => (
                                                    <option key={p} value={p}>
                                                        {p.charAt(0) + p.slice(1).toLowerCase()}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>

                                    <div className="row" style={{ marginTop: "var(--space-4)" }}>
                                        {d.status !== "ESCALATED" && (
                                            <button className="btn btn-quiet btn-small" disabled={busy} onClick={() => {
                                                const reason = window.prompt("Why does this need someone senior?");
                                                if (!reason || reason.trim().length < 3) return;
                                                void run(async () => {
                                                    await api(`/platform/enquiries/${d.id}/escalate`, { method: "POST", body: { reason } });
                                                    return "Escalated, and the team has been emailed.";
                                                });
                                            }}>
                                                Escalate
                                            </button>
                                        )}
                                        {d.canConvert && (
                                            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => setConvertOpen((o) => !o)}>
                                                {convertOpen ? "Cancel" : "Onboard them"}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {convertOpen && d.canConvert && (
                                    <form className="sheet" onSubmit={(e) => {
                                        e.preventDefault();
                                        const f = new FormData(e.currentTarget);
                                        void run(async () => {
                                            const r = await api<{ unclaimed: boolean }>(`/platform/enquiries/${d.id}/convert`, {
                                                method: "POST",
                                                body: { universityName: f.get("uni") || undefined, campusName: f.get("campus") || "Main campus", note: f.get("note") || undefined },
                                            });
                                            setConvertOpen(false);
                                            return r.unclaimed
                                                ? "Set up. We are looking after this campus until the university claims it, and the shop has been told how to start."
                                                : "Set up, and they have been emailed what to do next.";
                                        });
                                    }}>
                                        <h3 style={{ fontSize: "var(--t-lg)" }}>Onboard {d.organisation ?? d.name}</h3>
                                        <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                                            {d.kind === "PRINT_SHOP"
                                                ? "If their university isn't on PrintFlow, we create it as an unclaimed campus and look after it ourselves so the shop can trade now. Nothing moves if the university joins later."
                                                : "Creates their university and first campus. They tell us who their administrators are and we give them access."}
                                        </p>
                                        <div className="field">
                                            <label htmlFor="cv-uni">University name</label>
                                            <input id="cv-uni" name="uni" defaultValue={d.organisation ?? ""} maxLength={200} />
                                        </div>
                                        <div className="field">
                                            <label htmlFor="cv-campus">First campus</label>
                                            <input id="cv-campus" name="campus" defaultValue="Main campus" maxLength={200} />
                                        </div>
                                        <div className="field">
                                            <label htmlFor="cv-note">Note for the thread (optional)</label>
                                            <input id="cv-note" name="note" maxLength={500} />
                                        </div>
                                        <button className="btn btn-primary" type="submit" disabled={busy}>
                                            Create and tell them
                                        </button>
                                    </form>
                                )}

                                <div className="sheet">
                                    <h3 style={{ fontSize: "var(--t-lg)" }}>Thread</h3>
                                    <ul className="plain-list" aria-label="Conversation">
                                        {d.thread.map((t) => (
                                            <li key={t.id} style={{ borderLeft: `3px solid ${t.kind === "REPLY" ? "var(--emerald)" : t.kind === "ESCALATED" ? "var(--red)" : "var(--rule)"}`, paddingLeft: "var(--space-3)" }}>
                        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                          {t.kind === "RECEIVED" ? "They wrote" : t.kind === "REPLY" ? `${t.actorName ?? "We"} replied` : t.kind === "NOTE" ? `${t.actorName ?? "Someone"} noted` : t.kind.toLowerCase()}
                            {" · "}
                            {when(t.createdAt)}
                            {t.kind === "NOTE" && " · not sent to them"}
                        </span>
                                                {t.body && <p style={{ whiteSpace: "pre-wrap", margin: "var(--space-1) 0 0" }}>{t.body}</p>}
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <form className="sheet" onSubmit={(e) => {
                                    e.preventDefault();
                                    const f = new FormData(e.currentTarget);
                                    const form = e.currentTarget;
                                    void run(async () => {
                                        const isNote = f.get("as") === "note";
                                        await api(`/platform/enquiries/${d.id}/${isNote ? "notes" : "reply"}`, { method: "POST", body: { body: f.get("body") } });
                                        form.reset();
                                        return isNote ? "Note added. They were not told." : `Replied to ${d.email}.`;
                                    });
                                }}>
                                    <div className="field">
                                        <label htmlFor="r-body">Write</label>
                                        <textarea id="r-body" name="body" required minLength={2} maxLength={8000} rows={5} />
                                    </div>
                                    <fieldset>
                                        <legend>Send this as</legend>
                                        <div className="choice-row">
                                            <label className="choice">
                                                <input type="radio" name="as" value="reply" defaultChecked />
                                                <span>A reply, emailed to them</span>
                                            </label>
                                            <label className="choice">
                                                <input type="radio" name="as" value="note" />
                                                <span>A private note</span>
                                            </label>
                                        </div>
                                    </fieldset>
                                    <button className="btn btn-primary" type="submit" disabled={busy}>
                                        Send
                                    </button>
                                </form>
                            </>
                        )}
                    </div>
                </div>
            )}
        </AppShell>
    );
}