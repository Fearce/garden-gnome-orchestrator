// Triage EVERY non-done agent run in a recent window and name WHY each one ended — "the sweep says
// 10 errors in 24h, is anything actually broken?". Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-run-errors.cjs [hours]        (default 24)
//   npm run probe:run-errors --prefix server         (24h)
//   npm run probe:run-errors --prefix server -- 168  (last 7 days)
//
// Why it exists: `npm run health` prints `runs 24h: { error: 10, interrupted: 12 }` and stops there, and
// `probe:task-runs` needs a thread you already suspect. Neither answers "which of these are real?", so a
// sweep hand-writes SQL to find out — and the 2026-07-25 sweep first read four benign turn-ceiling cutoffs
// as four crashes because counts hide the reason. This classifies instead of counting, then VERIFIES that
// the mechanism each benign class relies on (failover, retry, boot auto-resume) actually ran.
//
// `classifyRun` + `CLASSES` are exported for nightly-health.cjs, so the sweep's first command and this probe
// can never disagree about what counts as a real failure.
//
// GOTCHAS:
//   • agent_runs has NO `backend` column — the backend is encoded in `model` (claude-* / grok-* / gpt-*-sol).
//   • `interrupted` = a server restart killed the run (markInterrupted), not the agent. Benign here, but the
//     cost already burned; a run can also be interrupted mid-cutoff, so cost/turns may be null.
//   • Rows written BEFORE the run-error fix (458566e) carry the opaque text "Run failed." with no reason. For
//     those the turn count IS the evidence: num_turns at/over the role's ceiling means a turn-ceiling cutoff.
//     An opaque row UNDER the ceiling can't be classified at all — it's reported as such, not guessed.
//   • "Claude Code process exited with code 1073807364" is Windows 0x40010004 (DBG_TERMINATE_PROCESS): the CLI
//     child was TREE-KILLED from outside (the script-hub stop+start footgun CLAUDE.md warns about) while the
//     server itself survived — so boot auto-resume never applies and the pipeline parks the task for a human.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const SERVER_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.resolve(SERVER_DIR, "data", "orchestrator.sqlite");

