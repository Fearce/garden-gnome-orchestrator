import type { AgentRunLike } from "../agents/runner.js";
import type { AgentEvent } from "../types.js";

// A streaming Claude/z.ai session only reads a queued user message at a turn boundary: when a tool call
// returns or the turn ends. One blocking tool call (an 8-minute poll loop, a long build) therefore holds
// the owner's injection unread for as long as it runs — measured at 5m49s on 2026-09-24 before the owner
// had to ask again. `priority: "now"` does NOT help here: a probe showed it waits for the running tool to
// finish too. `interrupt()` stops the tool within ~60ms and the queued message is answered right after.

/** Events that prove the run crossed a boundary where the queued message was handed to the model. */
const PICKUP_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set(["tool_result", "result"]);
/** Events that prove the model is still generating; interrupting then would discard live work. */
const STREAMING_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set(["text_delta", "thinking_delta", "text", "thinking", "tool_use"]);

const DEFAULT_QUIET_MS = 10_000;

export interface InjectionPickupOptions {
  /** How long the message may sit unread before the run is interrupted. <= 0 disables the watch. */
  timeoutMs: number;
  /** The run must have been silent this long before it is interrupted (it is blocked, not streaming). */
  quietMs?: number;
  /** A run that never falls quiet is interrupted anyway once this much time has passed. */
  maxWaitMs?: number;
  /** Re-checked at the deadline: false (the run was replaced, the task parked on a question) ends the watch. */
  mayInterrupt: () => boolean;
  onInterrupt: (waitedMs: number) => void;
  /** Called once when the watch ends for any reason. */
  onSettled?: () => void;
}

/** Watch one delivered injection until the run picks it up, interrupting a blocked run at the deadline.
 *  Returns a function that cancels the watch. */
export function watchInjectionPickup(run: AgentRunLike, opts: InjectionPickupOptions): () => void {
  if (opts.timeoutMs <= 0 || run.finished) {
    opts.onSettled?.();
    return () => {};
  }
  // A run silent for the whole timeout is quiet by definition, whatever the configured quiet window.
  const quietMs = Math.min(opts.quietMs ?? DEFAULT_QUIET_MS, opts.timeoutMs);
  const maxWaitMs = opts.maxWaitMs ?? opts.timeoutMs * 4;
  const sentAt = Date.now();
  let lastActivity = sentAt;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let unsubscribe: () => void = () => {};

  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    opts.onSettled?.();
  };
  const arm = (ms: number) => {
    timer = setTimeout(check, ms);
    timer.unref?.();
  };
  function check() {
    if (settled) return;
    if (run.finished || !opts.mayInterrupt()) return settle();
    const now = Date.now();
    const quietFor = now - lastActivity;
    if (quietFor < quietMs && now - sentAt < maxWaitMs) return arm(quietMs - quietFor);
    settle();
    opts.onInterrupt(now - sentAt);
    void run.interrupt();
  }

  unsubscribe = run.onEvent((e) => {
    if (PICKUP_EVENTS.has(e.type)) settle();
    else if (STREAMING_EVENTS.has(e.type)) lastActivity = Date.now();
  });
  run.onEnd(settle);
  arm(opts.timeoutMs);
  return settle;
}
