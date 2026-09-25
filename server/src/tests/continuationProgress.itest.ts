/**
 * Integration test — an implementor that keeps doing new work is continued for as long as it takes, and
 * only a wedged one is parked.
 *
 * The bug (task 3ab7019e, 2026-09-24): six productive 100-turn sessions, a commit and two findings, then
 * `Implementor ended without completing — Stopped at the per-session turn ceiling` because the auto-continue
 * loop stopped at a fixed count of 8 whatever those sessions did. Three of the eight were spent on empty
 * resumes. The owner's rule: a task runs until the work is done.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `awaitImplementorCompletion`'s loop, the progress read (`Db.roleActivitySince`), the streak, the
 *    park text, and the capacity-rollover classifier the park text must not trip.
 *  - SIMULATED: only the agent spawn — `startResumedImplementor` is intercepted and each session's activity
 *    is written the way `wireRun` would persist it.
 *
 * Run:  npm run test:continuation-progress   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
delete process.env.MAX_AUTO_RESUMES; // the default this gate is about: no fixed count
delete process.env.IMPLEMENTOR_NO_PROGRESS_LIMIT;

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunLike, ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { config } = await import("../config.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { ActionHistory, assessSessionProgress, MIN_NOVEL_ACTIONS } = await import("../orchestrator/continuationProgress.js");
const { isCapacityStallPark } = await import("../orchestrator/capacityStall.js");
const { workspaceGitFingerprint } = await import("../orchestrator/gitProgress.js");

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
  setProfileToken(_id: string, _token: string): void {}
}

const CEILING: ResultEvent = { type: "result", subtype: "error_max_turns", isError: true, errors: ["Stopped at the per-session turn ceiling"] };
const SUCCESS: ResultEvent = { type: "result", subtype: "success", isError: false, result: "ok" };

function fakeRun(res: ResultEvent): AgentRunLike {
  const run = {
    emitter: { on() {}, off() {}, once() {}, emit() {} },
    sessionId: "sess-1",
    finished: false,
    lastResult: res,
    rateLimited: false,
    rateLimitInfo: undefined,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    start() {
      return run;
    },
    onEvent: () => () => {},
    onEnd: () => {},
    send() {},
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    endInput() {},
    async stop() {},
    async result() {
      return res;
    },
    async nextResult() {
      return res;
    },
  };
  return run as unknown as AgentRunLike;
}

/** One implementor session: how it ended and what it left behind. */
interface Session {
  res: ResultEvent;
  actions?: string[];
  prose?: string[];
  finding?: boolean;
  /** A finding posted onto this task by ANOTHER task's run (`notify_thread`). */
  foreignFinding?: boolean;
}

const fresh = (tag: string, n = 6): string[] => Array.from({ length: n }, (_, i) => `Bash {"command":"step ${tag}-${i}"}`);
const POLL = ['Bash {"command":"sleep 60; tail -5 bot.log"}', 'Read {"file_path":"C:/repo/state.json"}'];
/** A wedged session: real volume (six distinct actions), identical every time. */
const WEDGE = [...POLL, ...fresh("loop", 4)];

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  resumes: number;
  dispose(): void;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));

