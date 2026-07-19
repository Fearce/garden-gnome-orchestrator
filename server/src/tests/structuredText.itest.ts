/**
 * Unit test — recovering a role's structured output from a CLI backend's free-form text
 * (`server/src/agents/structuredText.ts`).
 *
 * A CLI backend (Codex) can't be handed our json_schema tool, so a planner/researcher/qa run on it ends its
 * turn with a fenced ```json block that we parse + shape-check back into the object the pipeline consumes.
 * This exercises that extraction/validation against the REAL role schemas (PLAN/RESEARCH/QA) so a regression
 * in the parser can't silently break every non-Claude role run.
 *
 * Run:  npm run test:structured   (from server/)   — or:  npx tsx src/tests/structuredText.itest.ts
 * Exits non-zero if any assertion fails. Pure logic — no processes, no accounts, no network.
 */

import { extractJsonObject, validateAgainstSchema, parseStructuredText, jsonContractInstruction } from "../agents/structuredText.js";
import { PLAN_SCHEMA, RESEARCH_SCHEMA, QA_SCHEMA } from "../agents/roles.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nextractJsonObject");
{
  const fenced = "Here is my plan.\n\n```json\n{\"summary\": \"do the thing\"}\n```\n";
  check("pulls the object out of a ```json fence", extractJsonObject(fenced)?.summary === "do the thing");

  const bare = "I'll answer directly: {\"pass\": true, \"summary\": \"looks good\"} — done.";
  check("falls back to a bare balanced {…}", extractJsonObject(bare)?.pass === true);

  const two = "```json\n{\"summary\":\"draft one\"}\n```\nOn reflection:\n```json\n{\"summary\":\"final\"}\n```";
  check("takes the LAST fenced block (the deliberate final answer)", extractJsonObject(two)?.summary === "final");

  const braceInString = '```json\n{"summary": "use the } brace carefully", "parallelism": "none"}\n```';
  check("ignores a } inside a string literal", extractJsonObject(braceInString)?.summary === "use the } brace carefully");

  check("returns undefined when there is no JSON at all", extractJsonObject("just prose, no json here") === undefined);
  check("returns undefined for empty input", extractJsonObject("") === undefined);

  const arrayOnly = "```json\n[1,2,3]\n```";
  check("rejects a top-level array (roles emit objects)", extractJsonObject(arrayOnly) === undefined);
}

console.log("\nvalidateAgainstSchema — PLAN_SCHEMA");
{
  check("accepts the minimal valid plan (summary only)", validateAgainstSchema({ summary: "s" }, PLAN_SCHEMA) === null);
  check("rejects a plan missing its required summary", validateAgainstSchema({ steps: [] }, PLAN_SCHEMA) !== null);
  check(
    "accepts a full plan with nested steps",
    validateAgainstSchema({ summary: "s", steps: [{ title: "t", detail: "d", files: ["a.ts"] }], risks: ["r"], nextAgent: "implementor" }, PLAN_SCHEMA) === null,
  );
  check(
    "rejects a step missing its required title",
    validateAgainstSchema({ summary: "s", steps: [{ detail: "d" }] }, PLAN_SCHEMA) !== null,
  );
  check("rejects a bad nextAgent enum value", validateAgainstSchema({ summary: "s", nextAgent: "designer" }, PLAN_SCHEMA) !== null);
  check("accepts a valid nextAgent enum value", validateAgainstSchema({ summary: "s", nextAgent: "researcher" }, PLAN_SCHEMA) === null);
}

console.log("\nvalidateAgainstSchema — QA_SCHEMA");
{
  check("accepts a passing verdict", validateAgainstSchema({ pass: true, summary: "all green" }, QA_SCHEMA) === null);
  check("rejects a verdict with a non-boolean pass", validateAgainstSchema({ pass: "yes", summary: "s" }, QA_SCHEMA) !== null);
  check("rejects a verdict missing summary", validateAgainstSchema({ pass: false }, QA_SCHEMA) !== null);
  check(
    "accepts issues with a valid severity enum",
    validateAgainstSchema({ pass: false, summary: "s", issues: [{ description: "d", severity: "blocker" }] }, QA_SCHEMA) === null,
  );
  check(
    "rejects an issue with a bad severity enum",
    validateAgainstSchema({ pass: false, summary: "s", issues: [{ description: "d", severity: "catastrophic" }] }, QA_SCHEMA) !== null,
  );
  check(
    "rejects an issue missing its required description",
    validateAgainstSchema({ pass: false, summary: "s", issues: [{ severity: "minor" }] }, QA_SCHEMA) !== null,
  );
}

console.log("\nvalidateAgainstSchema — RESEARCH_SCHEMA");
{
  check("accepts a minimal research result", validateAgainstSchema({ summary: "s" }, RESEARCH_SCHEMA) === null);
  check(
    "accepts facts + memories",
    validateAgainstSchema({ summary: "s", facts: [{ claim: "c", source: "url" }], memories: [{ name: "n", gist: "g" }] }, RESEARCH_SCHEMA) === null,
  );
  check("rejects a fact missing its required claim", validateAgainstSchema({ summary: "s", facts: [{ source: "url" }] }, RESEARCH_SCHEMA) !== null);
}

console.log("\nparseStructuredText — end to end");
{
  const good = "Reviewed the diff.\n\n```json\n{\"pass\": false, \"summary\": \"one blocker\", \"issues\": [{\"description\": \"null deref\", \"severity\": \"blocker\"}]}\n```";
  const r = parseStructuredText(good, QA_SCHEMA);
  check("returns the validated value on a good QA reply", r.value?.pass === false && !r.error);

  const noJson = parseStructuredText("I think it's fine, shipping it.", QA_SCHEMA);
  check("returns a 'no JSON' error nudge when the block is missing", !noJson.value && !!noJson.error && /json/i.test(noJson.error!));

  const badShape = parseStructuredText("```json\n{\"summary\": \"forgot the pass field\"}\n```", QA_SCHEMA);
  check("returns a schema-mismatch error nudge naming the missing field", !badShape.value && !!badShape.error && /pass/.test(badShape.error!));
}

console.log("\njsonContractInstruction");
{
  const instr = jsonContractInstruction(PLAN_SCHEMA);
  check("embeds the schema so the agent knows the exact shape", instr.includes("summary") && instr.includes("json-schema"));
  check("tells the agent to end with a fenced json block", /```json/.test(instr) && /last thing/i.test(instr));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
