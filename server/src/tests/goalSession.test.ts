// Deterministic gate for a goal that carries ONE task session from turn to turn (orchestrator/goals.ts,
// `persistentSession`). No live accounts, no network, no real agents: a temp DB, real thread/message/run
// rows, and a fake host that records every dispatch, director call and continuation.
// Run: `npm run test:goals` (after goals.test.ts).
//
// What it pins: context reuse (one task, one session, no fresh dispatch per turn) and the call counts that
// buys against the fresh-step loop; the completion audit; WAITING deferral; the evidence-based no-progress
// stops (an identical report WITH new work continues, without it stops; a no-tool-call turn; an idle
// streak); the same-impasse blocker streak (rewording does not reset it, a changed repository does); holds
// for pending input, a cap park and a restart; the token budget and its refused resume; an explicit resume
// starting a fresh audit; a pin change starting a fresh task; and the races the owner named: an edit to the
// budget or session policy while the director thinks, a task resumed while a turn's evidence is read, and
// the turn boundary stamped before the host can create the turn's run.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { GOAL_BLOCKED_TURNS, GOAL_IDLE_TURNS, GOAL_UNCLEAN_TURNS, GoalRunner, describeGoal, type GoalContinuation, type GoalHost, type GoalTaskHold } from "../orchestrator/goals.js";
import { describeGoalUsage, summarizeRunUsage, type RunTokenRow } from "../orchestrator/goalUsage.js";
import type { DispatchInput } from "../orchestrator/api.js";
import type { ModelCandidate } from "../orchestrator/modelSelector.js";
import type { ThreadState } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const ROSTER: ModelCandidate[] = [
  { provider: "claude", model: "claude-opus-5-5", note: "flagship", efforts: ["low", "medium", "high", "max"] },
  { provider: "codex", model: "gpt-5.6", note: "workhorse", efforts: ["low", "medium", "high"] },
];

function answer(verdict: "complete" | "continue", title = "Remaining work") {
  return {
    verdict,
    reason: `director says ${verdict}`,
    progress: `progress after ${title}`,
    next: { title, brief: `Do ${title}.`, provider: "claude", model: "claude-opus-5-5", effort: "medium", rationale: "r" },
  };
}

interface Harness {
  db: Db;
  runner: GoalRunner;
  dispatched: DispatchInput[];
  continued: { threadId: string; message: string }[];
  answers: unknown[];
  judged: string[];
  notices: string[];
  clock: { t: number };
  holds: Map<string, GoalTaskHold>;
  fingerprints: Map<string, string>;
  /** Overrides the next continuation's answer (a hold, fresh or stop) instead of starting the turn. */
  continueResult?: GoalContinuation;
  /** Runs inside the host's git read, as an owner action racing the evidence would. */
  onFingerprint?: () => void;
  onJudge?: () => void;
  /** Creates the turn's run row inside `continueTask`, as the real host's synchronous resume can. */
  runOnContinue?: boolean;
  /** Replaces the dispatchable roster. */
  roster?: ModelCandidate[];
}

function harness(): Harness {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "goal-session-")), "t.sqlite"));
  const h = {
    db, dispatched: [], continued: [], answers: [], judged: [], notices: [], clock: { t: Date.now() },
    holds: new Map(), fingerprints: new Map(),
  } as unknown as Harness;
  const host: GoalHost = {
    dispatch: async (input) => {
      h.dispatched.push(input);
      const t = db.createThread({ title: input.title, workspace: input.workspace, rawPrompt: "", brief: input.brief });
      db.updateThread(t.id, { state: "implementing" });
      return t.id;
    },
    judge: async (prompt) => {
      h.judged.push(prompt);
      h.onJudge?.();
      const next = h.answers.shift();
      return next == null ? { failure: "no director model is available." } : { output: next, model: "claude-opus-5-5", provider: "claude" };
    },
    roster: () => h.roster ?? ROSTER,
    notify: (kind, title) => h.notices.push(`${kind}:${title}`),
    taskHold: (id) => h.holds.get(id) ?? null,
    continueTask: (threadId, message) => {
      if (h.continueResult) {
        const r = h.continueResult;
        h.continueResult = undefined;
        return r;
      }
      h.continued.push({ threadId, message });
      if (h.runOnContinue) {
        const run = db.createRun({ threadId, role: "implementor", model: "claude-opus-5-5", account: "max-1" });
        const started = db.getRun(run.id)!.startedAt;
        while (Date.now() <= started + 1) { /* move the DB clock past the run's start */ }
      }
      db.updateThread(threadId, { state: "implementing" });
      return { ok: true };
    },
    workspaceFingerprint: async (id) => {
      h.onFingerprint?.();
      return h.fingerprints.get(id) ?? "git-0";
    },
  };
  h.runner = new GoalRunner(db, new EventHub(), host, { ownerName: "Robin", now: () => h.clock.t, tickMs: 3_600_000, retryMs: 300_000 });
  return h;
}

/** Rows written in an earlier millisecond than the next turn's boundary, so a turn never reads its neighbour's. */
const tick = () => new Promise((r) => setTimeout(r, 3));

let toolSeq = 0;
/** `n` tool calls no turn made before. */
const novel = (n: number) => Array.from({ length: n }, () => `Bash {"command":"step ${++toolSeq}"}`);
/** The same three tool calls every time: a poll loop. */
const SAME = ['Read {"file_path":"a.ts"}', 'Bash {"command":"npm test"}', 'Grep {"pattern":"TODO"}'];

interface TurnEnd {
  report: string;
  tools?: string[];
  findings?: string[];
  fingerprint?: string;
  state?: ThreadState;
}

