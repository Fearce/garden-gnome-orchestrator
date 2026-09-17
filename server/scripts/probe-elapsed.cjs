#!/usr/bin/env node
// "Why did that task take nine hours?" — the question no other probe could answer.
//
// The owner reads WALL-CLOCK: a task opened at 09:24 and was still going at 19:48. The fleet's existing
// probes read everything else. probe:task-runs shows one task's run trail, probe:run-errors classifies
// non-done runs in a window, probe:accounts shows capacity RIGHT NOW, probe:parks names what is waiting on
// a person. None of them subtracts, so none of them can say the one thing the owner is actually asking:
// of those ten hours, how many had an agent running at all, and what was the console doing in the rest?
//
// That gap cost a whole investigation on 2026-09-17 ("are my agents over-working?"). Hand-reading run rows
// answered it — 10.4h elapsed, 6.5h with an agent running, ~3.9h waiting for a Claude session limit to
// reset with no failover rung left — and the answer was the opposite of the fear: the agents were not
// padding, the fleet had nowhere to run. Nothing about that reading was task-specific, so it is this probe.
//
//   node scripts/probe-elapsed.cjs [hours]                 (default 168 = 7 days)
//   node scripts/probe-elapsed.cjs --task <id|title>       one task's gap-by-gap timeline
//   node scripts/probe-elapsed.cjs 72 --json               machine-readable, for an agent
//   npm run probe:elapsed --prefix server -- 72
//
// Read-only; safe while prod is up (WAL + busy_timeout), and it never touches `messages` — 600k+ rows,
// and every signal it needs lives in a small indexed table (see .claude/rules/hot-path-query-performance.md).
//
// What it measures, and the two subtleties that make the number honest:
//   • BUSY is the UNION of the task's run intervals, not their sum. Two agents running concurrently
//     (shotgun, or an implementor overlapping a reviewer) spend one hour of the owner's time, not two;
//     summing would report a task as more than 100% busy and hide the waiting entirely.
//   • WAIT is every remaining second inside the span, each gap attributed to what the rows prove was
//     happening — a usage cap, an unanswered ask_user, an owner park, a restart, a warm resume. An
//     unattributable gap is reported as such rather than folded into a flattering bucket.
//
// It deliberately does NOT re-derive turn-ceiling economics (rate + trend per role): that reading exists in
// ceiling-economics.cjs and prints under probe:run-errors. This probe only counts the cutoffs it saw, and
// points there.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { classifyRun } = require("./probe-run-errors.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const DB_PATH = process.env.ORCH_DB ? path.resolve(process.env.ORCH_DB) : path.resolve(SERVER_DIR, "data", "orchestrator.sqlite");

const DEFAULT_HOURS = 168;
// Below this a "gap" is scheduler jitter between two runs of the same lane, not a wait anyone experienced.
// It still has to be REPORTED (as `jitter`), or the table and the verdict end up dividing by different
// denominators and disagree about the same bucket's share.
const MIN_GAP_MS = 5_000;
// A null `ended_at` means "still running" ONLY for a row in one of these states. The live DB holds orphans
// the completion-lifecycle bug left behind (`scripts/fix-stuck.cjs` is the repair) — `error` rows, months
// old, with no end stamp. Measuring those to `now` reported a finished task as 100% busy and erased every
// gap in it; over a 30-day window it invented 1,903 agent-hours and inverted the fleet's busy share.
const LIVE_RUN_STATES = new Set(["starting", "running", "idle"]);
// A gap this short after a finished run is the pipeline handing one role to the next, not a stall.
const HANDOFF_MS = 120_000;
const HOUR = 3_600_000;

