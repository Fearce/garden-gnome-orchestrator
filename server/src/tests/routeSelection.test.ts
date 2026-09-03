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
  check("simple work keeps adaptive cheaper-model routing", d.modelPolicy?.tier === "adaptive", JSON.stringify(d.modelPolicy));
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
{
  const d = selectRoute({
    title: "read: update the logger",
    brief: "Update the logger references.",
    readerEscalation: { reason: "requires edits", answer: "The read found affected references in a.ts, b.ts, c.ts and d.ts." },
  });
  check("reader escalation evidence can broaden a short original brief", d.scope === "broad" && d.usePlanner === true && d.useQa === true, JSON.stringify(d));
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

// Regression class for the real long-closed-place incident: production data quality across ingestion,
// refresh, storage, caches, API/UI eligibility and an existing-data migration. This is intentionally a
// representative class, not a task-id exception or one magic title phrase.
{
  const d = route(`Investigate why stale business records remain visible to users and implement a durable end-to-end fix.

Trace the full lifecycle across ingestion sources, stored status timestamps, refresh jobs, query filters,
ranking, caches, and user-facing results. Handle existing data and future updates with a safe migration or
backfill, preserve auditability, and add realistic regressions for open, closed, temporary, and unknown states.`);
  check("cross-cutting production-data work routes broad", d.scope === "broad", JSON.stringify(d));
  check("cross-cutting production-data work requires a flagship", d.modelPolicy?.tier === "flagship", JSON.stringify(d.modelPolicy));
  check("Opus 5 is the persisted first choice", d.modelPolicy?.preferredModel === "claude-opus-5", JSON.stringify(d.modelPolicy));
  check("data-lifecycle evidence is explicit", d.modelPolicy?.signals.includes("production data lifecycle") === true, JSON.stringify(d.modelPolicy));
  check("migration/backfill evidence is explicit", d.modelPolicy?.signals.includes("data migration/backfill") === true, JSON.stringify(d.modelPolicy));
  check("authoritative/auditability prose is not misreported as auth risk", !d.signals.includes("security/auth"), JSON.stringify(d.signals));
  check("structural evidence is persisted for capacity routing", (d.evidence?.wordCount ?? 0) > 50 && (d.evidence?.compoundCount ?? 0) >= 1, JSON.stringify(d.evidence));
}

{
  const d = route("Investigate why this one selector returns the wrong label.");
  check("a short bounded investigation keeps adaptive model choice", d.scope === "broad" && d.modelPolicy?.tier === "adaptive", JSON.stringify(d));
}

// Anchoring the risk stems at BOTH ends is what stopped "authoritative" reading as auth work — and it
// silently dropped every inflected form at the same time. Owners write "users cannot authenticate" and
// "run the migrations", not "authentication" and "a migration", so pin the forms in both directions:
// a missed security or migration signal loses the flagship floor AND the planner/QA route at once.
console.log("\nRisk stems must match their real inflections without re-matching lookalike words");
for (const phrase of [
  "Users cannot authenticate after the last release.",
  "Only authorized accounts should reach this route.",
  "Rotate the leaked credentials.",
  "Permissions are wrong for shared folders.",
  "Sessions expire far too early.",
  "Stored passwords must be re-hashed.",
  "Payloads are no longer encrypted at rest.",
  "Two vulnerabilities were reported in the parser.",
]) {
  const d = route(phrase);
  check(`"${phrase}" is security/auth risk`, d.signals.includes("security/auth"), JSON.stringify(d.signals));
  check(`"${phrase}" requires a flagship implementor`, d.modelPolicy?.tier === "flagship", JSON.stringify(d.modelPolicy));
}
for (const phrase of [
  "Run the migrations against the reporting replica.",
  "Backfilling rows for the new column.",
  "The databases disagree about the latest row.",
]) {
  const d = route(phrase);
  check(`"${phrase}" is data migration/backfill risk`, d.signals.includes("data migration/backfill"), JSON.stringify(d.signals));
}
for (const phrase of [
  "Show the author of each commit in the history list.",
  "Cite an authoritative source next to every figure.",
  "Rename the authority column to issuer.",
]) {
  const d = route(phrase);
  check(`"${phrase}" is not misread as security/auth`, !d.signals.includes("security/auth"), JSON.stringify(d.signals));
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
  check("heavy effort is a non-wording flagship signal", d.modelPolicy?.tier === "flagship" && d.modelPolicy.signals.includes("operator pinned max effort"), JSON.stringify(d.modelPolicy));
}
{
  const d = route("Keep working on polishing the UI.", { timedHours: 8 });
  check("a multi-hour timed window routes broad", d.scope === "broad", JSON.stringify(d));
  check("timed work is a non-wording flagship signal", d.modelPolicy?.tier === "flagship" && d.modelPolicy.signals.includes("multi-hour work window"), JSON.stringify(d.modelPolicy));
}
{
  const d = route("Improve things.", { shotgun: true });
  check("a shotgun (multi-agent) dispatch always routes broad", d.scope === "broad", JSON.stringify(d));
  check("shotgun keeps planner", d.usePlanner === true);
  check("shotgun keeps QA", d.useQa === true);
  check("multi-agent implementation requires a flagship", d.modelPolicy?.tier === "flagship", JSON.stringify(d.modelPolicy));
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
