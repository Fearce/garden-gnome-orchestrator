#!/usr/bin/env node

const assert = require("node:assert/strict");
const { classifyProcessBuild } = require("./process-vs-dist.cjs");

const build = (commit, extra = {}) => ({ commit, at: 1_700_000_000_000, dirty: false, ...extra });

// --- THE 2026-08-18 FALSE POSITIVE -------------------------------------------
// dist was rebuilt after the process started, for commits that touched only docs and scripts, and one
// source file had been rewritten with identical bytes. Both mtime signals fired; nothing had drifted.
// The old check said "likely a real stale build (someone needs a restart)" — a bounce that would have
// interrupted three live agents for nothing, and ~8 tool calls to disprove by hand.
{
  const v = classifyProcessBuild({ running: build("95c9022a"), dist: build("9e879d72"), changedFiles: [] });
  assert.equal(v.state, "current");
  assert.match(v.detail, /no restart needed/);
}

// The straightforward case: the process loaded exactly the build sitting in dist.
{
  const v = classifyProcessBuild({ running: build("9e879d72"), dist: build("9e879d72"), changedFiles: null });
  assert.equal(v.state, "current");
  assert.match(v.detail, /9e879d72/);
}

// --- A REAL STALE BUILD MUST STILL BE REPORTED --------------------------------
// Loosening a detector is the dangerous direction: a false negative here is silent forever, and this is
// the failure the check exists for (a built server change nobody restarted into).
{
  const v = classifyProcessBuild({
    running: build("aaaaaaaa"),
    dist: build("bbbbbbbb"),
    changedFiles: ["server/src/orchestrator/threadManager.ts", "server/src/agents/runner.ts"],
  });
  assert.equal(v.state, "stale");
  assert.match(v.detail, /NOT live/);
  assert.match(v.detail, /atomic hub restart/, "the warning has to say what to do about it");
  assert.match(v.detail, /threadManager\.ts/, "name the drifted files so the reader can judge urgency");
}
{
  // More than three drifted files are summarised, not dumped.
  const many = ["a", "b", "c", "d", "e"].map((n) => `server/src/${n}.ts`);
  const v = classifyProcessBuild({ running: build("aaaaaaaa"), dist: build("bbbbbbbb"), changedFiles: many });
  assert.equal(v.state, "stale");
  assert.match(v.detail, /5 server\/src file\(s\)/);
  assert.match(v.detail, /…/);
}

// --- EQUAL COMMITS ARE NOT PROOF WHEN EITHER SIDE WAS BUILT DIRTY -------------
// In this shared checkout a dirty build can carry a concurrent agent's uncommitted WIP, which the commit
// id does not describe. That must not read as a clean "current".
{
  for (const side of ["running", "dist"]) {
    const args = { running: build("9e879d72"), dist: build("9e879d72"), changedFiles: null };
    args[side] = build("9e879d72", { dirty: true });
    const v = classifyProcessBuild(args);
    assert.equal(v.state, "dirty-build", `a dirty ${side} build is not proof of a deployed tree`);
    assert.match(v.detail, /do not prove equal code/);
  }
}

// --- NOT KNOWING IS NEVER "CURRENT" -------------------------------------------
// Every unknown resolves away from "deployed". Claiming a deploy that did not happen is the expensive
// direction — it is what let a feature sit unbuilt in prod for a day (the Stop button, 2026-07-29).
{
  const v = classifyProcessBuild({ running: null, dist: build("9e879d72"), changedFiles: null });
  assert.equal(v.state, "unstamped", "a process predating the stamp must fall back, not pass");
  assert.match(v.detail, /tsx|before this check shipped/);
}
{
  const v = classifyProcessBuild({ running: build(null), dist: build("9e879d72"), changedFiles: null });
  assert.equal(v.state, "unstamped");
}
{
  for (const dist of [null, build(null)]) {
    const v = classifyProcessBuild({ running: build("9e879d72"), dist, changedFiles: null });
    assert.equal(v.state, "unknown", "no dist stamp to compare against is unknown, not current");
  }
}
{
  // git could not diff the two commits (a rebase made one unreachable). Differing commits plus no answer
  // is exactly the case that must not be waved through.
  const v = classifyProcessBuild({ running: build("aaaaaaaa"), dist: build("bbbbbbbb"), changedFiles: null });
  assert.equal(v.state, "unknown");
  assert.match(v.detail, /cannot compare/);
}

// --- THE SHAPE HEALTH RELIES ON ----------------------------------------------
// nightly-health.cjs branches on these names; a renamed state would silently take the fallback path.
{
  const states = new Set(["current", "stale", "dirty-build", "unstamped", "unknown"]);
  const v = classifyProcessBuild({ running: build("9e879d72"), dist: build("9e879d72"), changedFiles: null });
  assert.ok(states.has(v.state));
  assert.equal(typeof v.detail, "string");
  assert.ok(v.detail.length > 0);
}

console.log("process-vs-dist: ok");
