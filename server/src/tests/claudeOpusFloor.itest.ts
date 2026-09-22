/**
 * Integration test — the CLAUDE OPUS version floor.
 *
 * The owner reported a task running on `claude-opus-5` after Opus 5.5 shipped. Same shape as the Codex
 * `gpt-5.5` QA defect one file over, on the other backend and without the role scoping: the persisted
 * per-subscription role matrix held `claude-opus-5` for EVERY Claude role on BOTH subs, and `modelFor`
 * enforced it verbatim. `modelRoutingPolicy` already excluded retired Opus from the reviewed flagship
 * set and `filterAutoSelectionCandidates` already dropped legacy Codex ids, but neither sits on the
 * path a plain configured Claude model takes.
 *
 * So the assertions that matter are about RESOLUTION, not about a scoring function:
 *  - A stored retired Opus pin resolves to the current one, on every role, on any subscription.
 *  - A configured Sonnet/Fable/Haiku is NOT lifted — a cheaper tier is a choice, not an outdated one.
 *  - The replacement is only ever an id the live roster resolves; a roster with no current Opus passes
 *    the retired id through rather than parking the backbone backend.
 *  - The per-task strict owner pin is untouched, exactly as the Codex floor leaves it.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `claudeOpusTarget`, `modelFor`, `providerRoleModel`, `filterAutoSelectionCandidates`, the
 *    persisted override matrix, its safe Settings projection, and the real `Db` behind all of them.
 *  - STUBBED: only AccountManager's usage surface. No `claude` subprocess, no quota spent.
 *
 * Run:  npm run test:claude-opus-floor   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.ACCOUNT_1_TOKEN = "test-token-1";
process.env.ACCOUNT_1_ID = "acct1";
process.env.ACCOUNT_1_LABEL = "Sub One";
for (let i = 2; i <= 8; i++) process.env[`ACCOUNT_${i}_TOKEN`] = "";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ModelOverrides, Role } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { claudeOpusTarget, claudeOpusVersion, isRetiredClaudeOpus, CLAUDE_OPUS_FLOOR_MODEL } =
  await import("../orchestrator/claudeOpusFloor.js");
const { filterAutoSelectionCandidates } = await import("../orchestrator/modelSelector.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The live Claude catalog on the reporting installation, verbatim from kv `cache_claude_models`. */
const LIVE_ROSTER = [
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
];

const CLAUDE_ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa"];

/** The weekly meter the stubbed accounts report. Raised only by the usage-saving block below, whose
 *  policy cannot activate while the meters read 0 (`thresholdPct` is clamped to a minimum of 1). */
let stubSevenDay = 0;

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return 0; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  isModelLimited(_accountId: string, _model: string): boolean { return false; }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "acct1", label: "Sub One" },
      hasHeadroom: true,
      fiveHour: 0,
      fiveHourReset: null,
      sevenDay: 0,
      sevenDayReset: null,
      weeklySafetyPct: 100,
    };
  }
  auxToken(): string | undefined { return undefined; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  dto(): unknown[] {
    return [
      { id: "acct1", label: "Sub One", enabled: true, fiveHour: 0, sevenDay: stubSevenDay, sevenDayReset: null },
      { id: "acct2", label: "Sub Two", enabled: true, fiveHour: 0, sevenDay: stubSevenDay, sevenDayReset: null },
    ];
  }
}

interface Harness {
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  overrides(): ModelOverrides;
  dispose(): void;
}

