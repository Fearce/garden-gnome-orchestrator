// Regression for concurrent Grok takeovers sharing one server process. No Grok login/CLI/network needed.
// Run: npx tsx src/tests/grokRunner.test.ts

import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { CodexAgentRun } from "../agents/codexRunner.js";
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
