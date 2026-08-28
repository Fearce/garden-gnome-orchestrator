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
// implementor falls through to Codex / Grok / z.ai when every sub is capped. Those rungs live elsewhere
// entirely — kv keys (setting_*_enabled + *_cap_until) plus each backend's own data/<x>-usage-cache.json
// meters — so a ladder that is one rung deep, a backend cap-latched for days, or one whose weekly is simply
// spent is invisible from the account_usage_* blobs alone.
//
// GOTCHA: labels are NOT in the DB — they come from server/.env (ACCOUNT_i_ID ↔ ACCOUNT_i_LABEL). With no
// .env accounts the single inherited-login account is keyed "default". The kv column is snake-free JSON.

const fs = require("node:fs");
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
//
// `usageFile` is the backend's own last-reading cache under data/ (written by agents/<x>Usage.ts). The
// latch alone is NOT enough: a backend whose window is simply SPENT was never rejected, so nothing latches
// it, and routing skips it purely on the meters (zaiCapActive / codexProviderCandidate.hasHeadroom). Read
// without the meters, this readout called an exhausted Codex and z.ai live rungs and reported a ladder of
// 3 when only 1 could take work — the same "one-rung ladder looks healthy" blind spot in a new door.
// Windows are not the only door: Grok's plan also meters a monthly CREDIT pool that routing refuses the
// rung on, and it can run dry while the weekly window still reads room (see spentCredits).
const BACKENDS = [
  { name: "Codex", enabledKey: "setting_codex_enabled", capKey: "codex_cap_until", cooldownKey: "provider_startup_cooldown_codex_until", usageFile: "codex-usage-cache.json", poolCapKey: "codex_pool_cap_until" },
  { name: "Grok", enabledKey: "setting_grok_enabled", capKey: "grok_cap_until", cooldownKey: "provider_startup_cooldown_grok_until", usageFile: "grok-usage-cache.json" },
  { name: "z.ai", enabledKey: "setting_zai_enabled", capKey: "zai_cap_until", cooldownKey: "provider_startup_cooldown_zai_until", usageFile: "zai-usage-cache.json" },
];
// Every term threadManager's *ProviderCandidate methods gate `hasHeadroom` on, and where THIS file
// mirrors it. The ladder re-implements routing's decision by hand, so the two drift — and the drift is
// one-directional: a door added over there that isn't read over here keeps printing the rung as
// available, which reads as a HEALTHIER ladder than exists. That has now shipped three times (08d743b
// meters, 707cc13 sentinel resets, a523668 Grok credits), each found by eye long after the fact.
// `test:failover-ladder` diffs this map against the real source, so the next door fails a gate instead.
// Adding a term here without implementing it does not satisfy the gate — the map is the claim, and the
// mirror named beside each term is what has to be true.
const MIRRORED_HEADROOM_TERMS = {
  grokProviderCandidate: {
    startupCooldownUntil: "cooldownKey latch → reason 'startup cooldown'",
    capActive: "capKey latch → reason 'capped'",
    nearWeekly: "spentWindow (7d)",
    monthlyExhausted: "spentCredits (monthly pool)",
  },
  zaiProviderCandidate: {
    startupCooldownUntil: "cooldownKey latch → reason 'startup cooldown'",
    capActive: "capKey latch → reason 'capped'",
    near: "spentWindow (5h + 7d)",
  },
  codexProviderCandidate: {
    startupCooldownUntil: "cooldownKey latch → reason 'startup cooldown'",
    // General and DEDICATED model pools have different latches and windows. backendState mirrors the
    // general rung; dedicatedPoolRungs mirrors every model allowance. Together they implement the exact
    // selected-pool decision represented by this local in codexProviderCandidate.
    selectedPoolReady: "backendState + dedicatedPoolRungs (per-pool meters + cap latches)",
  },
};

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

/** A non-Claude rung's live state, from its kv keys plus its own last usage reading. Pure — `kv` reads a
 *  key, `usage` reads a backend's cached meters (null when it has never written one), `at` is the clock.
 *
 *  Order matters: disabled outranks a cap, and an explicit latch outranks the meters, because the latch
 *  carries the deadline routing itself is waiting on. A SPENT window is reported separately from a latched
 *  cap so the readout can say which one is holding the rung — they need different reactions (a latch
 *  self-expires; a spent weekly waits for the real reset). */
