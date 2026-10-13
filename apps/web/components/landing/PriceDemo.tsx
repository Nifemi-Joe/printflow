"use client";

import { useId, useMemo, useState } from "react";
import { naira } from "@/lib/format";

/**
 * An interactive illustration using an example price list. It is labelled as an
 * example: real charges are only ever calculated by the server when ordering.
 */
const EXAMPLE = {
  BW: { SINGLE: 2_000, DOUBLE: 3_500 },
  COLOUR: { SINGLE: 10_000, DOUBLE: 18_000 },
  binding: 50_000,
  fixedFee: 5_000,
  feeBps: 150,
};

export function PriceDemo() {
  const id = useId();
  const [pages, setPages] = useState(24);
  const [copies, setCopies] = useState(1);
  const [colour, setColour] = useState<"BW" | "COLOUR">("BW");
  const [sides, setSides] = useState<"SINGLE" | "DOUBLE">("DOUBLE");
  const [bind, setBind] = useState(false);

  const q = useMemo(() => {
    const sheetsPerCopy = sides === "SINGLE" ? pages : Math.ceil(pages / 2);
    const sheets = sheetsPerCopy * copies;
    const print = sheets * EXAMPLE[colour][sides];
    const binding = bind ? EXAMPLE.binding * copies : 0;
    const subtotal = print + binding;
    const fee = EXAMPLE.fixedFee + Math.floor((subtotal * EXAMPLE.feeBps + 5_000) / 10_000);
    return { sheets, print, binding, fee, total: subtotal + fee };
  }, [pages, copies, colour, sides, bind]);

  return (
    <div className="demo">
      <form className="demo-controls" onSubmit={(e) => e.preventDefault()} aria-describedby={`${id}-note`}>
        <div className="field">
          <label htmlFor={`${id}-pages`}>Pages in your document</label>
          <input id={`${id}-pages`} type="number" min={1} max={500} value={pages} onChange={(e) => setPages(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-copies`}>Copies</label>
          <input id={`${id}-copies`} type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </div>
        <fieldset>
          <legend>Colour</legend>
          <div className="choice-row">
            {(["BW", "COLOUR"] as const).map((c) => (
              <label className="choice" key={c}>
                <input type="radio" name={`${id}-colour`} checked={colour === c} onChange={() => setColour(c)} />
                <span>{c === "BW" ? "Black & white" : "Colour"}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Sides</legend>
          <div className="choice-row">
            {(["SINGLE", "DOUBLE"] as const).map((s) => (
              <label className="choice" key={s}>
                <input type="radio" name={`${id}-sides`} checked={sides === s} onChange={() => setSides(s)} />
                <span>{s === "SINGLE" ? "Single-sided" : "Double-sided"}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="row" style={{ gap: "0.6rem" }}>
          <input type="checkbox" checked={bind} onChange={(e) => setBind(e.target.checked)} /> Spiral binding
        </label>
      </form>

      <div className="ticket demo-ticket" aria-live="polite">
        <h3>Example price</h3>
        <div className="ticket-line">
          <span>
            {q.sheets} sheet{q.sheets === 1 ? "" : "s"}, A4 {colour === "BW" ? "black & white" : "colour"}
          </span>
          <span className="num">{naira(q.print)}</span>
        </div>
        {bind && (
          <div className="ticket-line">
            <span>Spiral binding × {copies}</span>
            <span className="num">{naira(q.binding)}</span>
          </div>
        )}
        <div className="ticket-line">
          <span>Service fee</span>
          <span className="num">{naira(q.fee)}</span>
        </div>
        <div className="ticket-total">
          <span>Total</span>
          <span className="num">{naira(q.total)}</span>
        </div>
        <p className="muted" id={`${id}-note`} style={{ fontSize: "var(--t-sm)", marginTop: "1rem" }}>
          These are example prices. When you order, PrintFlow calculates the exact amount from your campus price list, and that is the amount you pay.
        </p>
      </div>
    </div>
  );
}
