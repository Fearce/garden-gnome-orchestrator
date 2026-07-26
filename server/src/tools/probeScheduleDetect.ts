// Replay the LIVE schedule heuristic over the owner's real director prompts. Read-only, no agents, no
// quota. Safe while prod is up (readonly + busy_timeout).
//
//   npm run probe:schedule-detect --prefix server
//   npm run probe:schedule-detect --prefix server -- --text "run the audit every 3 days"
//   npm run probe:schedule-detect --prefix server -- --all      # don't cap the near-miss list
//
// Why this exists: `looksLikeScheduleRequest` decides whether a skip-director dispatch gets nagged
// with "you mentioned a scheduled task". It has now over-fired TWICE on ordinary prompts that merely
// named a frequency ("add a Weekly token safety %", "…regardless of weekly burn ratios"). Unit cases
// prove the rule you imagined; this proves the rule against the prompts actually typed. Tune with it:
//
//   • FLAGGED  — every one must read as a deliberate "set up/change a schedule" ask. Anything else is
//                the exact noise the owner complained about → tighten.
//   • NEAR MISS — schedule-ish vocabulary that did NOT fire. Scan for a genuine ask that got missed →
//                loosen. (Bias: a miss costs one absent reminder, a false positive nags forever.)
//
// The import is the SOURCE, not dist, so it always replays the rule you just edited.

import Database from "better-sqlite3";
import { looksLikeScheduleRequest } from "../orchestrator/director.js";
import { config } from "../config.js";

const args = process.argv.slice(2);
const adHoc = args.includes("--text") ? args[args.indexOf("--text") + 1] : undefined;
const showAll = args.includes("--all");

if (adHoc !== undefined) {
  console.log(`${looksLikeScheduleRequest(adHoc) ? "FLAGGED" : "not flagged"} — ${JSON.stringify(adHoc)}`);
  process.exit(0);
}

/** Vocabulary that USED to be enough on its own — the near-miss net, not the rule. */
const SCHEDULE_ISH =
  /\b(?:schedul\w*|cron|recurr\w+|periodic\w*|daily|hourly|weekly|nightly|monthly|(?:every|each)\s+(?:\d+\s+)?(?:morning|night|day|hour|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|min\w*|hours?|days?|weeks?))\b/;

const one = (s: string, n = 150): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const db = new Database(config.dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");
const rows = db
  .prepare("SELECT content, created_at FROM director_messages WHERE role='user' AND kind='text' ORDER BY created_at ASC")
  .all() as { content: string; created_at: number }[];
db.close();

const flagged = rows.filter((r) => looksLikeScheduleRequest(r.content));
const nearMiss = rows.filter((r) => !looksLikeScheduleRequest(r.content) && SCHEDULE_ISH.test(r.content.toLowerCase()));

console.log(`\n=== db: ${config.dbPath} ===`);
console.log(`${rows.length} owner prompts — ${flagged.length} flagged, ${nearMiss.length} schedule-ish near misses`);

console.log(`\n=== FLAGGED (${flagged.length}) — each must be a real schedule ask ===`);
if (!flagged.length) console.log("(none)");
for (const r of flagged) console.log(`  • ${day(r.created_at)}  ${one(r.content)}`);

const shown = showAll ? nearMiss : nearMiss.slice(-40);
console.log(`\n=== NEAR MISS (${nearMiss.length}${shown.length < nearMiss.length ? `, showing last ${shown.length} — pass --all` : ""}) — scan for a genuine ask that was missed ===`);
if (!shown.length) console.log("(none)");
for (const r of shown) console.log(`  • ${day(r.created_at)}  ${one(r.content)}`);
console.log("");
