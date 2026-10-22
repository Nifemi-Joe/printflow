"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { mfaPending, useRequireSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

export default function ApplyShop() {
  const { me, refresh } = useRequireSession();
  const router = useRouter();
  const unis = useData<{ items: Array<{ id: string; name: string }> }>("/universities");
  const [uni, setUni] = useState("");
  const detail = useData<{ campuses: Array<{ id: string; name: string }> }>(uni ? `/universities/${uni}` : null);
  const [error, setError] = useState<unknown>(null);
  const [kind, setKind] = useState<"BUSINESS" | "STUDENT_RUN">("BUSINESS");

  return (
      <AuthFrame title="Register a print shop" footer={<Link href="/">Back to PrintFlow</Link>}>
        <p className="muted">Your university reviews every shop before it can take orders. You will be the shop&apos;s owner and can add staff afterwards.</p>
        {kind === "STUDENT_RUN" && (
            <div className="notice notice-warn">
              <p>Students will see how far your identity has been confirmed, and you will agree to keep their documents private.</p>
            </div>
        )}
        {!me ? null : (
            <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  setError(null);
                  try {
                    const r = await api<{ id: string }>("/shops", {
                      method: "POST",
                      body: { universityId: uni, campusId: f.get("campus"), name: f.get("name"), locationNote: f.get("note") || undefined, kind },
                    });
                    // Registering a shop makes you staff, so two-step sign-in starts applying
                    // immediately. Put the destination in the address bar before refreshing the
                    // session, so whichever guard runs first carries people back here afterwards.
                    const target = kind === "STUDENT_RUN" ? `/shop/${r.id}/verification` : `/shop/${r.id}/settings`;
                    window.history.replaceState(null, "", target);
                    const m = await refresh();
                    router.replace(m && mfaPending(m) ? `/mfa?next=${encodeURIComponent(target)}` : target);
                  } catch (err) {
                    setError(err);
                  }
                }}
            >
              <ErrorNotice error={error} />
              <fieldset style={{ border: 0, padding: 0, margin: "0 0 var(--space-4)" }}>
                <legend style={{ fontWeight: 700, marginBottom: "var(--space-2)" }}>What are you registering?</legend>
                <div className="stack" style={{ gap: "var(--space-2)" }}>
                  {(
                      [
                        { value: "BUSINESS", title: "A print shop or business centre", hint: "You have premises. Your university checks you before you open." },
                        { value: "STUDENT_RUN", title: "I am a student with my own printer", hint: "You print for other students. You confirm your university email and matric number; until then your shop is labelled and your orders are capped." },
                      ] as const
                  ).map((o) => (
                      <label key={o.value} className="choice" style={{ display: "block" }}>
                        <input type="radio" name="kind" checked={kind === o.value} onChange={() => setKind(o.value)} />
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", padding: "var(--space-3) var(--space-4)", width: "100%" }}>
                    <strong>{o.title}</strong>
                    <span className="muted" style={{ fontWeight: 400, fontSize: "var(--t-sm)" }}>
                      {o.hint}
                    </span>
                  </span>
                      </label>
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor="name">Shop name</label>
                <input id="name" name="name" required minLength={2} maxLength={120} />
              </div>
              <div className="field">
                <label htmlFor="uni">University</label>
                <select id="uni" value={uni} onChange={(e) => setUni(e.target.value)} required>
                  <option value="">Choose a university</option>
                  {unis.data?.items.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="campus">Campus</label>
                <select id="campus" name="campus" required disabled={!detail.data}>
                  {detail.data?.campuses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="note">Where students find you</label>
                <textarea id="note" name="note" maxLength={500} />
              </div>
              <button className="btn btn-primary" type="submit" style={{ width: "100%" }}>
                Send for approval
              </button>
            </form>
        )}
      </AuthFrame>
  );
}
