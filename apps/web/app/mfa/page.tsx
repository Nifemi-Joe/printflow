"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { afterSignIn, homeFor, mfaPending, useSession } from "@/lib/session";

/** Staff must verify (or first enrol) an authenticator before reaching any dashboard. */
export default function MfaPage() {
  return (
      <Suspense fallback={null}>
        <Mfa />
      </Suspense>
  );
}

function Mfa() {
  const { me, loading, refresh, signOut } = useSession();
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (loading) return;
    if (!me) router.replace("/login");
    // Already done (or not needed): carry on to where they were going.
    else if (!mfaPending(me) && me.session.mfaRequired) router.replace(afterSignIn(me, next));
  }, [loading, me, router, next]);

  if (!me) return null;
  const enrolled = me.mfa.totpEnrolled;

  async function submit(code: string) {
    setError(null);
    try {
      await api(enrolled ? "/auth/mfa/verify" : "/auth/mfa/totp/confirm", { method: "POST", body: { code } });
      const m = await refresh();
      if (m) router.replace(mfaPending(m) ? homeFor(m) : afterSignIn(m, next));
    } catch (e) {
      setError(e);
    }
  }

  return (
      <AuthFrame title={enrolled ? "Enter your authenticator code" : "Set up two-step sign-in"}>
        <p className="muted">Staff accounts can change orders, prices and payments, so they need a second step at sign-in.</p>
        {!enrolled && !setup && (
            <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    setSetup(await api("/auth/mfa/totp/setup", { method: "POST" }));
                  } catch (e) {
                    setError(e);
                  }
                }}
            >
              Start setup
            </button>
        )}
        {setup && (
            <div className="stack" style={{ marginBottom: "1rem" }}>
              <p>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS or similar), choose to add an account, and enter this key:</p>
              <p className="ticket num" style={{ fontSize: "1.2rem", letterSpacing: "0.12em", wordBreak: "break-all" }}>{setup.secret.match(/.{1,4}/g)?.join(" ")}</p>
              <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                On a phone you can also <a href={setup.otpauthUri}>open it directly in your authenticator app</a>.
              </p>
            </div>
        )}
        <ErrorNotice error={error} />
        {(enrolled || setup) && (
            <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(String(new FormData(e.currentTarget).get("code")));
                }}
            >
              <div className="field">
                <label htmlFor="code">6-digit code</label>
                <input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
              </div>
              <button className="btn btn-primary" type="submit" style={{ width: "100%" }}>
                {enrolled ? "Verify" : "Finish setup"}
              </button>
            </form>
        )}
        <p className="muted" style={{ marginTop: "1.5rem" }}>
          Signed in as {me.user.email}. Not you?{" "}
          <a
              href="/login"
              onClick={async (e) => {
                e.preventDefault();
                await signOut();
                router.replace("/login");
              }}
          >
            Sign out
          </a>
        </p>
      </AuthFrame>
  );
}
