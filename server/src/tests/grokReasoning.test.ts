// Regression: Grok's streaming-json emits no tool events, so reasoning (`thought`) is the only narrative
// of a long agentic run. The runner must persist each reasoning burst as a durable `thinking` AgentEvent
// (not just an ephemeral thinking_delta) so a Grok transcript isn't ~empty after reload — the "99% of the
// Grok conversation is missing" bug. Run: npx tsx src/tests/grokReasoning.test.ts
//
// This drives the real stream parser + segment state machine via `onStdout` (the same path the child
// process feeds). The public start()/send() path spawns a live `grok` subprocess, which needs an
// unexhausted SuperGrok balance and can't run in CI, so we feed canned CLI JSONL directly instead.

import assert from "node:assert/strict";
import { GrokAgentRun } from "../agents/grokRunner.js";
import type { AgentEvent } from "../types.js";

function collect(run: GrokAgentRun): AgentEvent[] {
  const events: AgentEvent[] = [];
  run.onEvent((e) => events.push(e));
  return events;
}

/** Feed newline-delimited CLI events through the runner's stdout parser. */
function feed(run: GrokAgentRun, lines: string[]): void {
  (run as unknown as { onStdout(chunk: string): void }).onStdout(lines.map((l) => l + "\n").join(""));
}

// --- Interleaved thought/text bursts each commit as a durable `thinking` event ---
{
  const run = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  const events = collect(run);
  feed(run, [
    JSON.stringify({ type: "thought", data: "Let me look at the repo." }),
    JSON.stringify({ type: "thought", data: " Checking package.json." }),
    JSON.stringify({ type: "text", data: "I'll start by " }),
    JSON.stringify({ type: "text", data: "reading the config." }),
    JSON.stringify({ type: "thought", data: "Now editing the file." }),
    JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s1", num_turns: 3 }),
  ]);

  const thinking = events.filter((e): e is Extract<AgentEvent, { type: "thinking" }> => e.type === "thinking");
  assert.deepEqual(
    thinking.map((t) => t.text),
    ["Let me look at the repo. Checking package.json.", "Now editing the file."],
    "each reasoning burst must be committed as one durable thinking event, joined and trimmed",
  );

  // A text chunk arriving after thoughts must close the reasoning burst BEFORE streaming the response,
  // so the durable thinking lands ahead of the text it precedes.
  const firstThinkingIdx = events.findIndex((e) => e.type === "thinking");
  const firstTextDeltaIdx = events.findIndex((e) => e.type === "text_delta");
  assert.ok(firstThinkingIdx >= 0 && firstTextDeltaIdx >= 0, "both a thinking and a text_delta must be emitted");
  assert.ok(firstThinkingIdx < firstTextDeltaIdx, "the first reasoning burst must commit before the first response text");
}

// --- A turn killed mid-thought (no terminal event) still flushes the open reasoning burst ---
{
  const run = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  const events = collect(run);
  feed(run, [
    JSON.stringify({ type: "thought", data: "Half a reasoning burst that never" }),
    JSON.stringify({ type: "thought", data: " got a terminal event." }),
  ]);
  // Simulate the child close path (watchdog kill / crash): flushText commits any open reasoning burst.
  (run as unknown as { flushText(): unknown }).flushText();

  const thinking = events.filter((e) => e.type === "thinking") as Array<{ type: "thinking"; text: string }>;
  assert.equal(thinking.length, 1, "an open reasoning burst must be flushed on turn close");
  assert.equal(thinking[0]!.text, "Half a reasoning burst that never got a terminal event.");
}

// --- Empty / whitespace-only reasoning never emits a durable message ---
{
  const run = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  const events = collect(run);
  feed(run, [
    JSON.stringify({ type: "thought", data: "   " }),
    JSON.stringify({ type: "text", data: "Just a plain answer, no real reasoning." }),
    JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s2", num_turns: 1 }),
  ]);
  assert.equal(events.filter((e) => e.type === "thinking").length, 0, "whitespace-only reasoning must not persist");
}

// --- A 402 "balance exhausted" is a provider cap (fail over), not a plain error (park for review) ---
{
  const cap = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  collect(cap);
  feed(cap, [
    JSON.stringify({
      type: "error",
      message: 'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}',
    }),
  ]);
  assert.equal(cap.capped, true, "a 402 'balance exhausted' must mark the run capped so it fails over to another backend");

  // Regression: the pre-existing 429 / quota wording still caps.
  const cap429 = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  collect(cap429);
  feed(cap429, [JSON.stringify({ type: "error", message: "429 Too Many Requests: rate limit reached" })]);
  assert.equal(cap429.capped, true, "a 429 rate-limit error must still cap");

  // A benign failure must NOT be misread as a cap (else it would silently fail over instead of surfacing).
  const err = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  collect(err);
  feed(err, [JSON.stringify({ type: "error", message: "TypeError: cannot read property 'x' of undefined" })]);
  assert.equal(err.capped, false, "an ordinary error must not be misclassified as a usage cap");
}

console.log("All Grok reasoning-persistence + cap-detection checks passed.");
