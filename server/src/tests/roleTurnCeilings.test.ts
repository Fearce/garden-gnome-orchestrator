/**
 * Unit gate — every bounded role's per-session turn ceiling is sized to the work that role does.
 *
 * A ceiling is invisible when it is wrong. Nothing fails, nothing errors: the run simply stops with
 * `error_max_turns` part-way through, the orchestrator spends a recovery budget waking it, and the cost
 * shows up as an extra Opus pass per task rather than as a red test. That is exactly how the QA role
 * drifted — 60 turns was set (ec58b40, 2026-06-15) when QA was READ-ONLY, and the editing mode shipped
 * six weeks later (059da69, "let reviewers apply fixes") without revisiting it. An agent that edits
 * files, builds, runs the suite and commits was left on a reviewer's budget: 14% of QA runs after that
 * date died at the ceiling, against 1% before it.
 *
 * So the assertions here are relational, not literal — pinning the numbers would just re-encode whatever
 * they happen to be. What must hold is that a role doing implementor-grade work gets an implementor-grade
 * budget, and that the sweep's classifier floor stays at or below every real ceiling.
 *
 * Run:  npm run test:role-ceilings   (from server/)
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { config } from "../config.js";
import { implementorConfig, qaConfig, readerConfig, reviewerConfig } from "../agents/roles.js";

const stub = { bus: {}, office: {}, git: {} } as never;
const cwd = process.cwd();

const readOnlyQa = qaConfig(cwd, stub, { applyFixes: false }).maxTurns;
const editingQa = qaConfig(cwd, stub, { applyFixes: true }).maxTurns;
const implementor = implementorConfig(cwd, stub).maxTurns;

assert.ok(readOnlyQa && editingQa && implementor, "every one of these roles must declare a ceiling");

// The defect this file exists for. Editing QA re-does the implementor's work — it edits, builds, runs
// the suite, commits and re-verifies — so anything less than the implementor's own budget guarantees a
// cutoff on the longer tasks, which is the shape production showed.
assert.ok(
  editingQa >= implementor,
  `QA in editing mode gets ${editingQa} turns against the implementor's ${implementor}. It does the same class of ` +
    "work, so a smaller budget only buys a turn-ceiling cutoff plus the recovery run that follows it.",
);

// ...and the two QA modes must stay distinguishable in the right direction. A reviewer that only reads a
// diff has no use for an editor's budget, and an unbounded read-only pass is its own kind of waste.
assert.ok(editingQa > readOnlyQa, `editing QA (${editingQa}) must get more turns than read-only QA (${readOnlyQa})`);

// The auto-reviewer and the reader are deliberately NOT in that class: both are read-only (Write/Edit
// hard-blocked in roles.ts), so they answer rather than build. Assert the intent, so widening either
// role's tools has to come past this line.
const reviewer = reviewerConfig(cwd, stub).maxTurns;
const reader = readerConfig(cwd, stub).maxTurns;
assert.ok(reviewer && reader && reviewer < editingQa && reader < editingQa, `read-only roles stay below the editing budget (reviewer ${reviewer}, reader ${reader})`);

// --- the sweep classifier's floor must not overtake a real ceiling ---------------------------------
// `probe:run-errors` classifies an OPAQUE row ("Run failed.", no reason) as a benign cutoff when its turn
// count is >= the role's ceiling, so that number is a FLOOR: raising it above a real ceiling files a genuine
// turn-ceiling cutoff as something needing a human. `test:run-classify` pins the map to roles.ts for the
// roles whose ceiling is a literal; QA's is now an expression, which that parse skips — so check it here.
const { ROLE_TURN_CEILING } = createRequire(import.meta.url)("../../scripts/probe-run-errors.cjs") as {
  ROLE_TURN_CEILING: Record<string, number | undefined>;
};
const qaFloor = ROLE_TURN_CEILING.qa;
const implementorFloor = ROLE_TURN_CEILING.implementor;
assert.ok(qaFloor && implementorFloor, "probe-run-errors must still enrol qa and implementor, or their cutoffs read as needing a human");
assert.ok(
  qaFloor <= Math.min(readOnlyQa, editingQa),
  `probe-run-errors treats ${qaFloor} turns as QA's ceiling, but a QA run can be cut off as low as ` +
    `${Math.min(readOnlyQa, editingQa)}. A floor above the real ceiling reports a benign cutoff as needing a human.`,
);
assert.ok(
  implementorFloor <= implementor,
  `probe-run-errors treats ${implementorFloor} turns as the implementor's ceiling, above the real ${implementor}.`,
);

// An env override has to reach the role, or QA_FIX_MAX_TURNS is a knob that reads as set and does nothing.
assert.equal(editingQa, config.qaFixMaxTurns, "editing QA must read its ceiling from config.qaFixMaxTurns");
assert.equal(implementor, config.implementorMaxTurns, "the implementor must read its ceiling from config.implementorMaxTurns");

console.log("roleTurnCeilings: all assertions passed");
