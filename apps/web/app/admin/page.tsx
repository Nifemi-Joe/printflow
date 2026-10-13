"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui";
import { homeFor, useRequireSession } from "@/lib/session";

/** /admin on its own: open the first university this person administers. */
export default function AdminIndex() {
  const { me } = useRequireSession();
  const router = useRouter();
  useEffect(() => {
    if (!me || (me.session.mfaRequired && !me.session.mfaVerified)) return;
    router.replace(me.universityRoles[0] ? `/admin/${me.universityRoles[0].universityId}` : homeFor(me));
  }, [me, router]);
  return (
    <main style={{ padding: "3rem" }}>
      <Skeleton />
    </main>
  );
}
