"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PaymentMethodPicker, type Method } from "@/components/PaymentMethods";
import { ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { naira, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Entry {
    id: number;
    kind: string;
    label: string;
    amountKobo: number;
    cashKobo: number;
    promoKobo: number;
    orderId: string | null;
    orderReference: string | null;
    note: string | null;
    createdAt: string;
}

interface Wallet {
    cashKobo: number;
    promoKobo: number;
    totalKobo: number;
    limits: { maxBalanceKobo: number; topupMinKobo: number; topupMaxKobo: number; lowBalanceKobo: number };
    topUp: { available: boolean; mode: string; methods: Method[] };
    pendingTopups: Array<{ reference: string; amountKobo: number; createdAt: string }>;
    entries: Entry[];
    terms: string;
}

/** Common amounts, in naira. */
const QUICK = [500, 1000, 2000, 5000];

function TopupStatus({ reference, onDone }: { reference: string; onDone: () => void }) {
    const { data } = useData<{ status: string; amountKobo: number }>(`/me/wallet/topups/${reference}`, { pollMs: 3000 });
    useEffect(() => {
        if (data?.status === "SUCCEEDED") onDone();
    }, [data?.status, onDone]);
    if (!data) return null;
    if (data.status === "SUCCEEDED")
        return (
            <div className="notice" role="status">
                <p>
                    <strong>{naira(data.amountKobo)} added to your wallet.</strong>
                </p>
            </div>
        );
    if (data.status === "FAILED")
        return (
            <div className="notice notice-error" role="status">
                <p>That top-up didn&apos;t go through, and nothing was taken from your wallet. Try again or use another method.</p>
            </div>
        );
    return (
        <div className="notice notice-warn" role="status">
            <p>Waiting for your bank to confirm {naira(data.amountKobo)}. Transfers can take a minute or two; this page updates by itself.</p>
        </div>
    );
}

function WalletPage() {
    const params = useSearchParams();
    const router = useRouter();
    const { data: w, error, loading, reload } = useData<Wallet>("/me/wallet", { pollMs: 15_000 });
    const [amount, setAmount] = useState("1000");
    const [method, setMethod] = useState<Method | null>(null);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<unknown>(null);
    const [older, setOlder] = useState<Entry[]>([]);
    const [more, setMore] = useState(true);
    const returned = params.get("topup");

    if (loading) return <Skeleton lines={8} />;
    if (!w) return <ErrorNotice error={error} onRetry={reload} />;

    const naira100 = Math.round(Number(amount) * 100);
    const valid = Number.isFinite(naira100) && naira100 >= w.limits.topupMinKobo && naira100 <= w.limits.topupMaxKobo && Number.isInteger(Number(amount));
    const chosen = method ?? w.topUp.methods[0] ?? "CARD";
    const entries = [...w.entries, ...older.filter((o) => !w.entries.some((e) => e.id === o.id))];

    const topUp = async () => {
        setBusy(true);
        setActionError(null);
        try {
            const r = await api<{ checkoutUrl: string }>("/me/wallet/topups", { method: "POST", body: { amountKobo: naira100, method: chosen } });
            const u = new URL(r.checkoutUrl, window.location.origin);
            if (u.origin === window.location.origin) router.push(`${u.pathname}${u.search}`);
            else window.location.assign(r.checkoutUrl);
        } catch (e) {
            setActionError(e);
            setBusy(false);
        }
    };

    const loadOlder = async () => {
        const last = entries[entries.length - 1];
        if (!last) return;
        const r = await api<{ items: Entry[]; nextBefore: number | null }>(`/me/wallet/entries?limit=30&before=${last.id}`);
        setOlder((o) => [...o, ...r.items]);
        setMore(r.nextBefore !== null);
    };

    return (
        <>
            <PageHead title="Wallet" />
            {returned && <TopupStatus reference={returned} onDone={() => void reload()} />}

            <div className="grid-2" style={{ alignItems: "start" }}>
                <div>
                    <div className="ticket">
                        <h2 style={{ fontSize: "var(--t-xl)" }}>Balance</h2>
                        <p className="num" style={{ fontFamily: "var(--font-display)", fontSize: "var(--t-3xl)", color: "var(--emerald-deep)", margin: 0 }} data-testid="wallet-balance">
                            {naira(w.totalKobo)}
                        </p>
                        {w.promoKobo > 0 && (
                            <>
                                <div className="ticket-line">
                                    <span>Your money</span>
                                    <span className="num">{naira(w.cashKobo)}</span>
                                </div>
                                <div className="ticket-line">
                                    <span>Print credit from your university</span>
                                    <span className="num">{naira(w.promoKobo)}</span>
                                </div>
                            </>
                        )}
                        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "var(--t-sm)" }}>
                            {w.terms}
                        </p>
                    </div>

                    <div className="sheet" style={{ marginTop: "1.5rem" }}>
                        <h2 style={{ fontSize: "var(--t-xl)" }}>Top up</h2>
                        {!w.topUp.available ? (
                            <p className="muted">Top-ups are not available yet: payments have not been set up for this installation.</p>
                        ) : w.limits.topupMaxKobo < w.limits.topupMinKobo ? (
                            <p className="muted">Your wallet is at its {naira(w.limits.maxBalanceKobo)} limit. Spend some before topping up again.</p>
                        ) : (
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    if (valid) void topUp();
                                }}
                            >
                                <div className="choice-row" role="group" aria-label="Quick amounts" style={{ marginBottom: "var(--space-3)" }}>
                                    {QUICK.filter((n) => n * 100 <= w.limits.topupMaxKobo).map((n) => (
                                        <button type="button" key={n} className={`btn btn-small ${amount === String(n) ? "btn-primary" : "btn-quiet"}`} aria-pressed={amount === String(n)} onClick={() => setAmount(String(n))}>
                                            {naira(n * 100).replace(/\.00$/, "")}
                                        </button>
                                    ))}
                                </div>
                                <div className="field">
                                    <label htmlFor="topup-amount">Amount (₦)</label>
                                    <input
                                        id="topup-amount"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                                        aria-describedby="topup-hint"
                                        required
                                    />
                                    <p id="topup-hint" className="muted" style={{ fontSize: "var(--t-sm)" }}>
                                        Between {naira(w.limits.topupMinKobo).replace(/\.00$/, "")} and {naira(w.limits.topupMaxKobo).replace(/\.00$/, "")}, whole naira.
                                    </p>
                                </div>
                                <PaymentMethodPicker methods={w.topUp.methods} value={chosen} onChange={setMethod} />
                                <ErrorNotice error={actionError} />
                                <button className="btn btn-primary" type="submit" disabled={busy || !valid}>
                                    {busy ? "Opening checkout…" : valid ? `Top up ${naira(naira100).replace(/\.00$/, "")}` : "Top up"}
                                </button>
                            </form>
                        )}
                        {w.pendingTopups.length > 0 && (
                            <p className="muted" style={{ marginTop: "1rem", fontSize: "var(--t-sm)" }}>
                                Waiting for confirmation: {w.pendingTopups.map((p) => naira(p.amountKobo)).join(", ")}. If you paid, it will appear here automatically.
                            </p>
                        )}
                    </div>
                </div>

                <div className="sheet">
                    <h2 style={{ fontSize: "var(--t-xl)" }}>Activity</h2>
                    {entries.length === 0 ? (
                        <p className="muted">Nothing yet. Top up, then tick &ldquo;Use my wallet&rdquo; when you pay for a print.</p>
                    ) : (
                        <ul className="plain-list" aria-label="Wallet activity">
                            {entries.map((e) => (
                                <li key={e.id} className="ticket-line">
                  <span>
                    <strong>{e.label}</strong>
                      {e.orderReference && (
                          <>
                              {" "}
                              <a className="num" href={`/student/orders/${e.orderId}`}>
                                  {e.orderReference}
                              </a>
                          </>
                      )}
                      {e.promoKobo !== 0 && e.cashKobo !== 0 && <span className="muted"> (includes {naira(Math.abs(e.promoKobo))} credit)</span>}
                      {(e.kind === "PROMO_GRANT" || e.kind === "PROMO_REVOKE") && e.note && <span className="muted"> {e.note}</span>}
                      <br />
                    <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                      {when(e.createdAt)}
                    </span>
                  </span>
                                    <span className="num" style={{ color: e.amountKobo > 0 ? "var(--emerald-deep)" : undefined, fontWeight: 700 }}>
                    {e.amountKobo > 0 ? "+" : "−"}
                                        {naira(Math.abs(e.amountKobo))}
                  </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {entries.length >= 20 && more && (
                        <button className="btn btn-quiet btn-small" onClick={() => void loadOlder().catch((e: unknown) => setActionError(e instanceof ApiError ? e : null))}>
                            Show older
                        </button>
                    )}
                </div>
            </div>
            {w.topUp.mode === "TEST" && (
                <p className="muted" style={{ marginTop: "1rem" }}>
                    <StatusPill status="PENDING" label="Test mode" /> Top-ups use the simulated checkout. No money moves.
                </p>
            )}
        </>
    );
}

export default function WalletRoute() {
    return (
        <Suspense fallback={<Skeleton lines={8} />}>
            <WalletPage />
        </Suspense>
    );
}