/** Writes what a turn of the step task left behind, then ends it. */
async function endTurn(h: Harness, threadId: string, end: TurnEnd): Promise<void> {
  await tick();
  for (const content of end.tools ?? []) h.db.addMessage({ threadId, role: "implementor", kind: "tool", content });
  if (end.findings?.length) {
    const run = h.db.createRun({ threadId, role: "implementor", model: "claude-opus-5-5" });
    for (const summary of end.findings) h.db.addFinding({ threadId, fromRunId: run.id, fromRole: "implementor", summary });
  }
  h.db.addMessage({ threadId, role: "implementor", kind: "text", content: end.report });
  if (end.fingerprint) h.fingerprints.set(threadId, end.fingerprint);
  h.db.updateThread(threadId, { state: end.state ?? "done" });
  await tick();
}

/** A persistent goal whose first step is dispatched and running. */
async function started(h: Harness, over: { tokenBudget?: number; objective?: string } = {}): Promise<{ id: string; thread: string }> {
  h.answers.push(answer("continue", "Build it all"));
  const goal = h.runner.create({ title: "Carry", objective: over.objective ?? "Ship the parser with docs and tests.", workspace: process.cwd(), tokenBudget: over.tokenBudget });
  await h.runner.idle();
  return { id: goal.goal!.id, thread: h.db.getGoal(goal.goal!.id)!.currentThreadId! };
}

const goalOf = (h: Harness, id: string) => h.db.getGoal(id)!;

async function sessionReuse(): Promise<void> {
  console.log("goal session: one task carries every turn");
  const h = harness();
  const { id, thread } = await started(h);
  check("a new goal carries its session by default", goalOf(h, id).persistentSession === true);
  check("the first step brief says the session carries over", h.dispatched[0]!.brief.includes("continues the goal in this same session"));
  const TURNS = 5;
  for (let turn = 1; turn < TURNS; turn++) {
    await endTurn(h, thread, { report: `Turn ${turn}: parser part ${turn} done.\nGOAL STATUS: CONTINUE — part ${turn + 1}`, tools: novel(5) });
    await h.runner.evaluate(id);
  }
  const goal = goalOf(h, id);
  check("every turn went into the same task", h.continued.length === TURNS - 1 && h.continued.every((c) => c.threadId === thread));
  check("no fresh task after the first", h.dispatched.length === 1 && goal.stepCount === 1);
  check("the director planned once and was never asked to continue", h.judged.length === 1);
  check("the step counts its turns", goal.steps[0]!.turns === TURNS && goal.steps[0]!.settledAt === null);
  const msg = h.continued.at(-1)!.message;
  check("a continuation carries the objective, the last status and the rule", msg.includes("GOAL CONTINUATION") && msg.includes("Ship the parser with docs and tests.") && msg.includes(`CONTINUE — part ${TURNS}`) && msg.includes("GOAL STATUS: COMPLETE"));
  check("a continuation is short next to a fresh brief", msg.length < 2_500);
  check("a continuation reminds the session to report milestones", msg.includes("report_goal_progress") && msg.includes("GOAL_PROGRESS:"));
  check("with none recorded, a continuation asks for the first milestone report", msg.includes("No milestones are recorded for this goal yet."));
  check("legacy sessions can report blockers and verification without the old brief", msg.includes("include `blocker`") && msg.includes("`verification` saying how"));
  check("the first report preserves pending owner testing and approval", msg.includes("unresolved dependencies as blocked or awaiting_approval") && msg.includes("Owner testing and approval stay pending until explicitly approved"));

  console.log("goal session: a resumed session keeps its milestones");
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `part-${i}`, title: `Parser part ${i}: a deliberately long milestone title to fill the list`, status: i < 3 ? ("done" as const) : ("planned" as const) }));
  check("the session's report is recorded", h.runner.recordWork(thread, { items: [...items, { id: "part-3", title: "Parser part 3", status: "working" }] }).ok);
  await endTurn(h, thread, { report: `Turn ${TURNS}.\nGOAL STATUS: CONTINUE: part ${TURNS + 1}`, tools: novel(5) });
  await h.runner.evaluate(id);
  const resumed = h.continued.at(-1)!.message;
  check("the next turn lists the open milestones by id", resumed.includes("3 milestones recorded done.") && resumed.includes("- part-3 [working]: Parser part 3"));
  check("once milestones are recorded, the first-report request is gone", !resumed.includes("No milestones are recorded"));
  check(`a long milestone list is clipped, and the continuation stays short (${resumed.length} chars, ${msg.length} without milestones)`, resumed.includes("more not shown") && resumed.length < 2_500);
  check("the milestones stay on the goal across turns", goalOf(h, id).workItems.length === 30);

  console.log("goal session: the same script on the fresh-step loop");
  const f = harness();
  f.answers.push(answer("continue", "s1"));
  const fresh = f.runner.create({ title: "Fresh", objective: "Ship the parser with docs and tests.", workspace: process.cwd(), persistentSession: false }).goal!;
  await f.runner.idle();
  for (let turn = 1; turn < TURNS; turn++) {
    f.answers.push(answer("continue", `s${turn + 1}`));
    await endTurn(f, goalOf(f, fresh.id).currentThreadId!, { report: `Turn ${turn}.\nGOAL STATUS: CONTINUE — more`, tools: novel(5) });
    await f.runner.evaluate(fresh.id);
  }
  check("the fresh-step loop spends a director call and a new task per turn", f.judged.length === TURNS && f.dispatched.length === TURNS && f.continued.length === 0);
  console.log(`    ${TURNS} turns: persistent = ${h.judged.length} director call + ${h.dispatched.length} dispatch + ${h.continued.length} continuations; fresh-step = ${f.judged.length} director calls + ${f.dispatched.length} dispatches`);

  console.log("goal session: a parallel goal keeps fresh steps");
  const p = harness();
  p.answers.push(answer("continue", "a"), answer("continue", "b"), answer("continue", "c"));
  const wide = p.runner.create({ title: "Wide", objective: "o", workspace: process.cwd(), maxConcurrent: 2 }).goal!;
  await p.runner.idle();
  await endTurn(p, p.db.listOpenGoalSteps(wide.id)[0]!.threadId!, { report: "A.\nGOAL STATUS: CONTINUE — more", tools: novel(4) });
  await p.runner.evaluate(wide.id);
  await p.runner.idle();
  check("a parallel goal never continues a session", p.continued.length === 0 && p.dispatched.length === 3 && p.judged.length === 3);
}

