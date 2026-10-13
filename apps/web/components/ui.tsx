"use client";

import type { ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { STATUS_LABEL, statusTone } from "@/lib/format";

export function Logo({ size = 28 }: { size?: number }) {
  // A sheet with a folded corner and an emerald print line.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 3h13l7 7v19H7z" fill="#fff" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M20 3v7h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M11 16h12M11 21h8" stroke="#0a7a55" strokeWidth="3" strokeLinecap="round" />
    </svg>
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
