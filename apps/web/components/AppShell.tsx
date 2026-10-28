"use client";

import { InstallPrompt } from "./Pwa";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { NavItem } from "@/lib/nav";
import { canOpen, homeFor, mfaPending, useRequireSession } from "@/lib/session";
import { BrandLoader } from "./Splash";
import { Logo } from "./ui";

/** The signed-in frame: role navigation on the left (a drawer on phones). */
export function AppShell({ children, title, items }: { children: ReactNode; title: string; items: NavItem[]; staff?: boolean }) {
    const { me, loading, signOut } = useRequireSession();
    const pathname = usePathname();
    const router = useRouter();
    const [open, setOpen] = useState(false);

    useEffect(() => setOpen(false), [pathname]);

    const switchers: NavItem[] = [];
    if (me?.student) switchers.push({ href: "/student/orders", label: "My printing" });
    for (const s of me?.shopMemberships ?? []) switchers.push({ href: `/shop/${s.shopId}`, label: s.shopName });
    for (const u of me?.universityRoles ?? []) switchers.push({ href: `/admin/${u.universityId}`, label: u.universityName });
    if (me?.user.platformRole) switchers.push({ href: "/platform", label: "Platform" });
    const inWorkspace = items.length > 0 && switchers.some((s) => pathname === s.href || pathname.startsWith(`${s.href.replace(/\/orders$/, "")}/`));

    return (
        <div className="shell">
            <a href="#main" className="skip-link">
                Skip to content
            </a>
            <header className="shell-top">
                <Link href="/" className="brand">
                    <Logo /> PrintFlow
                </Link>
                <button type="button" className="btn btn-quiet btn-small" aria-expanded={open} aria-controls="app-nav" onClick={() => setOpen((o) => !o)}>
                    Menu
                </button>
            </header>
            <aside className="shell-nav" id="app-nav" data-open={open}>
                <Link href="/" className="brand" style={{ marginBottom: "1.5rem" }}>
                    <Logo /> PrintFlow
                </Link>
                {items.length > 0 && (!me || canOpen(me, pathname)) && (
                    <>
                        <p className="nav-group">{title}</p>
                        <nav aria-label={title}>
                            {items.map((i) => (
                                <Link key={i.href} href={i.href} aria-current={pathname === i.href ? "page" : undefined}>
                                    {i.label}
                                </Link>
                            ))}
                        </nav>
                    </>
                )}
                {/* Always offer a way back to your workspaces from pages outside them (such as Account). */}
                {(switchers.length > 1 || (switchers.length === 1 && !inWorkspace)) && (
                    <>
                        <p className="nav-group">{inWorkspace ? "Switch to" : "Your workspaces"}</p>
                        <nav aria-label="Workspaces">
                            {switchers.map((s) => (
                                <Link key={s.href} href={s.href}>
                                    {s.label}
                                </Link>
                            ))}
                        </nav>
                    </>
                )}
                <p className="nav-group">Account</p>
                <nav aria-label="Account">
                    <Link href="/account" aria-current={pathname === "/account" ? "page" : undefined}>
                        {me?.user.fullName ?? "Account"}
                    </Link>
                    <a
                        href="/login"
                        onClick={async (e) => {
                            e.preventDefault();
                            await signOut();
                            router.replace("/login");
                        }}
                    >
                        Sign out
                    </a>
                </nav>
            </aside>
            <main id="main" className="shell-main" tabIndex={-1}>
                {/* Nothing loads until two-step sign-in is done; the guard is sending them to /mfa. */}
                {loading || !me || mfaPending(me) ? (
                    // Not full-screen: the navigation around it stays usable and in place.
                    <BrandLoader label={me && mfaPending(me) ? "Taking you to the security check…" : "Checking your account…"} />
                ) : !canOpen(me, pathname) ? (
                    <div className="sheet" role="alert">
                        <h1 style={{ fontSize: "var(--t-xl)" }}>This page isn't part of your account</h1>
                        <p>
                            You're signed in as {me.user.email}, which doesn't have access to this {pathname.startsWith("/shop/") ? "shop" : pathname.startsWith("/admin/") ? "university" : "page"}.
                        </p>
                        <div className="row">
                            <Link className="btn btn-primary" href={homeFor(me)}>
                                Go to your home page
                            </Link>
                            <a
                                className="btn btn-quiet"
                                href="/login"
                                onClick={async (e) => {
                                    e.preventDefault();
                                    await signOut();
                                    router.replace("/login");
                                }}
                            >
                                Sign in as someone else
                            </a>
                        </div>
                    </div>
                ) : (
                    <>
                        <InstallPrompt />
                        {children}
                    </>
                )}
            </main>
        </div>
    );
}