// One-shot post-bounce / nightly quality probe for garden-gnome orchestrator.
// Read-only. Safe while prod is up (WAL + busy_timeout). Does NOT restart anything.
//
//   npm run health --prefix server
//   node scripts/nightly-health.cjs
//   node scripts/nightly-health.cjs --base http://127.0.0.1:4317
//
// What a resume-after-orchestrator-bounce agent needs in one command:
//   • /api/health up?
//   • dist mtime vs :4317 listener start (stale build shadowing)?
//   • reliability symbols still present in dist (office/Grok QA path)?
//   • git dirty files (concurrent teammate WIP — leave alone unless yours)
//   • thread/run health from SQLite (caps, parks, stuck runs)
//
// Exit: 0 = service healthy + required dist symbols present.
//       1 = hard fail (unreachable, or a required symbol missing from dist).
// Dirty tree / review backlog are reported but do NOT fail the exit code.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const BASE = (flag("--base") || "http://127.0.0.1:4317").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..", "..");
const SERVER = path.resolve(__dirname, "..");
const DIST = path.join(SERVER, "dist");
const DB_PATH = path.join(SERVER, "data", "orchestrator.sqlite");

/** Symbols that must exist in built dist after the 2026-07-20 Grok office/QA hardening. */
const REQUIRED_SYMBOLS = [
  { file: "agents/officeBridge.js", re: /isJunkOfficeBody|endsWithOpenOfficeMarker/ },
  { file: "agents/grokRunner.js", re: /emitInitIfNeeded|openEnded/ },
  { file: "orchestrator/threadManager.js", re: /latestQaRun|markRunning/ },
];

let hardFail = false;
const notes = [];

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
  notes.push(msg);
}

function fail(msg) {
  console.log(`  ✗ ${msg}`);
  hardFail = true;
}

function winListener(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const re = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function processStartMs(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8" },
    ).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

async function main() {
  // ---- 1) HTTP health ----
  section(`health ${BASE}`);
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) fail(`GET /api/health → HTTP ${res.status}`);
    else {
      const healthJson = await res.json();
      if (healthJson.ok) ok(`ok models=${JSON.stringify(healthJson.models || {})}`);
      else fail(`health.ok is not true: ${JSON.stringify(healthJson)}`);
    }
  } catch (e) {
    fail(`GET /api/health failed: ${e && e.message ? e.message : e}`);
  }

  try {
    const res = await fetch(`${BASE}/api/version`);
    if (res.ok) {
      const v = await res.json();
      ok(`web asset ${v.web || JSON.stringify(v)}`);
    }
  } catch {
    /* version is optional */
  }

  // ---- 2) Listener PID + start vs dist mtime ----
  section("process vs dist");
  const pid = winListener(4317);
  if (!pid) warn("no LISTEN on :4317 (netstat) — service may be down or non-Windows probe");
  else {
    ok(`:4317 LISTEN pid=${pid}`);
    const startMs = processStartMs(pid);
    if (startMs) ok(`process started ${new Date(startMs).toISOString()}`);

    const sampleDist = path.join(DIST, "agents", "grokRunner.js");
    if (fs.existsSync(sampleDist)) {
      const distMs = fs.statSync(sampleDist).mtimeMs;
      ok(`dist/agents/grokRunner.js mtime ${new Date(distMs).toISOString()}`);
      if (startMs && distMs > startMs + 2000) {
        warn(
          "dist is NEWER than the running process start — server may still be on a stale build (someone needs a restart; if resume note said bounce already happened, re-check)",
        );
      } else if (startMs && startMs >= distMs - 5000) {
        ok("process started at/after dist mtime (fresh build likely loaded)");
      }
    } else {
      fail(`missing ${sampleDist}`);
    }
  }

  // ---- 3) Required dist symbols ----
  section("dist symbols (Grok office + QA path)");
  for (const { file, re } of REQUIRED_SYMBOLS) {
    const p = path.join(DIST, file);
    if (!fs.existsSync(p)) {
      fail(`missing ${file}`);
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    if (re.test(text)) ok(`${file} matches ${re}`);
    else fail(`${file} missing pattern ${re}`);
  }

  // ---- 4) Git dirty (concurrent WIP) ----
  section("git (leave concurrent WIP alone)");
  try {
    const branch = execFileSync("git", ["status", "-sb"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")[0];
    ok(branch || "(no branch line)");
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!porcelain.length) ok("working tree clean");
    else {
      warn(`${porcelain.length} dirty path(s) — concurrent agent WIP? do not git add -A`);
      for (const line of porcelain.slice(0, 25)) console.log(`    ${line}`);
      if (porcelain.length > 25) console.log(`    … +${porcelain.length - 25} more`);
    }
  } catch (e) {
    warn(`git status failed: ${e && e.message ? e.message : e}`);
  }

  // ---- 5) SQLite operational snapshot ----
  section("sqlite (last 24h)");
  if (!fs.existsSync(DB_PATH)) {
    warn(`no DB at ${DB_PATH}`);
  } else {
    try {
      const db = new Database(DB_PATH, { readonly: true });
      db.pragma("busy_timeout = 5000");
      const since = Date.now() - 24 * 3600 * 1000;

      const byState = db.prepare("SELECT state, count(*) c FROM threads GROUP BY state ORDER BY c DESC").all();
      console.log("  threads by state:", Object.fromEntries(byState.map((r) => [r.state, r.c])));

      const runs = db
        .prepare("SELECT state, count(*) c FROM agent_runs WHERE started_at > ? GROUP BY state")
        .all(since);
      console.log("  runs 24h:", Object.fromEntries(runs.map((r) => [r.state, r.c])));

      const stuck = db
        .prepare(
          `SELECT id, role, account, started_at FROM agent_runs
           WHERE state='running' AND started_at < ?
           ORDER BY started_at ASC LIMIT 10`,
        )
        .all(Date.now() - 2 * 3600 * 1000);
      if (stuck.length) warn(`${stuck.length} run(s) stuck >2h in state=running`);
      else ok("no runs stuck >2h");

      const caps = db
        .prepare(
          `SELECT count(*) c FROM agent_runs
           WHERE started_at > ? AND error LIKE '%weekly limit%'`,
        )
        .get(since);
      if (caps?.c) warn(`${caps.c} run(s) hit weekly limit in last 24h (failover expected)`);
      else ok("no weekly-limit errors in last 24h");

      const parks = db
        .prepare(
          `SELECT count(*) c FROM threads
           WHERE state='review' AND error LIKE 'QA could not complete%'`,
        )
        .get();
      if (parks?.c) warn(`${parks.c} thread(s) parked on bare/diagnosable QA-could-not-complete`);

      const junkChat = db
        .prepare(
          `SELECT count(*) c FROM chat_messages
           WHERE created_at > ? AND (body = '\\n' OR body = 'claimi' OR length(body) BETWEEN 1 AND 6)`,
        )
        .get(since);
      if (junkChat?.c) warn(`${junkChat.c} suspicious short/junk office chat body(ies) in 24h`);
      else ok("no obvious junk office bodies in 24h");

      db.close();
    } catch (e) {
      warn(`sqlite probe failed: ${e && e.message ? e.message : e}`);
    }
  }

  // ---- summary ----
  section("summary");
  if (hardFail) {
    console.log("FAIL — service down or dist missing required symbols.");
    process.exit(1);
  }
  if (notes.length) {
    console.log("OK (with notes):");
    for (const n of notes) console.log(`  - ${n}`);
  } else {
    console.log("OK — healthy, dist symbols present, no operational notes.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
