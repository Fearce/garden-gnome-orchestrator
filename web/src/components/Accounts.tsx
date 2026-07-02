import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { isCapParked } from "../lib/format.js";
import type { AccountDTO, CodexUsageDTO } from "../types.js";

const clamp = (pct: number | null): number => (pct == null ? 0 : Math.min(100, Math.max(0, pct)));
const label = (pct: number | null): string => (pct == null ? "—" : `${Math.round(pct)}%`);

/** Compact "time until reset", e.g. 4d 6h · 2h 14m · 47m 12s · 9s. */
function countdown(reset: number | null | undefined, now: number): string {
  if (reset == null) return "";
  const ms = reset - now;
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function Accounts() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const codexUsage = useStore((s) => s.codexUsage);
  // A Codex implementor is live when some implementor run on the OpenAI backend is still going. The
  // account label is the discriminator the server stamps ("codex:<model>"); state idle = result emitted
  // but the run not yet finalized, so treat starting/running/idle as "implementing now".
  const codexLive = useStore((s) =>
    Object.values(s.runs).some(
      (r) => r.role === "implementor" && (r.account ?? "").startsWith("codex:") && (r.state === "starting" || r.state === "running" || r.state === "idle"),
    ),
  );
  // Global token freeze: at least one task is cap-parked, which the server only does when EVERY account
  // was rate-limited (no failover headroom). Derived from real thread state — not cosmetic — so the
  // strip frosts over exactly while the orchestrator is genuinely stalled on rate limits. Subscribe to
  // the derived boolean so the strip only re-renders when the freeze flips, not on every thread upsert.
  const frozen = useStore((s) => Object.values(s.threads).some((t) => isCapParked(t)));
  const now = useNow(accounts.length > 0 || !!codexUsage);
  const multi = accounts.length > 1;
  // Show the Codex chip once Codex is configured at all (enabled, a ChatGPT login, or a key stored) so
  // the top bar reflects it as a subscription alongside the Claude accounts.
  const showCodex = settings.codexEnabled || settings.hasOpenaiKey || settings.codexChatgptLogin;
  if (!accounts.length && !showCodex) return null;
  return (
    <div
      className={"accounts" + (frozen ? " frozen" : "")}
      title={
        frozen
          ? "Token freeze — every subscription is rate-limited right now. Parked tasks auto-resume the moment a window resets."
          : multi
            ? "Dispatch alternates between subscriptions and favors more weekly headroom. Burn fills in from each run as the windows are used."
            : "Subscription usage"
      }
    >
      {accounts.map((a) => (
        <AccountChip key={a.id} a={a} multi={multi} now={now} />
      ))}
      {showCodex ? (
        <CodexChip
          enabled={settings.codexEnabled}
          hasAuth={settings.hasOpenaiKey || settings.codexChatgptLogin}
          chatgpt={settings.codexChatgptLogin}
          model={settings.codexModel}
          live={codexLive}
          usage={codexUsage}
          now={now}
        />
      ) : null}
    </div>
  );
}

// Codex usage older than this reads as "last-known" (the operator hasn't run Codex recently), shown with
// the same ~/dim treatment as a stale Claude read. The snapshot is harvested from real runs, not polled.
const CODEX_STALE_MS = 15 * 60 * 1000;

/**
 * Top-bar chip for the OpenAI Codex backend. Shows the ChatGPT-plan 5h/weekly usage meters when we have
 * a snapshot (harvested from real Codex runs — see server readCodexUsage), plus the model and the
 * current state — implementing now / ready / needs auth / off.
 */
