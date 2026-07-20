import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { isCapParked, modelLabel } from "../lib/format.js";
import type { AccountDTO, CodexEffort, CodexUsageDTO, GrokEffort, GrokUsageDTO } from "../types.js";

const clamp = (pct: number | null): number => (pct == null ? 0 : Math.min(100, Math.max(0, pct)));
const label = (pct: number | null): string => (pct == null ? "—" : `${Math.round(pct)}%`);
// "claude-fable-5" → "Fable": the family word alone keeps the pool-cap tag chip-sized.
const familyWord = (model: string): string => modelLabel(model).split(" ")[0] ?? model;

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
  const grokUsage = useStore((s) => s.grokUsage);
  // A Grok implementor is live when some implementor run on the Grok backend is still going — the server
  // stamps the account label "grok:<model>". starting/running/idle all count as "implementing now".
  const grokLive = useStore((s) =>
    Object.values(s.runs).some(
      (r) => r.role === "implementor" && (r.account ?? "").startsWith("grok:") && (r.state === "starting" || r.state === "running" || r.state === "idle"),
    ),
  );
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
  const now = useNow(accounts.length > 0 || !!codexUsage || !!grokUsage);
  const multi = accounts.length > 1;
  // Show the Codex chip once Codex is configured at all (enabled, a ChatGPT login, or a key stored) so
  // the top bar reflects it as a subscription alongside the Claude accounts.
  const showCodex = settings.codexEnabled || settings.hasOpenaiKey || settings.codexChatgptLogin;
  // Show the Grok chip once Grok is configured — enabled, or a `grok login` is present.
  const showGrok = settings.grokEnabled || settings.grokSignedIn;
  if (!accounts.length && !showCodex && !showGrok) return null;
  return (
    <div
      className={"accounts" + (frozen ? " frozen" : "")}
      title={
        frozen
          ? "Token freeze — a task is parked because every account it needs is rate-limited. Parked tasks auto-resume the moment a window resets or a backend frees up."
          : multi
            ? "Dispatch alternates between subscriptions and favors more weekly headroom. Idle 5h windows restart staggered — placed dynamically around every other subscription's live reset (Codex included) — so 5h resets spread out instead of all landing at once."
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
          effort={settings.codexEffort}
          live={codexLive}
          usage={codexUsage}
          now={now}
        />
      ) : null}
      {showGrok ? (
        <GrokChip
          enabled={settings.grokEnabled}
          hasAuth={settings.grokSignedIn}
          account={settings.grokAccount ?? grokUsage?.email ?? null}
          model={settings.grokModel}
          effort={settings.grokEffort}
          preferred={settings.grokPreferred}
          live={grokLive}
          usage={grokUsage}
          now={now}
        />
      ) : null}
    </div>
  );
}

// Codex usage older than this reads as "last-known", shown with the same ~/dim treatment as a stale
// Claude read. The server pings the codex app-server every ~10 min (plus real-run snapshots), so this
// only trips when those live reads are failing.
const CODEX_STALE_MS = 15 * 60 * 1000;

/**
 * Top-bar chip for the OpenAI Codex backend. Shows the ChatGPT-plan 5h/weekly usage meters when we have
 * a reading (live app-server pings + real-run snapshots — see server readCodexUsage), plus the model and
 * the current state — implementing now / ready / needs auth / off.
 */
function CodexChip({
  enabled,
  hasAuth,
  chatgpt,
  model,
  effort,
  live,
  usage,
  now,
}: {
  enabled: boolean;
  hasAuth: boolean;
  chatgpt: boolean;
  model: string;
  effort: CodexEffort;
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
      ? `Codex is implementing a task now · ${authNote} · model ${model} · ${effort} effort`
      : state === "ready"
        ? `Codex (OpenAI) enabled · ${authNote} · model ${model} · ${effort} effort · implements dispatched tasks`
        : state === "noauth"
          ? "Codex is enabled but has no usable auth — sign in with `codex login` or add an API key in Settings → Subscriptions"
          : `Codex (OpenAI) configured but off · model ${model} · ${effort} effort`;
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
          <Meter
            k="5h"
            pct={usage!.fiveHour}
            kind="five"
            stale={stale}
            reset={usage!.fiveHourReset}
            resetEstimated={usage!.fiveHourResetEstimated}
            now={now}
            hold={usage!.wakeAt}
          />
          <Meter k="7d" pct={usage!.sevenDay} kind="week" stale={stale} reset={usage!.sevenDayReset} now={now} />
        </div>
      ) : (
        <div className="codex-model" title={`${model} · ${effort} effort`}>
          {model} · {effort}
        </div>
      )}
    </div>
  );
}

/** Compact absolute credit reading for the monthly SuperGrok meter (e.g. "864/15k"). */
function fmtCredits(used: number, limit: number): string {
  const fmt = (n: number): string =>
    n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(n));
  return `${fmt(used)}/${fmt(limit)}`;
}

