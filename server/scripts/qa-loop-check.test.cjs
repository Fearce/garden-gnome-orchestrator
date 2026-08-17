#!/usr/bin/env node

const assert = require("node:assert/strict");
const { qaLoopReading, accountedLaunches } = require("./qa-loop-check.cjs");

const text = (r) => r.lines.join("\n");
const base = {
  cap: 10,
  launches: 1,
  roundsUsed: 1,
  cutoffResumes: 0,
  silentRetries: 0,
  capFailovers: 0,
  interrupted: 0,
  appliesFixes: false,
};

// --- the launch arithmetic ----------------------------------------------------
// Every recovery mechanism spends a launch without spending a round. Miss one and the
// reconciliation line starts reporting phantom "unexplained" launches.
assert.equal(accountedLaunches({ roundsUsed: 6, cutoffResumes: 2, silentRetries: 1, capFailovers: 0 }), 9);
assert.equal(accountedLaunches({ roundsUsed: 4, cutoffResumes: 2, silentRetries: 1, capFailovers: 1 }), 8);
assert.equal(accountedLaunches({}), 0, "a task with no counters accounts for nothing, rather than throwing");

// A restart casualty is NOT a fourth term. The loop charges the round BEFORE launching QA
// so a killed run still costs one, which means those launches are already inside
// roundsUsed. 7295b2dc, live: 10 launches, 10 rounds, 2 interrupted — counting the
// casualties again would claim 12 accounted launches against 10 real rows.
assert.equal(accountedLaunches({ roundsUsed: 10, interrupted: 2 }), 10, "an interrupted run's round is already charged");
{
  const r = qaLoopReading({ ...base, launches: 10, roundsUsed: 10, interrupted: 2, cap: 10 });
  assert.equal(r.warn, false, "10 rounds against a 10-round cap is at the cap, not past it");
  assert.match(text(r), /10 QA launch\(es\) = 10 round\(s\)/);
  assert.match(text(r), /already counted above, not extra/);
  assert.doesNotMatch(text(r), /don't account for/, "double-counting casualties would invent a shortfall");
}

// --- THE 2026-08-17 REGRESSION ------------------------------------------------
// The check compared QA *launches* against the *rounds* cap. Real production tasks run
// launches well past their round count via the four separately-budgeted recoveries, so a
// healthy task was one continuation away from being reported as the durable-budget drain
// bug (44f793b) — sending the reader after a defect fixed a month earlier.
// b5802a7b, live: 9 launches = 6 rounds + 2 cutoff + 1 silent, cap 10.
{
  const r = qaLoopReading({ ...base, launches: 9, roundsUsed: 6, cutoffResumes: 2, silentRetries: 1 });
  assert.equal(r.warn, false, "9 launches over 6 rounds against a 10-round cap is healthy");
  assert.match(text(r), /within the 10-round cap/);
  assert.doesNotMatch(text(r), /exceeded its budget/);
}
// The shape that would have tripped the old check outright: launches past the cap while
// the durable round counter is comfortably inside it.
{
  const r = qaLoopReading({ ...base, launches: 13, roundsUsed: 8, cutoffResumes: 2, silentRetries: 1, capFailovers: 2 });
  assert.equal(r.warn, false, "13 launches is not a budget breach when only 8 rounds were charged");
  assert.match(text(r), /13 QA launch\(es\) = 8 round\(s\)/);
}

// --- the drain signature must still fire --------------------------------------
// Loosening the check is the dangerous direction: this is the one condition it exists for.
{
  const r = qaLoopReading({ ...base, launches: 11, roundsUsed: 11, cap: 10 });
  assert.equal(r.warn, true, "the durable round counter passing the cap IS the drain bug");
  assert.match(text(r), /11 durable QA round\(s\) against a 10-round cap/);
  assert.match(text(r), /the launch count above is NOT/);
}

// --- never report a pass you did not actually check ---------------------------
{
  const r = qaLoopReading({ ...base, launches: 4, roundsUsed: null });
  assert.equal(r.warn, false);
  assert.match(text(r), /no durable qaRoundsUsed/);
  assert.doesNotMatch(text(r), /within the/, "an unknown round count must not read as a pass");
}
{
  const r = qaLoopReading({ ...base, launches: 4, roundsUsed: 4, cap: null });
  assert.match(text(r), /no cap to check/);
  assert.doesNotMatch(text(r), /within the/);
}

// --- unexplained launches are a reconciliation note, not the drain alarm -------
// aa0a7a3b, live: 7 launches, 3 rounds + 2 cutoff + 1 silent, and a cap failover on a row
// predating cap_flagged (93d39d4) — so one launch is genuinely unaccounted for.
{
  const r = qaLoopReading({ ...base, launches: 7, roundsUsed: 3, cutoffResumes: 2, silentRetries: 1 });
  assert.equal(r.warn, false, "an unreconciled launch is not a budget breach");
  assert.match(text(r), /1 launch\(es\) the counters don't account for/);
  assert.match(text(r), /93d39d4/, "name why a real cap failover can go uncounted");
}
{
  const r = qaLoopReading({ ...base, launches: 9, roundsUsed: 6, cutoffResumes: 2, silentRetries: 1 });
  assert.doesNotMatch(text(r), /don't account for/, "a fully reconciled trail says nothing");
}

// --- QA-fixes mode is named, because the trail is unreadable without it --------
// With it on, QA edits and re-verifies without relaunching the implementor, so "6 QA runs,
// 1 implementor run" is the designed shape. Nothing else the probe prints says so.
{
  const on = qaLoopReading({ ...base, launches: 6, roundsUsed: 3, cutoffResumes: 2, silentRetries: 1, appliesFixes: true });
  assert.match(text(on), /QA-fixes mode is ON/);
  assert.match(text(on), /implementor is not relaunched/);
  const off = qaLoopReading({ ...base, launches: 6, roundsUsed: 3, cutoffResumes: 2, silentRetries: 1 });
  assert.doesNotMatch(text(off), /QA-fixes mode/, "silent for the default single-mode setup");
}

console.log("qa-loop-check: all assertions passed");
