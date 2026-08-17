// Diagnose ONE task's agent-run trail against the live DB — "why did this task loop / cost so much /
// keep getting interrupted?". Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-task-runs.cjs <thread-id | title-substring>
//   node scripts/probe-task-runs.cjs 66695c82
//   node scripts/probe-task-runs.cjs "grok usage"
//   npm run probe:task-runs --prefix server -- 66695c82
//
// What it shows:
//   • the thread's state/error, then every agent_run in order (role · model · state · cost · turns ·
//     duration · error) — the run trail CLAUDE.md's "Debugging a failed task" section tells you to read.
//   • per-(role,model) totals, and a state breakdown (done / error / interrupted / running).
//   • an auto-review trace: every reviewer hand-back / acceptance finding, and the next run it caused.
//     This answers the otherwise expensive question "did the reviewer send a fixable issue back to an
//     implementor, or did it simply re-park the task?" without hand-reading SQLite timestamps.
//   • a QA-loop check: the durable qaRoundsUsed counter against the maxQaRounds setting — the signature
//     of the durable-QA-budget drain (see qaRoundBudget.itest.ts / handoff 2026-07-20). QA *launches*
//     are reconciled separately, because rounds are only one of four things that spend one; the
//     arithmetic and the reasons live in scripts/qa-loop-check.cjs (gate: test:qa-loop-check).
//
// GOTCHA: agent_runs has NO `backend` column — the backend is encoded in `model` (grok-4.5 / gpt-*-sol /
// claude-*). Don't SELECT backend (SqliteError). `interrupted` = a server restart killed the run
// (markInterrupted), not the agent; null cost on such rows still burned real tokens before the kill.

const path = require("node:path");
const Database = require("better-sqlite3");
const { qaLoopReading } = require("./qa-loop-check.cjs");

const arg = process.argv.slice(2).join(" ").trim();
if (!arg) {
  console.error("usage: node scripts/probe-task-runs.cjs <thread-id | title-substring>");
  process.exit(2);
}

