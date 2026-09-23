/**
 * Integration test — the REVIEW-stage Codex model floor.
 *
 * The owner reported gpt-5.5 twice. It was never an auto-selection defect: `filterAutoSelectionCandidates`
 * already refuses legacy Codex ids, but it governs only the IMPLEMENTOR pick. The QA stage reads its model
 * straight out of the persisted per-role override matrix, so a stored `codex.qa = "gpt-5.5"` was enforced
 * verbatim on 270 QA runs while the implementor entry beside it had long since moved to gpt-5.6-terra.
 *
 * So the assertions that matter are about RESOLUTION, not about a scoring function:
 *  - A stored legacy QA/reviewer pin resolves to a dispatchable GPT-5.6 tier, at low effort.
 *  - The implementor and the one-shot roles beside it are NOT touched — that scope was the owner's
 *    correction after the first attempt over-applied the ban.
 *  - The Settings matrix projects the safe target, so the console stops advertising a model that cannot run.
 *  - The replacement is only ever an id this installation's live catalog resolves. A hand-written
 *    "gpt-5.6" is exactly what failed two dispatches before this task.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `codexReviewTarget`, `codexRoleModel`/`codexRoleTarget`, `providerRoleModel`, the persisted
 *    override matrix, its safe Settings projection, `setSettings`, and the real `Db` behind all of them.
 *  - STUBBED: only AccountManager's usage surface. No `claude`/`codex` subprocess, no quota spent.
 *
 * Run:  npm run test:review-model-floor   (from server/)
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
const { codexReviewTarget, isReviewFloorRole, reviewModelAllowed, REVIEW_SUBSTITUTE_EFFORT } =
  await import("../orchestrator/reviewModelFloor.js");
const { demandForRole } = await import("../orchestrator/capacityRouting.js");

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

/** The live Codex CLI catalog on the reporting installation, verbatim from kv `cache_codex_cli_models`. */
const LIVE_ROSTER = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-5.6-terra",
  "gpt-6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-5.5",
  "gpt-5.3-codex-spark",
];

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
  dto(): unknown[] { return [{ id: "acct1", label: "Sub One", sevenDay: 0, sevenDayReset: null }]; }
}

interface Harness {
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  overrides(): ModelOverrides;
  dispose(): void;
}

/**
 * `overrides` is seeded before the manager is constructed. `roster` is written to BOTH catalog keys so
 * the gate is independent of whether the
 * machine running it happens to hold a ChatGPT-plan Codex login (`codexRosterModels` picks by that).
 */
