"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui";
import { useRequireSession } from "@/lib/session";

/** /shop on its own: open the first shop this person works at, or the application form. */
export default function ShopIndex() {
  const { me } = useRequireSession();
  const router = useRouter();
  useEffect(() => {
    if (!me || (me.session.mfaRequired && !me.session.mfaVerified)) return;
    router.replace(me.shopMemberships[0] ? `/shop/${me.shopMemberships[0].shopId}` : "/shop/apply");
  }, [me, router]);
  return (
    <main style={{ padding: "3rem" }}>
      <Skeleton />
    </main>
  );
}
