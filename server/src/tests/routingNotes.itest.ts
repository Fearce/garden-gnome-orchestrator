/**
 * Integration test — the implementor routing gate only ANNOUNCES a route when it actually chose one.
 *
 * The owner's report: a deployment with one Claude subscription and no other backend enabled still got
 * a "Usage-aware routing chose Claude" finding on every dispatch, resume and inject — announcing a
 * decision that was fixed before the gate ran. This pins the boundary in both directions: silent when
 * there was no alternative, still loud when there was.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `gateImplementorProvider` → `resolveImplementorProvider` → `noteCapacityRoute` →
 *    `postRoutingNote`, the real capacity assessment, the real `Db` findings the dedupe reads back, and
 *    the real `config.accounts` + persisted `account_enabled_*` toggles behind `routingHadAlternatives`.
 *  - STUBBED: only AccountManager's usage surface (`dispatchPreview`/`hasHeadroom`), so a scenario can
 *    set an exact quota picture. No `claude` subprocess and no quota is spent.
 *
 * Run:  npm run test:routing-notes   (from server/)   — or:  npx tsx src/tests/routingNotes.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
// `config.accounts` is read from env at import time, and dotenv never overwrites a key that already
// exists — so pinning all eight slots here makes the account roster deterministic whatever `.env` holds.
process.env.ACCOUNT_1_TOKEN = "test-token-1";
process.env.ACCOUNT_1_ID = "acct1";
process.env.ACCOUNT_1_LABEL = "Sub One";
process.env.ACCOUNT_2_TOKEN = "test-token-2";
process.env.ACCOUNT_2_ID = "acct2";
process.env.ACCOUNT_2_LABEL = "Sub Two";
for (let i = 3; i <= 8; i++) process.env[`ACCOUNT_${i}_TOKEN`] = "";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { CapacityDemand } from "../orchestrator/capacityRouting.js";
import type { Finding, Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { config } = await import("../config.js");

// ---- tiny assertion harness ------------------------------------------------------------------------
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

/** One quota picture for the single Claude candidate the gate resolves. */
interface Usage {
  fiveHour: number;
  sevenDay: number;
}

class StubAccounts {
  usage: Usage = { fiveHour: 0, sevenDay: 0 };
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return this.usage.fiveHour;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  isModelLimited(_accountId: string, _model: string): boolean {
    return false;
  }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "acct1", label: "Sub One" },
      hasHeadroom: true,
      fiveHour: this.usage.fiveHour,
      fiveHourReset: null,
      sevenDay: this.usage.sevenDay,
      sevenDayReset: null,
      weeklySafetyPct: 100,
    };
  }
  auxToken(): string | undefined {
    return undefined;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  accounts: StubAccounts;
  thread(title: string): Thread;
  /** Run the real routing gate exactly as a dispatch / manual resume / inject does. */
  gate(thread: Thread): string | null;
  notes(threadId: string): Finding[];
  dispose(): void;
}

/** `enabledSubs: 1` disables the second subscription through the same persisted kv key the settings
 *  panel writes, which is what a one-subscription deployment looks like on disk. */
