/**
 * Unit test — auto model selection's two pure halves: the reply validator (modelSelector) and the
 * outcome score (modelGrading). No network, no DB, no quota.
 *
 * Why these two:
 *  - The reply is MODEL OUTPUT that decides which backend spawns. A hallucinated id ("gpt-5-turbo") or a
 *    pick naming a provider that can't run it must never reach a spawn — the parser is the only thing
 *    standing between the two, so it is asserted as hard as the titler's commentary guard.
 *  - The score is what every future pick is made from. If it can't rank a clean finish above a task that
 *    burned four QA rounds, the whole feedback loop is decoration.
 *
 * Run:  npm run test:model-select   (from server/)   — or:  npx tsx src/tests/modelSelection.test.ts
 */

import { buildSelectionPrompt, modelNote, parseSelection, selectImplementorModel, type ModelCandidate } from "../orchestrator/modelSelector.js";
import { gradeSettledTask, outcomeOfState, scoreOutcome } from "../orchestrator/modelGrading.js";
import { claudeTokenUsage } from "../agents/runner.js";
import { codexTokenUsage } from "../agents/codexRunner.js";
import type { AgentRun, Effort } from "../types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const CANDIDATES: ModelCandidate[] = [
  { provider: "claude", model: "claude-haiku-4-5-20251001", efforts: ["low", "medium", "high"], note: modelNote("claude", "claude-haiku-4-5-20251001") },
  { provider: "claude", model: "claude-sonnet-4-6", efforts: ["low", "medium", "high", "max"], note: modelNote("claude", "claude-sonnet-4-6") },
  { provider: "claude", model: "claude-opus-4-8", efforts: ["low", "medium", "high", "xhigh", "max"], note: modelNote("claude", "claude-opus-4-8") },
  { provider: "codex", model: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max"], note: modelNote("codex", "gpt-5.6-sol") },
  { provider: "zai", model: "glm-4.7", efforts: ["low", "medium", "high"], note: modelNote("zai", "glm-4.7") },
];
const EFFORTS: Effort[] = ["low", "medium", "high", "max"];
const CTX = { candidates: CANDIDATES, efforts: EFFORTS };

console.log("\n=== auto model selection — reply validation ===\n");

{
  const pick = parseSelection('{"model":"claude-haiku-4-5-20251001","effort":"low","reason":"one-line copy edit"}', CTX);
  check("a clean reply parses", pick?.model === "claude-haiku-4-5-20251001", JSON.stringify(pick));
  check("effort is taken from the reply", pick?.effort === "low", String(pick?.effort));
  check("provider comes from the ROSTER, not the reply", pick?.provider === "claude", String(pick?.provider));
  check("reason is carried", pick?.reason === "one-line copy edit", String(pick?.reason));
}

{
  const fenced = 'Here you go:\n```json\n{"model": "gpt-5.6-sol", "effort": "high", "reason": "big refactor"}\n```\nHope that helps.';
  const pick = parseSelection(fenced, CTX);
  check("a fenced reply with prose around it still parses", pick?.model === "gpt-5.6-sol", JSON.stringify(pick));
  check("the matched candidate's provider is used (codex)", pick?.provider === "codex", String(pick?.provider));
}

// The failure that matters: a model id nobody can run. Rejecting is the ONLY safe answer — the caller
// then falls back to normal routing, whereas accepting would spawn against an id the backend rejects.
for (const bad of [
  '{"model":"gpt-5-turbo","effort":"high","reason":"invented"}',
  '{"model":"claude-opus-4-9","effort":"high","reason":"a version that does not exist here"}',
  '{"model":"","effort":"high","reason":"blank"}',
  '{"effort":"high","reason":"no model at all"}',
  "I'd go with Sonnet for this one.",
  "",
  "{ not json at all",
]) {
  const pick = parseSelection(bad, CTX);
  check(`rejected: ${bad.slice(0, 46) || "(empty)"}`, pick === null, JSON.stringify(pick));
}

{
  const pick = parseSelection('{"model":"  CLAUDE-Sonnet-4-6 ","effort":"high","reason":"x"}', CTX);
  check("an id that differs only in case/whitespace still matches", pick?.model === "claude-sonnet-4-6", JSON.stringify(pick));
}