const dbPath = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const db = new Database(dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");

function section(title) {
  console.log(`\n=== ${title} ===`);
}
function short(s, n = 90) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function iso(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : null;
}
// A malformed blob must not take down the whole trail at the last section, after the
// expensive part has already printed.
function parseStageOutputs(raw) {
  try {
    return JSON.parse(raw || "{}") ?? {};
  } catch {
    return {};
  }
}
function dur(a, b) {
  if (!a || !b) return null;
  const s = Math.round((b - a) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// Resolve the thread: exact id, then id-prefix (the 8-char short id the UI shows), then newest title match.
let thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(arg);
if (!thread) {
  thread = db.prepare("SELECT * FROM threads WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${arg}%`);
}
if (!thread) {
  thread = db
    .prepare("SELECT * FROM threads WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(`%${arg}%`);
}
if (!thread) {
  console.error(`No thread matches "${arg}" (by id or title).`);
  process.exit(1);
}

section(`db: ${dbPath}`);
section("thread");
console.log({
  id: thread.id,
  title: short(thread.title, 70),
  state: thread.state,
  lane: thread.lane,
  created: iso(thread.created_at),
  error: short(thread.error, 120),
});

const runs = db
  .prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC")
  .all(thread.id);

// How much the run actually PRODUCED. `system` rows are the orchestrator's own notices (the auto-resume
// line), so they say nothing about whether the agent worked — the same exclusion ranSilently uses.
const outputOf = db.prepare("SELECT COUNT(*) n FROM messages WHERE run_id = ? AND kind != 'system'");
const produced = (r) => outputOf.get(r.id).n;
// A run that ended NON-ERROR having produced nothing never reached the model. That's the silent-resume
// signature, and it reads as a perfectly healthy `done` row — which is exactly why it went undiagnosed
// for days. Rows written before the fix keep their misleading `done` state, so the probe has to say it.
const silent = (r) => r.state === "done" && r.ended_at != null && produced(r) === 0;

section(`run trail (${runs.length} runs)`);
for (const r of runs) {
  console.log({
    role: r.role,
    model: r.model,
    state: r.state,
    cost: r.cost_usd != null ? Number(r.cost_usd.toFixed(3)) : null,
    turns: r.num_turns,
    dur: dur(r.started_at, r.ended_at),
    started: iso(r.started_at),
    error: short(r.error, 70) || undefined,
    // What the RUNNER concluded about a cap, where an error row is read. Absent = no verdict recorded
    // (a row predating the flag, or one a restart/silent-run stamp closed out) — never "saw no cap".
    ...(r.cap_flagged != null ? { cap: r.cap_flagged === 1 } : {}),
    ...(silent(r) ? { output: "⚠ NONE — never reached the model" } : {}),
  });
}

const silentRuns = runs.filter(silent);
if (silentRuns.length) {
  section(`silent runs (${silentRuns.length})`);
  console.log(
    "  These ended as `done` without producing a single message — the agent never ran. On an implementor\n" +
      "  that is the silent-resume failure: the CLI loaded the session, emitted init and exited, and the\n" +
      "  pipeline used to read it as a finish and hand the half-done work straight to QA.",
  );
  for (const r of silentRuns) {
    console.log(`  - ${r.role} · ${r.model} · ${iso(r.started_at)} · ${dur(r.started_at, r.ended_at)} · ${r.num_turns ?? "—"} turns`);
  }
  console.log(
    "  ↳ Handled since 2026-07-27 (threadManager `ranSilently` → forced-fresh retry, gate test:silent-resume).\n" +
      "    A silent run on a NEW row is stamped `error` instead and shows up in `npm run probe:run-errors`;\n" +
      "    a `done` one here predates that. Several in a row on one task means the retry itself isn't working.",
  );
}

section("totals by (role, model)");
const totals = db
  .prepare(
    `SELECT role, model, COUNT(*) n, ROUND(SUM(cost_usd), 3) cost, SUM(num_turns) turns
     FROM agent_runs WHERE thread_id = ? GROUP BY role, model ORDER BY role, cost DESC`,
  )
  .all(thread.id);
for (const t of totals) console.log(t);

section("state breakdown by role");
const byState = db
  .prepare(
    `SELECT role, state, COUNT(*) n FROM agent_runs WHERE thread_id = ? GROUP BY role, state ORDER BY role, n DESC`,
  )
  .all(thread.id);
for (const s of byState) console.log(s);

// Auto-review trace. A reviewer's structured verdict is persisted as a finding; the matching run alone
// cannot say whether it accepted, handed work back, or found no verdict. The next run after a hand-back
// makes the key control-flow transition visible: current builds should normally show implementor here,
// then a reviewer re-check. A missing/other next run is factual rather than automatically an error: it
// can be an old build, a zero fix-round budget, a failed routing gate, or a second owner click later.
section("auto-review trace");
{
  const fixBudgetRow = db.prepare("SELECT value FROM kv WHERE key = 'setting_max_review_fix_rounds'").get();
  const fixBudget = fixBudgetRow ? Number(fixBudgetRow.value) : 1; // first-boot default before the setting is persisted
  const verdicts = db
    .prepare(
      `SELECT summary, detail, created_at
       FROM findings
       WHERE thread_id = ? AND from_role = 'reviewer'
       ORDER BY created_at ASC`,
    )
    .all(thread.id)
    .filter((f) => /^Auto-review (?:handed this back|accepted this as finished)/.test(f.summary ?? ""));
  const handBacks = verdicts.filter((f) => /^Auto-review handed this back/.test(f.summary ?? ""));
  const accepts = verdicts.filter((f) => /^Auto-review accepted this as finished/.test(f.summary ?? ""));
  console.log({ maxReviewFixRoundsSetting: fixBudget, handBacks: handBacks.length, accepts: accepts.length });
  if (!verdicts.length) {
    console.log("  No settled auto-review verdicts are recorded for this task.");
  }
  for (const verdict of verdicts) {
    const handedBack = /^Auto-review handed this back/.test(verdict.summary ?? "");
    const next = handedBack ? runs.find((r) => r.started_at >= verdict.created_at) : undefined;
    const disposition = !handedBack
      ? "accepted"
      : next?.role === "implementor"
        ? "implementor fix round followed"
        : next
          ? `no immediate fix round (next run: ${next.role})`
          : "no later run recorded";
    console.log(`  - ${iso(verdict.created_at)} • ${disposition}`);
    console.log(`    ${short(verdict.summary, 180)}`);
    if (handedBack && next) {
      console.log(`    next: ${next.role} · ${next.model} · ${next.state} · ${iso(next.started_at)}`);
    }
  }
  if (handBacks.length && !handBacks.some((f) => runs.find((r) => r.started_at >= f.created_at && r.role === "implementor"))) {
    console.log("  ↳ No hand-back in this trail was followed by an implementor run. Check the historical build and maxReviewFixRounds setting before treating that as a defect.");
  }
}

// QA-loop heuristic — the durable-budget drain signature.
section("QA-loop check");
{
  const setting = (key) => db.prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value ?? null;
  // A non-numeric cap is no cap at all — reporting "within the NaN-round cap" would read as a pass.
  const cap = Number.isFinite(Number(setting("setting_max_qa_rounds"))) ? Number(setting("setting_max_qa_rounds")) : null;
  const appliesFixes = setting("setting_qa_applies_fixes") === "1";
  const qa = runs.filter((r) => r.role === "qa");
  const verdicts = qa.filter((r) => r.state === "done").length;
  const interrupted = qa.filter((r) => r.state === "interrupted").length;
  const errored = qa.filter((r) => r.state === "error").length;
  // The loop enforces its budget against these durable counters, not against the run rows.
  const stage = parseStageOutputs(thread.stage_outputs);
  console.log({
    maxQaRoundsSetting: cap,
    qaAppliesFixes: appliesFixes,
    qaLaunches: qa.length,
    qaRoundsUsed: stage.qaRoundsUsed ?? null,
    qaVerdicts: verdicts,
    qaKilledByRestart: interrupted,
    qaErrored: errored,
  });
  const reading = qaLoopReading({
    cap,
    launches: qa.length,
    roundsUsed: stage.qaRoundsUsed ?? null,
    cutoffResumes: stage.qaCutoffResumes,
    silentRetries: stage.qaSilentRetries,
    capFailovers: qa.filter((r) => r.cap_flagged === 1).length,
    interrupted,
    appliesFixes,
  });
  for (const line of reading.lines) console.log(line);
}

db.close();
