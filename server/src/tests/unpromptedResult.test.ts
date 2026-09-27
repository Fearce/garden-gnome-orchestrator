/**
 * Unit gate — a result for a turn the CLI opened on its own is never a run's outcome.
 *
 * Resuming a session whose previous process left a background task behind (a `run_in_background` Bash, a
 * background sub-agent) makes the CLI report that task first: it opens a housekeeping turn, reaches no
 * model, and closes it with `subtype: "success"`, `num_turns: 0`, an empty `result` and
 * `origin: {kind: "task-notification"}` — BEFORE it reads the prompt we resumed with. Verified against the
 * real CLI 2.1.280 on 2026-09-27. Read as the answer to our prompt, it ended the run 0.5s into its real turn
 * ("[Request interrupted by user]") and the self-improvement round filed it as a silent failure.
 *
 * Run: npm run test:unprompted-result   (from server/)
 */
import { AgentRun } from "../agents/runner.js";
import type { AgentEvent } from "../types.js";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// The exact housekeeping result the CLI emitted in the reproduction, minus telemetry noise.
const NOTIFICATION_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  num_turns: 0,
  duration_api_ms: 0,
  stop_reason: null,
  total_cost_usd: 0.0128331,
  origin: { kind: "task-notification" },
  queued_turn_count: 0,
  result_index: 0,
};

// The prompt's own turn: it echoes the uuid of the message it consumed and carries a terminal_reason.
function promptResult(uuid: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "BANANA",
    num_turns: 1,
    terminal_reason: "completed",
    total_cost_usd: 0.0154612,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
    result_index: 1,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function freshRun(): { agent: any; results: AgentEvent[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = new AgentRun({ model: "claude-haiku-4-5-20251001", cwd: process.cwd() }) as any;
  const results: AgentEvent[] = [];
  agent.onEvent((e: AgentEvent) => {
    if (e.type === "result") results.push(e);
  });
  return { agent, results };
}

async function main(): Promise<void> {
  console.log("\nA housekeeping result before the prompt's turn\n");
  {
    const { agent, results } = freshRun();
    const awaited = agent.result();
    agent.handle(NOTIFICATION_RESULT);
    check("it is not cached as the run's last result", agent.lastResult === undefined, JSON.stringify(agent.lastResult));
    check("it is not emitted as a result event", results.length === 0, `emitted ${results.length}`);
    agent.handle(promptResult("prompt-1"));
    const res = await awaited;
    check("result() resolves with the prompt's own turn", res?.result === "BANANA" && res?.numTurns === 1, JSON.stringify(res));
    check("the prompt's turn is the cached outcome", agent.lastResult?.result === "BANANA");
  }

  console.log("\nThe discriminator is narrow: every real outcome still counts\n");
  {
    // A turn that consumed one of our messages is ours, whatever origin the CLI stamps on it.
    const { agent, results } = freshRun();
    agent.handle({ ...NOTIFICATION_RESULT, user_message_uuids: ["ours"] });
    check("a notification turn that consumed our message is an outcome", results.length === 1 && agent.lastResult !== undefined);
  }
  {
    // The model was reached: this is real work, not bookkeeping.
    const { agent, results } = freshRun();
    agent.handle({ ...NOTIFICATION_RESULT, num_turns: 2, result: "reacted to the finished build" });
    check("a notification turn that reached the model is an outcome", results.length === 1 && agent.lastResult?.numTurns === 2);
  }
  {
    // The 07-27 silent resume: 0 turns, no origin. It must keep surfacing so `ranSilently` can catch it.
    const { agent, results } = freshRun();
    agent.handle({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, total_cost_usd: 0 });
    check("a 0-turn result with no origin still surfaces", results.length === 1 && agent.lastResult?.numTurns === 0);
  }
  {
    const { agent, results } = freshRun();
    agent.handle({ ...NOTIFICATION_RESULT, subtype: "error_during_execution", is_error: true, result: "boom" });
    check("an error result is never swallowed", results.length === 1 && agent.lastResult?.isError === true);
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

await main();
