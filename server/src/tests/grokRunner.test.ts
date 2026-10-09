// Regression for concurrent Grok takeovers sharing one server process. No Grok login/CLI/network needed.
// Run: npx tsx src/tests/grokRunner.test.ts

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, unlink } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { CodexAgentRun, codexResumeRolloutMissing, settleCodexChild } from "../agents/codexRunner.js";
import { GrokAgentRun, stageGrokPrompt } from "../agents/grokRunner.js";

const prompts = Array.from({ length: 32 }, (_, i) => `task-specific-prompt-${i}`);
const paths = await Promise.all(prompts.map(stageGrokPrompt));

try {
  assert.ok(paths.every((path): path is string => typeof path === "string"));
  assert.equal(new Set(paths).size, prompts.length, "each concurrent Grok run must own a unique prompt file");
  const staged = await Promise.all(paths.map((path) => readFile(path!, "utf8")));
  assert.deepEqual(staged, prompts, "concurrent staging must not cross-contaminate task prompts");
} finally {
  await Promise.all(paths.map((path) => path ? unlink(path).catch(() => {}) : Promise.resolve()));
}

console.log("All Grok runner concurrency checks passed.");

const wedged = new GrokAgentRun({ model: "grok-4.6", effort: "high", cwd: process.cwd() });
const privateRun = wedged as unknown as { turnActive: boolean; sawFirstEvent: boolean; onWatchdogTimeout(ms: number): void };
privateRun.turnActive = true;
privateRun.sawFirstEvent = false;
privateRun.onWatchdogTimeout(60_000);
assert.equal(wedged.startupWedged, true, "a zero-event watchdog must be marked as a provider startup wedge");
assert.equal(wedged.startupWedgeScope, "provider", "a fresh zero-event Grok turn is provider-scoped");
assert.equal(wedged.transientApiError, true, "a startup wedge must enter the provider failover path");
assert.match(wedged.transientApiErrorMessage ?? "", /startup watchdog/, "the failover history must keep the exact watchdog reason");

const resumedGrok = new GrokAgentRun({ model: "grok-4.6", effort: "high", cwd: process.cwd(), resume: "saved-grok", freshFallback: "full kickoff" });
const privateResumedGrok = resumedGrok as unknown as { turnActive: boolean; sawFirstEvent: boolean; isResumeTurn: boolean; onWatchdogTimeout(ms: number): void };
privateResumedGrok.turnActive = true;
privateResumedGrok.sawFirstEvent = false;
privateResumedGrok.isResumeTurn = true;
privateResumedGrok.onWatchdogTimeout(60_000);
assert.equal(resumedGrok.startupWedgeScope, "session", "a zero-event Grok resume is session-scoped");

for (const [label, resume, expected] of [
  ["fresh", false, "provider"],
  ["resumed", true, "session"],
] as const) {
  const codex = new CodexAgentRun({
    model: "gpt-5.6-terra",
    effort: "high",
    cwd: process.cwd(),
    apiKey: "sk-test",
    ...(resume ? { resume: "saved-codex", freshFallback: "full kickoff" } : {}),
  });
  const privateCodex = codex as unknown as { turnActive: boolean; sawFirstEvent: boolean; isResumeTurn: boolean; onWatchdogTimeout(ms: number): void };
  privateCodex.turnActive = true;
  privateCodex.sawFirstEvent = false;
  privateCodex.isResumeTurn = resume;
  privateCodex.onWatchdogTimeout(60_000);
  assert.equal(codex.startupWedgeScope, expected, `a ${label} zero-event Codex turn has the right wedge scope`);
}

console.log("Grok startup-watchdog classification passed.");

assert.equal(
  codexResumeRolloutMissing("thread/resume: thread/resume failed: no rollout found for thread id 01a08616 (code -32600)"),
  true,
  "the real missing-rollout error is a fresh-session recovery condition",
);
assert.equal(codexResumeRolloutMissing("thread/resume failed: connection reset"), false, "ordinary resume transport errors still use normal retry policy");
assert.equal(codexResumeRolloutMissing("no rollout found for thread id mentioned in task prose"), false, "task prose alone cannot trigger session replacement");

