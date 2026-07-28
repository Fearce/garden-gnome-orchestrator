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
// It then prints the FULL failover ladder: the Claude subs above are only its first rung, and an
// implementor falls through to Codex / Grok / z.ai when every sub is capped. Those rungs live in different
// kv keys (setting_*_enabled + *_cap_until), so a ladder that is one rung deep — or a backend that has been
// cap-latched for days — is invisible from the account_usage_* blobs alone.
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
// Mirrors PROVIDER_HARD_LIMIT in orchestrator/threadManager.ts — a window at/above this is treated as
// having no room left, so a sub only counts as a live ladder rung while BOTH windows are under it.
const HARD_LIMIT_PCT = 98;
// The non-Claude rungs. Each is gated by a setting_*_enabled flag ("1" = on) and cap-latched by a
// *_cap_until epoch that threadManager writes on a rejected turn and clears once it expires — so an
// absent/empty/past value means "not capped" (see loadCodexCap / loadGrokCap / loadZaiCap).
const BACKENDS = [
  { name: "Codex", enabledKey: "setting_codex_enabled", capKey: "codex_cap_until" },
  { name: "Grok", enabledKey: "setting_grok_enabled", capKey: "grok_cap_until" },
  { name: "z.ai", enabledKey: "setting_zai_enabled", capKey: "zai_cap_until" },
];
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

/** A non-Claude rung's live state, from its two kv keys. Pure — `kv` reads a key, `at` is the clock. */
function backendState({ enabledKey, capKey }, kv, at) {
  if (kv(enabledKey) !== "1") return { available: false, reason: "disabled" };
  const until = Number(kv(capKey));
  if (Number.isFinite(until) && until > at) return { available: false, reason: "capped", until };
  return { available: true, reason: "ready" };
}

/** A sub only counts as a live rung while BOTH windows are under the hard limit — a sub sitting at 99%
 *  weekly still shows a healthy-looking 5h number but can't actually take a task. */
function claudeHasHeadroom(usage) {
  return (usage.fiveHour ?? 0) < HARD_LIMIT_PCT && (usage.sevenDay ?? 0) < HARD_LIMIT_PCT;
}

function main() {
  const dbPath = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");

  const kv = (key) => db.prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value ?? null;

  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'account_usage_%' ORDER BY key").all();

  let claudeRungs = 0;
  console.log(`Account state @ ${new Date(now).toISOString().replace("T", " ").slice(0, 19)} (${dbPath})\n`);
  if (!rows.length) console.log("No account_usage_* rows — the account manager hasn't persisted any usage yet.\n");
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
    if (claudeHasHeadroom(v)) claudeRungs++;

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

  const NOTE = {
    disabled: () => "disabled (not in the ladder)",
    capped: (s) => `CAPPED — frees in ${countdown(s.until)}`,
    ready: () => "available",
  };
  const backends = BACKENDS.map((b) => ({ ...b, ...backendState(b, kv, now) }));
  console.log("Failover ladder — where an implementor lands when every Claude sub above is capped:");
  for (const b of backends) console.log(`  ${b.available ? "✓" : "✗"} ${b.name.padEnd(6)} ${NOTE[b.reason](b)}`);

  const altRungs = backends.filter((b) => b.available).length;
  const depth = claudeRungs + altRungs;
  console.log(
    `\n  ladder depth: ${depth} rung(s) — ${claudeRungs} Claude sub(s) under ${HARD_LIMIT_PCT}% on both windows` +
      ` + ${altRungs} alt backend(s).` +
      (depth === 0
        ? " ⚠ NOTHING can take work — new tasks will park on caps until a window resets."
        : depth === 1
          ? " ⚠ one rung left — a burst can park tasks on caps."
          : ""),
  );

  console.log(
    '\nReading it: "idle" on a chip = a stagger hold-off, NOT that the subscription is globally unused. A sub' +
      "\nshared with another orchestrator/service shows extWakeAt set; while held, GG can't see that outside" +
      "\nburn. holdUntil in the future + extWakeAt lapsed is the classic false-idle case this probe exists for." +
      "\nA CAPPED alt backend is expected (the latch self-expires and routing skips it) — it only matters when" +
      "\nit shrinks the ladder to one rung.",
  );
  db.close();
}

if (require.main === module) main();

module.exports = { backendState, claudeHasHeadroom, BACKENDS, HARD_LIMIT_PCT };
