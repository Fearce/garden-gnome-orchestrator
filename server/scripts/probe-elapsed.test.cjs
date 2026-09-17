// Gate for probe-elapsed.cjs. Every assertion here is a reading the probe would get WRONG if the rule it
// checks were removed — the same revert-check discipline as db-size.test.cjs: a checker nobody has seen
// fail is not evidence. Pure functions only, driven with the row shapes the live DB actually holds.

const assert = require("node:assert/strict");
const {
  CAUSES,
  attributeGap,
  boundQuestions,
  classOf,
  fleetReading,
  isLive,
  likeLiteral,
  mergeIntervals,
  parseArgs,
  renderTask,
  runEnd,
  taskReading,
  verdictFor,
} = require("./probe-elapsed.cjs");

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);

function run(overrides = {}) {
  return {
    thread_id: "t1",
    role: "implementor",
    state: "done",
    started_at: T0,
    ended_at: T0 + HOUR,
    num_turns: 40,
    cost_usd: 1,
    cap_flagged: 0,
    error: null,
    ...overrides,
  };
}

// ---- busy time is a UNION, never a sum ----
{
  const blocks = mergeIntervals(
    [run({ started_at: T0, ended_at: T0 + 2 * HOUR }), run({ role: "qa", started_at: T0 + HOUR, ended_at: T0 + 3 * HOUR })],
    T0 + 10 * HOUR,
  );
  assert.equal(blocks.length, 1, "two overlapping runs are one block of the owner's time");
  assert.equal(blocks[0].end - blocks[0].start, 3 * HOUR, "the union is 3h, not the 4h the two runs sum to");

  const task = taskReading({
    thread: { id: "t1", title: "concurrent", state: "done" },
    runs: [run({ started_at: T0, ended_at: T0 + 2 * HOUR }), run({ role: "qa", started_at: T0 + HOUR, ended_at: T0 + 3 * HOUR })],
    nowMs: T0 + 10 * HOUR,
  });
  assert.equal(task.busyMs, task.spanMs, "concurrent agents must never report more busy time than elapsed");
  assert.equal(task.waitMs, 0);
}

// A live run has no ended_at; it must be measured to now, not dropped or read as an instant.
{
  const task = taskReading({
    thread: { id: "t1", title: "live", state: "implementing" },
    runs: [run({ ended_at: null, state: "running" })],
    nowMs: T0 + 5 * HOUR,
  });
  assert.equal(task.live, true);
  assert.equal(task.busyMs, 5 * HOUR, "an open run is busy up to now");
}

// ---- an ORPHAN is not a live run: the row that inverted the whole headline ----
// 15 of the live DB's 18 rows with a null ended_at are `error` orphans (fix-stuck.cjs repairs them),
// the oldest from June. Measured to `now` they swallow the entire task in one block: 100% busy, no gaps,
// and a 30-day window reporting ~1,900 agent-hours that were never worked.
{
  const orphan = run({ state: "error", ended_at: null, error: "Run failed." });
  assert.equal(isLive(orphan), false);
  assert.equal(runEnd(orphan, T0 + 300 * HOUR), T0, "an orphan closes at its own start, not at now");

  const task = taskReading({
    thread: { id: "t1", title: "orphaned", state: "done" },
    runs: [orphan, run({ started_at: T0 + 300 * HOUR, ended_at: T0 + 301 * HOUR })],
    nowMs: T0 + 400 * HOUR,
  });
  assert.equal(task.live, false, "a finished task must not report itself as still running");
  assert.equal(task.busyMs, HOUR, "only the real run is busy time");
  assert.equal(task.waitMs, 300 * HOUR);
  assert.equal(task.gaps.length, 1, "the gap the orphan used to swallow must be visible");
}