{
  // A good pick must not be thrown away over an effort tier we simply don't offer — that would cost a
  // whole extra call (or the fallback) for a field with a safe default.
  const pick = parseSelection('{"model":"glm-4.7","effort":"ludicrous","reason":"x"}', CTX);
  check("an unknown effort degrades to high rather than voiding the pick", pick?.effort === "high", JSON.stringify(pick));
  const gated = parseSelection('{"model":"glm-4.7","effort":"xhigh","reason":"x"}', CTX);
  check("an effort not supported by the selected model degrades too", gated?.effort === "high", JSON.stringify(gated));
}

{
  const long = "x ".repeat(400);
  const pick = parseSelection(`{"model":"glm-4.7","effort":"high","reason":"${long}"}`, CTX);
  check("a runaway reason is clipped", (pick?.reason.length ?? 0) <= 200, String(pick?.reason.length));
}

console.log("\n=== the prompt carries what the decision needs ===\n");

{
  const prompt = buildSelectionPrompt({
    title: "Add a dark-mode toggle",
    workspace: "C:\\repo",
    brief: "The settings panel needs a dark-mode toggle.",
    planText: "Summary: one component + one CSS block.\nSteps:\n- Toggle (web/src/x.tsx): add it",
    candidates: CANDIDATES,
    efforts: EFFORTS,
    repoStats: [{ provider: "claude", model: "claude-sonnet-4-6", picks: 3, avgScore: 88, doneRate: 0.67, avgQaRounds: 1.3, avgCostUsd: 2.5, avgTotalTokens: 120_000, avgInputTokens: 100_000, avgOutputTokens: 12_000, avgCacheTokens: 8_000, avgReasoningTokens: 0, tokenSampleRate: 1, avgMinutes: 14 }],
    globalStats: [{ provider: "zai", model: "glm-4.7", picks: 9, avgScore: 52, doneRate: 0.33, avgQaRounds: 2.4, avgCostUsd: 1.1, avgTotalTokens: 240_000, avgInputTokens: 200_000, avgOutputTokens: 40_000, avgCacheTokens: 0, avgReasoningTokens: 0, tokenSampleRate: 0.8, avgMinutes: 31 }],
    repoEffortStats: [{ provider: "claude", model: "claude-sonnet-4-6", effort: "medium", picks: 2, avgScore: 94, doneRate: 1, avgQaRounds: 1, avgCostUsd: 1.5, avgTotalTokens: 80_000, avgInputTokens: 68_000, avgOutputTokens: 8_000, avgCacheTokens: 4_000, avgReasoningTokens: 0, tokenSampleRate: 1, avgMinutes: 9 }],
    globalEffortStats: [],
  });
  check("every dispatchable model is offered by exact id", CANDIDATES.every((c) => prompt.includes(c.model)), "a candidate is missing from the roster block");
  check("each candidate's exact effort set is offered", CANDIDATES.every((c) => prompt.includes(`effort ${c.efforts.join(" | ")}`)), "candidate effort coverage missing");
  check("the planner's read of the repo is included", prompt.includes("web/src/x.tsx"), "plan text missing");
  check("the repo's own history is included", prompt.includes("avg score 88"), "repo stats missing");
  check("the global history is included", prompt.includes("avg score 52"), "global stats missing");
  check("the brief is included", prompt.includes("dark-mode toggle"), "brief missing");
  // Cheapest-capable is the whole policy; a prompt that lost it would quietly drift to "always Opus".
  check("the cheapest-capable instruction survives", /CHEAPEST option you are confident/.test(prompt), "policy line missing");
  check("token burn is treated as cost even when dollars are zero", /subscription\/token-window burn.*\$0.*token burn/s.test(prompt), "token-cost policy missing");
  check("durable token totals reach the selector", prompt.includes("120K tokens"), "token history missing");
  check("effort-specific local outcomes reach the selector", prompt.includes("claude-sonnet-4-6 @ medium"), "effort history missing");
  check("LiveBench is framed as a secondary effort/category prior", /LiveBench.*secondary capability prior.*category scores.*smallest reasoning effort/s.test(prompt), "benchmark weighting guidance missing");
}

