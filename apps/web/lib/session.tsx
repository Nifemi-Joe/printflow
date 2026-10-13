"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, SESSION_LOST_EVENT, setCsrf } from "./api";

export interface Me {
  user: { id: string; email: string; fullName: string; phone: string | null; platformRole: string | null; emailVerified: boolean; phoneVerified: boolean };
  student: { universityId: string; universityName: string; campusId: string; campusName: string; departmentId: string | null; matricNumber: string | null } | null;
  shopMemberships: Array<{ membershipId: string; shopId: string; shopName: string; shopStatus: string; universityId: string; role: string; permissions: string[] }>;
  universityRoles: Array<{ universityId: string; universityName: string; role: string }>;
  mfa: { totpEnrolled: boolean };
  session: { mfaVerified: boolean; mfaRequired: boolean };
  csrfToken: string;
}

interface SessionState {
  me: Me | null;
  loading: boolean;
  /** True after a deliberate sign-out, so the page guard does not remember the old page. */
  signedOut: boolean;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState>({ me: null, loading: true, signedOut: false, refresh: async () => null, signOut: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api<({ authenticated: true } & Me) | { authenticated: false }>("/auth/session");
      if (!r.authenticated) {
        setMe(null);
        return null;
      }
      setCsrf(r.csrfToken);
      setSignedOut(false);
      setMe(r);
      return r;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 401) setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setSignedOut(true);
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A session that expires or is revoked mid-page: re-check it, so the page guard
  // sends the person to sign in instead of leaving error boxes on screen.
  useEffect(() => {
    const onLost = () => void refresh();
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    return () => window.removeEventListener(SESSION_LOST_EVENT, onLost);
  }, [refresh]);

  return <Ctx.Provider value={{ me, loading, signedOut, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}

/** Whether this person must still pass (or set up) two-step sign-in. */
export function mfaPending(me: Me): boolean {
  return me.session.mfaRequired && !me.session.mfaVerified;
}

/** Only same-site paths are followed after sign-in, never another site. */
export function safeNext(next: string | null | undefined): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

/** Where a signed-in person should land first. */
export function homeFor(me: Me): string {
  if (mfaPending(me)) return "/mfa";
  if (me.user.platformRole) return "/platform";
  if (me.universityRoles[0]) return `/admin/${me.universityRoles[0].universityId}`;
  if (me.shopMemberships[0]) return `/shop/${me.shopMemberships[0].shopId}`;
  if (me.student) return "/student/orders";
  return "/shop/apply";
}

/**
 * Whether this person can open a page. Workspace pages belong to a specific shop,
 * university or role; anything else (account, verify, checkout) is open to anyone
 * signed in. Used so a link left over from someone else's session is not followed.
 */
export function canOpen(me: Me, path: string): boolean {
  const p = path.split(/[?#]/)[0]!;
  if (p === "/mfa" || p === "/login" || p === "/register") return false;
  const shop = /^\/shop\/([\w-]+)/.exec(p);
  if (shop && shop[1] !== "apply") return me.shopMemberships.some((m) => m.shopId === shop[1]);
  const uni = /^\/admin\/([\w-]+)/.exec(p);
  if (uni) return me.universityRoles.some((u) => u.universityId === uni[1]);
  if (p === "/platform" || p.startsWith("/platform/")) return Boolean(me.user.platformRole);
  if (p === "/student" || p.startsWith("/student/")) return Boolean(me.student);
  return true;
}

/**
 * Where to go after signing in. Staff who still need two-step sign-in always go to
 * /mfa first (carrying the page they asked for), so a "next" link can never skip it.
 * A link to a page this person cannot open (for example one left by the previous
 * person on this browser) is ignored in favour of their own home page.
 */
export function afterSignIn(me: Me, next: string | null | undefined): string {
  const raw = safeNext(next);
  const target = raw && canOpen(me, raw) ? raw : null;
  if (mfaPending(me)) return target ? `/mfa?next=${encodeURIComponent(target)}` : "/mfa";
  return target ?? homeFor(me);
}

/**
 * Redirects to /login when signed out, and to /mfa whenever two-step sign-in is
 * pending, on every signed-in page (the account page included), not only staff pages.
 */
export function useRequireSession() {
  const s = useSession();
  const router = useRouter();
  useEffect(() => {
    if (s.loading) return;
    const here = window.location.pathname + window.location.search;
    // After a deliberate sign-out, the next person should start at their own home page.
    if (!s.me) router.replace(s.signedOut ? "/login" : `/login?next=${encodeURIComponent(here)}`);
    else if (mfaPending(s.me)) router.replace(`/mfa?next=${encodeURIComponent(here)}`);
  }, [s.loading, s.me, s.signedOut, router]);
  return s;
}
