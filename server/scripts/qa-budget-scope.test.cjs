#!/usr/bin/env node

// Every QA recovery budget must be enforced against a field something RENEWS.
//
//   npm run test:qa-budget-scope --prefix server
//
// Why it exists (2026-08-25). QA has two involuntary stops it can recover from — a turn-ceiling
// cutoff and an empty run — and each is bounded by a `MAX_QA_*` constant. Those bounds are
// per-REVIEW: a round that reaches a verdict proves the reviewer is not wedged, which is the only
// failure they exist to stop. `748633a` scoped the cutoff budget that way and left its sibling on a
// task-lifetime counter, so `7d776461` spent its one empty-run retry on a round that RECOVERED and
// the round two verdicts later was refused its own first retry and parked — discarding a $17.49
// Opus review over a recovery that had worked. Eight days, one commit apart in the same file.
//
// `test:qa-budget` proves the BEHAVIOUR of the budgets that exist. This proves the SHAPE, so the
// third one cannot ship half-scoped: a lifetime tally and a per-review allowance are different
// fields with different jobs, and the compiler cannot tell them apart.
//
// It reads source text rather than importing, because these are private members of a class whose
// construction needs a Db, an EventHub and an AccountManager. That makes "found nothing" the
// dangerous outcome — a renamed method or a moved constant would otherwise pass vacuously — so
// every extraction below asserts it found something before asserting anything about it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const threadManager = fs.readFileSync(path.join(SRC, "orchestrator", "threadManager.ts"), "utf8");
const types = fs.readFileSync(path.join(SRC, "types.ts"), "utf8");

/** The per-review suffix. Both budgets already use it, and it is what the renewal helper keys on. */
const PER_REVIEW = "ThisRound";

// ---- the fields StageOutputs declares -----------------------------------------------------------

/** `StageOutputs`' declared field names. Comments in that block are prose containing colons, so the
 *  match is anchored to the two-space indent an interface member has and nothing else. */
function stageOutputFields() {
  const block = /export interface StageOutputs \{([\s\S]*?)\n\}/.exec(types);
  assert.ok(block, "could not find the StageOutputs interface — this gate is reading the wrong file");
  return [...block[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]);
}

const fields = stageOutputFields();
assert.ok(fields.length > 5, `StageOutputs parse looks wrong — found only ${fields.length} field(s)`);

const perReviewFields = fields.filter((f) => f.endsWith(PER_REVIEW));
assert.ok(
  perReviewFields.length >= 2,
  `expected at least the two known per-review allowances, found ${JSON.stringify(perReviewFields)}`,
);

// ---- 1. a per-review allowance needs a lifetime sibling ------------------------------------------
// The pair is not decoration: `probe:task-runs` reconciles QA launches against the LIFETIME tally
// (a continuation or a retry spends a launch without spending a round), while the loop enforces the
// budget against the allowance. Collapsing them into one field breaks whichever job it stops doing —
// renewing a tally makes the arithmetic under-count, and not renewing an allowance is the bug above.

for (const allowance of perReviewFields) {
  const tally = allowance.slice(0, -PER_REVIEW.length);
  assert.ok(
    fields.includes(tally),
    `${allowance} has no lifetime sibling '${tally}' in StageOutputs — probe:task-runs reconciles ` +
      `launches against the tally, so the allowance cannot be the only field`,
  );
}

// ---- 2. every per-review allowance is actually renewed --------------------------------------------

const renewal = /private renewQaRecoveryAllowances\(threadId: string\): void \{([\s\S]*?)\n  \}/.exec(threadManager);
assert.ok(
  renewal,
  "could not find renewQaRecoveryAllowances — if it was renamed, point this gate at the new name " +
    "rather than deleting the check; an unrenewed allowance is silent in production",
);

for (const allowance of perReviewFields) {
  assert.match(
    renewal[1],
    new RegExp(`\\b${allowance}\\b`),
    `${allowance} is a per-review allowance that renewQaRecoveryAllowances never resets, so it is a ` +
      `task-lifetime budget wearing a per-review name — the 7d776461 bug exactly`,
  );
}