async function completionAudit(): Promise<void> {
  console.log("goal session: a completion claim is audited");
  const h = harness();
  const { id, thread } = await started(h);
  h.answers.push(answer("continue", "Docs are missing"));
  await endTurn(h, thread, { report: "All done.\nGOAL STATUS: COMPLETE", tools: novel(4) });
  await h.runner.evaluate(id);
  check("the claim goes to the director", h.judged.length === 2 && h.judged[1]!.includes("audit that claim"));
  check("a rejected claim continues in the same session with the audit's reason", h.continued.length === 1 && h.continued[0]!.threadId === thread && h.continued[0]!.message.includes("DOES NOT AGREE YET") && h.continued[0]!.message.includes("Do Docs are missing."));
  check("no fresh task for the rework", h.dispatched.length === 1);
  h.answers.push(answer("complete", "unused"));
  await endTurn(h, thread, { report: "Docs written too.\nGOAL STATUS: COMPLETE", tools: novel(4) });
  await h.runner.evaluate(id);
  check("claim + agreeing audit achieves the goal", goalOf(h, id).status === "achieved" && h.judged.length === 3);

  console.log("goal session: the director alone asks for verification in the session");
  const v = harness();
  const vg = await started(v, { objective: "o" });
  v.runner.update(vg.id, { objective: "o, and benchmarks" });
  v.answers.push(answer("complete", "Verify"));
  await endTurn(v, vg.thread, { report: "Benchmarks done.\nGOAL STATUS: CONTINUE — check", tools: novel(4) });
  await v.runner.evaluate(vg.id);
  check("a changed objective asks the director", v.judged.length === 2 && v.judged[1]!.includes("changed the objective"));
  check("a lone director verdict sends a verification turn into the session", v.continued.length === 1 && v.continued[0]!.message.includes("BELIEVES THE OBJECTIVE IS MET") && goalOf(v, vg.id).status === "active");
}

async function waitingTurn(): Promise<void> {
  console.log("goal session: a WAITING turn defers once");
  const h = harness();
  const { id, thread } = await started(h);
  await endTurn(h, thread, { report: "Benchmark running as pid 4242; checked it is alive.\nGOAL STATUS: WAITING — pid 4242 bench", tools: novel(4) });
  await h.runner.evaluate(id);
  let goal = goalOf(h, id);
  check("no continuation while the job runs", h.continued.length === 0 && goal.hold === "waiting" && (goal.nextCheckAt ?? 0) > h.clock.t);
  check("the wait names the job", /pid 4242 bench/.test(goal.statusReason ?? ""));
  await h.runner.evaluate(id);
  check("nothing happens before the check", h.continued.length === 0 && h.judged.length === 1);
  h.clock.t = goal.nextCheckAt! + 1;
  await h.runner.evaluate(id);
  goal = goalOf(h, id);
  check("it continues in the session at the check, with no director call", h.continued.length === 1 && h.judged.length === 1 && goal.hold === null);
  await endTurn(h, thread, { report: "Still running.\nGOAL STATUS: WAITING — pid 4242 bench", tools: SAME });
  await h.runner.evaluate(id);
  check("a repeated WAITING report on a live job is not a no-progress stop", goalOf(h, id).status === "active");
}

