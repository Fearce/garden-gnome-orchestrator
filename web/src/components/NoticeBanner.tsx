import { useStore } from "../store.js";
import type { TokenSafetyState } from "../types.js";
import { clockHM, formatDuration } from "../lib/format.js";
import { tokenSafetyBox } from "../lib/tokenSafety.js";

/** The app-level alert stack under the topbar. Two sources, both always visible with desktop
 *  notifications off:
 *  - the Token Safety box, rendered from the server's durable `tokenSafety` state (so it survives a
 *    reload and carries the bypass button), and
 *  - the latest transient server `notice` (token-window reset, a refused action, ...). Only the most
 *    recent is held, so a later one replaces an undismissed banner rather than stacking.
 *  `level` sets the tone: warn = amber alert, info = neutral green (a recovery/resume). */
export function NoticeBanner() {
  const notice = useStore((s) => s.notice);
  const clearNotice = useStore((s) => s.clearNotice);
  const tokenSafety = useStore((s) => s.tokenSafety);
  const dismissed = useStore((s) => s.tokenSafetyDismissed);
  const box = tokenSafetyBox(tokenSafety, dismissed);
  if (!notice && !box) return null;
  return (
    <div className="notice-stack">
      {box === "freeze" ? <TokenSafetyFreeze state={tokenSafety!} /> : null}
      {box === "bypassed" ? <TokenSafetyBypassed state={tokenSafety!} /> : null}
      {notice ? (
        <div className={`notice-banner${notice.level === "info" ? " info" : ""}`} role="alert">
          <span className="notice-icon" aria-hidden="true">
            {notice.level === "info" ? "↺" : "⚠"}
          </span>
          <div className="notice-text">
            <div className="notice-title">{notice.title}</div>
            <div className="notice-message">{notice.message}</div>
          </div>
          <button className="notice-x" aria-label="Dismiss notification" onClick={clearNotice}>
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the freeze is holding, in one sentence. */
function heldSummary(state: TokenSafetyState): string {
  const parts: string[] = [];
  if (state.heldTasks) parts.push(`${plural(state.heldTasks, "task is", "tasks are")} paused with its saved session`);
  if (state.queuedTasks) parts.push(`${plural(state.queuedTasks, "new task is", "new tasks are")} held in the queue`);
  return parts.length ? `${parts.join("; ")}.` : "No task is waiting yet; new work will be held.";
}

function releaseSummary(state: TokenSafetyState): string {
  const when =
    state.resetAt && state.resetAt > Date.now()
      ? ` The blocking window resets around ${clockHM(state.resetAt)} (in ${formatDuration(state.resetAt - Date.now())}).`
      : "";
  return `It clears on its own once usage reads below ${state.threshold}%.${when}`;
}

/** The freeze itself, with the one-shot "Resume anyway" override and its risk note. */
function TokenSafetyFreeze({ state }: { state: TokenSafetyState }) {
  const bypass = useStore((s) => s.bypassTokenSafety);
  const bypassing = useStore((s) => s.tokenSafetyBypassing);
  const dismiss = useStore((s) => s.dismissTokenSafety);
  const usage = state.utilization == null ? "Usage" : `Usage is at ${Math.round(state.utilization)}%`;
  return (
    <div className="notice-banner token-safety" role="alert" data-testid="token-safety-box">
      <span className="notice-icon" aria-hidden="true">
        ⚠
      </span>
      <div className="notice-text">
        <div className="notice-title">Token safety limit reached</div>
        <div className="notice-message">
          {usage} (your limit is {state.threshold}%). {heldSummary(state)} {releaseSummary(state)}
        </div>
        <div className="token-safety-actions">
          <button className="btn danger sm" disabled={bypassing} onClick={() => bypass()} data-testid="token-safety-bypass">
            {bypassing ? "Resuming…" : "Resume anyway"}
          </button>
          <p className="token-safety-risk">
            Skips the safety margin for this crossing only. Held work restarts on the allowance that is left, so
            a provider can hit its hard cap and throttle, error, or stop a task mid-run, and the resumed work can
            use up the rest of the window. The limit re-arms once usage drops below {state.threshold}%.
          </p>
        </div>
      </div>
      <button className="notice-x" aria-label="Hide until the next freeze" title="Hide until the next freeze" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}

/** Confirms a bypass and says honestly what it did and did not start. */
function TokenSafetyBypassed({ state }: { state: TokenSafetyState }) {
  const dismiss = useStore((s) => s.dismissTokenSafety);
  const bypass = state.bypass!;
  const waiting = bypass.waiting
    ? ` ${plural(bypass.waiting, "task is", "tasks are")} still waiting for a free slot or provider headroom and will start through the normal capacity check.`
    : "";
  return (
    <div className="notice-banner info token-safety" role="status" data-testid="token-safety-bypassed">
      <span className="notice-icon" aria-hidden="true">
        ↺
      </span>
      <div className="notice-text">
        <div className="notice-title">Token safety bypassed</div>
        <div className="notice-message">
          Resumed {plural(bypass.resumed, "held task", "held tasks")}; new work is no longer held.{waiting} The safety
          limit is off until usage drops below {bypass.threshold}%, then trips again on the next crossing.
        </div>
      </div>
      <button className="notice-x" aria-label="Dismiss notification" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
