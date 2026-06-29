import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { AccountDTO } from "../types.js";

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
  // A Codex implementor is live when some implementor run on the OpenAI backend is still going. The
  // account label is the discriminator the server stamps ("codex:<model>"); state idle = result emitted
  // but the run not yet finalized, so treat starting/running/idle as "implementing now".
  const codexLive = useStore((s) =>
    Object.values(s.runs).some(
      (r) => r.role === "implementor" && (r.account ?? "").startsWith("codex:") && (r.state === "starting" || r.state === "running" || r.state === "idle"),
    ),
  );
  const now = useNow(accounts.length > 0);
  const multi = accounts.length > 1;
  // Show the Codex chip once Codex is configured at all (enabled, or a key is stored) so the top bar
  // reflects it as a subscription alongside the Claude accounts.
  const showCodex = settings.codexEnabled || settings.hasOpenaiKey;
  if (!accounts.length && !showCodex) return null;
  return (
    <div
      className="accounts"
      title={
        multi
          ? "Dispatch alternates between subscriptions and favors more weekly headroom. Burn fills in from each run as the windows are used."
          : "Subscription usage"
      }
    >
      {accounts.map((a) => (
        <AccountChip key={a.id} a={a} multi={multi} now={now} />
      ))}
      {showCodex ? <CodexChip enabled={settings.codexEnabled} hasKey={settings.hasOpenaiKey} model={settings.codexModel} live={codexLive} /> : null}
    </div>
  );
}

/**
 * Top-bar chip for the OpenAI Codex backend. OpenAI exposes no rolling 5h/weekly headroom like the
 * Claude subscription ping, so this is an honest STATUS chip (not a fabricated usage meter): it shows
 * the model and the current state — implementing now / ready / needs a key / off.
 */
function CodexChip({ enabled, hasKey, model, live }: { enabled: boolean; hasKey: boolean; model: string; live: boolean }) {
  const state = !enabled ? "off" : !hasKey ? "nokey" : live ? "implementing" : "ready";
  const tag = state === "implementing" ? "implementing" : state === "ready" ? "ready" : state === "nokey" ? "no key" : "off";
  const tagCls = state === "nokey" ? "acct-tag" : state === "off" ? "acct-tag dim" : "acct-tag ok";
  const title =
    state === "implementing"
      ? `Codex is implementing a task now · model ${model}`
      : state === "ready"
        ? `Codex (OpenAI) enabled · model ${model} · implements dispatched tasks`
        : state === "nokey"
          ? "Codex is enabled but has no valid API key — add one in Settings → Subscriptions"
          : `Codex (OpenAI) configured but off · model ${model}`;
  return (
    <div className={"acct codex" + (state === "implementing" ? " active" : "") + (state === "off" ? " is-off" : "")} title={title}>
      <div className="acct-head">
        <span className={"acct-dot" + (state === "implementing" || state === "ready" ? " on" : "")} />
        <span className="acct-label">Codex</span>
        <span className={tagCls}>{tag}</span>
      </div>
      <div className="codex-model" title={model}>
        {model}
      </div>
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
  // A stale read carries a stale reset epoch — almost certainly already passed —
  // so only count down against a live read with a reset still in the future.
  const left = stale || reset == null || reset <= now ? "" : countdown(reset, now);
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
