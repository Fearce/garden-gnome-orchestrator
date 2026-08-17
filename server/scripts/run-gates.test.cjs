#!/usr/bin/env node
// Gate for the gate RUNNER (run-gates.cjs) — the one script the suite can't check by running it,
// because it is the thing that runs the suite.
//
// What it pins, and why each was worth an assertion:
//   1. The transcript lands somewhere gitignored. It is rewritten in full on every run and is
//      hundreds of KB; a path outside server/data would show up in `git status` and eventually in
//      somebody's commit.
//   2. A closed stdout must not take the transcript down with it. `npm run test:gates | head -20`
//      raises EPIPE mid-run; unguarded, Node kills the process and leaves a truncated log that
//      reads exactly like a completed suite — exit 0, plausible tail, no summary.
//   3. The summary names the transcript. The whole point of the file is that a backgrounded run is
//      read from it; a summary that doesn't say where it is sends the next reader back to `| tail`.
//   4. Every gate is spawned per name, so the count in the summary is the count of gates.
//
// Run: node scripts/run-gates.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { GATES, TRANSCRIPT, guardBrokenPipe, summaryText, tail } = require("./run-gates.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const ROOT = path.resolve(SERVER_DIR, "..");

// --- 1. the transcript cannot end up in a commit ----------------------------------------------
assert.equal(
  path.relative(ROOT, path.dirname(TRANSCRIPT)).split(path.sep).join("/"),
  "server/data",
  "the transcript belongs in server/data — the ignored runtime-state directory",
);
assert.match(
  fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"),
  /^server\/data\/$/m,
  "server/data/ is no longer gitignored, so every suite run would leave its transcript in `git status`",
);

// --- 2. a broken pipe is survivable; nothing else is -------------------------------------------
guardBrokenPipe(new PassThrough()).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
assert.throws(
  () => guardBrokenPipe(new PassThrough()).emit("error", Object.assign(new Error("nope"), { code: "ENOSPC" })),
  /nope/,
  "only a broken pipe is survivable — a full disk must still fail loudly",
);

// --- 3. the summary is honest and points at the full output ------------------------------------
const green = [
  { gate: "test:cron", ok: true, ms: 700, output: "ok" },
  { gate: "test:git", ok: true, ms: 131_000, output: "ok" },
];
const greenText = summaryText(green);
assert.match(greenText, /2\/2 gates passed/);
assert.ok(greenText.includes(TRANSCRIPT), "a green summary must still say where the full output is");
assert.doesNotMatch(greenText, /✗/, "nothing failed, so nothing may be reported as failing");

const red = [green[0], { gate: "test:git", ok: false, ms: 900, output: "line1\nline2\nAssertionError: boom" }];
const redText = summaryText(red);
assert.match(redText, /1\/2 gates passed/);
assert.match(redText, /✗ test:git/, "a failing gate must be named");
assert.match(redText, /AssertionError: boom/, "…with the tail of what it printed, or the name alone is useless");
assert.ok(redText.includes(TRANSCRIPT));

// --- 4. the tail helper keeps the END (where a failure's reason is), not the head ---------------
const many = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
const kept = tail(many, 12).split("\n");
assert.equal(kept.length, 12);
assert.equal(kept[kept.length - 1], "line 40", "the last line is the one that says why a gate failed");

// --- 5. the gate list is a list of distinct npm scripts ----------------------------------------
assert.equal(new Set(GATES).size, GATES.length, "a duplicated gate would be run (and counted) twice");
const scripts = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")).scripts ?? {};
for (const gate of GATES) assert.ok(scripts[gate], `${gate} is in GATES but has no npm script — the suite would report it failing every run`);

console.log(`runGates: all assertions passed (${GATES.length} gates, transcript ${path.relative(ROOT, TRANSCRIPT)})`);
