"use client";

/** A small set of mutually exclusive options shown as chips (a labelled radio group). */
export function Segmented<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  hideLabel,
}: {
  label: string;
  name: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hideLabel?: boolean;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: "0 0 var(--space-4)" }}>
      <legend className={hideLabel ? "sr-only" : undefined} style={hideLabel ? undefined : { fontWeight: 700, marginBottom: "var(--space-2)" }}>
        {label}
      </legend>
      <div className="choice-row">
        {options.map((o) => (
          <label className="choice" key={o.value}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
