// Failure text persisted on a dead `agent_runs` row.
// Run: npx tsx src/tests/runError.test.ts

import assert from "node:assert/strict";
import { MAX_RUN_ERROR_LEN, runErrorText } from "../orchestrator/runError.js";
import type { AgentEvent } from "../types.js";

type ResultEvent = Extract<AgentEvent, { type: "result" }>;

const errored = (subtype: string, over: Partial<ResultEvent> = {}): ResultEvent =>
  ({ type: "result", subtype, isError: true, ...over }) as ResultEvent;

// The regression this exists for: the production shape of a turn-ceiling cutoff is an error result with a
// subtype and NO message (num_turns 101 against implementorMaxTurns 100). It used to persist the opaque
// "Run failed.", making a benign auto-resumed cutoff unreadable as anything but a crash in the history.
{
  const text = runErrorText(errored("error_max_turns"));
  assert.match(text, /turn ceiling/i);
  assert.match(text, /error_max_turns/);
  assert.notEqual(text, "Run failed.");
}

// Nothing in the persisted reason may promise a resume: a turn ceiling reaches BOTH the warm-resumed
// implementor and a planner/QA run whose text is lifted into an owner-facing park message.
{
  assert.doesNotMatch(runErrorText(errored("error_max_turns")), /resum/i);
}

// For a KNOWN involuntary cutoff the canned reason beats the SDK's own words, which merely restate the
// subtype ("Reached maximum number of turns (100)") without saying it is expected rather than a crash. That
// also keeps the persisted text STABLE: the sweep's classifier keys on it, so it must not drift with SDK
// phrasing — the first version of this let a cutoff read as a REAL failure in `npm run probe:run-errors`.
{
  const text = runErrorText(errored("error_max_turns", { errors: ["Reached maximum number of turns (100)"] }));
  assert.match(text, /turn ceiling/i);
  assert.match(text, /not a crash/i);
}

// Structured-output exhaustion is the other cutoff the roles can actually hit (planner/researcher/qa/reader
// all run with a json_schema output format).
{
  const text = runErrorText(errored("error_max_structured_output_retries"));
  assert.match(text, /structured-output retries/i);
  assert.notEqual(text, "Run failed.");
}

// `SDKResultError` has no `result` field — its diagnostic is the `errors` array — so a genuine crash must
// persist what the SDK actually reported rather than degrading to the subtype name.
{
  const text = runErrorText(errored("error_during_execution", { errors: ["ENOENT: spawn claude", "exit 1"] }));
  assert.equal(text, "ENOENT: spawn claude; exit 1");
}

// Blank/whitespace entries in that array must not produce a leading/trailing separator or an empty row.
{
  assert.equal(runErrorText(errored("error_during_execution", { errors: ["", "  ", "real problem"] })), "real problem");
  assert.match(runErrorText(errored("error_max_turns", { errors: ["", " "] })), /turn ceiling/i);
}

// The CLI backends (Codex/Grok) build their own results and put the message in `result`, which wins over
// both the SDK array and the canned subtype reason.
{
  const text = runErrorText(errored("error_max_turns", { result: "Could not write server/src/foo.ts: EPERM", errors: ["ignored"] }));
  assert.equal(text, "Could not write server/src/foo.ts: EPERM");
}

// A message-less subtype the SDK adds later still renders its name — a future subtype degrades to
// something diagnosable rather than back to the opaque text.
{
  assert.equal(runErrorText(errored("error_future_thing")), "Run failed (error_future_thing).");
}

// Whitespace-only result text must not persist as a blank error row.
{
  assert.match(runErrorText(errored("error_max_turns", { result: "   \n " })), /turn ceiling/i);
  assert.equal(runErrorText(errored("error_future_thing", { result: "\n" })), "Run failed (error_future_thing).");
}

// Neither a message nor a subtype is the only case left with nothing to say (defensive: the SDK's subtypes
// are four non-empty literals, and both CLI runners always pass a non-empty subtype).
{
  assert.equal(runErrorText(errored("")), "Run failed.");
  assert.equal(runErrorText(errored("  ")), "Run failed.");
}

// The column is capped, so long agent output is truncated rather than rejected by SQLite.
{
  const text = runErrorText(errored("error_during_execution", { result: "x".repeat(MAX_RUN_ERROR_LEN + 500) }));
  assert.equal(text.length, MAX_RUN_ERROR_LEN);
}

// The cap applies to the joined `errors` array too — that path builds its own string.
{
  const text = runErrorText(errored("error_during_execution", { errors: ["y".repeat(MAX_RUN_ERROR_LEN), "z".repeat(50)] }));
  assert.equal(text.length, MAX_RUN_ERROR_LEN);
}

console.log("runError: all assertions passed");
