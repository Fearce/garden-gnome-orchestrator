#!/usr/bin/env node
// Gate for the gate-suite PROVENANCE — the record of what a green run covered.
//
// The failure it exists for (2026-08-26): two commits edited `run-gates.cjs`'s own spawn call after
// the last complete pass, so the suite's green did not cover the harness that produced it — and
// nothing said so. Establishing that took comparing a log mtime against `git log` by hand.
//
// The dangerous direction here is a false FRESH: a green wrongly reported as still-covering is
// silent, while a false stale only sends someone to re-run a suite. Every classification assertion
// below is written that way round.
//
// Run: node scripts/gates-provenance.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classifyPath, buildStamp, readStamp, assessStamp, fingerprint, STAMP_VERSION } = require("./gates-provenance.cjs");
const { STAMP } = require("./run-gates.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const ROOT = path.resolve(SERVER_DIR, "..");

// --- 1. the stamp is runtime state, never a commit ---------------------------------------------
assert.equal(
  path.relative(ROOT, path.dirname(STAMP)).split(path.sep).join("/"),
  "server/data",
  "the stamp belongs beside the transcript in the ignored runtime-state directory",
);

// --- 2. what a changed path means for a previous green ------------------------------------------
assert.equal(classifyPath("server/scripts/run-gates.cjs"), "harness", "the runner is the case this module exists for");
assert.equal(classifyPath("server\\scripts\\run-gates.cjs"), "harness", "…including as Windows hands it to us");
assert.equal(classifyPath("server/src/tests/qaBudget.itest.ts"), "gate");
assert.equal(classifyPath("server/scripts/audit-deps.test.cjs"), "gate");
assert.equal(classifyPath("server/src/orchestrator/threadManager.ts"), "product");
assert.equal(classifyPath("relay/src/core.ts"), "product");
assert.equal(classifyPath("web/src/store.ts"), "product");

// Inert: the things a sweep rewrites every single night. Classifying these as code would report
// STALE after every report edit, and a check that always says stale stops being read.
for (const inert of [
  "CLAUDE.md",
  ".claude/rules/nightly-quality-sweep.md",
  "docs/DECISIONS.md",
  "server/data/nightly-sweep-2026-08-26.md",
  ".gitignore",
  "web/public/logo.svg",
]) {
  assert.equal(classifyPath(inert), "inert", `${inert} cannot change what a gate does`);
}

// The load-bearing default: anything unrecognized counts as code. A new top-level directory, a
// build config, a lockfile — all can change a gate's outcome, and guessing "inert" hides that.
assert.equal(classifyPath("server/package.json"), "product", "a script rename changes which gates exist");
assert.equal(classifyPath("package-lock.json"), "product", "a dependency bump changes what the gates run against");
assert.equal(classifyPath("some/new/thing.rs"), "product", "an unrecognized path must be assumed to matter");
assert.equal(classifyPath("tsconfig.json"), "product");

// --- 3. a stamp records the verdict, not just that it ran ---------------------------------------
const green = [
  { gate: "test:cron", ok: true, ms: 700 },
  { gate: "test:git", ok: true, ms: 72_600 },
];
const cleanStamp = buildStamp({
  startedAt: 1000,
  endedAt: 2000,
  head: "aaaaaaaa",
  dirty: [],
  runnerFingerprint: fingerprint("runner v1"),
  results: green,
});
assert.equal(cleanStamp.passed, 2);
assert.equal(cleanStamp.total, 2);
assert.deepEqual(cleanStamp.failed, []);

const redStamp = buildStamp({ ...cleanStamp, results: [green[0], { gate: "test:repo-ops", ok: false, ms: 900 }] });
assert.deepEqual(redStamp.failed, ["test:repo-ops"], "a failing gate must be named in the stamp, not merely counted");

// --- 4. the verdicts -----------------------------------------------------------------------------
const unchanged = { head: "aaaaaaaa", runnerFingerprint: fingerprint("runner v1"), changedSince: [], dirty: [] };

assert.equal(assessStamp(null, unchanged).verdict, "none", "no stamp is not a pass");
assert.equal(assessStamp(redStamp, unchanged).verdict, "red");
assert.match(assessStamp(redStamp, unchanged).reasons[0], /test:repo-ops/);

const fresh = assessStamp(cleanStamp, unchanged);
assert.equal(fresh.verdict, "fresh", "nothing moved, so the green still holds");
assert.deepEqual(fresh.reasons, []);

// THE case. HEAD has not moved and nothing is dirty — only the runner's own bytes differ. Every
// other staleness signal here reads clean, which is exactly why 08-26 got through.
const runnerEdited = assessStamp(cleanStamp, { ...unchanged, runnerFingerprint: fingerprint("runner v2") });
assert.equal(runnerEdited.verdict, "stale", "a green produced by a since-edited runner does not cover the harness");
assert.match(runnerEdited.reasons.join(" "), /RUNNER itself has changed/);

// …and it must not need a commit to notice, since the edit can be sitting uncommitted.
assert.equal(
  assessStamp(cleanStamp, { ...unchanged, head: "bbbbbbbb", runnerFingerprint: fingerprint("runner v2"), changedSince: ["server/scripts/run-gates.cjs"] }).verdict,
  "stale",
);

assert.equal(assessStamp(cleanStamp, { ...unchanged, changedSince: ["server/src/orchestrator/threadManager.ts"] }).verdict, "stale");
assert.equal(assessStamp(cleanStamp, { ...unchanged, dirty: ["server/src/tests/qaBudget.itest.ts"] }).verdict, "stale");

// Cry-wolf guard: the sweep edits markdown all night. That must not invalidate a green.
const docsOnly = assessStamp(cleanStamp, { ...unchanged, changedSince: ["CLAUDE.md", "server/data/report.md"], dirty: [".claude/rules/x.md"] });
assert.equal(docsOnly.verdict, "fresh", "a documentation edit cannot stale a gate result");

// A green earned over someone else's uncommitted WIP is still green, but the reader should know.
const dirtyRun = buildStamp({ ...cleanStamp, dirty: ["server/src/x.ts"], results: green });
const overDirty = assessStamp(dirtyRun, unchanged);
assert.equal(overDirty.verdict, "fresh");
assert.match(overDirty.caveats.join(" "), /DIRTY tree/, "a shared checkout makes this the common case, not an edge one");

// …and dirt the run ALREADY carried is not a change SINCE it — the suite graded that file as it stood.
// Without this the tree's normal state reports STALE the instant a green finishes, and a check that is
// permanently stale gets ignored, which is the failure this whole probe exists to avoid.
const stillDirty = assessStamp(dirtyRun, { ...unchanged, dirty: ["server/src/x.ts"] });
assert.equal(stillDirty.verdict, "fresh", "the same uncommitted file the run covered cannot stale that run");
assert.match(stillDirty.caveats.join(" "), /not pinned/, "…but its content since is unverifiable, and that must be said");

// The other direction, which is the one that must NOT be loosened: dirt that appeared AFTERWARDS.
const newDirt = assessStamp(dirtyRun, { ...unchanged, dirty: ["server/src/x.ts", "server/src/y.ts"] });
assert.equal(newDirt.verdict, "stale", "an edit made after the run is a real change, even beside pre-existing dirt");
assert.match(newDirt.reasons.join(" "), /code under test/);

// --- 5. the stamp survives the disk round-trip, and a format change invalidates it ---------------
const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "gates-prov-"));
try {
  const file = path.join(tmp, "gates-last.json");
  fs.writeFileSync(file, JSON.stringify(cleanStamp, null, 2));
  assert.deepEqual(readStamp(file), cleanStamp, "what run-gates writes is what the probe reads");
  assert.equal(assessStamp(readStamp(file), unchanged).verdict, "fresh");

  fs.writeFileSync(file, JSON.stringify({ ...cleanStamp, version: STAMP_VERSION + 1 }));
  assert.equal(readStamp(file), null, "a stamp from a different format is not a stamp — better unknown than misread");

  fs.writeFileSync(file, "{ truncated");
  assert.equal(readStamp(file), null, "a half-written stamp (killed mid-run) must read as absent");
  assert.equal(assessStamp(readStamp(file), unchanged).verdict, "none");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- 6. a real stamp on disk, if one is here, is readable by the code that must read it ----------
if (fs.existsSync(STAMP)) {
  assert.ok(readStamp(STAMP), `${STAMP} exists but does not parse as a v${STAMP_VERSION} stamp`);
}

console.log("gatesProvenance: all assertions passed (classification, verdicts, round-trip)");
