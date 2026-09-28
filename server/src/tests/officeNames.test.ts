// Self-chosen office names: normalisation and live-collision resolution (there is no default name pool).
// Run: npx tsx src/tests/officeNames.test.ts

import assert from "node:assert/strict";
import {
  cleanOfficeName,
  firstFreeName,
  NAME_REUSE_WINDOW_MS,
  OFFICE_NAME_MAX,
  pruneNameUses,
  recentNameHolder,
  resolveLiveNameCollisions,
} from "../orchestrator/officeNames.js";
import { unnamedAgentLabel } from "../types.js";

// Normalisation: whitespace collapsed, markdown/quote wrapping dropped, clamped to the tool's max.
assert.equal(cleanOfficeName("  Marigold \n  Thistlewick "), "Marigold Thistlewick");
assert.equal(cleanOfficeName('**"Nettle"**'), "Nettle");
assert.equal(cleanOfficeName("   "), "");
assert.equal(cleanOfficeName("x".repeat(40)).length, OFFICE_NAME_MAX);

// An unnamed agent goes by its role, not an invented default.
assert.equal(unnamedAgentLabel("implementor"), "Implementor");
assert.equal(unnamedAgentLabel("qa"), "QA");

// Numbered variants when a name is taken, case-insensitively, still within the max length.
assert.equal(firstFreeName("Moss", new Set()), "Moss");
assert.equal(firstFreeName("Moss", new Set(["moss"])), "Moss 2");
assert.equal(firstFreeName("Moss", new Set(["Moss", "Moss 2"])), "Moss 3");
const long = "y".repeat(OFFICE_NAME_MAX);
assert.equal(firstFreeName(long, new Set([long])).length, OFFICE_NAME_MAX);
assert.ok(firstFreeName(long, new Set([long])).endsWith(" 2"));

// Live collisions: the senior agent keeps the name, the later one gets a variant; unnamed agents are skipped.
{
  const names = { "a::implementor": "Moss", "b::implementor": "Moss" };
  const changes = resolveLiveNameCollisions(
    [
      { threadId: "b", role: "implementor", startedAt: 200 },
      { threadId: "a", role: "implementor", startedAt: 100 },
      { threadId: "c", role: "qa", startedAt: 50 },
    ],
    names,
  );
  assert.deepEqual([...changes], [["b::implementor", "Moss 2"]]);
}

// A task's own earlier agent (not live any more) still blocks its name, so one feed never shows two of it.
{
  const names = { "a::implementor": "Fern", "a::qa": "Fern" };
  const changes = resolveLiveNameCollisions([{ threadId: "a", role: "qa", startedAt: 1 }], names);
  assert.deepEqual([...changes], [["a::qa", "Fern 2"]]);
}

// A stable, collision-free live set changes nothing.
{
  const names = { "a::implementor": "Fern", "b::implementor": "Moss" };
  const live = [
    { threadId: "a", role: "implementor" as const, startedAt: 1 },
    { threadId: "b", role: "implementor" as const, startedAt: 2 },
  ];
  assert.equal(resolveLiveNameCollisions(live, names).size, 0);
}

// A numbered variant skips names other agents held within the reuse window.
{
  const names = { "a::implementor": "Moss", "b::implementor": "Moss" };
  const live = [
    { threadId: "a", role: "implementor" as const, startedAt: 1 },
    { threadId: "b", role: "implementor" as const, startedAt: 2 },
  ];
  const changes = resolveLiveNameCollisions(live, names, new Set(["moss 2"]));
  assert.deepEqual([...changes], [["b::implementor", "Moss 3"]]);
}

// Reuse window: another agent's name blocks for 30 days after its last use, case-insensitively; your own never does.
{
  const now = 1_000 * NAME_REUSE_WINDOW_MS;
  const day = 24 * 60 * 60 * 1000;
  const uses = [
    { agentKey: "old::qa", name: "Fern", lastUsedAt: now - 31 * day },
    { agentKey: "recent::implementor", name: "Fern", lastUsedAt: now - 29 * day },
    { agentKey: "newest::planner", name: "fern", lastUsedAt: now - day },
  ];
  assert.equal(recentNameHolder("FERN", "me::implementor", uses, now)?.agentKey, "newest::planner");
  assert.equal(recentNameHolder("Fern", "me::implementor", uses.slice(0, 1), now), null);
  assert.equal(recentNameHolder("Fern", "newest::planner", uses.slice(2), now), null);
  assert.equal(recentNameHolder("Bramble", "me::implementor", uses, now), null);
  assert.deepEqual(pruneNameUses(uses, now).map((u) => u.agentKey), ["recent::implementor", "newest::planner"]);
}

console.log("All officeNames checks passed.");
