"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

/** Polls an async fetcher on an interval (Phase2 plan §5: "Polling the backend is fine for MVP
 * -- no need for websockets"). Re-polls immediately whenever `deps` change, and clears the
 * timer on unmount.
 *
 * `errorStatus` mirrors `ApiError.status` when the failure was one (0 for "fetch itself threw",
 * i.e. backend unreachable; 401 for an expired/invalid session; the real HTTP status otherwise)
 * and is `null` for a non-ApiError failure -- callers use this to render a specific empty/error
 * state (plan §4) instead of a generic "something broke" message.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList,
  intervalMs = 5000
): { data: T | null; error: string | null; errorStatus: number | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const run = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      setErrorStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setErrorStatus(err instanceof ApiError ? err.status : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    run();
    const id = setInterval(run, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, intervalMs, ...deps]);

  return { data, error, errorStatus, loading, refresh: run };
}
