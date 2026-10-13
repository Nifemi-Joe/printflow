"use client";

import { useEffect, useState } from "react";
import { ErrorNotice } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

interface CodeSent {
  sentTo: string | null;
  resendAfterSeconds?: number;
  alreadyVerified?: boolean;
}

function maskPhone(p: string): string {
  return /^\+234\d{10}$/.test(p) ? `+234 ${p.slice(4, 7)} ••• ${p.slice(-4)}` : `${p.slice(0, 3)} ••• ${p.slice(-4)}`;
}

/** Shows a 60-second countdown after a code is sent, so people don't hammer "resend". */
function useCountdown(initial = 0) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft] as const;
}

/**
 * Add or change a phone number and confirm it with the 6-digit code we text.
 * Used after registration and on the account page.
 */
export function PhoneVerify({
  phone,
  verified,
  onVerified,
  codeAlreadySent,
}: {
  phone: string | null;
  verified: boolean;
  onVerified: () => Promise<unknown> | void;
  /** True right after sign-up, when a code has just been texted: go straight to code entry. */
  codeAlreadySent?: boolean;
}) {
  const [number, setNumber] = useState(phone ?? "");
  const [sentTo, setSentTo] = useState<string | null>(codeAlreadySent && phone && !verified ? maskPhone(phone) : null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [left, setLeft] = useCountdown(codeAlreadySent ? 60 : 0);
  const [editing, setEditing] = useState(!phone);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<CodeSent>("/me/phone", { method: "POST", body: { phone: number } });
      if (r.alreadyVerified) {
        await onVerified();
      } else {
        setSentTo(r.sentTo);
        setLeft(r.resendAfterSeconds ?? 60);
        setEditing(false);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setLeft(Number((e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 60));
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/me/phone/verify", { method: "POST", body: { code } });
      setCode("");
      setSentTo(null);
      await onVerified();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (verified && !editing) {
    return (
      <div>
        <p>
          <strong>{phone}</strong> <span className="pill pill-go">Confirmed</span>
        </p>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => (setEditing(true), setNumber(""))}>
          Use a different number
        </button>
      </div>
    );
  }

  return (
    <div>
      <ErrorNotice error={error} />
      {!sentTo ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="field">
            <label htmlFor="pv-phone">Phone number</label>
            <input id="pv-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0801 234 5678" value={number} onChange={(e) => setNumber(e.target.value)} required />
            <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
              We text you a 6-digit code. Nigerian numbers can start with 0.
            </p>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || left > 0 || number.trim().length < 7}>
            {busy ? "Sending…" : left > 0 ? `Send again in ${left}s` : "Text me a code"}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p role="status">We sent a code to {sentTo}. It works for 10 minutes.</p>
          <div className="field">
            <label htmlFor="pv-code">6-digit code</label>
            <input
              id="pv-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              autoFocus
              style={{ letterSpacing: "0.3em", fontSize: "var(--t-xl)", maxWidth: 220 }}
            />
          </div>
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Confirm number"}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy || left > 0} onClick={() => void send()}>
              {left > 0 ? `Resend in ${left}s` : "Resend code"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => (setSentTo(null), setEditing(true))}>
              Change number
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
