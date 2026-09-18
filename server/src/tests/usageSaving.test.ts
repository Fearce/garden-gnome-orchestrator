/** Focused contract tests for per-subscription usage saving. No network or live quota is required. */

import { usageSavingActive } from "../orchestrator/usageSaving.js";
import { clientCommandSchema } from "../ws/protocol.js";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { FileMemoryService } from "../memory/memory.js";
import { ThreadManager } from "../orchestrator/threadManager.js";
import type { AccountManager } from "../accounts/accountManager.js";
import type { UsageSavingPolicy } from "../types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean): void => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
};

const policy: UsageSavingPolicy = {
  enabled: true,
  thresholdPct: 90,
  model: "claude-sonnet-5",
  effort: "low",
};

console.log("\n=== usage-saving activation ===\n");
check("disabled is inactive above both thresholds", !usageSavingActive({ ...policy, enabled: false }, { fiveHour: 99, sevenDay: 99 }));
check("below both meters is inactive", !usageSavingActive(policy, { fiveHour: 89, sevenDay: 89 }));
check("the 5-hour meter activates at the exact threshold", usageSavingActive(policy, { fiveHour: 90, sevenDay: 10 }));
check("the weekly meter activates independently", usageSavingActive(policy, { fiveHour: 10, sevenDay: 91 }));
check("a provider with no 5-hour meter still activates on weekly", usageSavingActive(policy, { fiveHour: null, sevenDay: 95 }));
check("unknown meters do not activate", !usageSavingActive(policy, { fiveHour: null, sevenDay: undefined }));
check("a blank fallback model cannot activate", !usageSavingActive({ ...policy, model: "  " }, { fiveHour: 95, sevenDay: 95 }));

console.log("\n=== settings protocol ===\n");
const valid = {
  type: "settings.set",
  settings: { usageSaving: { "account-a": policy, codex: { ...policy, model: "gpt-5.6-luna", effort: "max" } } },
};
check("accepts complete per-subscription policies", clientCommandSchema.safeParse(valid).success);
check(
  "rejects an out-of-range threshold",
  !clientCommandSchema.safeParse({ type: "settings.set", settings: { usageSaving: { codex: { ...policy, thresholdPct: 101 } } } }).success,
);
check(
  "rejects a blank exact model",
  !clientCommandSchema.safeParse({ type: "settings.set", settings: { usageSaving: { codex: { ...policy, model: " " } } } }).success,
);

console.log("\n=== runtime settings and model resolution ===\n");
class UsageAccounts {
  fiveHour = 95;
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return this.fiveHour; }
  soonestResetAt(): number | null { return Date.now() + 3_600_000; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "account-a", label: "Claude A", token: "test-token" },
      hasHeadroom: true,
      fiveHour: this.fiveHour,
      sevenDay: 20,
      weeklySafetyPct: 100,
    };
  }
  dto(): Array<Record<string, unknown>> {
    return [{
      id: "account-a", label: "Claude A", enabled: true, active: false, rateLimited: false,
      fiveHour: this.fiveHour, sevenDay: 20, updatedAt: Date.now(), weeklySafetyPct: 100,
    }];
  }
  byId(): undefined { return undefined; }
}

const dir = mkdtempSync(join(tmpdir(), "usage-saving-"));
const db = new Db(join(dir, "orchestrator.sqlite"));
const accounts = new UsageAccounts();
const manager = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), accounts as unknown as AccountManager);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = manager as any;
try {
  const initial = manager.settings().usageSaving["account-a"];
  check("a new subscription defaults off at 90%", initial?.enabled === false && initial.thresholdPct === 90);
  manager.setSettings({
    usageSaving: {
      "account-a": { enabled: true, thresholdPct: 90, model: "claude-haiku-4-5-20251001", effort: "low" },
    },
  });
  check("5-hour usage selects the exact configured model for every role", manager.modelFor("account-a", "planner") === "claude-haiku-4-5-20251001" && manager.modelFor("account-a", "implementor") === "claude-haiku-4-5-20251001");
  check("the runtime target carries the exact configured effort", internals.usageSavingTarget("account-a")?.effort === "low");

  // A strict owner pin outranks usage saving. The pin's own feed message promises no fallback model, and
  // the reported failure was a repository where the economy model is not permitted to do the work at all.
  const unpinned = db.createThread({ title: "unpinned", workspace: dir, rawPrompt: "x" });
  const pinned = db.createThread({
    title: "pinned",
    workspace: dir,
    rawPrompt: "x",
    modelRequest: { requested: "claude-opus-5", provider: "claude", model: "claude-opus-5", strict: true },
  });
  const savingTarget = internals.implementorDispatchTarget(unpinned.id, "claude", "account-a");
  const pinnedTarget = internals.implementorDispatchTarget(pinned.id, "claude", "account-a");
  check("an unpinned task still dispatches the saving model", savingTarget.model === "claude-haiku-4-5-20251001");
  check("a strict pin dispatches the pinned model while saving is active", pinnedTarget.model === "claude-opus-5");
  // The policy is a model+effort PAIR resolved against ITS model, so half of it must not travel onto a
  // model the pair never described — every effort site reads `saving?.effort`.
  check("a strict pin carries no saving policy, so its effort is not downgraded either", pinnedTarget.saving === undefined);
  // Thrift is not lost, only made visible: the pinned model's own pool is what gets gated, so an
  // exhausted pool parks the task instead of quietly running something else.
  const demand = internals.capacityDemand(db.getThread(pinned.id), "implementor", undefined);
  const snapshot = internals.capacitySnapshotForThread(db.getThread(pinned.id), "implementor", demand);
  check(
    "capacity is gated on the pinned model's own pool while saving is active",
    snapshot.options.length > 0 && snapshot.options.every((option: { label: string }) => option.label.endsWith("· claude-opus-5")),
  );

  accounts.fiveHour = 89;
  check("dropping below both meters restores normal model routing", manager.modelFor("account-a", "implementor") !== "claude-haiku-4-5-20251001");
  check(
    "an unpinned task returns to normal routing too",
    internals.implementorDispatchTarget(unpinned.id, "claude", "account-a").model !== "claude-haiku-4-5-20251001",
  );
} finally {
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
