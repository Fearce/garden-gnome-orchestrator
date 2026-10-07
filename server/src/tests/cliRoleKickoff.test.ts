/**
 * Regression guard for CLI QA fallbacks. Claude/z.ai receive the SDK's real tool policy, while
 * Codex and Grok receive it in their textual kickoff. Editing QA must never be followed by the
 * ordinary-QA "do not edit" rule, or those providers leave fixes behind despite QA_FIX_PROMPT.
 */
import assert from "node:assert/strict";
import { CODEX_IMPLEMENTOR_DOCTRINE, GROK_IMPLEMENTOR_DOCTRINE, IMPLEMENTOR_APPEND, QA_FIX_PROMPT, QA_PROMPT } from "../agents/prompts.js";
import type { AgentRunConfig } from "../agents/runner.js";
import { cliRoleKickoff, cliRoleStartContent } from "../orchestrator/threadManager.js";

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
assert.match(readOnly, /Do not emit a kickoff or progress preamble/i, "QA starts with tools instead of narrating routine setup");
assert.match(readOnly, /no candidate list means only that the detector found none and never waives this check/i, "the cache-stable QA prompt owns the complete deliverables invariant");
assert.match(readOnly, /For each card, verify its path still resolves to the intended file inside this task's workspace/, "QA checks that recorded cards are servable");
assert.match(readOnly, /Check for refused-deliverable warnings too/, "QA catches refused CLI bridge posts");
assert.match(readOnly, /OPERATOR_NOTE: short action \| https:\/\//, "CLI fallback roles must retain the owner-note bridge");
assert.match(
  readOnly,
  /DELIVERABLE: Short label \| C:\/absolute\/path\/to\/file\.ext/,
  "CLI fallback roles must retain the deliverable bridge",
);

for (const prompt of [IMPLEMENTOR_APPEND, CODEX_IMPLEMENTOR_DOCTRINE, GROK_IMPLEMENTOR_DOCTRINE]) {
  assert.match(prompt, /Clean checkouts take priority over task ownership/, "every implementor backend receives the owner's clean-checkout priority");
  assert.match(prompt, /preserve peer changes in separately attributed Conventional Commits/, "peer changes are preserved rather than left dirty");
  assert.match(prompt, /standing owner authorization/, "checkpointing peer work must not require another permission request");
  assert.match(prompt, /git-transaction\.cjs/, "every implementation backend receives the shared Git queue command");
  assert.match(prompt, /do not wait for their author to commit/, "peer commits do not become an owner permission wait");
  assert.doesNotMatch(prompt, /none of your work uncommitted/, "the completion check covers all pending work");
  assert.match(prompt, /copy (?:the finished file|it) into the task workspace/i, "every implementor backend copies outside artifacts before posting");
  assert.match(prompt, /copy's absolute path/, "every implementor backend posts the workspace copy");
}
assert.match(
  readOnly,
  /never use it to hide an implementor's missing deliverable/i,
  "QA must not surface an implementor artifact on its behalf",
);

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
  assert.match(text, /pending peer source, configuration and documentation changes in separately attributed Conventional Commits/, `${provider} editing QA must preserve and commit peer work`);
  assert.match(text, /Clean checkouts take priority over task ownership; this is standing owner authorization/, `${provider} editing QA must honor the owner's clean-checkout priority`);
  assert.match(text, /Push these commits unless the task handoff says auto-push is off/, `${provider} editing QA must apply the captured push policy to peer commits too`);
  assert.match(text, /git-transaction\.cjs/, `${provider} editing QA uses the shared Git queue`);
  assert.match(text, /Do not emit a kickoff or progress preamble/i, `${provider} QA-fix starts with tools instead of narration`);
  assert.match(text, /no candidate list means only that the detector found none and never waives this check/i, `${provider} QA-fix retains the complete deliverables invariant`);
  assert.match(text, /editing QA reviewer: inspect, fix every in-scope issue/i, `${provider} must receive editing QA mode`);
  assert.doesNotMatch(text, /inspect and run checks, but do not edit the implementation/i, `${provider} must not receive contradictory read-only QA mode`);
}

console.log("cli role kickoff: editing QA doctrine reaches Codex and Grok without a read-only contradiction");

{
  const cfg: AgentRunConfig = {
    model: "test-reader",
    cwd: process.cwd(),
    systemPrompt: "Answer repository lookups read-only.",
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["answered", "escalated", "answer"],
        properties: { answered: { type: "boolean" }, escalated: { type: "boolean" }, answer: { type: "string" } },
      },
    },
  };
  const kickoff = cliRoleKickoff(cfg, "Count the rebases.", "reader", "Codex");
  assert.equal(typeof kickoff, "string");
  assert.match(kickoff as string, /COMPLETE owner-facing answer/i);
  assert.match(kickoff as string, /final schema object's `answer` field/i);
  assert.match(kickoff as string, /remain read-only/i);
}

for (const prompt of [CODEX_IMPLEMENTOR_DOCTRINE, GROK_IMPLEMENTOR_DOCTRINE, readOnly]) {
  assert.match(prompt, /ASK_USER: \{/);
  assert.match(prompt, /end this turn immediately/);
  assert.doesNotMatch(prompt, /stop and explain it clearly in your final message/);
}

// Every implementation provider receives an actionable, cloud-only bridge example.
for (const prompt of [CODEX_IMPLEMENTOR_DOCTRINE, GROK_IMPLEMENTOR_DOCTRINE, IMPLEMENTOR_APPEND]) {
  assert.match(prompt, /"cloudWork":"review","cloudOnly":true/);
  assert.match(prompt, /never remove cloudOnly/);
  assert.match(prompt, /Confirm the spawn result says \*\*Claude cloud\*\*/);
}

// A kickoff with pasted images is a content-block array. Appending the inbox note by template
// interpolation once delivered a QA brief to Codex as "[object Object],[object Object],[object Object]".
for (const provider of ["Codex", "Grok"] as const) {
  const cfg: AgentRunConfig = { model: "test-model", cwd: process.cwd(), systemPrompt: QA_PROMPT };
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const note = "Quiet inbox: read it at checkpoints.";
  const start = cliRoleStartContent(cfg, [{ type: "text", text: "# QA review for task: Example brief" }, image], "qa", provider, note);
  assert.ok(Array.isArray(start), `${provider}: an image kickoff must stay a content-block array`);
  const blocks = start as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.doesNotMatch(JSON.stringify(blocks), /\[object Object\]/, `${provider}: no block may be stringified`);
  assert.match(text, /# QA review for task: Example brief/, `${provider}: the brief arrives as readable text`);
  assert.match(text, /Temporary provider fallback/, `${provider}: the CLI role prelude is kept`);
  assert.equal(blocks.at(-1)?.text, note, `${provider}: the inbox note follows the kickoff`);
  assert.ok(blocks.includes(image as never), `${provider}: the pasted image is preserved`);

  const plain = cliRoleStartContent(cfg, "Review the completed task.", "qa", provider, note);
  assert.equal(typeof plain, "string");
  assert.match(plain as string, /Review the completed task\.\n\nQuiet inbox: read it at checkpoints\.$/, `${provider}: a text kickoff keeps the note appended`);
}

console.log("cli role kickoff: image kickoffs reach Codex and Grok as readable blocks, not [object Object]");
