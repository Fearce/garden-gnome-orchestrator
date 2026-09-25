#!/usr/bin/env node
/**
 * Which gates exercise this symbol — and run them, before paying for the whole suite.
 *
 * The full free suite is several minutes even with parallel gates, so the expensive mistake is
 * discovering a broken gate one suite at a time. That is exactly what a change to a SHARED seam does:
 * 2026-09-17 added a `this.accounts.select()` call to `startResumedImplementor`, every itest whose StubAccounts carried
 * only `dispatchPreview` then crashed, and each one surfaced a full suite run apart.
 *
 * The fix is not a smarter suite, it is asking the question first: which test files mention the thing
 * I just changed? That grep was hand-rolled twice in two sessions, and both times the hand-built
 * follow-up loop ran a SUBSET of its own answer and missed a gate. So it lives here, and it runs the
 * whole answer.
 *
 * Usage (from the repo root or server/):
 *   npm run gates:touching --prefix server -- startResumedImplementor
 *   npm run gates:touching --prefix server -- --list runRole usageSavingTarget
 *   npm run gates:touching --prefix server -- --list --all-matches poolResolved
 *
 * A symbol is matched as a plain case-sensitive substring — the same thing a `grep -l` would do, and
 * deliberately not a parsed identifier: a gate that reaches your change through a string literal, an
 * `internals.<name>` bracket access or a comment naming it is still a gate you want to have run.
 *
 * This is a PRE-FLIGHT, never a replacement for `npm run test:gates`. It can only find a gate that
 * NAMES the symbol, and the suite is what proves the rest. Exits non-zero if any selected gate fails.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(SERVER_DIR, "src", "tests");

/** Every npm script that runs at least one file under `src/tests`, indexed by the files it runs.
 *  A script can run several (`a.ts && b.ts && c.cjs`), and a file can appear in more than one, so
 *  this is many-to-many and both directions matter: the caller wants the SCRIPT, keyed by the FILE
 *  its grep hit. Derived from package.json rather than hard-coded, so a newly registered gate is
 *  found the day it lands. */
function scriptsByTestFile(pkg) {
  const byFile = new Map();
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    for (const match of String(command).matchAll(/src\/tests\/([A-Za-z0-9_.-]+)/g)) {
      const file = match[1];
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file).add(name);
    }
  }
  return byFile;
}

/** Test files containing any of `symbols`, as plain substrings. */
function testFilesMentioning(symbols) {
  const hits = new Map();
  let entries;
  try {
    entries = fs.readdirSync(TESTS_DIR);
  } catch {
    return hits;
  }
  for (const entry of entries) {
    const full = path.join(TESTS_DIR, entry);
    let text;
    try {
      if (!fs.statSync(full).isFile()) continue;
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const found = symbols.filter((symbol) => text.includes(symbol));
    if (found.length) hits.set(entry, found);
  }
  return hits;
}

function runGate(name) {
  const started = Date.now();
  const res = spawnSync("npm", ["run", "--silent", name], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    name,
    ok: res.status === 0,
    seconds: Math.round((Date.now() - started) / 1000),
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function main(argv) {
  const listOnly = argv.includes("--list");
  const allMatches = argv.includes("--all-matches");
  const symbols = argv.filter((arg) => !arg.startsWith("--"));
  if (!symbols.length) {
    console.log("usage: npm run gates:touching --prefix server -- [--list] [--all-matches] <symbol> ...");
    console.log("  names every registered gate whose test file mentions a symbol, then runs them.");
    return 2;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8"));
  const byFile = scriptsByTestFile(pkg);
  const hits = testFilesMentioning(symbols);

  const gates = new Map(); // gate name -> the test files that selected it
  const unregistered = [];
  for (const [file, found] of hits) {
    const scripts = byFile.get(file);
    // A test file with no npm script is `test:gate-registration`'s problem, not this tool's — but it
    // IS a file mentioning your change that nothing will run, so say so rather than dropping it.
    if (!scripts?.size) {
      unregistered.push(`${file} (mentions ${found.join(", ")})`);
      continue;
    }
    for (const script of scripts) {
      if (!gates.has(script)) gates.set(script, []);
      gates.get(script).push(file);
    }
  }

  const names = [...gates.keys()].sort();
  console.log(`\n=== gates mentioning ${symbols.join(", ")} ===`);
  if (!names.length) console.log("  none — the suite is the only thing that covers this change");
  for (const name of names) {
    const via = allMatches ? `  ← ${[...new Set(gates.get(name))].join(", ")}` : "";
    console.log(`  ${name}${via}`);
  }
  for (const line of unregistered) console.log(`  ⚠ no npm script runs ${line}`);
  if (listOnly || !names.length) {
    console.log("");
    return 0;
  }

  console.log(`\n=== running ${names.length} gate(s) ===`);
  const failures = [];
  for (const name of names) {
    const result = runGate(name);
    console.log(`  ${result.ok ? "✅" : "❌"} ${name} (${result.seconds}s)`);
    if (!result.ok) failures.push(result);
  }
  for (const failure of failures) {
    console.log(`\n─── ${failure.name}: FAILED ───`);
    console.log(failure.output.split(/\r?\n/).slice(-25).join("\n"));
  }
  console.log(
    failures.length
      ? `\n${names.length - failures.length}/${names.length} passed — fix these before spending a full suite run\n`
      : `\n${names.length}/${names.length} passed — a pre-flight, not a verdict: still run npm run test:gates\n`,
  );
  return failures.length ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
