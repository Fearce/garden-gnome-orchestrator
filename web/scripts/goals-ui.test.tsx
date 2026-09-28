/**
 * Gate: the Goals console surface (run with the server half: `npm run test:goals --prefix server`).
 *
 *   · the `goals` broadcast is the store's source of truth, and a goal write costs one small command;
 *   · Pause/Resume/End project in the same click, a dropped write says so instead of projecting;
 *   · the view renders what the owner needs to act: status and why, the director's progress, the
 *     current step with its model and effort, the agent's claim, and the right lifecycle buttons;
 *   · a task that is a goal step is found by its thread id (the board card's badge).
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Goal } from "../src/types.js";
import "./ssrCssStub.mjs";

Object.assign(globalThis, { React });
Object.defineProperty(globalThis, "document", { value: { baseURI: "http://localhost/", addEventListener: () => {} }, configurable: true });
Object.defineProperty(globalThis, "location", { value: { protocol: "http:", host: "localhost", search: "", pathname: "/" }, configurable: true });

type SentFrame = { type: string; [key: string]: unknown };
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: SentFrame[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentFrame);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}
Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

const { connect, useStore } = await import("../src/store.js");
const { Goals, goalStepOf } = await import("../src/components/Goals.js");
connect();
const socket = FakeWebSocket.instances[0]!;
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
socket.sent.length = 0;

const goal: Goal = {
  id: "goal-1",
  title: "Offline support",
  objective: "The app works fully offline, with sync on reconnect.",
  workspace: "C:\\repo",
  status: "active",
  statusReason: null,
  progress: "Cache layer done; sync queue remains.",
  lastVerdict: { verdict: "continue", reason: "Sync is missing.", agentClaimedComplete: true, at: Date.now() - 60_000 },
  effort: null,
  provider: null,
  model: null,
  maxConcurrent: 1,
  burnConservation: true,
  burnRatePct: 100,
  currentThreadId: "thread-2",
  nextCheckAt: null,
  stepCount: 2,
  steps: [
    { id: "s1", goalId: "goal-1", seq: 1, threadId: "thread-1", title: "Cache layer", provider: "claude", model: "claude-opus-5-5", effort: "high", rationale: "Architectural.", outcome: "done", agentClaimedComplete: true, createdAt: 1, settledAt: 2 },
    { id: "s2", goalId: "goal-1", seq: 2, threadId: "thread-2", title: "Sync queue", provider: "codex", model: "gpt-5.6", effort: "medium", rationale: "Mechanical follow-up.", outcome: null, agentClaimedComplete: null, createdAt: 3, settledAt: null },
  ],
  createdAt: 1,
  updatedAt: 3,
  endedAt: null,
};

// --- the store ---
socket.onmessage?.({ data: JSON.stringify({ type: "goals", goals: [goal] }) });
assert.deepEqual(useStore.getState().goals, [goal], "the goals broadcast replaces the store list");

assert.equal(useStore.getState().createGoal({ title: "t", objective: "o", workspace: "C:\\repo" }), true);
assert.deepEqual(socket.sent.map((f) => f.type), ["goal.create"], "a create costs one small command, never a snapshot");

socket.sent.length = 0;
assert.equal(useStore.getState().createGoal({ title: "t", objective: "o", workspace: "C:\\repo", effort: "high", provider: "codex", model: "gpt-5.6" }), true);
assert.deepEqual(
  { effort: socket.sent[0]?.effort, provider: socket.sent[0]?.provider, model: socket.sent[0]?.model },
  { effort: "high", provider: "codex", model: "gpt-5.6" },
  "the owner's effort and model ride on the create",
);

socket.sent.length = 0;
assert.equal(useStore.getState().createGoal({ title: "t", objective: "o", workspace: "C:\\repo", maxConcurrent: 3, burnConservation: false, burnRatePct: 150 }), true);
assert.deepEqual(
  { maxConcurrent: socket.sent[0]?.maxConcurrent, burnConservation: socket.sent[0]?.burnConservation, burnRatePct: socket.sent[0]?.burnRatePct },
  { maxConcurrent: 3, burnConservation: false, burnRatePct: 150 },
  "parallel steps and the burn-rate guard ride on the create",
);

socket.sent.length = 0;
assert.equal(useStore.getState().updateGoal("goal-1", { effort: null, provider: null, model: null }), true);
assert.deepEqual(
  socket.sent,
  [{ type: "goal.update", id: "goal-1", patch: { effort: null, provider: null, model: null } }],
  "an edit can hand the pick back to the director",
);

socket.sent.length = 0;
assert.equal(useStore.getState().setGoalStatus("goal-1", "paused"), true);
assert.deepEqual(socket.sent, [{ type: "goal.status", id: "goal-1", status: "paused" }]);
assert.equal(useStore.getState().goals[0]?.status, "paused", "Pause projects in the same click");

socket.sent.length = 0;
assert.equal(useStore.getState().updateGoal("goal-1", { maxConcurrent: 3 }), true);
assert.deepEqual(socket.sent, [{ type: "goal.update", id: "goal-1", patch: { maxConcurrent: 3 } }]);

socket.readyState = FakeWebSocket.CLOSED;
socket.sent.length = 0;
useStore.setState({ notice: null });
assert.equal(useStore.getState().setGoalStatus("goal-1", "active"), false);
assert.equal(useStore.getState().goals[0]?.status, "paused", "a dropped write projects nothing");
assert.equal(useStore.getState().notice?.title, "Goal not changed");
socket.readyState = FakeWebSocket.OPEN;

// --- the board badge lookup ---
assert.equal(goalStepOf([goal], "thread-2")?.step.seq, 2);
assert.equal(goalStepOf([goal], "thread-2")?.goal.title, "Offline support");
assert.equal(goalStepOf([goal], "unrelated"), null, "an ordinary task is not a goal step");

// --- the view (SSR reads the store's initial state, so seed that) ---
const render = (goals: Goal[]): string => {
  Object.assign(useStore.getInitialState(), { goals });
  return renderToStaticMarkup(React.createElement(Goals));
};

const active = render([goal]);
assert.match(active, /Offline support/);
assert.match(active, /Cache layer done; sync queue remains\./, "the director's progress is shown");
assert.match(active, />2 steps</, "the step count carries no budget");
assert.doesNotMatch(active, /budget/i, "a goal has no step budget");
assert.match(active, /Director: continue/);
assert.match(active, /Current step/);
assert.match(active, /Sync queue/);
assert.match(active, /Mechanical follow-up\./, "the director's reason for the pick is shown");
assert.match(active, /effort-badge eff-medium/, "the step's effort is shown");
assert.match(active, /Director&#x27;s model/, "an unpinned goal says the director picks the model");
assert.match(active, /low–medium/, "an unpinned goal shows its low-or-medium effort default");
assert.match(active, />Pause</);
assert.doesNotMatch(active, />Resume</);
assert.match(active, /1 at a time/, "a sequential goal says so");
assert.match(active, /burn ≤ 100%/, "the burn-rate guard is on by default and shows its rate");

const wide = render([
  {
    ...goal,
    maxConcurrent: 3,
    burnConservation: false,
    lastVerdict: { verdict: "wait", reason: "Docs depend on the API.", agentClaimedComplete: false, at: Date.now() - 1_000, settledSteps: 1 },
    steps: [
      ...goal.steps,
      { id: "s3", goalId: "goal-1", seq: 3, threadId: "thread-3", title: "Conflict UI", provider: "claude", model: "claude-opus-5-5", effort: "low", rationale: "Independent of sync.", outcome: null, agentClaimedComplete: null, createdAt: 4, settledAt: null },
    ],
  },
]);
assert.match(wide, /3 at once/, "the parallel slot count is on the card");
assert.match(wide, /Running · 2 of 3/, "every running step is listed with the slot use");
assert.match(wide, /Sync queue/);
assert.match(wide, /Conflict UI/);
assert.match(wide, /burn guard off/, "a goal without the guard says so");
assert.match(wide, /Director: waiting on running steps/, "a wait verdict reads as waiting");

const holding = render([{ ...goal, statusReason: "Paused for burn rate: Claude has used 70% of its weekly window, 55% allowed by now at 100% pace." }]);
assert.match(holding, /Paused for burn rate/, "a burn-rate hold says why on the card");

const paused = render([{ ...goal, status: "paused", statusReason: "The last 3 steps failed. Check the latest step's task, then resume the goal." }]);
assert.match(paused, />Resume</);
assert.match(paused, /The last 3 steps failed/, "why a goal paused is on the card");

const achieved = render([{ ...goal, status: "achieved", statusReason: "Everything verified.", endedAt: 4 }]);
assert.match(achieved, />Achieved</);
assert.match(achieved, />Reopen</);
assert.doesNotMatch(achieved, /Mark achieved/, "an ended goal offers no lifecycle it cannot take");
assert.doesNotMatch(achieved, /Current step/);

const pinned = render([{ ...goal, effort: "high", provider: "codex", model: "gpt-5.6" }]);
assert.match(pinned, /effort-badge eff-high[^>]*>high</, "the owner's effort is on the card");
assert.doesNotMatch(pinned, /low–medium/);
assert.doesNotMatch(pinned, /Director&#x27;s model/, "a pinned goal shows its model, not the director's");

const empty = render([]);
assert.match(empty, /No goals/);

console.log("Goals UI gate passed - store wiring, click projection, badge lookup and the rendered card.");
process.exit(0);
