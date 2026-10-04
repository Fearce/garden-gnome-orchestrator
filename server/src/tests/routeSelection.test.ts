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
  check("Opus 5.5 is the persisted first choice", d.modelPolicy?.preferredModel === "claude-opus-5-5", JSON.stringify(d.modelPolicy));
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

// ---- implementor effort: the fallback when neither an owner pin, a model pick nor a planner sets one ---
// With the planner off (or skipped by this very route), nothing else sizes the implementor's effort, and
// the automatic model pick starts from it. Medium is the default for ordinary work; high is earned by a
// correctness-critical risk or real complexity evidence; max is never chosen automatically — only an
// owner pin reaches it (see `routeImplementorEffort`'s doc comment).
console.log("\nImplementor effort fits the classified work");
{
  const effortOf = (brief: string, extra: Partial<RouteInput> = {}) => route(brief, extra).implementorEffort;
  check("a typo fix runs at low effort", effortOf("Fix the typo in the README: 'recieve' should be 'receive'.") === "low", String(effortOf("Fix the typo in the README: 'recieve' should be 'receive'.")));
  check("a version bump runs at low effort", effortOf("Bump the version to 2.4.1.") === "low", String(effortOf("Bump the version to 2.4.1.")));
  check("a short narrow ask with no small-change wording gets medium, not low", effortOf("wat pls fix the broken button") === "medium", String(effortOf("wat pls fix the broken button")));
  check("a contained change with explicit verification gets medium", effortOf("Fix the typo in README.md, then run the test suite.") === "medium", String(effortOf("Fix the typo in README.md, then run the test suite.")));
  const ordinary = "Expand the screensaver text area so it uses the full vertical space below each house, and keep the fade at the bottom edge.";
  check("an ordinary not-obviously-contained change gets medium", route(ordinary).scope === "standard" && effortOf(ordinary) === "medium", JSON.stringify(route(ordinary)));
  check("a bounded investigation (broad, no scale) gets medium, not high", effortOf("Investigate why this one selector returns the wrong label.") === "medium", String(effortOf("Investigate why this one selector returns the wrong label.")));
  check("a small multi-part request gets medium, not high", effortOf("Add a loading spinner to the dashboard.\n- Also add a retry button.\n- Also add an error banner.") === "medium", String(effortOf("Add a loading spinner to the dashboard.\n- Also add a retry button.\n- Also add an error banner.")));
  check("production/infra work without correctness-critical scale gets medium", effortOf("Update the production deploy pipeline config to add a new CI/CD stage.") === "medium", String(effortOf("Update the production deploy pipeline config to add a new CI/CD stage.")));
  check("a new-design-surface mention alone gets medium", effortOf("Introduce a new integration with the calendar API.") === "medium", String(effortOf("Introduce a new integration with the calendar API.")));
  check("a short security phrase is correctness-critical: high, not medium", effortOf("User sessions expire far too early.") === "high", String(effortOf("User sessions expire far too early.")));
  const critical = `Investigate why stale business records remain visible to users and implement a durable end-to-end fix.

Trace the full lifecycle across ingestion sources, stored status timestamps, refresh jobs, query filters,
ranking, caches, and user-facing results. Handle existing data and future updates with a safe migration or
backfill, preserve auditability, and add realistic regressions for open, closed, temporary, and unknown states.`;
  check("substantial correctness-critical data work gets high — never max without an owner pin", effortOf(critical) === "high", String(effortOf(critical)));
  const bigNonCritical = `Refactor the reporting dashboard across the codebase.
- Update charts.tsx, widgets.tsx, dashboard.ts and layout.css.
- Also rework the export pipeline in exporter.ts.`;
  check("a large non-critical multi-file rewrite gets high (real complexity evidence)", effortOf(bigNonCritical) === "high", String(effortOf(bigNonCritical)));
  check("a multi-agent split gets high", effortOf("Improve things.", { shotgun: true }) === "high", String(effortOf("Improve things.", { shotgun: true })));
  check("a multi-hour timed window gets high", effortOf("Keep working on polishing the UI.", { timedHours: 8 }) === "high", String(effortOf("Keep working on polishing the UI.", { timedHours: 8 })));
  check("an owner-pinned max does not turn the route's own effort into max", effortOf("Small cleanup in one file.", { effortOverride: "max" }) === "high", String(effortOf("Small cleanup in one file.", { effortOverride: "max" })));
  check("every route carries an effort", ["", "Improve things.", "Rename foo to bar in a.ts."].every((b) => typeof effortOf(b) === "string"));
  check("every route explains its effort", ["", "Improve things.", critical, bigNonCritical].every((b) => !!route(b).effortReason));
}

