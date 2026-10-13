"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

function Verify() {
  const token = useSearchParams().get("token") ?? "";
  const { refresh } = useSession();
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [error, setError] = useState<unknown>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api("/auth/verify-email", { method: "POST", body: { token } })
      .then(async () => {
        setState("done");
        await refresh();
      })
      .catch((e) => {
        setError(e);
        setState("failed");
      });
  }, [token, refresh]);
  if (state === "working") return <p role="status">Confirming your email…</p>;
  if (state === "failed") return <ErrorNotice error={error} />;
  return (
    <div className="notice" role="status">
      <p>Your email is confirmed. You can now place orders.</p>
      <Link href="/student/documents" className="btn btn-primary">
        Go to my documents
      </Link>
    </div>
  );
}

export default function VerifyEmail() {
  return (
    <AuthFrame title="Confirm your email">
      <Suspense>
        <Verify />
      </Suspense>
    </AuthFrame>
  );
}
