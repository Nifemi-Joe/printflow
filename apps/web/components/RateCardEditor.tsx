"use client";

import { useState } from "react";
import { naira, SPEC_LABEL, when } from "@/lib/format";
import { StatusPill } from "./ui";

export interface RateCard {
  id: string;
  version: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  oddPageDuplexPolicy: string;
  minimumCharge: number;
  sheetPrices: Array<{ paperSize: string; colourMode: string; sides: string; pricePerSheet: number }>;
  finishing: Array<{ code: string; name: string; unit: string; price: number; paperSizes?: string[] }>;
}

export interface RateCardDraftInput {
  effectiveFrom: string;
  oddPageDuplexPolicy: string;
  minimumChargeKobo: number;
  sheetPrices: Array<{ paperSize: string; colourMode: string; sides: string; pricePerSheetKobo: number }>;
  finishing: Array<{ code: string; name: string; unit: string; priceKobo: number }>;
}

const toKobo = (naira: string) => Math.round(Number(naira) * 100);

export function RateCardView({ card, actions }: { card: RateCard; actions?: React.ReactNode }) {
  return (
    <div className="sheet">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Version {card.version}</h3>
        <StatusPill status={card.status === "PUBLISHED" ? "APPROVED" : card.status === "DRAFT" ? "PENDING" : "REMOVED"} label={card.status.toLowerCase()} />
      </div>
      <p className="muted">
        Effective from {when(card.effectiveFrom)}
        {card.effectiveTo ? ` until ${when(card.effectiveTo)}` : ""}. Odd page on double-sided: {card.oddPageDuplexPolicy === "CHARGE_FULL_SHEET" ? "charged as a full sheet" : "charged as single-sided"}.
        {card.minimumCharge > 0 && ` Minimum charge ${naira(card.minimumCharge)}.`}
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
        <table>
          <thead>
            <tr>
              <th scope="col">Paper</th>
              <th scope="col">Colour</th>
              <th scope="col">Sides</th>
              <th scope="col" className="num">
                Per sheet
              </th>
            </tr>
          </thead>
          <tbody>
            {card.sheetPrices.map((s) => (
              <tr key={`${s.paperSize}${s.colourMode}${s.sides}`}>
                <td>{s.paperSize}</td>
                <td>{SPEC_LABEL[s.colourMode]}</td>
                <td>{SPEC_LABEL[s.sides]}</td>
                <td className="num">{naira(s.pricePerSheet)}</td>
              </tr>
            ))}
            {card.finishing.map((f) => (
              <tr key={f.code}>
                <td colSpan={3}>
                  {f.name} <span className="muted">({f.unit === "PER_COPY" ? "per copy" : f.unit === "PER_SHEET" ? "per sheet" : "per order"})</span>
                </td>
                <td className="num">{naira(f.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {actions && (
        <div className="row" style={{ marginTop: "1rem" }}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** Drafts a new price list version. Prices are entered in naira and sent as kobo. */
export function RateCardForm({ base, onSubmit }: { base?: RateCard; onSubmit: (d: RateCardDraftInput) => Promise<void> }) {
  const [rows, setRows] = useState(
    base?.sheetPrices.map((s) => ({ ...s, price: (s.pricePerSheet / 100).toFixed(2) })) ?? [
      { paperSize: "A4", colourMode: "BW", sides: "SINGLE", price: "20.00" },
      { paperSize: "A4", colourMode: "BW", sides: "DOUBLE", price: "35.00" },
      { paperSize: "A4", colourMode: "COLOUR", sides: "SINGLE", price: "100.00" },
    ],
  );
  const [fin, setFin] = useState(
    base?.finishing.map((f) => ({ code: f.code, name: f.name, unit: f.unit, price: (f.price / 100).toFixed(2) })) ?? [{ code: "STAPLE", name: "Stapling", unit: "PER_COPY", price: "10.00" }],
  );
  const [policy, setPolicy] = useState(base?.oddPageDuplexPolicy ?? "CHARGE_FULL_SHEET");
  const [minimum, setMinimum] = useState(base ? (base.minimumCharge / 100).toFixed(2) : "0.00");
  const [from, setFrom] = useState(() => new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 16));
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="sheet"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({
            effectiveFrom: new Date(from).toISOString(),
            oddPageDuplexPolicy: policy,
            minimumChargeKobo: toKobo(minimum),
            sheetPrices: rows.map((r) => ({ paperSize: r.paperSize, colourMode: r.colourMode, sides: r.sides, pricePerSheetKobo: toKobo(r.price) })),
            finishing: fin.map((f) => ({ code: f.code, name: f.name, unit: f.unit, priceKobo: toKobo(f.price) })),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>New price list version</h3>
      <p className="muted">Publishing creates a new version. Orders already confirmed keep the price they were quoted.</p>
      <div className="field">
        <label htmlFor="rc-from">Takes effect</label>
        <input id="rc-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </div>
      <fieldset>
        <legend>Printing, per sheet (₦)</legend>
        {rows.map((r, i) => (
          <div className="row" key={i} style={{ marginBottom: "0.5rem" }}>
            <select aria-label="Paper size" value={r.paperSize} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, paperSize: e.target.value } : x)))} style={{ width: 90 }}>
              {["A4", "A3", "A5", "LETTER", "LEGAL"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select aria-label="Colour" value={r.colourMode} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, colourMode: e.target.value } : x)))} style={{ width: 150 }}>
              <option value="BW">Black & white</option>
              <option value="COLOUR">Colour</option>
            </select>
            <select aria-label="Sides" value={r.sides} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, sides: e.target.value } : x)))} style={{ width: 140 }}>
              <option value="SINGLE">Single-sided</option>
              <option value="DOUBLE">Double-sided</option>
            </select>
            <input aria-label="Price per sheet in naira" inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={r.price} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))} style={{ width: 110 }} required />
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setRows(rows.filter((_, k) => k !== i))} aria-label="Remove this price">
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setRows([...rows, { paperSize: "A3", colourMode: "BW", sides: "SINGLE", price: "50.00" }])}>
          Add a price
        </button>
      </fieldset>
      <fieldset>
        <legend>Finishing (₦)</legend>
        {fin.map((f, i) => (
          <div className="row" key={i} style={{ marginBottom: "0.5rem" }}>
            <input aria-label="Name" value={f.name} onChange={(e) => setFin(fin.map((x, k) => (k === i ? { ...x, name: e.target.value, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || x.code } : x)))} style={{ width: 180 }} required />
            <select aria-label="Charged" value={f.unit} onChange={(e) => setFin(fin.map((x, k) => (k === i ? { ...x, unit: e.target.value } : x)))} style={{ width: 140 }}>
              <option value="PER_COPY">per copy</option>
              <option value="PER_SHEET">per sheet</option>
              <option value="PER_ORDER">per order</option>
            </select>
            <input aria-label="Price in naira" inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={f.price} onChange={(e) => setFin(fin.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))} style={{ width: 110 }} required />
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setFin(fin.filter((_, k) => k !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setFin([...fin, { code: "SPIRAL_BIND", name: "Spiral binding", unit: "PER_COPY", price: "500.00" }])}>
          Add finishing
        </button>
      </fieldset>
      <div className="field">
        <label htmlFor="rc-policy">Last page of an odd-length double-sided job</label>
        <select id="rc-policy" value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="CHARGE_FULL_SHEET">Charge as a full double-sided sheet</option>
          <option value="CHARGE_AS_SINGLE_SIDED">Charge as a single-sided sheet</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="rc-min">Minimum order (₦, 0 for none)</label>
        <input id="rc-min" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        Save as draft
      </button>
    </form>
  );
}
