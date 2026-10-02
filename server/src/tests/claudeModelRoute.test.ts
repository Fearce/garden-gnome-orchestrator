/**
 * Unit test — which Claude line a task's route implies (claudeModelRoute.ts), through the real route
 * classifier (routeSelection.ts) so the briefs read the way real ones do.
 *
 * Owner direction, 2026-10-02: Sonnet 5.5 for well-scoped "normal coding", Opus 5.5 for open-ended,
 * agentic or long work. The expensive direction is putting Sonnet on a long tool loop, so every
 * agentic signal must lock Opus, and only a tight plan may move a not-obviously-contained task to Sonnet.
 *
 * Run:  npm run test:claude-model-route   (from server/)
 */

import { isScopedSonnetModel, planClaudeModel, routeClaudeModel, SCOPED_SONNET_MODEL } from "../orchestrator/claudeModelRoute.js";
import { selectRoute } from "../orchestrator/routeSelection.js";
import type { ClaudeModelRoute, PlanOutput } from "../types.js";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const show = (route: ClaudeModelRoute | undefined): string => JSON.stringify(route);

console.log("\n=== claude model route — the route alone ===\n");

{
  const route = selectRoute({ title: "Fix typo in README", brief: "Fix the typo 'recieve' in README.md." });
  check("a narrow typo fix runs on Sonnet", route.scope === "narrow" && route.claudeModel?.tier === "sonnet", show(route.claudeModel));
  check("the reason says why, for the route note", /narrow, contained change/.test(route.claudeModel?.reason ?? ""), route.claudeModel?.reason);
}
{
  const route = selectRoute({ title: "Rename a setting label", brief: "Rename the 'Max QA rounds' label to 'QA fix rounds' in SettingsPanel.tsx and run the typecheck." });
  check(
    "a contained change with an explicit check (implementor + QA, no planner) runs on Sonnet",
    route.scope === "standard" && !route.usePlanner && route.claudeModel?.tier === "sonnet",
    `${route.scope} ${route.usePlanner} ${show(route.claudeModel)}`,
  );
}
{
  const route = selectRoute({ title: "Investigate flaky QA", brief: "Investigate why QA keeps timing out on the d2r repo and figure out the root cause." });
  check("an open-ended investigation stays on Opus", route.claudeModel?.tier === "opus", show(route.claudeModel));
  check("…and no plan can move it", route.claudeModel?.planRefinable === false, show(route.claudeModel));
}
{
  const route = selectRoute({ title: "Fix login", brief: "Users cannot authenticate after the session cookie expires; fix the login flow." });
  check("flagship risk (auth) stays on Opus, locked", route.claudeModel?.tier === "opus" && route.claudeModel.planRefinable === false, show(route.claudeModel));
}
{
  const route = selectRoute({ title: "Tweak copy", brief: "Change the button text to Save.", goalStep: true });
  check("a goal step stays on Opus however small it reads", route.claudeModel?.tier === "opus" && !route.claudeModel.planRefinable, show(route.claudeModel));
}
{
  const route = selectRoute({ title: "Tweak copy", brief: "Change the button text to Save.", timedHours: 0.5 });
  check("a duration window stays on Opus", route.claudeModel?.tier === "opus" && !route.claudeModel.planRefinable, show(route.claudeModel));
}
{
  const route = selectRoute({ title: "Tweak copy", brief: "Change the button text to Save.", shotgun: true });
  check("a multi-agent split stays on Opus", route.claudeModel?.tier === "opus" && !route.claudeModel.planRefinable, show(route.claudeModel));
}
{
  const route = selectRoute({ title: "Tweak copy", brief: "Change the button text to Save.", collaborator: true });
  check("a split's collaborator keeps the Opus line", route.claudeModel?.tier === "opus" && !route.claudeModel.planRefinable, show(route.claudeModel));
  check("…while its stages still follow its own narrow slice", route.scope === "narrow" && !route.usePlanner, `${route.scope} ${route.usePlanner}`);
}
{
  const route = selectRoute({
    title: "Add an export button",
    brief: "Add a CSV export button to the board header that downloads the visible tasks with their title, state and repository columns, using the existing download helper for the file.",
  });
  check("a not-obviously-contained brief starts on Opus", route.claudeModel?.tier === "opus", show(route.claudeModel));
  check("…but a plan may still move it", route.claudeModel?.planRefinable === true, show(route.claudeModel));
}
{
  const route = selectRoute({
    title: "Board polish",
    brief: "- Move the filter chips left\n- Add a count badge to each lane\n- Tighten the header spacing",
  });
  check("a multi-part brief starts on Opus, refinable by a plan", route.claudeModel?.tier === "opus" && route.claudeModel.planRefinable, show(route.claudeModel));
}

