// Regression: Opus 5.5 writes its progress narration ("I found two manual deploy scripts… I'll verify which
// host is currently serving gnomerang.com") inside THINKING blocks. The Claude runner only ever streamed
// those as ephemeral thinking_delta, so the line lived as a live draft, vanished on reload, and never
// reached the feed as a row. Codex reasoning summaries had the same gap. Each runner must commit a
// non-empty reasoning block as a durable `thinking` event, which ThreadManager persists as a message.
// Run: npx tsx src/tests/narrationPersist.test.ts

import assert from "node:assert/strict";
import { AgentRun } from "../agents/runner.js";
import { CodexAgentRun } from "../agents/codexRunner.js";
import type { AgentEvent } from "../types.js";

const NARRATION =
  "I found two manual deploy scripts in the repo. Before writing the workflow, I'll verify which host is currently serving gnomerang.com.\n";

function collect(run: { onEvent(cb: (e: AgentEvent) => void): unknown }): AgentEvent[] {
  const events: AgentEvent[] = [];
  run.onEvent((e) => events.push(e));
  return events;
}
const thinkingOf = (events: AgentEvent[]): string[] =>
  events.flatMap((e) => (e.type === "thinking" ? [e.text] : []));

// --- Claude: each non-empty thinking block commits durably, in block order, verbatim ---
{
  const run = new AgentRun({ model: "claude-opus-5-5", cwd: process.cwd() });
  const events = collect(run);
  const handle = (m: unknown) => (run as unknown as { handle(m: unknown): void }).handle(m);
  handle({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: NARRATION } } });
  handle({ type: "assistant", message: { content: [{ type: "thinking", thinking: NARRATION, signature: "sig" }] } });
  handle({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "sig-only" }] } });
  handle({ type: "assistant", message: { content: [{ type: "thinking", thinking: "  \n", signature: "sig" }] } });
  handle({ type: "assistant", message: { content: [{ type: "redacted_thinking", data: "opaque" }] } });
  handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "dig gnomerang.com" } }] } });
  handle({ type: "assistant", message: { content: [{ type: "thinking", thinking: "The A record points at the Hetzner box.", signature: "s" }, { type: "text", text: "Deploying." }] } });

  assert.deepEqual(
    thinkingOf(events),
    [NARRATION, "The A record points at the Hetzner box."],
    "every non-empty thinking block commits as a durable thinking event; signature-only and blank blocks do not",
  );
  assert.equal(
    thinkingOf(events)[0],
    events.filter((e): e is Extract<AgentEvent, { type: "thinking_delta" }> => e.type === "thinking_delta").map((e) => e.text).join(""),
    "the committed text equals the streamed deltas it replaces, so co-work's delta→commit dedupe stays exact",
  );
  const order = events.map((e) => e.type).filter((t) => t !== "thinking_delta");
  assert.deepEqual(order, ["thinking", "tool_use", "thinking", "text"], "reasoning commits in stream order around tools and text");
}

// --- Codex: a completed reasoning summary commits durably; an empty one does not ---
{
  const codex = new CodexAgentRun({ model: "gpt-6-sol", effort: "low", cwd: process.cwd(), apiKey: "test-key" });
  const events = collect(codex);
  const handleEvent = (e: unknown) => (codex as unknown as { handleEvent(event: unknown): void }).handleEvent(e);
  handleEvent({ type: "item.started", item: { id: "r0", type: "reasoning", text: "" } });
  handleEvent({ type: "item.completed", item: { id: "r0", type: "reasoning", text: "**Checking DNS** before editing the workflow." } });
  handleEvent({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "   " } });
  assert.deepEqual(thinkingOf(events), ["**Checking DNS** before editing the workflow."]);
  assert.equal(events.filter((e) => e.type === "thinking_delta").length, 0, "no live-only draft is left pinned without a commit");
}

console.log("All narration-persistence checks passed.");
