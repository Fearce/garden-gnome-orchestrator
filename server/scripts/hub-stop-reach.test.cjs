// Gate for scripts/hub-stop-reach.cjs — "can script-hub STOP this process, or only SEE it?"
//
// The regression it exists for shipped as a two-day outage with nothing red anywhere: GGO's registry
// entry carried four backslash-only processMatchers while the process ran as `node.exe" dist/index.js`,
// so /api/restart's pattern sweep killed nothing and 13 deploys were refused, while /api/status kept
// reporting the script running via its portMatchers. Both of those states are pinned below.
//
// Free: pure string/regex matching, no hub, no process, no network.
// Run: node scripts/hub-stop-reach.test.cjs

const assert = require("node:assert/strict");
const { matcherReach, unreachableRemedy } = require("./hub-stop-reach.cjs");

// The live command line, verbatim (note the FORWARD slash and the trailing space).
const LIVE = '"C:\\Program Files\\nodejs\\node.exe" dist/index.js ';
// What script-hub itself spawns from the registry's `args: ["dist\\index.js"]` — a BACKslash. A matcher
// covering only this form is why the drift was invisible: it is correct for a hub-started process and
// wrong for every other way the same server can be launched.
const HUB_SPAWNED = '"C:\\Program Files\\nodejs\\node.exe" dist\\index.js ';

// --- the exact pre-fix registry, which must read as unreachable -------------------------------------
const BROKEN = [
  "claude-orchestrator\\\\server\\\\dist\\\\index\\.js",
  "claude-orchestrator/server/dist/index\\.js",
  'node\\.exe" dist\\\\index\\.js',
  "node dist\\\\index\\.js",
];
const broken = matcherReach(BROKEN, LIVE);
assert.equal(broken.reachable, false, "the pre-fix matchers must NOT reach the live process");
assert.equal(broken.matched, null);
assert.equal(broken.tested.length, 4, "every declared matcher is reported as tested, not just the first");
assert.match(broken.reason, /none of 4 processMatcher/);

// --- the fix: either separator, and it must still cover the hub's own spawn form ---------------------
const FIXED = [
  "claude-orchestrator\\\\server\\\\dist\\\\index\\.js",
  "claude-orchestrator/server/dist/index\\.js",
  'node\\.exe" dist[\\\\/]index\\.js',
  "node dist[\\\\/]index\\.js",
];
assert.equal(matcherReach(FIXED, LIVE).reachable, true, "the fixed matchers reach the live process");
assert.equal(matcherReach(FIXED, LIVE).matched, 'node\\.exe" dist[\\\\/]index\\.js');
assert.equal(matcherReach(FIXED, HUB_SPAWNED).reachable, true, "and still reach a hub-spawned process");

// --- unknown is never green ------------------------------------------------------------------------
assert.equal(matcherReach([], LIVE).reachable, false, "an entry with no matchers cannot be stopped");
assert.match(matcherReach([], LIVE).reason, /no processMatchers/);
assert.equal(matcherReach(undefined, LIVE).reachable, false, "a missing matcher list is not a pass");
assert.equal(matcherReach(FIXED, "").reachable, false, "an unreadable command line is not a pass");
assert.match(matcherReach(FIXED, "").reason, /command line could not be read/);
assert.equal(matcherReach(FIXED, null).reachable, false);

// --- matching mirrors the hub: case-insensitive, and a bad pattern is skipped not fatal --------------
assert.equal(
  matcherReach(['NODE\\.EXE" DIST/INDEX\\.JS'], LIVE).reachable,
  true,
  "the hub compiles its patterns with the 'i' flag and PowerShell -match is case-insensitive too",
);
const withJunk = matcherReach(["([unclosed", 'node\\.exe" dist[\\\\/]index\\.js'], LIVE);
assert.equal(withJunk.reachable, true, "an unparseable pattern must not mask a sibling that does match");
assert.equal(withJunk.matched, 'node\\.exe" dist[\\\\/]index\\.js');
assert.equal(matcherReach(["([unclosed"], LIVE).reachable, false, "…and on its own it is still no match");

// --- a matcher must not match something it was never meant to ----------------------------------------
assert.equal(
  matcherReach(FIXED, '"C:\\Program Files\\nodejs\\node.exe" other/index.js').reachable,
  false,
  "a different script's command line is not this entry's process",
);

// --- the remedy names the artifact, the evidence and the fix ----------------------------------------
const remedy = unreachableRemedy({ ...broken, commandLine: LIVE }, "claude-orchestrator");
assert.match(remedy, /registry\/scripts\.json/, "it must name the file to edit");
assert.match(remedy, /claude-orchestrator/, "…and which entry in it");
assert.match(remedy, /dist\/index\.js/, "…and show the command line that actually ran");
assert.match(remedy, /ok:false/, "…and the symptom the operator would otherwise misread");
assert.ok(remedy.includes(BROKEN[0]), "…and the patterns that were tested");

console.log("hubStopReach: all assertions passed");
