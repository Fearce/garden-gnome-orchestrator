/**
 * Integration test — a task a server restart interrupted resumes on the backend that owns its session.
 *
 * The owner's report: after a restart, a task that had been running on Codex (GPT Sol) was re-routed from
 * scratch, usage routing chose Claude, and the Codex session was thrown away for a fresh Claude one —
 * spending Claude credits while Codex had plenty of room. The provider choice lives in memory, so a
 * restart forgets it; the session's own run row is the durable record of who was doing the work.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `gateImplementorProvider` / `gateVanillaProvider` → `resolveImplementorProvider` → routing,
 *    `priorImplementorProvider` reading the real `Db` run rows, the persisted restart error, and the
 *    QA-only restart retry's provider pin in `runImplementorQa`.
 *  - STUBBED: the quota pictures (`claudeProviderCandidate` / `codexProviderCandidate`) and Codex
 *    readiness, so a scenario can make usage routing prefer Claude. No agent process starts.
 *
 * Run:  npm run test:restart-provider-affinity   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { RESTART_AUTO_RESUME_MSG } = await import("../orchestrator/restartResume.js");

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return 0; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  isModelLimited(): boolean { return false; }
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "acct1", label: "Sub One" }, hasHeadroom: true, fiveHour: 0, fiveHourReset: null, sevenDay: 0, sevenDayReset: null, weeklySafetyPct: 100 };
  }
  auxToken(): string | undefined { return undefined; }
  setPingInterval(): void {}
  applyEnabled(): void {}
  applyWeeklySafetyPct(): void {}
  setSpreadUsage(): void {}
  setProfileToken(): void {}
}

const dir = mkdtempSync(join(tmpdir(), "restart-affinity-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = mgr as any;

// Claude is fresh and resets soonest, so ordinary usage routing picks Claude; Codex is healthy too.
let codexReady = true;
const realSettings = internals.settings;
internals.settings = () => ({ ...realSettings.call(internals), codexEnabled: true, grokEnabled: false, zaiEnabled: false, spreadUsage: false });
internals.openaiApiKey = () => "sk-test";
internals.codexCapActive = () => false;
internals.codexImplementorReady = () => codexReady;
internals.claudeProviderCandidate = () => ({
  provider: "claude", hasHeadroom: true, fiveHour: 3, fiveHourReset: Date.now() + 4 * 3600_000,
  sevenDay: 17, sevenDayReset: Date.now() + 2 * 86_400_000, weeklySafetyPct: 100, capacityLabel: "Claude Sub One",
});
internals.codexProviderCandidate = () => ({
  provider: "codex", hasHeadroom: true, fiveHour: 10, fiveHourReset: null,
  sevenDay: 25, sevenDayReset: Date.now() + 7 * 86_400_000, weeklySafetyPct: 100, capacityLabel: "Codex general pool",
});

function task(title: string, lane?: Thread["lane"]): Thread {
  return db.createThread({ title, workspace, rawPrompt: "continue the work", brief: "continue the work", lane });
}

/** A finished implementor run that left a session on `account` — what the restart interrupted. */
function priorSession(threadId: string, account: string, sessionId: string): void {
  const run = db.createRun({ threadId, role: "implementor", model: "gpt-test", account });
  db.updateRun(run.id, { state: "interrupted", sessionId, endedAt: Date.now() });
}

function interruptedByRestart(threadId: string): void {
  db.updateThread(threadId, { state: "failed", error: RESTART_AUTO_RESUME_MSG });
}

