import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { VerifyReminder } from "@/components/VerifyReminder";

const ITEMS = [
  { href: "/student/documents", label: "Documents" },
  { href: "/student/print", label: "Print something" },
  { href: "/student/orders", label: "Orders" },
  { href: "/student/wallet", label: "Wallet" },
  { href: "/student/notifications", label: "Notifications" },
];

export default function StudentLayout({ children }: { children: ReactNode }) {
  return (
      <AppShell title="My printing" items={ITEMS}>
        <VerifyReminder />
        {children}
      </AppShell>
  );
}
