import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { api, API_URL, ApiError, idempotencyKey } from "./api";
import { useSession } from "./session";

/** The shop this operator is working in. Operators with several shops use the first; the web app has a switcher. */
export function useActiveShop() {
  const { me } = useSession();
  const m = me?.shopMemberships[0] ?? null;
  return m ? { shopId: m.shopId, shopName: m.shopName, permissions: m.permissions, can: (p: string) => m.permissions.includes(p) } : null;
}

// Reachability is judged against our own API rather than a third-party URL, which
// campus networks and captive portals often block.
NetInfo.configure({
  reachabilityUrl: `${API_URL}/v1/health`,
  reachabilityTest: async (r) => r.status === 200,
  reachabilityShortTimeout: 5_000,
  reachabilityLongTimeout: 60_000,
  reachabilityRequestTimeout: 8_000,
});

/** Tracks connectivity. `null` while unknown so the UI doesn't flash an offline banner on start. */
export function useOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((s) => {
      setOnline(s.isConnected === false ? false : s.isInternetReachable === false ? false : s.isConnected === null ? null : true);
    });
    // On the web build, NetInfo only watches navigator.connection where it exists,
    // which misses plain online/offline changes; re-check on those events too.
    const recheck = () => void NetInfo.refresh();
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.addEventListener("online", recheck);
      window.addEventListener("offline", recheck);
    }
    return () => {
      unsubscribe();
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.removeEventListener("online", recheck);
        window.removeEventListener("offline", recheck);
      }
    };
  }, []);
  return online;
}

/**
 * A status change the operator made while offline. It is NOT applied until the
 * server confirms it through /sync, and the UI labels it that way.
 */
export interface Draft {
  clientActionId: string;
  orderId: string;
  reference: string;
  to: string;
  fromStatus: string;
  expectedVersion: number;
  reason?: string;
  draftedAt: string;
}

export interface SyncResult {
  clientActionId: string;
  outcome: "APPLIED" | "CONFLICT" | "REJECTED";
  status?: string;
  version?: number;
  error?: { code: string; message: string };
  current?: { status: string; version: number } | null;
}

export interface Problem extends Draft {
  outcome: "CONFLICT" | "REJECTED";
  message: string;
  current: { status: string; version: number } | null;
}

const key = (shopId: string) => `printflow.drafts.${shopId}`;
const problemsKey = (shopId: string) => `printflow.draft-problems.${shopId}`;

async function readList<T>(k: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

/** Unique per operator; the server de-duplicates replays by this id. Format matches [\w-]{16,64}. */
const newActionId = idempotencyKey;

export function isOffline(e: unknown): boolean {
  return e instanceof ApiError && e.code === "OFFLINE";
}

/** Offline draft queue for one shop, persisted on the device and reconciled with POST /shops/:id/sync. */
export function useDrafts(shopId: string | null) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    if (!shopId) return;
    setDrafts(await readList<Draft>(key(shopId)));
    setProblems(await readList<Problem>(problemsKey(shopId)));
  }, [shopId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (nextDrafts: Draft[], nextProblems: Problem[]) => {
      if (!shopId) return;
      setDrafts(nextDrafts);
      setProblems(nextProblems);
      await AsyncStorage.setItem(key(shopId), JSON.stringify(nextDrafts));
      await AsyncStorage.setItem(problemsKey(shopId), JSON.stringify(nextProblems));
    },
    [shopId],
  );

  const add = useCallback(
    async (d: Omit<Draft, "clientActionId" | "draftedAt">) => {
      if (!shopId) return;
      const current = await readList<Draft>(key(shopId));
      // One pending change per order: a newer draft replaces the older one.
      const next = [...current.filter((x) => x.orderId !== d.orderId), { ...d, clientActionId: newActionId(), draftedAt: new Date().toISOString() }];
      await save(next, await readList<Problem>(problemsKey(shopId)));
    },
    [save, shopId],
  );

  const discard = useCallback(
    async (clientActionId: string) => {
      if (!shopId) return;
      await save(
        (await readList<Draft>(key(shopId))).filter((d) => d.clientActionId !== clientActionId),
        (await readList<Problem>(problemsKey(shopId))).filter((p) => p.clientActionId !== clientActionId),
      );
    },
    [save, shopId],
  );

  /** Sends drafts. Applied ones are removed; conflicts and rejections are kept for the operator to review. */
  const sync = useCallback(async (): Promise<{ applied: number; problems: number } | null> => {
    if (!shopId) return null;
    const pending = await readList<Draft>(key(shopId));
    if (pending.length === 0) return { applied: 0, problems: 0 };
    setSyncing(true);
    try {
      const r = await api<{ results: SyncResult[] }>(`/shops/${shopId}/sync`, {
        method: "POST",
        body: {
          actions: pending.map((d) => ({
            clientActionId: d.clientActionId,
            orderId: d.orderId,
            to: d.to,
            expectedVersion: d.expectedVersion,
            draftedAt: d.draftedAt,
            ...(d.reason ? { reason: d.reason } : {}),
          })),
        },
      });
      const byId = new Map(r.results.map((x) => [x.clientActionId, x]));
      const remaining: Draft[] = [];
      const newProblems: Problem[] = [];
      let applied = 0;
      for (const d of pending) {
        const res = byId.get(d.clientActionId);
        if (!res) remaining.push(d);
        else if (res.outcome === "APPLIED") applied++;
        else newProblems.push({ ...d, outcome: res.outcome, message: res.error?.message ?? "Not applied", current: res.current ?? null });
      }
      const oldProblems = (await readList<Problem>(problemsKey(shopId))).filter((p) => !byId.has(p.clientActionId));
      await save(remaining, [...oldProblems, ...newProblems]);
      return { applied, problems: newProblems.length };
    } finally {
      setSyncing(false);
    }
  }, [save, shopId]);

  return { drafts, problems, syncing, add, discard, sync, reload: load };
}
