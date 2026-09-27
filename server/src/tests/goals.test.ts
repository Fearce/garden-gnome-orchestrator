// Deterministic gate for goal-directed tasks (orchestrator/goals.ts). No live accounts, no network, no
// real agents: a temp DB, real thread rows, and a fake host whose director answers from a script.
// Run: `npm run test:goals`.
//
// What it pins: the two-voice ending (agent claim AND director verdict), the verification step when only
// the director thinks it is done, the step-in-flight gate, the backoff when no director answers, the three
// runaway guards (cancel, failed streak, step budget), orphan adoption after a crash, the owner pausing
// mid-judgement, the hub wake-up when a step task settles, the weekly burn-rate hold, and parallel steps
// (slots, the director's `wait`, and reports of several steps that ended together).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import {
  GOAL_BURN_GRACE_PCT,
  GoalRunner,
  burnBudgetPct,
  checkBurnRate,
  detectGoalComplete,
  goalJudgeSchema,
  poolOverPace,
  goalStepPin,
  parseGoalJudgement,
  resolveStepPin,
  stepTitle,
  type GoalHost,
  type GoalJudgement,
} from "../orchestrator/goals.js";
import type { DispatchInput } from "../orchestrator/api.js";
import type { ModelCandidate } from "../orchestrator/modelSelector.js";
import type { Goal, ThreadState } from "../types.js";

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

  console.log("goals: the owner's model and effort");
  const auto = { effort: null, provider: null, model: null } satisfies Pick<Goal, "effort" | "provider" | "model">;
  const pick = (over: Partial<GoalJudgement["next"]> = {}) => parseGoalJudgement(answer("continue", "x", over))!.next;
  check("an unset effort caps the director's high pick at medium", goalStepPin(auto, pick({ effort: "high" }), ROSTER).effort === "medium");
  check("an unset effort keeps the director's low pick", goalStepPin(auto, pick({ effort: "low" }), ROSTER).effort === "low");
  check("an unset effort is noted when capped", /medium/.test(goalStepPin(auto, pick({ effort: "max" }), ROSTER).note ?? ""));
  check("the owner's effort overrides the director's", goalStepPin({ ...auto, effort: "high" }, pick({ effort: "low" }), ROSTER).effort === "high");
  const pinnedModel = goalStepPin({ effort: null, provider: "codex", model: "gpt-5.6" }, pick({ effort: "low" }), ROSTER);
  check("the owner's model overrides the director's", pinnedModel.provider === "codex" && pinnedModel.model === "gpt-5.6" && pinnedModel.effort === "low");
  const clamped = goalStepPin({ effort: "max", provider: "codex", model: "gpt-5.6" }, pick(), ROSTER);
  check("the owner's effort drops to what the pinned model offers", clamped.effort === "high" && !!clamped.note);
  const offRoster = goalStepPin({ effort: "medium", provider: "grok", model: "grok-5" }, pick(), ROSTER);
  check("a pinned model with no capacity stays pinned (the task waits)", offRoster.provider === "grok" && offRoster.model === "grok-5" && offRoster.effort === "medium");

  const enumOf = (schema: ReturnType<typeof goalJudgeSchema>, field: "effort" | "model") => {
    const next = (schema.properties as { next: { properties: Record<string, { enum?: string[] }> } }).next;
    return (next.properties[field]?.enum ?? []).join(",");
  };
  const effortsOf = (schema: ReturnType<typeof goalJudgeSchema>) => enumOf(schema, "effort");
  const modelsOf = (schema: ReturnType<typeof goalJudgeSchema>) => enumOf(schema, "model");
  check("the director may only pick low or medium by default", effortsOf(goalJudgeSchema(auto, ROSTER)) === "low,medium");
  check("an owner effort is the only effort offered", effortsOf(goalJudgeSchema({ ...auto, effort: "high" }, ROSTER)) === "high");
  check("an owner model is the only model offered", modelsOf(goalJudgeSchema({ effort: null, provider: "codex", model: "gpt-5.6" }, ROSTER)) === "gpt-5.6");
  const verdictsOf = (schema: ReturnType<typeof goalJudgeSchema>) => ((schema.properties as { verdict: { enum: string[] } }).verdict.enum ?? []).join(",");
  check("wait is not offered with nothing running", verdictsOf(goalJudgeSchema(auto, ROSTER)) === "complete,continue");
  check("wait is offered while steps run", verdictsOf(goalJudgeSchema(auto, ROSTER, 2)) === "complete,continue,wait");
}