function makeHarness(overrides: ModelOverrides, roster: readonly string[] = LIVE_ROSTER): Harness {
  const dir = mkdtempSync(join(tmpdir(), "opus-floor-"));
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  db.kvSet("setting_model_overrides", JSON.stringify(overrides));
  db.kvSet("cache_claude_models", JSON.stringify(roster));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    db,
    internals,
    overrides: () => JSON.parse(db.kvGet("setting_model_overrides") ?? "{}") as ModelOverrides,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- the version parser ----------------------------------------------------------------------------
console.log("\n=== claude opus floor — reading a version out of a model id ===\n");

check("a bare major is that major point zero", claudeOpusVersion("claude-opus-5") === 5);
check("a major-minor id reads both parts", claudeOpusVersion("claude-opus-5-5") === 5.5);
check(
  "a trailing 8-digit snapshot date is not read as the minor",
  claudeOpusVersion("claude-opus-4-5-20251101") === 4.5,
  String(claudeOpusVersion("claude-opus-4-5-20251101")),
);
check(
  "non-Opus Claude models carry no Opus version",
  claudeOpusVersion("claude-sonnet-5") === null && claudeOpusVersion("claude-fable-5-1") === null
    && claudeOpusVersion("claude-haiku-4-5-20251001") === null,
);
check("a non-Claude id carries none either", claudeOpusVersion("gpt-5.6-terra") === null && claudeOpusVersion("glm-5.3") === null);

console.log("\n=== claude opus floor — the policy ===\n");

check("the reported model is refused", isRetiredClaudeOpus("claude-opus-5"));
check(
  "so is every older Opus on the live roster",
  ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101"].every(isRetiredClaudeOpus),
);
check("the floor model itself is current", !isRetiredClaudeOpus(CLAUDE_OPUS_FLOOR_MODEL) && CLAUDE_OPUS_FLOOR_MODEL === "claude-opus-5-5");
check(
  "the floor is a MINIMUM, not a pin — a future Opus passes through",
  !isRetiredClaudeOpus("claude-opus-5-6") && !isRetiredClaudeOpus("claude-opus-6"),
);
check(
  "a cheaper Claude tier is a choice, not an outdated flagship",
  !isRetiredClaudeOpus("claude-sonnet-5") && !isRetiredClaudeOpus("claude-sonnet-4-6")
    && !isRetiredClaudeOpus("claude-fable-5") && !isRetiredClaudeOpus("claude-haiku-4-5-20251001"),
);
check("a Claude-family rule never touches another backend", !isRetiredClaudeOpus("gpt-5.5") && !isRetiredClaudeOpus("glm-5.2"));

{
  const target = claudeOpusTarget("claude-opus-5", LIVE_ROSTER);
  check("a retired pin is replaced by the current flagship", target.model === CLAUDE_OPUS_FLOOR_MODEL, String(target.model));
  check("the excluded id is reported for the owner-facing note", target.replaced === "claude-opus-5", String(target.replaced));
}
check(
  "an already-current model is returned untouched, with no substitution to announce",
  claudeOpusTarget("claude-opus-5-5", LIVE_ROSTER).model === "claude-opus-5-5"
    && claudeOpusTarget("claude-opus-5-5", LIVE_ROSTER).replaced === undefined,
);
check(
  "a Sonnet pin is not lifted to Opus",
  claudeOpusTarget("claude-sonnet-5", LIVE_ROSTER).model === "claude-sonnet-5"
    && claudeOpusTarget("claude-sonnet-5", LIVE_ROSTER).replaced === undefined,
);
check(
  "with the floor model absent it takes the newest Opus above the floor rather than inventing one",
  claudeOpusTarget("claude-opus-5", ["claude-opus-6", "claude-opus-5-7", "claude-opus-5"]).model === "claude-opus-6",
  claudeOpusTarget("claude-opus-5", ["claude-opus-6", "claude-opus-5-7", "claude-opus-5"]).model,
);
check(
  "the replacement is always an id the roster resolves — never a hand-written one",
  LIVE_ROSTER.includes(claudeOpusTarget("claude-opus-4-8", LIVE_ROSTER).model),
);
{
  const target = claudeOpusTarget("claude-opus-5", ["claude-opus-5", "claude-sonnet-5"]);
  check(
    "a roster with no current Opus passes the retired id through rather than parking the backbone backend",
    target.model === "claude-opus-5" && target.replaced === undefined,
    JSON.stringify(target),
  );
}

// ---- auto-selection --------------------------------------------------------------------------------
console.log("\n=== claude opus floor — the auto-selection roster ===\n");

{
  const candidates = [
    { provider: "claude" as const, model: "claude-opus-5-5" },
    { provider: "claude" as const, model: "claude-opus-5" },
    { provider: "claude" as const, model: "claude-sonnet-5" },
    { provider: "codex" as const, model: "gpt-5.6-terra" },
    { provider: "codex" as const, model: "gpt-5.5" },
  ];
  const kept = filterAutoSelectionCandidates(candidates).map((c) => `${c.provider}:${c.model}`);
  check("a retired Opus is dropped while a current one is dispatchable", !kept.includes("claude:claude-opus-5"), kept.join(","));
  check("the current Opus and the cheaper Claude tiers stay", kept.includes("claude:claude-opus-5-5") && kept.includes("claude:claude-sonnet-5"), kept.join(","));
  check("the existing Codex floor is unaffected by the new arm", kept.includes("codex:gpt-5.6-terra") && !kept.includes("codex:gpt-5.5"), kept.join(","));
}
{
  // Each backend's floor is gated on ITS own current option: a Claude roster offering only the retired
  // tier must stay selectable, or the filter removes the backend from the choice entirely.
  const kept = filterAutoSelectionCandidates([
    { provider: "claude" as const, model: "claude-opus-5" },
    { provider: "codex" as const, model: "gpt-5.6-terra" },
  ]).map((c) => `${c.provider}:${c.model}`);
  check("a current Codex model does not drop a retired Claude one", kept.includes("claude:claude-opus-5"), kept.join(","));
}

// ---- the wiring ------------------------------------------------------------------------------------
console.log("\n=== claude opus floor — the wiring (real ThreadManager, real Db) ===\n");

{
  // The reporting installation's exact persisted matrix: BOTH subs, EVERY role, on the retired Opus.
  const h = makeHarness({
    acct1: { director: "claude-opus-5", planner: "claude-opus-5", researcher: "claude-opus-5", implementor: "claude-opus-5", qa: "claude-opus-5" },
    acct2: { director: "claude-sonnet-4-6", planner: "claude-opus-5", researcher: "claude-opus-5", implementor: "claude-opus-5", qa: "claude-opus-5" },
    codex: { implementor: "gpt-5.6-terra", qa: "gpt-5.5" },
  });
  try {
    check(
      "every role on the reporting subscription resolves to the current Opus",
      CLAUDE_ROLES.every((role) => h.internals.modelFor("acct1", role) === CLAUDE_OPUS_FLOOR_MODEL),
      CLAUDE_ROLES.map((role) => `${role}=${h.internals.modelFor("acct1", role)}`).join(","),
    );
    check(
      "the implementor — the role the owner saw it on — is one of them",
      h.internals.modelFor("acct1", "implementor") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.modelFor("acct1", "implementor")),
    );
    check(
      "the second subscription is floored too, not just the first",
      h.internals.modelFor("acct2", "implementor") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.modelFor("acct2", "implementor")),
    );
    check(
      "a deliberate Sonnet pin beside them is left exactly as configured",
      h.internals.modelFor("acct2", "director") === "claude-sonnet-4-6",
      String(h.internals.modelFor("acct2", "director")),
    );
    check(
      "the provider-level resolver agrees with modelFor",
      h.internals.providerRoleModel("claude", "implementor", "acct1") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.providerRoleModel("claude", "implementor", "acct1")),
    );
    check(
      "the Codex review floor beside it still applies",
      h.internals.codexRoleModel("qa") !== "gpt-5.5" && h.internals.codexRoleModel("implementor") === "gpt-5.6-terra",
      `${h.internals.codexRoleModel("qa")}/${h.internals.codexRoleModel("implementor")}`,
    );
    check(
      "Settings projects the replacement, so the console stops advertising the retired model",
      h.internals.settings().modelOverrides.acct1?.implementor === CLAUDE_OPUS_FLOOR_MODEL
        && h.internals.settings().modelOverrides.acct2?.qa === CLAUDE_OPUS_FLOOR_MODEL,
      JSON.stringify(h.internals.settings().modelOverrides),
    );
    check(
      "the Settings projection leaves a current pin alone",
      h.internals.settings().modelOverrides.acct2?.director === "claude-sonnet-4-6",
      JSON.stringify(h.internals.settings().modelOverrides.acct2),
    );
    check(
      "the raw matrix is NOT rewritten — the floor is a resolution rule, not a migration",
      h.overrides().acct1?.implementor === "claude-opus-5",
      JSON.stringify(h.overrides().acct1),
    );
  } finally {
    h.dispose();
  }
}

