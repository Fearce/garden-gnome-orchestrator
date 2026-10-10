/**
 * Unit gate — a message the agent folds in mid-turn is recorded as consumed the moment it is folded.
 *
 * An append sent while the agent works (no priority, which the CLI enqueues as "later") is read at the next
 * tool boundary, not at turn end. The CLI reports that fold only through a `command_lifecycle` frame
 * (`queued` at send, `started` at the fold, `completed` after) and the turn's closing `result`, whose
 * `user_message_uuids` lists every message the turn took. The stream/assistant frames carry the uuid only for
 * a turn's FIRST message. Verified against the real CLI 2.1.296 on 2026-10-10. Watching only those frames,
 * GGO showed a read injection as unread for minutes, and a run that ended reverted its receipt to pending and
 * delivered the same instruction again to the next run.
 *
 * Run: npm run test:mid-turn-consumption   (from server/)
 */
import { AgentRun } from "../agents/runner.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runWithSend(id: string): { agent: any; consumed: () => boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = new AgentRun({ model: "claude-haiku-4-5-20251001", cwd: process.cwd() }) as any;
  agent.inputs.issue(id);
  let fired = false;
  agent.onInputConsumed(id, () => (fired = true));
  return { agent, consumed: () => fired };
}

const lifecycle = (id: string, state: string): Record<string, unknown> => ({ type: "command_lifecycle", command_uuid: id, state });

async function main(): Promise<void> {
  console.log("\nThe CLI's command lifecycle\n");
  {
    const { agent, consumed } = runWithSend("steer-1");
    agent.handle(lifecycle("steer-1", "queued"));
    check("queued is not consumption", !consumed() && !agent.latestSendConsumed);
    agent.handle(lifecycle("steer-1", "started"));
    check("started (the fold) consumes the send", consumed() && agent.latestSendConsumed);
  }
  {
    const { agent, consumed } = runWithSend("steer-2");
    agent.handle(lifecycle("steer-2", "completed"));
    check("completed consumes a send whose started frame was missed", consumed());
  }
  {
    const { agent, consumed } = runWithSend("steer-3");
    agent.handle(lifecycle("steer-3", "cancelled"));
    check("cancelled never counts as read", !consumed() && !agent.latestSendConsumed);
  }
  {
    const { agent, consumed } = runWithSend("steer-4");
    agent.handle(lifecycle("someone-else", "started"));
    check("another command's lifecycle leaves this send unconsumed", !consumed());
  }

  console.log("\nThe turn's result\n");
  {
    const { agent, consumed } = runWithSend("steer-5");
    agent.handle({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 6, user_message_uuid: "kickoff", user_message_uuids: ["kickoff", "steer-5"] });
    check("a mid-turn fold listed on the result is consumed", consumed() && agent.latestSendConsumed);
  }
  {
    const { agent, consumed } = runWithSend("steer-6");
    agent.handle({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 3, user_message_uuids: ["kickoff"] });
    check("a result that did not take the send leaves it unconsumed", !consumed());
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

await main();
