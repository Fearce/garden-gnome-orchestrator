// Replay the LIVE route classifier over the owner's real task briefs and report the implementor effort it
// picks. Read-only, no agents, no quota. Safe while prod is up (readonly + busy_timeout).
//
//   npm run probe:route-effort --prefix server                 # last 30 days
//   npm run probe:route-effort --prefix server -- --days 90
//   npm run probe:route-effort --prefix server -- --high       # also list every high pick and its reason
//   npm run probe:route-effort --prefix server -- --text "Fix the sidebar width. Never force-push."
//
//   • DISTRIBUTION — medium should dominate; max must be 0 (only an owner pin reaches it).
//   • PERSISTED    — what those tasks actually got when they were routed (older policies included), so a
//                    change shows its before/after in one run.
//   • HIGH         — every high must name a real reason; a guardrail or a long brief is not one.
//
// The import is the SOURCE, not dist, so it always replays the rule you just edited.

import Database from "better-sqlite3";
import { selectRoute } from "../orchestrator/routeSelection.js";
import { config } from "../config.js";
import type { Effort, RouteDecision } from "../types.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const adHoc = flag("--text");
if (adHoc !== undefined) {
  const d = selectRoute({ title: "", brief: adHoc });
  console.log(`${d.implementorEffort} — ${d.effortReason}\n  scope ${d.scope}; signals: ${d.signals.join("; ") || "(none)"}`);
  process.exit(0);
}

const days = Number(flag("--days") ?? 30);
const listHigh = args.includes("--high");

interface Row {
  id: string;
  title: string;
  brief: string | null;
  stage_outputs: string | null;
}

function persistedEffort(raw: string | null): Effort | undefined {
  try {
    return (JSON.parse(raw ?? "{}") as { routeDecision?: RouteDecision }).routeDecision?.implementorEffort;
  } catch {
    return undefined;
  }
}

function tally(values: Array<string | undefined>): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? "(none)", (counts.get(v ?? "(none)") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
}

const db = new Database(config.dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");
const rows = db
  .prepare("SELECT id, title, brief, stage_outputs FROM threads WHERE created_at > ? ORDER BY created_at DESC")
  .all(Date.now() - days * 86_400_000) as Row[];
db.close();

const decisions = rows.map((r) => ({ row: r, decision: selectRoute({ title: r.title, brief: r.brief ?? "" }) }));
const reasons = new Map<string, number>();
for (const { decision } of decisions) {
  if (decision.implementorEffort !== "high") continue;
  for (const part of (decision.effortReason ?? "").split(" — ")[0]!.split("; ")) {
    const key = part.replace(/\d+/g, "N");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
}

console.log(`\n=== db: ${config.dbPath} — ${rows.length} tasks in the last ${days} days ===`);
console.log(`\nDISTRIBUTION (current policy): ${tally(decisions.map((d) => d.decision.implementorEffort))}`);
console.log(`PERSISTED (as routed at the time): ${tally(rows.map((r) => persistedEffort(r.stage_outputs)))}`);
console.log(`\nHIGH reasons: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") || "(none)"}`);
if (listHigh) {
  for (const { row, decision } of decisions) {
    if (decision.implementorEffort === "high") console.log(`  • ${row.id.slice(0, 8)}  ${row.title.slice(0, 64)}  — ${decision.effortReason}`);
  }
}
console.log("");