{
  const empty = buildSelectionPrompt({
    title: "t",
    workspace: "C:\\repo",
    brief: "b",
    candidates: CANDIDATES,
    efforts: EFFORTS,
    repoStats: [],
    globalStats: [],
  });
  check("with no history the prompt says so instead of implying zeros", empty.includes("no graded tasks yet"), "empty-history note missing");
}

console.log("\n=== the call itself (fetch stubbed — no token, no quota) ===\n");

type FetchArgs = Parameters<typeof fetch>;
const realFetch = globalThis.fetch;
let sent: string[] = [];
function stubModel(replies: string[]): void {
  sent = [];
  const queue = [...replies];
  globalThis.fetch = (async (_url: FetchArgs[0], init?: FetchArgs[1]) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[]; model: string };
    sent.push(body.messages[0]!.content);
    const text = queue.shift() ?? "";
    return { status: 200, json: async () => ({ content: [{ type: "text", text }] }), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
}

const baseCtx = {
  title: "t",
  workspace: "C:\\repo",
  brief: "b",
  candidates: CANDIDATES,
  efforts: EFFORTS,
  repoStats: [],
  globalStats: [],
};

{
  stubModel(['{"model":"claude-sonnet-4-6","effort":"medium","reason":"ordinary feature work"}']);
  const pick = await selectImplementorModel(baseCtx, "tok", "claude-sonnet-4-6");
  check("a usable reply becomes a pick in one call", pick?.model === "claude-sonnet-4-6" && sent.length === 1, `${JSON.stringify(pick)} calls=${sent.length}`);
}

{
  // A model that named something off-roster gets ONE corrective retry — telling it plainly to copy an id
  // usually works, and the alternative (giving up) costs the whole feature for that task.
  stubModel(['{"model":"gpt-4o","effort":"high","reason":"nope"}', '{"model":"glm-4.7","effort":"high","reason":"fine"}']);
  const pick = await selectImplementorModel(baseCtx, "tok", "claude-sonnet-4-6");
  check("an off-roster reply is retried once, then accepted", pick?.model === "glm-4.7" && sent.length === 2, `${JSON.stringify(pick)} calls=${sent.length}`);
  check("the retry tells the model exactly what went wrong", /copied EXACTLY/.test(sent[1] ?? ""), "no corrective suffix");
}

{
  stubModel(['{"model":"gpt-4o","effort":"high","reason":"nope"}', "still not a model id"]);
  const pick = await selectImplementorModel(baseCtx, "tok", "claude-sonnet-4-6");
  check("two unusable replies give up (caller falls back to normal routing)", pick === null && sent.length === 2, `${JSON.stringify(pick)} calls=${sent.length}`);
}

{
  stubModel(['{"model":"claude-sonnet-4-6","effort":"high","reason":"x"}']);
  const noToken = await selectImplementorModel(baseCtx, undefined, "claude-sonnet-4-6");
  check("no subscription token → no pick and no call", noToken === null && sent.length === 0, `${JSON.stringify(noToken)} calls=${sent.length}`);
}

{
  stubModel(['{"model":"claude-sonnet-4-6","effort":"high","reason":"x"}']);
  const only = await selectImplementorModel({ ...baseCtx, candidates: [CANDIDATES[1]!] }, "tok", "claude-sonnet-4-6");
  check("one dispatchable model → taken without paying for a call", only?.model === "claude-sonnet-4-6" && sent.length === 0, `${JSON.stringify(only)} calls=${sent.length}`);
  const none = await selectImplementorModel({ ...baseCtx, candidates: [] }, "tok", "claude-sonnet-4-6");
  check("no dispatchable model → null, no call", none === null && sent.length === 0, JSON.stringify(none));
}

globalThis.fetch = realFetch;

console.log("\n=== the score ===\n");

check("an accepted task is a 100", scoreOutcome("done", 1) === 100, String(scoreOutcome("done", 1)));
check("reaching QA once is free", scoreOutcome("done", 1) === scoreOutcome("done", 0), "a first QA round was penalised");
check("each fix-round past the first costs 12", scoreOutcome("done", 3) === 76, String(scoreOutcome("done", 3)));
check("the QA penalty is capped", scoreOutcome("done", 12) === 64, String(scoreOutcome("done", 12)));
check("landing on a human is a 40", scoreOutcome("review", 1) === 40, String(scoreOutcome("review", 1)));
check("a failure is a 0", scoreOutcome("failed", 1) === 0, String(scoreOutcome("failed", 1)));
check("the score never goes negative", (scoreOutcome("failed", 9) ?? -1) === 0, String(scoreOutcome("failed", 9)));
// The ordering that makes the scale worth having: a finished task, however many rounds it took, still
// beats one that had to be handed to a person.
check("a 4-round finish still outranks a first-round hand-off", (scoreOutcome("done", 4) ?? 0) > (scoreOutcome("review", 1) ?? 0), `${scoreOutcome("done", 4)} vs ${scoreOutcome("review", 1)}`);
check("a cancelled task is never scored", scoreOutcome("cancelled", 1) === null, String(scoreOutcome("cancelled", 1)));

console.log("\n=== what counts as evidence ===\n");

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: "r",
  threadId: "t",
  role: "implementor",
  model: "claude-sonnet-4-6",
  state: "done",
  costUsd: 1,
  numTurns: 10,
  tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 5, reasoningOutputTokens: 0, totalTokens: 120 },
  startedAt: 0,
  ...over,
});
const facts = {
  state: "done" as const,
  runs: [run({}), run({ id: "r2", role: "qa", model: "claude-opus-4-8", costUsd: 2, numTurns: 20 })],
  qaRounds: 1,
  dispatchedAt: 0,
  settledAt: 600_000,
  capParked: false,
  restartInterrupted: false,
};

