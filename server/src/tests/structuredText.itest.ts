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

import {
  extractJsonObject,
  extractJsonObjects,
  validateAgainstSchema,
  parseStructuredText,
  jsonContractInstruction,
  formatStructuredRoleFeed,
  formatStructuredObject,
  isQaStatusTick,
  takeStructuredProgressLines,
} from "../agents/structuredText.js";
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

  // Grok multi-turn structured roles stream one complete JSON object per model turn into a single text
  // buffer — a naive JSON.parse of the concatenation fails, and the LAST object is the real verdict.
  const grokMulti =
    '{ "pass": false, "summary": "Starting QA.", "issues": [] }' +
    '{ "pass": false, "summary": "Still checking.", "issues": [] }' +
    '{"pass":true,"summary":"Ship it.","issues":[]}';
  check(
    "Grok multi-object stream: extractJsonObjects finds every complete object",
    extractJsonObjects(grokMulti).length === 3,
  );
  const grokParsed = parseStructuredText(grokMulti, QA_SCHEMA);
  check(
    "Grok multi-object stream: parseStructuredText takes the LAST schema-valid object (final pass)",
    grokParsed.value?.pass === true && grokParsed.value?.summary === "Ship it." && !grokParsed.error,
  );
  // Final object truncated mid-string (stream cut off) — brace counter skips it; prior complete valid
  // object must still win so the pipeline gets a verdict instead of "QA could not complete".
  const truncated = grokMulti + '{"pass":true,"summary":"Ship it. Typecheck (server+web), server build, and unit tests (sched';
  const truncParsed = parseStructuredText(truncated, QA_SCHEMA);
  check(
    "Grok multi-object stream with truncated tail still yields last complete valid verdict",
    truncParsed.value?.pass === true && truncParsed.value?.summary === "Ship it." && !truncParsed.error,
  );

  // Exact text Grok QA produced on thread ad31128e (prod failure: "QA could not complete" despite a
  // successful Grok run). Old path: JSON.parse of the whole buffer → throw → structuredOutput missing.
  const realGrokQa =
    '{ "pass": false, "summary": "Starting QA: inspecting git changes and the Grok-related fix against the brief.", "issues": [] }' +
    '{ "pass": false, "summary": "Root-cause fix looks right (prompt-file collision). Running tests, typecheck, and checking for other concurrent-Grok races.", "issues": [] }' +
    '{"pass":true,"summary":"Ship it. The bug matches a real concurrent prompt-file race.","issues":[]}';
  let oldParseThrew = false;
  try {
    JSON.parse(realGrokQa);
  } catch {
    oldParseThrew = true;
  }
  check("real Grok QA payload: naive JSON.parse fails (the historical bug)", oldParseThrew);
  const realParsed = parseStructuredText(realGrokQa, QA_SCHEMA);
  check(
    "real Grok QA payload: parseStructuredText recovers the final pass verdict",
    realParsed.value?.pass === true && typeof realParsed.value?.summary === "string" && !realParsed.error,
  );
}

