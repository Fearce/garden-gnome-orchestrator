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
 *  - The z.ai catalog parse, which decides which GLM models the selector may pick from at all. It is the
 *    one backend with no CLI cache to cross-check it, so a bad parse silently shrinks the roster.
 *
 * Run:  npm run test:model-select   (from server/)   — or:  npx tsx src/tests/modelSelection.test.ts
 */

import { buildSelectionPrompt, modelNote, parseSelection, selectImplementorModel, type ModelCandidate } from "../orchestrator/modelSelector.js";
import { gradeSettledTask, outcomeOfState, scoreOutcome } from "../orchestrator/modelGrading.js";
import { CURATED_CODEX_MODELS, fetchZaiModels } from "../agents/modelCatalog.js";
import { WAKE_MODEL } from "../agents/codexUsagePing.js";
import { claudeTokenUsage } from "../agents/runner.js";
import { codexTokenUsage } from "../agents/codexRunner.js";
import { providerIntent } from "../orchestrator/providerIntent.js";
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
  {
    provider: "codex",
    model: "gpt-5.6-sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    note: modelNote("codex", "gpt-5.6-sol"),
    capacity: "Codex general pool: 5h 42% free (resets in 2h) — enough runway for substantial implementation",
  },
  { provider: "zai", model: "glm-4.7", efforts: ["low", "medium", "high"], note: modelNote("zai", "glm-4.7") },
];
const EFFORTS: Effort[] = ["low", "medium", "high", "max", "ultra"];
const CTX = { candidates: CANDIDATES, efforts: EFFORTS };

// These are the exact persisted briefs from the two tasks whose provider-intent gate failed before
// either could start. Keep the full prose: the regression is the interaction between a routing
// directive and unrelated capacity/disruption language far later in the same real-world prompt.
const FAILED_PROVIDER_INTENT_BRIEFS = {
  "0587c3f4-8bc7-4ef7-8406-cfa49b196fea": `Investigate and permanently fix the wrongful capacity freeze observed on active task fe529d83-61fc-4e77-93d1-098e67e3598e (“Retrieve bearer token and configure keyboard input”). Do not interrupt, restart, inject into, or otherwise disrupt that task: it auto-resumed around 15:19 on codex:gpt-5.6-terra and must continue.

Incident facts to trace from exact persisted run history, routing decisions, capacity telemetry, supervisor/resume events, and deployment/restart records: around 15:17 the task was parked claiming all compatible implementor capacity was capped and advertising next capacity in 28m. At that time the Codex UI reportedly showed roughly 33% five-hour capacity remaining and Codex general weekly capacity healthy. A QA run was interrupted around the deployment/restart, an immediately-following Claude retry was capped, and Codex was only selected on the next supervisor sweep roughly two minutes later. Determine the precise race/ordering/staleness/error-classification cause(s), including why usable Codex was excluded initially and why the user-facing park message predicted 28m despite viable Codex capacity.

Implement a general, robust fix—not a one-off override—for capacity reservation/routing, failover, supervisor resumption, interrupted QA handling, and park-message eligibility/next-reset calculation as applicable. Preserve intended safeguards: model-pool-specific limits, provider compatibility, meaningful runway checks, and no dispatch onto genuinely exhausted capacity. Ensure a viable Codex pool is considered promptly when Claude caps or a restart interrupts QA, and that displayed wait estimates never imply all capacity is blocked when an eligible compatible pool is available.

Add focused regression coverage reproducing this incident’s ordering/race and verifying immediate correct Codex selection or accurate non-park behavior, plus correct park-message wording/calculation. Run the relevant targeted tests and broader gates proportionate to the changed routing logic. Inspect existing decisions/docs before proposing architectural changes; retain established capacity-aware routing behavior where correct.

Work on the active branch, commit using Conventional Commits, and push when complete unless the origin is Vota (then commit only, never push). Because this changes server code on Windows, deploy via the supported \`npm run deploy --prefix server\` atomic deployment path—not stop/start or a hand-built shared artifact—then verify the live build with the supported verification path after resume. Leave a concise evidence-backed handoff covering root cause, fix, tests, deployment/live verification, and any remaining risk. No placeholders or half-measures.`,
  "91dfc2bc-da27-418b-86f1-6a8bb07d1eb7": `Repair both related orchestration defects and deploy the fix.

Routing directive: run the implementor on Codex. Codex is expressly allowed and required for this repair. Capacity safeguards apply to individual model pools and real-time availability; they must not be converted into a provider-level exclusion. The prior task 0587c3f4-8bc7-4ef7-8406-cfa49b196fea failed immediately because provider-intent routing falsely classified its capacity-safety language as excluding Codex. Fix that classification and add a regression reproducing this exact failed-task intent: an explicit Codex requirement plus discussion of pool exhaustion/safe dispatch must route to Codex rather than fail as incompatible.

Also complete the original incident repair for active Android task fe529d83-61fc-4e77-93d1-098e67e3598e (“Retrieve bearer token and configure keyboard input”). Around 15:17 it was parked as all compatible implementor capacity capped with next capacity in 28m despite approximately 33% Codex five-hour capacity and healthy Codex general weekly capacity. It auto-resumed around 15:19 on codex:gpt-5.6-terra. Trace exact persisted run history, provider/model intent, capacity telemetry, reservation decisions, supervisor/resume events, and deployment/restart records. Pay particular attention to the QA interruption around deployment/restart, the immediately capped Claude retry, why a viable Codex route was selected only on the next supervisor sweep, and why the park message advertised 28m. Implement a general race-safe fix across routing, capacity reservation, failover, interrupted-QA recovery, supervisor resumption, and user-facing park-message calculation as warranted. Add regressions for this exact sequence as well as the provider-intent incident.

Preserve genuine capacity protections and correct pool-specific fallback behavior. A task must promptly use an eligible viable Codex pool; a truly unavailable pool must not make Codex itself ineligible or produce a misleading all-capacity park statement.

Do not manually interrupt, inject into, pause, or otherwise alter the currently running Android task fe529d83-61fc-4e77-93d1-098e67e3598e. Avoid unnecessary disruption; if server deployment necessarily triggers the platform’s designed restart/resume path, use only the supported Windows atomic deployment flow and confirm the Android task resumes safely afterward.

Use the active branch, inspect established decisions before architectural changes, run focused and proportionate broader tests, commit with a Conventional Commit, and push unless the origin is Vota (then commit only). Because server code changes are expected, deploy via \`npm run deploy --prefix server\` only; never stop/start or hand-build the shared artifact. After automatic resume, run the supported live verification and leave evidence of root causes, regressions, deployment, live-build verification, and active Android-task continuity. No placeholders or partial fixes.`,
} as const;

