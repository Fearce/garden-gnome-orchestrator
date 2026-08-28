/**
 * Unit test — the deterministic route-selection classifier (orchestrator/routeSelection.ts).
 *
 * Pure function, no Db/EventHub/ThreadManager: every case here is a direct input → RouteDecision check.
 * The pipeline-wiring side (does runPipeline actually skip/keep the planner and QA per the decision, does
 * an escalation force the full route, is the pick sticky/announced) is covered by
 * server/src/tests/routeSelection.itest.ts and the reader escalation section of reader.itest.ts.
 *
 * Run:  npm run test:route-selection   (from server/)   — or:  npx tsx src/tests/routeSelection.test.ts
 */

import { selectRoute, type RouteInput } from "../orchestrator/routeSelection.js";

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

function route(brief: string, extra: Partial<RouteInput> = {}) {
  return selectRoute({ title: "task", brief, ...extra });
}

console.log("routeSelection — deterministic planner/QA route classifier");

// ---- narrow: the brief's own example shapes -----------------------------------------------------
console.log("\nNarrow, contained changes → implementor only");
{
  const d = route("Fix the typo in the README: 'recieve' should be 'receive'.");
  check("typo fix routes narrow", d.scope === "narrow", JSON.stringify(d));
  check("typo fix skips the planner", d.usePlanner === false);
  check("typo fix skips QA", d.useQa === false);
  check("reason names a signal", d.reason.length > 0 && d.signals.length > 0);
}
{
  const d = route("Rename the `getUserData` function in src/utils.ts to `fetchUserProfile`.");
  check("single-file rename routes narrow", d.scope === "narrow", JSON.stringify(d));
}
{
  const d = route("Bump the lodash dependency version to 4.17.21.");
  check("version bump routes narrow", d.scope === "narrow", JSON.stringify(d));
}
{
  const d = route("Fix the off-by-one error in the pagination calculation in utils.ts.");
  check("well-scoped one-file bug fix routes narrow", d.scope === "narrow", JSON.stringify(d));
}
{
  const d = route("Fix the typo in README.md, then run the test suite.");
  check("a contained change with explicit verification selects QA without planning", d.scope === "standard" && d.usePlanner === false && d.useQa === true, JSON.stringify(d));
}
{
  const d = selectRoute({
    title: "read: fix a README typo",
    brief: "Fix the typo in README.md.",
    readerEscalation: { reason: "requires an edit", answer: "The typo is in README.md." },
  });
  check("a reader escalation for an obvious narrow edit does not force planner or QA", d.scope === "narrow" && d.usePlanner === false && d.useQa === false, JSON.stringify(d));
}

// ---- broad/risky: every explicit dimension named in the brief ------------------------------------
console.log("\nBroad or risk-bearing work → keep planning + QA");
{
  const d = route(
    "Add two-factor authentication to the login flow, including SMS and TOTP support, with a new database table for backup codes.",
  );
  check("auth + database change routes broad", d.scope === "broad", JSON.stringify(d));
  check("auth + database change keeps the planner", d.usePlanner === true);
  check("auth + database change keeps QA", d.useQa === true);
}
{
  const d = route("Update the payment checkout flow to support a new refund path.");
  check("payment/checkout work routes broad", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Write a migration to backfill the new column across the users table.");
  check("data migration routes broad", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Update the production deploy pipeline config to add a new CI/CD stage.");
  check("production/infra work routes broad", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Rewrite the whole codebase's error handling to a new pattern, system-wide.");
  check("explicit broad-scope wording routes broad", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Investigate why the dashboard is slow and fix it.");
  check("open-ended investigation routes broad (ambiguity signal)", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Figure out the best way to add rate limiting and design the approach.");
  check("figure-out/design wording routes broad", d.scope === "broad", JSON.stringify(d));
}

// ---- structural signals, independent of keywords --------------------------------------------------
console.log("\nStructural signals (file count, compound requests, effort, timed window)");
{
  const d = route("Update a.ts, b.ts, c.ts and d.ts to use the new logger.");
  check("touching 4+ files routes broad even with no risk keyword", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Add a loading spinner to the dashboard.\n- Also add a retry button.\n- Also add an error banner.");
  check("a bulleted multi-part request routes broad (compound)", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Small cleanup in one file.", { effortOverride: "max" });
  check("operator-pinned heavy effort routes broad even on a short brief", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Keep working on polishing the UI.", { timedHours: 8 });
  check("a multi-hour timed window routes broad", d.scope === "broad", JSON.stringify(d));
}
{
  const d = route("Improve things.", { shotgun: true });
  check("a shotgun (multi-agent) dispatch always routes broad", d.scope === "broad", JSON.stringify(d));
  check("shotgun keeps planner", d.usePlanner === true);
  check("shotgun keeps QA", d.useQa === true);
}

// ---- the conservative default: unclear cases keep the full route ----------------------------------
console.log("\nAmbiguous/unclear cases default to the full route (bias conservative)");
{
  const d = route(
    "Improve the onboarding flow so new users understand the product faster and convert better, revisiting copy, layout and the signup steps as needed.",
  );
  check("a longer, open-ended ask defaults to standard/broad, not narrow", d.scope !== "narrow", JSON.stringify(d));
}
{
  const d = route("");
  check("an empty brief never routes narrow (no confident signal)", d.scope !== "narrow", JSON.stringify(d));
}

// ---- determinism --------------------------------------------------------------------------------
console.log("\nDeterminism");
{
  const input: RouteInput = { title: "t", brief: "Add authentication to the API." };
  const a = selectRoute(input);
  const b = selectRoute(input);
  check("identical input yields an identical decision", JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