const DAY = 24 * 60 * 60_000;
/** A roster candidate whose pool has used `usedPct` of a weekly window that resets in `resetInDays`. */
function paced(base: ModelCandidate, usedPct: number, now: number, resetInDays = 3.5): ModelCandidate {
  return { ...base, weekly: { usedPct, resetAt: now + resetInDays * DAY } };
}

function burnRate(): void {
  const now = Date.now();
  console.log("goals: burn-rate pace");
  check("half-way through the week, 100% allows half the window plus the grace", Math.abs(burnBudgetPct(now + 3.5 * DAY, 100, now) - (50 + GOAL_BURN_GRACE_PCT)) < 1e-9);
  check("50% allows half of that pace", Math.abs(burnBudgetPct(now + 3.5 * DAY, 50, now) - (25 + GOAL_BURN_GRACE_PCT)) < 1e-9);
  check("the allowance never passes 100%", burnBudgetPct(now + DAY, 500, now) === 100);
  const over = poolOverPace(paced(ROSTER[0]!, 60, now), 100, now);
  check("60% used half-way through is ahead of a 100% pace", over?.pool === "Claude" && Math.round(over.budgetPct) === 55);
  check("it clears when the pace line reaches 60%", over != null && Math.abs(over.clearsAt - (now + 0.05 * 7 * DAY)) < 1_000);
  check("a 200% burn rate lets the same pool run", poolOverPace(paced(ROSTER[0]!, 60, now), 200, now) === null);
  check("a pool with no weekly reading is never held", poolOverPace(ROSTER[0]!, 100, now) === null);
  check("a window that already reset is never held", poolOverPace({ ...ROSTER[0]!, weekly: { usedPct: 99, resetAt: now - 1 } }, 100, now) === null);
  const nearReset = poolOverPace(paced(ROSTER[0]!, 99, now, 0.1), 50, now);
  check("a pool that cannot catch up clears at its reset", nearReset?.clearsAt === now + 0.1 * DAY);

  console.log("goals: burn-rate conservation");
  const auto = { effort: null, provider: null, model: null, burnConservation: true, burnRatePct: 100 };
  const claudeOver = [paced(ROSTER[0]!, 70, now), paced(ROSTER[1]!, 20, now)];
  const oneOver = checkBurnRate(auto, claudeOver, now);
  check("a pool over its pace leaves the roster", oneOver.roster.map((c) => c.provider).join(",") === "codex" && oneOver.over.length === 1);
  check("one pool with room keeps the goal going", oneOver.hold === null);
  const allOver = checkBurnRate(auto, [paced(ROSTER[0]!, 70, now), paced(ROSTER[1]!, 80, now)], now);
  check("every pool over its pace holds the goal", /Paused for burn rate/.test(allOver.hold?.reason ?? "") && allOver.roster.length === 0);
  check("the hold re-checks within 30 minutes", allOver.hold != null && allOver.hold.until <= now + 30 * 60_000);
  check("conservation off passes everything through", checkBurnRate({ ...auto, burnConservation: false }, claudeOver, now).hold === null);
  const pinnedOver = checkBurnRate({ ...auto, provider: "claude", model: "claude-opus-5-5" }, claudeOver, now);
  check("a goal pinned to an over-pace pool holds even when another pool has room", pinnedOver.hold !== null);
  check("a goal pinned to a pool within pace runs", checkBurnRate({ ...auto, provider: "codex", model: "gpt-5.6" }, claudeOver, now).hold === null);
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
  roster: ModelCandidate[];
  schemas: unknown[];
  onJudge?: () => void;
}

