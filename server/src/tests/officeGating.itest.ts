/**
 * Integration test — office coordination is GATED on repo-peer presence.
 *
 * The contract: a task working ALONE in its repo hears nothing about the office (no kickoff note, no
 * general-office check-in — that's wasted tokens + noise). The moment a SECOND task joins the repo,
 * the office switches ON for BOTH: the newcomer's kickoff carries the office note, the previously-solo
 * incumbent is backfilled into the general office AND — if its implementor is live — gets a "teammate
 * joined" push straight into its session so it starts coordinating. Dedup is durable so a restart-driven
 * re-`ensureGroup` never re-announces or re-pings.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `officeNote` / `withOfficeNote` / `officeCheckIn` / `ensureGroup` / `repoPeers` /
 *    `liveAgentThreads` and the real `Db` + `EventHub` chat-room state behind them.
 *  - STUBBED: only the live agent handles — a tiny object recording `.send()` calls — placed into the
 *    real `activeRuns` / `this.live` maps, plus a real `agent_runs` row so `liveAgentThreads` resolves a
 *    role. No `claude` subprocess is spawned, so this is a FREE gate.
 *
 * Run:  npm run test:office-gating   (from server/)   — or:  npx tsx src/tests/officeGating.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Role } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { GENERAL_ROOM, repoRoom } = await import("../types.js");

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

const REPO_A = "C:/repos/alpha";
const REPO_B = "C:/repos/beta";

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "office-gate-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;

  const sentByThread = new Map<string, string[]>();

  /** Seed a live agent for a task: a real `agent_runs` row (so `liveAgentThreads` resolves its role) +
   *  a recording stub in `activeRuns`. For an implementor, also register it in `this.live` with an
   *  accountId, since only a live implementor gets the mid-run activation push. */
  function seedLive(threadId: string, role: Role, opts?: { implementor?: boolean; accountId?: string }): void {
    const accountId = opts?.accountId ?? "claude-max";
    const run = db.createRun({ threadId, role, model: "claude-x", account: accountId, effort: "high" });
    const sent: string[] = [];
    sentByThread.set(threadId, sent);
    const agent = { send: (text: string) => sent.push(text) };
    internals.track(threadId, agent);
    if (opts?.implementor) internals.live.set(threadId, { run: agent, runId: run.id, accountId });
  }

  return {
    mgr,
    db,
    internals,
    seedLive,
    sent: (threadId: string) => sentByThread.get(threadId) ?? [],
    thread: (title: string, workspace: string) => db.createThread({ title, workspace, rawPrompt: "do the thing" }),
    generalFor: (threadId: string) => db.listRoomMessages(GENERAL_ROOM, 100).filter((m) => m.threadId === threadId && m.kind === "chat"),
    projectSys: (workspace: string) => db.listRoomMessages(repoRoom(workspace), 100).filter((m) => m.kind === "system"),
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  console.log("\n=== office coordination gating — integration test (real office machinery) ===\n");

  // -- Test A: officeNote is empty when solo, present + peer-named once a teammate shares the repo -----
  console.log("Test A — officeNote: undefined when alone, names the peer once a teammate is live");
  {
    const h = makeHarness();
    try {
      const a = h.thread("A", REPO_A);
      h.seedLive(a.id, "implementor", { implementor: true });
      check("solo → officeNote returns undefined", h.internals.officeNote(a, "implementor", true) === undefined);
      check("solo → withOfficeNote leaves the kickoff untouched", h.internals.withOfficeNote(a, "implementor", "KICKOFF", true) === "KICKOFF");

      const b = h.thread("Build the exporter", REPO_A);
      h.seedLive(b.id, "planner");
      const noteForA = h.internals.officeNote(a, "implementor", true) as string | undefined;
      check("peer present → officeNote is a string", typeof noteForA === "string");
      check("peer present → officeNote names the peer's task", !!noteForA && noteForA.includes("Build the exporter"), noteForA);
      check("peer present → withOfficeNote appends the note", h.internals.withOfficeNote(a, "implementor", "KICKOFF", true).startsWith("KICKOFF\n\n⚠️ OFFICE"));

      // Read-only roles get the coordinate/share phrasing, not the editing "step on each other" framing.
      const noteForPlanner = h.internals.officeNote(a, "planner", true) as string;
      check("read-only role → uses the coordinate/share phrasing", noteForPlanner.includes("what you're examining"), noteForPlanner);
      check("read-only role → omits the editing 'step on each other' framing", !noteForPlanner.includes("step on each other"), noteForPlanner);
      const noteForImpl = h.internals.officeNote(a, "implementor", true) as string;
      check("editing role → keeps the 'step on each other' framing", noteForImpl.includes("step on each other"), noteForImpl);

      const c = h.thread("C", REPO_B);
      h.seedLive(c.id, "implementor", { implementor: true });
      check("different repo → still no note (peers are per-repo)", h.internals.officeNote(c, "implementor", true) === undefined);
    } finally {
      h.dispose();
    }
  }

  // -- Test B: general check-in is suppressed when solo, backfilled when the repo groups up -----------
  console.log("\nTest B — general-office check-in: silent when solo, backfilled on grouping");
  {
    const h = makeHarness();
    try {
      const a = h.thread("A", REPO_A);
      h.seedLive(a.id, "implementor", { implementor: true });
      h.internals.officeCheckIn(a.id, "implementor");
      check("solo → no general check-in posted", h.generalFor(a.id).length === 0);

      // A second task joins → ensureGroup switches the office on for both.
      const b = h.thread("Task B", REPO_A);
      h.seedLive(b.id, "implementor", { implementor: true });
      h.internals.officeCheckIn(b.id, "implementor"); // its own go-live check-in (peer now present)
      h.internals.ensureGroup(b.id);

      check("grouped → incumbent A's check-in was backfilled", h.generalFor(a.id).length === 1, `count=${h.generalFor(a.id).length}`);
      check("grouped → newcomer B checked in", h.generalFor(b.id).length === 1, `count=${h.generalFor(b.id).length}`);
      check("grouped → project room announced both members", h.projectSys(REPO_A).length === 2, `count=${h.projectSys(REPO_A).length}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test C: a live implementor incumbent is woken with a "teammate joined" push (once) -------------
  console.log("\nTest C — the previously-solo incumbent implementor gets a mid-run activation push");
  {
    const h = makeHarness();
    try {
      const a = h.thread("A", REPO_A);
      h.seedLive(a.id, "implementor", { implementor: true });
      h.internals.officeCheckIn(a.id, "implementor");
      check("before any peer → incumbent got no push", h.sent(a.id).length === 0);

      const b = h.thread("Ship the API", REPO_A);
      h.seedLive(b.id, "implementor", { implementor: true });
      h.internals.ensureGroup(b.id);

      check("joined → incumbent A got exactly one push", h.sent(a.id).length === 1, `count=${h.sent(a.id).length}`);
      check("push says a teammate joined", h.sent(a.id)[0]?.includes("teammate just joined") ?? false);
      check("push names the newcomer's task", h.sent(a.id)[0]?.includes("Ship the API") ?? false);
      check("push uses the MCP-tool phrasing (Claude incumbent)", h.sent(a.id)[0]?.includes("chat_post") ?? false);
      check("the newcomer B is NOT pushed to itself", h.sent(b.id).length === 0, `count=${h.sent(b.id).length}`);

      // Durable dedup: a restart-style re-ensureGroup must not re-announce or re-push.
      h.internals.ensureGroup(b.id);
      check("re-ensureGroup → no second push (durable dedup via chatThreadInRoom)", h.sent(a.id).length === 1, `count=${h.sent(a.id).length}`);
      check("re-ensureGroup → no duplicate project announcements", h.projectSys(REPO_A).length === 2, `count=${h.projectSys(REPO_A).length}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test D: a CLI incumbent (Codex/Grok) gets the OFFICE[team] text-bridge phrasing, not MCP -------
  console.log("\nTest D — a CLI-backend incumbent is woken via the OFFICE[team] text bridge");
  {
    const h = makeHarness();
    try {
      const a = h.thread("A", REPO_A);
      h.seedLive(a.id, "implementor", { implementor: true, accountId: "xai-grok" });
      const b = h.thread("Grok teammate", REPO_A);
      h.seedLive(b.id, "implementor", { implementor: true });
      h.internals.ensureGroup(b.id);
      check("CLI incumbent got a push", h.sent(a.id).length === 1, `count=${h.sent(a.id).length}`);
      check("CLI push uses the OFFICE[team] bridge phrasing", h.sent(a.id)[0]?.includes("OFFICE[team]") ?? false);
      check("CLI push does NOT tell it to call chat_post (no MCP)", !(h.sent(a.id)[0]?.includes("chat_post") ?? true));
    } finally {
      h.dispose();
    }
  }

  // -- Test E: a live PLANNER/QA incumbent is NOT pushed mid-run (never disrupt structured output) ----
  console.log("\nTest E — a one-shot read-only incumbent (planner) is not interrupted by a push");
  {
    const h = makeHarness();
    try {
      const a = h.thread("A", REPO_A);
      h.seedLive(a.id, "planner"); // NOT registered in this.live — a read-only phase
      const b = h.thread("New task", REPO_A);
      h.seedLive(b.id, "implementor", { implementor: true });
      h.internals.ensureGroup(b.id);
      check("planner incumbent got NO push (only live implementors are pinged)", h.sent(a.id).length === 0, `count=${h.sent(a.id).length}`);
      check("planner incumbent WAS still backfilled into the general office", h.generalFor(a.id).length === 1, `count=${h.generalFor(a.id).length}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test F: a 3rd task joining an already-grouped repo wakes BOTH earlier incumbents, once ---------
  console.log("\nTest F — a 3rd joiner notifies the already-grouped incumbents (each exactly once)");
  {
    const h = makeHarness();
    try {
      const a = h.thread("A", REPO_A);
      h.seedLive(a.id, "implementor", { implementor: true });
      const b = h.thread("B", REPO_A);
      h.seedLive(b.id, "implementor", { implementor: true });
      h.internals.ensureGroup(b.id); // A + B group; A woken about B
      check("first grouping → A pushed once (about B)", h.sent(a.id).length === 1, `count=${h.sent(a.id).length}`);
      check("first grouping → B (the joiner) not pushed", h.sent(b.id).length === 0, `count=${h.sent(b.id).length}`);

      const c = h.thread("Third task", REPO_A);
      h.seedLive(c.id, "implementor", { implementor: true });
      h.internals.ensureGroup(c.id); // C joins the {A,B} group

      check("3rd joiner → A woken again (about C)", h.sent(a.id).length === 2, `count=${h.sent(a.id).length}`);
      check("3rd joiner → B woken (about C)", h.sent(b.id).length === 1, `count=${h.sent(b.id).length}`);
      check("A's 2nd push names the 3rd task", h.sent(a.id)[1]?.includes("Third task") ?? false);
      check("3rd joiner → C (itself) not pushed", h.sent(c.id).length === 0, `count=${h.sent(c.id).length}`);

      // Re-running ensureGroup for the settled trio must wake nobody again.
      h.internals.ensureGroup(c.id);
      check("re-ensureGroup → no further pushes to A", h.sent(a.id).length === 2, `count=${h.sent(a.id).length}`);
      check("re-ensureGroup → no further pushes to B", h.sent(b.id).length === 1, `count=${h.sent(b.id).length}`);
    } finally {
      h.dispose();
    }
  }

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