// The renewal must run where a verdict is read, not on some other event: the verdict IS the proof
// that the reviewer is not wedged, which is the whole justification for handing back an allowance.
assert.match(
  threadManager,
  /if \(verdict\) \{\s*\n\s*this\.renewQaRecoveryAllowances\(thread\.id\);/,
  "renewQaRecoveryAllowances must be called on the verdict branch of a QA round — renewing on any " +
    "other event hands a wedged reviewer a fresh budget",
);

// ---- 3. a MAX_QA_* budget is enforced against a per-review field ----------------------------------
// This is the half that would have caught the original. Pre-fix the code read
// `stage.qaSilentRetries >= MAX_QA_SILENT_RETRIES` — a lifetime counter used as a budget — and
// nothing anywhere said that was wrong.

const budgetConstants = [...threadManager.matchAll(/^const (MAX_QA_[A-Z_]+) = \d+;/gm)].map((m) => m[1]);
assert.ok(
  budgetConstants.length >= 2,
  `expected the QA recovery budget constants, found ${JSON.stringify(budgetConstants)}`,
);

/** Every StageOutputs field compared against `constName`, in source order.
 *
 *  ALL of them, not the first: each budget is read twice — once where the loop enforces it, once
 *  where the park message decides whether to say the mechanism was already tried. Checking only the
 *  first match let this gate PASS against the very bug it was written for, because the park-note
 *  read sits earlier in the file than the enforcement. Both reads must agree on the scope anyway:
 *  a note sourced from the lifetime tally tells the owner a mechanism ran for a round it never ran for.
 *
 *  An operand is either an inline `stage.foo ?? 0` or a local assigned from one just above, which is
 *  how the two enforcement sites happen to be written. */
function enforcedFields(constName) {
  const cmp = new RegExp(`\\(?([A-Za-z][A-Za-z0-9.]*)\\s*\\?\\?\\s*0\\)?\\s*>=\\s*${constName}\\b|\\b([A-Za-z][A-Za-z0-9]*)\\s*>=\\s*${constName}\\b`, "g");
  const found = [];
  for (const m of threadManager.matchAll(cmp)) {
    const operand = m[1] ?? m[2];
    if (operand.startsWith("stage.")) {
      found.push(operand.slice("stage.".length));
      continue;
    }
    // A local: take its nearest PRECEDING assignment from a stage field.
    const local = new RegExp(`const ${operand} = (?:stage|this\\.db\\.getThreadStageOutputs\\([^)]*\\))\\.([A-Za-z0-9]+)\\s*\\?\\?`, "g");
    let assigned = null;
    for (const a of threadManager.slice(0, m.index).matchAll(local)) assigned = a[1];
    assert.ok(assigned, `could not resolve what '${operand}' reads for ${constName} — resolve it by hand`);
    found.push(assigned);
  }
  assert.ok(found.length > 0, `no '>= ${constName}' comparison found — the budget is declared but never enforced`);
  return found;
}

for (const constName of budgetConstants) {
  for (const field of enforcedFields(constName)) {
    assert.ok(
      fields.includes(field),
      `${constName} is compared against '${field}', which StageOutputs does not declare`,
    );
    assert.ok(
      field.endsWith(PER_REVIEW),
      `${constName} is read against '${field}', a task-LIFETIME counter. A recovery budget bounds ` +
        `one wedged review, so a round whose recovery SUCCEEDED spends a later round's allowance and ` +
        `parks the task over a mechanism that worked (7d776461, 2026-08-18). Read it from ` +
        `'${field}${PER_REVIEW}' and renew that in renewQaRecoveryAllowances.`,
    );
  }
}

console.log(
  `qaBudgetScope: all assertions passed (${budgetConstants.length} budget(s), ` +
    `${perReviewFields.length} per-review allowance(s) — each paired, enforced and renewed)`,
);