function CodexChip({
  enabled,
  hasAuth,
  chatgpt,
  model,
  live,
  usage,
  now,
}: {
  enabled: boolean;
  hasAuth: boolean;
  chatgpt: boolean;
  model: string;
  live: boolean;
  usage: CodexUsageDTO | null;
  now: number;
}) {
  const state = !enabled ? "off" : !hasAuth ? "noauth" : live ? "implementing" : "ready";
  const tag = state === "implementing" ? "implementing" : state === "ready" ? "ready" : state === "noauth" ? "no auth" : "off";
  const tagCls = state === "noauth" ? "acct-tag" : state === "off" ? "acct-tag dim" : "acct-tag ok";
  const authNote = chatgpt ? "via your ChatGPT plan" : "via API key";
  const title =
    state === "implementing"
      ? `Codex is implementing a task now · ${authNote} · model ${model}`
      : state === "ready"
        ? `Codex (OpenAI) enabled · ${authNote} · model ${model} · implements dispatched tasks`
        : state === "noauth"
          ? "Codex is enabled but has no usable auth — sign in with `codex login` or add an API key in Settings → Subscriptions"
          : `Codex (OpenAI) configured but off · model ${model}`;
  // Render meters whenever we have any usage reading, regardless of on/off — the headroom is real and
  // useful even when Codex isn't the active backend right now.
  const showMeters = !!usage && (usage.fiveHour != null || usage.sevenDay != null);
  const stale = !!usage && now - usage.updatedAt > CODEX_STALE_MS;
  return (
    <div
      className={"acct codex" + (state === "implementing" ? " active" : "") + (state === "off" ? " is-off" : "") + (stale ? " stale" : "")}
      title={title}
    >
      <div className="acct-head">
        <span className={"acct-dot" + (state === "implementing" || state === "ready" ? " on" : "")} />
        <span className="acct-label">Codex</span>
        <span className={tagCls}>{tag}</span>
      </div>
      {showMeters ? (
        <div className="acct-meters">
          <Meter k="5h" pct={usage!.fiveHour} kind="five" stale={stale} reset={usage!.fiveHourReset} now={now} />
          <Meter k="7d" pct={usage!.sevenDay} kind="week" stale={stale} reset={usage!.sevenDayReset} now={now} />
        </div>
      ) : (
        <div className="codex-model" title={model}>
          {model}
        </div>
      )}
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function AccountChip({ a, multi, now }: { a: AccountDTO; multi: boolean; now: number }) {
  const stale = !!a.stale && (a.fiveHour != null || a.sevenDay != null);
  // An error with no usable read ever (blank meters) is the "broken" state we want
  // loud and visible — not buried in a hover tooltip the way it used to be.
  const errored = !!a.error && a.fiveHour == null && a.sevenDay == null;
  const cls =
    "acct" + (multi && a.active ? " active" : "") + (a.rateLimited ? " limited" : "") + (stale ? " stale" : "") + (errored ? " errored" : "");
  const title = a.error
    ? `usage unavailable: ${a.error}`
    : stale
      ? `${a.label} — last-known usage (no live read for this sub right now)`
      : a.label;
  return (
    <div className={cls} title={title}>
      <div className="acct-head">
        {multi ? <span className={"acct-dot" + (a.active ? " on" : "")} /> : null}
        <span className="acct-label">{a.label}</span>
        {a.rateLimited ? (
          <span className="acct-tag">limited</span>
        ) : errored ? (
          <span className="acct-tag">no usage</span>
        ) : stale ? (
          <span className="acct-tag dim">stale</span>
        ) : null}
      </div>
      {errored ? (
        <div className="acct-err">{a.error}</div>
      ) : (
        <div className="acct-meters">
          <Meter k="5h" pct={a.fiveHour} kind="five" stale={stale} reset={a.fiveHourReset} now={now} />
          <Meter k="7d" pct={a.sevenDay} kind="week" stale={stale} reset={a.sevenDayReset} now={now} />
        </div>
      )}
    </div>
  );
}

function Meter({
  k,
  pct,
  kind,
  stale,
  reset,
  now,
}: {
  k: string;
  pct: number | null;
  kind: "five" | "week";
  stale?: boolean;
  reset?: number | null;
  now: number;
}) {
  const win = k === "5h" ? "5-hour" : "weekly";
  // The reset epoch is an absolute wall-clock time — it doesn't drift just because our usage snapshot
  // went stale, so keep counting down as long as it's still in the future. The `reset <= now` guard
  // already drops a window that has actually rolled over (its new reset is unknown until the next run).
  const left = reset == null || reset <= now ? "" : countdown(reset, now);
  const usageTip = pct == null ? `${win} usage: —` : `${win} usage: ${stale ? "~" : ""}${label(pct)}${stale ? " (last known)" : ""}`;
  const tip = left ? `${usageTip} · resets in ${left}` : usageTip;
  return (
    <div className="meter" title={tip}>
      <span className="meter-k">{k}</span>
      <div className="meter-track">
        <div className={"meter-fill " + kind + (stale ? " stale" : "")} style={{ width: `${clamp(pct)}%` }} />
      </div>
      <span className="meter-v">
        {pct != null && stale ? "~" : ""}
        {label(pct)}
      </span>
      <span className="meter-r">{left}</span>
    </div>
  );
}
