import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, loadToken, saveToken } from "./api";

export interface Me {
  user: { id: string; email: string; fullName: string; phone: string | null; platformRole: string | null; emailVerified: boolean; phoneVerified: boolean };
  student: { universityId: string; universityName: string; campusName: string } | null;
  shopMemberships: Array<{ shopId: string; shopName: string; role: string; permissions: string[] }>;
  universityRoles: Array<{ universityId: string; universityName: string; role: string }>;
  mfa: { totpEnrolled: boolean };
  session: { mfaVerified: boolean; mfaRequired: boolean };
}

interface Ctx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  /** `identifier` is an email address or a phone number (local Nigerian formats are fine). */
  signIn: (identifier: string, password: string, mfaCode?: string) => Promise<{ me: Me; needsCode: boolean }>;
  /** Texts a sign-in code; the answer is the same whether or not the number has an account. */
  requestCode: (phone: string) => Promise<{ sentTo: string; resendAfterSeconds: number }>;
  signInWithCode: (phone: string, code: string, mfaCode?: string) => Promise<{ me: Me; needsCode: boolean }>;
  signOut: () => Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      if (!(await loadToken())) {
        setMe(null);
        return null;
      }
      const m = await api<Me>("/auth/me");
      setMe(m);
      return m;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  type SignInResponse = Me & { sessionToken: string; session: Me["session"] & { mfaEnrolled: boolean } };

  const finish = useCallback(async (r: SignInResponse) => {
    await saveToken(r.sessionToken);
    const m = await api<Me>("/auth/me");
    setMe(m);
    return { me: m, needsCode: r.session.mfaRequired && r.session.mfaEnrolled && !r.session.mfaVerified };
  }, []);

  const signIn = useCallback(
    async (identifier: string, password: string, mfaCode?: string) => {
      const id = identifier.trim();
      const r = await api<SignInResponse>("/auth/login", {
        method: "POST",
        body: { ...(id.includes("@") ? { email: id } : { phone: id }), password, client: "mobile", ...(mfaCode ? { mfaCode } : {}) },
      });
      return finish(r);
    },
    [finish],
  );

  const requestCode = useCallback(
    (phone: string) => api<{ sentTo: string; resendAfterSeconds: number }>("/auth/otp/request", { method: "POST", body: { phone } }),
    [],
  );

  const signInWithCode = useCallback(
    async (phone: string, code: string, mfaCode?: string) => {
      const r = await api<SignInResponse>("/auth/otp/verify", { method: "POST", body: { phone, code, client: "mobile", ...(mfaCode ? { mfaCode } : {}) } });
      return finish(r);
    },
    [finish],
  );

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    await saveToken(null);
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <SessionCtx.Provider value={{ me, loading, refresh, signIn, requestCode, signInWithCode, signOut }}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("SessionProvider missing");
  return c;
}

export function homeFor(me: Me): string {
  if (me.session.mfaRequired && !me.session.mfaVerified) return "/mfa";
  if (me.shopMemberships[0]) return "/shop/queue";
  if (me.student) return "/student/orders";
  return "/overview";
}
