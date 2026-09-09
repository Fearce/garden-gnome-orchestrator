#!/usr/bin/env node

process.env.MAX_UNATTENDED_AUTO_REVIEWS = "2";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  CONVERGENCE_FIX_COMMIT,
  SUPPRESSION_LITERALS,
  UNATTENDED_BUDGET_DEFAULT,
  autoReviewReading,
  autoReviewTableExists,
  selectAutoReviewRows,
} = require("./auto-review-health.cjs");
const { resolveShipDate } = require("./recovery-features.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-auto-review-health-"));
const dbPath = path.join(temp, "health.sqlite");
const probe = path.resolve(__dirname, "probe-auto-review.cjs");
let db;

function runProbe(file, ...args) {
  return spawnSync(process.execPath, [probe, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ORCH_DB: file },
    encoding: "utf8",
  });
}

function insertThread(id, state, error = null) {
  db.prepare("INSERT INTO threads(id,title,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(
    id,
    `Task ${id}`,
    state,
    error,
    10,
    500,
  );
}

function insertRun(threadId, id, role, startedAt) {
  db.prepare("INSERT INTO agent_runs(id,thread_id,role,state,started_at,ended_at) VALUES(?,?,?,?,?,?)").run(
    id,
    threadId,
    role,
    "done",
    startedAt,
    startedAt + 10,
  );
}

function insertEpisode(threadId, value) {
  db.prepare(`
    INSERT INTO auto_review_episodes
      (thread_id,revision,status,source,claim_token,attempt_count,reason,verdict_json,
       verdict_run_id,started_at,settled_at,updated_at)
    VALUES
      (@threadId,@revision,@status,@source,@claimToken,@attemptCount,@reason,@verdictJson,
       @verdictRunId,@startedAt,@settledAt,@updatedAt)
  `).run({
    threadId,
    revision: `run:${threadId}-work`,
    status: "parked",
    source: "supervisor",
    claimToken: null,
    attemptCount: 1,
    reason: "Reviewer did not accept the work.",
    verdictJson: JSON.stringify({ accept: false, summary: "Rejected", issues: ["Fix it"] }),
    verdictRunId: `${threadId}-review`,
    startedAt: 120,
    settledAt: 200,
    updatedAt: 200,
    ...value,
  });
}

function seedReviewed(id, state, error, episode) {
  insertThread(id, state, error);
  insertRun(id, `${id}-work`, "implementor", 100);
  insertRun(id, `${id}-review`, "reviewer", 150);
  insertEpisode(id, episode);
}