async function noProgress(): Promise<void> {
  console.log("goal session: an identical summary with real new work continues");
  let h = harness();
  let g = await started(h);
  const same = "Worked through the backlog.\nGOAL STATUS: CONTINUE — more backlog";
  await endTurn(h, g.thread, { report: same, tools: novel(5) });
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: same, tools: novel(5) });
  await h.runner.evaluate(g.id);
  check("new tool calls under the same words continue", goalOf(h, g.id).status === "active" && h.continued.length === 2);
  await endTurn(h, g.thread, { report: same, tools: SAME, fingerprint: "git-1" });
  await h.runner.evaluate(g.id);
  check("a repository change under the same words continues", goalOf(h, g.id).status === "active" && h.continued.length === 3);
  await endTurn(h, g.thread, { report: same, tools: SAME, findings: ["Found the slow query in reports.ts"] });
  await h.runner.evaluate(g.id);
  check("a new finding under the same words continues", goalOf(h, g.id).status === "active" && h.continued.length === 4);
  await endTurn(h, g.thread, { report: same, tools: SAME, findings: ["Found the slow query in reports.ts"] });
  await h.runner.evaluate(g.id);
  let goal = goalOf(h, g.id);
  check("the same words with nothing new stops", goal.status === "blocked" && /repeated the report/.test(goal.statusReason ?? "") && h.continued.length === 4);
  check("the stop is notified as blocked", h.notices.includes("input:Goal blocked: Carry"));

  console.log("goal session: turns that reword but do nothing stop after a streak");
  h = harness();
  g = await started(h);
  await endTurn(h, g.thread, { report: "Set up.\nGOAL STATUS: CONTINUE — a", tools: SAME });
  await h.runner.evaluate(g.id);
  for (let i = 1; i <= GOAL_IDLE_TURNS; i++) {
    await endTurn(h, g.thread, { report: `Checked again (${i}).\nGOAL STATUS: CONTINUE — a`, tools: SAME });
    await h.runner.evaluate(g.id);
    if (i < GOAL_IDLE_TURNS) check(`idle turn ${i} still continues`, goalOf(h, g.id).status === "active");
  }
  goal = goalOf(h, g.id);
  check(`${GOAL_IDLE_TURNS} idle turns in a row stop`, goal.status === "blocked" && /did no new work/.test(goal.statusReason ?? ""));

  console.log("goal session: a turn that ends on its report alone goes to the director");
  h = harness();
  g = await started(h);
  h.answers.push(answer("continue", "The instruction ended with its turn: do the backlog"));
  await endTurn(h, g.thread, { report: "Wrapped up as you asked; nothing changed.\nGOAL STATUS: BLOCKED — you asked me to finish up" });
  await h.runner.evaluate(g.id);
  goal = goalOf(h, g.id);
  check("a text-only turn does not block the goal", goal.status === "active");
  check("the director is asked why it stopped, not skipped", h.judged.length === 2 && h.judged[1]!.includes("made no tool call: it only wrote its report"));
  check("its direction goes into the same session", h.continued.length === 1 && h.continued[0]!.threadId === g.thread && h.continued[0]!.message.includes("Do The instruction ended with its turn: do the backlog."));
  await endTurn(h, g.thread, { report: "Took the backlog.\nGOAL STATUS: CONTINUE — more backlog", tools: novel(5) });
  await h.runner.evaluate(g.id);
  check("a working turn after it continues on its own again", goalOf(h, g.id).status === "active" && h.continued.length === 2 && h.judged.length === 2);

  console.log("goal session: a text-only turn that repeats the report before it still goes to the director");
  h = harness();
  g = await started(h);
  await endTurn(h, g.thread, { report: "Finished up.\nGOAL STATUS: CONTINUE — nothing left", tools: novel(5) });
  await h.runner.evaluate(g.id);
  h.answers.push(answer("continue", "Take the next backlog item"));
  await endTurn(h, g.thread, { report: "Finished up.\nGOAL STATUS: CONTINUE — nothing left" });
  await h.runner.evaluate(g.id);
  check("a repeated report does not stop it before the director judges", goalOf(h, g.id).status === "active" && h.judged.length === 2 && h.judged[1]!.includes("made no tool call"));

  console.log("goal session: a turn with no tool call again after the director's direction stops");
  h = harness();
  g = await started(h);
  h.answers.push(answer("continue", "Get back to work"));
  await endTurn(h, g.thread, { report: "I think we are fine.\nGOAL STATUS: CONTINUE — x" });
  await h.runner.evaluate(g.id);
  check("the first goes to the director", goalOf(h, g.id).status === "active" && h.judged.length === 2 && h.continued.length === 1);
  await endTurn(h, g.thread, { report: "Still fine, I think.\nGOAL STATUS: CONTINUE — y" });
  await h.runner.evaluate(g.id);
  goal = goalOf(h, g.id);
  check("the second in a row blocks with the reason", goal.status === "blocked" && /last 2 turns made no tool call, even with the director's direction/.test(goal.statusReason ?? ""));
  check("without another director call or turn", h.judged.length === 2 && h.continued.length === 1);
  check("the stop is notified", h.notices.includes("input:Goal blocked: Carry"));

  console.log("goal session: an explicit resume starts a fresh audit");
  h.answers.push(answer("continue", "Pick up from the parser"));
  check("resume is accepted", h.runner.setStatus(g.id, "active").ok);
  await h.runner.idle();
  goal = goalOf(h, g.id);
  check("the director is asked before the session goes on", h.judged.length === 3 && h.judged[2]!.includes("resumed the goal"));
  check("the resumed goal continues in its session with the director's direction", h.continued.length === 2 && h.continued[1]!.message.includes("Do Pick up from the parser."));
  check("its progress summary is kept", goal.progress === "progress after Pick up from the parser");
  h.answers.push(answer("continue", "Parser next"));
  await endTurn(h, g.thread, { report: "Read the notes.\nGOAL STATUS: CONTINUE — parser" });
  await h.runner.evaluate(g.id);
  check("the resume starts the no-tool-call count afresh: the director is asked, not a stop", goalOf(h, g.id).status === "active" && h.judged.length === 4 && h.continued.length === 3);
}

async function blockerStreak(): Promise<void> {
  console.log("goal session: the same impasse three turns running stops");
  let h = harness();
  let g = await started(h);
  const wording = ["Need the API key.", "Still missing the API key for staging.", "The staging key is not available."];
  for (let i = 0; i < GOAL_BLOCKED_TURNS; i++) {
    await endTurn(h, g.thread, { report: `${wording[i]}\nGOAL STATUS: BLOCKED — ${wording[i]}`, tools: novel(4) });
    await h.runner.evaluate(g.id);
    if (i < GOAL_BLOCKED_TURNS - 1) check(`blocked turn ${i + 1} still tries again`, goalOf(h, g.id).status === "active" && goalOf(h, g.id).blockedStreak === i + 1);
  }
  let goal = goalOf(h, g.id);
  check("rewording and trying new commands do not reset the streak", goal.status === "blocked" && /same impasse/.test(goal.statusReason ?? ""));

  console.log("goal session: a blocker after real progress is a new one");
  h = harness();
  g = await started(h);
  await endTurn(h, g.thread, { report: "Need key A.\nGOAL STATUS: BLOCKED — key A", tools: novel(4) });
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: "Need key A.\nGOAL STATUS: BLOCKED — key A", tools: SAME });
  await h.runner.evaluate(g.id);
  check("two turns on key A", goalOf(h, g.id).blockedStreak === 2);
  await endTurn(h, g.thread, { report: "Key A arrived; migrated. Now need key B.\nGOAL STATUS: BLOCKED — key B", tools: novel(4), fingerprint: "git-2" });
  await h.runner.evaluate(g.id);
  goal = goalOf(h, g.id);
  check("a changed repository restarts the count", goal.status === "active" && goal.blockedStreak === 1);
  await endTurn(h, g.thread, { report: "Need key B.\nGOAL STATUS: BLOCKED — key B", tools: SAME });
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: "Need key B.\nGOAL STATUS: BLOCKED — key B", tools: SAME });
  await h.runner.evaluate(g.id);
  check("the new impasse stops after its own three turns", goalOf(h, g.id).status === "blocked");

  console.log("goal session: any other ending clears the streak");
  h = harness();
  g = await started(h);
  await endTurn(h, g.thread, { report: "Need key.\nGOAL STATUS: BLOCKED — key", tools: novel(4) });
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: "Worked around it.\nGOAL STATUS: CONTINUE — rest", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("a CONTINUE turn resets the count", goalOf(h, g.id).blockedStreak === 0 && goalOf(h, g.id).status === "active");
}