function backendState({ enabledKey, capKey, cooldownKey, usageFile }, kv, at, usage = () => null) {
  if (kv(enabledKey) !== "1") return { available: false, reason: "disabled" };
  const cooldownUntil = cooldownKey ? Number(kv(cooldownKey)) : 0;
  if (Number.isFinite(cooldownUntil) && cooldownUntil > at) return { available: false, reason: "startup cooldown", until: cooldownUntil };
  const until = Number(kv(capKey));
  if (Number.isFinite(until) && until > at) return { available: false, reason: "capped", until };
  const meters = usageFile ? usage(usageFile) : null;
  const spent = meters ? (spentWindow(meters, at) ?? spentCredits(meters, at)) : null;
  if (spent) {
    return {
      available: false,
      reason: "spent",
      until: spent.reset,
      window: spent.window,
      pct: spent.pct,
      reportedReset: spent.reportedReset ?? null,
    };
  }
  return { available: true, reason: "ready", meters };
}

// How far out a window's reported reset can be before it is not believable as that window's reset. z.ai's
// quota endpoint has been seen returning a fixed far-future sentinel (1799999999000 — Jan 2027) as a
// 5-HOUR window's nextResetTime, which would otherwise render as "resets in 169d". Generous (2× the
// window) so a real, legitimately-late reset is never suppressed.
const WINDOW_MAX_RESET_MS = { "5h": 2 * 5 * 3_600_000, "7d": 2 * 7 * 86_400_000 };

/** The first window with no room left, or null. Mirrors routing's rule (`>= PROVIDER_HARD_LIMIT` with a
 *  reset that hasn't passed): an unknown reset still counts as spent, since a full window with no known
 *  reset is exactly the state routing refuses to send work into. A reset too distant to be this window's
 *  is reported as unknown rather than counted down — the verdict is unaffected (routing reads the same
 *  meters and reaches the same conclusion), but a bogus countdown would be read as a real outage length. */
function spentWindow(meters, at) {
  for (const [window, pct, reset] of [
    ["5h", meters.fiveHour, meters.fiveHourReset],
    ["7d", meters.sevenDay, meters.sevenDayReset],
  ]) {
    if (typeof pct !== "number" || pct < HARD_LIMIT_PCT) continue;
    if (reset != null && reset <= at) continue; // window already rolled over — it has room again
    const plausible = reset != null && reset - at <= WINDOW_MAX_RESET_MS[window];
    if (reset == null || plausible) return { window, pct, reset };
    return { window, pct, reset: null, reportedReset: reset };
  }
  return null;
}

// A billing period is a month, so its end can legitimately sit ~31 days out — the same sentinel clamp as
// the windows above, with the bound its own length rather than a window's.
const MONTHLY_MAX_RESET_MS = 2 * 31 * 86_400_000;

/** A spent credit pool, or null. Grok's plan meters a MONTHLY credit allowance alongside its weekly
 *  window, and routing refuses the rung on it too (`monthlyExhausted` in grokProviderCandidate). Credits
 *  can run dry while the weekly still reads room, so reading windows alone would report an available rung
 *  that routing skips — the overstated-depth blind spot, through the one door percentages can't express. */
function spentCredits(meters, at) {
  const { monthlyUsed: used, monthlyLimit: limit, monthlyReset: reset } = meters;
  if (typeof used !== "number" || typeof limit !== "number" || !(limit > 0) || used < limit) return null;
  if (reset != null && reset <= at) return null; // billing period ended — the pool has refilled
  const pct = Math.round((used / limit) * 100);
  const plausible = reset != null && reset - at <= MONTHLY_MAX_RESET_MS;
  if (reset == null || plausible) return { window: "monthly credits", pct, reset };
  return { window: "monthly credits", pct, reset: null, reportedReset: reset };
}

/** The windows an available backend still has, so "available" is a number the reader can check rather than
 *  a bare claim. Omits a window the backend doesn't meter (Grok reports no 5h, only Grok meters credits). */
function meterSummary(m) {
  return (
    [
      typeof m.fiveHour === "number" ? `5h ${Math.round(m.fiveHour)}%` : null,
      typeof m.sevenDay === "number" ? `7d ${Math.round(m.sevenDay)}%` : null,
      typeof m.monthlyUsed === "number" && m.monthlyLimit > 0
        ? `credits ${Math.round((m.monthlyUsed / m.monthlyLimit) * 100)}%`
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || "no windows metered"
  );
}

/** A backend's cached meters, read from data/<file>. Read-only and never throws: a missing or corrupt
 *  cache reads as "no meters", which leaves the rung on the latch-only verdict rather than inventing one. */
function readBackendUsage(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "data", file), "utf8"));
  } catch {
    return null;
  }
}

// A ChatGPT plan is not one allowance: `rateLimitsByLimitId` also carries a dedicated pool per model that
// ships its own (Spark). Those pools serve only the BOUNDED roles (DEDICATED_POOL_ROLES in
// agents/codexPools.ts), so they never lengthen the implementor ladder above — but they do decide whether
// a reader/planner/researcher can reach Codex at all, which the general meters cannot show.
const POOL_HARD_LIMIT_PCT = 95;

