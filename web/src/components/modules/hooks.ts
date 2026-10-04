import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorText, fetchServiceStatus, serviceAction, type ServiceStatus } from "./moduleApi.js";
import type { ModuleView } from "../../types.js";

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** False while the browser tab is in the background: every module poll and stream pauses then. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
}

export interface PollState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Run the load now (after an action), without waiting for the next tick. */
  refresh: () => Promise<void>;
}

/**
 * Load `load` now and then every `intervalMs` while the page is visible and `enabled`. Overlapping loads
 * are coalesced, an in-flight load is aborted when the view unmounts, and nothing keeps polling once the
 * tab is closed: leaving a module's tab is what lets its worker go idle and exit.
 */
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number | null, enabled = true): PollState<T> {
  const visible = usePageVisible();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inflight = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const abort = new AbortController();
    controller.current = abort;
    const run = loadRef
      .current(abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setData(value);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
        inflight.current = null;
      });
    inflight.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (!enabled || !visible) return;
    void refresh();
    const timer = intervalMs ? window.setInterval(() => void refresh(), intervalMs) : null;
    return () => {
      if (timer) window.clearInterval(timer);
      controller.current?.abort();
      inflight.current = null;
    };
  }, [enabled, visible, intervalMs, refresh]);

  return { data, error, loading, refresh };
}

/** How long after opening a tab a "stopped" worker is re-read quickly, since the tab's own first request is starting it. */
const SETTLE_MS = 20_000;

export interface ServiceControl {
  status: ServiceStatus | null;
  error: string | null;
  pending: "start" | "stop" | "restart" | null;
  act: (action: "start" | "stop" | "restart", force?: boolean) => Promise<ServiceStatus | null>;
  refresh: () => Promise<void>;
}

/**
 * The module's worker process as the tab's header shows it. Read every 15 s while the tab is open, and every
 * second while it settles: the tab's first request starts the worker in parallel with this read.
 */
export function useService(id: ModuleView): ServiceControl {
  const [settling, setSettling] = useState(true);
  const poll = usePoll((signal) => fetchServiceStatus(id, signal), settling ? 1_000 : 15_000);
  const openedAt = useRef(Date.now());
  const state = poll.data?.state;
  useEffect(() => {
    setSettling(state === undefined || state === "starting" || (state === "stopped" && Date.now() - openedAt.current < SETTLE_MS));
  }, [state, poll.data]);
  const [pending, setPending] = useState<ServiceControl["pending"]>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = useCallback(
    async (action: "start" | "stop" | "restart", force = false) => {
      setPending(action);
      setActionError(null);
      try {
        const status = await serviceAction(id, action, force);
        await poll.refresh();
        return status;
      } catch (error) {
        setActionError(errorText(error));
        return null;
      } finally {
        setPending(null);
      }
    },
    [id, poll],
  );
  return { status: poll.data, error: actionError ?? (poll.error ? errorText(poll.error) : null), pending, act, refresh: poll.refresh };
}
