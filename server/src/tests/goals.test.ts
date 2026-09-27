// Deterministic gate for goal-directed tasks (orchestrator/goals.ts). No live accounts, no network, no
// real agents: a temp DB, real thread rows, and a fake host whose director answers from a script.
// Run: `npm run test:goals`.
//
// What it pins: the two-voice ending (agent claim AND director verdict), the verification step when only
// the director thinks it is done, the step-in-flight gate, the backoff when no director answers, the three
// runaway guards (cancel, failed streak, step budget), orphan adoption after a crash, the owner pausing
// mid-judgement, and the hub wake-up when a step task settles.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import {
  GoalRunner,
  detectGoalComplete,
  parseGoalJudgement,
  resolveStepPin,
  stepTitle,
  type GoalHost,
  type GoalJudgement,
} from "../orchestrator/goals.js";
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

function answer(verdict: "complete" | "continue", title = "Next slice", over: Partial<GoalJudgement["next"]> = {}) {
  return {
    verdict,
    reason: `director says ${verdict}`,
    progress: `progress after ${title}`,
    next: { title, brief: `Do ${title}.`, provider: "claude", model: "claude-opus-5-5", effort: "high", rationale: "hard step", ...over },
  };
}

function pure(): void {
  console.log("goals: detectGoalComplete");
  check("a standalone COMPLETE line is a claim", detectGoalComplete("Did it all.\n\nGOAL STATUS: COMPLETE"));
  check("markdown decoration is tolerated", detectGoalComplete("Done.\n**GOAL STATUS: COMPLETE**"));
  check("CONTINUE is not a claim", !detectGoalComplete("GOAL STATUS: CONTINUE — docs remain"));
  check("the last status line wins", !detectGoalComplete("GOAL STATUS: COMPLETE\nwait, more\nGOAL STATUS: CONTINUE — tests"));
  check("echoing the instruction is not a claim", !detectGoalComplete("`GOAL STATUS: COMPLETE` only if the ENTIRE objective is done"));
  check("a mid-sentence mention is not a claim", !detectGoalComplete("I will write GOAL STATUS: COMPLETE when done."));
  check("no report is no claim", !detectGoalComplete(null));

  console.log("goals: parseGoalJudgement");
  check("rejects a missing brief", parseGoalJudgement({ verdict: "continue", reason: "r", progress: "p", next: { title: "t", brief: "" } }) === null);
  check("rejects an unknown verdict", parseGoalJudgement({ ...answer("continue"), verdict: "maybe" }) === null);
  check("accepts a full answer", parseGoalJudgement(answer("continue"))?.next.title === "Next slice");

  console.log("goals: resolveStepPin");
  const exact = resolveStepPin(parseGoalJudgement(answer("continue"))!.next, ROSTER);
  check("an exact pair keeps its effort", exact.provider === "claude" && exact.model === "claude-opus-5-5" && exact.effort === "high" && exact.note === null);
  const lowered = resolveStepPin(parseGoalJudgement(answer("continue", "x", { provider: "codex", model: "gpt-5.6", effort: "max" }))!.next, ROSTER);
  check("an unoffered effort drops to the nearest lower one", lowered.effort === "high" && !!lowered.note);
  const moved = resolveStepPin(parseGoalJudgement(answer("continue", "x", { provider: "claude", model: "gpt-5.6", effort: "low" }))!.next, ROSTER);
  check("a model under the wrong backend moves to the one that has it", moved.provider === "codex" && moved.model === "gpt-5.6");
  const missing = resolveStepPin(parseGoalJudgement(answer("continue", "x", { model: "retired-model" }))!.next, ROSTER);
  check("an undispatchable model falls back to automatic routing", missing.provider === null && missing.model === null && !!missing.note);
}

interface Harness {
  db: Db;
  hub: EventHub;
  runner: GoalRunner;
  dispatched: DispatchInput[];
  answers: unknown[];
  judged: string[];
  notices: string[];
  clock: { t: number };
  onJudge?: () => void;
}

function harness(): Harness {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "goals-test-")), "t.sqlite"));
  const hub = new EventHub();
  const h = { db, hub, dispatched: [], answers: [], judged: [], notices: [], clock: { t: Date.now() } } as unknown as Harness;
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
      return next === undefined || next === null ? null : { output: next, model: "claude-opus-5-5", provider: "claude" };
    },
    roster: () => ROSTER,
    notify: (kind, title) => h.notices.push(`${kind}:${title}`),
  };
  h.runner = new GoalRunner(db, hub, host, { ownerName: "Kevin", now: () => h.clock.t, tickMs: 3_600_000, retryMs: 300_000 });
  return h;
}

