/**
 * Regression guard for CLI QA fallbacks. Claude/z.ai receive the SDK's real tool policy, while
 * Codex and Grok receive it in their textual kickoff. Editing QA must never be followed by the
 * ordinary-QA "do not edit" rule, or those providers leave fixes behind despite QA_FIX_PROMPT.
 */
import assert from "node:assert/strict";
import { QA_FIX_PROMPT, QA_PROMPT } from "../agents/prompts.js";
import type { AgentRunConfig } from "../agents/runner.js";
import { cliRoleKickoff } from "../orchestrator/threadManager.js";

function qaKickoff(systemPrompt: string, disallowedTools: string[]): string {
  const cfg: AgentRunConfig = {
    model: "test-model",
    cwd: process.cwd(),
    systemPrompt,
    disallowedTools,
  };
  const kickoff = cliRoleKickoff(cfg, "Review the completed task.", "qa", "Codex");
  if (typeof kickoff !== "string") throw new Error("string input must produce a string CLI kickoff");
  return kickoff;
}

const readOnly = qaKickoff(QA_PROMPT, ["Write", "Edit", "NotebookEdit", "AskUserQuestion"]);
assert.match(readOnly, /inspect and run checks, but do not edit the implementation/i);

// Run the same shared kickoff builder for both CLI provider labels. The distinction is deliberate:
// Codex triggered the regression, but Grok uses this exact text path too.
for (const provider of ["Codex", "Grok"] as const) {
  const cfg: AgentRunConfig = {
    model: "test-model",
    cwd: process.cwd(),
    systemPrompt: QA_FIX_PROMPT,
    disallowedTools: ["AskUserQuestion"],
  };
  const kickoff = cliRoleKickoff(cfg, "Review the completed task.", "qa", provider);
  assert.equal(typeof kickoff, "string");
  const text = kickoff as string;
  assert.match(text, /stage ONLY your own QA hunks and create a focused Conventional Commit/i, `${provider} must receive the QA-fix commit doctrine`);
  assert.match(text, /editing QA reviewer: inspect, fix every in-scope issue/i, `${provider} must receive editing QA mode`);
  assert.doesNotMatch(text, /inspect and run checks, but do not edit the implementation/i, `${provider} must not receive contradictory read-only QA mode`);
}

console.log("cli role kickoff: editing QA doctrine reaches Codex and Grok without a read-only contradiction");