// A row whose stamps are inverted must not produce negative busy time or a negative gap.
{
  const task = taskReading({
    thread: { id: "t1", title: "inverted", state: "done" },
    runs: [run({ started_at: T0 + HOUR, ended_at: T0 })],
    nowMs: T0 + 5 * HOUR,
  });
  assert.equal(task.busyMs, 0);
  assert.equal(task.spanMs, 0);
}

// Rows arrive ordered by started_at alone, so same-millisecond ties come back in arbitrary order. Without
// the sort, the gap loop subtracts backwards and every negative "gap" is silently dropped as sub-threshold.
{
  const first = run({ started_at: T0, ended_at: T0 + HOUR });
  const second = run({ role: "qa", started_at: T0 + 3 * HOUR, ended_at: T0 + 4 * HOUR });
  const forwards = taskReading({ thread: { id: "t1", title: "a", state: "done" }, runs: [first, second], nowMs: T0 + 4 * HOUR });
  const backwards = taskReading({ thread: { id: "t1", title: "a", state: "done" }, runs: [second, first], nowMs: T0 + 4 * HOUR });
  assert.deepEqual(backwards.gaps.map((g) => g.ms), [2 * HOUR], "a reversed pair still reports its 2h gap");
  assert.deepEqual(backwards.waitByCause, forwards.waitByCause);
  assert.equal(backwards.busyMs, forwards.busyMs);
}

// ---- the classifier guard: classifyRun answers a question only a NON-done run can be asked ----
{
  assert.equal(classOf(run({ state: "done", num_turns: 101 })), null, "a done implementor at the ceiling is not a cutoff");
  assert.equal(classOf(run({ state: "running", ended_at: null })), null);
  assert.equal(classOf(run({ state: "error", error: "You've hit your session limit · resets 3pm" })), "cap");
  const task = taskReading({
    thread: { id: "t1", title: "clean", state: "done" },
    runs: [run({ num_turns: 101 }), run({ started_at: T0 + 4 * HOUR, ended_at: T0 + 5 * HOUR, num_turns: 120 })],
    nowMs: T0 + 5 * HOUR,
  });
  assert.equal(task.cutoffs, 0, "without the guard both clean runs count as turn-ceiling cutoffs");
  assert.equal(task.gaps[0].cause, "park", "and the gap between them reads as failure recovery");
}

// ---- gap attribution ----
const gap = { start: T0 + HOUR, end: T0 + 3 * HOUR };

{
  const capped = run({ state: "error", error: "You've hit your session limit · resets 3pm (Europe/Copenhagen)" });
  assert.equal(attributeGap(gap, capped).cause, "cap");
  // The runner's own verdict counts even when this file's regexes have never seen the backend's wording —
  // that drift is exactly what cap_flagged exists to survive (probe-run-errors.cjs classifierDisagreements).
  const unknownWording = run({ state: "error", cap_flagged: 1, error: "quota wording nobody has parsed yet" });
  assert.equal(attributeGap(gap, unknownWording).cause, "cap");
  // …but a run that hit a cap, failed over and FINISHED was never blocked. Reading its flag would
  // manufacture capacity evidence, which is the permissive direction.
  const recovered = run({ state: "done", cap_flagged: 1 });
  assert.equal(attributeGap(gap, recovered).cause, "park", "a completed run's cap flag is not a wait");
}

{
  const before = run();
  const open = attributeGap(gap, before, { questions: [{ created_at: T0 + 90 * MIN, answered_at: null }] });
  assert.equal(open.cause, "ownerAnswer");
  assert.match(open.detail, /unanswered/);
  const answeredEarlier = attributeGap(gap, before, { questions: [{ created_at: T0 - HOUR, answered_at: T0 }] });
  assert.notEqual(answeredEarlier.cause, "ownerAnswer", "a question closed before the gap opened explains nothing");
}

{
  const receipt = { command: "thread.resume", created_at: T0 + 2 * HOUR };
  assert.equal(attributeGap(gap, run(), { ownerCommands: [receipt] }).cause, "ownerPark");
  assert.equal(attributeGap(gap, run(), { ownerCommands: [{ ...receipt, created_at: T0 + 9 * HOUR }] }).cause, "park");
}

