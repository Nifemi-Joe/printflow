"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { useData } from "@/lib/use-data";

const STATUSES = ["AVAILABLE", "BUSY", "OUT_OF_PAPER", "OUT_OF_TONER", "FAULT", "OFFLINE"];
const SIZES = ["A4", "A3", "A5", "LETTER", "LEGAL"] as const;
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

interface Gap {
    field: string;
    label: string;
    cost: string;
}
interface Printer {
    id: string;
    label: string;
    serialNumber: string | null;
    make: string | null;
    model: string | null;
    colour: boolean | null;
    duplex: boolean | null;
    paperSizes: string[] | null;
    notes: string | null;
    reportedStatus: string;
    statusReportedAt: string | null;
    reportedBy: string | null;
    detailsUpdatedAt: string | null;
    gaps: Gap[];
    gapSummary: string | null;
    complete: boolean;
}
interface Payload {
    items: Printer[];
    incomplete: number;
    blockingNote: string;
}

/** The three answers to a yes/no question, when "I don't know" is a real answer. */
function Tristate({ name, legend, value, onChange, yes, no }: { name: string; legend: string; value: boolean | null; onChange: (v: boolean | null) => void; yes: string; no: string }) {
    const options: Array<[string, boolean | null]> = [
        [yes, true],
        [no, false],
        ["I'm not sure yet", null],
    ];
    return (
        <fieldset>
            <legend>{legend}</legend>
            <div className="choice-row">
                {options.map(([text, v]) => (
                    <label className="choice" key={text}>
                        <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
                        <span>{text}</span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

/** What we still don't know, and what each blank costs. Never an error. */
function Gaps({ printer }: { printer: Printer }) {
    if (printer.complete) return null;
    return (
        <div className="notice" role="note" style={{ marginTop: "var(--space-3)" }}>
            <p>{printer.gapSummary}</p>
            <ul className="plain-list" style={{ marginTop: "var(--space-2)" }}>
                {printer.gaps.map((g) => (
                    <li key={g.field} style={{ fontSize: "var(--t-sm)" }}>
                        <strong>{g.label}.</strong> {g.cost}
                    </li>
                ))}
            </ul>
        </div>
    );
}

const EMPTY = { label: "", serialNumber: "", make: "", model: "", colour: null as boolean | null, duplex: null as boolean | null, paperSizes: [] as string[], notes: "" };

export default function Printers() {
    const { shopId } = useParams<{ shopId: string }>();
    const { data, error, loading, reload } = useData<Payload>(`/shops/${shopId}/devices`);
    const [form, setForm] = useState({ ...EMPTY });
    const [editing, setEditing] = useState<string | null>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

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

    const body = (f: typeof EMPTY) => ({
        label: f.label,
        serialNumber: f.serialNumber || null,
        make: f.make || null,
        model: f.model || null,
        colour: f.colour,
        duplex: f.duplex,
        paperSizes: f.paperSizes.length ? f.paperSizes : null,
        notes: f.notes || null,
    });

    const toggleSize = (f: typeof EMPTY, s: string, on: boolean) => ({ ...f, paperSizes: on ? [...f.paperSizes, s] : f.paperSizes.filter((x) => x !== s) });

    return (
        <>
            <PageHead title="Printers" />
            <p className="muted">
                Add each printer you use for PrintFlow jobs. Tell us what you can — you can take orders straight away and fill in the rest whenever you like. PrintFlow never reads your printer
                directly; statuses here are what you report.
            </p>

            {msg && (
                <div className="notice" role="status">
                    <p>{msg}</p>
                </div>
            )}
            <ErrorNotice error={error ?? actionError} onRetry={reload} />

            {loading ? (
                <Skeleton lines={5} />
            ) : (
                <div className="grid-2" style={{ alignItems: "start" }}>
                    <div className="stack">
                        {!data?.items.length ? (
                            <Empty title="No printers added yet">Add your first printer with the form. A name is all you need to start.</Empty>
                        ) : (
                            data.items.map((p) => (
                                <div className="sheet" key={p.id}>
                                    <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
                                        <div>
                                            <strong style={{ fontSize: "var(--t-lg)" }}>{p.label}</strong>
                                            <br />
                                            <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                        {[p.make, p.model].filter(Boolean).join(" ") || "Make and model not given"}
                                                {p.serialNumber ? ` · ${p.serialNumber}` : ""}
                      </span>
                                            <br />
                                            <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                        {p.colour === null ? "Colour unknown" : p.colour ? "Prints colour" : "Black and white only"} ·{" "}
                                                {p.duplex === null ? "double-sided unknown" : p.duplex ? "prints double-sided" : "single-sided only"} ·{" "}
                                                {p.paperSizes?.length ? p.paperSizes.join(", ") : "paper sizes unknown"}
                      </span>
                                        </div>
                                        <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                                            {editing === p.id ? "Close" : "Edit details"}
                                        </button>
                                    </div>

                                    <div className="field" style={{ marginTop: "var(--space-3)", marginBottom: 0 }}>
                                        <label htmlFor={`st-${p.id}`}>Status right now</label>
                                        <select
                                            id={`st-${p.id}`}
                                            value={p.reportedStatus}
                                            disabled={busy}
                                            onChange={(e) =>
                                                void run(async () => {
                                                    await api(`/shops/${shopId}/devices/${p.id}`, { method: "PATCH", body: { reportedStatus: e.target.value } });
                                                    return `${p.label} is now ${label(e.target.value).toLowerCase()}.`;
                                                })
                                            }
                                        >
                                            {["UNKNOWN", ...STATUSES].map((s) => (
                                                <option key={s} value={s}>
                                                    {label(s)}
                                                </option>
                                            ))}
                                        </select>
                                        {p.statusReportedAt && (
                                            <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                                                Reported {relative(p.statusReportedAt)}
                                                {p.reportedBy ? ` by ${p.reportedBy}` : ""}.
                                            </p>
                                        )}
                                    </div>

                                    {p.notes && (
                                        <p className="muted" style={{ fontSize: "var(--t-sm)", marginTop: "var(--space-3)" }}>
                                            {p.notes}
                                        </p>
                                    )}

                                    <Gaps printer={p} />

                                    {editing === p.id && <EditForm printer={p} busy={busy} onSave={(f) => void run(async () => {
                                        await api(`/shops/${shopId}/devices/${p.id}`, { method: "PATCH", body: body(f) });
                                        setEditing(null);
                                        return `Saved. ${f.label} is up to date.`;
                                    })} />}
                                </div>
                            ))
                        )}
                    </div>

                    <form
                        className="sheet"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                                const added = await api<Printer>(`/shops/${shopId}/devices`, { method: "POST", body: body(form) });
                                setForm({ ...EMPTY });
                                return added.complete
                                    ? `${added.label} added.`
                                    : `${added.label} added. You can take orders with it now — there are a few details left whenever you have a moment.`;
                            });
                        }}
                    >
                        <h2 style={{ fontSize: "var(--t-xl)" }}>Add a printer</h2>
                        <p className="muted" style={{ fontSize: "var(--t-sm)" }}>Only the name is needed. Everything else can wait.</p>

                        <div className="field">
                            <label htmlFor="p-label">What do you call it?</label>
                            <input id="p-label" required maxLength={80} value={form.label} placeholder="HP in my room" onChange={(e) => setForm({ ...form, label: e.target.value })} />
                        </div>
                        <div className="field">
                            <label htmlFor="p-serial">Serial or ID number</label>
                            <input id="p-serial" maxLength={60} value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
                            <p className="muted" style={{ fontSize: "var(--t-sm)" }}>Usually on a sticker at the back or under the lid.</p>
                        </div>
                        <div className="row">
                            <div className="field" style={{ flex: 1 }}>
                                <label htmlFor="p-make">Make</label>
                                <input id="p-make" maxLength={60} value={form.make} placeholder="HP" onChange={(e) => setForm({ ...form, make: e.target.value })} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                                <label htmlFor="p-model">Model</label>
                                <input id="p-model" maxLength={60} value={form.model} placeholder="LaserJet 1020" onChange={(e) => setForm({ ...form, model: e.target.value })} />
                            </div>
                        </div>

                        <Tristate name="p-colour" legend="Can it print in colour?" value={form.colour} onChange={(v) => setForm({ ...form, colour: v })} yes="Yes, colour" no="Black and white only" />
                        <Tristate name="p-duplex" legend="Can it print on both sides?" value={form.duplex} onChange={(v) => setForm({ ...form, duplex: v })} yes="Yes, double-sided" no="One side at a time" />

                        <fieldset>
                            <legend>Paper sizes it takes</legend>
                            <div className="choice-row">
                                {SIZES.map((s) => (
                                    <label className="choice" key={s}>
                                        <input type="checkbox" checked={form.paperSizes.includes(s)} onChange={(e) => setForm(toggleSize(form, s, e.target.checked))} />
                                        <span>{s}</span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        <div className="field">
                            <label htmlFor="p-notes">Anything else students should know</label>
                            <input id="p-notes" maxLength={500} value={form.notes} placeholder="Slow on big jobs" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                        </div>

                        <button className="btn btn-primary" type="submit" disabled={busy || !form.label.trim()}>
                            Add this printer
                        </button>
                    </form>
                </div>
            )}
        </>
    );
}

/** The same questions again, filled in, for a printer that already exists. */
function EditForm({ printer, busy, onSave }: { printer: Printer; busy: boolean; onSave: (f: typeof EMPTY) => void }) {
    const [f, setF] = useState({
        label: printer.label,
        serialNumber: printer.serialNumber ?? "",
        make: printer.make ?? "",
        model: printer.model ?? "",
        colour: printer.colour,
        duplex: printer.duplex,
        paperSizes: printer.paperSizes ?? [],
        notes: printer.notes ?? "",
    });
    return (
        <form
            style={{ marginTop: "var(--space-4)", borderTop: "1px solid var(--rule)", paddingTop: "var(--space-4)" }}
            onSubmit={(e) => {
                e.preventDefault();
                onSave(f);
            }}
        >
            <div className="field">
                <label htmlFor={`e-label-${printer.id}`}>Name</label>
                <input id={`e-label-${printer.id}`} required maxLength={80} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
            </div>
            <div className="field">
                <label htmlFor={`e-serial-${printer.id}`}>Serial or ID number</label>
                <input id={`e-serial-${printer.id}`} maxLength={60} value={f.serialNumber} onChange={(e) => setF({ ...f, serialNumber: e.target.value })} />
            </div>
            <div className="row">
                <div className="field" style={{ flex: 1 }}>
                    <label htmlFor={`e-make-${printer.id}`}>Make</label>
                    <input id={`e-make-${printer.id}`} maxLength={60} value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                    <label htmlFor={`e-model-${printer.id}`}>Model</label>
                    <input id={`e-model-${printer.id}`} maxLength={60} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
                </div>
            </div>
            <Tristate name={`e-colour-${printer.id}`} legend="Can it print in colour?" value={f.colour} onChange={(v) => setF({ ...f, colour: v })} yes="Yes, colour" no="Black and white only" />
            <Tristate name={`e-duplex-${printer.id}`} legend="Can it print on both sides?" value={f.duplex} onChange={(v) => setF({ ...f, duplex: v })} yes="Yes, double-sided" no="One side at a time" />
            <fieldset>
                <legend>Paper sizes it takes</legend>
                <div className="choice-row">
                    {SIZES.map((s) => (
                        <label className="choice" key={s}>
                            <input
                                type="checkbox"
                                checked={f.paperSizes.includes(s)}
                                onChange={(e) => setF({ ...f, paperSizes: e.target.checked ? [...f.paperSizes, s] : f.paperSizes.filter((x) => x !== s) })}
                            />
                            <span>{s}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <div className="field">
                <label htmlFor={`e-notes-${printer.id}`}>Anything else students should know</label>
                <input id={`e-notes-${printer.id}`} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || !f.label.trim()}>
                Save details
            </button>
        </form>
    );
}