// --- the convergence section ------------------------------------------------------------------
// The loop the owner reported (auto-review -> park -> auto-review on unchanged work) is a SECOND
// unattended claim on one work revision. These checks exist to prove the detector actually goes red on
// that shape before its silence is read as health, and that neither of the two look-alikes trips it: a
// second review after genuinely new work, and the pre-fix repeats still sitting in this DB forever.
function runConvergenceChecks() {
  const DAY = 86_400_000;
  const fixShip = resolveShipDate(CONVERGENCE_FIX_COMMIT);
  assert.ok(
    fixShip,
    `${CONVERGENCE_FIX_COMMIT} no longer resolves, so every historical repeat would be reported as a live regression`,
  );
  const fixAt = fixShip.getTime();
  const now = Date.now();
  // Wide enough that the pre-fix events below stay inside the window however long ago the fix shipped.
  const wideDays = String(Math.ceil((now - fixAt) / DAY) + 5);

  const file = path.join(temp, "convergence.sqlite");
  const conv = new Database(file);
  conv.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE auto_review_episodes (
      thread_id TEXT PRIMARY KEY, revision TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
      claim_token TEXT, attempt_count INTEGER NOT NULL, reason TEXT, verdict_json TEXT,
      verdict_run_id TEXT, started_at INTEGER NOT NULL, settled_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE supervisor_events (
      id TEXT PRIMARY KEY, thread_id TEXT, thread_title TEXT, workspace TEXT, trigger TEXT NOT NULL,
      kind TEXT NOT NULL, action TEXT, summary TEXT NOT NULL, detail TEXT,
      used_agent INTEGER NOT NULL DEFAULT 0, cost_usd REAL, total_tokens INTEGER, model TEXT,
      notified_discord INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  conv.prepare("INSERT INTO kv(key,value) VALUES('setting_director_supervisor_enabled','1')").run();

  // Settled tasks, so the per-task section has nothing to say about them: the exit code asserted below
  // can then only have come from the convergence section, which is the point of this fixture.
  const thread = (id) =>
    conv
      .prepare("INSERT INTO threads(id,title,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, `Task ${id}`, "done", null, 1, now);
  const run = (threadId, id, role, startedAt) =>
    conv
      .prepare("INSERT INTO agent_runs(id,thread_id,role,state,started_at,ended_at) VALUES(?,?,?,?,?,?)")
      .run(id, threadId, role, "done", startedAt, startedAt + 10);
  let seq = 0;
  const event = (
    threadId,
    kind,
    at,
    { summary = "delegating review", detail = null, usedAgent = 0, action = "start_auto_review" } = {},
  ) =>
    conv
      .prepare(
        `INSERT INTO supervisor_events(id,thread_id,thread_title,workspace,trigger,kind,action,summary,detail,used_agent,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(`ev-${seq++}`, threadId, `Task ${threadId}`, "fixture-repo", "state_change", kind, action, summary, detail, usedAgent, at);

  // Production writes a claim's reviewer run a hair BEFORE its audit row, so every fixture claim gets
  // one. That ordering is what makes "work since the last reviewer run" unusable as the repeat test —
  // each claim would find its OWN reviewer as the boundary and read as work-free. Seeding it here keeps
  // the role exclusion in `countWork` load-bearing: without it the `loop` pair looks like real work.
  const claim = (threadId, at, index, attempt = null) => {
    run(threadId, `${threadId}-review-${index}`, "reviewer", at - 1);
    event(threadId, "action", at, {
      detail: attempt == null ? null : `model test (codex); unattended auto-review attempt ${attempt}/${UNATTENDED_BUDGET_DEFAULT}`,
    });
  };

  // The defect: two unattended reviews with nothing done in between, both after the fence shipped.
  thread("loop");
  run("loop", "loop-w1", "implementor", now - 3 * DAY);
  claim("loop", now - 2 * DAY, 1, 1);
  claim("loop", now - 1 * DAY, 2, 2);

  // Look-alike 1 — a second review that followed genuinely new work (an owner injection, a resume) is a
  // new question, not a re-run of the same one.
  thread("progress");
  run("progress", "progress-w1", "implementor", now - 3 * DAY);
  claim("progress", now - 2 * DAY, 1, 1);
  run("progress", "progress-w2", "implementor", now - 36 * 3600_000);
  claim("progress", now - 1 * DAY, 2, 2);

  // The defect that survived the per-revision fence: every new claim has a new work run, but the third
  // launch crosses the task-level budget. The persisted marker makes that provable even if a later owner
  // action resets the live episode row.
  thread("budget-leak");
  run("budget-leak", "budget-w1", "implementor", now - 4 * DAY);
  claim("budget-leak", now - 3 * DAY, 1, 1);
  run("budget-leak", "budget-w2", "implementor", now - 60 * 3600_000);
  claim("budget-leak", now - 2 * DAY, 2, 2);
  run("budget-leak", "budget-w3", "implementor", now - 36 * 3600_000);
  claim("budget-leak", now - 1 * DAY, 3, 3);

  // Look-alike 2 — the repeats this DB will carry forever, from before the fence existed.
  thread("historic");
  run("historic", "historic-w1", "implementor", fixAt - 4 * DAY);
  claim("historic", fixAt - 3 * DAY, 1);
  claim("historic", fixAt - 2 * DAY, 2);

  // The fence itself, free and after a paid judgement, plus one unrelated skip.
  event("loop", "skip", now - 12 * 3600_000, { summary: `${SUPPRESSION_LITERALS[2]} the reviewer did not accept it` });
  event("loop", "skip", now - 11 * 3600_000, { summary: SUPPRESSION_LITERALS[0], usedAgent: 1 });
  event("loop", "skip", now - 10 * 3600_000, { summary: "task produced fresh activity before acting - verdict discarded", usedAgent: 1 });
  conv.close();

  const red = runProbe(file, "--json");
  assert.equal(red.status, 1, `a repeat unattended claim on unchanged work must exit 1:\n${red.stdout}\n${red.stderr}`);
  const redPayload = JSON.parse(red.stdout);
  assert.equal(redPayload.attention, 0, "the convergence section must fail the probe on its own, not via a per-task invariant");
  const loop = redPayload.convergence;
  assert.equal(loop.verdict, "LOOP");
  assert.deepEqual(
    loop.postFixRepeats.map((entry) => entry.threadId),
    ["loop"],
    "only the unchanged-revision repeat is a regression - new work and pre-fix history are not",
  );
  assert.deepEqual(
    loop.budgetLeaks.map((entry) => entry.threadId),
    ["budget-leak"],
    "a third cross-revision claim must be caught from its persisted attempt counter",
  );
  assert.equal(loop.violations.length, 2, "the same-revision and cross-revision loop shapes are independently visible");
  assert.equal(loop.taskBudgetMeasuredClaims, 7);
  assert.equal(loop.taskBudgetUnmeasuredClaims, 2, "pre-marker history stays explicit instead of being treated as a healthy zero");
  assert.equal(loop.fencedFree, 1, "a fence hit before any paid check-in is the cheap, working path");
  assert.equal(loop.fencedPaid, 1);
  assert.equal(loop.otherSkips, 1, "a race guard is not the fence and must not be counted as one");
  assert.match(runProbe(file).stdout, /LOOP: loop /);
  assert.match(runProbe(file).stdout, /LOOP: budget-/);
  assert.match(runProbe(file).stdout, /attempt 3 exceeded its persisted task budget of 2/);

  // Counted over the wide window, where every seeded event sits regardless of how long ago the fence
  // shipped — the default window's contents move with the calendar, so it is asserted on shape only.
  const wide = JSON.parse(runProbe(file, "--json", "--days", wideDays).stdout).convergence;
  assert.equal(wide.launches, 9);
  assert.equal(wide.revisions, 7, "progress and budget fixtures mint a real revision for every new work run");
  assert.equal(
    wide.repeats.length,
    2,
    "`loop` and `historic` each repeat once; `progress` never does - a reviewer run must not count as work",
  );
  assert.deepEqual(
    wide.preFixRepeats.map((entry) => entry.threadId),
    ["historic"],
    "a repeat that predates the fence is reported as history",
  );
  assert.ok(
    !wide.postFixRepeats.some((entry) => entry.threadId === "historic"),
    "pre-fix residue must never red this probe forever - the fix already closed it",
  );

  // With the offending second claim removed, the same DB must go green: proof the red above came from
  // the loop and not from anything else in the fixture.
  const repaired = new Database(file);
  repaired.prepare("DELETE FROM supervisor_events WHERE thread_id='loop' AND kind='action' AND created_at=?").run(now - 1 * DAY);
  repaired.prepare("DELETE FROM supervisor_events WHERE thread_id='budget-leak' AND kind='action' AND created_at=?").run(now - 1 * DAY);
  repaired.close();
  const green = runProbe(file, "--json");
  assert.equal(green.status, 0, `one claim per revision is healthy:\n${green.stdout}\n${green.stderr}`);
  assert.equal(JSON.parse(green.stdout).convergence.verdict, "PASS");

  // An empty window is not a clean bill of health. It must say so instead of printing a green verdict
  // the owner would read as "the loop is closed".
  const quiet = new Database(file);
  quiet.prepare("DELETE FROM supervisor_events WHERE kind='action'").run();
  quiet.prepare("UPDATE kv SET value='0' WHERE key='setting_director_supervisor_enabled'").run();
  quiet.close();
  const empty = runProbe(file);
  assert.equal(empty.status, 0, "no evidence is not a failure - it is an absent measurement");
  assert.match(empty.stdout, /NO EVIDENCE/);
  assert.match(empty.stdout, /nothing here proves the loop is closed/);
  assert.match(empty.stdout, /Supervisor is OFF right now/);
  assert.match(empty.stdout, /no unattended review in the window/, "the headline must not report a count it never measured");
  assert.doesNotMatch(empty.stdout, /Unattended convergence \(last \d+d\) - PASS/, "an empty window must never read as PASS");
  assert.doesNotMatch(empty.stdout, /0 unattended repeat claim\(s\)/, "an unmeasured window must not read as zero repeats on the first line");

  // Wording drift is silent by construction: a renamed fence sentence turns "the guard fired N times"
  // into zero, i.e. into a quiet wrong all-clear. Pin each literal against the code that emits it.
  const dbSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "db", "db.ts"), "utf8");
  for (const literal of SUPPRESSION_LITERALS) {
    assert.ok(
      dbSource.includes(literal),
      `db.autoReviewAutomationBlock no longer emits "${literal}" - update SUPPRESSION_LITERALS or the fence evidence silently reads zero`,
    );
  }
  const configSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "config.ts"), "utf8");
  assert.match(
    configSource,
    new RegExp(`MAX_UNATTENDED_AUTO_REVIEWS,\\s*${UNATTENDED_BUDGET_DEFAULT}\\)`),
    "the runtime and CommonJS probe defaults must move together",
  );
}

try {
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE auto_review_episodes (
      thread_id TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      claim_token TEXT,
      attempt_count INTEGER NOT NULL,
      reason TEXT,
      verdict_json TEXT,
      verdict_run_id TEXT,
      started_at INTEGER NOT NULL,
      settled_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  seedReviewed("accepted", "done", null, {
    status: "accepted",
    reason: "All checks passed.",
    verdictJson: JSON.stringify({ accept: true, summary: "Verified", issues: [] }),
  });
  seedReviewed("parked", "review", "Kevin must choose the deployment target.", {
    reason: "Kevin must choose the deployment target.",
    verdictJson: JSON.stringify({ accept: false, summary: "Needs input", issues: ["Kevin must choose"] }),
  });
  seedReviewed("restart", "review", "Auto-review was interrupted by a server restart.", {
    source: "reconciled",
    attemptCount: 4,
    reason: "Auto-review was interrupted by a server restart.",
    verdictJson: null,
  });
  seedReviewed("active", "reviewing", null, {
    status: "running",
    source: "owner",
    claimToken: "do-not-print-this-claim-token",
    reason: null,
    verdictJson: null,
    verdictRunId: null,
    settledAt: null,
  });

  seedReviewed("newwork", "review", "New work is ready for review.", {
    reason: "Earlier revision was rejected.",
  });
  insertRun("newwork", "newwork-work-2", "implementor", 300);

  seedReviewed("duplicate", "review", "Reviewer did not accept the work.", { attemptCount: 2 });
  seedReviewed("badaccept", "done", null, { status: "accepted", reason: "Claimed success.", verdictJson: null });
  seedReviewed("late", "review", "Reviewer did not accept the work.", {});
  insertRun("late", "late-review-after-settle", "reviewer", 300);
  seedReviewed("hidden", "review", null, { reason: "Persisted but not visible." });

  insertThread("unowned", "review", "Old reviewer hand-back.");
  insertRun("unowned", "unowned-work", "implementor", 100);
  insertRun("unowned", "unowned-review", "reviewer", 150);

  assert.equal(autoReviewTableExists(db), true);
  const readings = new Map(selectAutoReviewRows(db).map((row) => [row.threadId, autoReviewReading(row)]));
  assert.equal(readings.get("accepted").disposition, "accepted", "a valid accepted verdict converges to done");
  assert.equal(readings.get("parked").disposition, "parked", "a needs-input verdict is visibly parked");
  assert.equal(readings.get("restart").disposition, "parked", "restart reconciliation is a terminal park");
  assert.equal(readings.get("restart").attention, false, "historical retry count is not fresh loop activity");
  assert.match(readings.get("restart").notes.join(" "), /historical reviewer attempts were imported and fenced/);
  assert.equal(readings.get("active").disposition, "active", "a well-formed claim is active, not an alarm");
  assert.equal(readings.get("newwork").disposition, "eligible", "new non-reviewer work opens a new revision");
  assert.match(readings.get("duplicate").issues.join(" "), /Supervisor claimed the same revision 2 times/);
  assert.match(readings.get("badaccept").issues.join(" "), /no valid accept=true verdict/);
  assert.match(readings.get("late").issues.join(" "), /started after this episode settled/);
  assert.match(readings.get("hidden").issues.join(" "), /not visible on the review task/);
  assert.match(readings.get("unowned").issues.join(" "), /no durable episode fences another unattended launch/);
  assert.equal(
    readings.get("accepted").row.unattendedStreak,
    null,
    "a pre-migration DB reports the task-level streak as unmeasured, never as a reassuring zero",
  );
  assert.equal(
    autoReviewReading(selectAutoReviewRows(db, "accepted")[0]).disposition,
    "accepted",
    "the single-task query uses the same classifier",
  );

  // Upgrade this fixture to the current schema and prove the task-level invariant itself is red. The
  // historical section cannot substitute for this row: owner reviews legitimately reset its counter.
  db.exec("ALTER TABLE auto_review_episodes ADD COLUMN unattended_streak INTEGER NOT NULL DEFAULT 0");
  seedReviewed("budgetleak", "review", "Reviewer did not accept the work.", {});
  db.prepare("UPDATE auto_review_episodes SET unattended_streak=? WHERE thread_id='budgetleak'").run(
    UNATTENDED_BUDGET_DEFAULT + 1,
  );
  const budgetLeak = autoReviewReading(selectAutoReviewRows(db, "budgetleak")[0]);
  assert.match(budgetLeak.issues.join(" "), /exceeds the budget/);
  db.prepare("UPDATE auto_review_episodes SET unattended_streak=? WHERE thread_id='parked'").run(
    UNATTENDED_BUDGET_DEFAULT,
  );
  const spent = autoReviewReading(selectAutoReviewRows(db, "parked")[0]);
  assert.equal(spent.attention, false, "reaching the bound is healthy; only crossing it is a leak");
  assert.match(spent.notes.join(" "), /budget is spent/);

  db.close();
  db = null;

  const bad = runProbe(dbPath);
  assert.equal(bad.status, 1, `actionable inconsistencies must exit 1:\n${bad.stdout}\n${bad.stderr}`);
  assert.match(bad.stdout, /^ATTENTION -/);
  assert.match(bad.stdout, /\[ATTENTION\] duplicat/);
  assert.doesNotMatch(bad.stdout, /do-not-print-this-claim-token/, "the ownership token must never be printed");

  const jsonRun = runProbe(dbPath, "--json");
  assert.equal(jsonRun.status, 1);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.verdict, "ATTENTION");
  assert.ok(payload.attention >= 5);
  assert.equal(payload.entries.find((entry) => entry.threadId === "active").episode.claimed, true);
  assert.doesNotMatch(jsonRun.stdout, /do-not-print-this-claim-token/);

  db = new Database(dbPath);
  db.prepare("DELETE FROM threads WHERE id IN ('duplicate','badaccept','late','hidden','unowned','budgetleak')").run();
  db.prepare("DELETE FROM agent_runs WHERE thread_id IN ('duplicate','badaccept','late','hidden','unowned','budgetleak')").run();
  db.prepare("DELETE FROM auto_review_episodes WHERE thread_id IN ('duplicate','badaccept','late','hidden','unowned','budgetleak')").run();
  db.close();
  db = null;

  const before = fs.readFileSync(dbPath);
  const good = runProbe(dbPath);
  const goodJson = runProbe(dbPath, "--json");
  const after = fs.readFileSync(dbPath);
  assert.equal(good.status, 0, `repaired, active, accepted, parked, and newer-work rows are healthy:\n${good.stdout}\n${good.stderr}`);
  assert.match(good.stdout, /^PASS -/);
  assert.equal(goodJson.status, 0);
  assert.ok(before.equals(after), "the health probe must leave the SQLite file byte-identical");

  const oldPath = path.join(temp, "old.sqlite");
  const old = new Database(oldPath);
  old.exec("CREATE TABLE threads(id TEXT PRIMARY KEY)");
  old.close();
  const oldRun = runProbe(oldPath);
  assert.equal(oldRun.status, 2);
  assert.match(oldRun.stderr, /auto_review_episodes is absent/);

  const usage = runProbe(dbPath, "--unknown");
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
  for (const bogus of [["--days", "0"], ["--days", "soon"], ["--days=-3"]]) {
    const rejected = runProbe(dbPath, ...bogus);
    assert.equal(rejected.status, 2, `\`${bogus.join(" ")}\` must be refused, not silently treated as a window`);
  }

  // `health.sqlite` has no supervisor_events, so the same run also pins the degradation: an older DB
  // must say it records no unattended history rather than crash or imply a clean window.
  assert.match(good.stdout, /supervisor_events is absent/);

  runConvergenceChecks();
} finally {
  if (db?.open) db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("PASS - durable auto-review health probe covers convergence, recovery, and loop invariants");
