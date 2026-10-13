import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { api } from "./api";

/** Loads on screen focus, supports pull-to-refresh and optional polling while focused. */
export function useData<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [refreshing, setRefreshing] = useState(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      setData(await api<T>(pathRef.current));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      if (!pollMs) return undefined;
      const t = setInterval(() => void load(), pollMs);
      return () => clearInterval(t);
    }, [load, pollMs, path]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return { data, error, loading, refreshing, refresh, reload: load };
}
