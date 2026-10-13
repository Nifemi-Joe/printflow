"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { universityId } = useParams<{ universityId: string }>();
  const b = `/admin/${universityId}`;
  return (
    <AppShell
      staff
      title="University"
      items={[
        { href: b, label: "Overview" },
        { href: `${b}/shops`, label: "Shops" },
        { href: `${b}/pricing`, label: "Prices" },
        { href: `${b}/orders`, label: "Orders" },
        { href: `${b}/disputes`, label: "Disputes" },
        { href: `${b}/staff`, label: "Staff" },
        { href: `${b}/audit`, label: "Audit log" },
        { href: `${b}/privacy`, label: "Privacy requests" },
        { href: `${b}/settings`, label: "Settings and campuses" },
      ]}
    >
      {children}
    </AppShell>
  );
}
