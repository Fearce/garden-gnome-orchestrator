import { useStore } from "../store.js";
import type { AccountDTO } from "../types.js";

const clamp = (pct: number | null): number => (pct == null ? 0 : Math.min(100, Math.max(0, pct)));
const label = (pct: number | null): string => (pct == null ? "—" : `${Math.round(pct)}%`);

export function Accounts() {
  const accounts = useStore((s) => s.accounts);
  if (!accounts.length) return null;
  const multi = accounts.length > 1;
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
        <AccountChip key={a.id} a={a} multi={multi} />
      ))}
    </div>
  );
}

function AccountChip({ a, multi }: { a: AccountDTO; multi: boolean }) {
  const stale = !!a.stale && (a.fiveHour != null || a.sevenDay != null);
  const cls = "acct" + (multi && a.active ? " active" : "") + (a.rateLimited ? " limited" : "") + (stale ? " stale" : "");
  const title = a.error
    ? `error: ${a.error}`
    : stale
      ? `${a.label} — last-known usage (no live read for this sub right now)`
      : a.label;
  return (
    <div className={cls} title={title}>
      <div className="acct-head">
        {multi ? <span className={"acct-dot" + (a.active ? " on" : "")} /> : null}
        <span className="acct-label">{a.label}</span>
        {a.rateLimited ? <span className="acct-tag">limited</span> : stale ? <span className="acct-tag dim">stale</span> : null}
      </div>
      <div className="acct-meters">
        <Meter k="5h" pct={a.fiveHour} kind="five" stale={stale} />
        <Meter k="7d" pct={a.sevenDay} kind="week" stale={stale} />
      </div>
    </div>
  );
}

function Meter({ k, pct, kind, stale }: { k: string; pct: number | null; kind: "five" | "week"; stale?: boolean }) {
  const win = k === "5h" ? "5-hour" : "weekly";
  const tip = pct == null ? `${win} usage: —` : `${win} usage: ${stale ? "~" : ""}${label(pct)}${stale ? " (last known)" : ""}`;
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
    </div>
  );
}