async function holds(): Promise<void> {
  console.log("goal session: pending owner input holds the next turn");
  let h = harness();
  let g = await started(h);
  h.continueResult = { ok: false, hold: { kind: "waiting", reason: "Step task has the owner's queued message to deliver first." } };
  await endTurn(h, g.thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.id);
  let goal = goalOf(h, g.id);
  check("queued input: no continuation is sent over it", h.continued.length === 0 && goal.hold === "waiting" && /queued message/.test(goal.statusReason ?? ""));
  check("a hold costs no director call", h.judged.length === 1);
  h.clock.t = goal.nextCheckAt! + 1;
  await h.runner.evaluate(g.id);
  check("once the input is delivered, the session continues", h.continued.length === 1 && goalOf(h, g.id).hold === null);

  console.log("goal session: a cap-parked or restarting task keeps its slot");
  h = harness();
  g = await started(h);
  h.holds.set(g.thread, { kind: "usage_limited", reason: "Step task is parked on a usage cap until 14:00." });
  await endTurn(h, g.thread, { report: "Half.", tools: novel(4), state: "review" });
  await h.runner.evaluate(g.id);
  goal = goalOf(h, g.id);
  check("a cap park does not settle the step", goal.steps[0]!.settledAt === null && goal.hold === "usage_limited" && h.judged.length === 1 && h.dispatched.length === 1);
  h.holds.set(g.thread, { kind: "waiting", reason: "Step task resumes after the restart." });
  await h.runner.evaluate(g.id);
  check("a restart auto-resume does not settle it either", goalOf(h, g.id).steps[0]!.settledAt === null && goalOf(h, g.id).hold === "waiting");
  h.holds.delete(g.thread);
  h.db.updateThread(g.thread, { state: "implementing" });
  await h.runner.evaluate(g.id);
  check("back at work: the hold clears", goalOf(h, g.id).hold === null);

  console.log("goal session: a task that can no longer take a turn gets a fresh step");
  h = harness();
  g = await started(h);
  h.continueResult = { ok: false, fresh: "the step task was closed" };
  h.answers.push(answer("continue", "Fresh start"));
  await endTurn(h, g.thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("the director plans a fresh task, once", h.judged.length === 2 && h.dispatched.length === 2 && h.continued.length === 0);
  check("the director is told the task cannot carry on", h.judged[1]!.includes("cannot carry the goal on"));
}

async function budget(): Promise<void> {
  console.log("goal session: a token budget stops the loop");
  const h = harness();
  const g = await started(h, { tokenBudget: 1_000 });
  const run = h.db.createRun({ threadId: g.thread, role: "implementor", model: "claude-opus-5-5", account: "max-1" });
  h.db.updateRun(run.id, { tokenUsage: { inputTokens: 300, outputTokens: 900, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 51_200 } });
  await endTurn(h, g.thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.id);
  let goal = goalOf(h, g.id);
  check("cached input does not count against the budget", goal.usage.tokensUsed === 1_200 && goal.usage.cachedInputTokens === 50_000);
  check("spent: budget_limited, no continuation", goal.status === "budget_limited" && h.continued.length === 0 && /token budget/.test(goal.statusReason ?? ""));
  check("the owner is told", h.notices.includes("input:Goal out of token budget: Carry"));
  check("describeGoal shows the spend", describeGoal(goal).includes("Step-task run usage: 1.2k of 1k step-task tokens"));
  check("resume is refused while the budget is spent", !h.runner.setStatus(g.id, "active").ok);
  check("a Grok pin is refused on a budgeted goal", !h.runner.update(g.id, { provider: "grok", model: "grok-5" }).ok);
  check("raising the budget is accepted", h.runner.update(g.id, { tokenBudget: 10_000 }).ok);
  h.answers.push(answer("continue", "Part 2"));
  check("then resume is accepted", h.runner.setStatus(g.id, "active").ok);
  await h.runner.idle();
  goal = goalOf(h, g.id);
  check("the resumed goal audits, then continues in the same session", h.judged.length === 2 && h.continued.length === 1 && h.dispatched.length === 1 && goal.status === "active");
}

const GROK: ModelCandidate = { provider: "grok", model: "grok-5", note: "unmetered", efforts: ["low", "medium", "high"] };

/** The director's answer, picking Grok for the next step. */
function grokPick(title: string) {
  const a = answer("continue", title);
  return { ...a, next: { ...a.next, provider: "grok", model: "grok-5" } };
}

async function budgetMetering(): Promise<void> {
  console.log("goal session: a budgeted goal never runs where its budget cannot see");
  let h = harness();
  h.roster = [...ROSTER, GROK];
  h.answers.push(grokPick("Build it all"));
  let g = h.runner.create({ title: "Metered", objective: "Ship it.", workspace: process.cwd(), tokenBudget: 50_000 });
  await h.runner.idle();
  check("the director is not offered Grok", !h.judged[0]!.includes("grok-5"));
  check("a Grok pick runs on a metered pool instead", h.dispatched[0]!.requestedProvider === "claude" && h.dispatched[0]!.requestedModel === "claude-opus-5-5");

  h = harness();
  h.roster = [GROK];
  g = h.runner.create({ title: "Metered", objective: "Ship it.", workspace: process.cwd(), tokenBudget: 50_000 });
  await h.runner.idle();
  const held = goalOf(h, g.goal!.id);
  check("only Grok free: the goal waits on capacity without a director call", h.judged.length === 0 && h.dispatched.length === 0 && held.hold === "usage_limited" && /only Grok/.test(held.statusReason ?? ""));

  h = harness();
  h.roster = [...ROSTER, GROK];
  h.answers.push(grokPick("Build it all"));
  g = h.runner.create({ title: "Unmetered", objective: "Ship it.", workspace: process.cwd() });
  await h.runner.idle();
  check("without a budget a Grok pick stands", h.dispatched[0]!.requestedProvider === "grok");
  const thread = goalOf(h, g.goal!.id).currentThreadId!;
  check("a budget can be added to a goal that is not pinned to Grok", h.runner.update(g.goal!.id, { tokenBudget: 50_000 }).ok);
  await h.runner.idle();
  h.answers.push(grokPick("Part 2"));
  await endTurn(h, thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.goal!.id);
  check("...and the Grok task is not carried on: the next step is a fresh, metered task", h.continued.length === 0 && h.dispatched.length === 2 && h.dispatched[1]!.requestedProvider === "claude");
}

async function pinChange(): Promise<void> {
  console.log("goal session: a pin change ends the carried session");
  const h = harness();
  const g = await started(h);
  h.runner.update(g.id, { provider: "codex", model: "gpt-5.6" });
  await h.runner.idle();
  h.answers.push(answer("continue", "On codex"));
  await endTurn(h, g.thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("the next step is a fresh task on the new pin", h.continued.length === 0 && h.dispatched.length === 2 && h.dispatched[1]!.requestedModel === "gpt-5.6");
  check("the director is told why", h.judged[1]!.includes("changed the model/effort pin"));
}

async function races(): Promise<void> {
  console.log("goal session: a budget lowered while the director thinks");
  let h = harness();
  let g = await started(h, { tokenBudget: 100_000 });
  const run = h.db.createRun({ threadId: g.thread, role: "implementor", model: "claude-opus-5-5", account: "max-1" });
  h.db.updateRun(run.id, { tokenUsage: { inputTokens: 500, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000 } });
  h.answers.push(answer("continue", "Rework"));
  h.onJudge = () => {
    h.onJudge = undefined;
    h.runner.update(g.id, { tokenBudget: 500 });
  };
  await endTurn(h, g.thread, { report: "Done?\nGOAL STATUS: COMPLETE", tools: novel(4) });
  await h.runner.evaluate(g.id);
  await h.runner.idle();
  check("the stale judgement neither continues nor dispatches", h.continued.length === 0 && h.dispatched.length === 1);
  check("the goal stops on the new budget", goalOf(h, g.id).status === "budget_limited");

  console.log("goal session: spend crossing the budget while the director thinks");
  h = harness();
  g = await started(h, { tokenBudget: 1_000 });
  h.answers.push(answer("continue", "Rework"));
  h.onJudge = () => {
    h.onJudge = undefined;
    const late = h.db.createRun({ threadId: g.thread, role: "implementor", model: "claude-opus-5-5", account: "max-1" });
    h.db.updateRun(late.id, { tokenUsage: { inputTokens: 800, outputTokens: 800, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_600 } });
  };
  await endTurn(h, g.thread, { report: "Done?\nGOAL STATUS: COMPLETE", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("the budget is re-checked before the turn is sent", h.continued.length === 0 && goalOf(h, g.id).status === "budget_limited");

  console.log("goal session: the session policy switched off while the director thinks");
  h = harness();
  g = await started(h);
  h.answers.push(answer("continue", "Stale"), answer("continue", "Fresh task"));
  h.onJudge = () => {
    h.onJudge = undefined;
    h.runner.update(g.id, { persistentSession: false });
  };
  await endTurn(h, g.thread, { report: "Done?\nGOAL STATUS: COMPLETE", tools: novel(4) });
  await h.runner.evaluate(g.id);
  await h.runner.idle();
  check("the stale judgement is dropped and the new policy plans a fresh task", h.continued.length === 0 && h.judged.length === 3 && h.dispatched.length === 2 && h.dispatched[1]!.title.includes("Fresh task"));

  console.log("goal session: the owner resumes the task while its evidence is read");
  h = harness();
  g = await started(h);
  h.onFingerprint = () => {
    h.onFingerprint = undefined;
    h.db.addMessage({ threadId: g.thread, role: "user", kind: "text", content: "Also fix the README." });
    h.db.updateThread(g.thread, { state: "implementing" });
  };
  await endTurn(h, g.thread, { report: "Thinking.\nGOAL STATUS: CONTINUE — x" });
  await h.runner.evaluate(g.id);
  let goal = goalOf(h, g.id);
  check("the old report neither settles nor blocks the resumed turn", goal.status === "active" && goal.steps[0]!.settledAt === null && goal.steps[0]!.outcome === null);
  check("nothing is sent into the resumed task", h.continued.length === 0);
  await endTurn(h, g.thread, { report: "README fixed.\nGOAL STATUS: CONTINUE — y", tools: novel(4), fingerprint: "git-3" });
  await h.runner.evaluate(g.id);
  goal = goalOf(h, g.id);
  check("its real ending settles and continues", goal.status === "active" && h.continued.length === 1);

  console.log("goal session: the turn boundary precedes the host's run");
  h = harness();
  g = await started(h);
  h.runOnContinue = true;
  await endTurn(h, g.thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.id);
  const step = goalOf(h, g.id).steps[0]!;
  const runs = h.db.goalTurnActivity(g.thread, step.turnStartedAt).runs;
  check("a run the host creates during the send belongs to the new turn", h.continued.length === 1 && runs === 1);
}

async function uncleanTurns(): Promise<void> {
  console.log("goal session: unclean turns with no tool call stop at the second");
  let h = harness();
  let g = await started(h);
  h.answers.push(answer("continue", "Recover the context"));
  await endTurn(h, g.thread, { report: "Lost the context.", state: "review" });
  await h.runner.evaluate(g.id);
  let goal = goalOf(h, g.id);
  check("the first is the director's to judge", goal.status === "active" && h.judged.length === 2 && h.continued.length === 1);
  check("told it both made no tool call and did not finish cleanly", h.judged[1]!.includes("made no tool call and did not finish cleanly"));
  await endTurn(h, g.thread, { report: "Lost it again.", state: "review" });
  await h.runner.evaluate(g.id);
  goal = goalOf(h, g.id);
  check("the second blocks without asking the director again", goal.status === "blocked" && /made no tool call, and the last did not finish cleanly/.test(goal.statusReason ?? "") && h.judged.length === 2 && h.continued.length === 1);

  console.log("goal session: a task that keeps ending unclean is not continued again");
  h = harness();
  g = await started(h);
  h.answers.push(answer("continue", "Try again"));
  await endTurn(h, g.thread, { report: "Half.", tools: novel(4), state: "review" });
  await h.runner.evaluate(g.id);
  check("one unclean turn: the director is asked, and the session goes on", h.judged.length === 2 && h.continued.length === 1 && h.dispatched.length === 1);
  h.answers.push(answer("continue", "Start clean"));
  await endTurn(h, g.thread, { report: "Half again.", tools: novel(4), state: "review" });
  await h.runner.evaluate(g.id);
  check(`${GOAL_UNCLEAN_TURNS} unclean turns running: the next step is a fresh task`, h.continued.length === 1 && h.dispatched.length === 2 && h.dispatched[1]!.title.includes("Start clean"));
}

async function waitingBackoff(): Promise<void> {
  console.log("goal session: a long job's idle checks wait longer each time");
  let h = harness();
  let g = await started(h);
  const minutes: number[] = [];
  // The first two turns do new work (SAME is new the first time it appears); the five after them only poll.
  for (let i = 0; i < 7; i++) {
    await endTurn(h, g.thread, { report: "Still running.\nGOAL STATUS: WAITING — pid 4242 bench", tools: i === 0 ? novel(4) : SAME });
    await h.runner.evaluate(g.id);
    const goal = goalOf(h, g.id);
    minutes.push(Math.round((goal.nextCheckAt! - h.clock.t) / 60_000));
    h.clock.t = goal.nextCheckAt! + 1;
    await h.runner.evaluate(g.id);
  }
  check(`the waits double and stop at an hour (${minutes.join(", ")} min)`, minutes.join() === [5, 5, 10, 20, 40, 60, 60].join());
  check("an idle watch never stops the goal", goalOf(h, g.id).status === "active" && h.continued.length === 7 && h.judged.length === 1);
  await endTurn(h, g.thread, { report: "Bench at 80%.\nGOAL STATUS: WAITING — pid 4242 bench", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("a check that finds new work resets the wait", goalOf(h, g.id).nextCheckAt! - h.clock.t === 5 * 60_000);

  console.log("goal session: a WAITING turn that did new work clears the idle streak");
  h = harness();
  g = await started(h);
  for (const i of [0, 1, 2]) {
    await endTurn(h, g.thread, { report: `Checked again (${i}).\nGOAL STATUS: CONTINUE — a`, tools: SAME });
    await h.runner.evaluate(g.id);
  }
  check("two idle turns counted", h.db.goalLoopState(g.id).idleStreak === 2);
  await endTurn(h, g.thread, { report: "Started the benchmark as pid 7.\nGOAL STATUS: WAITING — pid 7", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("the WAITING turn's new work resets the count", h.db.goalLoopState(g.id).idleStreak === 0);
  h.clock.t = goalOf(h, g.id).nextCheckAt! + 1;
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: "Checked again (3).\nGOAL STATUS: CONTINUE — a", tools: SAME });
  await h.runner.evaluate(g.id);
  check("so the next idle turn is the first of a new streak", goalOf(h, g.id).status === "active" && h.db.goalLoopState(g.id).idleStreak === 1);

  console.log("goal session: a repeated report is compared with the turn just before");
  h = harness();
  g = await started(h);
  const same = "Checked the queue.\nGOAL STATUS: CONTINUE — queue";
  await endTurn(h, g.thread, { report: same, tools: SAME });
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: "Job running.\nGOAL STATUS: WAITING — job", tools: SAME });
  await h.runner.evaluate(g.id);
  h.clock.t = goalOf(h, g.id).nextCheckAt! + 1;
  await h.runner.evaluate(g.id);
  await endTurn(h, g.thread, { report: same, tools: SAME });
  await h.runner.evaluate(g.id);
  check("a report seen two turns ago is not a repeat", goalOf(h, g.id).status === "active");
}

async function carrierPolicy(): Promise<void> {
  console.log("goal session: a persistent goal's task skips the self-improvement round");
  let h = harness();
  let g = await started(h);
  check("its dispatch asks for no self-improvement round", h.dispatched[0]!.skipSelfImprovement === true);
  const p = harness();
  p.answers.push(answer("continue", "s1"));
  p.runner.create({ title: "Fresh", objective: "o", workspace: process.cwd(), persistentSession: false });
  await p.runner.idle();
  check("a fresh-step goal keeps the round", p.dispatched[0]!.skipSelfImprovement === undefined);

  console.log("goal session: a budgeted goal reads the backend a task actually ran on");
  h = harness();
  g = await started(h);
  h.db.createRun({ threadId: g.thread, role: "implementor", model: "grok-5", account: "grok:grok-5" });
  check("the budget is accepted (the step was dispatched on claude)", h.runner.update(g.id, { tokenBudget: 50_000 }).ok);
  await h.runner.idle();
  h.answers.push(answer("continue", "Metered"));
  await endTurn(h, g.thread, { report: "Part 1.\nGOAL STATUS: CONTINUE — part 2", tools: novel(4) });
  await h.runner.evaluate(g.id);
  check("a task that failed over to Grok is not carried on", h.continued.length === 0 && h.dispatched.length === 2 && h.dispatched[1]!.requestedProvider === "claude");

  console.log("goal session: a carrier whose pool is over pace waits without a director call");
  h = harness();
  g = await started(h);
  h.roster = [{ ...ROSTER[0]!, weekly: { usedPct: 99, resetAt: h.clock.t + 6 * 86_400_000 } }, ROSTER[1]!];
  await endTurn(h, g.thread, { report: "Half.", tools: novel(4), state: "review" });
  await h.runner.evaluate(g.id);
  const goal = goalOf(h, g.id);
  check("no judgement, no fresh task on another pool", h.judged.length === 1 && h.dispatched.length === 1 && h.continued.length === 0);
  check("the goal waits for the carrier's pool", goal.hold === "usage_limited" && goal.status === "active");

  console.log("goal session: a carrier's pool that runs out while the director judges");
  h = harness();
  g = await started(h);
  h.answers.push(answer("continue", "Fix the half"));
  h.onJudge = () => {
    h.onJudge = undefined;
    h.roster = [{ ...ROSTER[0]!, weekly: { usedPct: 99, resetAt: h.clock.t + 6 * 86_400_000 } }, ROSTER[1]!];
  };
  await endTurn(h, g.thread, { report: "Half.", tools: novel(4), state: "review" });
  await h.runner.evaluate(g.id);
  check("the session's judgement is not handed to a fresh task on another pool", h.judged.length === 2 && h.dispatched.length === 1 && h.continued.length === 0 && goalOf(h, g.id).hold === "usage_limited");

  console.log("goal session: a backend that reports no tool calls is not idle for it");
  h = harness();
  g = await started(h);
  for (let i = 1; i <= GOAL_IDLE_TURNS + 1; i++) {
    await tick();
    h.db.createRun({ threadId: g.thread, role: "implementor", model: "grok-5", account: "grok:grok-5" });
    await endTurn(h, g.thread, { report: `Grok turn ${i}.\nGOAL STATUS: CONTINUE — more` });
    await h.runner.evaluate(g.id);
  }
  check(`${GOAL_IDLE_TURNS + 1} reworded Grok turns keep going`, goalOf(h, g.id).status === "active" && h.continued.length === GOAL_IDLE_TURNS + 1);
  h.db.createRun({ threadId: g.thread, role: "implementor", model: "grok-5", account: "grok:grok-5" });
  await endTurn(h, g.thread, { report: `Grok turn ${GOAL_IDLE_TURNS + 1}.\nGOAL STATUS: CONTINUE — more` });
  await h.runner.evaluate(g.id);
  check("but a repeated report still stops them", goalOf(h, g.id).status === "blocked" && /repeated the report/.test(goalOf(h, g.id).statusReason ?? ""));
}

function usageAccounting(): void {
  console.log("goal session: usage accounting");
  const base = 1_000_000;
  const row = (over: Partial<RunTokenRow>): RunTokenRow => ({
    account: "max-1", startedAt: base + 10, endedAt: base + 70_010,
    inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, ...over,
  });
  const usage = summarizeRunUsage([
    row({ startedAt: base - 1, inputTokens: 9_999_999, outputTokens: 9_999_999 }),
    row({ inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 5_000, cacheCreationInputTokens: 300 }),
    row({ account: "codex:gpt-5.6", inputTokens: 6_000, outputTokens: 400, cacheReadInputTokens: 5_000 }),
    row({ account: "grok:grok-5" }),
  ], base);
  check("runs before the baseline are only counted", usage.runsBeforeBaseline === 1 && usage.runs === 3);
  check("Claude fresh input = input + cache writes", usage.freshInputTokens === 100 + 300 + 1_000);
  check("Codex fresh input = input minus its cached part", usage.freshInputTokens - 400 === 1_000);
  check("tokens used = fresh input + output, cache reads apart", usage.tokensUsed === 1_400 + 600 && usage.cachedInputTokens === 10_000);
  check("an unmetered run is counted, not read as zero", usage.unmeteredRuns === 1);
  check("the line marks a lower bound and the uncounted runs", describeGoalUsage(usage, 5_000) === "≥ 2k of 5k step-task tokens (1 run reported no usage; 1 earlier run not counted)");
  check("agent time is summed per counted run", usage.agentSeconds === 210);
}

function existingGoals(): void {
  console.log("goal session: goals that existed before this build");
  const path = join(mkdtempSync(join(tmpdir(), "goal-session-legacy-")), "t.sqlite");
  const db = new Db(path);
  const paused = db.createGoal({ title: "Overlay", objective: "o", workspace: process.cwd(), effort: null, provider: null, model: null, maxConcurrent: 1, burnConservation: true, burnRatePct: 100 });
  db.updateGoal(paused.id, { status: "paused", statusReason: "Paused by the owner." });
  db.raw.prepare("UPDATE goals SET usage_since = NULL").run();
  db.raw.close();
  const before = Date.now();
  const reopened = new Db(path);
  const goal = reopened.getGoal(paused.id)!;
  check("a paused goal stays paused", goal.status === "paused" && goal.statusReason === "Paused by the owner." && goal.hold === null);
  check("its usage counts from the migration on", goal.usage.since >= before);
  check("it carries its session from now on", goal.persistentSession === true && goal.tokenBudget === null);
  reopened.raw.close();
}

async function main(): Promise<void> {
  await sessionReuse();
  await completionAudit();
  await waitingTurn();
  await noProgress();
  await blockerStreak();
  await holds();
  await budget();
  await budgetMetering();
  await pinChange();
  await races();
  await uncleanTurns();
  await waitingBackoff();
  await carrierPolicy();
  usageAccounting();
  existingGoals();
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall goal session checks passed");
  process.exit(0);
}

void main();