// Ordered worst-first for the report; `owned` marks a cause somebody (a person or a quota) owns, as opposed
// to time the console itself spent. The label is the whole explanation — this output is read by an owner
// asking why their evening's task is not done yet.
const CAUSES = [
  { key: "cap", label: "capacity wait — a usage cap with no rung free to fail over to" },
  { key: "ownerAnswer", label: "owner answer wait — an ask_user question was open" },
  // Only an inject writes an owner_command_receipt today, so a Resume or Retry click ends a gap this probe
  // reports as `park`. Say so in the label rather than letting the split read as complete.
  { key: "ownerPark", label: "owner park — ended with the owner's own inject (a Resume/Retry click lands in `park` below)" },
  { key: "park", label: "parked between stages — nothing was queued, so a person or the supervisor had to act" },
  { key: "restart", label: "server restart + auto-resume" },
  { key: "resume", label: "warm-resume / retry lag after an involuntary stop" },
  { key: "failure", label: "recovery after a real failure" },
  { key: "handoff", label: "pipeline handoff between roles" },
  { key: "jitter", label: "scheduler jitter under 5s between runs" },
  { key: "unattributed", label: "unattributed — no cap, question, owner action or error explains it" },
];
const CAUSE_LABEL = new Map(CAUSES.map((c) => [c.key, c.label]));

/** Whether this row is an agent that is genuinely still going, as opposed to one that lost its end stamp. */
function isLive(run) {
  return run.ended_at == null && LIVE_RUN_STATES.has(run.state);
}

/** When a run stopped occupying the owner's time. A live run runs to `nowMs`; an orphan closes at its own
 *  start, so it contributes no busy time it cannot prove. `Math.max` also survives a row whose stamps are
 *  inverted, which would otherwise make the gap loop produce negative waits. */
function runEnd(run, nowMs) {
  if (isLive(run)) return Math.max(nowMs, run.started_at);
  return Math.max(run.ended_at ?? run.started_at, run.started_at);
}

/** The union of a task's run intervals, in order. */
function mergeIntervals(runs, nowMs) {
  const spans = runs
    .map((run) => ({ start: run.started_at, end: runEnd(run, nowMs), run }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      // The run that ends LATEST is the one whose outcome explains a gap after this block.
      if (span.end > last.end) {
        last.end = span.end;
        last.run = span.run;
      }
      continue;
    }
    merged.push({ start: span.start, end: span.end, run: span.run });
  }
  return merged;
}

function overlaps(gap, from, to) {
  return from < gap.end && (to ?? Infinity) > gap.start;
}

/** classifyRun answers "which non-done class is this", so it must never be asked about a run that finished:
 *  its last resort reads a turn count, which files a perfectly good `done` run at the role ceiling as a
 *  cutoff and every other one as `unclassifiable` — a real failure, in this probe's vocabulary. */
function classOf(run) {
  if (!run || run.state === "done" || LIVE_RUN_STATES.has(run.state)) return null;
  return classifyRun(run);
}

/** What the rows prove was happening between two blocks of agent work. `before` is the run whose end opened
 *  the gap; it is the strongest evidence available, because the orchestrator's reaction to how a run ended
 *  IS the wait (a cap parks until reset, a restart waits for boot, a cutoff warm-resumes). */
function attributeGap(gap, before, context = {}) {
  const { questions = [], ownerCommands = [] } = context;
  const cls = classOf(before);
  // `cap_flagged` is the RUNNER's own verdict, which is what survives a backend wording this file has never
  // seen — but only for a run that did NOT finish. A `done` run that hit a cap, failed over and completed
  // was never blocked, and reading its flag manufactures capacity evidence in the permissive direction.
  if (cls === "cap" || (cls !== null && before.cap_flagged === 1)) {
    return { cause: "cap", detail: capDetail(before) };
  }
  const question = questions.find((q) => overlaps(gap, q.created_at, q.answered_at));
  if (question) {
    return { cause: "ownerAnswer", detail: question.answered_at ? "answered" : "still unanswered" };
  }
  const command = ownerCommands.find((c) => c.created_at >= gap.start && c.created_at <= gap.end);
  if (command) {
    return { cause: "ownerPark", detail: `ended with the owner's ${command.command}` };
  }
  if (cls === "restart") return { cause: "restart", detail: "killed by a server restart" };
  // The hard deadline blocks dispatch AND resume until the owner clears the clock, so it is a park a person
  // owns — filing it under warm-resume would send them to the turn-ceiling reading for a wait no agent can end.
  if (cls === "deadline") {
    return { cause: "park", detail: "stopped by the owner's active-task hard deadline — only the owner's clock releases it" };
  }
  // `structured` is a human-alarm class in probe-run-errors, not something the pipeline rides out.
  if (cls === "real" || cls === "unclassifiable" || cls === "structured") {
    return { cause: "failure", detail: shortText(before?.error) };
  }
  if (cls) return { cause: "resume", detail: `${cls} — warm-resumed` };
  if (gap.end - gap.start <= HANDOFF_MS) return { cause: "handoff", detail: null };
  // A run that ended cleanly and was followed by hours of silence is the shape of a task parked in `review`:
  // the pipeline queues the next role in seconds, so nothing but a person (or the supervisor acting for one)
  // restarts a task after that. It is the single largest slice of elapsed time on this fleet, and reading it
  // as "unexplained" made a board full of waiting tasks look like a console defect.
  if (!cls && before?.state === "done") {
    return { cause: "park", detail: `nothing queued after a completed ${before.role} run` };
  }
  return { cause: "unattributed", detail: null };
}

