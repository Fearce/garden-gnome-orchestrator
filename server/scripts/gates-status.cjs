#!/usr/bin/env node
// "We ran the gates and they were green" — but over WHICH tree, and does that green still cover
// what is here now? Read-only; run it before quoting a gate result you did not personally watch.
//
//   npm run probe:gates --prefix server
//
// Exit 1 only when the last completed run was RED — a stale green is the normal state mid-session
// (you edited code and have not re-run yet) and must not red a sweep step. See `gates-provenance.cjs`
// for the verdict logic and the 2026-08-26 failure that motivated it.

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readStamp, assessStamp, fingerprintFile } = require("./gates-provenance.cjs");
const { STAMP, GATES } = require("./run-gates.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(SERVER_DIR, "..");
const RUNNER = path.join(SERVER_DIR, "scripts", "run-gates.cjs");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT_DIR, encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function lines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = mins / 60;
  return hrs < 48 ? `${hrs.toFixed(1)}h ago` : `${(hrs / 24).toFixed(1)}d ago`;
}

function currentState(stamp) {
  const head = git(["rev-parse", "HEAD"]);
  const changedSince = stamp?.head && head && stamp.head !== head ? lines(git(["diff", "--name-only", `${stamp.head}..${head}`])) : [];
  return {
    head,
    runnerFingerprint: fingerprintFile(RUNNER),
    changedSince,
    dirty: lines(git(["status", "--porcelain"])).map((l) => l.slice(3)),
  };
}

function describeRun(stamp) {
  const secs = Math.round((stamp.endedAt - stamp.startedAt) / 1000);
  console.log(`  last completed run : ${stamp.passed}/${stamp.total} passed in ${Math.floor(secs / 60)}m${secs % 60}s, ${ago(stamp.endedAt)}`);
  console.log(`  against commit     : ${stamp.head ? stamp.head.slice(0, 8) : "(no repo)"}${stamp.dirty.length ? ` + ${stamp.dirty.length} uncommitted file(s)` : " (clean tree)"}`);
  if (stamp.total !== GATES.length) {
    console.log(`  ⚠ the suite now holds ${GATES.length} gate(s), that run covered ${stamp.total}`);
  }
  const slowest = [...stamp.gates].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`  slowest            : ${slowest.map((g) => `${g.gate} ${(g.ms / 1000).toFixed(0)}s`).join(" · ")}`);
}

function main() {
  const stamp = readStamp(STAMP);
  const { verdict, reasons, caveats } = assessStamp(stamp, currentState(stamp));

  console.log(`\nGate suite provenance (${STAMP})\n`);
  if (stamp) describeRun(stamp);
  else console.log("  no stamp on disk — no suite has run to completion here, or the data dir was cleared");

  console.log("");
  if (verdict === "fresh") console.log("  ✓ FRESH — that green still covers this tree and the harness that produced it.");
  if (verdict === "stale") console.log("  ⚠ STALE — the last run passed, but it no longer describes what is here now:");
  if (verdict === "red") console.log("  ✗ RED — the last completed run had failures:");
  if (verdict === "none") console.log("  · UNKNOWN — nothing to compare against:");
  for (const r of reasons ?? []) console.log(`      - ${r}`);
  for (const c of caveats ?? []) console.log(`      · ${c}`);

  if (verdict !== "fresh") console.log("\n  Re-run with: npm run test:gates --prefix server   (background it; watch server/data/gates-last.log)");
  console.log(
    "\nReading it: a stamp is written ONLY by a run that reached its summary, so a missing one means the\n" +
      "suite was interrupted, not that it failed. The harness reason is the one to respect even when it\n" +
      "looks pedantic — a change to run-gates.cjs changes the gate LIST as well as the spawn, so a green\n" +
      "from before it describes a different suite (2026-08-26).\n",
  );
  return verdict === "red" ? 1 : 0;
}

module.exports = { ago, currentState };

if (require.main === module) process.exit(main());