function harness(): Harness {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "goals-test-")), "t.sqlite"));
  const hub = new EventHub();
  const h = { db, hub, dispatched: [], answers: [], judged: [], schemas: [], notices: [], clock: { t: Date.now() }, roster: ROSTER } as unknown as Harness;
  const host: GoalHost = {
    dispatch: async (input) => {
      h.dispatched.push(input);
      const t = db.createThread({ title: input.title, workspace: input.workspace, rawPrompt: "", brief: input.brief });
      db.updateThread(t.id, { state: "implementing" });
      return t.id;
    },
    judge: async (prompt, schema) => {
      h.judged.push(prompt);
      h.schemas.push(schema);
      h.onJudge?.();
      const next = h.answers.shift();
      return next === undefined || next === null ? null : { output: next, model: "claude-opus-5-5", provider: "claude" };
    },
    roster: () => h.roster,
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
  check("the step is pinned to the director's model", first.requestedProvider === "claude" && first.requestedModel === "claude-opus-5-5");
  check("a goal with no effort set runs at medium even when the director asks for high", first.effort === "medium");
  check("the judge prompt says the effort is capped", h.judged[0]!.includes("low or medium"));
  check("the brief carries the objective and the status-line rule", first.brief.includes("Parser, docs and tests all done.") && first.brief.includes("GOAL STATUS: COMPLETE"));
  check("the judge prompt asks for the whole remaining objective per step", h.judged[0]!.includes("ALL the remaining work") && !h.judged[0]!.includes("not the whole objective at once"));
  check("the brief tells the agent to keep going past its step", first.brief.includes("keep going into the rest of the objective") && !first.brief.includes("do not stretch this step"));
  check("a goal step is dispatched without QA", first.skipQa === true);
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
  const step = h.db.createGoalStep({ goalId: e.id, title: "lost link", provider: null, model: null, effort: null, rationale: "", brief: "b" });
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

  console.log("goals: owner-chosen model and effort");
  h.answers.push(answer("continue", "pinned step", { provider: "claude", model: "claude-opus-5-5", effort: "low" }));
  const p = h.runner.create({ title: "Pinned", objective: "o", workspace: ws, effort: "high", provider: "codex", model: "gpt-5.6" });
  check("create stores the owner's pick", p.ok && p.goal?.effort === "high" && p.goal.provider === "codex" && p.goal.model === "gpt-5.6");
  await h.runner.idle();
  const pinned = h.dispatched.at(-1)!;
  check("every step runs on the owner's model and effort", pinned.requestedProvider === "codex" && pinned.requestedModel === "gpt-5.6" && pinned.effort === "high");
  check("the judge prompt names the owner's pin", h.judged.at(-1)!.includes("gpt-5.6") && h.judged.at(-1)!.includes("high"));
  const cleared = h.runner.update(p.goal!.id, { effort: null, provider: null, model: null });
  check("edit clears the pin back to automatic", cleared.ok && cleared.goal?.effort === null && cleared.goal.model === null && cleared.goal.provider === null);
  const repinned = h.runner.update(p.goal!.id, { effort: "low", provider: "claude", model: "claude-opus-5-5" });
  check("edit sets a new pin", repinned.goal?.effort === "low" && repinned.goal.model === "claude-opus-5-5");
  console.log("goals: validation");
  check("rejects a model without its provider", !h.runner.create({ title: "t", objective: "o", workspace: ws, model: "gpt-5.6" }).ok);
  check("rejects an unknown effort", !h.runner.update(p.goal!.id, { effort: "turbo" as never }).ok);
  check("rejects a missing workspace", !h.runner.create({ title: "t", objective: "o", workspace: join(ws, "no-such-dir-xyz") }).ok);
  check("rejects an empty objective", !h.runner.create({ title: "t", objective: " ", workspace: ws }).ok);
  check("an ended goal cannot be paused", !h.runner.setStatus(h.runner.setStatus(f.id, "abandoned").goal!.id, "paused").ok);
}

