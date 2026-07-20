// Diagnose the subscription/account strip — "why does the chip say idle / limited / 0% / a wrong %?".
// Read-only. Safe while prod is up (WAL + busy_timeout). Reads the persisted account_usage_* kv blobs
// AccountManager writes on every ping/rollover, which are the ground truth behind each top-bar chip.
//
//   node scripts/probe-accounts.cjs
//   npm run probe:accounts --prefix server
//
// What it shows, per account (labels resolved from .env ACCOUNT_i_LABEL):
//   • 5h / 7d utilization + when each window resets (countdown).
//   • holdUntil — a STAGGER HOLD: this orchestrator parked its own 5h-window restart until its slot and
//     STOPS pinging the sub meanwhile (pingAll skips held accounts), so the chip shows "idle 0%" and is
//     BLIND to any outside consumer's burn until the hold releases. This is the usual answer to "it says
//     idle but I know something is using this sub" — a 2nd orchestrator / background service on the same
//     subscription is draining it while GG's own window sits held.
//   • extWakeAt — last time a hold-release probe caught the window ALREADY started by someone else
//     (an outside consumer). recent (<24h) ⇒ holds are skipped for this sub; lapsed ⇒ next rollover does
//     a short ~90s probe to re-test (see holdStartAt / extWakeAfterProbe in accounts/accountManager.ts).
//   • usageAt / staleness — a value older than ~20 min means the ping is failing (chip shows "stale").
//
// GOTCHA: labels are NOT in the DB — they come from server/.env (ACCOUNT_i_ID ↔ ACCOUNT_i_LABEL). With no
// .env accounts the single inherited-login account is keyed "default". The kv column is snake-free JSON.

const path = require("node:path");
const Database = require("better-sqlite3");
try {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
} catch {
  /* dotenv optional — labels just fall back to the raw id */
}

const EXT_WAKE_TTL_MS = 24 * 3_600_000;
const STALE_MS = 20 * 60 * 1000;
const now = Date.now();

const labels = {};
for (let i = 1; i <= 8; i++) {
  const id = process.env[`ACCOUNT_${i}_ID`] ?? `acct${i}`;
  if (process.env[`ACCOUNT_${i}_TOKEN`]) labels[id] = process.env[`ACCOUNT_${i}_LABEL`] ?? `account ${i}`;
}

function countdown(t) {
  if (t == null) return "—";
  const ms = t - now;
  if (ms <= 0) return "now/past";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
const ago = (t) => (t == null ? "—" : `${Math.round((now - t) / 60000)}m ago`);
const pct = (v) => (v == null ? "  —" : `${String(Math.round(v)).padStart(3)}%`);

const dbPath = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const db = new Database(dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");

const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'account_usage_%' ORDER BY key").all();
if (!rows.length) {
  console.log("No account_usage_* rows — the account manager hasn't persisted any usage yet.");
  process.exit(0);
}

console.log(`Account state @ ${new Date(now).toISOString().replace("T", " ").slice(0, 19)} (${dbPath})\n`);
for (const r of rows) {
  const id = r.key.replace(/^account_usage_/, "");
  let v;
  try {
    v = JSON.parse(r.value);
  } catch {
    console.log(`${id}: <unparseable value>`);
    continue;
  }
  const held = v.holdUntil != null && v.holdUntil > now;
  const extRecent = v.extWakeAt != null && now - v.extWakeAt < EXT_WAKE_TTL_MS;
  const stale = v.usageAt != null && now - v.usageAt > STALE_MS;
  const mls = Object.entries(v.modelLimits ?? {}).filter(([, t]) => t > now);

  console.log(`■ ${labels[id] ?? id}  (${id})`);
  console.log(`    5h ${pct(v.fiveHour)}  · resets ${countdown(v.fiveHourReset)}`);
  console.log(`    7d ${pct(v.sevenDay)}  · resets ${countdown(v.sevenDayReset)}`);
  console.log(`    usage read ${ago(v.usageAt)}${stale ? "  ⚠ STALE (ping failing → chip dims)" : ""}`);
  if (held) {
    console.log(
      `    ⏸ STAGGER HOLD until ${countdown(v.holdUntil)} → chip shows "idle" & 0%, and GG is NOT pinging this sub` +
        ` (blind to any outside consumer's burn until the hold releases).`,
    );
  }
  console.log(
    `    extWakeAt ${ago(v.extWakeAt)} — ${
      v.extWakeAt == null
        ? "never seen an outside consumer on this sub"
        : extRecent
          ? "recent ⇒ known-shared, holds skipped (reads real usage)"
          : "lapsed ⇒ next rollover short-probes (~90s) to re-test the outside consumer"
    }`,
  );
  if (mls.length) {
    console.log(`    model pool caps: ${mls.map(([m, t]) => `${m} (frees ${countdown(t)})`).join(", ")}`);
  }
  console.log("");
}

console.log(
  'Reading it: "idle" on a chip = a stagger hold-off, NOT that the subscription is globally unused. A sub' +
    "\nshared with another orchestrator/service shows extWakeAt set; while held, GG can't see that outside" +
    "\nburn. holdUntil in the future + extWakeAt lapsed is the classic false-idle case this probe exists for.",
);
db.close();