console.log("\n=== claude model route — the planner's plan ===\n");

const refinable = routeClaudeModel({ scope: "standard", usePlanner: true, flagshipSignals: [], riskHits: [], structural: [] });
const tight: PlanOutput = {
  summary: "Add the export button.",
  steps: [
    { title: "Button", detail: "Add the button.", files: ["web/src/components/Board.tsx"] },
    { title: "Export", detail: "Build the CSV.", files: ["web/src/lib/export.ts", "web/src/components/Board.tsx"] },
  ],
  risks: ["none"],
  openQuestions: [],
  effort: "medium",
};
{
  const judged = planClaudeModel(refinable, tight);
  check("a tight plan moves the task to Sonnet", judged.tier === "sonnet", show(judged));
  check("…counting distinct files", /2 steps, 2 files/.test(judged.reason), judged.reason);
  check("…and a judged line is final", judged.planRefinable === false, show(judged));
}
{
  const many = { ...tight, steps: [1, 2, 3, 4, 5].map((n) => ({ title: `Step ${n}`, detail: "x", files: ["a.ts"] })) };
  const judged = planClaudeModel(refinable, many);
  check("a plan of more than four steps stays on Opus", judged.tier === "opus" && /spans 5 steps/.test(judged.reason), show(judged));
}
{
  const wide = { ...tight, steps: [{ title: "All", detail: "x", files: ["a.ts", "b.ts", "c.ts", "d.ts"] }] };
  const judged = planClaudeModel(refinable, wide);
  check("a plan touching more than three files stays on Opus", judged.tier === "opus" && /touches 4 files/.test(judged.reason), show(judged));
}
{
  const vague = { ...tight, steps: [{ title: "Somewhere", detail: "find it" }] };
  check("a step without named files is not concrete", planClaudeModel(refinable, vague).tier === "opus");
}
{
  check("open questions keep Opus", planClaudeModel(refinable, { ...tight, openQuestions: ["Which format?"] }).tier === "opus");
  check("a high-effort plan keeps Opus", planClaudeModel(refinable, { ...tight, effort: "high" }).tier === "opus");
  check("a plan that needs research keeps Opus", planClaudeModel(refinable, { ...tight, nextAgent: "researcher" }).tier === "opus");
}
{
  const narrow = routeClaudeModel({ scope: "narrow", usePlanner: false, flagshipSignals: [], riskHits: [], structural: [] });
  const sprawling = { ...tight, steps: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `Step ${n}`, detail: "x", files: [`f${n}.ts`] })) };
  check("a plan can also widen a Sonnet route to Opus", planClaudeModel(narrow, sprawling).tier === "opus");
}
{
  const locked = routeClaudeModel({ scope: "broad", usePlanner: true, flagshipSignals: [], riskHits: ["open-ended/ambiguous"], structural: [] });
  check("a locked Opus line ignores even a tight plan", planClaudeModel(locked, tight).tier === "opus");
}

console.log("\n=== claude model route — which ids count as the scoped Sonnet ===\n");

check("Sonnet 5.5 is the scoped model", isScopedSonnetModel(SCOPED_SONNET_MODEL));
check("a newer Sonnet is too (newest-in-family)", isScopedSonnetModel("claude-sonnet-6"));
check("an older Sonnet is not", !isScopedSonnetModel("claude-sonnet-5") && !isScopedSonnetModel("claude-sonnet-4-6"));
check("Opus, Haiku and other backends are not", !isScopedSonnetModel("claude-opus-5-5") && !isScopedSonnetModel("claude-haiku-4-5-20251001") && !isScopedSonnetModel("gpt-6-luna"));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
