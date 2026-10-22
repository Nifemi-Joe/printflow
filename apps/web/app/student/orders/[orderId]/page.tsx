"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { PaymentMethodPicker, type Method } from "@/components/PaymentMethods";
import { TrustBadge, type Trust } from "@/components/Trust";
import { ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { METHOD_LABEL, naira, SPEC_LABEL, STATUS_LABEL, when } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Order {
  id: string;
  reference: string;
  status: string;
  totalKobo: number;
  lines: Array<{ code: string; description: string; quantity: number; amount: number }>;
  display: { total: string; subtotal: string; serviceFee: string };
  spec: { copies: number; paperSize: string; colourMode: string; sides: string; pageRanges?: string; finishingCodes: string[] };
  totalSheets: number;
  shop: { id: string; name: string };
  provider: Trust & { needsAcknowledgement: boolean; orderCapKobo: number | null; acknowledgedAt: string | null };
  pickupLocation: string;
  document: { title: string; versionNumber: number; pageCount: number };
  paymentDueAt: string;
  cancellation: "CANCEL_NO_CHARGE" | "CANCEL_WITH_REFUND" | "NOT_ELIGIBLE";
  queue: { position: number; jobsAhead: number; estimatedMinutes: number | null } | null;
  canRequestPickupCode: boolean;
  events: Array<{ from: string | null; to: string; reason: string | null; at: string }>;
  payments: Array<{ status: string; provider: string; reference: string; paidWith: string | null; requestedMethod: string | null }>;
  paymentMethods: Method[];
  refunds: Array<{ id: string; amountKobo: string; status: string; reason: string; destination: "WALLET" | "PROVIDER" }>;
  wallet: { enabled: boolean; appliedKobo: number; amountDueKobo: number; returnedKobo: number; balanceKobo: number };
  disputes: Array<{ id: string; category: string; status: string; resolutionNote: string | null }>;
}

const ACTIVE = ["AWAITING_PAYMENT", "PAID", "ACCEPTED", "PRINTING", "PAUSED", "PRINT_FAILED", "QUALITY_CHECK", "READY_FOR_PICKUP", "REFUND_PENDING"];

export default function OrderDetail() {
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const { data: o, error, loading, reload } = useData<Order>(`/orders/${orderId}`, { pollMs: 8000 });
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<Method | null>(null);
  const [useWallet, setUseWallet] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refundTo, setRefundTo] = useState<"WALLET" | "PROVIDER">("WALLET");

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton lines={8} />;
  if (!o) return <ErrorNotice error={error} onRetry={reload} />;
  const cardPaid = o.payments.some((p) => p.status === "SUCCEEDED");
  const paid = cardPaid || (o.wallet.appliedKobo > 0 && o.status !== "AWAITING_PAYMENT");
  // What the wallet would add now, and what is left for card/transfer/USSD.
  const walletOn = o.wallet.enabled && (o.wallet.appliedKobo > 0 || (useWallet && o.wallet.balanceKobo > 0));
  const fromWallet = o.wallet.appliedKobo > 0 ? o.wallet.appliedKobo : walletOn ? Math.min(o.wallet.balanceKobo, o.totalKobo) : 0;
  const due = o.totalKobo - fromWallet;

  return (
      <>
        <PageHead title={o.document.title}>
          <StatusPill status={o.status} />
        </PageHead>
        <p className="muted num">
          {o.reference}, {o.shop.name}, collect from {o.pickupLocation}
        </p>
        <p>
          <TrustBadge trust={o.provider} showDetail={o.provider.kind === "STUDENT_RUN"} />
        </p>
        <ErrorNotice error={actionError} />

        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            {o.status === "AWAITING_PAYMENT" && (
                <div className="sheet">
                  <h2 style={{ fontSize: "var(--t-xl)" }}>Pay to send this job to the shop</h2>
                  <p>Pay by {when(o.paymentDueAt)} or the order expires.</p>
                  {o.wallet.enabled && o.wallet.appliedKobo === 0 && o.wallet.balanceKobo > 0 && (
                      <label className="choice" style={{ display: "block", marginBottom: "var(--space-3)" }}>
                        <input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
                        <span style={{ padding: "var(--space-3) var(--space-4)" }}>
                    Use my wallet ({naira(o.wallet.balanceKobo)})
                  </span>
                      </label>
                  )}
                  {fromWallet > 0 && (
                      <div className="ticket" style={{ margin: "0 0 var(--space-3)" }} aria-label="How this order is paid">
                        <div className="ticket-line">
                          <span>From your wallet{o.wallet.appliedKobo > 0 ? " (set aside for this order)" : ""}</span>
                          <span className="num">{naira(fromWallet)}</span>
                        </div>
                        <div className="ticket-total">
                          <span>Left to pay</span>
                          <span className="num">{naira(due)}</span>
                        </div>
                      </div>
                  )}
                  {due > 0 && <PaymentMethodPicker methods={o.paymentMethods} value={method ?? o.paymentMethods[0] ?? "CARD"} onChange={setMethod} />}
                  <div className="row">
                    <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() =>
                            act(async () => {
                              const r = await api<{ paidFromWallet: boolean; checkoutUrl?: string }>(`/orders/${o.id}/payments`, {
                                method: "POST",
                                body: { useWallet: walletOn, ...(due > 0 ? { method: method ?? o.paymentMethods[0] ?? "CARD" } : {}) },
                              });
                              if (r.paidFromWallet || !r.checkoutUrl) return;
                              const u = new URL(r.checkoutUrl, window.location.origin);
                              if (u.origin === window.location.origin) router.push(`${u.pathname}${u.search}`);
                              else window.location.assign(r.checkoutUrl);
                            })
                        }
                    >
                      {due === 0 ? `Pay ${o.display.total} from wallet` : fromWallet > 0 ? `Pay ${naira(due)}` : `Pay ${o.display.total}`}
                    </button>
                    {o.wallet.enabled && o.wallet.balanceKobo < o.totalKobo && o.wallet.appliedKobo === 0 && (
                        <Link className="btn btn-quiet" href="/student/wallet">
                          Top up wallet
                        </Link>
                    )}
                  </div>
                </div>
            )}

            {o.queue && (
                <div className="sheet">
                  <h2 style={{ fontSize: "var(--t-xl)" }}>{o.queue.position === 1 ? "Next in the queue" : `Number ${o.queue.position} in the queue`}</h2>
                  <p className="muted">
                    {o.queue.estimatedMinutes ? `Estimated ready in about ${o.queue.estimatedMinutes} minutes, based on this shop's recent jobs.` : "The shop has not built up enough history for a time estimate yet."}
                  </p>
                </div>
            )}

            {o.canRequestPickupCode && (
                <div className="ticket" style={{ marginBottom: "1.5rem" }}>
                  <h2 style={{ fontSize: "var(--t-xl)" }}>Ready to collect</h2>
                  {code ? (
                      <>
                        <p className="pickup-code" aria-label={`Pickup code ${code.code.split("").join(" ")}`}>
                          {code.code.slice(0, 3)} {code.code.slice(3)}
                        </p>
                        <p className="muted">Show this at the counter. It works once and expires {when(code.expiresAt)}. Getting a new code cancels this one.</p>
                      </>
                  ) : (
                      <p>Get your pickup code when you are at the shop.</p>
                  )}
                  <button className="btn btn-primary" disabled={busy} onClick={() => act(async () => setCode(await api(`/orders/${o.id}/pickup-code`, { method: "POST" })))}>
                    {code ? "Get a new code" : "Show my pickup code"}
                  </button>
                </div>
            )}

            <div className="sheet">
              <h2 style={{ fontSize: "var(--t-xl)" }}>Progress</h2>
              <ol className="timeline">
                {o.events.map((e, i) => (
                    <li key={i}>
                      <strong>{STATUS_LABEL[e.to] ?? e.to}</strong> <span className="muted">{when(e.at)}</span>
                      {e.reason && <div className="muted">{e.reason}</div>}
                    </li>
                ))}
              </ol>
            </div>

            {(o.refunds.length > 0 || o.wallet.returnedKobo > 0) && (
                <div className="sheet">
                  <h2 style={{ fontSize: "var(--t-xl)" }}>Refunds</h2>
                  {o.wallet.returnedKobo > 0 && (
                      <p>
                        {naira(o.wallet.returnedKobo)} is back in your <Link href="/student/wallet">wallet</Link>, ready to use.
                      </p>
                  )}
                  {o.refunds.map((r) => (
                      <div className="ticket-line" key={r.id}>
                  <span>
                    {r.reason} <StatusPill status={r.status} />
                    <br />
                    <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
                      {r.destination === "WALLET" ? "To your PrintFlow wallet" : "Back to your card or bank (can take a few days)"}
                    </span>
                  </span>
                        <span className="num">{naira(r.amountKobo)}</span>
                      </div>
                  ))}
                </div>
            )}
          </div>

          <div>
            <div className="ticket">
              <h2 style={{ fontSize: "var(--t-xl)" }}>{paid ? "Receipt" : "Price"}</h2>
              <p className="muted">
                {o.spec.copies} cop{o.spec.copies === 1 ? "y" : "ies"}, {o.spec.paperSize}, {SPEC_LABEL[o.spec.colourMode]}, {SPEC_LABEL[o.spec.sides]}
                {o.spec.pageRanges ? `, pages ${o.spec.pageRanges}` : ""}. {o.totalSheets} sheets from version {o.document.versionNumber}.
              </p>
              {o.lines.map((l) => (
                  <div className="ticket-line" key={l.code}>
                    <span>{l.description}</span>
                    <span className="num">{naira(l.amount)}</span>
                  </div>
              ))}
              <div className="ticket-line">
                <span>Service fee</span>
                <span className="num">{o.display.serviceFee}</span>
              </div>
              <div className="ticket-total">
                <span>Total</span>
                <span className="num">{o.display.total}</span>
              </div>
              {o.wallet.appliedKobo > 0 && o.status !== "AWAITING_PAYMENT" && (
                  <p className="muted" style={{ marginTop: "0.75rem" }}>
                    {o.wallet.appliedKobo >= o.totalKobo ? "Paid from your wallet" : `${naira(o.wallet.appliedKobo)} from your wallet`}
                  </p>
              )}
              {o.payments
                  .filter((p) => p.status === "SUCCEEDED" && p.paidWith)
                  .map((p) => (
                      <p key={p.reference} className="muted" style={{ marginTop: "0.75rem" }}>
                        Paid by {METHOD_LABEL[p.paidWith!] ?? p.paidWith}
                      </p>
                  ))}
              {paid && (
                  <p style={{ marginTop: "1rem" }}>
                    <button className="btn btn-quiet btn-small" onClick={() => window.print()}>
                      Print receipt
                    </button>
                  </p>
              )}
              {o.payments.some((p) => p.provider === "TEST" && p.status === "SUCCEEDED") && <p className="muted">Test payment: no money moved.</p>}
            </div>

            <div className="sheet" style={{ marginTop: "1.5rem" }}>
              <h2 style={{ fontSize: "var(--t-xl)" }}>Need something else?</h2>
              <div className="stack">
                {o.cancellation !== "NOT_ELIGIBLE" && !cancelOpen && (
                    <button className="btn btn-danger" disabled={busy} onClick={() => setCancelOpen(true)}>
                      {o.cancellation === "CANCEL_WITH_REFUND" ? "Cancel and refund" : "Cancel order"}
                    </button>
                )}
                {o.cancellation !== "NOT_ELIGIBLE" && cancelOpen && (
                    <form
                        className="stack"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(async () => {
                            await api(`/orders/${o.id}/cancel`, { method: "POST", body: { refundTo } });
                            setCancelOpen(false);
                          });
                        }}
                    >
                      {o.cancellation === "CANCEL_WITH_REFUND" && cardPaid ? (
                          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                            <legend style={{ fontWeight: 700, marginBottom: "var(--space-2)" }}>Where should the refund go?</legend>
                            <label className="choice" style={{ display: "block", marginBottom: "var(--space-2)" }}>
                              <input type="radio" name="refund-to" checked={refundTo === "WALLET"} onChange={() => setRefundTo("WALLET")} />
                              <span style={{ padding: "var(--space-3) var(--space-4)" }}>My PrintFlow wallet (instant)</span>
                            </label>
                            <label className="choice" style={{ display: "block" }}>
                              <input type="radio" name="refund-to" checked={refundTo === "PROVIDER"} onChange={() => setRefundTo("PROVIDER")} />
                              <span style={{ padding: "var(--space-3) var(--space-4)" }}>Back to my card or bank (a few days)</span>
                            </label>
                            {o.wallet.appliedKobo > 0 && (
                                <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                                  The {naira(o.wallet.appliedKobo)} from your wallet goes back to your wallet either way.
                                </p>
                            )}
                          </fieldset>
                      ) : (
                          <p>
                            {o.wallet.appliedKobo > 0
                                ? `Cancel this order? ${naira(o.wallet.appliedKobo)} goes back to your wallet straight away.`
                                : "Cancel this order?"}
                          </p>
                      )}
                      <div className="row">
                        <button className="btn btn-danger" type="submit" disabled={busy}>
                          Yes, cancel it
                        </button>
                        <button className="btn btn-quiet" type="button" onClick={() => setCancelOpen(false)}>
                          Keep my order
                        </button>
                      </div>
                    </form>
                )}
                {!ACTIVE.includes(o.status) && (
                    <Link className="btn btn-quiet" href={`/student/print?reprint=${o.id}`}>
                      Print this again
                    </Link>
                )}
                {paid && !o.disputes.some((d) => ["OPEN", "UNDER_REVIEW"].includes(d.status)) && (
                    <button className="btn btn-quiet" onClick={() => setDisputeOpen((v) => !v)} aria-expanded={disputeOpen}>
                      Report a problem
                    </button>
                )}
              </div>
              {disputeOpen && (
                  <form
                      style={{ marginTop: "1rem" }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void act(async () => {
                          await api(`/orders/${o.id}/disputes`, { method: "POST", body: { category: f.get("category"), description: f.get("description") } });
                          setDisputeOpen(false);
                        });
                      }}
                  >
                    <div className="field">
                      <label htmlFor="cat">What went wrong</label>
                      <select id="cat" name="category">
                        <option value="QUALITY">Print quality</option>
                        <option value="WRONG_SPEC">Wrong paper, colour or sides</option>
                        <option value="NOT_RECEIVED">I did not receive my prints</option>
                        <option value="OVERCHARGED">I was charged incorrectly</option>
                        <option value="OTHER">Something else</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="desc">Details</label>
                      <textarea id="desc" name="description" minLength={10} required />
                    </div>
                    <button className="btn btn-primary" type="submit">
                      Send to the university
                    </button>
                  </form>
              )}
              {o.disputes.map((d) => (
                  <p key={d.id} style={{ marginTop: "1rem" }}>
                    Problem report: <StatusPill status={d.status} /> {d.resolutionNote}
                  </p>
              ))}
            </div>
          </div>
        </div>
      </>
  );
}
