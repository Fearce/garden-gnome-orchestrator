#!/usr/bin/env node
// Gate for the sweep DRIVER (quality-sweep.cjs) — the one script in the nightly procedure that
// nothing else checks, because it is the thing that runs the checks.
//
// What it pins, and why each was worth an assertion:
//   1. Every step's npm script actually exists in the package.json of the directory it runs in.
//      A typo or a renamed script currently surfaces at 3am as one dead step in an otherwise
//      green sweep — the driver reports `✗` and moves on, exactly as designed for a real failure.
//   2. The step numbers still cover the rule's numbered sections, contiguously. A step quietly
//      dropped from the array leaves a sweep that passes while never running that check.
//   3. The transcript lands somewhere gitignored. It is regenerated in full on every run and
//      routinely hundreds of KB; a path outside server/data would put it in `git status` and
//      eventually into somebody's commit.
//   4. The verdict text and the exit code agree — a summary that reads green while exiting 1
//      (or the reverse) is the one output nobody double-checks.
//
// Run: node scripts/quality-sweep.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { STEPS, TRANSCRIPT, selected, summaryText, exitCodeFor, guardBrokenPipe } = require("./quality-sweep.cjs");

const ROOT = path.resolve(__dirname, "..");

// --- 1. every step points at a script that exists where it will be run ------------------------
const pkgCache = new Map();
function scriptsIn(dir) {
  if (!pkgCache.has(dir)) {
    pkgCache.set(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts ?? {});
  }
  return pkgCache.get(dir);
}

for (const s of STEPS) {
  assert.ok(fs.existsSync(path.join(s.cwd, "package.json")), `step ${s.step} (${s.name}) runs in ${s.cwd}, which has no package.json`);
  assert.ok(
    scriptsIn(s.cwd)[s.script],
    `step ${s.step} (${s.name}) runs \`npm run ${s.script}\` in ${path.relative(ROOT, s.cwd) || "."}, ` +
      `which declares no such script — the sweep would report it as a failing check every night`,
  );
  assert.ok(s.name && s.what, `step ${s.step} needs a name and a description — both are printed in the verdict`);
}

// --- 2. the numbered sections of the rule are all still covered -------------------------------
const numbers = STEPS.map((s) => s.step);
assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, "steps must be listed in ascending order — they run top to bottom");
const covered = [...new Set(numbers)];
assert.deepEqual(
  covered,
  Array.from({ length: covered.length }, (_, i) => i + 1),
  `steps must cover 1..N with no gaps — found ${covered.join(",")}, so a section of the rule has no command`,
);
assert.ok(covered.length >= 10, `the sweep rule has ten numbered sections; only ${covered.length} are wired up`);

// --- 3. the transcript cannot end up in a commit ----------------------------------------------
const transcriptDir = path.dirname(TRANSCRIPT);
assert.equal(
  path.relative(ROOT, transcriptDir).split(path.sep).join("/"),
  "server/data",
  "the transcript belongs in server/data — the ignored runtime-state directory",
);
assert.match(
  fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"),
  /^server\/data\/$/m,
  "server/data/ is no longer gitignored, so every sweep would leave its transcript in `git status`",
);

// --- 4. selection ------------------------------------------------------------------------------
assert.equal(selected([]).length, STEPS.length, "no arguments runs the whole sweep");
assert.equal(selected(["--list"]).length, STEPS.length, "a flag is not a step number — it must not filter anything out");
const two = selected(["2", "7"]);
assert.ok(two.length > 0 && two.every((s) => s.step === 2 || s.step === 7), "numeric arguments select those steps only");
assert.equal(selected(["99"]).length, 0, "an unknown step number selects nothing rather than everything");

// --- 5. the verdict text and the exit code agree -----------------------------------------------
const green = [
  { step: 1, name: "health", what: "x", ms: 1600, ok: true },
  { step: 2, name: "gates", what: "y", ms: 484_000, ok: true },
];
assert.equal(exitCodeFor(green), 0);
const greenText = summaryText(green);
assert.match(greenText, /all 2 check\(s\) green/);
assert.doesNotMatch(greenText, /failed/);
assert.ok(greenText.includes(TRANSCRIPT), "a green verdict must still say where the full output is");

const red = [green[0], { ...green[1], ok: false }];
assert.equal(exitCodeFor(red), 1, "any failing step must exit non-zero");
const redText = summaryText(red);
assert.match(redText, /1 of 2 check\(s\) failed: gates/);
assert.match(redText, /npm run quality -- 2$/m, "the re-run hint must name the failing step's number");
assert.doesNotMatch(redText, /green/);

// --- 6. a closed stdout must not take the transcript down with it ------------------------------
// Found the hard way: `npm run quality -- 5 | head -30` exited 0 and left a transcript with the
// verdict missing, because EPIPE killed the process mid-write. A truncated transcript is worse than
// none — it reads like a completed sweep.
const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
guardBrokenPipe(new PassThrough()).emit("error", epipe); // must not throw
assert.throws(
  () => guardBrokenPipe(new PassThrough()).emit("error", Object.assign(new Error("nope"), { code: "ENOSPC" })),
  /nope/,
  "only a broken pipe is survivable — a full disk must still fail loudly",
);

console.log(`qualitySweep: all assertions passed (${STEPS.length} steps across ${covered.length} sections)`);
