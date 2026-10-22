"use client";

import type { ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { STATUS_LABEL, statusTone } from "@/lib/format";

/**
 * The PrintFlow mark. It sits beside the wordmark almost everywhere, so it is
 * decorative by default — the word "PrintFlow" next to it is already the name, and
 * a screen reader announcing it twice is noise. Pass `label` where the mark stands
 * on its own. Sizes above 64 CSS pixels take the larger file so it stays sharp on
 * dense screens.
 */
export function Logo({ size = 28, label }: { size?: number; label?: string }) {
  return (
      <img
          src={size > 64 ? "/brand/mark-512.png" : "/brand/mark-128.png"}
          alt={label ?? ""}
          aria-hidden={label ? undefined : true}
          width={size}
          height={size}
          className="logo-mark"
          decoding="async"
      />
  );
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const tone = statusTone(status);
  return <span className={`pill ${tone === "plain" ? "" : `pill-${tone}`}`}>{label ?? STATUS_LABEL[status] ?? status.replace(/_/g, " ").toLowerCase()}</span>;
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : "Something went wrong.";
  const first = message.charAt(0).toUpperCase() + message.slice(1);
  return (
      <div className="notice notice-error" role="alert">
        <p>{first.endsWith(".") ? first : `${first}.`}</p>
        {onRetry && (
            <button type="button" className="btn btn-quiet btn-small" onClick={onRetry}>
              Try again
            </button>
        )}
      </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
      <div aria-busy="true" aria-label="Loading" className="stack">
        {Array.from({ length: lines }, (_, i) => (
            <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%`, height: i === 0 ? 24 : 16 }} />
        ))}
      </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
      <div className="empty">
        <h3>{title}</h3>
        {children && <p className="muted">{children}</p>}
        {action}
      </div>
  );
}

export function Field({
                        label,
                        hint,
                        error,
                        children,
                        id,
                      }: {
  label: string;
  hint?: string;
  error?: string;
  id: string;
  children: ReactNode;
}) {
  return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        {children}
        {hint && !error && (
            <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
        )}
        {error && (
            <span className="error" id={`${id}-error`} role="alert">
          {error}
        </span>
        )}
      </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
      <div className="page-head">
        <h1>{title}</h1>
        {children && <div className="row">{children}</div>}
      </div>
  );
}