function settle(h: Harness, threadId: string, state: ThreadState, report?: string): void {
  if (report) h.db.addMessage({ threadId, role: "implementor", kind: "text", content: report });
  h.db.updateThread(threadId, { state });
}

async function lifecycle(): Promise<void> {
  const ws = process.cwd();
  console.log("goals: first step");
  const h = harness();
  h.answers.push(answer("continue", "Build the parser"));
  const created = h.runner.create({ title: "Ship v2", objective: "Parser, docs and tests all done.", workspace: ws });
  check("create ok", created.ok && created.goal?.status === "active");
  await h.runner.idle();
  let goal = h.db.getGoal(created.goal!.id)!;
  check("the director was asked to plan step 1", h.judged.length === 1 && h.judged[0]!.includes("No step has run yet"));
  check("the judge prompt carries the roster", h.judged[0]!.includes('model "gpt-5.6"'));
  check("step 1 dispatched once", h.dispatched.length === 1);
  const first = h.dispatched[0]!;
  check("the step is pinned to the director's pick", first.requestedProvider === "claude" && first.requestedModel === "claude-opus-5-5" && first.effort === "high");
  check("the brief carries the objective and the status-line rule", first.brief.includes("Parser, docs and tests all done.") && first.brief.includes("GOAL STATUS: COMPLETE"));
  check("the board title names goal and step", first.title === stepTitle(goal, 1, "Build the parser"));
  check("the goal tracks its current task", goal.currentThreadId !== null && goal.steps[0]?.threadId === goal.currentThreadId);
  check("the director's progress summary is stored", goal.progress === "progress after Build the parser");

  console.log("goals: a running step blocks the next");
  await h.runner.evaluate(goal.id);
  check("no judgement while the step runs", h.judged.length === 1 && h.dispatched.length === 1);

  console.log("goals: agent claims complete, director disagrees");
  h.answers.push(answer("continue", "Write the docs"));
  settle(h, goal.currentThreadId!, "done", "Parser shipped.\nGOAL STATUS: COMPLETE");
  await h.runner.evaluate(goal.id);
  goal = h.db.getGoal(goal.id)!;
  check("step 1 recorded as done with the agent's claim", goal.steps[0]?.outcome === "done" && goal.steps[0]?.agentClaimedComplete === true);
  check("the judge saw the agent's claim and report", h.judged[1]!.includes("DECLARED the whole objective complete") && h.judged[1]!.includes("Parser shipped."));
  check("a lone agent claim does not end the goal", goal.status === "active" && h.dispatched.length === 2);
  check("the verdict is recorded", goal.lastVerdict?.verdict === "continue" && goal.lastVerdict.agentClaimedComplete === true);

  console.log("goals: director thinks complete, agent did not claim");
  h.answers.push(answer("complete", "Verify everything"));
  settle(h, goal.currentThreadId!, "done", "Docs written.\nGOAL STATUS: CONTINUE — tests remain");
  await h.runner.evaluate(goal.id);
  goal = h.db.getGoal(goal.id)!;
  check("a lone director verdict dispatches a verification step", goal.status === "active" && h.dispatched.length === 3);
  check("the verification brief says so", h.dispatched[2]?.brief.includes("THIS STEP IS A VERIFICATION") === true);

  console.log("goals: both agree");
  h.answers.push(answer("complete", "unused"));
  settle(h, goal.currentThreadId!, "done", "Verified all parts.\nGOAL STATUS: COMPLETE");
  await h.runner.evaluate(goal.id);
  goal = h.db.getGoal(goal.id)!;
  check("agent claim + director verdict achieves the goal", goal.status === "achieved" && goal.endedAt !== null);
  check("no step follows an achieved goal", h.dispatched.length === 3);
  check("the owner is notified", h.notices.some((n) => n.startsWith("done:Goal achieved")));
  await h.runner.evaluate(goal.id);
  check("an achieved goal is never re-judged", h.judged.length === 4);
}

