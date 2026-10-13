"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { Segmented } from "@/components/Segmented";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";

export default function ForgotPassword() {
  const router = useRouter();
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [done, setDone] = useState(false);
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Reset your password" footer={<Link href="/login">Back to sign in</Link>}>
      <Segmented
        label="How should we reach you?"
        hideLabel
        name="reset-mode"
        value={mode}
        onChange={(m) => (setMode(m), setError(null), setDone(false), setSentTo(null))}
        options={[
          { value: "email", label: "By email" },
          { value: "phone", label: "By text message" },
        ]}
      />
      <ErrorNotice error={error} />
      {mode === "email" ? (
        done ? (
          <div className="notice" role="status">
            <p>If an account exists for that email, a reset link is on its way. The link works for one hour.</p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const email = new FormData(e.currentTarget).get("email");
              void run(async () => {
                await api("/auth/password-reset/request", { method: "POST", body: { email } });
                setDone(true);
              });
            }}
          >
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
              Send reset link
            </button>
          </form>
        )
      ) : !sentTo ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api<{ sentTo: string }>("/auth/password-reset/request", { method: "POST", body: { phone } });
              setSentTo(r.sentTo);
            });
          }}
        >
          <div className="field">
            <label htmlFor="reset-phone">Phone number</label>
            <input id="reset-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0801 234 5678" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
              Only for numbers you have confirmed on your account.
            </p>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            Text me a code
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(async () => {
              await api("/auth/password-reset/confirm", { method: "POST", body: { phone, code: f.get("code"), newPassword: f.get("newPassword") } });
              router.replace("/login?reset=1");
            });
          }}
        >
          <p role="status">If {sentTo} is confirmed on a PrintFlow account, a code is on its way.</p>
          <div className="field">
            <label htmlFor="reset-code">6-digit code</label>
            <input id="reset-code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="newPassword">New password</label>
            <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            Set new password
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
