"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Loads a resource, exposes loading/error/reload, and optionally polls. */
export function useData<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setLoading(Boolean(path));
    void load();
    if (!opts.pollMs) return () => void (alive.current = false);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, opts.pollMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, path, opts.pollMs]);

  return { data, error, loading, reload: load, setData };
}
