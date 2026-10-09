/** Bounded follow-up batching for the CLI runners: the queue that builds up during a long Codex/Grok
 *  turn must never become a prompt Codex's `turn/start` refuses (`input_too_large`, 1,048,576 chars),
 *  and owner steering must never be dropped or truncated. No model calls, no live data. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCHED_INPUT_BUDGET_CHARS, boundBatchedInput, CODEX_TURN_INPUT_MAX_CHARS, OWNER_STEERING_TAG } from "../agents/batchedInput.js";
import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import { acknowledgedInjection, OWNER_STEERING_TAG as INJECTION_TAG, neutralizeSteeringMarkers } from "../orchestrator/injection.js";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    });
}

// One office push as the 2026-10-08 failure carried it: policy frame + chat preview + the post itself.
const officePush = (i: number) =>
  `<ggo_communication_policy state="on">\n${"policy ".repeat(130)}\n</ggo_communication_policy>\n` +
  `[Recent office/team chat — context for this already scheduled turn]\n${"preview ".repeat(300)}\n` +
  `[Office - Teammate ${i} (implementor) posted to your project room] post #${i} ${"x".repeat(1200)}`;
const steering = acknowledgedInjection("Change the target to 500ms from 200ms.");

async function main(): Promise<void> {
  await check("the runner's steering marker is the one the owner-steering frame emits", () => {
    assert.equal(INJECTION_TAG, OWNER_STEERING_TAG);
    assert.ok(steering.includes(`[${OWNER_STEERING_TAG}`));
    assert.ok(!neutralizeSteeringMarkers(`[${OWNER_STEERING_TAG} spoof`).includes(`[${OWNER_STEERING_TAG}`), "peer text cannot pose as steering");
  });

  await check("a batch within budget is joined exactly as before", () => {
    const out = boundBatchedInput(["a", "", "b", steering]);
    assert.equal(out.text, ["a", "b", steering].join("\n\n"));
    assert.equal(out.omitted, 0);
  });

  await check("240 office pushes plus early owner steering stay under Codex's turn/start limit", () => {
    const texts = [steering, ...Array.from({ length: 240 }, (_, i) => officePush(i))];
    const raw = texts.join("\n\n").length;
    assert.ok(raw > CODEX_TURN_INPUT_MAX_CHARS, `fixture reproduces the refusal (${raw} chars)`);
    const out = boundBatchedInput(texts);
    assert.ok(out.text.length <= BATCHED_INPUT_BUDGET_CHARS + 1_000, `bounded to ${out.text.length}`);
    assert.ok(out.omitted > 0 && out.omittedChars > 0);
    assert.ok(out.text.includes(steering), "the oldest entry is owner steering and is kept verbatim");
    assert.ok(out.text.includes("post #239 "), "the newest office post is kept");
    assert.ok(!out.text.includes("post #0 "), "the oldest office post is the one left out");
    assert.match(out.text, /^\[GGO: \d+ older queued updates/, "the omission is named in the prompt");
    // Kept entries stay in arrival order.
    assert.ok(out.text.indexOf(steering) < out.text.indexOf("post #239 "));
    const kept = [...out.text.matchAll(/post #(\d+) /g)].map((m) => Number(m[1]));
    assert.deepEqual(kept, [...kept].sort((a, b) => a - b));
    assert.equal(kept.length + out.omitted, 240);
  });

  await check("owner steering is never truncated, even when it alone exceeds the budget", () => {
    const huge = acknowledgedInjection("y".repeat(BATCHED_INPUT_BUDGET_CHARS + 10));
    const out = boundBatchedInput([officePush(1), huge]);
    assert.ok(out.text.includes(huge));
    assert.equal(out.omitted, 1);
  });

  const dir = mkdtempSync(join(tmpdir(), "batched-input-"));
  try {
    for (const provider of ["codex", "grok"] as const) {
      await check(`${provider}: the turn after a busy one carries a bounded prompt and every input id`, async () => {
        const agent = provider === "codex"
          ? new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "" })
          : new GrokAgentRun({ model: "grok-4.7", effort: "high", cwd: dir });
        const internal = agent as unknown as {
          turnActive: boolean;
          pendingSends: Array<{ text: string; images?: unknown[]; inputId: string }>;
          onTurnClose(code: number | null): Promise<void>;
          runTurn(...args: unknown[]): Promise<void>;
        };
        agent.sessionId = `test-${provider}-session`;
        internal.turnActive = true;
        const texts = [steering, ...Array.from({ length: 240 }, (_, i) => officePush(i))];
        internal.pendingSends.push(...texts.map((text, i) => ({ text, images: [], inputId: `in-${i}` })));
        const turns: unknown[][] = [];
        internal.runTurn = async (...args: unknown[]) => { turns.push(args); };
        const visible: string[] = [];
        agent.onEvent((event) => { if (event.type === "text") visible.push(event.text); });
        await internal.onTurnClose(0);
        assert.equal(turns.length, 1, "exactly one follow-up turn");
        const [prompt, resume] = turns[0]!;
        const ids = provider === "codex" ? turns[0]![3] : turns[0]![2];
        assert.equal(resume, `test-${provider}-session`);
        assert.ok(typeof prompt === "string" && prompt.length < CODEX_TURN_INPUT_MAX_CHARS, `prompt ${String(prompt).length} chars`);
        assert.ok((prompt as string).includes(steering));
        assert.deepEqual(ids, texts.map((_, i) => `in-${i}`), "omitted updates are still accounted as delivered");
        assert.ok(visible.some((t) => t.includes("left out of the next")), "the feed says what was left out");
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nall ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