{
  // No per-sub entry at all: the role falls through to the global "default" layer, which the composer's
  // quick model picker writes — so a retired id can arrive there too.
  const h = makeHarness({ default: { implementor: "claude-opus-4-8" } });
  try {
    check(
      "a retired id on the DEFAULT layer is floored too",
      h.internals.modelFor("acct1", "implementor") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.modelFor("acct1", "implementor")),
    );
    check(
      "a role with no override at all keeps the built-in config default",
      h.internals.modelFor("acct1", "qa") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.modelFor("acct1", "qa")),
    );
  } finally {
    h.dispose();
  }
}

{
  // A usage-saving policy resolves ABOVE the matrix and returns early from modelFor, so it needs its
  // own proof that the floor still sits under it.
  const h = makeHarness({ acct1: { implementor: "claude-sonnet-5" } });
  try {
    stubSevenDay = 95;
    h.db.kvSet("setting_usage_saving", JSON.stringify({ acct1: { enabled: true, thresholdPct: 90, model: "claude-opus-5", effort: "medium" } }));
    const saved = h.internals.usageSavingTarget("acct1");
    check(
      "a usage-saving target is reachable in this harness (else the assertion below proves nothing)",
      saved?.model === "claude-opus-5",
      JSON.stringify(saved),
    );
    check(
      "a retired Opus reached through usage saving is floored as well",
      h.internals.modelFor("acct1", "implementor") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.modelFor("acct1", "implementor")),
    );
  } finally {
    stubSevenDay = 0;
    h.dispose();
  }
}

{
  // The catalog is empty before the first successful refresh; the curated list is the cold-start roster
  // and it carries the floor model, so a cold boot must not dispatch the retired id.
  const h = makeHarness({ acct1: { implementor: "claude-opus-5" } }, []);
  try {
    check(
      "a cold start with no live catalog still floors from the curated list",
      h.internals.modelFor("acct1", "implementor") === CLAUDE_OPUS_FLOOR_MODEL,
      String(h.internals.modelFor("acct1", "implementor")),
    );
  } finally {
    h.dispose();
  }
}

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
