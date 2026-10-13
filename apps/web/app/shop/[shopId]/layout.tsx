"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { useSession } from "@/lib/session";

/** Each page and the permission it needs; people only see what they can use. */
const PAGES: Array<{ path: string; label: string; needs: string }> = [
    { path: "", label: "Queue", needs: "orders.view" },
    { path: "/history", label: "Order history", needs: "orders.view" },
    { path: "/devices", label: "Printers", needs: "orders.view" },
    { path: "/staff", label: "Staff", needs: "staff.manage" },
    { path: "/pricing", label: "Prices", needs: "pricing.manage" },
    { path: "/reports", label: "Reports", needs: "reports.view" },
    { path: "/settings", label: "Shop settings", needs: "catalogue.manage" },
];

export default function ShopLayout({ children }: { children: ReactNode }) {
    const { shopId } = useParams<{ shopId: string }>();
    const { me } = useSession();
    const base = `/shop/${shopId}`;
    const membership = me?.shopMemberships.find((m) => m.shopId === shopId);
    const items = PAGES.filter((p) => !membership || membership.permissions.includes(p.needs)).map((p) => ({ href: base + p.path, label: p.label }));
    return (
        <AppShell staff title={membership?.shopName ?? "Print shop"} items={items}>
            {children}
        </AppShell>
    );
}
