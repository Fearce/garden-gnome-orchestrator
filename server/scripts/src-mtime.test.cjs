#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { walkRuntimeSrcFiles, newestSrcMtimeMs, srcFilesNewerThan } = require("./src-mtime.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "src-mtime-test-"));

function touch(rel, mtimeMs) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "// fixture\n");
  const t = mtimeMs / 1000;
  fs.utimesSync(full, t, t);
  return full;
}

const BASE = 1_700_000_000_000; // an arbitrary fixed instant, so the fixture never depends on `Date.now()`

touch("orchestrator/threadManager.ts", BASE + 60_000); // changed AFTER a process started at BASE
touch("agents/runner.ts", BASE - 60_000); // unchanged, older than the process start
touch("db/db.ts", BASE); // exactly at the boundary, not counted (strictly after only)
touch("tests/threadManager.test.ts", BASE + 60_000); // excluded dir
touch("tools/probe.ts", BASE + 60_000); // excluded dir
touch("orchestrator/threadManager.test.ts", BASE + 60_000); // excluded suffix, non-excluded dir
touch("orchestrator/threadManager.itest.ts", BASE + 60_000); // excluded suffix
touch("orchestrator/notes.js", BASE + 60_000); // wrong extension, tsx never loads a .js under src
touch("orchestrator/README.md", BASE + 60_000); // not a source file at all

// --- walkRuntimeSrcFiles: the exclusion rules -----------------------------------------------------
{
  const files = walkRuntimeSrcFiles(tmp).map((f) => path.relative(tmp, f.path).split(path.sep).join("/"));
  assert.deepEqual(
    files.sort(),
    ["agents/runner.ts", "db/db.ts", "orchestrator/threadManager.ts"].sort(),
    "tests/, tools/, .test./.itest. suffixes, and non-ts-family files must all be excluded",
  );
}

// --- newestSrcMtimeMs -------------------------------------------------------------------------------
{
  assert.equal(newestSrcMtimeMs(tmp), BASE + 60_000);
}
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "src-mtime-empty-"));
  assert.equal(newestSrcMtimeMs(empty), null, "an empty/unreadable src dir must report null, never 0 or a throw");
  assert.equal(newestSrcMtimeMs(path.join(empty, "does-not-exist")), null);
  fs.rmSync(empty, { recursive: true, force: true });
}

// --- srcFilesNewerThan: THE CHECK THE SOURCE-RUN LIVENESS FIX DEPENDS ON ---------------------------
// 2026-09-11: a process running from source under tsx has no build stamp, so the only honest liveness
// signal is "did any runtime file's on-disk bytes change after this process started". This is that
// signal; get the boundary or the exclusions wrong here and nightly-health.cjs either misses a real
// drift or cries wolf on every sweep.
{
  const drifted = srcFilesNewerThan(BASE, tmp, tmp);
  assert.deepEqual(
    drifted.map((f) => f.path),
    ["orchestrator/threadManager.ts"],
    "only the file strictly newer than the process start counts; the boundary case and the excluded paths must not",
  );
}
{
  // Nothing drifted: every runtime file predates (or equals) the process start.
  const drifted = srcFilesNewerThan(BASE + 120_000, tmp, tmp);
  assert.deepEqual(drifted, [], "a start time after every file's mtime must report no drift");
}
{
  // Newest-first ordering, for a caller that only wants to name the first few.
  touch("agents/second.ts", BASE + 90_000);
  const drifted = srcFilesNewerThan(BASE, tmp, tmp);
  assert.deepEqual(
    drifted.map((f) => f.path),
    ["agents/second.ts", "orchestrator/threadManager.ts"],
    "results are sorted newest-first",
  );
}
{
  assert.deepEqual(srcFilesNewerThan(NaN, tmp, tmp), [], "a non-finite instant must never be treated as `Number.NEGATIVE_INFINITY`");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("src-mtime: ok");