async function guards(): Promise<void> {
  const ws = process.cwd();

  console.log("goals: backoff when no director answers");
  let h = harness();
  const a = h.runner.create({ title: "Backoff", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  let goal = h.db.getGoal(a.id)!;
  check("no dispatch without a judgement", h.dispatched.length === 0);
  check("the wait is visible and timed", goal.status === "active" && !!goal.statusReason && goal.nextCheckAt === h.clock.t + 300_000);
  await h.runner.evaluate(a.id);
  check("no retry before the backoff expires", h.judged.length === 1);
  h.clock.t += 300_001;
  h.answers.push(answer("continue", "Now"));
  await h.runner.evaluate(a.id);
  goal = h.db.getGoal(a.id)!;
  check("retries after the backoff and clears the wait", h.dispatched.length === 1 && goal.statusReason === null && goal.nextCheckAt === null);

  console.log("goals: a cancelled step pauses the goal, once");
  settle(h, goal.currentThreadId!, "cancelled");
  await h.runner.evaluate(a.id);
  goal = h.db.getGoal(a.id)!;
  check("cancel pauses with a reason", goal.status === "paused" && /cancelled/.test(goal.statusReason ?? ""));
  check("the pause is notified", h.notices.some((n) => n.startsWith("input:Goal paused")));
  h.answers.push(answer("continue", "After resume"));
  h.runner.setStatus(a.id, "active");
  await h.runner.idle();
  goal = h.db.getGoal(a.id)!;
  check("resume judges again instead of re-pausing on the old cancel", goal.status === "active" && h.dispatched.length === 2);

  console.log("goals: a streak of failed steps pauses");
  h = harness();
  h.answers.push(answer("continue", "s1"));
  const b = h.runner.create({ title: "Failing", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  for (let i = 2; i <= 3; i++) {
    h.answers.push(answer("continue", `s${i}`));
    settle(h, h.db.getGoal(b.id)!.currentThreadId!, "failed");
    await h.runner.evaluate(b.id);
  }
  settle(h, h.db.getGoal(b.id)!.currentThreadId!, "failed");
  await h.runner.evaluate(b.id);
  goal = h.db.getGoal(b.id)!;
  check("three failed steps pause the goal", goal.status === "paused" && /3 steps failed/.test(goal.statusReason ?? ""));
  check("no fourth step was dispatched", h.dispatched.length === 3);

  console.log("goals: the step budget pauses");
  h = harness();
  h.answers.push(answer("continue", "only"));
  const c = h.runner.create({ title: "Budget", objective: "o", workspace: ws, maxSteps: 1 }).goal!;
  await h.runner.idle();
  settle(h, h.db.getGoal(c.id)!.currentThreadId!, "review");
  await h.runner.evaluate(c.id);
  goal = h.db.getGoal(c.id)!;
  check("the budget pauses before a second judgement", goal.status === "paused" && /budget of 1 steps/.test(goal.statusReason ?? "") && h.judged.length === 1);
  check("a review outcome is not a failure", goal.steps[0]?.outcome === "review");

  console.log("goals: the owner pauses while the director is thinking");
  h = harness();
  const d = h.runner.create({ title: "Race", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  h.clock.t += 300_001;
  h.answers.push(answer("continue", "late"));
  h.onJudge = () => h.runner.setStatus(d.id, "paused");
  await h.runner.evaluate(d.id);
  await h.runner.idle();
  check("a judgement that lands after a pause dispatches nothing", h.dispatched.length === 0 && h.db.getGoal(d.id)!.status === "paused");

  console.log("goals: an orphaned step is adopted, not duplicated");
  h = harness();
  const e = h.runner.create({ title: "Orphan", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  const step = h.db.createGoalStep({ goalId: e.id, title: "lost link", provider: null, model: null, effort: null, rationale: "" });
  const orphan = h.db.createThread({ title: stepTitle(e, step.seq, "lost link"), workspace: ws, rawPrompt: "", brief: "b" });
  h.db.updateThread(orphan.id, { state: "implementing" });
  h.clock.t += 300_001;
  await h.runner.evaluate(e.id);
  goal = h.db.getGoal(e.id)!;
  check("the orphan's task is adopted as the current step", goal.currentThreadId === orphan.id && goal.steps.at(-1)?.threadId === orphan.id);
  check("no duplicate step was dispatched", h.dispatched.length === 0);

  console.log("goals: a settling step wakes its goal through the hub");
  h = harness();
  h.runner.start();
  h.answers.push(answer("continue", "one"));
  const f = h.runner.create({ title: "Wake", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  const current = h.db.getGoal(f.id)!.currentThreadId!;
  h.answers.push(answer("continue", "two"));
  settle(h, current, "done", "ok");
  h.hub.publish({ type: "thread.upsert", thread: h.db.getThread(current)! });
  await new Promise((r) => setTimeout(r, 20));
  await h.runner.idle();
  h.runner.stop();
  check("the next step was dispatched without waiting for the tick", h.dispatched.length === 2);

  console.log("goals: validation");
  check("rejects a missing workspace", !h.runner.create({ title: "t", objective: "o", workspace: join(ws, "no-such-dir-xyz") }).ok);
  check("rejects an empty objective", !h.runner.create({ title: "t", objective: " ", workspace: ws }).ok);
  check("an ended goal cannot be paused", !h.runner.setStatus(h.runner.setStatus(f.id, "abandoned").goal!.id, "paused").ok);
}

async function main(): Promise<void> {
  pure();
  await lifecycle();
  await guards();
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall goal checks passed");
  process.exit(0);
}

void main();