async function burnHoldLoop(): Promise<void> {
  const ws = process.cwd();
  console.log("goals: the runner holds for burn rate");
  let h = harness();
  h.roster = [paced(ROSTER[0]!, 70, h.clock.t), paced(ROSTER[1]!, 80, h.clock.t)];
  const a = h.runner.create({ title: "Burning", objective: "o", workspace: ws }).goal!;
  check("burn-rate conservation defaults on at 100%", a.burnConservation === true && a.burnRatePct === 100);
  await h.runner.idle();
  let goal = h.db.getGoal(a.id)!;
  check("every pool over pace: no director call, no step", h.judged.length === 0 && h.dispatched.length === 0);
  check("the hold is shown on the goal and timed", goal.status === "active" && /Paused for burn rate/.test(goal.statusReason ?? "") && (goal.nextCheckAt ?? 0) > h.clock.t);
  await h.runner.evaluate(a.id);
  check("no judgement before the hold's re-check", h.judged.length === 0);

  h.roster = [paced(ROSTER[0]!, 70, h.clock.t), paced(ROSTER[1]!, 20, h.clock.t)];
  h.clock.t = goal.nextCheckAt! + 1;
  h.answers.push(answer("continue", "on codex", { provider: "claude", model: "claude-opus-5-5", effort: "medium" }));
  await h.runner.evaluate(a.id);
  goal = h.db.getGoal(a.id)!;
  check("a pool back within pace lets the goal run", h.dispatched.length === 1 && goal.statusReason === null);
  check("the director is told which pool was left out", h.judged[0]!.includes("Left out for spending faster") && !h.judged[0]!.includes('model "claude-opus-5-5"'));
  const providers = (h.schemas[0] as { properties: { next: { properties: { provider: { enum: string[] } } } } }).properties.next.properties.provider.enum;
  check("the over-pace backend is not on offer", providers.join(",") === "codex");
  const d = h.dispatched[0]!;
  check("a pick on the over-pace pool is moved to a pool within pace, not auto-routed", d.requestedProvider === "codex" && d.requestedModel === "gpt-5.6");

  console.log("goals: burn-rate conservation off, and switching it off mid-hold");
  h = harness();
  h.roster = [paced(ROSTER[0]!, 70, h.clock.t), paced(ROSTER[1]!, 80, h.clock.t)];
  h.answers.push(answer("continue", "anyway"));
  h.runner.create({ title: "Unguarded", objective: "o", workspace: ws, burnConservation: false });
  await h.runner.idle();
  check("with conservation off the goal runs over pace", h.dispatched.length === 1);
  const held = h.runner.create({ title: "Held", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  check("the guarded goal holds", h.dispatched.length === 1 && /burn rate/.test(h.db.getGoal(held.id)!.statusReason ?? ""));
  h.answers.push(answer("continue", "released"));
  h.runner.update(held.id, { burnConservation: false });
  await h.runner.idle();
  check("switching conservation off dispatches at once", h.dispatched.length === 2 && h.db.getGoal(held.id)!.burnConservation === false);
  const raised = h.runner.update(held.id, { burnRatePct: 9999 });
  check("the burn rate is clamped", raised.goal?.burnRatePct === 500);
}

async function parallel(): Promise<void> {
  const ws = process.cwd();
  console.log("goals: parallel steps fill every slot");
  let h = harness();
  h.answers.push(answer("continue", "api"), answer("continue", "ui"), answer("continue", "docs"));
  const g = h.runner.create({ title: "Wide", objective: "o", workspace: ws, maxConcurrent: 3 }).goal!;
  check("max concurrent is stored", g.maxConcurrent === 3);
  await h.runner.idle();
  check("three slots, three steps", h.dispatched.length === 3 && h.judged.length === 3);
  check("the second judgement sees the running step", h.judged[1]!.includes('STEPS STILL RUNNING (1 of up to 3 at once)') && h.judged[1]!.includes("Do api."));
  check("a parallel goal asks for work beside the running steps", h.judged[1]!.includes("IN PARALLEL"));
  check("the step brief names its siblings", h.dispatched[2]!.brief.includes('step 1 "api"') && h.dispatched[2]!.brief.includes('step 2 "ui"'));
  check("a parallel step stays in its lane", !h.dispatched[2]!.brief.includes("keep going into the rest of the objective"));
  await h.runner.evaluate(g.id);
  check("full slots: no judgement", h.judged.length === 3);

  console.log("goals: several steps end together");
  const ids = h.db.listOpenGoalSteps(g.id).map((s) => s.threadId!);
  h.answers.push(answer("continue", "tests"), answer("continue", "bench"));
  settle(h, ids[0]!, "done", "API report.");
  settle(h, ids[1]!, "done", "UI report.");
  await h.runner.evaluate(g.id);
  check("both endings are reported once", h.judged[3]!.includes("2 STEPS ENDED") && h.judged[3]!.includes("API report.") && h.judged[3]!.includes("UI report."));
  await h.runner.idle();
  check("the two free slots are filled", h.dispatched.length === 5);
  check("a step already reported is not reported again", !h.judged[4]!.includes("API report."));

  console.log("goals: the director waits for running steps");
  h = harness();
  h.answers.push(answer("continue", "first"), { ...answer("continue", "ignored"), verdict: "wait" });
  const w = h.runner.create({ title: "Waiting", objective: "o", workspace: ws, maxConcurrent: 2 }).goal!;
  await h.runner.idle();
  let goal = h.db.getGoal(w.id)!;
  check("wait dispatches nothing", h.dispatched.length === 1 && goal.lastVerdict?.verdict === "wait" && /Holding the next step/.test(goal.statusReason ?? ""));
  await h.runner.evaluate(w.id);
  check("the hold spends no director call on the next tick", h.judged.length === 2);
  h.answers.push(answer("complete", "unused"));
  settle(h, goal.currentThreadId!, "done", "First done.\nGOAL STATUS: COMPLETE");
  await h.runner.evaluate(w.id);
  goal = h.db.getGoal(w.id)!;
  check("a step ending lifts the hold, and both voices end the goal", h.judged.length === 3 && goal.status === "achieved");

  console.log("goals: complete is held while a step still runs");
  h = harness();
  h.answers.push(answer("continue", "a"), answer("continue", "b"));
  const c = h.runner.create({ title: "Early", objective: "o", workspace: ws, maxConcurrent: 2 }).goal!;
  await h.runner.idle();
  const [ta] = h.db.listOpenGoalSteps(c.id).map((s) => s.threadId!);
  h.answers.push(answer("complete", "unused"));
  settle(h, ta!, "done", "A done.\nGOAL STATUS: COMPLETE");
  await h.runner.evaluate(c.id);
  goal = h.db.getGoal(c.id)!;
  check("complete with a step running neither ends the goal nor dispatches", goal.status === "active" && h.dispatched.length === 2 && goal.lastVerdict?.verdict === "wait" && /Looks complete/.test(goal.lastVerdict.reason));

  console.log("goals: raising max concurrent fills the new slot at once");
  h = harness();
  h.answers.push(answer("continue", "solo"));
  const r = h.runner.create({ title: "Grow", objective: "o", workspace: ws }).goal!;
  await h.runner.idle();
  check("one slot, one step", h.dispatched.length === 1);
  h.answers.push(answer("continue", "second"));
  h.runner.update(r.id, { maxConcurrent: 2 });
  await h.runner.idle();
  check("the new slot is filled without waiting for the step to end", h.dispatched.length === 2);

  console.log("goals: the step budget waits for running steps");
  h = harness();
  h.answers.push(answer("continue", "x"), answer("continue", "y"));
  const b = h.runner.create({ title: "Budget2", objective: "o", workspace: ws, maxSteps: 2, maxConcurrent: 2 }).goal!;
  await h.runner.idle();
  const [bx, by] = h.db.listOpenGoalSteps(b.id).map((s) => s.threadId!);
  settle(h, bx!, "done", "x done");
  await h.runner.evaluate(b.id);
  check("budget reached with a step running: not paused yet", h.db.getGoal(b.id)!.status === "active" && h.judged.length === 2);
  settle(h, by!, "done", "y done");
  await h.runner.evaluate(b.id);
  check("once every step ended, the budget pauses", h.db.getGoal(b.id)!.status === "paused");
}

async function main(): Promise<void> {
  pure();
  burnRate();
  await lifecycle();
  await guards();
  await burnHoldLoop();
  await parallel();
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall goal checks passed");
  process.exit(0);
}

void main();