/** The dedicated Codex pools and whether each can take a bounded role right now. Pure, like
 *  `backendState`: `meters` is the cached usage reading, `latches` the parsed per-pool latch blob, `at`
 *  the clock. A window counts as spent only while its reset is still ahead — a lapsed reset has rolled
 *  over, the same rule the backend windows use. A pool with no meter at all is NOT a rung (fail-closed:
 *  routing refuses a pool it cannot see, so the readout must not promise one). */
function dedicatedPoolRungs(meters, latches, at) {
  const pools = meters && Array.isArray(meters.pools) ? meters.pools : [];
  return pools
    .filter((p) => p && p.limitId !== "codex" && p.modelSlug)
    .map((p) => {
      const latchedUntil = latches[p.limitId];
      const spent = (v, reset) => v != null && v >= POOL_HARD_LIMIT_PCT && (reset == null || reset > at);
      const latched = Number.isFinite(latchedUntil) && latchedUntil > at;
      const noMeter = p.fiveHour == null && p.sevenDay == null;
      const available = !latched && !noMeter && !spent(p.fiveHour, p.fiveHourReset) && !spent(p.sevenDay, p.sevenDayReset);
      return {
        name: p.limitName || p.limitId,
        model: p.modelSlug,
        available,
        reason: latched ? "capped" : noMeter ? "no meter" : available ? "ready" : "spent",
        until: latched ? latchedUntil : null,
        fiveHour: p.fiveHour == null ? null : p.fiveHour,
        sevenDay: p.sevenDay == null ? null : p.sevenDay,
      };
    });
}

/** The per-pool cap latches threadManager persists as one {limitId: epochMs} blob. Absent/corrupt reads
 *  as "nothing latched", matching loadPoolCaps, which starts clean rather than failing the boot. */