console.log("\njsonContractInstruction");
{
  const instr = jsonContractInstruction(PLAN_SCHEMA);
  check("embeds the schema so the agent knows the exact shape", instr.includes("summary") && instr.includes("json-schema"));
  check("tells the agent to end with a fenced json block", /```json/.test(instr) && /last thing/i.test(instr));
}

console.log("\nformatStructuredRoleFeed — Grok/Codex QA walls of JSON");
{
  // Exact multi-turn shape Grok QA dumps into the task feed (prod: "looks like grok cant succesfully post…").
  const grokWall =
    '{ "pass": false, "summary": "Inspecting office/team-chat Grok fix vs current diffs." }\n' +
    '{ "pass": false, "summary": "Reading officeBridge + grokRunner harvest logic." }\n' +
    '{ "pass": true, "summary": "Office-bridge fix for Grok team chat is complete, tested, and ready to ship." }';
  const human = formatStructuredRoleFeed(grokWall);
  check("does not leave raw JSON braces in the feed", !human.includes('"pass"') && !human.includes("{ "));
  check("shows intermediate status as markdown list bullets", human.includes("- Inspecting") && human.includes("- Reading"));
  check("shows the final pass as markdown Pass", /\*\*Pass\*\*/.test(human) && human.includes("Office-bridge fix"));
  check("blank line separates checklist from final Pass (Markdown needs it)", /\n\n\*\*Pass\*\*/.test(human));
  // Pipeline parse of the RAW text must still recover the final verdict — feed humanization is display-only.
  const stillParsed = parseStructuredText(grokWall, QA_SCHEMA);
  check("raw multi-object text still parses for the pipeline", stillParsed.value?.pass === true);

  const failWithIssues =
    '{"pass":false,"summary":"Not shippable yet.","issues":[{"severity":"blocker","description":"missing test","location":"foo.ts"}]}';
  const failHuman = formatStructuredRoleFeed(failWithIssues);
  check("formats a failing verdict with severity + location", /\*\*Fail\*\*/.test(failHuman) && failHuman.includes("blocker") && failHuman.includes("foo.ts"));
  check("labels the issues list under Fail", failHuman.includes("Issues:") && failHuman.includes("- **blocker**"));

  // Codex style: prose narration + a final fenced JSON block.
  const codexMix =
    "I verified the Accounts menu wiring and the live switch path.\n\n```json\n" +
    '{"pass":true,"summary":"Accounts provider switch works end-to-end.","issues":[]}\n```';
  const mixHuman = formatStructuredRoleFeed(codexMix);
  check("keeps Codex prose ahead of the formatted verdict", mixHuman.startsWith("I verified the Accounts"));
  check("replaces the fenced JSON with a Pass line", /\*\*Pass\*\*/.test(mixHuman) && !mixHuman.includes("```") && !mixHuman.includes('"pass"'));

  // Pure prose (Claude-style) is left alone.
  const prose = "Passed.\n\nThe plan-voice feature does exactly what the brief asked.";
  check("leaves pure prose unchanged", formatStructuredRoleFeed(prose) === prose);

  // Live progress deltas: first object only, then the rest.
  const partial = '{ "pass": false, "summary": "Starting QA." }';
  const p1 = takeStructuredProgressLines(partial, 0);
  check("progress helper emits the first complete object as a bullet", p1.lines.length === 1 && p1.lines[0]!.startsWith("- Starting"));
  const more = partial + '{ "pass": false, "summary": "Still checking." }';
  const p2 = takeStructuredProgressLines(more, p1.nextIndex);
  check("progress helper only emits newly completed objects", p2.lines.length === 1 && p2.lines[0]!.includes("Still checking"));
  check("progress helper advances the index", p2.nextIndex === 2);

  // Intermediate pass:true drafts (Grok re-emits a near-final verdict many times) must NOT become bullets.
  const draftPass = more + '{ "pass": true, "summary": "Almost done, shipping soon." }';
  const p3 = takeStructuredProgressLines(draftPass, p2.nextIndex);
  check("progress helper skips intermediate pass:true drafts", p3.lines.length === 0 && p3.nextIndex === 3);

  // Long pass:false draft-fail narratives (prod: Grok usage QA) must not become progress bullets either.
  const draftFail =
    '{ "pass": false, "summary": "Starting QA." }\n' +
    '{ "pass": false, "summary": "Backend SuperGrok meters work and Settings shows weekly usage, but the top-bar Grok chip is clipped off-screen at ~1280px so usage still is not visible — fail." }\n' +
    '{ "pass": false, "summary": "Not shippable yet.", "issues": [{"severity":"blocker","description":"chip clipped","location":"styles.css"}] }\n' +
    '{ "pass": false, "summary": "SuperGrok usage plumbing is real but the chip is clipped — fail.", "issues": [{"severity":"blocker","description":"chip clipped off-screen at 1280px","location":"web/src/styles.css"}] }';
  const draftFailHuman = formatStructuredRoleFeed(draftFail);
  check("skips long intermediate pass:false draft-fail narratives", !draftFailHuman.includes("not visible") && draftFailHuman.includes("**Fail**"));
  check(
    "skips intermediate pass:false that already carry issues (only short Starting tick remains)",
    /^-\s+Starting QA\.\s*$/m.test(draftFailHuman) && !draftFailHuman.includes("Not shippable yet."),
  );
  check("draft-fail wall shows only short status + final Fail", /^-\s+Starting/m.test(draftFailHuman) && /\*\*Fail\*\*/.test(draftFailHuman));
  check("draft-fail wall has a single Issues section", (draftFailHuman.match(/^Issues:/gm) ?? []).length === 1);
  check("isQaStatusTick accepts short empty-issues ticks", isQaStatusTick({ pass: false, summary: "Starting QA.", issues: [] }));
  check("isQaStatusTick rejects pass:true drafts", !isQaStatusTick({ pass: true, summary: "Ship it." }));
  check("isQaStatusTick rejects long draft-fail summaries", !isQaStatusTick({
    pass: false,
    summary: "Backend SuperGrok meters work and Settings shows weekly usage, but the top-bar Grok chip is clipped off-screen at ~1280px so usage still is not visible — fail.",
    issues: [],
  }));
  check("isQaStatusTick rejects objects with issues", !isQaStatusTick({
    pass: false,
    summary: "Not ready.",
    issues: [{ severity: "blocker", description: "x" }],
  }));

  // Prod shape: two real status ticks, then ~40 near-identical pass:true re-drafts, then a final Pass
  // with a nit (thread 5c03fc4f — "looks like grok cant succesfully post…").
  let longWall =
    '{ "pass": false, "summary": "Inspecting office/team-chat Grok fix vs current diffs." }\n' +
    '{ "pass": false, "summary": "Reading officeBridge + grokRunner harvest logic." }\n';
  for (let i = 0; i < 40; i++) {
    longWall += `{ "pass": true, "summary": "Grok team-chat fix draft ${i}." }\n`;
  }
  longWall +=
    '{ "pass": true, "summary": "Grok team-chat OFFICE bridge fix verified on master.", "issues": [{"severity":"nit","description":"Stale comment.","location":"threadManager.ts"}] }';
  const longHuman = formatStructuredRoleFeed(longWall);
  check("long Grok wall: no raw JSON left", !longHuman.includes('"pass"') && !longHuman.includes("{ "));
  check("long Grok wall: only real status ticks as bullets (not 40 draft Passes)", (longHuman.match(/^- /gm) ?? []).length === 3); // 2 progress + 1 issue
  check("long Grok wall: single final Pass markdown", (longHuman.match(/\*\*Pass\*\*/g) ?? []).length === 1);
  check("long Grok wall: surfaces final issues", longHuman.includes("nit") && longHuman.includes("threadManager.ts") && longHuman.includes("Issues:"));
  check("long Grok wall: already-humanized text is stable", formatStructuredRoleFeed(longHuman) === longHuman);

  // Second pass: a previously-humanized wall that still kept long draft-fail bullets (prod: Grok usage QA).
  const bloatedHuman =
    "- Starting QA: inspect git changes.\n" +
    "- Working tree clean; inspecting next.\n" +
    "- Backend SuperGrok meters work and Settings shows weekly/monthly usage, but the top-bar Grok chip is clipped off-screen at ~1280px so usage still is not visible — fail.\n" +
    "- Backend + Settings usage work, but the Grok chip is clipped off-screen at common desktop widths — matching the user complaint.\n\n" +
    "**Fail** — SuperGrok usage plumbing is real but the chip is clipped.\n\n" +
    "- **blocker**: Top-bar Grok chip clipped off-screen at 1280px. (web/src/styles.css)";
  const compacted = formatStructuredRoleFeed(bloatedHuman);
  check("compacts already-humanized bloated QA checklists", !compacted.includes("1280px so usage") && compacted.includes("**Fail**"));
  check("keeps short status ticks when compacting", compacted.includes("- Starting QA") && compacted.includes("- Working tree clean"));
  check("adds Issues: when compacting legacy issue bullets", compacted.includes("Issues:") && compacted.includes("- **blocker**"));
  check("compacted humanized text is stable on a second pass", formatStructuredRoleFeed(compacted) === compacted);

  // Cap: many distinct short pass:false ticks keep the FIRST N (+ trailing "more checks" marker).
  let manyTicks = "";
  for (let i = 0; i < 12; i++) manyTicks += `{ "pass": false, "summary": "Check step ${i}." }\n`;
  manyTicks += '{ "pass": true, "summary": "Done." }';
  const capped = formatStructuredRoleFeed(manyTicks);
  check("caps long progress lists with an ellipsis marker", capped.includes("…") && capped.includes("more checks"));
  check("caps progress to a short checklist + final Pass", (capped.match(/^- /gm) ?? []).length <= 9 && /\*\*Pass\*\*/.test(capped));
  check("cap prefers early status ticks (Starting-style), not the last ones", capped.includes("Check step 0.") && !capped.includes("Check step 11."));

  const planObj = formatStructuredObject(
    { summary: "Ship the fix", steps: [{ title: "Patch runner", detail: "humanize feed" }], nextAgent: "implementor" },
    { isLast: true },
  );
  check("formats a plan with steps", !!planObj && planObj.includes("Ship the fix") && planObj.includes("1. Patch runner") && planObj.includes("Next: implementor"));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