const missing = new CodexAgentRun({
  model: "gpt-5.6-terra",
  effort: "high",
  cwd: process.cwd(),
  apiKey: "sk-test",
  resume: "missing-codex",
  freshFallback: "full brief\n\ndurable history\n\nstanding directives",
});
let restarted: { prompt: string; resume?: string } | null = null;
const missingEvents: string[] = [];
missing.onEvent((event) => { if (event.type === "text") missingEvents.push(event.text); });
const privateMissing = missing as unknown as {
  isResumeTurn: boolean;
  sawFirstEvent: boolean;
  turnActive: boolean;
  handleEvent(event: unknown): void;
  onTurnClose(code: number | null): void;
  runTurn(prompt: string, resume?: string): Promise<void>;
};
privateMissing.isResumeTurn = true;
privateMissing.sawFirstEvent = true;
privateMissing.turnActive = true;
missing.send("latest owner steering while resume is failing");
privateMissing.runTurn = async (prompt, resume) => { restarted = { prompt, resume }; };
privateMissing.handleEvent({
  type: "turn.failed",
  error: { message: "thread/resume failed: no rollout found for thread id missing-codex", code: -32600 },
});
privateMissing.onTurnClose(1);
assert.equal(missing.startupWedged, true, "a missing rollout is classified as a session startup failure");
assert.equal(missing.startupWedgeScope, "session");
assert.equal(missing.resumeHealed, true, "the runner consumes its one fresh-session fallback");
assert.deepEqual(restarted, {
  prompt: "full brief\n\ndurable history\n\nstanding directives\n\nlatest owner steering while resume is failing",
  resume: undefined,
});
assert.match(missingEvents.join("\n"), /could not find the saved rollout/);

console.log("Codex missing-rollout recovery checks passed.");

// A finished launcher may leave inherited pipes open in a grandchild. `close` then never arrives even
// though `exit` did; the runner must release the task after the drain grace, exactly once.
const orphanedPipes = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
const settledCodes: (number | null)[] = [];
settleCodexChild(orphanedPipes as unknown as ChildProcess, (code) => settledCodes.push(code), 15);
orphanedPipes.emit("exit", 1);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.deepEqual(settledCodes, [1], "an exited launcher releases its run without a close event");
assert.equal(orphanedPipes.stdout.destroyed, true);
assert.equal(orphanedPipes.stderr.destroyed, true);
orphanedPipes.emit("close", 1);
assert.deepEqual(settledCodes, [1], "a late close cannot settle the next turn a second time");

const cleanClose = new EventEmitter();
const cleanCodes: (number | null)[] = [];
settleCodexChild(cleanClose as ChildProcess, (code) => cleanCodes.push(code), 15);
cleanClose.emit("exit", 0);
cleanClose.emit("close", 0);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.deepEqual(cleanCodes, [0], "a normal close wins over the fallback timer");

console.log("Codex child-exit recovery checks passed.");

const activeChild = Object.assign(new EventEmitter(), { kill: () => { throw new Error("an active turn must not be stopped"); } });
let activeSettles = 0;
settleCodexChild(activeChild as unknown as ChildProcess, () => { activeSettles++; }, 15);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(activeSettles, 0, "the shutdown grace starts only after a terminal event");
activeChild.emit("close", 0);