try {
  console.log("\n=== restart provider affinity — integration test ===\n");

  console.log("Control — a fresh dispatch follows usage routing");
  {
    const t = task("fresh dispatch");
    check("usage routing prefers Claude in this quota picture", internals.gateImplementorProvider(t) === "claude");
  }

  console.log("\nA restart-interrupted Codex session resumes on Codex");
  {
    const t = task("restart-interrupted codex task");
    priorSession(t.id, "codex:openai-codex", "codex-thread-1");
    interruptedByRestart(t.id);
    const chosen = internals.gateImplementorProvider(db.getThread(t.id));
    check("the gate keeps Codex", chosen === "codex", String(chosen));
    check("the in-memory provider is Codex for startResumedImplementor", internals.implementorProvider.get(t.id) === "codex");
    const notes = db.listFindings(t.id).map((f) => f.summary);
    check("the feed says the restart kept the session's backend", notes.some((s) => s.startsWith("Resumed on Codex after the server restart")), notes.join(" | "));
    check("no misleading usage-routing note claims a fresh choice", !notes.some((s) => s.startsWith("Usage-aware routing chose")), notes.join(" | "));
  }

  console.log("\nA manual Resume after a non-restart failure still re-routes");
  {
    const t = task("ordinary failure");
    priorSession(t.id, "codex:openai-codex", "codex-thread-2");
    db.updateThread(t.id, { state: "failed", error: "something else went wrong" });
    check("usage routing decides", internals.gateImplementorProvider(db.getThread(t.id)) === "claude");
  }

  console.log("\nThe session's backend can no longer take the work → normal routing");
  {
    const t = task("codex gone");
    priorSession(t.id, "codex:openai-codex", "codex-thread-3");
    interruptedByRestart(t.id);
    codexReady = false;
    const chosen = internals.gateImplementorProvider(db.getThread(t.id));
    codexReady = true;
    check("routing falls back to Claude", chosen === "claude", String(chosen));
  }

  console.log("\nA restart-interrupted Claude session stays on Claude even when routing prefers Codex");
  {
    const realClaude = internals.claudeProviderCandidate;
    internals.claudeProviderCandidate = () => ({ ...realClaude(), fiveHour: 80, sevenDay: 90, sevenDayReset: Date.now() + 6 * 86_400_000 });
    const control = task("claude-heavy control");
    const routed = internals.gateImplementorProvider(control);
    const t = task("restart-interrupted claude task");
    priorSession(t.id, "acct1", "claude-session-1");
    interruptedByRestart(t.id);
    const chosen = internals.gateImplementorProvider(db.getThread(t.id));
    internals.claudeProviderCandidate = realClaude;
    check("routing alone would choose Codex here", routed === "codex", String(routed));
    check("the restart resume keeps Claude", chosen === "claude", String(chosen));
  }

  console.log("\nDefault mode keeps the session's backend too");
  {
    const t = task("vanilla codex", "vanilla");
    priorSession(t.id, "codex:openai-codex", "codex-thread-4");
    interruptedByRestart(t.id);
    const chosen = internals.gateVanillaProvider(db.getThread(t.id));
    check("the Default-mode gate keeps Codex", chosen === "codex", String(chosen));
  }

  console.log("\nRecovery intent survives state changes and admission parks");
  {
    const t = task("promoted reader", "read");
    priorSession(t.id, "codex:openai-codex", "promoted-codex-session");
    db.updateThreadStageOutputs(t.id, { readerDone: true });
    interruptedByRestart(t.id);
    const realResume = internals.resumeImplementorOnly;
    let chosen: string | undefined;
    let carriesRestartNotice = false;
    internals.resumeImplementorOnly = async () => {
      const current = db.getThread(t.id)!;
      chosen = internals.gateImplementorProvider(current);
      carriesRestartNotice = internals.restartResumePending(current);
    };
    await mgr.resumeThread(t.id);
    internals.resumeImplementorOnly = realResume;
    check("promoted read resume keeps Codex after its early state transition", chosen === "codex", String(chosen));
    check("promoted read resume retains the restart notice", carriesRestartNotice);
    internals.resuming.delete(t.id);
  }
  {
    const t = task("token safety park");
    priorSession(t.id, "codex:openai-codex", "token-park-session");
    interruptedByRestart(t.id);
    internals.parkRestartResumeForTokenSafety(db.getThread(t.id));
    check("token park durably retains recovery intent", db.getThreadStageOutputs(t.id).restartResumePending === true);
    // The freeze wake converts its admission marker; it must not depend on the old error text.
    db.updateThread(t.id, { state: "review", error: "waiting for capacity" });
    check("token park wake keeps Codex", internals.gateImplementorProvider(db.getThread(t.id)) === "codex");
    check("token park wake still carries the restart notice", internals.restartResumePending(db.getThread(t.id)));
  }
  {
    const t = task("capacity park");
    priorSession(t.id, "codex:openai-codex", "cap-park-session");
    interruptedByRestart(t.id);
    internals.capParked.set(t.id, "implementor");
    internals.settleReview(t.id, "waiting");
    check("capacity park replaces the restart error", !db.getThread(t.id)?.error?.startsWith("interrupted by a server restart"));
    check("capacity park wake keeps Codex", internals.gateImplementorProvider(db.getThread(t.id)) === "codex");
    internals.setState(t.id, "cancelled");
    check("terminal state clears pending recovery", db.getThreadStageOutputs(t.id).restartResumePending === false);
  }

  console.log("\nA QA-only restart retry pins the implementor's backend for its fix rounds");
  {
    const t = task("qa retry");
    priorSession(t.id, "codex:openai-codex", "codex-thread-5");
    db.updateThread(t.id, { state: "failed", error: RESTART_AUTO_RESUME_MSG });
    db.updateThreadStageOutputs(t.id, { qaRoundsUsed: 1, qaInterruptedRetryRound: 1 });
    let providerDuringLoop: string | undefined;
    const realLoop = internals.runImplementorQaLoop;
    const realStopLive = internals.stopLive;
    internals.runImplementorQaLoop = async () => { providerDuringLoop = internals.implementorProvider.get(t.id); };
    internals.stopLive = async () => {};
    await internals.runImplementorQa(db.getThread(t.id), "KICKOFF", undefined, "codex-thread-5", undefined, { qaEnabled: true, maxQaRounds: 3 });
    internals.runImplementorQaLoop = realLoop;
    internals.stopLive = realStopLive;
    check("the fix round would resume on Codex, not default to Claude", providerDuringLoop === "codex", String(providerDuringLoop));
  }
} finally {
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
