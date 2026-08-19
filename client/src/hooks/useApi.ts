import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../services/api';

/**
 * Data fetching for a GET endpoint.
 *
 * Deliberately small: no cache, no deduplication, no background revalidation.
 * The data volumes here do not justify a client cache layer, and every extra
 * abstraction is one more thing to explain. What it does handle is the part
 * that actually causes bugs - cancelling an in-flight request when the
 * component unmounts or the parameters change, so a slow response cannot
 * overwrite a newer one.
 */

interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-runs the request. Useful after a mutation. */
  reload: () => void;
}

export function useApi<T>(
  path: string | null,
  params?: Record<string, string | number | boolean | undefined | null>,
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);

  // Serialised so the effect re-runs on a VALUE change, not on every render
  // caused by a caller passing a fresh object literal.
  const paramKey = JSON.stringify(params ?? {});
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;

    setLoading(true);
    setError(null);

    api
      .get<T>(path, params, controller.signal)
      .then((result) => {
        // Ignore a response that has been superseded by a newer request.
        if (requestId !== latestRequest.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return;
        if (requestId !== latestRequest.current) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong loading this data.');
      })
      .finally(() => {
        if (requestId === latestRequest.current) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}

/**
 * Debounces a rapidly changing value - used for search boxes so a request is
 * not fired on every keystroke.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