console.log("\n=== auto model selection — reply validation ===\n");

{
  const explicit = providerIntent("Kevin explicitly requires this recovery to run on GPT, not Grok. Do not route it to Grok.");
  check("an explicit GPT instruction resolves to Codex", explicit.preferred === "codex", String(explicit.preferred));
  check("an explicit negative provider instruction is preserved", explicit.excluded.has("grok"), JSON.stringify([...explicit.excluded]));
  const diagnostic = providerIntent("Grok produced no events within 60s and failed the startup watchdog.");
  check("an error report that merely names Grok is not a routing instruction", diagnostic.preferred === undefined && diagnostic.excluded.size === 0, JSON.stringify(diagnostic));
  const clauses = providerIntent("Do not use Codex; switch to Claude.");
  check("provider intent respects clause boundaries", clauses.preferred === "claude" && clauses.excluded.has("codex") && !clauses.excluded.has("claude"), JSON.stringify({ preferred: clauses.preferred, excluded: [...clauses.excluded] }));
  const providerFirstExclusion = providerIntent("Codex is not allowed for this task; use Claude.");
  check("a true provider-first Codex exclusion still wins", providerFirstExclusion.preferred === "claude" && providerFirstExclusion.excluded.has("codex"), JSON.stringify({ preferred: providerFirstExclusion.preferred, excluded: [...providerFirstExclusion.excluded] }));
  const passiveExclusion = providerIntent("Codex must not be used for this task. Use Claude.");
  check("a true passive Codex exclusion still wins", passiveExclusion.preferred === "claude" && passiveExclusion.excluded.has("codex"), JSON.stringify({ preferred: passiveExclusion.preferred, excluded: [...passiveExclusion.excluded] }));
  const reasonedExclusion = providerIntent("Codex is not allowed for this task because its capacity is unreliable. Use Claude.");
  check("a capacity rationale does not erase a genuine provider ban", reasonedExclusion.preferred === "claude" && reasonedExclusion.excluded.has("codex"), JSON.stringify({ preferred: reasonedExclusion.preferred, excluded: [...reasonedExclusion.excluded] }));
  const dynamicPoolGuard = providerIntent("Codex must not be used when its general pool is exhausted. Use Claude until capacity returns.");
  check("a dynamic pool safeguard is not frozen into a provider exclusion", dynamicPoolGuard.preferred === "claude" && !dynamicPoolGuard.excluded.has("codex"), JSON.stringify({ preferred: dynamicPoolGuard.preferred, excluded: [...dynamicPoolGuard.excluded] }));
  const retainCodex = providerIntent("Use Codex. Do not exclude Codex and do not switch away from Codex.");
  check("negated exclusions and retention language preserve Codex", retainCodex.preferred === "codex" && !retainCodex.excluded.has("codex"), JSON.stringify({ preferred: retainCodex.preferred, excluded: [...retainCodex.excluded] }));
}