/**
 * Top-bar chip for the xAI Grok backend. Shows signed-in SuperGrok identity, state (implementing /
 * ready / capped / needs auth / off), and live meters: weekly used-% (CLI log / winpty) + monthly
 * credits (HTTP billing — absolute units on the value, not just a near-empty %). Before the first
 * reading lands it shows model·effort (or a soft error) so the chip never looks blank when configured.
 */
function GrokChip({
  enabled,
  hasAuth,
  account,
  model,
  effort,
  preferred,
  live,
  usage,
  now,
}: {
  enabled: boolean;
  hasAuth: boolean;
  account: string | null;
  model: string;
  effort: GrokEffort;
  preferred: boolean;
  live: boolean;
  usage: GrokUsageDTO | null;
  now: number;
}) {
  const capReset =
    usage?.capUntil != null && usage.capUntil > now
      ? usage.capUntil
      : usage?.sevenDay != null && usage.sevenDay >= 100 && (usage.sevenDayReset == null || usage.sevenDayReset > now)
        ? usage.sevenDayReset
        : null;
  const monthlyExhausted =
    usage?.monthlyUsed != null &&
    usage.monthlyLimit != null &&
    usage.monthlyLimit > 0 &&
    usage.monthlyUsed >= usage.monthlyLimit &&
    (usage.monthlyReset == null || usage.monthlyReset > now);
  const capped =
    capReset !== null ||
    monthlyExhausted ||
    (usage?.sevenDay != null && usage.sevenDay >= 100 && usage.sevenDayReset == null);
  const state = !enabled ? "off" : !hasAuth ? "noauth" : capped ? "capped" : live ? "implementing" : "ready";
  const tag =
    state === "implementing" ? "implementing" : state === "ready" ? "ready" : state === "capped" ? "capped" : state === "noauth" ? "no auth" : "off";
  const tagCls = state === "noauth" || state === "capped" ? "acct-tag" : state === "off" ? "acct-tag dim" : "acct-tag ok";
  const who = account ? ` · ${account}` : "";
  const plan = usage?.plan ?? (usage?.tier === 1 ? "SuperGrok" : null);
  const monthlyPct =
    usage?.monthlyUsed != null && usage.monthlyLimit != null && usage.monthlyLimit > 0
      ? Math.min(100, Math.max(0, (100 * usage.monthlyUsed) / usage.monthlyLimit))
      : null;
  const creditLabel =
    usage?.monthlyUsed != null && usage.monthlyLimit != null && usage.monthlyLimit > 0
      ? fmtCredits(usage.monthlyUsed, usage.monthlyLimit)
      : null;
  const hasMeter = usage != null && (usage.sevenDay != null || monthlyPct != null);
  const stale = !!usage?.stale;
  const prefNote = preferred
    ? " · preferred for the implementor"
    : " · auto-ranked with Claude/Codex by soonest weekly reset (Prefer Grok still honors its safety threshold)";
  const meterNote =
    usage?.sevenDay != null
      ? ` · weekly ${Math.round(usage.sevenDay)}%${usage.sevenDayReset != null && usage.sevenDayReset > now ? ` (resets ${countdown(usage.sevenDayReset, now)})` : ""}`
      : "";
  const monthlyNote =
    monthlyPct != null && usage?.monthlyUsed != null && usage.monthlyLimit != null
      ? ` · monthly ${usage.monthlyUsed}/${usage.monthlyLimit} credits (${Math.round(monthlyPct)}%)`
      : "";
  const title =
    state === "implementing"
      ? `Grok is implementing a task now${who}${plan ? ` · ${plan}` : ""} · model ${model} · ${effort} effort${meterNote}${monthlyNote}${prefNote}`
      : state === "ready"
        ? `Grok${plan ? ` (${plan})` : ""} enabled${who} · model ${model} · ${effort} effort${meterNote}${monthlyNote}${prefNote}`
        : state === "capped"
          ? `Grok hit its usage limit — routing implementors elsewhere${
              capReset != null
                ? `; retrying in ${countdown(capReset, now)}`
                : monthlyExhausted && usage?.monthlyReset != null
                  ? `; monthly credits refill in ${countdown(usage.monthlyReset, now)}`
                  : ""
            }`
          : state === "noauth"
            ? "Grok is enabled but not signed in — run `grok login` (or `grok login --device-auth`) on the host"
            : `Grok${plan ? ` (${plan})` : ""} configured but off · model ${model} · ${effort} effort`;
  return (
    <div
      className={
        "acct grok" + (state === "implementing" ? " active" : "") + (state === "off" ? " is-off" : "") + (state === "capped" ? " limited" : "") + (stale ? " stale" : "")
      }
      title={title}
    >
      <div className="acct-head">
        <span className={"acct-dot" + (state === "implementing" || state === "ready" ? " on" : "")} />
        <span className="acct-label">Grok</span>
        <span className={tagCls}>{tag}</span>
        {plan ? (
          <span className="acct-tag ok" title={`${plan} subscription`}>
            {plan}
          </span>
        ) : null}
        {stale ? <span className="acct-tag dim">stale</span> : null}
        {preferred && (state === "ready" || state === "implementing") ? (
          <span className="acct-tag ok" title="Preferred for the implementor — Grok runs it whenever it's enabled and not capped">
            preferred
          </span>
        ) : null}
      </div>
      {hasMeter ? (
        <div className="acct-meters">
          {usage!.sevenDay != null ? (
            <Meter k="7d" pct={usage!.sevenDay} kind="week" stale={stale} reset={usage!.sevenDayReset} now={now} />
          ) : null}
          {monthlyPct != null ? (
            <Meter
              k="mo"
              pct={monthlyPct}
              kind="week"
              stale={stale}
              reset={usage!.monthlyReset}
              now={now}
              valueLabel={creditLabel}
              detail={
                usage!.monthlyUsed != null && usage!.monthlyLimit != null
                  ? `${usage!.monthlyUsed}/${usage!.monthlyLimit} credits`
                  : null
              }
            />
          ) : null}
        </div>
      ) : (
        <div
          className="codex-model"
          title={
            usage?.error
              ? `usage unavailable: ${usage.error}`
              : hasAuth
                ? `Polling SuperGrok weekly + monthly usage… · ${model} · ${effort}${who}`
                : `${model} · ${effort} effort${who}`
          }
        >
          {state === "capped" && usage?.capUntil
            ? `retry in ${countdown(usage.capUntil, now)}`
            : usage?.error
              ? usage.error
              : hasAuth
                ? "polling usage…"
                : `${model} · ${effort}`}
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
        {(a.modelLimits ?? [])
          .filter((ml) => ml.resetsAt > now)
          .map((ml) => (
            <span
              key={ml.model}
              className="acct-tag"
              title={`${ml.model} has its own usage pool, and it's exhausted on this sub — dispatch falls back to ${ml.fallback} until it frees up (retries in ${countdown(ml.resetsAt, now)}). The normal 5h/weekly windows are unaffected.`}
            >
              {familyWord(ml.model)} → {familyWord(ml.fallback)}
            </span>
          ))}
      </div>
      {errored ? (
        <div className="acct-err">{a.error}</div>
      ) : (
        <div className="acct-meters">
          <Meter k="5h" pct={a.fiveHour} kind="five" stale={stale} reset={a.fiveHourReset} now={now} hold={a.holdUntil} />
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
  resetEstimated,
  now,
  hold,
  detail,
  valueLabel,
}: {
  k: string;
  pct: number | null;
  kind: "five" | "week";
  stale?: boolean;
  reset?: number | null;
  resetEstimated?: boolean;
  now: number;
  hold?: number | null;
  /** Optional absolute reading (e.g. "616/15000 credits") appended to the hover tip. */
  detail?: string | null;
  /** Override the right-hand value text (e.g. "864/15k" for SuperGrok monthly credits). */
  valueLabel?: string | null;
}) {
  const win = k === "5h" ? "5-hour" : k === "mo" ? "monthly" : "weekly";
  // Stagger hold-off: the 5h window rolled over and its restart ping deliberately waits for this
  // account's slot, so the subs reset alternately. The window is idle at 0% — fully usable; a real
  // dispatch starts it immediately.
  const holding = hold != null && hold > now && (reset == null || reset <= now);
  // The reset epoch is an absolute wall-clock time — it doesn't drift just because our usage snapshot
  // went stale, so keep counting down as long as it's still in the future. The `reset <= now` guard
  // already drops a window that has actually rolled over (its new reset is unknown until the next run).
  const left = reset == null || reset <= now ? "" : countdown(reset, now);
  const detailNote = detail ? ` · ${detail}` : "";
  const usageTip =
    pct == null
      ? `${win} usage: —${detailNote}`
      : `${win} usage: ${stale ? "~" : ""}${label(pct)}${stale ? " (last known)" : ""}${detailNote}`;
  const resetTip = resetEstimated ? `estimated reset in ${left} (Codex omitted the 5-hour window)` : `resets in ${left}`;
  const tip = holding
    ? `${usageTip} · window idle — starts in ${countdown(hold, now)} (staggered so 5h resets spread out across subscriptions; a dispatch starts it right away)`
    : left
      ? `${usageTip} · ${resetTip}`
      : usageTip;
  const shown = valueLabel
    ? `${stale ? "~" : ""}${valueLabel}`
    : `${pct != null && stale ? "~" : ""}${label(pct)}`;
  return (
    <div className={"meter" + (valueLabel ? " meter-wide-v" : "")} title={tip}>
      <span className="meter-k">{k}</span>
      <div className="meter-track">
        <div className={"meter-fill " + kind + (stale ? " stale" : "")} style={{ width: `${clamp(pct)}%` }} />
      </div>
      <span className="meter-v">{shown}</span>
      <span className="meter-r">{holding ? `idle ${countdown(hold, now)}` : left ? `${resetEstimated ? "~" : ""}${left}` : ""}</span>
    </div>
  );
}
