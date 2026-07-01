// Best-effort, READ-ONLY live monitor for token-freeze / cap events during a session.
// Tails the orchestrator's SQLite for the state transitions that a freeze produces and appends
// timestamped lines to token_freeze_test.log. It never writes to the DB or touches source.
//
//   node token_freeze_monitor.cjs [--once] [--seconds N]
//
// Signals watched:
//   - threads.error starting with "⏳ Auto-resume pending"  (CAP_PARK — every account rate-limited)
//   - threads.state = 'review'|'failed' with a non-cap error (a hard park, e.g. a context overflow)
//   - agent_runs.state = 'error'                            (a run that ended on an error/cap)
// A token freeze may NOT fire during a session; if nothing changes, the log simply records the
// baseline snapshot and "no transitions observed", which is the honest outcome.

const path = require("node:path");
const fs = require("node:fs");

const DB_PATH = path.join(__dirname, "server", "data", "orchestrator.sqlite");
const LOG_PATH = path.join(__dirname, "token_freeze_test.log");
const CAP_MARKER = "⏳ Auto-resume pending";
const POLL_MS = 5000;

const argv = process.argv.slice(2);
const once = argv.includes("--once");
const secIdx = argv.indexOf("--seconds");
const runSeconds = secIdx >= 0 ? Number(argv[secIdx + 1]) : 0; // 0 = run until killed

function stamp() {
  return new Date().toISOString();
}
function append(line) {
  fs.appendFileSync(LOG_PATH, `[${stamp()}] ${line}\n`);
}

let Database;
{
  // The orchestrator's better-sqlite3 lives under server/node_modules, not the repo root — try both.
  const candidates = [
    path.join(__dirname, "server", "node_modules", "better-sqlite3"),
    path.join(__dirname, "node_modules", "better-sqlite3"),
  ];
  let lastErr;
  for (const c of candidates) {
    try {
      Database = require(c);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!Database) {
    append(`FATAL: could not load better-sqlite3 (${lastErr && lastErr.message}). Monitor not started.`);
    process.exit(1);
  }
}
if (!fs.existsSync(DB_PATH)) {
  append(`FATAL: DB not found at ${DB_PATH}. Is the orchestrator running? Monitor not started.`);
  process.exit(1);
}

// Open read-only so we can never perturb the live server's DB.
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

function classify(t) {
  const err = t.error || "";
  if (err.startsWith(CAP_MARKER)) return "CAP-PARK (rate-limit, auto-resume pending)";
  if (t.state === "review") return "HUMAN-GATED REVIEW (no auto-resume — generic/other, incl. context overflow)";
  if (t.state === "failed") return "FAILED";
  return t.state;
}

// Baseline snapshot so a later transition is meaningful.
const prev = new Map();
function snapshot() {
  const threads = db.prepare("SELECT id, title, state, error FROM threads").all();
  const out = [];
  for (const t of threads) {
    const key = `${t.state}|${t.error || ""}`;
    if (prev.get(t.id) !== key) {
      if (prev.has(t.id)) {
        out.push(`THREAD ${String(t.id).slice(0, 8)} "${t.title}" → ${classify(t)}${t.error ? ` :: ${t.error}` : ""}`);
      }
      prev.set(t.id, key);
    }
  }
  // Recently errored runs (cap or hard error) — the run-level signal behind a thread transition.
  let runs = [];
  try {
    runs = db.prepare("SELECT thread_id, role, state, error, ended_at FROM agent_runs WHERE state='error' ORDER BY ended_at DESC LIMIT 5").all();
  } catch { /* schema variance — ignore */ }
  return { out, runs };
}

append(`=== monitor start (db=${DB_PATH}) ===`);
{
  const threads = db.prepare("SELECT id, title, state, error FROM threads").all();
  append(`baseline: ${threads.length} threads; ${threads.filter((t) => (t.error || "").startsWith(CAP_MARKER)).length} cap-parked, ${threads.filter((t) => t.state === "review").length} in review, ${threads.filter((t) => t.state === "failed").length} failed.`);
  for (const t of threads) prev.set(t.id, `${t.state}|${t.error || ""}`);
}

function tick() {
  const { out } = snapshot();
  for (const line of out) append(line);
}

if (once) {
  tick();
  append("=== --once snapshot complete ===");
  process.exit(0);
}

const started = Date.now();
const timer = setInterval(() => {
  tick();
  if (runSeconds > 0 && Date.now() - started >= runSeconds * 1000) {
    append(`=== monitor stop (ran ${runSeconds}s, no fatal) ===`);
    clearInterval(timer);
    process.exit(0);
  }
}, POLL_MS);

process.on("SIGINT", () => {
  append("=== monitor stop (SIGINT) ===");
  process.exit(0);
});
