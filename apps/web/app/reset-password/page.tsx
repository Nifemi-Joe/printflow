"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (done)
    return (
      <div className="notice" role="status">
        <p>Your password has been changed and every device has been signed out.</p>
        <Link href="/login" className="btn btn-primary">
          Sign in
        </Link>
      </div>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api("/auth/password-reset/confirm", { method: "POST", body: { token, newPassword: new FormData(e.currentTarget).get("password") } });
          setDone(true);
        } catch (err) {
          setError(err);
        }
      }}
    >
      {!token && <div className="notice notice-error"><p>This link is incomplete. Open the link from your email again.</p></div>}
      <ErrorNotice error={error} />
      <div className="field">
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" minLength={10} required autoComplete="new-password" />
        <span className="hint">At least 10 characters.</span>
      </div>
      <button className="btn btn-primary" type="submit" disabled={!token} style={{ width: "100%" }}>
        Save new password
      </button>
    </form>
  );
}

export default function ResetPassword() {
  return (
    <AuthFrame title="Choose a new password">
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthFrame>
  );
}
