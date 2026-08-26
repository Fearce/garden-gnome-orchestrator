#!/usr/bin/env node
// What a green gate suite actually COVERED, so "we ran the gates" can be checked instead of assumed.
//
// The transcript says 71/71 passed. It does not say which tree that was, or whether the thing that
// produced it has changed since — and on 2026-08-26 that mattered: two commits of the night edited
// `run-gates.cjs`'s OWN spawn call AFTER the last complete pass, so the harness that reports on
// everything else was the one change nothing covered. A runner that can no longer launch its children
// fails in the direction that reads as success. Answering it took reading a log mtime against
// `git log` by hand; this module makes it a read.
//
// Pure over injected state (no git, no fs, no clock) so the gate can drive it directly —
// `gates-status.cjs` is the thin shell that gathers the real state and prints the verdict.

const crypto = require("node:crypto");
const fs = require("node:fs");

const STAMP_VERSION = 1;

/** A change to the runner changes the SUITE — its gate list lives there too — so a green from before
 *  it no longer describes the suite you would run now. Content-addressed, like every other staleness
 *  check here (`dist vs HEAD`): an mtime cries wolf on a checkout that rewrote the file unchanged. */
function fingerprint(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
}

function fingerprintFile(file) {
  try {
    return fingerprint(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Paths that cannot change what a gate does. Everything NOT listed here counts as code, because the
 *  dangerous direction is a false "still fresh" — an unrecognized path is assumed to matter. */
const INERT = [
  /\.md$/i,
  /^\.claude\//,
  /^docs\//,
  /^server\/data\//,
  /^\.gitignore$/,
  /^LICENSE$/i,
  /\.(png|jpe?g|gif|svg|ico|pdf)$/i,
];

const GATE_CODE = [/(^|\/)(src\/)?tests?\//, /\.(test|itest)\.(cjs|js|ts|mjs)$/];

/** Which kind of thing a changed path is, from the point of view of "does the last green still hold". */
function classifyPath(p) {
  const rel = String(p).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel) return "inert";
  if (rel === "server/scripts/run-gates.cjs") return "harness";
  if (INERT.some((re) => re.test(rel))) return "inert";
  if (GATE_CODE.some((re) => re.test(rel))) return "gate";
  return "product";
}

function bucket(paths) {
  const out = { harness: [], gate: [], product: [] };
  for (const p of paths ?? []) {
    const kind = classifyPath(p);
    if (kind !== "inert") out[kind].push(p);
  }
  return out;
}

function buildStamp({ startedAt, endedAt, head, dirty, runnerFingerprint, results }) {
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => r.gate);
  return {
    version: STAMP_VERSION,
    startedAt,
    endedAt,
    head: head ?? null,
    dirty: dirty ?? [],
    runnerFingerprint: runnerFingerprint ?? null,
    total: (results ?? []).length,
    passed: (results ?? []).length - failed.length,
    failed,
    gates: (results ?? []).map((r) => ({ gate: r.gate, ok: r.ok, ms: r.ms })),
  };
}

function readStamp(file) {
  try {
    const stamp = JSON.parse(fs.readFileSync(file, "utf8"));
    return stamp && stamp.version === STAMP_VERSION ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * Is the last recorded green still meaningful?
 *
 * `current` is injected: `{ head, runnerFingerprint, changedSince, dirty }` — `changedSince` being the
 * paths committed between the stamp's HEAD and now. A stamp is only ever written by a run that got
 * all the way to a summary, so its ABSENCE is itself a finding: an interrupted suite leaves none.
 */
function assessStamp(stamp, current = {}) {
  const reasons = [];
  if (!stamp) {
    return {
      verdict: "none",
      reasons: ["no completed gate run is recorded — the suite has not finished since this file was last cleared"],
    };
  }
  if (stamp.failed.length) {
    return {
      verdict: "red",
      reasons: [`the last completed run was RED: ${stamp.failed.join(", ")}`],
      stamp,
    };
  }

  // The harness first: it is the failure this whole module exists for, and it is true even when HEAD
  // has not moved (an uncommitted edit to the runner invalidates the green just as thoroughly).
  if (stamp.runnerFingerprint && current.runnerFingerprint && stamp.runnerFingerprint !== current.runnerFingerprint) {
    reasons.push("the gate RUNNER itself has changed since that pass — the green does not cover the harness that produced it, or the gate list it now holds");
  }

  // Dirt the run ALREADY had is not a change since it: the suite graded whatever was on disk then.
  // Counting it would make every green over a dirty tree read STALE immediately — and on a shared
  // checkout the tree is dirty most of the time, so the check would be permanently red and ignored.
  // What that dirt does cost is pinned-ness, which is what the caveat below says out loud.
  const alreadyDirty = new Set(stamp.dirty);
  const committed = bucket(current.changedSince);
  const uncommitted = bucket((current.dirty ?? []).filter((p) => !alreadyDirty.has(p)));
  if (committed.gate.length || uncommitted.gate.length) {
    reasons.push(`gate code has changed since that pass (${[...committed.gate, ...uncommitted.gate].length} file(s))`);
  }
  if (committed.product.length || uncommitted.product.length) {
    reasons.push(`code under test has changed since that pass (${[...committed.product, ...uncommitted.product].length} file(s))`);
  }
  if (!current.head || !stamp.head) {
    reasons.push("no commit was recorded for one side of the comparison, so what changed since is unknown");
  }

  const caveats = [];
  if (stamp.dirty.length) {
    caveats.push(`that run passed over a DIRTY tree (${stamp.dirty.length} uncommitted file(s)) — it covered work that may never be committed, and their content since is not pinned`);
  }
  return { verdict: reasons.length ? "stale" : "fresh", reasons, caveats, stamp };
}

module.exports = { STAMP_VERSION, fingerprint, fingerprintFile, classifyPath, bucket, buildStamp, readStamp, assessStamp };
