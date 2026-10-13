"use client";

import Link from "next/link";
import { useSession } from "@/lib/session";

/** Shown on student pages until the student has confirmed a phone or an email. */
export function VerifyReminder() {
  const { me } = useSession();
  if (!me?.student || me.user.emailVerified || me.user.phoneVerified) return null;
  return (
    <div className="notice notice-warn" role="note" style={{ marginBottom: "var(--space-4)" }}>
      <p>
        Confirm your phone number or email to place orders. <Link href="/verify">Confirm now</Link>
      </p>
    </div>
  );
}
