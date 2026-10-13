"use client";

import { METHOD_LABEL } from "@/lib/format";

export type Method = "CARD" | "BANK_TRANSFER" | "USSD";

const HINT: Record<Method, string> = {
  CARD: "Debit card (Verve, Mastercard, Visa).",
  BANK_TRANSFER: "Transfer from any bank app to a one-time account number.",
  USSD: "Dial a code from your phone. No data or app needed.",
};

/** How the student wants to pay. Only methods the installation offers are shown. */
export function PaymentMethodPicker({ methods, value, onChange }: { methods: Method[]; value: Method; onChange: (m: Method) => void }) {
  if (methods.length <= 1) return null;
  return (
    <fieldset style={{ border: 0, padding: 0, margin: "var(--space-4) 0" }}>
      <legend style={{ fontWeight: 700, marginBottom: "var(--space-2)" }}>Pay with</legend>
      <div className="stack" style={{ gap: "var(--space-2)" }}>
        {methods.map((m) => (
          <label key={m} className="choice" style={{ display: "block" }}>
            <input type="radio" name="pay-method" value={m} checked={value === m} onChange={() => onChange(m)} />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", padding: "var(--space-3) var(--space-4)", width: "100%" }}>
              <strong>{METHOD_LABEL[m]}</strong>
              <span className="muted" style={{ fontWeight: 400, fontSize: "var(--t-sm)" }}>
                {HINT[m]}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
