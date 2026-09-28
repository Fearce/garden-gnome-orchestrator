/**
 * Integration test — a warm resume of a BLOATED Claude session must reseed from a compressed handoff.
 *
 * The cost (owner report, 2026-09-28: "token consumption over night was much bigger … fewer agents … I
 * suspect long running tasks doing something costly on turn limits"): every turn-ceiling continuation,
 * stall nudge and steering resume inside the cache-warm window resumed the FULL session. A 100-turn
 * implementor's context therefore only ever grew across continuations — 300k → 450k → 550k → 900k
 * tokens in the measured d2r task — until the CLI's own compaction at the ~1M window, and every call of
 * every later session re-read all of it. The warm path assumed "cache warm = cheap"; a cache READ of
 * 900k tokens per call is not cheap. Past `config.resumeReseedContextTokens`, the resume now takes the
 * existing compressed-handoff reseed instead.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `startResumedImplementor` (warm/cold gate, the new context gate, the reseed seed composition)
 *    and `sessionContextTokens` reading a real transcript file from a temp CLAUDE_PROJECTS_DIR.
 *  - SIMULATED: only the agent spawn — `startImplementor` is intercepted to record whether it was asked
 *    to `resume` the prior session or was handed a fresh seed.
 *
 * Run:  npm run test:bloated-resume-reseed   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";

const projectsDir = mkdtempSync(join(tmpdir(), "bloated-resume-projects-"));
process.env.CLAUDE_PROJECTS_DIR = projectsDir;

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { sessionContextTokens } = await import("../orchestrator/resumeCompress.js");
const { config } = await import("../config.js");

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

class Accounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return 10; }
  soonestResetAt(): number | null { return Date.now() + 3_600_000; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  // Compression reads a token for its optional Haiku stage; the fixtures stay under the inline cap, so
  // no Haiku call is made.
  auxToken(): string { return "test-token"; }
  select(): { account: { id: string; label: string; token: string }; reason: string } {
    return { account: { id: "account-a", label: "Claude A", token: "test-token" }, reason: "fixture" };
  }
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "account-a", label: "Claude A", token: "test-token" }, hasHeadroom: true, fiveHour: 10, sevenDay: 10, weeklySafetyPct: 100 };
  }
  dto(): Array<Record<string, unknown>> {
    return [{ id: "account-a", label: "Claude A", enabled: true, active: false, rateLimited: false, fiveHour: 10, sevenDay: 10, updatedAt: Date.now(), weeklySafetyPct: 100 }];
  }
  byId(): undefined { return undefined; }
}

/** A transcript whose latest model call carried `contextTokens` of prompt, split the way the API reports
 *  it (mostly cache reads). Written now, so its mtime is inside the warm window. */
