// Replay the LIVE effort-ask detector over the owner's real director prompts. Read-only, no agents, no
// quota. Safe while prod is up (readonly + busy_timeout).
//
//   npm run probe:effort-request --prefix server
//   npm run probe:effort-request --prefix server -- --text "review this with high effort"
//
//   • PINNED    — every one must read as an ask for THIS task's effort; anything else pins a whole task
//                 wrong → tighten.
//   • NEAR MISS — mentions "effort" without pinning. Scan for a genuine ask that got missed → loosen.
//
// The import is the SOURCE, not dist, so it always replays the rule you just edited.

import Database from "better-sqlite3";
import { detectEffortRequest } from "../orchestrator/effortRequest.js";
import { config } from "../config.js";

const args = process.argv.slice(2);
const adHoc = args.includes("--text") ? args[args.indexOf("--text") + 1] : undefined;

if (adHoc !== undefined) {
  console.log(`${detectEffortRequest(adHoc) ?? "no pin"} — ${JSON.stringify(adHoc)}`);
  process.exit(0);
}

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

const pinned = rows.map((r) => ({ ...r, effort: detectEffortRequest(r.content) })).filter((r) => r.effort);
const nearMiss = rows.filter((r) => !detectEffortRequest(r.content) && /\beffort/i.test(r.content));

console.log(`\n=== db: ${config.dbPath} ===`);
console.log(`${rows.length} owner prompts — ${pinned.length} pinned, ${nearMiss.length} near misses`);
console.log(`\n=== PINNED (${pinned.length}) — each must ask for this task's effort ===`);
if (!pinned.length) console.log("(none)");
for (const r of pinned) console.log(`  • ${day(r.created_at)}  [${r.effort}]  ${one(r.content)}`);
console.log(`\n=== NEAR MISS (${nearMiss.length}) — scan for a genuine ask that was missed ===`);
if (!nearMiss.length) console.log("(none)");
for (const r of nearMiss) console.log(`  • ${day(r.created_at)}  ${one(r.content)}`);
console.log("");
