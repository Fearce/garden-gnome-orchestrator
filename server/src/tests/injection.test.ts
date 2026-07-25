import assert from "node:assert/strict";
import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import { acknowledgedInjection, injectionSendOptions, structuredAcknowledgedInjection } from "../orchestrator/injection.js";

const message = "Use a new clip design and export a 3MF file.";
const prompt = acknowledgedInjection(message);

assert.match(prompt, /^\[DIRECTOR INJECTION — ACKNOWLEDGEMENT REQUIRED\]/);
assert.ok(prompt.includes(message));
assert.match(prompt, /highest-priority direction/);
assert.match(prompt, /begin your next visible response with `ACK:`/);
assert.match(prompt, /do not treat it as background context/);

const structuredPrompt = structuredAcknowledgedInjection(message);
assert.match(structuredPrompt, /remain schema-valid/);
assert.match(structuredPrompt, /required `summary` field with `ACK:`/);

/** The real CLI runner classes must receive `priority: now` for a plain Inject
 * (append) and therefore interrupt their long batch rather than waiting for it
 * to finish. This stays process-free: only the child-kill seam is replaced. */
function assertAppendInterruptsBatch(run: CodexAgentRun | GrokAgentRun, label: string): void {
  const internals = run as unknown as {
    turnActive: boolean;
    sessionId: string;
    requestInterrupt(): void;
  };
  internals.turnActive = true;
  internals.sessionId = "live-session";
  let interrupts = 0;
  internals.requestInterrupt = () => {
    interrupts++;
  };
  run.send("Owner steering", injectionSendOptions(run, "append"));
  assert.equal(interrupts, 1, `${label} append injection must interrupt its active batch immediately`);
}

assertAppendInterruptsBatch(new CodexAgentRun({ model: "gpt-5.6", effort: "low", cwd: process.cwd(), apiKey: "test-key" }), "Codex");
assertAppendInterruptsBatch(new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() }), "Grok");

console.log("injection: acknowledgement framing and immediate CLI append delivery verified");
