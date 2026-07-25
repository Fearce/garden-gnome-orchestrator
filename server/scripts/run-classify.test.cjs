// Gate for the shared non-done-run classifier (probe-run-errors.cjs), which decides both the sweep's
// first-command verdict in nightly-health.cjs and the probe's own output. A misclassification here is
// expensive in one direction only: labelling a REAL failure as an expected outcome hides it from the sweep.
// Run: node scripts/run-classify.test.cjs

const assert = require("node:assert/strict");
const { classifyRun, CLASSES, ROLE_TURN_CEILING } = require("./probe-run-errors.cjs");

const run = (over) => ({ role: "implementor", state: "error", error: "", num_turns: null, ...over });
const is = (expected, over, why) => assert.equal(classifyRun(run(over)), expected, why);

// Every key the classifier can return must exist in CLASSES, or the verdict silently drops the bucket.
{
  const keys = new Set(CLASSES.map((c) => c.key));
  for (const k of ["real", "unclassifiable", "structured", "cutoff", "cap", "transient", "restart"]) {
    assert.ok(keys.has(k), `CLASSES is missing "${k}"`);
  }
}

// A restart is identified by run state, not text — markInterrupted writes no error on most rows.
is("restart", { state: "interrupted" });
is("restart", { state: "interrupted", error: "Claude Code process exited with code 1073807364" });
is("restart", { error: "interrupted by a server restart" });

// Usage caps. The bare, qualifier-less form is a Fable model-pool notice; production catches it via the
// rate_limit_event rather than this text, and 53 such rows were initially misread as REAL failures.
is("cap", { error: "You've hit your session limit · resets 5:30pm (Europe/Copenhagen)" });
is("cap", { error: "You've hit your weekly limit · resets Jul 21, 10pm (Europe/Copenhagen)" });
is("cap", { model: "claude-fable-5", error: "You've hit your limit · resets Jul 24, 8am (Europe/Copenhagen)" });
is("cap", { error: "429 Too Many Requests" });
is("cap", { error: "402 Payment Required" });

// Transient provider/transport failures — the runner retries these itself (transientApiErrorInfo).
is("transient", { error: "API Error: 500 Internal server error. This is a server-side issue, usually temporary" });
is("transient", { error: "upstream connection reset" });
is("transient", { error: "Overloaded" });

// Involuntary cutoffs, as worded by orchestrator/runError.ts.
is("cutoff", { error: "Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash." });
is("structured", {
  role: "qa",
  error: "Stopped after too many structured-output retries (error_max_structured_output_retries) — …",
});

// Legacy opaque rows (pre-458566e): the turn count against the ROLE's ceiling is the only evidence left.
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

console.log("runClassify: all assertions passed");