function readEnvNumber(key) {
  try {
    const line = fs
      .readFileSync(path.resolve(SERVER_DIR, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    const n = line ? Number(line.slice(key.length + 1).trim()) : NaN;
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

// Per-role turn ceilings, mirroring agents/roles.ts. Only the implementor's is configurable; keep the rest in
// sync if a role's maxTurns changes, or a legacy opaque cutoff on that role stops being recognised.
const ROLE_TURN_CEILING = {
  planner: 40,
  researcher: 40,
  reader: 40,
  qa: 60,
  implementor: readEnvNumber("IMPLEMENTOR_MAX_TURNS") ?? 100,
};

// These MIRROR the runner's own classifiers (RATE_LIMIT_RESULT_RE / SESSION_LIMIT_TEXT_RE /
// TRANSIENT_API_ERROR_RE in agents/runner.ts) but are deliberately BROADER: those gate control flow and must
// not swallow prose that merely mentions a limit, whereas these only label historical rows, where a miss is
// the expensive direction. The bare "You've hit your limit · resets …" (a Fable model-pool notice the runner
// catches via the rate_limit_event, not via text) is why the qualifier word here is optional.
const CAP_RE =
  /you'?ve hit your [\w .-]{0,24}limit|session limit|weekly limit|usage limit|hour limit|limit reached|rate.?limit|too many requests|\b429\b|payment required|quota (?:exceeded|reached)/i;
const TRANSIENT_RE =
  /api\s*(?:error|status)?\s*[:=]?\s*(?:500|502|503|504|520|522|524|529)\b|overload|internal server error|service unavailable|bad gateway|gateway timeout|temporar(?:y|ily) unavailable|connection (?:reset|closed)|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i;
const CUTOFF_RE = /per-session turn ceiling|error_max_turns/i;
const STRUCTURED_RE = /structured-output retries|error_max_structured_output_retries|structured output/i;
const OPAQUE_RE = /^run failed\.?$/i;

// Ordered so the verdict reads worst-first; `human` decides whether a class needs anyone's attention.
const CLASSES = [
  { key: "real", label: "REAL failure — the agent or its environment broke", human: true },
  { key: "unclassifiable", label: "opaque legacy row (pre-458566e) — no reason recorded", human: true },
  { key: "structured", label: "structured-output retries exhausted — the agent never matched the schema", human: true },
  { key: "cutoff", label: "turn-ceiling cutoff — involuntary, warm-resumed on the implementor path", human: false },
  { key: "cap", label: "usage cap — account/backend failover expected", human: false },
  { key: "transient", label: "transient provider/transport error — retried automatically", human: false },
  { key: "restart", label: "killed by a server restart — auto-resumed on boot", human: false },
];

/** Which CLASSES key a non-done run belongs to. Takes a raw `agent_runs` row (snake_case). */
function classifyRun(run) {
  if (run.state === "interrupted") return "restart";
  const err = String(run.error || "").trim();
  if (/interrupted by a server restart/i.test(err)) return "restart";
  if (CAP_RE.test(err)) return "cap";
  if (TRANSIENT_RE.test(err)) return "transient";
  if (CUTOFF_RE.test(err)) return "cutoff";
  if (STRUCTURED_RE.test(err)) return "structured";
  // A pre-fix row says only "Run failed.". Its turn count is the one piece of evidence left: at or over the
  // role's ceiling it was a cutoff, and below it there is genuinely nothing recorded to classify.
  if (!err || OPAQUE_RE.test(err)) {
    const ceiling = ROLE_TURN_CEILING[run.role];
    if (ceiling && run.num_turns != null && run.num_turns >= ceiling) return "cutoff";
    return "unclassifiable";
  }
  return "real";
}

module.exports = { classifyRun, CLASSES, ROLE_TURN_CEILING };

// ---- CLI ----

function short(s, n = 130) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function iso(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "—";
}
function usd(v) {
  return v != null ? `$${Number(v).toFixed(2)}` : "—";
}

function main() {
  const hours = Number(process.argv[2] ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error("usage: node scripts/probe-run-errors.cjs [hours]");
    process.exit(2);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`no DB at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");
  const since = Date.now() - hours * 3600 * 1000;

  const runs = db
    .prepare(
      `SELECT r.id, r.thread_id, r.role, r.model, r.account, r.state, r.error, r.cost_usd, r.num_turns,
              r.started_at, t.title, t.state AS thread_state, t.error AS thread_error
       FROM agent_runs r LEFT JOIN threads t ON t.id = r.thread_id
       WHERE r.started_at > ? AND r.state IN ('error','interrupted')
       ORDER BY r.started_at DESC`,
    )
    .all(since);
  const done = db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE started_at > ? AND state='done'").get(since).c;

  console.log(`\n=== non-done runs, last ${hours}h (${runs.length} of ${runs.length + done} finished runs) ===`);
  if (!runs.length) {
    console.log("  ✓ nothing errored or was interrupted in the window.");
    db.close();
    return;
  }

  const buckets = new Map(CLASSES.map((c) => [c.key, []]));
  for (const r of runs) buckets.get(classifyRun(r)).push(r);

  console.log("\n=== verdict ===");
  for (const c of CLASSES) {
    const rows = buckets.get(c.key);
    if (!rows.length) continue;
    const cost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    console.log(`  ${c.human ? "⚠" : "✓"} ${String(rows.length).padStart(3)} × ${c.label} (${usd(cost)})`);
  }
  const needsHuman = CLASSES.filter((c) => c.human).reduce((n, c) => n + buckets.get(c.key).length, 0);
  console.log(
    needsHuman
      ? `\n  ⚠ ${needsHuman} run(s) need a human look — detailed below. The rest are handled by design.`
      : "\n  ✓ every non-done run is an expected, handled outcome — nothing to fix.",
  );

  // Detail only the classes a human must read; the benign ones are summarised by task instead, so a long
  // window doesn't bury the real failures under dozens of expected restart rows.
  for (const c of CLASSES.filter((x) => x.human)) {
    const rows = buckets.get(c.key);
    if (!rows.length) continue;
    console.log(`\n=== ${c.label} (${rows.length}) ===`);
    for (const r of rows) {
      console.log(
        `- ${r.role} · ${r.model} · ${iso(r.started_at)} · ${usd(r.cost_usd)} · ${r.num_turns ?? "—"} turns` +
          `\n    task ${String(r.thread_id).slice(0, 8)} [${r.thread_state ?? "gone"}] ${short(r.title, 60)}` +
          `\n    ${short(r.error) || "(no error text recorded)"}`,
      );
    }
    if (c.key === "unclassifiable") {
      console.log(
        "  ↳ these predate the run-error fix (458566e) and can't be diagnosed from the DB. New rows always\n" +
          "    carry the agent's own words or the SDK subtype, so this class should shrink to zero over time.",
      );
    }
  }

  reportRecovery(db, buckets);
  reportBenignByTask(buckets);
  db.close();
}

// "Handled by design" is a claim about a MECHANISM (failover, retry, boot auto-resume), and the DB can check it
// rather than taking it on faith: a recovered run is followed by another run on the same task. Only tasks that
// still OWED work count — a `done`/`closed`/`cancelled` task legitimately has no follow-up (the usual case
// being a cap during the post-task self-improvement round, which by design can't affect the verdict), and a
// task still in flight may simply not have started its next run yet. That leaves `review` and `failed`: there,
// a benign-looking cap or restart as the last thing that happened is a task that stopped mid-work.
const OWED_WORK_STATES = new Set(["review", "failed"]);

function reportRecovery(db, buckets) {
  const hasLaterRun = db.prepare("SELECT 1 FROM agent_runs WHERE thread_id = ? AND started_at > ? LIMIT 1");
  const stalled = CLASSES.filter((c) => !c.human)
    .flatMap((c) => buckets.get(c.key).map((r) => ({ run: r, cls: c })))
    .filter((c) => OWED_WORK_STATES.has(c.run.thread_state))
    .filter((c) => !hasLaterRun.get(c.run.thread_id, c.run.started_at));

  console.log("\n=== recovery check (did the handling mechanism actually run?) ===");
  if (!stalled.length) {
    console.log("  ✓ every task that still owed work ran again after its cap/restart/retry.");
    return;
  }
  for (const s of stalled) {
    const park = String(s.run.thread_error || "").includes("⏳ Auto-resume pending")
      ? "cap-supervisor park (normal — resumeCapParked owns it)"
      : "NOT a cap-supervisor park — nothing is waiting to resume it";
    console.log(
      `  ⚠ ${s.run.role} · ${s.cls.key} · ${iso(s.run.started_at)} · task ${String(s.run.thread_id).slice(0, 8)} ` +
        `[${s.run.thread_state}] ${short(s.run.title, 46)}\n      ${park}`,
    );
  }
  console.log("  ↳ drill in with: npm run probe:task-runs --prefix server -- <id>");
}

function reportBenignByTask(buckets) {
  const benign = CLASSES.filter((c) => !c.human).flatMap((c) => buckets.get(c.key));
  if (!benign.length) return;
  console.log(`\n=== handled by design, by task (${benign.length}) ===`);
  const byThread = new Map();
  for (const r of benign) {
    if (!byThread.has(r.thread_id)) byThread.set(r.thread_id, { title: r.title, state: r.thread_state, n: 0, cost: 0 });
    const e = byThread.get(r.thread_id);
    e.n++;
    e.cost += r.cost_usd ?? 0;
  }
  for (const [id, e] of [...byThread.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`- ${String(id).slice(0, 8)} [${e.state ?? "gone"}] ${short(e.title, 60)} — ${e.n} run(s), ${usd(e.cost)}`);
  }
  console.log("  ↳ drill into any one with: npm run probe:task-runs --prefix server -- <id>");
}

if (require.main === module) main();