// ---- the owner's real briefs: routine work must not escalate ---------------------------------------
// The Director closes almost every brief with the same guardrails ("Never force-push, never --no-verify",
// "deploy per the repo's process") and writes several hundred words even for a contained fix. Neither is
// evidence that the work is hard.
console.log("\nRoutine Director briefs stay at medium");
{
  // Task a1460046 (2026-09-30): a contained UI classification bug plus a regression test. It ran at MAX
  // because "Never force-push" read as data-migration risk and its length read as scale.
  const narration = `BUG: In the GGO task detail view, implementor narration and thinking messages get classified as "tools" noise. When Robin filters tools out using the "TOOLS" toggle, prose messages that are clearly the implementor talking disappear along with the raw tool calls. They should stay visible.

SCREENSHOT (Robin attached): The task panel for "Auto-deploy app.example.com on every push to main" (task 86e05fa7, 3m 54s, MAX effort, IMPLEMENTING). The filter chips read "ALL 29", "DIRECTOR DIR 3", "IMPLEMENTOR IMPL 26", and a "TOOLS" toggle button. The feed shows:
- A tool-result block with memory file content ("name: Shipping a change means DEPLOYING it to production…").
- IMPLEMENTOR (Pipewright Pim, Opus 5.5 Max) 02:06:19 PM: a Bash tool call.
- IMPLEMENTOR 02:06:22 PM: an ssh Bash tool call.
- IMPLEMENTOR, circled in red by Robin: an entry with a thought-bubble icon, in italic text: "I found two manual deploy scripts in the repo. Before writing the workflow, I'll verify which host is currently serving app.example.com."
Robin: "this message should not have been hidden under 'TOOLS' - this reads like an actual implementor message that should be visible even with tools filtered out."

WHAT TO DO:
- Find how feed entries are classified for the TOOLS filter (client and/or server event typing). Classify them by the real message kind: assistant prose/narration/thinking stays visible when tools are hidden. Only actual tool calls and tool results get hidden.
- Check every agent role (planner, researcher, implementor, QA, director) and both providers (Claude and Codex event shapes), so narration is never hidden by the tools filter. That includes messages that were persisted before the fix and are replayed from history, not just live streams.
- Add a regression test covering the classification.
- No stubs or half-measures. Keep the existing visual style.

DONE: With TOOLS filtered out, messages like the circled one stay visible and tool calls/results stay hidden. The test passes, the build succeeds, and the fix is deployed/restarted per the repo's own process so the live GGO shows it. Commit and push. Never force-push, never --no-verify. Work on the active branch, no worktrees.`;
  const d = selectRoute({ title: "Show implementor narration when tool messages are filtered", brief: narration });
  check("the a1460046 UI bug-fix brief runs at medium", d.implementorEffort === "medium", `${d.implementorEffort} — ${d.effortReason} — ${d.signals.join("; ")}`);
  check("its 'Never force-push' guardrail is not data-migration risk", !d.signals.includes("data migration/backfill"), d.signals.join("; "));

  const words = route("Raise the max retry count for the uploader and lower the high-water mark on the queue; show the maximum in the status bar.");
  check("a brief that merely says 'max'/'high'/'maximum' is not escalated", words.implementorEffort !== "high" && words.implementorEffort !== "max", `${words.implementorEffort} — ${words.effortReason}`);
  const thorough = route("Be thorough: fix the date picker so it keeps the selected month after closing, and add a test for it. High priority.");
  check("'thorough' and 'high priority' in a brief are not an effort request", thorough.implementorEffort === "medium", `${thorough.implementorEffort} — ${thorough.effortReason}`);

  const guardrails = route("Fix the tooltip overlap on the task card.\nDo not touch the database or run migrations. Never force-push or use rm -rf.");
  check("prohibitions ('do not touch the database', 'never force-push') are not risk evidence", !guardrails.signals.includes("data migration/backfill"), guardrails.signals.join("; "));
  const realMigration = route("Migrate the users table to the new schema and backfill the display names. Never force-push.");
  check("a real migration still reads as data-migration risk beside a guardrail", realMigration.signals.includes("data migration/backfill") && realMigration.implementorEffort === "high", `${realMigration.implementorEffort} — ${realMigration.signals.join("; ")}`);
  const contrast = route("Don't touch the UI but migrate the settings table to the new schema.");
  check("a prohibition ends at 'but' — the work after it still counts", contrast.signals.includes("data migration/backfill"), contrast.signals.join("; "));

  const checkout = route("Another agent shares this checkout, so commit only your own hunks after fixing the sidebar width.");
  check("a git 'checkout' is not money/finance", !checkout.signals.includes("money/finance"), checkout.signals.join("; "));
  check("a real checkout flow still is", route("The checkout page double-charges on refresh.").signals.includes("money/finance"));
  const agentSession = route("A new step starts a fresh session that must re-read the plan before editing the sidebar.");
  check("an agent/SDK 'session' is not security/auth", !agentSession.signals.includes("security/auth"), agentSession.signals.join("; "));
  check("a login session still is", route("Login sessions expire after five minutes.").signals.includes("security/auth"));

  // A prohibition word in the MIDDLE of a sentence describes the defect, not a guardrail: cutting it would
  // drop the security signal and route a real authz bug narrow, with no QA and no flagship floor.
  const authzBug = route("The admin API never checks the user's permissions, so any user can delete accounts.");
  check("a mid-sentence 'never' describing a security bug keeps the security signal", authzBug.signals.includes("security/auth") && authzBug.useQa && authzBug.implementorEffort === "high", `${authzBug.scope}/${authzBug.implementorEffort} — ${authzBug.signals.join("; ")}`);
  const logoutBug = route("After logout the old session token must not still work, but today it does.");
  check("a mid-sentence 'must not' requirement keeps the security signal", logoutBug.signals.includes("security/auth"), logoutBug.signals.join("; "));
  const weBug = route("We never validate the JWT signature, so anyone can forge a token.");
  check("a 'we never …' defect description keeps the security signal", weBug.signals.includes("security/auth") && weBug.useQa, `${weBug.scope}/${weBug.implementorEffort} — ${weBug.signals.join("; ")}`);
  const youGuard = route("Fix the date picker alignment. You must not touch the auth middleware.");
  check("a 'you must not …' guardrail is still stripped", !youGuard.signals.includes("security/auth"), youGuard.signals.join("; "));
  const bulleted = route("Fix the sidebar width on narrow screens.\n- Never touch the auth middleware or the login form.\n- Keep the existing session cookies as they are.\n1) Don't run the database migrations.");
  check("bulleted and numbered guardrails are still stripped", !bulleted.signals.includes("security/auth") && !bulleted.signals.includes("data migration/backfill"), bulleted.signals.join("; "));
  const chained = route("Tidy the settings panel spacing. Commit and push, never force-push the migration branch, never --no-verify.");
  check("a comma-chained 'never' guardrail is still stripped", !chained.signals.includes("data migration/backfill"), chained.signals.join("; "));

  // Task 86e05fa7: a CI deploy workflow that handles SSH secrets — risky, so high is fair; never max.
  const deploy = route(`GOAL: Set up CI/CD (GitHub Actions) so app.example.com automatically deploys on every push to main.
- Work out how app.example.com is deployed today and mirror the existing manual deploy path in CI.
- Secrets (SSH key, host, tokens) go in GitHub repo secrets. Never commit them.
- The workflow must end with a verification step that proves the live site serves the new commit.
Commit and push. Never force-push main, never --no-verify.`);
  check("the 86e05fa7 deploy-workflow brief runs at high at most", deploy.implementorEffort === "medium" || deploy.implementorEffort === "high", `${deploy.implementorEffort} — ${deploy.effortReason}`);
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
