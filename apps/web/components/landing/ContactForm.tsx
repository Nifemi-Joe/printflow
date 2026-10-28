"use client";

import { useState } from "react";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";

const KINDS = [
    { value: "UNIVERSITY", label: "I'm from a university" },
    { value: "PRINT_SHOP", label: "I run a print shop" },
    { value: "STUDENT", label: "I'm a student" },
    { value: "OTHER", label: "Something else" },
] as const;

type Kind = (typeof KINDS)[number]["value"];

/**
 * The way in for anyone without an account. It posts to PrintFlow rather than
 * opening the visitor's mail app: a `mailto:` link loses the message on any phone
 * whose owner reads mail in a browser, which is most of them, and leaves nothing
 * behind to follow up.
 */
export function ContactForm({ initialKind = "UNIVERSITY" }: { initialKind?: Kind }) {
    const [kind, setKind] = useState<Kind>(initialKind);
    const [sent, setSent] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);

    if (sent) {
        return (
            <div className="notice" role="status">
                <p>
                    <strong>Thank you — we have your message.</strong> Your reference is <span className="num">{sent}</span>, and we have emailed you a copy. Someone will read it and
                    reply.
                </p>
            </div>
        );
    }

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(true);
                setError(null);
                void (async () => {
                    try {
                        const r = await api<{ reference: string }>("/enquiries", {
                            method: "POST",
                            body: {
                                kind,
                                name: f.get("name"),
                                email: f.get("email"),
                                phone: f.get("phone") || undefined,
                                organisation: f.get("organisation") || undefined,
                                role: f.get("role") || undefined,
                                message: f.get("message"),
                                website: f.get("website") || undefined,
                            },
                        });
                        setSent(r.reference);
                    } catch (err) {
                        setError(err);
                    } finally {
                        setBusy(false);
                    }
                })();
            }}
        >
            <ErrorNotice error={error} />

            <fieldset>
                <legend>Who are you?</legend>
                <div className="choice-row">
                    {KINDS.map((k) => (
                        <label className="choice" key={k.value}>
                            <input type="radio" name="kind" checked={kind === k.value} onChange={() => setKind(k.value)} />
                            <span>{k.label}</span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <div className="field">
                <label htmlFor="c-name">Your name</label>
                <input id="c-name" name="name" required minLength={2} maxLength={120} autoComplete="name" />
            </div>
            <div className="field">
                <label htmlFor="c-email">Email</label>
                <input id="c-email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="row">
                <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="c-phone">Phone (optional)</label>
                    <input id="c-phone" name="phone" type="tel" autoComplete="tel" />
                </div>
                {kind !== "STUDENT" && (
                    <div className="field" style={{ flex: 1 }}>
                        <label htmlFor="c-role">Your role (optional)</label>
                        <input id="c-role" name="role" maxLength={120} placeholder={kind === "UNIVERSITY" ? "Director of Student Affairs" : "Owner"} />
                    </div>
                )}
            </div>
            {kind !== "OTHER" && (
                <div className="field">
                    <label htmlFor="c-org">{kind === "PRINT_SHOP" ? "Your shop, and the campus you're next to" : "Your university"}</label>
                    <input id="c-org" name="organisation" maxLength={200} required={kind !== "STUDENT"} />
                    {kind === "PRINT_SHOP" && (
                        <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                            If your university isn&apos;t on PrintFlow yet, say so — you can still start trading, and we&apos;ll look after the campus side until they join.
                        </p>
                    )}
                </div>
            )}
            <div className="field">
                <label htmlFor="c-msg">What would you like to tell us?</label>
                <textarea id="c-msg" name="message" required minLength={10} maxLength={4000} rows={5} />
            </div>

            {/* Hidden from people and from screen readers; only something filling every
          field it finds will put anything in it. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}>
                <label htmlFor="c-website">Leave this empty</label>
                <input id="c-website" name="website" tabIndex={-1} autoComplete="off" />
            </div>

            <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send message"}
            </button>
            <p className="muted" style={{ fontSize: "var(--t-sm)", marginTop: "var(--space-3)" }}>
                We use what you send only to reply to you.
            </p>
        </form>
    );
}