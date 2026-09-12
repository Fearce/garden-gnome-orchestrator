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
//   5. Step selection: a flag is not a step number, and an unknown number selects nothing.
//   6. A closed stdout (a reader piping into `head`) cannot truncate the transcript.
//   7. A second concurrent sweep refuses instead of interleaving the first one's transcript, and
//      refuses BEFORE opening it — `flags:"w"` truncates, so a late refusal destroys the log it
//      was declining to write.
//
// Run: node scripts/quality-sweep.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  STEPS,
  TRANSCRIPT,
  SWEEP_LOCK_DB,
  SWEEP_OWNER,
  BUSY_EXIT_CODE,
  selected,
  summaryText,
  exitCodeFor,
  guardBrokenPipe,
  sweepBusyText,
  sweepArtifactPaths,
} = require("./quality-sweep.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server");
const { LOCK_DB, OWNER_FILE } = require(path.join(SERVER, "scripts", "gate-run-lease.cjs"));

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
const rule = fs.readFileSync(path.join(ROOT, ".claude", "rules", "nightly-quality-sweep.md"), "utf8");
const documented = [...rule.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1]));
assert.deepEqual(
  covered,
  documented,
  `the sweep driver and its documented sections must match exactly — driver=[${covered}] docs=[${documented}]`,
);

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

// --- 7. a second sweep refuses instead of shredding the first one's transcript -------------------
// Both instances open TRANSCRIPT with `flags:"w"` and write at independent offsets, so two live
// sweeps interleave one file: on 2026-09-11 the summary that got read said step 2 green while
// `test:zai-usage` had failed, with another step's output spliced through the gate list. The lease is
// the existing SQLite one the gate suite already uses, on its own lock file so a sweep never blocks
// the gates run it is about to spawn.
const { spawnSync } = require("node:child_process");
const { acquireGateRunLease } = require(path.join(SERVER, "scripts", "gate-run-lease.cjs"));

assert.ok(SWEEP_LOCK_DB.startsWith(path.join(SERVER, "data")), "the sweep lock lives in gitignored server/data");
assert.notEqual(SWEEP_LOCK_DB, LOCK_DB, "a sweep must not take the GATE lease — it spawns a gates run itself");
assert.notEqual(SWEEP_OWNER, OWNER_FILE, "…and must not overwrite the gate lease's owner file either");

const busy = sweepBusyText({ pid: 4321, startedAtIso: "2026-09-11T03:25:00.000Z" });
assert.match(busy, /PID 4321/, "the refusal must name the incumbent, or it cannot be acted on");
assert.match(busy, /taskkill \/PID 4321/, "…with the command that ends it");
assert.match(busy, /--force/, "…and the override, so the guard is never a dead end");
assert.match(busy, /NOT a sweep result/, "…and must refuse to be read as a verdict");

// Exercised in a sandbox, never on the production lease: step 2 of the sweep spawns the gate suite,
// so this file routinely runs WHILE a sweep holds that lease, and claiming it here would both fail
// ("a free lease must be claimable") and truncate the running sweep's own transcript.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gg-sweep-gate-"));
const sandboxed = sweepArtifactPaths(sandbox);
assert.notEqual(sandboxed.lockDb, SWEEP_LOCK_DB, "GGO_SWEEP_SANDBOX must relocate the lease…");
assert.notEqual(sandboxed.owner, SWEEP_OWNER, "…its owner file…");
assert.notEqual(sandboxed.transcript, TRANSCRIPT, "…and the transcript, which this gate would otherwise truncate");

try {
  const held = acquireGateRunLease({ lockDbPath: sandboxed.lockDb, ownerPath: sandboxed.owner });
  assert.ok(held.acquired, "a free lease must be claimable");
  try {
    const second = spawnSync(process.execPath, [path.join(ROOT, "scripts", "quality-sweep.cjs"), "1"], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, GGO_SWEEP_SANDBOX: sandbox },
    });
    assert.equal(second.status, BUSY_EXIT_CODE, "a second sweep exits BUSY, never 0 — busy is not a pass");
    assert.match(second.stdout, /already running/);
    assert.equal(
      fs.existsSync(sandboxed.transcript),
      false,
      "and it must refuse BEFORE opening the transcript, which truncates",
    );
  } finally {
    held.release();
  }
  const reclaimed = acquireGateRunLease({ lockDbPath: sandboxed.lockDb, ownerPath: sandboxed.owner });
  assert.ok(reclaimed.acquired, "a released lease is immediately reclaimable — the guard must not outlive the run that took it");
  reclaimed.release();
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`qualitySweep: all assertions passed (${STEPS.length} steps across ${covered.length} sections)`);
