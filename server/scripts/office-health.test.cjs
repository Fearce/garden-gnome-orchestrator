#!/usr/bin/env node
// Gate for probe:office — the nightly check that the Online Office is actually TWO-WAY.
//
// What it pins, and why each was worth an assertion:
//   1. A line carrying this instance's own name AFTER the fix is a FAILURE. That is the regression the
//      probe exists for: an instance receiving what it sent makes every solo agent believe it has a
//      teammate (itself), because `repoPeers` is the office ON-switch.
//   2. The same line BEFORE the fix is NOT a failure. This is the assertion that matters most, and it
//      is here because the probe's first version got it wrong: a date-granularity boundary flagged two
//      rows written ninety minutes before the fix and went red on a healthy office. A nightly check that
//      cries wolf stops being read — so the boundary is the kv stamp the fixed build writes on first
//      boot, and this pins that the distinction survives.
//   3. With no boundary at all (the fixed build never booted here) nothing is called a regression.
//   4. A cross-machine room the console will not show is a FAILURE — the "invisible conversation"
//      defect, where coordination works and the owner cannot reach it.
//   5. A genuinely-remote line with no machine stamp is a WARNING, not a failure: it means a room can
//      silently go unreachable, but it is not proof that one has.
//
// Free: pure functions over synthetic rows, no DB, no network, no agent.
//
// Run: node scripts/office-health.test.cjs

const assert = require("node:assert/strict");
const { SELF_ECHO_FIX, classifyOfficeRows, senderMachine, verdictFor } = require("./probe-office.cjs");

const SELF = "Kevin";
const FIX_AT = Date.parse("2026-08-25T08:30:00Z");
const before = FIX_AT - 90 * 60_000; // the ninety minutes that broke the first design
const after = FIX_AT + 60 * 60_000;

const row = (over = {}) => ({ id: "r", room: "repo:c:/vota", sender_name: null, remote_instance: null, created_at: after, ...over });

// --- senderMachine: the only way to recover a machine from a pre-column row --------------------
assert.equal(senderMachine("Sif @ Mikkel's laptop"), "Mikkel's laptop");
assert.equal(senderMachine("Eir"), null, "a local gnome name carries no machine");
assert.equal(senderMachine(null), null);
assert.equal(senderMachine("Sif @ Box @ Two"), "Box @ Two", "split on the FIRST separator — the rest is the machine");

// --- 1. a self-named line after the fix is a live regression -----------------------------------
{
  const echo = classifyOfficeRows({
    rows: [row({ sender_name: "Juni @ Kevin", created_at: after })],
    selfName: SELF,
    fixAt: FIX_AT,
  });
  assert.equal(echo.liveEcho.length, 1, "a line carrying this instance's own name after the fix is a regression");
  assert.equal(echo.residue.length, 0);
  const v = verdictFor({ echo, rooms: [] });
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /own name/, "the verdict has to say what it found");
}

// --- 2. the SAME line before the fix is residue, not a failure ---------------------------------
//     The cry-wolf case. A date-granularity boundary called this a regression and reddened a healthy
//     office; only a boundary that knows when the fixed build actually ran can tell them apart.
{
  const echo = classifyOfficeRows({
    rows: [row({ sender_name: "Juni @ Kevin", created_at: before })],
    selfName: SELF,
    fixAt: FIX_AT,
  });
  assert.equal(echo.liveEcho.length, 0, "a self-named line written BEFORE the fix is residue, not a regression");
  assert.equal(echo.residue.length, 1);
  assert.equal(verdictFor({ echo, rooms: [] }).ok, true, "residue must never fail the sweep — that is how a check stops being read");
}

// --- 3. no boundary yet ⇒ nothing can be judged a regression -----------------------------------
{
  const echo = classifyOfficeRows({
    rows: [row({ sender_name: "Juni @ Kevin", created_at: after })],
    selfName: SELF,
    fixAt: null,
  });
  assert.equal(echo.liveEcho.length, 0, "with no recorded fix boot, a self-named row cannot be called a regression");
  assert.equal(echo.residue.length, 1);
}

// --- a genuinely remote line is neither -------------------------------------------------------
{
  const echo = classifyOfficeRows({
    rows: [row({ sender_name: "Sif @ Mikkel's laptop", remote_instance: "Mikkel's laptop" })],
    selfName: SELF,
    fixAt: FIX_AT,
  });
  assert.deepEqual([echo.liveEcho.length, echo.residue.length, echo.unstamped.length], [0, 0, 0]);
}

// --- 5. a remote line with no stamp is a warning, not a failure --------------------------------
{
  const echo = classifyOfficeRows({
    rows: [row({ sender_name: "Sif @ Mikkel's laptop", remote_instance: null })],
    selfName: SELF,
    fixAt: FIX_AT,
  });
  assert.equal(echo.unstamped.length, 1, "a remote line nothing stamped counts toward no room's participants");
  assert.equal(verdictFor({ echo, rooms: [] }).ok, true, "…but it is not proof a room went unreachable");
}

// --- 4. a cross-machine room the console will not show is a failure ----------------------------
{
  const empty = { liveEcho: [], residue: [], unstamped: [] };
  const reachable = { room: "repo:c:/repos/card_marker", remoteInstances: ["Mikkel's laptop"], reachable: true };
  assert.equal(verdictFor({ echo: empty, rooms: [reachable] }).ok, true);

  const hidden = { room: "repo:c:/repos/card_marker", remoteInstances: ["Mikkel's laptop"], reachable: false };
  const v = verdictFor({ echo: empty, rooms: [hidden] });
  assert.equal(v.ok, false, "a room holding cross-machine talk that the console will not show is the defect this probe exists for");
  assert.match(v.problems[0], /card_marker/, "name the room, or the verdict is unactionable");

  // Unknown (server not built) must not be read as broken — that would fail every unbuilt checkout.
  const unknown = { room: "repo:x", remoteInstances: ["Someone"], reachable: null };
  assert.equal(verdictFor({ echo: empty, rooms: [unknown] }).ok, true, "an unknown reachability verdict is not a failure");
}

// --- the boundary is read from the DB, never hardcoded ----------------------------------------
assert.equal(SELF_ECHO_FIX.kv, "remote_instance_backfill_v1", "the boundary must come from the stamp the fixed build writes");
assert.ok(!("at" in SELF_ECHO_FIX), "a hardcoded timestamp is what made this check cry wolf — it must not come back");

console.log("office health: all assertions passed");