function makeHarness(sessions: Session[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "continuation-progress-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  const thread = db.createThread({ title: "long task", workspace, rawPrompt: "p", brief: "b" });
  const other = db.createThread({ title: "neighbour", workspace, rawPrompt: "p", brief: "b" });
  const otherRun = db.createRun({ threadId: other.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.lastImplementorSession.set(thread.id, "sess-1");

  const h: Harness = {
    mgr,
    db,
    thread,
    resumes: 0,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };

  /** Start session `i`: a fresh run row (strictly later than the last, so activity never bleeds across
   *  sessions on a shared millisecond) plus the activity that session persists. */
  const launch = async (i: number) => {
    await tick();
    const s = sessions[i] ?? { res: SUCCESS, prose: ["Finished."] };
    const run = db.createRun({ threadId: thread.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
    const agent = fakeRun(s.res);
    internals.live.set(thread.id, { run: agent, runId: run.id, accountId: "a" });
    for (const content of s.actions ?? []) db.addMessage({ threadId: thread.id, runId: run.id, role: "implementor", kind: "tool", content });
    for (const content of s.prose ?? []) db.addMessage({ threadId: thread.id, runId: run.id, role: "implementor", kind: "text", content });
    if (s.finding) mgr.postFinding({ threadId: thread.id, fromRunId: run.id, fromRole: "implementor", summary: `learned ${i}`, severity: "note" });
    if (s.foreignFinding) mgr.postFinding({ threadId: thread.id, fromRunId: otherRun.id, fromRole: "implementor", summary: `fyi ${i}`, severity: "note" });
    return { run: agent, runId: run.id, accountId: "a" };
  };

  internals.startResumedImplementor = async () => {
    h.resumes++;
    return launch(h.resumes);
  };
  internals.firstLaunch = () => launch(0);
  return h;
}

async function drive(h: Harness): Promise<ResultEvent | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const first = await internals.firstLaunch();
  return internals.awaitImplementorCompletion(h.thread, undefined, "kickoff", first.run, "a", false, "continue", true);
}

function parkText(h: Harness, res: ResultEvent | undefined): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (h.mgr as any).implementorParkReason(res, "needs your review.");
}

// ---- pure classifier -------------------------------------------------------------------------------

console.log("\n=== 0. the pure progress read ===");
{
  const none = new Set<string>();
  const activity = (actions: string[], findingSummaries: string[] = [], earlierFindingSummaries: string[] = []) => ({ actions, findingSummaries, earlierFindingSummaries });
  check("an empty session is not progress", !assessSessionProgress(activity([]), none).progressed);
  check("new actions are progress", assessSessionProgress(activity(fresh("x")), none).progressed);
  const base = assessSessionProgress(activity(POLL), none).actionKeys;
  check("the same poll again is not progress", !assessSessionProgress(activity([...POLL, ...POLL]), base).progressed);
  check("whitespace changes do not make an action new", !assessSessionProgress(activity(POLL.map((a) => ` ${a.replace(" ", "   ")} `)), base).progressed);
  check(
    `fewer than ${MIN_NOVEL_ACTIONS} new actions is not progress`,
    !assessSessionProgress(activity([...POLL, ...fresh("y", MIN_NOVEL_ACTIONS - 1)]), base).progressed,
  );
  check("a new finding is progress on its own", assessSessionProgress(activity(POLL, ["new finding"], ["old finding"]), base).progressed);
  check("a repeated finding is not progress", !assessSessionProgress(activity(POLL, ["old finding"], ["old finding"]), base).progressed);
  check("a changed workspace is progress", assessSessionProgress(activity(POLL), base, true).progressed);
  const history = new ActionHistory(4);
  history.record(base);
  history.record(assessSessionProgress(activity(fresh("other")), none).actionKeys);
  check("history retains actions from multiple sessions", !assessSessionProgress(activity(POLL), history.union()).progressed);
}

console.log("\n=== 0b. workspace changes count as progress ===");
{
  const dir = mkdtempSync(join(tmpdir(), "continuation-git-"));
  try {
    check("non-repository fingerprint is unknown", await workspaceGitFingerprint(dir) === null);
    execFileSync("git", ["init", "-q", dir]);
    // The owner's global core.hooksPath runs a real validation suite on every commit (~3s each here).
    const emptyHooks = join(dir, ".git", "gate-empty-hooks");
    mkdirSync(emptyHooks);
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", emptyHooks]);
    const clean = await workspaceGitFingerprint(dir);
    writeFileSync(join(dir, "artifact.txt"), "first");
    const written = await workspaceGitFingerprint(dir);
    check("an untracked artifact changes the fingerprint", clean !== null && written !== null && clean !== written);
    execFileSync("git", ["-C", dir, "add", "artifact.txt"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "add artifact"]);
    const committed = await workspaceGitFingerprint(dir);
    check("a commit changes the fingerprint", committed !== null && committed !== written);
    check("an unchanged workspace stays stable", (await workspaceGitFingerprint(dir)) === committed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the loop --------------------------------------------------------------------------------------

console.log("\n=== A. a task that keeps working is continued past the old fixed count of 8 ===");
{
  const working = Array.from({ length: 13 }, (_, i): Session => ({ res: CEILING, actions: fresh(`s${i}`) }));
  working.push({ res: SUCCESS, actions: fresh("final"), prose: ["Shipped and verified."] });
  const h = makeHarness(working);
  const res = await drive(h);
  check("all 13 turn-ceiling cutoffs were continued", h.resumes === 13, `${h.resumes} resume(s)`);
  check("the real finish is what comes out", res?.isError === false && res.subtype === "success", JSON.stringify(res));
  h.dispose();
}

console.log("\n=== B. empty resumes between productive sessions never end the task ===");
{
  const sessions: Session[] = [];
  for (let i = 0; i < 6; i++) sessions.push({ res: CEILING, actions: fresh(`w${i}`) }, { res: SUCCESS });
  sessions.push({ res: SUCCESS, actions: fresh("done"), prose: ["Shipped."] });
  const h = makeHarness(sessions);
  const res = await drive(h);
  check("every cutoff and every empty resume was continued", h.resumes === 12, `${h.resumes} resume(s)`);
  check("the task still ends on its real finish", res?.isError === false, JSON.stringify(res));
  h.dispose();
}

console.log("\n=== B2. final-sounding text cannot override an involuntary cutoff ===");
{
  const h = makeHarness([
    { res: CEILING, actions: fresh("almost"), prose: ["All tests pass and the work is done."] },
    { res: SUCCESS, actions: fresh("actual-final"), prose: ["Finished."] },
  ]);
  const res = await drive(h);
  check("the cutoff still gets a continuation", h.resumes === 1, `${h.resumes} resume(s)`);
  check("the continuation reaches a real finish", res?.isError === false);
  h.dispose();
}

console.log("\n=== C. a WEDGED implementor (same poll, session after session) is parked ===");
{
  const h = makeHarness(Array.from({ length: 10 }, (): Session => ({ res: CEILING, actions: WEDGE })));
  const res = await drive(h);
  // Session 0 is new work (nothing to compare with); 1..3 repeat it → the third idle session parks.
  check(`it stops after ${config.implementorNoProgressLimit} idle sessions`, h.resumes === config.implementorNoProgressLimit, `${h.resumes} resume(s)`);
  check("the result is an error, never a finish handed to QA", res?.isError === true);
  const text = parkText(h, res);
  check("the park says why", /did no new work/.test(text) && /needs your review/.test(text), text);
  check("a usage-window rollover will not wake it", !isCapacityStallPark(text), text);
  check("the feed says how many idle sessions it has seen", h.db.listMessages(h.thread.id).some((m) => /no new work in 2\/3 session/.test(m.content)));
  h.dispose();
}

console.log("\n=== D. empty resumes cannot launder a wedge (the baseline survives them) ===");
{
  // Were an empty session allowed to reset the baseline, every WEDGE after one would read as new work.
  const sessions: Session[] = [{ res: CEILING, actions: WEDGE }];
  for (let i = 0; i < 8; i++) sessions.push({ res: SUCCESS }, { res: CEILING, actions: WEDGE });
  const h = makeHarness(sessions);
  const res = await drive(h);
  check("it still parks within the idle limit", h.resumes === config.implementorNoProgressLimit, `${h.resumes} resume(s)`);
  check("with an error result", res?.isError === true);
  check("the empty resume parks as a wedge", /did no new work/.test(parkText(h, res)), parkText(h, res));
  h.dispose();
}

console.log("\n=== E. a finding breaks the idle streak; another task's notification does not ===");
{
  const h = makeHarness([
    { res: CEILING, actions: WEDGE },
    { res: CEILING, actions: WEDGE },
    { res: CEILING, actions: WEDGE, finding: true },
    { res: CEILING, actions: WEDGE },
    { res: CEILING, actions: WEDGE, foreignFinding: true },
    { res: CEILING, actions: WEDGE },
    { res: CEILING, actions: WEDGE },
  ]);
  const res = await drive(h);
  // idle: s1=1, s2 finding → 0, s3=1, s4 foreign (still idle)=2, s5=3 → park after the 5th resume.
  check("the own finding reset the streak, the foreign one did not", h.resumes === 5, `${h.resumes} resume(s)`);
  check("then parked", res?.isError === true);
  h.dispose();
}

console.log("\n=== F. an operator's explicit MAX_AUTO_RESUMES still caps it ===");
{
  const saved = config.maxAutoResumes;
  (config as { maxAutoResumes: number }).maxAutoResumes = 2;
  const h = makeHarness(Array.from({ length: 6 }, (_, i): Session => ({ res: CEILING, actions: fresh(`c${i}`) })));
  const res = await drive(h);
  check("it stopped at the configured cap", h.resumes === 2, `${h.resumes} resume(s)`);
  check("the feed shows the cap", h.db.listMessages(h.thread.id).some((m) => /continuing… 2\/2/.test(m.content)));
  check("the park keeps the turn-ceiling reason (not a wedge)", /turn ceiling/.test(parkText(h, res)), parkText(h, res));
  (config as { maxAutoResumes: number }).maxAutoResumes = saved;
  h.dispose();
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
