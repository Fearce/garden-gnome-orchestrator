#!/usr/bin/env node

const assert = require("node:assert/strict");
const { classifyDistVsHead } = require("./dist-vs-head.cjs");

// --- NO STAMP AT ALL ---------------------------------------------------------------------------
{
  const v = classifyDistVsHead({ distStamp: null, changedFiles: null });
  assert.equal(v.state, "unknown");
  assert.match(v.detail, /no \.build-info\.json/);
}
{
  const v = classifyDistVsHead({ distStamp: {}, changedFiles: null });
  assert.equal(v.state, "unknown");
  assert.match(v.detail, /recorded no commit/);
}
{
  const v = classifyDistVsHead({ distStamp: { commit: null }, changedFiles: null });
  assert.equal(v.state, "unknown");
  assert.match(v.detail, /recorded no commit/);
}

// --- GIT CANNOT COMPARE -------------------------------------------------------------------------
{
  const v = classifyDistVsHead({ distStamp: { commit: "aaaaaaaa" }, changedFiles: null });
  assert.equal(v.state, "unknown");
  assert.match(v.detail, /cannot compare/);
}

// --- THE 2026-09-11 FIX: "stale" states ONLY the fact this module owns -------------------------
// Before this split the detail baked in "that committed change is NOT live, however fresh the
// process looks" unconditionally. That claim is true only when the running process actually loads
// dist, which this module cannot know: it never sees the running process at all. A source-run
// process (tsx under `npm run serve`) inherited the claim anyway and read as proof commit `b26fdaa`
// was undeployed; it was live, and a different commit (`78dc504`) was the real gap. Callers, not this
// module, must own the liveness clause and gate it on the process's confirmed shape.
{
  const v = classifyDistVsHead({
    distStamp: { commit: "aaaaaaaa" },
    changedFiles: ["server/src/orchestrator/threadManager.ts", "server/src/agents/runner.ts"],
  });
  assert.equal(v.state, "stale");
  assert.match(v.detail, /2 server\/src file\(s\)/);
  assert.match(v.detail, /threadManager\.ts/, "name the drifted files so the reader can judge urgency");
  assert.doesNotMatch(v.detail, /NOT live/, "liveness is not this module's fact to assert");
  assert.doesNotMatch(v.detail, /however fresh/, "liveness is not this module's fact to assert");
  assert.doesNotMatch(v.detail, /deploy/, "the remedy belongs to the caller, who knows whether a restart would even help");
}
{
  // More than three drifted files are summarised, not dumped (unchanged from the pre-split behavior).
  const many = ["a", "b", "c", "d", "e"].map((n) => `server/src/${n}.ts`);
  const v = classifyDistVsHead({ distStamp: { commit: "aaaaaaaa" }, changedFiles: many });
  assert.equal(v.state, "stale");
  assert.match(v.detail, /5 server\/src file\(s\)/);
  assert.match(v.detail, /…/);
}

// --- DIRTY BUILD ---------------------------------------------------------------------------------
{
  const v = classifyDistVsHead({ distStamp: { commit: "9e879d72", dirty: true }, changedFiles: [] });
  assert.equal(v.state, "dirty-build");
  assert.match(v.detail, /DIRTY tree/);
}

// --- CURRENT ---------------------------------------------------------------------------------------
{
  const v = classifyDistVsHead({ distStamp: { commit: "9e879d72", dirty: false }, changedFiles: [] });
  assert.equal(v.state, "current");
  assert.match(v.detail, /9e879d72/);
}

console.log("dist-vs-head: ok");
