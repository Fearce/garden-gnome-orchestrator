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

/** A numeric override as the server itself would see it: the process env wins over `.env`, matching dotenv. */
function envNumber(key) {
  const fromFile = () => {
    try {
      const line = fs
        .readFileSync(path.resolve(SERVER_DIR, ".env"), "utf8")
        .split(/\r?\n/)
        .find((l) => l.startsWith(`${key}=`));
      return line ? line.slice(key.length + 1).trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const n = Number(process.env[key] ?? fromFile());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Per-role turn ceilings, mirroring agents/roles.ts. Only the implementor's is configurable; keep the rest in
// sync if a role's maxTurns changes, or a legacy opaque cutoff on that role stops being recognised.
const ROLE_TURN_CEILING = {
  planner: 40,
  researcher: 40,
  reader: 40,
  qa: 60,
  reviewer: 60,
  implementor: envNumber("IMPLEMENTOR_MAX_TURNS") ?? 100,
};

// These MIRROR the runner's own classifiers (RATE_LIMIT_RESULT_RE / SESSION_LIMIT_TEXT_RE /
// TRANSIENT_API_ERROR_RE in agents/runner.ts). Only ONE direction is dangerous here: matching too widely
// files a real failure as an expected outcome and hides it from the sweep, while failing to match merely
// yields a noisy "real" — so every pattern must be a specific, unambiguous notice, never something that
// could appear in ordinary crash prose. A bare number is the classic violation (`429` also occurs as a line
// number in a stack trace), hence the required context around it. The one deliberate widening is the
// qualifier-less "You've hit your limit · resets …" — a Fable model-pool notice the runner catches via the
// rate_limit_event rather than text; it still requires that whole CLI phrase, so it can't match prose.
// The last alternative is z.ai's own wording (ZAI_CAP_TEXT_RE in runner.ts), which shares none of
// Anthropic's: `API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted…]`. It reached
// this sweep as a REAL failure until 2026-08-06. Anchored like its runner twin: a persisted reason can be
// a CLI backend's own final words, and an agent WRITING about the notice must not read as one.
const CAP_RE =
  /you'?ve hit your [\w .-]{0,24}limit|session limit|weekly limit|usage limit|hour limit|limit reached|rate.?limit|too many requests|(?:http|api)[\w .:=_-]{0,16}429\b|\b429\s+too many|payment required|quota (?:exceeded|reached)|^\s*(?:api error:\s*)?request rejected \(429\)[^\n]{0,160}\blimit (?:exhausted|reached)/i;
const TRANSIENT_RE =
  /api\s*(?:error|status)?\s*[:=]?\s*(?:500|502|503|504|520|522|524|529)\b|overload|internal server error|service unavailable|bad gateway|gateway timeout|temporar(?:y|ily) unavailable|connection (?:reset|closed|refused)|unable to connect to (?:the )?api|failed ?to ?open ?socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up/i;
// Every wording a turn/cost cutoff can arrive in — a backend whose text isn't here raises a REAL-failure
// alarm for exactly the class this probe exists to defuse. runError.ts writes the "per-session … ceiling"
// lines, grokRunner.ts writes "Grok stopped at its turn limit.", and the SDK's own `errors` text ("Reached
// maximum number of turns (100)") reached rows written in the window before runError.ts started preferring
// the canned reason — a real 101-turn row in this DB reads exactly that way.
const CUTOFF_RE =
  /per-session (?:turn|cost) ceiling|error_max_turns|error_max_budget_usd|stopped at its turn limit|reached maximum number of turns/i;
const STRUCTURED_RE = /structured-output retries|error_max_structured_output_retries|structured output/i;
// A resumed session that came back without ever reaching the model (0 turns, $0, no messages). The
// orchestrator stamps this text itself (SILENT_RUN_ERROR in threadManager.ts) precisely so the row shows up
// here rather than as a misleading `done` — keep the two in sync.
const SILENT_RE = /produced no output — the run returned without ever reaching the model/i;
const OPAQUE_RE = /^run failed\.?$/i;

// Ordered so the verdict reads worst-first; `human` decides whether a class needs anyone's attention.
const CLASSES = [
  { key: "real", label: "REAL failure — the agent or its environment broke", human: true },
  { key: "unclassifiable", label: "opaque legacy row (pre-458566e) — no reason recorded", human: true },
  { key: "structured", label: "structured-output retries exhausted — the agent never matched the schema", human: true },
  { key: "cutoff", label: "turn-ceiling cutoff — involuntary, warm-resumed on the implementor and QA paths", human: false },
  { key: "silent", label: "resumed session returned empty — retried on a fresh session", human: false },
  { key: "cap", label: "usage cap — account/backend failover expected", human: false },
  { key: "transient", label: "transient provider/transport error — retried automatically", human: false },
  { key: "restart", label: "killed by a server restart — auto-resumed on boot", human: false },
];

/** Which CLASSES key a non-done run belongs to. Takes a raw `agent_runs` row (snake_case).
 *
 *  The recorded reason is consulted BEFORE `state`, because `state='interrupted'` is not only the
 *  markInterrupted stamp: `finalizeRun` also stamps it whenever a run ended with no result at all, and it
 *  PRESERVES whatever error the row already had. Trusting the state first filed 5 consecutive
 *  "native binary … failed to launch" rows — a broken install — as benign auto-resumed restarts. */
function classifyRun(run) {
  const err = String(run.error || "").trim();
  if (/interrupted by a server restart/i.test(err)) return "restart";
  if (CAP_RE.test(err)) return "cap";
  if (TRANSIENT_RE.test(err)) return "transient";
  if (CUTOFF_RE.test(err)) return "cutoff";
  if (SILENT_RE.test(err)) return "silent";
  if (STRUCTURED_RE.test(err)) return "structured";
  // Any other reason the row actually recorded outranks the state stamp — an interrupted run that says WHY
  // it died died of that, not of the bounce.
  if (err && !OPAQUE_RE.test(err)) return "real";
  if (run.state === "interrupted") return "restart";
  // An error-state row with no reason: pre-fix rows say only "Run failed.", and the turn count is the one
  // piece of evidence left — at or over the role's ceiling it was a cutoff, below it there is nothing to go on.
  const ceiling = ROLE_TURN_CEILING[run.role];
  if (ceiling > 0 && run.num_turns != null && run.num_turns >= ceiling) return "cutoff";
  return "unclassifiable";
}

// The classes that put a run in front of a human. A runner-flagged cap landing in one means this file's
// regexes are behind the runner's — annoying but safe. The reverse (below) is the dangerous one. DERIVED
// from CLASSES, never hand-listed: a second copy of `human` is the same drift this whole check exists for.
const HUMAN_ALARM_CLASSES = new Set(CLASSES.filter((c) => c.human).map((c) => c.key));

/**
 * Where this file's regexes and the RUNNER's own verdict disagree about a cap. `agent_runs.cap_flagged`
 * records what the runner concluded (`rateLimited` / a CLI backend's `capped`) — the flag every failover
 * path keys on — so the drift between the two classifiers is readable instead of inferred. It exists
 * because on 2026-08-05 BOTH were ignorant of z.ai's wording at once, and proving that took an hour of
 * reading absent findings and self-expiring kv latches.
 *
 * `null` is not "the runner saw no cap" — it means no runner verdict was ever recorded: a row predating
 * the flag, or one closed out by a restart/silent-run stamp rather than by its own agent. Skipped, so the
 * check has no opinion until the data can support one.
 *
 * @param {Array<{run: object, key: string}>} classified — every non-done run with its class
 */
function classifierDisagreements(classified) {
  const unrecognizedByRunner = []; // the sweep called it a cap; the runner didn't act on one
  const unrecognizedByProbe = []; // the runner capped; the sweep is about to alarm a human about it
  for (const { run, key } of classified) {
    if (run.cap_flagged == null) continue;
    const runnerSaidCap = run.cap_flagged === 1;
    if (key === "cap" && !runnerSaidCap) unrecognizedByRunner.push(run);
    else if (runnerSaidCap && HUMAN_ALARM_CLASSES.has(key)) unrecognizedByProbe.push(run);
  }
  return { unrecognizedByRunner, unrecognizedByProbe };
}

module.exports = { classifyRun, CLASSES, ROLE_TURN_CEILING, classifierDisagreements };

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

  // The flag arrived after this probe did, and a sweep can run against a DB whose server hasn't booted the
  // migration yet — so read the column only when it exists, rather than crashing the whole triage.
  const hasCapFlag = db
    .prepare("PRAGMA table_info(agent_runs)")
    .all()
    .some((c) => c.name === "cap_flagged");
  const runs = db
    .prepare(
      `SELECT r.id, r.thread_id, r.role, r.model, r.account, r.state, r.error, r.cost_usd, r.num_turns,
              ${hasCapFlag ? "r.cap_flagged" : "NULL AS cap_flagged"},
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

  reportVerdict(buckets);
  reportNeedsHuman(buckets);
  reportCapAgreement(buckets);
  reportRecovery(db, buckets);
  reportBenignByTask(buckets);
  db.close();
}

function reportVerdict(buckets) {
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
}

// Detail only the classes a human must read; the benign ones are summarised by task instead, so a long window
// doesn't bury the real failures under dozens of expected restart rows.
function reportNeedsHuman(buckets) {
  for (const c of CLASSES.filter((x) => x.human)) {
    const rows = buckets.get(c.key);
    if (!rows.length) continue;
    console.log(`\n=== ${c.label} (${rows.length}) ===`);
    for (const r of rows) {
      console.log(
        `- ${r.role} · ${r.model} · ${r.account ?? "?"} · ${iso(r.started_at)} · ${usd(r.cost_usd)} · ${r.num_turns ?? "—"} turns` +
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
}

// Does the RUNNER agree this was a cap? Every classifier in this file is a hand-copied mirror of the
// runner's, and a mirror nobody diffs drifts silently — z.ai's `Request rejected (429) · [1310][Weekly/
// Monthly Limit Exhausted…]` was unknown to BOTH for weeks, so a spent backend kept counting as a failover
// rung and a QA round burned. `cap_flagged` makes the disagreement readable, in the direction that matters:
// a cap the RUNNER missed did not fail over, whatever this file calls it.
function reportCapAgreement(buckets) {
  const classified = CLASSES.flatMap((c) => buckets.get(c.key).map((run) => ({ run, key: c.key })));
  const covered = classified.filter((c) => c.run.cap_flagged != null);
  if (!covered.length) return; // every row predates the flag — say nothing rather than something unfounded
  const { unrecognizedByRunner, unrecognizedByProbe } = classifierDisagreements(classified);

  console.log("\n=== cap classifier agreement (does the runner read these the same way?) ===");
  const line = (r) =>
    `- ${r.role} · ${r.model} · ${r.account ?? "?"} · ${iso(r.started_at)} · task ${String(r.thread_id).slice(0, 8)}` +
    `\n    ${short(r.error) || "(no error text recorded)"}`;

  if (!unrecognizedByRunner.length && !unrecognizedByProbe.length) {
    console.log(`  ✓ both classifiers agree on all ${covered.length} run(s) carrying the flag.`);
    return;
  }
  if (unrecognizedByRunner.length) {
    console.log(`  ⚠ ${unrecognizedByRunner.length} run(s) look like a usage cap here, but the RUNNER never flagged one:`);
    for (const r of unrecognizedByRunner) console.log(line(r));
    console.log(
      "  ↳ That run did NOT fail over: no cap latch, no provider hand-off, the backend kept counting as a\n" +
        "    failover rung. Teach the runner this wording — a non-Anthropic backend supplies its own via\n" +
        "    `providerCapText` (agents/runner.ts, gate test:zai-cap), then mirror it into CAP_RE here.",
    );
  }
  if (unrecognizedByProbe.length) {
    console.log(`  · ${unrecognizedByProbe.length} run(s) the runner capped are about to be reported to you as a failure:`);
    for (const r of unrecognizedByProbe) console.log(line(r));
    console.log("  ↳ Harmless to the pipeline (the runner handled it); CAP_RE in this file is behind the runner's.");
  }
}

// "Handled by design" is a claim about a MECHANISM (failover, retry, boot auto-resume), and the DB can check it
// rather than taking it on faith: a recovered run is followed by another run on the same task. Only tasks that
// still OWED work count — a `done`/`closed`/`cancelled` task legitimately has no follow-up (the usual case
// being a cap during the post-task self-improvement round, which by design can't affect the verdict), and a
// task still in flight may simply not have started its next run yet. That leaves `review` and `failed`: there,
// a benign-looking cap or restart as the last thing that happened is a task that stopped mid-work.
const OWED_WORK_STATES = new Set(["review", "failed"]);

function reportRecovery(db, buckets) {
  // `>=` with the id excluded rather than `>`, so a sibling run created in the same millisecond still counts
  // as a follow-up instead of reading as a stall.
  const hasLaterRun = db.prepare(
    "SELECT 1 FROM agent_runs WHERE thread_id = ? AND started_at >= ? AND id != ? LIMIT 1",
  );
  const stalled = CLASSES.filter((c) => !c.human)
    .flatMap((c) => buckets.get(c.key).map((r) => ({ run: r, cls: c })))
    .filter((c) => OWED_WORK_STATES.has(c.run.thread_state))
    .filter((c) => !hasLaterRun.get(c.run.thread_id, c.run.started_at, c.run.id));

  console.log("\n=== recovery check (did the handling mechanism actually run?) ===");
  if (!stalled.length) {
    console.log("  ✓ every task that still owed work ran again after its cap/restart/retry.");
    return;
  }
  // Most "never ran again" tasks are waiting on a PERSON by design, and the thread's own park text says which.
  // Only an unexplained one is a finding — flagging the by-design parks with ⚠ too is what trains a reader to
  // skim the check, which is how the tree-killed row went unnoticed in the first place.
  const explained = (threadError) => {
    const e = String(threadError || "");
    if (e.includes("⏳ Auto-resume pending")) return "cap-supervisor park — resumeCapParked owns it";
    // A QA round that ended without a verdict parks for a person BY DESIGN. An involuntary stop there is
    // recovered first — a turn-ceiling cutoff is continued (bounded by qaCutoffResumes), an empty run is
    // re-run fresh (qaSilentRetries) — so a park naming a spent budget means the mechanism ran and gave up,
    // not that nothing tried. health counts these separately as its own warn.
    if (/QA could not complete/i.test(e)) {
      if (/cut off again each time/i.test(e)) return "QA park — the reviewer's continuation budget is spent, awaiting the owner";
      if (/restarted on a fresh session/i.test(e)) return "QA park — the reviewer came back empty and its fresh-session retry is spent, awaiting the owner";
      return "QA park — QA ended without a verdict, awaiting the owner";
    }
    // An auto-review that reached no verdict re-parks the task BY DESIGN — an absent decision is never an
    // acceptance. Its involuntary stops are recovered first (a cutoff continues the session, an empty run
    // starts over), so a park here means the recovery ran and the button is the owner's again.
    if (/Auto-review (?:couldn't|could not) reach a verdict/i.test(e)) return "auto-review park — no verdict reached, back on the owner's desk";
    if (/interrupted by (?:a )?server restart/i.test(e)) return "human-gated park after a restart — Resume continues it";
    return undefined;
  };
  let unexplained = 0;
  for (const s of stalled) {
    const why = explained(s.run.thread_error);
    if (why) {
      console.log(`  · by design: task ${String(s.run.thread_id).slice(0, 8)} [${s.run.thread_state}] — ${why}`);
      continue;
    }
    unexplained++;
    console.log(
      `  ⚠ ${s.run.role} · ${s.cls.key} · ${iso(s.run.started_at)} · task ${String(s.run.thread_id).slice(0, 8)} ` +
        `[${s.run.thread_state}] ${short(s.run.title, 46)}\n      nothing is waiting to resume it and its park text doesn't explain why`,
    );
  }
  if (unexplained) console.log("  ↳ drill in with: npm run probe:task-runs --prefix server -- <id>");
  else console.log("  ✓ every task that stopped is accounted for by its own park message.");
}

const BENIGN_TASK_LIST_LIMIT = 15;

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
  // Truncated so a long window can't bury the ⚠ sections above — but SAY what was dropped, since a silent
  // cap reads as "that was everything".
  const ranked = [...byThread.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [id, e] of ranked.slice(0, BENIGN_TASK_LIST_LIMIT)) {
    console.log(`- ${String(id).slice(0, 8)} [${e.state ?? "gone"}] ${short(e.title, 60)} — ${e.n} run(s), ${usd(e.cost)}`);
  }
  if (ranked.length > BENIGN_TASK_LIST_LIMIT) {
    console.log(`  … +${ranked.length - BENIGN_TASK_LIST_LIMIT} more task(s) with only expected outcomes (not shown)`);
  }
  console.log("  ↳ drill into any one with: npm run probe:task-runs --prefix server -- <id>");
}

if (require.main === module) main();