{
  const g = gradeSettledTask(facts);
  check("a settled task grades", g?.score === 100, JSON.stringify(g));
  check("cost is the WHOLE task's, not just the implementor's", g?.costUsd === 3, String(g?.costUsd));
  check("turns are summed across the task", g?.numTurns === 30, String(g?.numTurns));
  check("token burn is summed across the whole pipeline", g?.tokenUsage?.totalTokens === 240, JSON.stringify(g?.tokenUsage));
  check("one implementor model → that model is credited", g?.gradedModel === "claude-sonnet-4-6", String(g?.gradedModel));
  check("wall-clock is recorded", g?.durationMs === 600_000, String(g?.durationMs));
}

{
  // A cap-failover mid-task means the work was done by two different models. Crediting either one would
  // be a lie, so it scores but reaches no model's average.
  const split = gradeSettledTask({ ...facts, runs: [...facts.runs, run({ id: "r3", model: "gpt-5.6-sol" })] });
  check("a task split across two models credits neither", split?.gradedModel === null, String(split?.gradedModel));
  check("…but is still recorded with both named", split?.ranModels === "claude-sonnet-4-6, gpt-5.6-sol", String(split?.ranModels));
}

check("a quota park is not a verdict about the model", gradeSettledTask({ ...facts, state: "review", capParked: true }) === null, "graded a cap park");
check("a restart casualty is not either", gradeSettledTask({ ...facts, state: "failed", restartInterrupted: true }) === null, "graded a restart casualty");
check("a task still running is not graded", gradeSettledTask({ ...facts, state: "implementing" }) === null, "graded a live task");
check(
  "a failure before any implementor ran is not the model's fault",
  gradeSettledTask({ ...facts, state: "failed", runs: [run({ role: "planner" })] }) === null,
  "graded a task no implementor touched",
);
check("outcomeOfState maps only the settled states", outcomeOfState("qa") === null && outcomeOfState("review") === "review", "state mapping drifted");

console.log("\n=== provider token normalization ===\n");
const claudeUsage = claudeTokenUsage({
  "claude-opus": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 5 },
  "claude-sonnet": { inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 7, cacheCreationInputTokens: 0 },
});
check("Claude mixed-model usage is fully summed", claudeUsage?.totalTokens === 212 && claudeUsage.cacheReadInputTokens === 37, JSON.stringify(claudeUsage));
const codexUsage = codexTokenUsage({ input_tokens: 100, cached_input_tokens: 60, output_tokens: 25, reasoning_output_tokens: 10, total_tokens: 125 });
check("Codex preserves cache/reasoning detail without double-counting total", codexUsage?.totalTokens === 125 && codexUsage.cacheReadInputTokens === 60 && codexUsage.reasoningOutputTokens === 10, JSON.stringify(codexUsage));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
