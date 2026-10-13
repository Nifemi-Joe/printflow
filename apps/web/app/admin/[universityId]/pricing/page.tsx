"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { RateCardForm, RateCardView, type RateCard } from "@/components/RateCardEditor";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, SPEC_LABEL } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Data {
  campusCards: RateCard[];
  overrides: Array<{ id: string; shopName: string; kind: string; paperSize: string | null; colourMode: string | null; sides: string | null; finishingCode: string | null; priceKobo: string }>;
  bounds: { sheet: Array<{ paperSize: string; colourMode: string; sides: string; min: number; max: number }> } | null;
}

export default function AdminPricing() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const { data, error, loading, reload } = useData<Data>(`${base}/rate-cards`);
  const overview = useData<{ university: { pricingMode: string } }>(`${base}/overview`);
  const shops = useData<{ items: Array<{ id: string; name: string; status: string }> }>(`${base}/shops`);
  const [actionError, setActionError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setActionError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await reload();
      await overview.reload();
    } catch (e) {
      setActionError(e);
    }
  };

  if (loading || overview.loading) return <Skeleton lines={6} />;
  const mode = overview.data?.university.pricingMode;
  const published = data?.campusCards.find((c) => c.status === "PUBLISHED");

  return (
    <>
      <PageHead title="Prices" />
      {msg && (
        <div className="notice" role="status">
          <p>{msg}</p>
        </div>
      )}
      <ErrorNotice error={error ?? actionError} onRetry={reload} />

      <div className="sheet" style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "var(--t-xl)" }}>Who sets prices</h2>
        <fieldset>
          <legend className="sr-only">Pricing mode</legend>
          <div className="choice-row">
            {[
              ["UNIVERSITY_CONTROLLED", "The university sets one price list"],
              ["MERCHANT_CONTROLLED", "Shops set prices within limits"],
            ].map(([v, l]) => (
              <label className="choice" key={v}>
                <input type="radio" name="mode" checked={mode === v} onChange={() => run(() => api(`${base}/settings`, { method: "PATCH", body: { pricingMode: v } }), "Pricing mode changed. New quotes use it immediately.")} />
                <span>{l}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {mode === "UNIVERSITY_CONTROLLED" ? (
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="stack">
            {data?.campusCards.length === 0 && <div className="notice notice-warn"><p>No price list yet. Students cannot order until one is published.</p></div>}
            {data?.campusCards.map((c) => (
              <RateCardView
                key={c.id}
                card={c}
                actions={
                  <>
                    {c.status === "DRAFT" && (
                      <button className="btn btn-primary btn-small" onClick={() => run(() => api(`${base}/rate-cards/${c.id}/publish`, { method: "POST" }), `Version ${c.version} published.`)}>
                        Publish
                      </button>
                    )}
                    {c.status === "PUBLISHED" && (
                      <button className="btn btn-quiet btn-small" onClick={() => window.confirm("Retire this price list? Quotes stop using it immediately.") && run(() => api(`${base}/rate-cards/${c.id}/retire`, { method: "POST" }), "Retired.")}>
                        Retire
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </div>
          <div className="stack">
            <RateCardForm base={published} onSubmit={(d) => run(() => api(`${base}/rate-cards`, { method: "POST", body: d }), "Draft saved. Publish it when ready.")} />
            {published && (
              <form
                className="sheet"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const [paperSize, colourMode, sides] = String(f.get("line")).split("/");
                  void run(
                    () => api(`${base}/price-overrides`, { method: "POST", body: { kind: "SHEET", shopId: f.get("shop"), rateCardId: published.id, paperSize, colourMode, sides, priceKobo: Math.round(Number(f.get("price")) * 100) } }),
                    "Override approved.",
                  );
                }}
              >
                <h3>Approve a price for one shop</h3>
                <p className="muted">Applies to version {published.version} only.</p>
                <div className="field">
                  <label htmlFor="ov-shop">Shop</label>
                  <select id="ov-shop" name="shop" required>
                    {shops.data?.items
                      .filter((s) => s.status === "APPROVED")
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ov-line">Price line</label>
                  <select id="ov-line" name="line">
                    {published.sheetPrices.map((s) => (
                      <option key={`${s.paperSize}/${s.colourMode}/${s.sides}`} value={`${s.paperSize}/${s.colourMode}/${s.sides}`}>
                        {s.paperSize} {SPEC_LABEL[s.colourMode]?.toLowerCase()} {SPEC_LABEL[s.sides]?.toLowerCase()} (normally {naira(s.pricePerSheet)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ov-price">Price per sheet (₦)</label>
                  <input id="ov-price" name="price" inputMode="decimal" required pattern="\d+(\.\d{1,2})?" />
                </div>
                <button className="btn btn-primary" type="submit">
                  Approve override
                </button>
                {data?.overrides.map((o) => (
                  <div className="ticket-line" key={o.id}>
                    <span>
                      {o.shopName}: {o.kind === "SHEET" ? `${o.paperSize} ${SPEC_LABEL[o.colourMode ?? ""]?.toLowerCase()} ${SPEC_LABEL[o.sides ?? ""]?.toLowerCase()}` : o.finishingCode} {naira(o.priceKobo)}
                    </span>
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => run(() => api(`${base}/price-overrides/${o.id}`, { method: "DELETE" }), "Override revoked.")}>
                      Revoke
                    </button>
                  </div>
                ))}
              </form>
            )}
          </div>
        </div>
      ) : (
        <form
          className="sheet"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const keys = ["A4/BW/SINGLE", "A4/BW/DOUBLE", "A4/COLOUR/SINGLE", "A4/COLOUR/DOUBLE", "A3/BW/SINGLE", "A3/COLOUR/SINGLE"];
            const bounds = keys
              .filter((k) => f.get(`${k}-min`) && f.get(`${k}-max`))
              .map((k) => {
                const [paperSize, colourMode, sides] = k.split("/");
                return { paperSize, colourMode, sides, minKobo: Math.round(Number(f.get(`${k}-min`)) * 100), maxKobo: Math.round(Number(f.get(`${k}-max`)) * 100) };
              });
            void run(() => api(`${base}/price-bounds`, { method: "PUT", body: { bounds } }), "Price limits saved. Shops can publish prices inside them.");
          }}
        >
          <h2 style={{ fontSize: "var(--t-xl)" }}>Price limits for shops</h2>
          <p className="muted">Shops can only offer a line you set limits for, and only at a price inside them. Leave a line empty to not allow it.</p>
          {["A4/BW/SINGLE", "A4/BW/DOUBLE", "A4/COLOUR/SINGLE", "A4/COLOUR/DOUBLE", "A3/BW/SINGLE", "A3/COLOUR/SINGLE"].map((k) => {
            const [p, c, s] = k.split("/");
            const cur = data?.bounds?.sheet.find((b) => b.paperSize === p && b.colourMode === c && b.sides === s);
            return (
              <div className="row" key={k} style={{ marginBottom: "0.5rem" }}>
                <span style={{ width: 240 }}>
                  {p} {SPEC_LABEL[c!]?.toLowerCase()}, {SPEC_LABEL[s!]?.toLowerCase()}
                </span>
                <input aria-label={`${k} minimum in naira`} name={`${k}-min`} inputMode="decimal" placeholder="Min ₦" defaultValue={cur ? (cur.min / 100).toFixed(2) : ""} style={{ width: 110 }} />
                <input aria-label={`${k} maximum in naira`} name={`${k}-max`} inputMode="decimal" placeholder="Max ₦" defaultValue={cur ? (cur.max / 100).toFixed(2) : ""} style={{ width: 110 }} />
              </div>
            );
          })}
          <button className="btn btn-primary" type="submit">
            Save limits
          </button>
        </form>
      )}
    </>
  );
}