function capDetail(run) {
  const text = shortText(run?.error);
  return text || "flagged by the runner as a cap";
}

function shortText(value, max = 80) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An unanswered `ask_user` is open forever in the table, but the task stopped waiting on it the moment an
 *  agent ran again. Left unbounded, one abandoned question claims every later gap in the task — restarts,
 *  failures, week-long parks — and can flip the whole fleet verdict to OWNER-BOUND off a single row. */
function boundQuestions(questions, blocks) {
  return questions.map((q) => {
    if (q.answered_at) return q;
    const resumed = blocks.find((block) => block.start > q.created_at);
    return resumed ? { ...q, answered_at: resumed.start } : q;
  });
}

/** One task's elapsed-time reading: span, busy, and every gap with its cause. */
function taskReading({ thread, runs, questions = [], ownerCommands = [], nowMs }) {
  const blocks = mergeIntervals(runs, nowMs);
  const spanStart = blocks[0].start;
  const spanEnd = blocks[blocks.length - 1].end;
  const busyMs = blocks.reduce((total, block) => total + (block.end - block.start), 0);
  const bounded = boundQuestions(questions, blocks);

  const gaps = [];
  let jitterMs = 0;
  for (let i = 1; i < blocks.length; i += 1) {
    const gap = { start: blocks[i - 1].end, end: blocks[i].start };
    const ms = gap.end - gap.start;
    if (ms < MIN_GAP_MS) {
      jitterMs += ms;
      continue;
    }
    gaps.push({ ...gap, ms, ...attributeGap(gap, blocks[i - 1].run, { questions: bounded, ownerCommands }) });
  }

  const byCause = new Map();
  for (const gap of gaps) byCause.set(gap.cause, (byCause.get(gap.cause) ?? 0) + gap.ms);
  // Reported rather than dropped: every gap must land somewhere, or the cause table and the verdict divide
  // by different denominators and disagree about the same bucket's share.
  if (jitterMs > 0) byCause.set("jitter", jitterMs);

  return {
    id: thread?.id ?? runs[0].thread_id,
    title: thread?.title ?? "(deleted task)",
    state: thread?.state ?? "gone",
    startedAt: spanStart,
    endedAt: spanEnd,
    live: runs.some(isLive),
    spanMs: spanEnd - spanStart,
    busyMs,
    waitMs: spanEnd - spanStart - busyMs,
    gaps,
    waitByCause: Object.fromEntries(byCause),
    runs: runs.length,
    turns: runs.reduce((total, run) => total + (run.num_turns ?? 0), 0),
    costUsd: runs.reduce((total, run) => total + (run.cost_usd ?? 0), 0),
    cutoffs: runs.filter((run) => classOf(run) === "cutoff").length,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The fleet verdict. The point of the whole probe is that "tasks are taking longer" has three completely
 *  different cures, and the owner cannot tell them apart from the board: the agents are genuinely doing
 *  more work, the fleet has no quota to run on, or the tasks are sitting on the owner's own desk. */
function verdictFor(totals) {
  const { spanMs, busyMs, waitByCause } = totals;
  if (!spanMs) return { key: "empty", line: "no task ran in this window — nothing to read" };
  const entries = Object.entries(waitByCause).sort((a, b) => b[1] - a[1]);
  const waitMs = entries.reduce((total, [, ms]) => total + ms, 0);
  const busyShare = busyMs / spanMs;
  if (!entries.length || waitMs / spanMs < 0.2) {
    return {
      key: "agent",
      line: `AGENT-BOUND — ${pct(busyShare)} of elapsed time had an agent running. The time is going into the work itself, so read turns/cost per task (probe:run-errors, ceiling economics) rather than capacity.`,
    };
  }
  const [topCause, topMs] = entries[0];
  const share = topMs / waitMs;
  const map = {
    cap: `CAPACITY-BOUND — ${pct(share)} of the non-working time was quota wait. The agents are not slow, the fleet has nowhere to run; check the ladder with probe:accounts.`,
    ownerAnswer: `OWNER-BOUND — ${pct(share)} of the non-working time was an open ask_user question. Tasks are waiting on answers, not on agents.`,
    ownerPark: `OWNER-BOUND — ${pct(share)} of the non-working time was a task parked for a click. probe:parks names which ones.`,
    park: `PARK-BOUND — ${pct(share)} of the non-working time was tasks sitting between stages with nothing queued, i.e. waiting on a person. The agents were not running at all; probe:parks names what needs a human.`,
    restart: `RESTART-BOUND — ${pct(share)} of the non-working time was server bounces and their auto-resumes. Check keepAlive/deploy churn before blaming the agents.`,
    resume: `RESUME-BOUND — ${pct(share)} of the non-working time was warm-resume lag after involuntary stops. Read the per-role cutoff rate and trend in probe:run-errors.`,
    failure: `FAILURE-BOUND — ${pct(share)} of the non-working time followed real failures. Triage them with probe:run-errors.`,
    handoff: `PIPELINE-BOUND — ${pct(share)} of the non-working time was role handoff overhead.`,
    jitter: `PIPELINE-BOUND — ${pct(share)} of the non-working time was sub-5s scheduler jitter, i.e. there is no real wait here.`,
    unattributed: `UNEXPLAINED — ${pct(share)} of the non-working time matches no cap, question, owner action or error. Drill into the slowest task with --task.`,
  };
  return { key: topCause, line: map[topCause] };
}

function fleetReading(tasks) {
  const waitByCause = {};
  let spanMs = 0;
  let busyMs = 0;
  for (const task of tasks) {
    spanMs += task.spanMs;
    busyMs += task.busyMs;
    for (const [cause, ms] of Object.entries(task.waitByCause)) {
      waitByCause[cause] = (waitByCause[cause] ?? 0) + ms;
    }
  }
  const totals = {
    tasks: tasks.length,
    spanMs,
    busyMs,
    waitMs: spanMs - busyMs,
    waitByCause,
    medianSpanMs: median(tasks.map((t) => t.spanMs)),
    medianBusyMs: median(tasks.map((t) => t.busyMs)),
    medianTurns: median(tasks.map((t) => t.turns)),
    medianCostUsd: median(tasks.map((t) => t.costUsd)),
    cutoffs: tasks.reduce((total, task) => total + task.cutoffs, 0),
  };
  return { totals, verdict: verdictFor(totals) };
}

// ---- rendering ----

function hours(ms) {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / HOUR).toFixed(1)}h`;
}
function pct(share) {
  return `${Math.round(share * 100)}%`;
}
/** A task whose only run started and ended in the same millisecond (a reviewer killed at launch is a real
 *  row here) has a zero span, and every share of it would print as NaN%. */
function ratio(part, whole) {
  return whole > 0 ? part / whole : 0;
}
function usd(value) {
  return `$${(value ?? 0).toFixed(2)}`;
}
function stamp(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function renderCauses(waitByCause, waitMs, gapCounts) {
  const rows = CAUSES.map((cause) => [cause, waitByCause[cause.key] ?? 0]).filter(([, ms]) => ms > 0);
  if (!rows.length) return ["  (no gap long enough to report)"];
  return rows
    .sort((a, b) => b[1] - a[1])
    .map(([cause, ms]) => {
      const count = gapCounts?.get(cause.key);
      const where = count ? ` · ${count} gap(s)` : "";
      return `  ${hours(ms).padStart(6)}  ${String(pct(ratio(ms, waitMs))).padStart(4)}  ${cause.label}${where}`;
    });
}

function renderFleet(tasks, { hoursWindow }) {
  const { totals, verdict } = fleetReading(tasks);
  const gapCounts = new Map();
  for (const task of tasks) {
    for (const gap of task.gaps) gapCounts.set(gap.cause, (gapCounts.get(gap.cause) ?? 0) + 1);
  }
  const lines = [];
  lines.push(`Elapsed-time triage @ ${stamp(Date.now())}Z · last ${hoursWindow}h · ${DB_PATH}`);
  lines.push("");
  if (!tasks.length) {
    lines.push("No task ran an agent in this window.");
    return lines.join("\n");
  }
  lines.push(
    `${totals.tasks} task(s) ran · ${hours(totals.spanMs)} of elapsed task time (summed across tasks, which overlap — not a wall clock), ${hours(totals.busyMs)} of it with an agent actually running (${pct(ratio(totals.busyMs, totals.spanMs))})`,
  );
  lines.push("");
  lines.push(`Where the other ${hours(totals.waitMs)} went:`);
  lines.push(...renderCauses(totals.waitByCause, totals.waitMs, gapCounts));
  lines.push("");
  lines.push("Slowest by elapsed time:");
  for (const task of [...tasks].sort((a, b) => b.spanMs - a.spanMs).slice(0, 8)) {
    const top = Object.entries(task.waitByCause).sort((a, b) => b[1] - a[1])[0];
    const waited = top ? ` · biggest wait ${hours(top[1])} ${top[0]}` : "";
    lines.push(
      `  ${task.id.slice(0, 8)} [${task.state}] ${hours(task.spanMs)} elapsed · ${hours(task.busyMs)} busy (${pct(ratio(task.busyMs, task.spanMs))})${waited} · ${task.runs} run(s), ${task.turns} turns, ${usd(task.costUsd)}`,
    );
    lines.push(`             ${shortText(task.title, 90)}`);
  }
  lines.push("");
  lines.push(
    `Agent effort per task (median): ${hours(totals.medianBusyMs)} busy · ${totals.medianTurns} turns · ${usd(totals.medianCostUsd)} — ${totals.cutoffs} turn-ceiling cutoff(s) in the window`,
  );
  lines.push(`  ↳ whether that cutoff count is a mis-sized ceiling: npm run probe:run-errors --prefix server -- ${hoursWindow}`);
  lines.push("");
  lines.push(`VERDICT: ${verdict.line}`);
  lines.push("  ↳ one task, gap by gap: npm run probe:elapsed --prefix server -- --task <id|title>");
  return lines.join("\n");
}

function renderTask(task) {
  const lines = [];
  lines.push(`${task.id} [${task.state}] ${task.title}`);
  lines.push(
    `${stamp(task.startedAt)}Z → ${task.live ? "still running" : `${stamp(task.endedAt)}Z`} · ${hours(task.spanMs)} elapsed · ${hours(task.busyMs)} busy (${pct(ratio(task.busyMs, task.spanMs))}) · ${hours(task.waitMs)} waiting`,
  );
  lines.push(`${task.runs} run(s) · ${task.turns} turns · ${usd(task.costUsd)} · ${task.cutoffs} turn-ceiling cutoff(s)`);
  lines.push("");
  if (!task.gaps.length) {
    lines.push("No gap over 5s — an agent was running for effectively the whole span.");
  } else {
    lines.push("Gaps:");
    for (const gap of task.gaps) {
      lines.push(`  ${stamp(gap.start)}Z +${hours(gap.ms).padStart(5)}  ${CAUSE_LABEL.get(gap.cause)}`);
      if (gap.detail) lines.push(`                         ${gap.detail}`);
    }
    lines.push("");
    lines.push(...renderCauses(task.waitByCause, task.waitMs));
  }
  lines.push("");
  lines.push("  ↳ the run trail behind these gaps: npm run probe:task-runs --prefix server -- " + task.id.slice(0, 8));
  return lines.join("\n");
}

// ---- CLI ----

function parseArgs(argv) {
  const args = { hours: DEFAULT_HOURS, task: null, json: false };
  let hoursGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--task") {
      args.task = argv[i + 1];
      i += 1;
      if (!args.task) throw new Error("--task needs a task id or title substring");
    } else if (/^\d+(\.\d+)?$/.test(arg)) {
      args.hours = Number(arg);
      hoursGiven = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!(args.hours > 0)) throw new Error("hours must be a positive number");
  // --task reads the task's whole history; accepting a window silently discards it.
  if (args.task && hoursGiven) throw new Error("--task reads the whole task, so it takes no hours window");
  return args;
}

function readTasks(db, { since, threadId, nowMs }) {
  const runs = threadId
    ? db.prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at").all(threadId)
    : db.prepare("SELECT * FROM agent_runs WHERE started_at >= ? ORDER BY started_at").all(since);
  const byThread = new Map();
  for (const run of runs) {
    if (!byThread.has(run.thread_id)) byThread.set(run.thread_id, []);
    byThread.get(run.thread_id).push(run);
  }
  const thread = db.prepare("SELECT id, title, state FROM threads WHERE id = ?");
  const questionsFor = db.prepare("SELECT created_at, answered_at FROM questions WHERE thread_id = ? ORDER BY created_at");
  // Only a receipt that actually EXECUTED ended a wait; a pending or conflicted one never reached the task.
  const commandsFor = db.prepare(
    "SELECT command, created_at FROM owner_command_receipts WHERE thread_id = ? AND status = 'completed' ORDER BY created_at",
  );
  return [...byThread.entries()].map(([id, threadRuns]) =>
    taskReading({
      thread: thread.get(id),
      runs: threadRuns,
      questions: questionsFor.all(id),
      ownerCommands: commandsFor.all(id),
      nowMs,
    }),
  );
}

/** `%` and `_` in an owner's search term are LIKE wildcards, so `--task some_name` would quietly match
 *  `someXname`. Escape them and declare the escape character. */
function likeLiteral(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function resolveThread(db, query) {
  const literal = likeLiteral(query);
  return (
    db.prepare("SELECT id, title, state FROM threads WHERE id = ?").get(query) ||
    db.prepare("SELECT id, title, state FROM threads WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 1").get(`${literal}%`) ||
    db.prepare("SELECT id, title, state FROM threads WHERE title LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 1").get(`%${literal}%`)
  );
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`usage: node scripts/probe-elapsed.cjs [hours] [--task <id|title>] [--json]\n${error.message}`);
    process.exit(2);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`no DB at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");
  try {
    report(db, args);
  } finally {
    db.close();
  }
}

function report(db, args) {
  const nowMs = Date.now();

  if (args.task) {
    const thread = resolveThread(db, args.task);
    if (!thread) {
      console.error(`No task matches "${args.task}" (by id or title).`);
      process.exit(1);
    }
    const [task] = readTasks(db, { threadId: thread.id, nowMs });
    if (!task) {
      console.error(`Task ${thread.id} has no agent run to measure.`);
      process.exit(1);
    }
    console.log(args.json ? JSON.stringify(task, null, 2) : renderTask(task));
    return;
  }

  const tasks = readTasks(db, { since: nowMs - args.hours * HOUR, nowMs });
  if (args.json) {
    const { totals, verdict } = fleetReading(tasks);
    console.log(JSON.stringify({ windowHours: args.hours, totals, verdict, tasks }, null, 2));
    return;
  }
  console.log(renderFleet(tasks, { hoursWindow: args.hours }));
}

module.exports = { CAUSES, attributeGap, boundQuestions, classOf, isLive, likeLiteral, runEnd, fleetReading, mergeIntervals, parseArgs, renderFleet, renderTask, taskReading, verdictFor, HANDOFF_MS, MIN_GAP_MS };

if (require.main === module) main();