// A terminal turn must settle even when the launcher never emits exit/close during tool-host teardown.
// Exercise the real event parser and close path: the forced shutdown must retain the verdict, and a
// steering message in the drain gap must open a continuation instead of publishing the old verdict.
for (const scenario of ["success", "failed", "steering", "normal-close"] as const) {
  const run = new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: process.cwd(), apiKey: "sk-test",
    outputSchema: { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] } });
  let kills = 0;
  let closes = 0;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills++; return true; },
  });
  const internal = run as unknown as {
    turnActive: boolean; child: ChildProcess; drainTerminalChild: () => void;
    onStdout(chunk: string): void; onTurnClose(code: number | null): Promise<void>;
    runTurn(prompt: string, resume?: string): Promise<void>;
  };
  internal.turnActive = true;
  internal.child = child as unknown as ChildProcess;
  internal.drainTerminalChild = settleCodexChild(internal.child, (code) => {
    closes++;
    void internal.onTurnClose(code);
  }, 15);
  let continuation: string | undefined;
  internal.runTurn = async (prompt) => { continuation = prompt; };
  let results = 0;
  run.onEvent((event) => { if (event.type === "result") results++; });
  internal.onStdout(JSON.stringify({ type: "thread.started", thread_id: "saved-terminal-session" }) + "\n");
  internal.onStdout(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"pass":false}' } }) + "\n");
  internal.onStdout(JSON.stringify(scenario === "failed"
    ? { type: "turn.failed", error: { message: "verification failed" } }
    : { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\n");
  assert.equal(results, 0, "terminal events must still wait for drain-gap steering");
  if (scenario === "steering") run.send("current owner instruction");
  if (scenario === "normal-close") { child.emit("exit", 0); child.emit("close", 0); }
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(closes, 1, `${scenario}: settle exactly once without relying on launcher exit`);
  assert.equal(kills, scenario === "normal-close" ? 0 : 1, "only a lingering launcher is stopped");
  if (scenario === "steering") {
    assert.equal(continuation, "current owner instruction", "queued steering survives terminal shutdown");
    assert.equal(results, 0, "an obsolete verdict cannot escape before its continuation");
  } else {
    assert.equal(results, 1);
    assert.equal(run.lastResult?.isError, scenario === "failed");
    if (scenario === "failed") assert.equal(run.lastResult?.result, "verification failed");
    else assert.deepEqual(run.lastResult?.structuredOutput, { pass: false }, "shutdown does not turn a failed QA verdict into acceptance");
  }
  child.emit("exit", 0);
  child.emit("close", 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closes, 1, "late process events cannot settle a newer turn");
}

console.log("Codex terminal-turn shutdown and steering checks passed.");

// Real process proof, without provider access: stdout reports success but the process stays alive.
const lingeringRun = new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: process.cwd(), apiKey: "sk-test" });
const lingering = lingeringRun as unknown as {
  turnActive: boolean; child: ChildProcess; drainTerminalChild: () => void;
  onStdout(chunk: string): void; onTurnClose(code: number | null): Promise<void>;
};
const lingeringChild = spawn(process.execPath, ["-e", `
  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:3,output_tokens:1}})+"\\n");
  setInterval(()=>{},1000);
`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const lingeringExit = new Promise<void>((resolve) => { lingeringChild.once("exit", () => resolve()); });
lingering.turnActive = true;
lingering.child = lingeringChild;
lingering.drainTerminalChild = settleCodexChild(lingeringChild, (code) => { void lingering.onTurnClose(code); }, 15);
lingeringChild.stdout!.on("data", (chunk: Buffer) => lingering.onStdout(chunk.toString()));
let proofTimeout: NodeJS.Timeout | undefined;
try {
  const [result] = await Promise.race([
    Promise.all([lingeringRun.result(), lingeringExit]),
    new Promise<never>((_, reject) => { proofTimeout = setTimeout(() => reject(new Error("terminal launcher did not settle and exit")), 10_000); }),
  ]);
  assert.equal(result?.isError, false, "forced process shutdown preserves a successful terminal result");
  assert.equal(result?.tokenUsage?.inputTokens, 3);
  assert.equal(lingeringRun.finished, true);
} finally {
  if (proofTimeout) clearTimeout(proofTimeout);
  lingeringChild.kill();
}
console.log("Codex lingering-launcher process proof passed.");
