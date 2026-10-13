"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { PhoneVerify } from "@/components/PhoneVerify";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

/** After sign-up: confirm the email or the phone (either one unlocks ordering). */
function Verify() {
  const router = useRouter();
  const welcome = useSearchParams().get("welcome") === "1";
  const { me, loading, refresh } = useSession();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!loading && !me) router.replace("/login?next=/verify");
  }, [loading, me, router]);

  if (!me) return <AuthFrame title="Confirm it's you">{null}</AuthFrame>;
  const anyVerified = me.user.emailVerified || me.user.phoneVerified;

  return (
    <AuthFrame
      title={anyVerified ? "You're all set" : "Confirm it's you"}
      footer={
        <Link href="/student/documents" className="btn btn-primary" style={{ width: "100%" }}>
          {anyVerified ? "Start printing" : "Skip for now"}
        </Link>
      }
    >
      <p>{anyVerified ? "You can place orders now. Confirming both helps you recover your account." : "Confirm your phone number or your email. Either one lets you place orders."}</p>
      <ErrorNotice error={error} />

      <section aria-labelledby="v-phone" style={{ marginTop: "var(--space-5)" }}>
        <h2 id="v-phone" style={{ fontSize: "var(--t-lg)" }}>
          Phone {me.user.phoneVerified && <span className="pill pill-go">Confirmed</span>}
        </h2>
        <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
          Fastest: we text you a code. You'll also get a text when your prints are ready.
        </p>
        <PhoneVerify phone={me.user.phone} verified={me.user.phoneVerified} onVerified={refresh} codeAlreadySent={welcome} />
      </section>

      <section aria-labelledby="v-email" style={{ marginTop: "var(--space-6)" }}>
        <h2 id="v-email" style={{ fontSize: "var(--t-lg)" }}>
          Email {me.user.emailVerified && <span className="pill pill-go">Confirmed</span>}
        </h2>
        {me.user.emailVerified ? (
          <p>{me.user.email}</p>
        ) : (
          <>
            <p>
              We sent a link to <strong>{me.user.email}</strong>. Open it on any device.
            </p>
            {sent ? (
              <p role="status">A new link is on its way.</p>
            ) : (
              <button
                className="btn btn-quiet btn-small"
                onClick={async () => {
                  setError(null);
                  try {
                    await api("/auth/verify-email/resend", { method: "POST" });
                    setSent(true);
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Send the link again
              </button>
            )}
            <button className="btn btn-quiet btn-small" style={{ marginLeft: "var(--space-2)" }} onClick={() => void refresh()}>
              I've clicked it
            </button>
          </>
        )}
      </section>
    </AuthFrame>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
