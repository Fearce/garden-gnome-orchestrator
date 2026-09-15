/**
 * Integration test: posting a deliverable for a file already surfaced on the task updates the
 * existing card instead of stacking a duplicate.
 *
 * This is the emission-side half of the 2026-09-15 "owner still cannot see deliverables" regression:
 * a restore script and a live re-post (a recovery agent, an owner-triggered resume, a retried CLI
 * bridge line) both converging on the same recovered file produced TWO cards for ONE artifact, because
 * `ThreadManager.postFinding` never deduplicated deliverables by the file they actually point at
 * (only by finding id, which every fresh post gets a new one of). Same identity rule as
 * `restore-archived-deliverables.cjs`, now enforced on the live path too so it can't recur.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `postFinding` / `findDuplicateDeliverable` / `resolveDeliverablePath` and the real `Db` +
 *    `EventHub` behind them, against real files on disk (the containment check needs `realpathSync`).
 *  - STUBBED: only the AccountManager (no agent is ever spawned; `postFinding` is a plain method).
 *
 * Run (from server/): npm run test:deliverable-dedup, or npx tsx src/tests/deliverableDedup.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  \u2705 ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` - ${detail}` : ""));
    console.log(`  \u274c ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "deliverable-dedup-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    mgr,
    db,
    workspace,
    thread: () => db.createThread({ title: "Skill tree layout redesign prototype", workspace, rawPrompt: "build the prototype" }),
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  console.log("\n=== deliverable dedup on postFinding, integration test (real ThreadManager, real Db) ===\n");

  // -- Test A: re-posting the same real file (different path spelling + label) updates in place --------
  console.log("Test A - a second post for the same real file updates the existing card, no duplicate");
  {
    const h = makeHarness();
    try {
      const t = h.thread();
      const shotBackslash = join(h.workspace, "docs", "tree-prototype", "01-overview.png");
      mkdirSync(join(h.workspace, "docs", "tree-prototype"), { recursive: true });
      writeFileSync(shotBackslash, Buffer.from([137, 80, 78, 71]));
      const shotForwardSlash = shotBackslash.split("\\").join("/");

      const first = h.mgr.postFinding({
        threadId: t.id,
        fromRole: "implementor",
        kind: "deliverable",
        summary: "HQ tree overview",
        label: "HQ tree overview",
        path: shotForwardSlash,
      });
      const second = h.mgr.postFinding({
        threadId: t.id,
        fromRole: "implementor",
        kind: "deliverable",
        summary: "HQ tree overview (recaptured)",
        label: "HQ tree overview (recaptured)",
        path: shotBackslash,
      });

      check("second post returns the SAME finding id", second.id === first.id, `${first.id} vs ${second.id}`);
      check("second post's label wins on the shared card", second.label === "HQ tree overview (recaptured)", second.label ?? "");
      const all = h.db.listFindings(t.id).filter((f) => f.kind === "deliverable");
      check("exactly one deliverable card exists for the one real file", all.length === 1, `found ${all.length}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test B: a genuinely different file adds a second card, never collapsed with the first ------------
  console.log("\nTest B - a second, different file is a new card, not deduplicated away");
  {
    const h = makeHarness();
    try {
      const t = h.thread();
      mkdirSync(join(h.workspace, "docs", "tree-prototype"), { recursive: true });
      const shotA = join(h.workspace, "docs", "tree-prototype", "01-overview.png");
      const shotB = join(h.workspace, "docs", "tree-prototype", "02-overview-fogged.png");
      writeFileSync(shotA, Buffer.from([137, 80, 78, 71]));
      writeFileSync(shotB, Buffer.from([137, 80, 78, 71]));

      h.mgr.postFinding({ threadId: t.id, fromRole: "implementor", kind: "deliverable", summary: "Overview", label: "Overview", path: shotA });
      h.mgr.postFinding({ threadId: t.id, fromRole: "implementor", kind: "deliverable", summary: "Fogged", label: "Fogged", path: shotB });

      const all = h.db.listFindings(t.id).filter((f) => f.kind === "deliverable");
      check("two distinct files produce two distinct cards", all.length === 2, `found ${all.length}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test C: an unresolvable path (the file was never written) is recorded as-is, not blocked ---------
  console.log("\nTest C - a path that does not resolve is still recorded (nothing to dedup against)");
  {
    const h = makeHarness();
    try {
      const t = h.thread();
      const missing = join(h.workspace, "docs", "never-written.png");
      const finding = h.mgr.postFinding({ threadId: t.id, fromRole: "implementor", kind: "deliverable", summary: "Ghost", label: "Ghost", path: missing });
      check("an unresolvable deliverable path is still posted", finding.path === missing);
      const finding2 = h.mgr.postFinding({ threadId: t.id, fromRole: "implementor", kind: "deliverable", summary: "Ghost again", label: "Ghost again", path: missing });
      check(
        "two posts of the same never-written path are NOT collapsed (nothing on disk to prove identity)",
        finding2.id !== finding.id,
      );
    } finally {
      h.dispose();
    }
  }

  // -- Test D: ordinary (non-deliverable) findings are completely untouched ------------------------------
  console.log("\nTest D - plain findings (kind 'finding') never go through dedup");
  {
    const h = makeHarness();
    try {
      const t = h.thread();
      h.mgr.postFinding({ threadId: t.id, fromRole: "implementor", summary: "Same summary twice" });
      h.mgr.postFinding({ threadId: t.id, fromRole: "implementor", summary: "Same summary twice" });
      const all = h.db.listFindings(t.id).filter((f) => f.kind === "finding");
      check("repeated plain findings are never merged", all.length === 2, `found ${all.length}`);
    } finally {
      h.dispose();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

await main();