{
  assert.equal(attributeGap(gap, run({ state: "interrupted", error: "Interrupted by a server restart" })).cause, "restart");
  assert.equal(attributeGap(gap, run({ state: "error", error: "Stopped at the per-session turn ceiling (error_max_turns)" })).cause, "resume");
  assert.equal(attributeGap(gap, run({ state: "error", error: "native binary failed to launch" })).cause, "failure");
  // The hard deadline blocks dispatch AND resume until the owner clears the clock — a park, never a resume.
  const deadline = attributeGap(gap, run({ state: "interrupted", error: "Run stopped by the active-task hard deadline" }));
  assert.equal(deadline.cause, "park");
  assert.match(deadline.detail, /hard deadline/);
  // `structured` is a human-alarm class in probe-run-errors, so it belongs with the failures.
  assert.equal(
    attributeGap(gap, run({ state: "error", error: "structured-output retries exhausted" })).cause,
    "failure",
  );
  assert.equal(attributeGap({ start: T0, end: T0 + 30_000 }, run()).cause, "handoff", "half a minute between roles is the pipeline, not a stall");
  assert.equal(attributeGap(gap, run()).cause, "park", "a clean run followed by hours of silence is a task waiting on a person");
  assert.equal(attributeGap(gap, null).cause, "unattributed", "with no preceding run there is nothing to claim");
}

// Sub-5s jitter is not a gap anyone experienced — but it is still REPORTED, or the cause table and the
// verdict divide by different denominators and disagree about the same bucket's share.
{
  const task = taskReading({
    thread: { id: "t1", title: "jitter", state: "done" },
    runs: [run({ ended_at: T0 + HOUR }), run({ role: "qa", started_at: T0 + HOUR + 2_000, ended_at: T0 + 2 * HOUR })],
    nowMs: T0 + 3 * HOUR,
  });
  assert.equal(task.gaps.length, 0);
  assert.equal(task.waitByCause.jitter, 2_000);
  const attributed = Object.values(task.waitByCause).reduce((a, b) => a + b, 0);
  assert.equal(attributed, task.waitMs, "every millisecond of wait must land in exactly one cause");
}

// ---- an abandoned ask_user must not claim every later gap ----
{
  const blocks = [
    { start: T0, end: T0 + HOUR },
    { start: T0 + 3 * HOUR, end: T0 + 4 * HOUR },
    { start: T0 + 20 * HOUR, end: T0 + 21 * HOUR },
  ];
  const [bounded] = boundQuestions([{ created_at: T0 + 2 * HOUR, answered_at: null }], blocks);
  assert.equal(bounded.answered_at, T0 + 3 * HOUR, "the task stopped waiting when an agent ran again");

  const task = taskReading({
    thread: { id: "t1", title: "abandoned question", state: "done" },
    runs: [
      run({ ended_at: T0 + HOUR }),
      run({ started_at: T0 + 3 * HOUR, ended_at: T0 + 4 * HOUR }),
      run({ started_at: T0 + 20 * HOUR, ended_at: T0 + 21 * HOUR }),
    ],
    questions: [{ created_at: T0 + 2 * HOUR, answered_at: null }],
    nowMs: T0 + 21 * HOUR,
  });
  assert.deepEqual(
    task.gaps.map((g) => g.cause),
    ["ownerAnswer", "park"],
    "the question owns its own gap and nothing after it",
  );
}

