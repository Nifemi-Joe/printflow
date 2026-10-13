"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { Segmented } from "@/components/Segmented";
import { ErrorNotice } from "@/components/ui";
import { api, ApiError, setCsrf } from "@/lib/api";
import { afterSignIn, useSession, type Me } from "@/lib/session";

type SignInResponse = Me & { session: { mfaEnrolled: boolean; mfaRequired: boolean; mfaVerified: boolean } };

/** Email if it has an @, otherwise treat it as a phone number. */
function identifier(raw: string): { email: string } | { phone: string } {
  const v = raw.trim();
  return v.includes("@") ? { email: v } : { phone: v };
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();
  const [mode, setMode] = useState<"password" | "code">(params.get("with") === "code" ? "code" : "password");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [needMfa, setNeedMfa] = useState(false);
  // SMS code flow
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const finish = async (res: SignInResponse) => {
    setCsrf(res.csrfToken);
    if (res.session.mfaRequired && res.session.mfaEnrolled && !res.session.mfaVerified && !needMfa) {
      setNeedMfa(true);
      setBusy(false);
      return;
    }
    const me = await refresh();
    router.replace(me ? afterSignIn(me, params.get("next")) : "/");
  };

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sentTo: string; resendAfterSeconds: number }>("/auth/otp/request", { method: "POST", body: { phone } });
      setSentTo(r.sentTo);
      setLeft(r.resendAfterSeconds);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setLeft(Number((e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 60));
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
      <>
        <Segmented
            label="How do you want to sign in?"
            hideLabel
            name="signin-mode"
            value={mode}
            onChange={(m) => (setMode(m), setError(null), setNeedMfa(false))}
            options={[
              { value: "password", label: "Password" },
              { value: "code", label: "Text me a code" },
            ]}
        />
        <ErrorNotice error={error} />

        {mode === "password" ? (
            <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  setBusy(true);
                  setError(null);
                  try {
                    await finish(
                        await api<SignInResponse>("/auth/login", {
                          method: "POST",
                          body: { ...identifier(String(f.get("identifier"))), password: f.get("password"), ...(f.get("mfaCode") ? { mfaCode: f.get("mfaCode") } : {}) },
                        }),
                    );
                  } catch (err) {
                    setError(err);
                    setBusy(false);
                  }
                }}
            >
              <div className="field">
                <label htmlFor="identifier">Email or phone number</label>
                <input id="identifier" name="identifier" autoComplete="username" required />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input id="password" name="password" type="password" autoComplete="current-password" required />
              </div>
              {needMfa && (
                  <div className="field">
                    <label htmlFor="mfaCode">Code from your authenticator app</label>
                    <input id="mfaCode" name="mfaCode" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
                  </div>
              )}
              <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
        ) : !sentTo ? (
            <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendCode();
                }}
            >
              <div className="field">
                <label htmlFor="otp-phone">Phone number</label>
                <input id="otp-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0801 234 5678" value={phone} onChange={(e) => setPhone(e.target.value)} required />
                <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                  Works once you have confirmed your number in your account.
                </p>
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy || left > 0} style={{ width: "100%" }}>
                {busy ? "Sending…" : left > 0 ? `Send again in ${left}s` : "Text me a sign-in code"}
              </button>
            </form>
        ) : (
            <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  setBusy(true);
                  setError(null);
                  try {
                    await finish(
                        await api<SignInResponse>("/auth/otp/verify", {
                          method: "POST",
                          body: { phone, code: f.get("code"), ...(f.get("mfaCode") ? { mfaCode: f.get("mfaCode") } : {}) },
                        }),
                    );
                  } catch (err) {
                    setError(err);
                    setBusy(false);
                  }
                }}
            >
              <p role="status">If {sentTo} is confirmed on a PrintFlow account, a code is on its way. It works for 10 minutes.</p>
              <div className="field">
                <label htmlFor="otp-code">6-digit code</label>
                <input id="otp-code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus style={{ letterSpacing: "0.3em", fontSize: "var(--t-xl)" }} />
              </div>
              {needMfa && (
                  <div className="field">
                    <label htmlFor="mfaCode2">Code from your authenticator app</label>
                    <input id="mfaCode2" name="mfaCode" inputMode="numeric" pattern="\d{6}" maxLength={6} required />
                  </div>
              )}
              <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <div className="row" style={{ marginTop: "var(--space-3)" }}>
                <button type="button" className="btn btn-quiet btn-small" disabled={busy || left > 0} onClick={() => void sendCode()}>
                  {left > 0 ? `Resend in ${left}s` : "Resend code"}
                </button>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => (setSentTo(null), setError(null))}>
                  Use a different number
                </button>
              </div>
            </form>
        )}
        <p style={{ marginTop: "1rem" }}>
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
      </>
  );
}

export default function LoginPage() {
  return (
      <AuthFrame
          title="Sign in"
          footer={
            <p>
              New here? <Link href="/register">Create a student account</Link>
            </p>
          }
      >
        <Suspense>
          <LoginForm />
        </Suspense>
      </AuthFrame>
  );
}
