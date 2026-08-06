// Gate for the shared non-done-run classifier (probe-run-errors.cjs), which decides both the sweep's
// first-command verdict in nightly-health.cjs and the probe's own output. A misclassification here is
// expensive in one direction only: labelling a REAL failure as an expected outcome hides it from the sweep.
// Run: node scripts/run-classify.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classifyRun, CLASSES, ROLE_TURN_CEILING } = require("./probe-run-errors.cjs");

const run = (over) => ({ role: "implementor", state: "error", error: "", num_turns: null, ...over });
const is = (expected, over, why) => assert.equal(classifyRun(run(over)), expected, why);

// Every key the classifier can return must exist in CLASSES, or the verdict silently drops the bucket.
{
  const keys = new Set(CLASSES.map((c) => c.key));
  for (const k of ["real", "unclassifiable", "structured", "silent", "cutoff", "cap", "transient", "restart"]) {
    assert.ok(keys.has(k), `CLASSES is missing "${k}"`);
  }
}

// A restart is the markInterrupted stamp on a row with NO recorded reason. `state='interrupted'` alone must
// NOT win: finalizeRun also stamps it for a run that ended with no result and preserves the row's existing
// error, so trusting the state first filed 5 consecutive "failed to launch" rows (a broken install) as benign.
is("restart", { state: "interrupted" });
is("restart", { state: "interrupted", error: "Run failed." }, "opaque text is no reason at all");
is("restart", { error: "interrupted by a server restart" });
is(
  "real",
  { state: "interrupted", error: "Claude Code native binary at C:\\…\\claude.exe exists but failed to launch." },
  "an interrupted row that says WHY it died died of that, not of the bounce",
);
is("real", { state: "interrupted", error: "Claude Code process exited with code 1073807364" }, "external tree-kill");
is("cap", { state: "interrupted", error: "You've hit your session limit · resets 5:30pm" }, "a preserved cap text still wins");

// Usage caps. The bare, qualifier-less form is a Fable model-pool notice; production catches it via the
// rate_limit_event rather than this text, and 53 such rows were initially misread as REAL failures.
is("cap", { error: "You've hit your session limit · resets 5:30pm (Europe/Copenhagen)" });
is("cap", { error: "You've hit your weekly limit · resets Jul 21, 10pm (Europe/Copenhagen)" });
is("cap", { model: "claude-fable-5", error: "You've hit your limit · resets Jul 24, 8am (Europe/Copenhagen)" });
is("cap", { error: "429 Too Many Requests" });
is("cap", { error: "402 Payment Required" });
is("cap", { error: "api_error_status=429 rejected" });
// z.ai says it in its own words — the exact row a QA run recorded on 2026-08-05, reported as a REAL
// failure needing a human when the backend had simply spent its weekly quota.
is("cap", {
  role: "qa",
  model: "glm-5.2",
  error:
    "API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-07 05:17:25][20260805162117d671fff34d0b496f]",
});

// …the envelope alone is not the notice, so a run that merely narrates the rejection path stays visible.
is("real", { error: "the reader explained how a request rejected (429) reaches the failover ladder" });

// …but a bare number must NOT read as a cap: `429` is also a line number, and filing a crash as a cap hides it.
is("real", { error: "TypeError: Cannot read properties of undefined at threadManager.ts:429:15" });
is("real", { error: "fatal: unable to access repo: exit status 429" });

// Transient provider/transport failures — the runner retries these itself (transientApiErrorInfo).
is("transient", { error: "API Error: 500 Internal server error. This is a server-side issue, usually temporary" });
is("transient", { error: "upstream connection reset" });
is("transient", { error: "Overloaded" });
// An unreachable API is the provider's fault, not the work's — production retries these too
// (TRANSIENT_API_ERROR_RE in agents/runner.ts); keep both lists saying the same thing.
is("transient", { error: "API Error: Unable to connect to API (ConnectionRefused)" });
is("transient", { error: "API Error: Unable to connect to API (FailedToOpenSocket)" });

// Involuntary cutoffs — EVERY backend's wording, or a cutoff raises a REAL-failure alarm for exactly the
// class this probe exists to defuse. runError.ts writes the first two, grokRunner.ts the third.
is("cutoff", { error: "Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash." });
is("cutoff", { error: "Stopped at the per-session cost ceiling (error_max_budget_usd) — an involuntary cutoff, not a crash." });
is("cutoff", { model: "grok-4.5", error: "Grok stopped at its turn limit." });
// The SDK's own phrasing, as persisted for rows written before runError.ts preferred the canned reason.
// Missing this made the sweep report a routine 101-turn cutoff as a REAL failure.
is("cutoff", { error: "Reached maximum number of turns (100)", num_turns: 101 });
is("structured", {
  role: "qa",
  error: "Stopped after too many structured-output retries (error_max_structured_output_retries) — …",
});

