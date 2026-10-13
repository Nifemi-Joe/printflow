"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui";
import { homeFor, useSession } from "@/lib/session";

/** Sends each person to the right workspace for their role. */
export default function Dashboard() {
  const { me, loading } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    router.replace(me ? homeFor(me) : "/login");
  }, [me, loading, router]);
  return (
    <main style={{ padding: "3rem" }}>
      <Skeleton />
    </main>
  );
}
