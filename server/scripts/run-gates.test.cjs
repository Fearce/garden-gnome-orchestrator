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
//   5. One OS-backed lease owns the shared transcript; a killed owner releases it automatically.
//      A pidfile would need stale/PID-reuse guesses and can still strand or steal the suite.
//
// Run: node scripts/run-gates.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const {
  BUSY_EXIT_CODE,
  GATES,
  TRANSCRIPT,
  busyText,
  clearCompletedStamp,
  gitStatusPaths,
  guardBrokenPipe,
  summaryText,
  tail,
} = require("./run-gates.cjs");
const { LOCK_DB, OWNER_FILE, acquireGateRunLease, readOwner } = require("./gate-run-lease.cjs");

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
for (const runtimePath of [LOCK_DB, OWNER_FILE]) {
  assert.equal(
    path.relative(ROOT, path.dirname(runtimePath)).split(path.sep).join("/"),
    "server/data",
    "gate lease artifacts belong beside the ignored transcript",
  );
}

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

const busy = busyText({ pid: 1234, startedAtIso: "2026-09-09T14:00:00.000Z" });
assert.notEqual(BUSY_EXIT_CODE, 0, "a duplicate invocation is not proof that the gates passed");
assert.match(busy, /PID 1234/);
assert.match(busy, /2026-09-09T14:00:00\.000Z/);
assert.ok(busy.includes(TRANSCRIPT), "the rejected runner must point at the active owner's transcript");
assert.match(busy, /did not touch the transcript or completion stamp/);
assert.match(busy, /not a gate pass/);

assert.deepEqual(
  gitStatusPaths(() => " M server/scripts/run-gates.cjs\r\n?? server/scripts/new.cjs\r\n"),
  ["server/scripts/run-gates.cjs", "server/scripts/new.cjs"],
  "the leading status column must survive long enough to preserve the first path's first byte",
);
assert.deepEqual(
  gitStatusPaths(() => {
    throw new Error("not a git checkout");
  }),
  [],
  "a source tarball without Git still runs the suite",
);

// --- 4. the tail helper keeps the END (where a failure's reason is), not the head ---------------
const many = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
const kept = tail(many, 12).split("\n");
assert.equal(kept.length, 12);
assert.equal(kept[kept.length - 1], "line 40", "the last line is the one that says why a gate failed");

// --- 5. the gate list is a list of distinct npm scripts ----------------------------------------
assert.equal(new Set(GATES).size, GATES.length, "a duplicated gate would be run (and counted) twice");
const scripts = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")).scripts ?? {};
for (const gate of GATES) assert.ok(scripts[gate], `${gate} is in GATES but has no npm script — the suite would report it failing every run`);

// --- 6. one full suite owns the shared transcript at a time ------------------------------------
const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-gate-lease-"));
const leaseOptions = {
  lockDbPath: path.join(leaseDir, "lease.sqlite"),
  ownerPath: path.join(leaseDir, "owner.json"),
  command: "run-gates test owner",
  timeoutMs: 10,
};

try {
  const oldStamp = path.join(leaseDir, "old-completion.json");
  fs.writeFileSync(oldStamp, "old pass\n", "utf8");
  clearCompletedStamp(oldStamp);
  assert.equal(fs.existsSync(oldStamp), false, "a new owned run must invalidate the previous completion stamp");
  clearCompletedStamp(oldStamp); // no prior run is a normal first-run state

  const first = acquireGateRunLease(leaseOptions);
  assert.equal(first.acquired, true, "the first full-suite process must acquire the lease");
  assert.equal(readOwner(leaseOptions.ownerPath)?.pid, process.pid, "the busy diagnostic must name the owner");

  const duplicate = acquireGateRunLease(leaseOptions);
  assert.equal(duplicate.acquired, false, "a second full suite must not overwrite the shared transcript");
  assert.equal(duplicate.owner?.pid, process.pid, "the rejected runner should identify the active owner");

  first.release();
  first.release(); // release is deliberately idempotent
  assert.equal(readOwner(leaseOptions.ownerPath), null, "a clean release removes its own diagnostic metadata");

  const next = acquireGateRunLease(leaseOptions);
  assert.equal(next.acquired, true, "the lease must be immediately reusable after a clean release");
  fs.writeFileSync(
    leaseOptions.ownerPath,
    `${JSON.stringify({ version: 1, token: "replacement", pid: 42 })}\n`,
    "utf8",
  );
  next.release();
  assert.equal(
    readOwner(leaseOptions.ownerPath)?.token,
    "replacement",
    "an old releaser must never delete a newer owner's diagnostic metadata",
  );

  const metadataFailureDb = path.join(leaseDir, "metadata-failure.sqlite");
  assert.throws(
    () => acquireGateRunLease({ ...leaseOptions, lockDbPath: metadataFailureDb, ownerPath: leaseDir }),
    /EISDIR|EPERM/,
    "a diagnostic-write failure must stay visible",
  );
  const afterMetadataFailure = acquireGateRunLease({
    ...leaseOptions,
    lockDbPath: metadataFailureDb,
    ownerPath: path.join(leaseDir, "metadata-recovery.json"),
  });
  assert.equal(afterMetadataFailure.acquired, true, "a diagnostic failure must release the real lease");
  afterMetadataFailure.release();
} finally {
  fs.rmSync(leaseDir, { recursive: true, force: true });
}

// --- 7. a killed runner cannot strand the lease ------------------------------------------------
async function assertCrashSafeLease() {
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-gate-crash-"));
  const options = {
    lockDbPath: path.join(crashDir, "lease.sqlite"),
    ownerPath: path.join(crashDir, "owner.json"),
    command: "run-gates killed owner",
    timeoutMs: 10,
  };
  const helper = path.join(__dirname, "gate-run-lease.cjs");
  const childSource = [
    `const { acquireGateRunLease } = require(${JSON.stringify(helper)});`,
    "const lease = acquireGateRunLease({ lockDbPath: process.env.TEST_LOCK_DB, ownerPath: process.env.TEST_OWNER_FILE, command: 'child' });",
    "if (!lease.acquired) process.exit(2);",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childSource], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, TEST_LOCK_DB: options.lockDbPath, TEST_OWNER_FILE: options.ownerPath },
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the lease-holder child")), 5_000);
      let ready = false;
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (code, signal) => {
        if (ready) return;
        clearTimeout(timer);
        reject(new Error(`lease-holder child exited before ready (code ${code}, signal ${signal}): ${childStderr.trim()}`));
      });
      child.stdout.once("data", (chunk) => {
        ready = true;
        clearTimeout(timer);
        assert.match(chunk.toString(), /ready/);
        resolve();
      });
    });

    const blocked = acquireGateRunLease(options);
    assert.equal(blocked.acquired, false, "the child process must own the lease while alive");

    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;

    const recovered = acquireGateRunLease(options);
    assert.equal(recovered.acquired, true, "the OS-backed lease must recover without stale-lock heuristics");
    recovered.release();
  } finally {
    if (child.exitCode == null && child.signalCode == null && child.pid) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(crashDir, { recursive: true, force: true });
  }
}

assertCrashSafeLease()
  .then(() => console.log(`runGates: all assertions passed (${GATES.length} gates, transcript ${path.relative(ROOT, TRANSCRIPT)})`))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