// Legacy opaque rows (pre-458566e): the turn count against the ROLE's ceiling is the only evidence left.
// A resumed session that came back empty. threadManager.ts stamps this text itself so the row lands here
// instead of as a `done` 0-turn row the sweep never reads — the two strings must stay identical.
is("silent", {
  num_turns: 0,
  error: "Resumed session produced no output — the run returned without ever reaching the model (0 turns, $0).",
});

is("cutoff", { error: "Run failed.", num_turns: ROLE_TURN_CEILING.implementor + 1 }, "implementor at its ceiling");
is("cutoff", { role: "qa", error: "Run failed.", num_turns: ROLE_TURN_CEILING.qa }, "qa at its own lower ceiling");
is("unclassifiable", { error: "Run failed.", num_turns: 31 }, "below the ceiling — nothing recorded to classify");
is("unclassifiable", { error: "Run failed.", num_turns: null }, "no turn count at all");
is("unclassifiable", { error: "" }, "no text and no turns");
is(
  "unclassifiable",
  { role: "director", error: "Run failed.", num_turns: 500 },
  "a role with no known ceiling can't be assumed to have hit one",
);

// Anything that reported a real reason stays REAL — the sweep must not lose these to a benign bucket.
is("real", { error: "ENOENT: spawn claude; exit 1" });
is("real", { error: "Claude Code process exited with code 1073807364" }, "an external tree-kill that was NOT marked interrupted");
is("real", { error: "TypeError: cannot read property 'x' of undefined" });

// A message merely *mentioning* a limit still classifies as a cap here (deliberately broader than the
// runner's control-flow regexes) — assert the intent so a future narrowing is a conscious choice.
is("cap", { error: "the task failed because we hit your usage limit while writing the report" });

// --- ROLE_TURN_CEILING must cover every role that HAS a ceiling ------------------------------------
// The map is the last-resort evidence for an OPAQUE row ("Run failed." with no reason), so a role
// missing from it degrades to "unclassifiable" and the sweep reports a benign turn-ceiling cutoff as
// something needing a human. That is silent: it renders as a longer list, never as an error. `reviewer`
// shipped with the auto-review feature and sat unenrolled until a sweep tripped over it — so pin the
// map against roles.ts rather than against a hand-copied list that drifts the same way again.
const rolesSrc = fs.readFileSync(path.resolve(__dirname, "..", "src", "agents", "roles.ts"), "utf8");
const declared = {};
for (const chunk of rolesSrc.split(/export function /).slice(1)) {
  const role = chunk.match(/^(\w+?)Config\s*\(/)?.[1];
  if (!role) continue;
  const turns = chunk.match(/maxTurns: (.+?),/)?.[1];
  if (turns) declared[role] = turns;
}
assert.ok(Object.keys(declared).length >= 6, `expected to parse the role configs out of roles.ts, got ${Object.keys(declared)}`);

for (const [role, turns] of Object.entries(declared)) {
  assert.ok(
    ROLE_TURN_CEILING[role] > 0,
    `roles.ts caps '${role}' at ${turns} turns but ROLE_TURN_CEILING has no entry — an opaque ${role} row at its ceiling would classify as 'unclassifiable' and be reported as needing a human`,
  );
  if (/^\d+$/.test(turns)) {
    assert.equal(ROLE_TURN_CEILING[role], Number(turns), `ceiling for '${role}' drifted from roles.ts`);
  }
}
// The converse: a role the probe thinks is bounded but roles.ts does not cap would let a runaway run
// be filed as a benign cutoff — the one direction this classifier must never get wrong.
for (const role of Object.keys(ROLE_TURN_CEILING)) {
  assert.ok(declared[role], `ROLE_TURN_CEILING caps '${role}', which roles.ts no longer bounds`);
}
// director is deliberately absent — it sets no maxTurns, so it genuinely has no ceiling to hit.
assert.equal(declared.director, undefined, "director is expected to be unbounded in roles.ts");
assert.equal(ROLE_TURN_CEILING.director, undefined, "an unbounded role must NOT be given a ceiling");

console.log("runClassify: all assertions passed");
