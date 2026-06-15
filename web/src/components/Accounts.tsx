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
  const cls = "acct" + (multi && a.active ? " active" : "") + (a.rateLimited ? " limited" : "");
  return (
    <div className={cls} title={a.error ? `error: ${a.error}` : a.label}>
      <div className="acct-head">
        {multi ? <span className={"acct-dot" + (a.active ? " on" : "")} /> : null}
        <span className="acct-label">{a.label}</span>
        {a.rateLimited ? <span className="acct-tag">limited</span> : null}
      </div>
      <div className="acct-meters">
        <Meter k="5h" pct={a.fiveHour} kind="five" />
        <Meter k="7d" pct={a.sevenDay} kind="week" />
      </div>
    </div>
  );
}

function Meter({ k, pct, kind }: { k: string; pct: number | null; kind: "five" | "week" }) {
  return (
    <div className="meter" title={`${k === "5h" ? "5-hour" : "weekly"} usage: ${label(pct)}`}>
      <span className="meter-k">{k}</span>
      <div className="meter-track">
        <div className={"meter-fill " + kind} style={{ width: `${clamp(pct)}%` }} />
      </div>
      <span className="meter-v">{label(pct)}</span>
    </div>
  );
}