function makeHarness(enabledSubs: 1 | 2): Harness {
  const dir = mkdtempSync(join(tmpdir(), "routing-notes-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const accounts = new StubAccounts();
  const mgr = new ThreadManager(db, hub, memory, accounts as unknown as AccountManager);
  db.kvSet("account_enabled_acct1", "1");
  db.kvSet("account_enabled_acct2", enabledSubs === 2 ? "1" : "0");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    mgr,
    db,
    internals,
    accounts,
    thread(title) {
      return db.createThread({ title, workspace, rawPrompt: "do the thing", brief: "do the thing" });
    },
    gate(thread) {
      return internals.gateImplementorProvider(thread) ?? null;
    },
    notes(threadId) {
      return db.listFindings(threadId).filter((f) => /^(Usage-aware routing |Low quota runway on )/.test(f.summary));
    },
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  console.log("\n=== routing notes — integration test (real routing gate, stubbed usage) ===\n");

  check(
    "the harness pinned exactly two configured subscriptions",
    config.accounts.length === 2,
    config.accounts.map((a) => a.id).join(","),
  );

  // -- Test A: one sub, one backend, healthy quota → nothing to announce -----------------------------
  console.log("\nTest A — one subscription and no other backend: the gate posts no routing note");
  {
    const h = makeHarness(1);
    try {
      const t = h.thread("Fix the typo in the readme");
      check("the gate still routes to Claude", h.gate(t) === "claude", String(h.gate(t)));
      check("no routing note was posted", h.notes(t.id).length === 0, h.notes(t.id).map((f) => f.summary).join(" | "));

      // A resume / inject re-runs the same gate. It must stay silent too — that is the owner's report.
      h.gate(t);
      h.gate(t);
      check("re-running the gate (resume/inject) still posts nothing", h.notes(t.id).length === 0, h.notes(t.id).map((f) => f.summary).join(" | "));
    } finally {
      h.dispose();
    }
  }

  // -- Test B: one sub whose only pool is short → a capacity warning, not a routing claim -------------
  console.log("\nTest B — one subscription that is nearly spent: a quota warning, posted once");
  {
    const h = makeHarness(1);
    try {
      h.accounts.usage = { fiveHour: 95, sevenDay: 20 };
      const t = h.thread("Rework the settings panel");
      h.gate(t);
      const notes = h.notes(t.id);
      check("exactly one note was posted", notes.length === 1, notes.map((f) => f.summary).join(" | "));
      check(
        "it is a quota warning, not a routing decision",
        notes[0]?.summary.startsWith("Low quota runway on ") === true,
        notes[0]?.summary,
      );
      check("it is a warning", notes[0]?.severity === "warning", String(notes[0]?.severity));
      check(
        "it says there was nowhere else to route",
        notes[0]?.detail?.includes("nothing to route to") === true,
        notes[0]?.detail ?? "",
      );

      h.gate(t);
      h.gate(t);
      check("a resume/inject does not repeat the same warning", h.notes(t.id).length === 1, String(h.notes(t.id).length));
    } finally {
      h.dispose();
    }
  }

  // -- Test C: a second SUBSCRIPTION is a real choice → the routing note stays -------------------------
  console.log("\nTest C — two enabled subscriptions: the routing note is still posted");
  {
    const h = makeHarness(2);
    try {
      const t = h.thread("Rework the settings panel");
      h.gate(t);
      const notes = h.notes(t.id);
      check("the routing note was posted", notes.length === 1, notes.map((f) => f.summary).join(" | "));
      check(
        "it names the chosen backend",
        notes[0]?.summary.startsWith("Usage-aware routing chose Claude") === true,
        notes[0]?.summary,
      );
    } finally {
      h.dispose();
    }
  }

  // -- Test D: a second BACKEND is a real choice, and only a CHANGED verdict re-announces --------------
  console.log("\nTest D — two backend candidates: posted once, repeated never, re-posted on a change");
  {
    const h = makeHarness(1);
    try {
      const t = h.thread("Rework the settings panel");
      const demand: CapacityDemand = h.internals.capacityDemand(t, "implementor");
      const claude = h.internals.claudeProviderCandidate(demand);
      const codex = {
        provider: "codex",
        hasHeadroom: true,
        fiveHour: 10,
        fiveHourReset: null,
        sevenDay: 10,
        sevenDayReset: null,
        weeklySafetyPct: 100,
        capacityLabel: "Codex",
      };
      const candidates = [claude, codex];

      h.internals.noteCapacityRoute(t, demand, "claude", candidates);
      check("a two-backend route is announced", h.notes(t.id).length === 1, h.notes(t.id).map((f) => f.summary).join(" | "));

      h.internals.noteCapacityRoute(t, demand, "claude", candidates);
      check("an unchanged verdict is not re-announced", h.notes(t.id).length === 1, String(h.notes(t.id).length));

      h.internals.noteCapacityRoute(t, demand, "codex", candidates);
      const notes = h.notes(t.id);
      check("a changed verdict IS announced", notes.length === 2, String(notes.length));
      check(
        "the new note names the new backend",
        notes[1]?.summary.startsWith("Usage-aware routing chose Codex") === true,
        notes[1]?.summary,
      );

      // Back to the first backend after a real flip is a change too, not a repeat of the older note.
      h.internals.noteCapacityRoute(t, demand, "claude", candidates);
      check("a flip back is announced again", h.notes(t.id).length === 3, String(h.notes(t.id).length));
    } finally {
      h.dispose();
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

await main();
process.exit(0);