// ---- the verdict separates the three cures ----
{
  assert.equal(verdictFor({ spanMs: 10 * HOUR, busyMs: 9.5 * HOUR, waitByCause: { handoff: 30 * MIN } }).key, "agent");
  assert.equal(verdictFor({ spanMs: 10 * HOUR, busyMs: 4 * HOUR, waitByCause: { cap: 5 * HOUR, handoff: HOUR } }).key, "cap");
  assert.equal(verdictFor({ spanMs: 10 * HOUR, busyMs: 2 * HOUR, waitByCause: { park: 7 * HOUR, cap: HOUR } }).key, "park");
  assert.equal(verdictFor({ spanMs: 0, busyMs: 0, waitByCause: {} }).key, "empty");
  const capLine = verdictFor({ spanMs: 10 * HOUR, busyMs: 4 * HOUR, waitByCause: { cap: 6 * HOUR } }).line;
  assert.match(capLine, /probe:accounts/, "a capacity verdict must name the probe that shows the ladder");
  // The verdict map is a parallel list of the CAUSES keys, so a tenth cause added without an entry
  // would print "VERDICT: undefined".
  for (const cause of CAUSES) {
    const line = verdictFor({ spanMs: 10 * HOUR, busyMs: 0, waitByCause: { [cause.key]: 10 * HOUR } }).line;
    assert.ok(line, `no verdict line for cause "${cause.key}"`);
  }
}

// ---- fleet aggregation ----
{
  const tasks = [
    taskReading({
      thread: { id: "a", title: "capped", state: "done" },
      runs: [
        run({ thread_id: "a", state: "error", ended_at: T0 + HOUR, error: "You've hit your session limit · resets 3pm" }),
        run({ thread_id: "a", started_at: T0 + 3 * HOUR, ended_at: T0 + 4 * HOUR }),
      ],
      nowMs: T0 + 4 * HOUR,
    }),
    taskReading({
      thread: { id: "b", title: "clean", state: "done" },
      runs: [run({ thread_id: "b", ended_at: T0 + HOUR, cost_usd: 3, num_turns: 60 })],
      nowMs: T0 + 4 * HOUR,
    }),
    taskReading({
      thread: { id: "c", title: "city-wide crawl", state: "done" },
      runs: [run({ thread_id: "c", ended_at: T0 + HOUR, cost_usd: 300, num_turns: 2200 })],
      nowMs: T0 + 4 * HOUR,
    }),
  ];
  const { totals, verdict } = fleetReading(tasks);
  assert.equal(totals.tasks, 3);
  assert.equal(totals.spanMs, 6 * HOUR);
  assert.equal(totals.busyMs, 4 * HOUR);
  assert.equal(totals.waitByCause.cap, 2 * HOUR);
  assert.equal(verdict.key, "cap");
  assert.equal(totals.medianCostUsd, 3, "a median, not a mean — one $300 crawl must not set the typical task");
}

// ---- CLI arguments ----
{
  assert.deepEqual(parseArgs([]), { hours: 168, task: null, json: false });
  assert.deepEqual(parseArgs(["72", "--json"]), { hours: 72, task: null, json: true });
  assert.equal(parseArgs(["--task", "6bf166a5"]).task, "6bf166a5");
  assert.throws(() => parseArgs(["--task"]), /needs a task id/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["0"]), /positive/);
  // Accepting both silently discarded the window and read the task's whole history instead.
  assert.throws(() => parseArgs(["24", "--task", "abc"]), /takes no hours window/);

  // A `%` or `_` in an owner's search term is a LIKE wildcard, not a character.
  assert.equal(likeLiteral("some_name"), "some\\_name");
  assert.equal(likeLiteral("100%"), "100\\%");
}

// ---- the rendered report names what the owner has to do next ----
{
  const text = renderTask(
    taskReading({
      thread: { id: "t1", title: "capped task", state: "done" },
      runs: [
        run({ state: "error", ended_at: T0 + HOUR, error: "You've hit your session limit · resets 3pm" }),
        run({ started_at: T0 + 3 * HOUR, ended_at: T0 + 4 * HOUR }),
      ],
      nowMs: T0 + 4 * HOUR,
    }),
  );
  assert.match(text, /2\.0h.+capacity wait/s);
  assert.match(text, /probe:task-runs/);
}

console.log("probe-elapsed: all assertions passed");