function writeTranscript(sessionId: string, contextTokens: number): void {
  const dir = join(projectsDir, "C--fixture-repo");
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const usage = (ctx: number) => ({ input_tokens: 3, cache_creation_input_tokens: 1_000, cache_read_input_tokens: ctx - 1_003, output_tokens: 200 });
  writeFileSync(join(dir, `${sessionId}.jsonl`), [
    line({ type: "user", message: { role: "user", content: "Implement the feature." } }),
    line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Reading the code." }], usage: usage(40_000) } }),
    line({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Editing the runner now." }], usage: usage(contextTokens) } }),
    // A trailing non-assistant line (a tool result) is the normal shape at a turn-ceiling cutoff.
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  ].join("\n") + "\n");
}

interface StartAsk { resume: string | undefined; kickoff: string }

function makeHarness(lane?: "vanilla"): { mgr: InstanceType<typeof ThreadManager>; db: InstanceType<typeof Db>; thread: Thread; asks: StartAsk[]; logs: string[]; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "bloated-resume-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const logs: string[] = [];
  const realLog = hub.log.bind(hub);
  hub.log = ((level: "info" | "warn" | "error", text: string) => { logs.push(text); realLog(level, text); }) as typeof hub.log;
  const mgr = new ThreadManager(db, hub, new FileMemoryService(join(dir, "memory")), new Accounts() as unknown as AccountManager);
  const thread = db.createThread({ title: "bloated resume", workspace, rawPrompt: "p", brief: "b", lane: lane ?? null });
  db.updateThreadStageOutputs(thread.id, {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const asks: StartAsk[] = [];
  internals.startImplementor = (_t: Thread, kickoff: string, opts?: { resume?: string }) => {
    asks.push({ resume: opts?.resume, kickoff });
    return { run: { onEnd: () => {}, onEvent: () => () => {} }, runId: "run-x", accountId: "account-a" };
  };
  return {
    mgr,
    db,
    thread,
    asks,
    logs,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function resume(h: ReturnType<typeof makeHarness>, sessionId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  // The run row the real spawn would have left: without it the backend/model guards read "no prior
  // session on this provider" and start fresh for their own reasons, proving nothing about this gate.
  const model = internals.implementorDispatchTarget(h.thread.id, "claude", "account-a").model;
  const run = h.db.createRun({ threadId: h.thread.id, role: "implementor", model, account: "Claude A" });
  h.db.updateRun(run.id, { sessionId });
  await internals.startResumedImplementor(h.thread, "kickoff", sessionId, {
    resumeNudge: "You haven't finished — you stopped at a turn limit. Continue exactly where you left off.",
    qaFollows: true,
  });
}

const over = config.resumeReseedContextTokens + 150_000;
const under = Math.floor(config.resumeReseedContextTokens / 2);

console.log("\n=== A. sessionContextTokens reads the latest call's prompt size from the transcript ===");
{
  writeTranscript("sess-measure", 612_345);
  check("the latest assistant call's input + cache read + cache creation", sessionContextTokens("sess-measure") === 612_345, String(sessionContextTokens("sess-measure")));
  check("a session with no transcript is unknown, not zero", sessionContextTokens("sess-missing") === null);
}

console.log("\n=== B. a warm session under the threshold still resumes in place ===");
{
  const h = makeHarness();
  writeTranscript("sess-small", under);
  await resume(h, "sess-small");
  check("the session is resumed in place", h.asks.length === 1 && h.asks[0]?.resume === "sess-small", JSON.stringify(h.asks.map((a) => a.resume)));
  h.dispose();
}

console.log("\n=== C. a warm session over the threshold is reseeded from a compressed handoff ===");
{
  const h = makeHarness();
  writeTranscript("sess-bloated", over);
  await resume(h, "sess-bloated");
  const ask = h.asks[0];
  check("a fresh session is started instead of reloading the bloated one", h.asks.length === 1 && ask?.resume === undefined, JSON.stringify(h.asks.map((a) => a.resume)));
  check("the seed carries the compressed handoff of the prior session", /compressed locally/.test(ask?.kickoff ?? "") && /Editing the runner now\./.test(ask?.kickoff ?? ""), (ask?.kickoff ?? "").slice(0, 300));
  check("the seed carries the continuation nudge", /stopped at a turn limit/.test(ask?.kickoff ?? ""));
  check("the feed log names the context size that triggered the reseed", h.logs.some((l) => /reseeding a fresh session/.test(l) && /context/.test(l)), JSON.stringify(h.logs));
  h.dispose();
}

console.log("\n=== D. a Default-mode (vanilla) session is a stock session: never reseeded ===");
{
  const h = makeHarness("vanilla");
  writeTranscript("sess-vanilla", over);
  await resume(h, "sess-vanilla");
  check("the vanilla session is resumed in place however large", h.asks.length === 1 && h.asks[0]?.resume === "sess-vanilla", JSON.stringify(h.asks.map((a) => a.resume)));
  h.dispose();
}

rmSync(projectsDir, { recursive: true, force: true });
console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