{
  const wrongfulFreeze = providerIntent(FAILED_PROVIDER_INTENT_BRIEFS["0587c3f4-8bc7-4ef7-8406-cfa49b196fea"]);
  check(
    "exact task 0587 brief does not turn its disruption warning into a Codex exclusion",
    !wrongfulFreeze.excluded.has("codex"),
    JSON.stringify({ preferred: wrongfulFreeze.preferred, excluded: [...wrongfulFreeze.excluded] }),
  );

  const repair = providerIntent(FAILED_PROVIDER_INTENT_BRIEFS["91dfc2bc-da27-418b-86f1-6a8bb07d1eb7"]);
  check(
    "exact task 91df brief preserves its required Codex route",
    repair.preferred === "codex" && !repair.excluded.has("codex"),
    JSON.stringify({ preferred: repair.preferred, excluded: [...repair.excluded] }),
  );

  for (const directive of [
    "Use Codex. Do not use an exhausted Codex model pool; choose a viable pool.",
    "Codex is allowed. Avoid capped Codex capacity and preserve healthy pools.",
    "Codex is required. Do not dispatch onto exhausted capacity or disrupt running tasks.",
    "Use Codex. Avoid disrupting the active Codex task while this repair runs.",
  ]) {
    const intent = providerIntent(directive);
    check(
      `positive Codex directive survives unrelated safety prose: ${directive.split(".")[0]}`,
      intent.preferred === "codex" && !intent.excluded.has("codex"),
      JSON.stringify({ preferred: intent.preferred, excluded: [...intent.excluded] }),
    );
  }
}

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
  const lowOnly = parseSelection('{"model":"glm-4.7","effort":"xhigh","reason":"x"}', {
    candidates: [{ ...CANDIDATES[4]!, efforts: ["low"] }],
    efforts: ["low"],
  });
  check("effort fallback respects an operator-capped roster", lowOnly?.effort === "low", JSON.stringify(lowOnly));
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
  check("exact live pool capacity reaches the model roster", prompt.includes("Live capacity: Codex general pool: 5h 42% free"), "capacity line missing");
  check("the selector must avoid at-risk pools for substantial work", /Do not put substantial work on an at-risk pool/.test(prompt), "runway policy missing");
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
  const lowOnly = await selectImplementorModel({ ...baseCtx, candidates: [{ ...CANDIDATES[1]!, efforts: ["low"] }], efforts: ["low"] }, "tok", "claude-sonnet-4-6");
  check("one dispatchable model still respects its advertised effort cap", lowOnly?.effort === "low" && sent.length === 0, `${JSON.stringify(lowOnly)} calls=${sent.length}`);
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

// z.ai's models endpoint answers OLDEST-first, and every picker in this app reads list position as
// capability, so the ordering is the load-bearing part of the parse.
// Under ChatGPT-plan auth `config.codex.models` is the ENTIRE Codex roster auto-select can reach, and
// the usage ping separately asserts its wake model runs on that auth. A model good enough to wake the
// 5h window but missing from the roster is a model the selector can never pick — the shape of the
// regression that quietly cut the Codex roster from five models to three.
check(
  "the Codex model the usage ping wakes with is one auto-select can also pick",
  (CURATED_CODEX_MODELS as readonly string[]).includes(WAKE_MODEL),
  `${WAKE_MODEL} not in ${CURATED_CODEX_MODELS.join(",")}`,
);

const respondWith = (body: string, status: number): void => {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
};
try {
  respondWith(JSON.stringify({ data: [
    { id: "glm-4.6", created_at: "2025-10-01T08:00:00Z" },
    { id: "glm-5.3", created_at: "2026-08-14T00:00:00Z" },
    { id: "glm-5.3-flash", created_at: "2026-08-14T00:00:00Z" },
    { id: "glm-4.7", created_at: "2025-12-22T00:00:00Z" },
    { id: "text-embedding-3", created_at: "2026-01-01T00:00:00Z" },
  ] }), 200);
  const zaiModels = await fetchZaiModels("test-key");
  check("the z.ai catalog is ordered newest-first", zaiModels.join(",") === "glm-5.3,glm-5.3-flash,glm-4.7,glm-4.6", zaiModels.join(","));
  check("a non-GLM entry never reaches a GLM picker", !zaiModels.includes("text-embedding-3"), zaiModels.join(","));

  respondWith("unauthorized", 401);
  let rejected = false;
  try {
    await fetchZaiModels("bad-key");
  } catch {
    rejected = true;
  }
  check("a rejected z.ai catalog fetch throws, so the last-known list is kept instead of blanked", rejected);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
