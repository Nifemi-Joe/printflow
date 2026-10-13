"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PaymentMethodPicker, type Method } from "@/components/PaymentMethods";
import { PowerBadge, type Power } from "@/components/Power";
import { Empty, ErrorNotice, Field, PageHead, Skeleton } from "@/components/ui";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { naira } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

interface Doc {
  id: string;
  title: string;
  latestVersion: { id: string; status: string; pageCount: number | null; pageSize: string | null };
}
interface Shop {
  id: string;
  name: string;
  acceptingOrders: boolean;
  locationNote: string | null;
  campus: { id: string; name: string };
  pickupLocations: Array<{ id: string; name: string }>;
  queue: { jobsAhead: number; estimatedMinutes: number | null; basis: string };
  devicesReported: Record<string, number>;
  power: Power | null;
}
interface PriceList {
  configured: boolean;
  message?: string;
  sheetPrices?: Array<{ paperSize: string; colourMode: string; sides: string; pricePerSheet: number }>;
  finishing?: Array<{ code: string; name: string; unit: string; price: number; paperSizes?: string[] }>;
  oddPageDuplexPolicy?: string;
}
interface Quote {
  id: string;
  lines: Array<{ code: string; description: string; quantity: number; amount: number }>;
  subtotalKobo: number;
  serviceFeeKobo: number;
  totalKobo: number;
  totalSheets: number;
  expiresAt: string;
  checkout: "LIVE" | "TEST" | "DISABLED";
  paymentMethods: Method[];
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return s === 0 ? <span style={{ color: "var(--red)" }}>This price has expired. Get a fresh price.</span> : <span>This price is held for {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

function Wizard() {
  const params = useSearchParams();
  const router = useRouter();
  const { me } = useSession();
  const docs = useData<{ items: Doc[] }>("/documents");
  const shops = useData<{ items: Shop[] }>(me?.student ? `/universities/${me.student.universityId}/shops` : null);
  const [versionId, setVersionId] = useState(params.get("document") ?? "");
  const [shopId, setShopId] = useState("");
  const prices = useData<PriceList>(shopId ? `/shops/${shopId}/price-list` : null);
  const [spec, setSpec] = useState({ pageRanges: "", copies: 1, paperSize: "A4", colourMode: "BW", sides: "SINGLE", finishingCodes: [] as string[] });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pickup, setPickup] = useState("");
  const [method, setMethod] = useState<Method>("CARD");
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const idemKey = useRef(newIdempotencyKey());
  const reprintOf = params.get("reprint") ?? undefined;

  const ready = docs.data?.items.filter((d) => d.latestVersion.status === "READY") ?? [];
  const doc = ready.find((d) => d.latestVersion.id === versionId);
  const shop = shops.data?.items.find((s) => s.id === shopId);

  // Prefill a reprint from the earlier order's spec.
  useEffect(() => {
    if (!reprintOf) return;
    api<{ spec: typeof spec & { documentPageCount: number }; shop: { id: string }; document: { versionId: string } }>(`/orders/${reprintOf}`)
      .then((o) => {
        setVersionId((v) => v || o.document.versionId);
        setShopId(o.shop.id);
        setSpec({ pageRanges: o.spec.pageRanges ?? "", copies: o.spec.copies, paperSize: o.spec.paperSize, colourMode: o.spec.colourMode, sides: o.spec.sides, finishingCodes: o.spec.finishingCodes ?? [] });
      })
      .catch(() => undefined);
  }, [reprintOf]);

  const offered = useMemo(() => {
    const sp = prices.data?.sheetPrices ?? [];
    return {
      sizes: [...new Set(sp.map((s) => s.paperSize))],
      colours: [...new Set(sp.filter((s) => s.paperSize === spec.paperSize).map((s) => s.colourMode))],
      sides: [...new Set(sp.filter((s) => s.paperSize === spec.paperSize && s.colourMode === spec.colourMode).map((s) => s.sides))],
      finishing: (prices.data?.finishing ?? []).filter((f) => !f.paperSizes || f.paperSizes.includes(spec.paperSize)),
    };
  }, [prices.data, spec.paperSize, spec.colourMode]);

  // Any change to the inputs invalidates the price.
  useEffect(() => setQuote(null), [versionId, shopId, spec]);
  useEffect(() => {
    if (shop?.pickupLocations[0] && !shop.pickupLocations.some((p) => p.id === pickup)) setPickup(shop.pickupLocations[0].id);
  }, [shop, pickup]);

  async function getQuote() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const q = await api<Quote>("/quotes", {
        method: "POST",
        body: { documentVersionId: versionId, shopId, spec: { ...spec, pageRanges: spec.pageRanges.trim() || undefined } },
      });
      setQuote(q);
      if (!q.paymentMethods.includes(method)) setMethod(q.paymentMethods[0] ?? "CARD");
      idemKey.current = newIdempotencyKey();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError) setFieldErrors(e.fieldErrors());
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndPay() {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api<{ id: string }>("/orders", {
        method: "POST",
        body: { quoteId: quote.id, pickupLocationId: pickup, ...(reprintOf ? { reprintOfOrderId: reprintOf } : {}) },
        headers: { "Idempotency-Key": idemKey.current },
      });
      if (quote.checkout === "DISABLED") {
        router.push(`/student/orders/${order.id}`);
        return;
      }
      const pay = await api<{ checkoutUrl: string }>(`/orders/${order.id}/payments`, { method: "POST", body: { method } });
      const u = new URL(pay.checkoutUrl, window.location.origin);
      if (u.origin === window.location.origin) router.push(`${u.pathname}${u.search}`);
      else window.location.assign(pay.checkoutUrl);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  if (docs.loading || shops.loading) return <Skeleton lines={6} />;
  if (ready.length === 0)
    return (
      <Empty title="Nothing ready to print" action={<Link className="btn btn-primary" href="/student/documents">Upload a document</Link>}>
        Upload a PDF or Word file first. It is ready to print once it has been checked.
      </Empty>
    );

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="sheet">
        <ErrorNotice error={error} />
        <Field id="doc" label="Document">
          <select id="doc" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            <option value="">Choose a document</option>
            {ready.map((d) => (
              <option key={d.latestVersion.id} value={d.latestVersion.id}>
                {d.title} ({d.latestVersion.pageCount} pages)
              </option>
            ))}
          </select>
        </Field>

        <fieldset>
          <legend>Shop</legend>
          {shops.data?.items.length === 0 && <p className="muted">No print shops are open at your university yet.</p>}
          <div className="stack">
            {shops.data?.items.map((s) => (
              <label key={s.id} className="choice" style={{ display: "block" }}>
                <input type="radio" name="shop" checked={shopId === s.id} disabled={!s.acceptingOrders} onChange={() => setShopId(s.id)} />
                <span style={{ display: "block", padding: "0.75rem 1rem", minHeight: 0 }}>
                  <strong>{s.name}</strong> <span className="muted">{s.campus.name}</span>
                  <br />
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {!s.acceptingOrders
                      ? "Not taking orders right now"
                      : s.queue.jobsAhead === 0
                        ? "No queue"
                        : `${s.queue.jobsAhead} job${s.queue.jobsAhead === 1 ? "" : "s"} ahead${s.queue.estimatedMinutes ? `, about ${s.queue.estimatedMinutes} min` : ""}`}
                    {s.locationNote ? `. ${s.locationNote}` : ""}
                  </span>
                  {s.power && s.power.status !== "UNKNOWN" && (
                    <>
                      <br />
                      <PowerBadge power={s.power} />
                    </>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {shopId && prices.data && !prices.data.configured && <div className="notice notice-warn"><p>{prices.data.message}</p></div>}

        {shopId && prices.data?.configured && (
          <>
            <Field id="ranges" label="Pages to print" hint={`Leave empty for all ${doc?.latestVersion.pageCount ?? ""} pages, or enter ranges like 1-5, 8`} error={fieldErrors["spec.pageRanges"]}>
              <input id="ranges" value={spec.pageRanges} placeholder="All pages" onChange={(e) => setSpec({ ...spec, pageRanges: e.target.value })} />
            </Field>
            <Field id="copies" label="Copies" error={fieldErrors["spec.copies"]}>
              <input id="copies" type="number" min={1} max={500} value={spec.copies} onChange={(e) => setSpec({ ...spec, copies: Math.max(1, Number(e.target.value) || 1) })} />
            </Field>
            <fieldset>
              <legend>Paper size</legend>
              <div className="choice-row">
                {offered.sizes.map((v) => (
                  <label className="choice" key={v}>
                    <input type="radio" name="size" checked={spec.paperSize === v} onChange={() => setSpec({ ...spec, paperSize: v })} />
                    <span>{v}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Colour</legend>
              <div className="choice-row">
                {offered.colours.map((v) => (
                  <label className="choice" key={v}>
                    <input type="radio" name="colour" checked={spec.colourMode === v} onChange={() => setSpec({ ...spec, colourMode: v })} />
                    <span>{v === "BW" ? "Black & white" : "Colour"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Sides</legend>
              <div className="choice-row">
                {offered.sides.map((v) => (
                  <label className="choice" key={v}>
                    <input type="radio" name="sides" checked={spec.sides === v} onChange={() => setSpec({ ...spec, sides: v })} />
                    <span>{v === "SINGLE" ? "Single-sided" : "Double-sided"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {offered.finishing.length > 0 && (
              <fieldset>
                <legend>Finishing</legend>
                {offered.finishing.map((f) => (
                  <label key={f.code} className="row" style={{ marginBottom: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={spec.finishingCodes.includes(f.code)}
                      onChange={(e) => setSpec({ ...spec, finishingCodes: e.target.checked ? [...spec.finishingCodes, f.code] : spec.finishingCodes.filter((c) => c !== f.code) })}
                    />
                    {f.name}{" "}
                    <span className="muted">
                      {naira(f.price)} {f.unit === "PER_COPY" ? "per copy" : f.unit === "PER_SHEET" ? "per sheet" : "per order"}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <button className="btn btn-primary" disabled={!versionId || busy} onClick={getQuote}>
              {busy && !quote ? "Calculating…" : "Get exact price"}
            </button>
          </>
        )}
      </div>

      <div>
        {quote ? (
          <div className="ticket" aria-live="polite">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Your price</h2>
            {quote.lines.map((l) => (
              <div className="ticket-line" key={l.code}>
                <span>
                  {l.description}
                  {l.quantity > 1 ? ` × ${l.quantity}` : ""}
                </span>
                <span className="num">{naira(l.amount)}</span>
              </div>
            ))}
            <div className="ticket-line">
              <span>Service fee</span>
              <span className="num">{naira(quote.serviceFeeKobo)}</span>
            </div>
            <div className="ticket-total">
              <span>Total</span>
              <span className="num">{naira(quote.totalKobo)}</span>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem", fontSize: "var(--t-sm)" }}>
              <Countdown until={quote.expiresAt} />
            </p>
            {shop && (
              <Field id="pickup" label="Collect from">
                <select id="pickup" value={pickup} onChange={(e) => setPickup(e.target.value)}>
                  {shop.pickupLocations.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {quote.checkout === "DISABLED" && (
              <div className="notice notice-warn">
                <p>Online payment is not switched on for this installation yet, so orders cannot be paid at the moment.</p>
              </div>
            )}
            {shop?.power?.status === "OUTAGE" && (
              <div className="notice notice-warn">
                <p>
                  {shop.name} has reported no power{shop.power.backAt && !shop.power.overdue ? "" : " right now"}. You can still order; printing starts when power is back.
                </p>
              </div>
            )}
            {quote.checkout !== "DISABLED" && <PaymentMethodPicker methods={quote.paymentMethods} value={method} onChange={setMethod} />}
            {quote.checkout === "TEST" && (
              <div className="notice notice-warn">
                <p>Test mode: payment is simulated and no money moves.</p>
              </div>
            )}
            <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy || !pickup || new Date(quote.expiresAt) < new Date()} onClick={confirmAndPay}>
              {busy ? "Placing order…" : `Confirm and pay ${naira(quote.totalKobo)}`}
            </button>
          </div>
        ) : (
          <div className="empty">
            <h3>Price appears here</h3>
            <p className="muted">Choose a document, a shop and your options, then get the exact price. Nothing is charged until you confirm.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PrintPage() {
  return (
    <>
      <PageHead title="Print something" />
      <Suspense fallback={<Skeleton />}>
        <Wizard />
      </Suspense>
    </>
  );
}