function makeHarness(overrides: ModelOverrides, roster: readonly string[] = LIVE_ROSTER): Harness {
  const dir = mkdtempSync(join(tmpdir(), "review-floor-"));
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  db.kvSet("setting_model_overrides", JSON.stringify(overrides));
  db.kvSet("cache_codex_models", JSON.stringify(roster));
  db.kvSet(
    "cache_codex_cli_models",
    JSON.stringify(roster.map((id) => ({ id, efforts: ["low", "medium", "high", "xhigh"] }))),
  );
  db.kvSet("setting_codex_effort", "ultra");
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

// ---- the pure policy -------------------------------------------------------------------------------
console.log("\n=== review model floor — the policy ===\n");

check("QA and the auto-reviewer are the governed stages", isReviewFloorRole("qa") && isReviewFloorRole("reviewer"));
check(
  "the implementor and the one-shot roles are NOT governed (the owner's scope correction)",
  !isReviewFloorRole("implementor") && !isReviewFloorRole("planner") && !isReviewFloorRole("researcher")
    && !isReviewFloorRole("reader") && !isReviewFloorRole("director"),
);

check("gpt-5.5 is refused for a review stage", !reviewModelAllowed("gpt-5.5"));
check(
  "so are the other retired Codex tiers",
  !reviewModelAllowed("gpt-5.4-mini") && !reviewModelAllowed("gpt-4.1") && !reviewModelAllowed("o3")
    && !reviewModelAllowed("gpt-5.3-codex-spark"),
);
check(
  "current tiers are allowed",
  reviewModelAllowed("gpt-6-luna") && reviewModelAllowed("gpt-6-sol") && reviewModelAllowed("gpt-6-astra"),
);
check("a non-Codex model is never touched by a Codex-family rule", !reviewModelAllowed("claude-opus-5-5") && !reviewModelAllowed("glm-5.3"));

{
  const target = codexReviewTarget("qa", "gpt-5.5", LIVE_ROSTER);
  check("a retired QA pin is replaced by the budget GPT-5.6 tier", target.model === "gpt-6-luna", String(target.model));
  check(
    "the substitution carries the cheap effort",
    target.effort === REVIEW_SUBSTITUTE_EFFORT && target.effort === "low",
    String(target.effort),
  );
  check("the excluded id is reported for the owner-facing note", target.replaced === "gpt-5.5", String(target.replaced));
  check("a substitution is never treated as blocked", target.blocked !== true);
}
check("the auto-reviewer gets the same floor", codexReviewTarget("reviewer", "gpt-4.1", LIVE_ROSTER).model === "gpt-6-luna");
check(
  "the implementor's own configured model is returned untouched",
  codexReviewTarget("implementor", "gpt-5.5", LIVE_ROSTER).model === "gpt-5.5"
    && codexReviewTarget("implementor", "gpt-5.5", LIVE_ROSTER).effort === undefined,
);
check(
  "planner/researcher/reader keep their configured model",
  (["planner", "researcher", "reader"] as Role[]).every((role) => codexReviewTarget(role, "gpt-5.5", LIVE_ROSTER).model === "gpt-5.5"),
);
check(
  "a review stage already on a current model keeps its configured effort (no substitution)",
  codexReviewTarget("qa", "gpt-6-sol", LIVE_ROSTER).model === "gpt-6-sol"
    && codexReviewTarget("qa", "gpt-6-sol", LIVE_ROSTER).effort === undefined,
);
check(
  "the replacement falls to the next GPT-5.6 tier when the budget tier is absent",
  codexReviewTarget("qa", "gpt-5.5", ["gpt-6-astra", "gpt-6-sol", "gpt-5.5"]).model === "gpt-6-sol",
);
check(
  "with no GPT-5.6 family at all it takes another CURRENT id rather than inventing one",
  codexReviewTarget("qa", "gpt-5.5", ["gpt-6-astra", "gpt-5.5"]).model === "gpt-6-astra",
);
{
  const target = codexReviewTarget("qa", "gpt-5.5", ["gpt-5.5", "gpt-5.4", "o3"]);
  check(
    "a legacy-only catalog blocks the backend rather than running the retired model",
    target.blocked === true && target.model === "gpt-5.5",
  );
}
check(
  "the replacement is always an id the roster actually resolves — never a bare gpt-5.6",
  LIVE_ROSTER.includes(codexReviewTarget("qa", "gpt-5.5", LIVE_ROSTER).model),
);

// ---- the wiring ------------------------------------------------------------------------------------
console.log("\n=== review model floor — the wiring (real ThreadManager, real Db) ===\n");

{
  // The reporting installation's exact persisted matrix.
  const h = makeHarness({
    codex: { director: "gpt-5.5", planner: "gpt-5.5", researcher: "gpt-5.5", implementor: "gpt-5.6-terra", qa: "gpt-5.5" },
  });
  try {
    check(
      "QA resolves to the replacement, not the stored pin",
      h.internals.codexRoleModel("qa") === "gpt-6-luna",
      String(h.internals.codexRoleModel("qa")),
    );
    check(
      "generation migration preserves the configured effort policy",
      h.internals.codexRoleTarget("qa").effort === undefined,
      String(h.internals.codexRoleTarget("qa").effort),
    );
    check(
      "the auto-reviewer resolves to a current model too",
      reviewModelAllowed(h.internals.codexRoleModel("reviewer")),
      String(h.internals.codexRoleModel("reviewer")),
    );
    check(
      "the implementor's stored model is untouched",
      h.internals.codexRoleModel("implementor") === "gpt-6-sol",
      String(h.internals.codexRoleModel("implementor")),
    );
    check(
      "planner/researcher/director keep their stored model — this fix is QA-scoped",
      (["planner", "researcher", "director"] as Role[]).every((role) => h.internals.providerRoleModel("codex", role) === "gpt-6-luna"),
    );
    check(
      "Settings projects the replacement, so it stops advertising the retired QA model",
      h.internals.settings().modelOverrides.codex?.qa === "gpt-6-luna",
      JSON.stringify(h.internals.settings().modelOverrides.codex),
    );
    check(
      "the raw matrix keeps the legacy QA pin so the replacement remains low effort",
      h.overrides().codex?.qa === "gpt-5.5" && h.overrides().codex?.planner === "gpt-5.5"
        && h.overrides().codex?.implementor === "gpt-5.6-terra",
      JSON.stringify(h.overrides().codex),
    );

    h.internals.setModelOverride("codex", "planner", "gpt-5.6-sol");
    h.internals.setModelOverride("codex", "researcher", "gpt-5.6-luna");
    check("saved Sol/Luna pins upgrade in non-review roles too", h.internals.providerRoleModel("codex", "planner") === "gpt-6-sol" && h.internals.providerRoleModel("codex", "researcher") === "gpt-6-luna");
    // A legacy role pin remains raw so the floor can preserve the low-effort substitution, but its
    // Settings response and dispatch target can never expose it as a usable QA choice.
    h.internals.setModelOverride("codex", "qa", "gpt-5.5");
    check(
      "a QA override is projected to the replacement instead of advertised as retired",
      h.overrides().codex?.qa === "gpt-5.5" && h.internals.settings().modelOverrides.codex?.qa === "gpt-6-luna",
      JSON.stringify(h.internals.settings().modelOverrides.codex),
    );
    h.internals.setSettings({ modelOverrides: { codex: { qa: "gpt-5.5" } } });
    check(
      "the Settings matrix patch cannot make a retired QA model selectable",
      h.overrides().codex?.qa === "gpt-5.5" && h.internals.settings().modelOverrides.codex?.qa === "gpt-6-luna",
      JSON.stringify(h.internals.settings().modelOverrides.codex),
    );
    h.internals.setModelOverride("codex", "implementor", "gpt-5.5");
    check(
      "the same write for the IMPLEMENTOR is stored verbatim",
      h.overrides().codex?.implementor === "gpt-5.5",
      JSON.stringify(h.overrides().codex),
    );
    h.internals.setModelOverride("codex", "qa", "");
    check("clearing a review override still clears it", h.overrides().codex?.qa === undefined, JSON.stringify(h.overrides().codex));
  } finally {
    h.dispose();
  }
}

{
  // No QA override at all: QA inherits the Codex implementor model, which must still clear the floor.
  const h = makeHarness({ codex: { implementor: "gpt-5.5" } });
  try {
    check(
      "an inherited retired model is floored too, not just an explicit QA pin",
      h.internals.codexRoleModel("qa") === "gpt-6-luna",
      String(h.internals.codexRoleModel("qa")),
    );
    check(
      "inheriting does not rewrite the implementor's own entry",
      h.overrides().codex?.implementor === "gpt-5.5",
      JSON.stringify(h.overrides().codex),
    );
  } finally {
    h.dispose();
  }
}

{
  const h = makeHarness({ codex: { qa: "gpt-5.5" } }, ["gpt-5.5", "gpt-5.4", "o3"]);
  try {
    h.db.kvSet("setting_codex_enabled", "1");
    h.db.kvSet("openai_api_key", "sk-test-review-floor");
    check(
      "a legacy-only catalog leaves the stored pin alone rather than guessing",
      h.overrides().codex?.qa === "gpt-5.5",
      JSON.stringify(h.overrides().codex),
    );
    check("and the floor reports it blocked, so Codex is refused for QA", h.internals.codexRoleTarget("qa").blocked === true);
    check(
      "the preferred-provider resume gate refuses Codex too, so a warm QA session cannot bypass the floor",
      h.internals.providerSafeForRole("codex", "qa", demandForRole("qa")) === false,
    );
    check(
      "capacity inventory does not advertise blocked Codex review models as ready",
      !h.internals.roleCapacitySnapshot("qa", demandForRole("qa")).ready.some((candidate: { provider: string }) => candidate.provider === "codex"),
      JSON.stringify(h.internals.roleCapacitySnapshot("qa", demandForRole("qa")).ready),
    );
  } finally {
    h.dispose();
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