function readPoolLatches(kv, poolCapKey) {
  if (!poolCapKey) return {};
  const raw = kv(poolCapKey);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** A sub only counts as a live rung while BOTH windows are under the hard limit — a sub sitting at 99%
 *  weekly still shows a healthy-looking 5h number but can't actually take a task. */
function claudeHasHeadroom(usage) {
  return (usage.fiveHour ?? 0) < HARD_LIMIT_PCT && (usage.sevenDay ?? 0) < HARD_LIMIT_PCT;
}

// The ladder above is the IMPLEMENTOR's. Some roles reach the owner only through the in-process MCP bus
// (post_finding/ask_user), which the text-bridge backends don't serve, so their real ladder is shorter —
// and a readout that prints one depth for everything states the widest reach as if it were everyone's.
// That is what hid the 08-14 defect: sweeps read "depth 3" for weeks while the auto-reviewer's own depth
// was 1, until a click on a capped sub burned itself out with a live backend sitting right there.
const ROLE_POLICY_SETS = { roles: "MCP_DEPENDENT_ROLES", providers: "CLI_BRIDGED_PROVIDERS" };
// provider id (threadManager) → the rung name printed above. A CLI-bridged backend missing from here would
// silently drop out of the exclusion, so the gate pins this map against BACKENDS.
const PROVIDER_RUNG = { codex: "Codex", grok: "Grok", zai: "z.ai" };

/** The role→backend policy, read out of threadManager.ts rather than restated here. Returns null when
 *  either Set can't be found — a rename must read as UNKNOWN, never as "no role is restricted", which is
 *  the flattering direction this whole readout exists to avoid. */
function roleReachPolicy(src) {
  const members = (name) => {
    const m = src.match(new RegExp(`${name}\\b[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/"([a-z.]+)"/g)].map((x) => x[1]) : null;
  };
  const roles = members(ROLE_POLICY_SETS.roles);
  const providers = members(ROLE_POLICY_SETS.providers);
  return roles && providers ? { roles, providers } : null;
}

/** Read the live threadManager source, or null when it isn't next to this script (a copied-out probe). */
function readThreadManagerSource() {
  try {
    return fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "threadManager.ts"), "utf8");
  } catch {
    return null;
  }
}

/** How many rungs a role has once the backends that can't serve it are struck off. The Claude subs are
 *  never excluded (they're where these roles run by default); only the alt rungs are filtered. */
function roleLadderDepth(backends, claudeRungs, excludedNames) {
  return claudeRungs + backends.filter((b) => b.available && !excludedNames.includes(b.name)).length;
}

/** The depth the MCP-dependent roles actually have, printed only when it differs from the implementor's —
 *  a shorter ladder for the role that decides a task's fate is the finding, and it is invisible above. */
function printRoleReach(backends, claudeRungs, depth) {
  const src = readThreadManagerSource();
  const policy = src && roleReachPolicy(src);
  if (!policy) {
    console.log(
      `\n  ⚠ could not read ${ROLE_POLICY_SETS.roles}/${ROLE_POLICY_SETS.providers} from threadManager.ts — ` +
        "per-role reach is UNKNOWN, not unrestricted. Some roles may have a shorter ladder than the depth above.",
    );
    return;
  }
  if (!policy.roles.length) return; // no role is restricted — the one depth above is everyone's
  const excluded = policy.providers.map((p) => PROVIDER_RUNG[p] ?? p);
  const roleDepth = roleLadderDepth(backends, claudeRungs, excluded);
  console.log(
    `\n  reach for ${policy.roles.join(" + ")}: ${roleDepth} rung(s) — these answer the owner ONLY through the` +
      `\n  in-process MCP bus (post_finding/ask_user), so ${excluded.join(" and ")} can't serve them at all.` +
      (roleDepth < depth
        ? `  ⚠ SHORTER than the ${depth} above — the depth line overstates what these roles can reach.`
        : ""),
  );
}

/** The dedicated-pool readout. Printed only when the plan actually HAS one, so a deployment without
 *  Spark reads exactly as before. The heading says 'bounded roles only' outright because a reader who
 *  mistook this for implementor headroom would over-count the ladder above — the precise error the
 *  ladder readout exists to prevent. */
function printDedicatedPools(backends, kv, usage) {
  for (const b of backends) {
    if (!b.poolCapKey) continue;
    const meters = b.usageFile ? usage(b.usageFile) : null;
    const rungs = dedicatedPoolRungs(meters, readPoolLatches(kv, b.poolCapKey), now);
    if (!rungs.length) continue;
    console.log(`\n  ${b.name} dedicated pools (bounded roles only — reader/planner/researcher, never implementor or QA):`);
    for (const r of rungs) {
      const note =
        r.reason === "capped"
          ? `CAPPED — frees in ${countdown(r.until)}`
          : r.reason === "no meter"
            ? "no meter yet"
            : r.reason === "spent"
              ? "NO ROOM"
              : "available";
      console.log(`    ${r.available ? "✓" : "✗"} ${r.name} (${r.model})  ${note}  (5h ${pct(r.fiveHour).trim()} · 7d ${pct(r.sevenDay).trim()})`);
    }
  }
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
    "startup cooldown": (s) => `STARTUP WEDGED — retry eligible in ${countdown(s.until)}`,
    capped: (s) => `CAPPED — frees in ${countdown(s.until)}`,
    // A spent window was never rejected, so there is no latch and no cooldown to count down — only the
    // real window reset, which the meters may not even name. Say which window and how full it is, or the
    // line reads like a mystery outage.
    spent: (s) =>
      `NO ROOM — ${s.window} at ${Math.round(s.pct)}%` +
      (s.until != null
        ? `, resets in ${countdown(s.until)}`
        : s.reportedReset != null
          ? `, reset unknown (backend reported ${new Date(s.reportedReset).toISOString().slice(0, 10)}, too far out to be a ${s.window} period)`
          : ", reset unknown"),
    ready: (s) => "available" + (s.meters ? ` (${meterSummary(s.meters)})` : " (no usage reading yet)"),
  };
  const backends = BACKENDS.map((b) => ({ ...b, ...backendState(b, kv, now, readBackendUsage) }));
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

  printDedicatedPools(backends, kv, readBackendUsage);

  printRoleReach(backends, claudeRungs, depth);

  console.log(
    '\nReading it: "idle" on a chip = a stagger hold-off, NOT that the subscription is globally unused. A sub' +
      "\nshared with another orchestrator/service shows extWakeAt set; while held, GG can't see that outside" +
      "\nburn. holdUntil in the future + extWakeAt lapsed is the classic false-idle case this probe exists for." +
      "\nA CAPPED alt backend is expected (the latch self-expires and routing skips it); NO ROOM is the quieter" +
      "\nform — a window simply spent, so nothing was ever rejected and nothing is latched, and only the real" +
      "\nwindow reset frees it. Either way it only matters when it shrinks the ladder to one rung.",
  );
  db.close();
}

if (require.main === module) main();

module.exports = {
  backendState,
  dedicatedPoolRungs,
  readPoolLatches,
  POOL_HARD_LIMIT_PCT,
  claudeHasHeadroom,
  roleReachPolicy,
  roleLadderDepth,
  readThreadManagerSource,
  PROVIDER_RUNG,
  spentWindow,
  spentCredits,
  BACKENDS,
  HARD_LIMIT_PCT,
  MIRRORED_HEADROOM_TERMS,
};
