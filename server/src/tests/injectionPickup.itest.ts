/**
 * Integration test — an appended owner injection must not sit unread behind one blocking tool call.
 *
 * The bug (task 3777dfb0, 2026-09-24): the owner injected while the implementor was inside an 8-minute
 * PowerShell poll loop. A streaming SDK session only reads a queued user message at a tool/turn
 * boundary, so the message waited 5m49s and the owner had to ask again before anything answered.
 * `watchInjectionPickup` interrupts the blocked call once the message has gone unread for
 * `config.injectionPickupMs`; an SDK probe showed `interrupt()` stops a running Bash tool within ~60ms
 * and the queued message is answered right after, while `priority: "now"` waits for the tool to finish.
 *
 * The reverse bug (task c9d16556, 2026-09-27): a message sent to an IDLE (or still-booting) session starts
 * its own turn, and a slow prompt hook plus first token kept that turn quiet past the deadline. The watch
 * interrupted the turn that had just read the owner's message, nothing was left queued, and the task sat
 * dead. Only an open tool call with an unconsumed message may be interrupted.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `watchInjectionPickup`, `injectionNeedsPickupWatch`, `injectThread`'s live branch, a real Db.
 *  - STUBBED: the agent itself — a subclass of the real `AgentRun` whose send/interrupt only record, and
 *    whose events are emitted by hand on the real emitter.
 *
 * Run:  npm run test:injection-pickup   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.INJECTION_PICKUP_MS = "150";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunConfig, SendOpts } from "../agents/runner.js";
import type { AgentEvent } from "../types.js";

const { AgentRun } = await import("../agents/runner.js");
const { CodexAgentRun } = await import("../agents/codexRunner.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { watchInjectionPickup } = await import("../orchestrator/injectionPickup.js");
const { injectionNeedsPickupWatch } = await import("../orchestrator/injection.js");

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeSdkRun extends AgentRun {
  readonly sends: { opts?: SendOpts }[] = [];
  interrupts = 0;
  constructor() {
    super({ cwd: tmpdir() } as AgentRunConfig);
  }
  override send(_content: unknown, opts?: SendOpts): void {
    this.sends.push({ opts });
  }
  override async interrupt(): Promise<void> {
    this.interrupts++;
  }
  override async stop(): Promise<void> {
    this.end();
  }
  fire(e: AgentEvent): void {
    this.emitter.emit("event", e);
  }
  /** Put the run inside one tool call, as the classic blocked case is. */
  blockInTool(): void {
    this.fire({ type: "tool_use", id: "blocking", name: "Bash", input: {} });
  }
  /** Send through the real AgentRun path, so the message carries the uuid the CLI echoes back. */
  realSend(): string {
    super.send("owner message");
    return this.lastInputId!;
  }
  /** Stamp a sent message the way the CLI does on the first stream frame of the turn that consumed it. */
  cliConsumes(uuid: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).handle({ type: "stream_event", event: { type: "message_start" }, user_message_uuids: [uuid] });
  }
  end(): void {
    this.finished = true;
    this.emitter.emit("end");
  }
}

interface Watched {
  interrupted: number[];
  settled: number;
}

function watch(run: FakeSdkRun, opts: { timeoutMs?: number; quietMs?: number; maxWaitMs?: number; mayInterrupt?: () => boolean } = {}): Watched {
  const w: Watched = { interrupted: [], settled: 0 };
  watchInjectionPickup(run, {
    timeoutMs: opts.timeoutMs ?? 60,
    quietMs: opts.quietMs ?? 40,
    maxWaitMs: opts.maxWaitMs,
    mayInterrupt: opts.mayInterrupt ?? (() => true),
    onInterrupt: (ms) => w.interrupted.push(ms),
    onSettled: () => w.settled++,
  });
  return w;
}

async function unitCases(): Promise<void> {
  console.log("Watcher — the decision itself");
  {
    const run = new FakeSdkRun();
    run.blockInTool();
    const w = watch(run);
    await sleep(120);
    check("a silent run (blocked in one tool call) is interrupted", run.interrupts === 1 && w.interrupted.length === 1, JSON.stringify(w));
    check("the watch settles exactly once", w.settled === 1, String(w.settled));
  }
  {
    const run = new FakeSdkRun();
    const w = watch(run);
    run.fire({ type: "tool_result", id: "t1", content: "ok", isError: false });
    await sleep(120);
    check("a tool boundary before the deadline means the message was read — no interrupt", run.interrupts === 0 && w.settled === 1, JSON.stringify(w));
  }
  {
    const run = new FakeSdkRun();
    watch(run);
    run.fire({ type: "result", subtype: "success", isError: false, result: "ACK" });
    await sleep(120);
    check("a finished turn also counts as picked up", run.interrupts === 0, String(run.interrupts));
  }
  {
    const run = new FakeSdkRun();
    const w = watch(run, { timeoutMs: 60, quietMs: 60, maxWaitMs: 10_000 });
    const streaming = setInterval(() => run.fire({ type: "text_delta", text: "…" }), 15);
    await sleep(150);
    check("a run still streaming is not interrupted mid-generation", run.interrupts === 0, String(run.interrupts));
    clearInterval(streaming);
    run.blockInTool();
    await sleep(150);
    check("…and is interrupted once it falls quiet (the tool call it started is blocking)", run.interrupts === 1 && w.interrupted.length === 1, JSON.stringify(w));
  }
  {
    const run = new FakeSdkRun();
    run.blockInTool();
    watch(run, { timeoutMs: 40, quietMs: 60, maxWaitMs: 120 });
    const streaming = setInterval(() => run.fire({ type: "thinking_delta", text: "…" }), 10);
    await sleep(220);
    clearInterval(streaming);
    check("a run that never goes quiet is still interrupted at the hard bound", run.interrupts === 1, String(run.interrupts));
  }
  {
    const run = new FakeSdkRun();
    run.blockInTool();
    const w = watch(run, { mayInterrupt: () => false });
    await sleep(120);
    check("a run the task no longer owns (replaced, or waiting on its question) is left alone", run.interrupts === 0 && w.settled === 1, JSON.stringify(w));
  }
  {
    const run = new FakeSdkRun();
    const w = watch(run);
    run.end();
    await sleep(120);
    check("a run that ends before the deadline is not interrupted", run.interrupts === 0 && w.settled === 1, JSON.stringify(w));
  }
  {
    const run = new FakeSdkRun();
    const w = watch(run, { timeoutMs: 0 });
    await sleep(60);
    check("timeoutMs 0 disables the watch", run.interrupts === 0 && w.settled === 1, JSON.stringify(w));
  }

  console.log("\nA message that started its own turn (idle or booting session)");
  {
    const run = new FakeSdkRun();
    run.realSend();
    const w = watch(run);
    await sleep(150);
    check("a quiet run with no tool call open is NOT interrupted — the quiet turn may be the owner's own message", run.interrupts === 0 && w.interrupted.length === 0, JSON.stringify(w));
    check("…and the watch stays armed until the message is read", w.settled === 0, String(w.settled));
    run.fire({ type: "result", subtype: "success", isError: false, result: "ACK" });
    check("…which a finished turn proves", w.settled === 1, String(w.settled));
  }
  {
    const run = new FakeSdkRun();
    const sent = run.realSend();
    const w = watch(run);
    run.cliConsumes(sent);
    run.blockInTool();
    await sleep(150);
    check("a message the CLI stamped as consumed is not interrupted once its turn opens a long tool call", run.interrupts === 0 && w.settled === 1, JSON.stringify(w));
  }
  {
    const run = new FakeSdkRun();
    run.cliConsumes(run.realSend());
    run.realSend();
    run.blockInTool();
    const w = watch(run);
    await sleep(150);
    check("an older consumed message does not excuse the newest one still queued behind a tool call", run.interrupts === 1 && w.interrupted.length === 1, JSON.stringify(w));
  }
  {
    const run = new FakeSdkRun();
    run.blockInTool();
    run.fire({ type: "result", subtype: "error_during_execution", isError: true });
    run.realSend();
    const w = watch(run);
    await sleep(150);
    check("a tool call left open by an aborted turn does not count as blocking the next one", run.interrupts === 0, JSON.stringify(w));
    run.end();
  }

  console.log("\nWhich sends need a watch");
  check("an append to a streaming SDK run does", injectionNeedsPickupWatch(new FakeSdkRun(), "append"));
  check("an interrupt-mode send does not (it already stops the turn)", !injectionNeedsPickupWatch(new FakeSdkRun(), "interrupt"));
  const codex = Object.create(CodexAgentRun.prototype);
  check("a Codex batch run does not (every Codex send already interrupts the batch)", !injectionNeedsPickupWatch(codex, "append"));
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
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "acct-a", label: "acct-a" }, hasHeadroom: true };
  }
  select(): { account: { id: string; label: string }; reason: string } {
    return { account: { id: "acct-a", label: "acct-a" }, reason: "fixture" };
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  auxToken(): undefined {
    return undefined;
  }
}

async function withManager(fn: (h: {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  seedLive: () => { id: string; run: FakeSdkRun };
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "injection-pickup-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const seedLive = () => {
    const t = db.createThread({ title: "pickup task", workspace, rawPrompt: "do the thing" });
    db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF", planDone: true, approved: true });
    db.updateThread(t.id, { state: "implementing" });
    const run = new FakeSdkRun();
    internals.live.set(t.id, { run, runId: "run-1", accountId: "acct-a" });
    return { id: t.id, run };
  };
  try {
    await fn({ mgr, db, internals, seedLive });
  } finally {
    if (internals.capSupervisor) clearInterval(internals.capSupervisor);
    if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
    await sleep(50);
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const pickupNotes = (db: InstanceType<typeof Db>, id: string) =>
  db.listMessagePage(id, 50).messages.filter((m) => m.kind === "system" && m.content.startsWith("⏱"));

async function wiringCases(): Promise<void> {
  console.log("\ninjectThread — the live implementor branch");
  await withManager(async ({ mgr, db, seedLive }) => {
    const { id, run } = seedLive();
    run.blockInTool();
    const r = await mgr.injectThread(id, "stop and answer me", "append");
    check("the append was accepted and delivered", r.ok && run.sends.length === 1, JSON.stringify(r));
    check("it was delivered as a plain append (no abort up front)", run.sends[0]?.opts === undefined, JSON.stringify(run.sends[0]));
    await sleep(350);
    check("the blocked implementor was interrupted once the message sat unread", run.interrupts === 1, String(run.interrupts));
    check("the owner is told why their agent's tool call was stopped", pickupNotes(db, id).length === 1, JSON.stringify(pickupNotes(db, id)));
  });
  await withManager(async ({ mgr, db, seedLive }) => {
    const { id, run } = seedLive();
    run.blockInTool();
    await mgr.injectThread(id, "first", "append");
    await mgr.injectThread(id, "second", "append");
    await sleep(350);
    check("two quick injections share one watch — one interrupt, one note", run.interrupts === 1 && pickupNotes(db, id).length === 1, `${run.interrupts} / ${pickupNotes(db, id).length}`);
  });
  await withManager(async ({ mgr, db, seedLive }) => {
    const { id, run } = seedLive();
    run.blockInTool();
    await mgr.injectThread(id, "answer me", "append");
    run.fire({ type: "tool_result", id: "t1", content: "done", isError: false });
    await sleep(350);
    check("an implementor that reached a tool boundary in time is not interrupted", run.interrupts === 0 && pickupNotes(db, id).length === 0, String(run.interrupts));
  });
  await withManager(async ({ mgr, db, seedLive }) => {
    const { id, run } = seedLive();
    run.blockInTool();
    await mgr.injectThread(id, "answer me", "append");
    db.updateThread(id, { state: "awaiting_user" });
    await sleep(350);
    check("an implementor waiting on its own ask_user question is not interrupted", run.interrupts === 0, String(run.interrupts));
  });
  await withManager(async ({ mgr, seedLive, internals }) => {
    const { id, run } = seedLive();
    run.blockInTool();
    await mgr.injectThread(id, "answer me", "append");
    internals.live.set(id, { run: new FakeSdkRun(), runId: "run-2", accountId: "acct-a" });
    await sleep(350);
    check("a run replaced by a relaunch is not interrupted", run.interrupts === 0, String(run.interrupts));
  });
  await withManager(async ({ mgr, db, seedLive }) => {
    const { id, run } = seedLive();
    await mgr.injectThread(id, "salvage the stash", "append");
    await sleep(350);
    check("an idle implementor whose turn is slow to start is not interrupted, and the owner is not told it was", run.interrupts === 0 && pickupNotes(db, id).length === 0, `${run.interrupts} / ${pickupNotes(db, id).length}`);
    run.end();
  });

  // The bug (task f11e4764, 2026-09-30): the owner appended while QA sat inside a 580s test-suite Bash call.
  // The QA lane delivered the message and posted "[delivered]", but only the implementor lane was watched,
  // so the instruction stayed unread for 10 minutes and the owner reported the task as ignoring them.
  console.log("\ninjectThread — the live QA and auto-review lanes");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seedReviewLane = (h: { db: InstanceType<typeof Db>; internals: any }, lane: "qa" | "reviewer") => {
    const t = h.db.createThread({ title: `pickup ${lane} task`, workspace: tmpdir(), rawPrompt: "review the thing" });
    h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF", planDone: true, approved: true });
    h.db.updateThread(t.id, { state: lane === "qa" ? "qa" : "reviewing" });
    const run = new FakeSdkRun();
    const row = h.db.createRun({ threadId: t.id, role: lane, model: "claude-opus-5-5", account: "acct-a" });
    if (lane === "qa") {
      h.internals.liveQa.set(t.id, run);
      h.internals.liveQaRunId.set(t.id, row.id);
    } else {
      h.internals.liveReviewer.set(t.id, run);
      h.internals.liveReviewerRunId.set(t.id, row.id);
    }
    return { id: t.id, run, runId: row.id };
  };
  await withManager(async ({ mgr, db, internals }) => {
    const { id, run } = seedReviewLane({ db, internals }, "qa");
    run.blockInTool();
    const r = await mgr.injectThread(id, "heal me first, then the party", "append");
    check("the QA append was accepted and delivered as a plain send", r.ok && run.sends.length === 1 && run.sends[0]?.opts === undefined, JSON.stringify({ r, sends: run.sends }));
    await sleep(350);
    check("QA blocked in one long tool call is interrupted once the owner's message sat unread", run.interrupts === 1, String(run.interrupts));
    const notes = pickupNotes(db, id);
    check("the owner is told QA's tool call was stopped to deliver their message", notes.length === 1 && notes[0]!.content.includes("QA"), JSON.stringify(notes));
  });
  await withManager(async ({ mgr, db, internals }) => {
    const { id, run } = seedReviewLane({ db, internals }, "reviewer");
    run.blockInTool();
    const r = await mgr.injectThread(id, "also check the migration", "append");
    check("the auto-review append was accepted", r.ok && run.sends.length === 1, JSON.stringify(r));
    await sleep(350);
    check("an auto-reviewer blocked in one long tool call is interrupted the same way", run.interrupts === 1 && pickupNotes(db, id).length === 1, `${run.interrupts} / ${pickupNotes(db, id).length}`);
  });
  await withManager(async ({ mgr, db, internals }) => {
    const { id, run } = seedReviewLane({ db, internals }, "qa");
    run.blockInTool();
    await mgr.injectThread(id, "answer me", "append");
    internals.liveQa.set(id, new FakeSdkRun());
    await sleep(350);
    check("a QA run a failover replaced is not interrupted", run.interrupts === 0, String(run.interrupts));
  });
  await withManager(async ({ mgr, db, internals }) => {
    const { id, run } = seedReviewLane({ db, internals }, "qa");
    run.blockInTool();
    await mgr.injectThread(id, "answer me", "append");
    db.updateThread(id, { state: "awaiting_user" });
    await sleep(350);
    check("a QA run waiting on its own question is not interrupted", run.interrupts === 0, String(run.interrupts));
  });
  await withManager(async ({ mgr, db, internals }) => {
    const { id, run, runId } = seedReviewLane({ db, internals }, "qa");
    run.blockInTool();
    const verdict = internals.awaitStructuredReviewResult(db.getThread(id), "qa", run, runId);
    await mgr.injectThread(id, "swap to the amethyst staff", "append");
    await sleep(350);
    const label = `RI-${String(internals.reviewInjections.listThread(id)[0]?.id).slice(0, 8)}`;
    // What the CLI does after interrupt() (`probe:sdk-steer -- --mode pickup --schema`, 2026-09-30): the
    // stopped turn closes as an error-shaped, verdict-less result, then the queued owner message runs as
    // the next turn and answers with the acknowledged verdict.
    run.fire({ type: "result", subtype: "error_during_execution", isError: true, aborted: true, terminalReason: "aborted_tools" });
    await sleep(20);
    run.fire({ type: "result", subtype: "success", isError: false, structuredOutput: { pass: true, summary: `ACK ${label}: staff swap verified` } });
    const res = await verdict;
    const waiting = db.listMessages(id).filter((m) => m.content.startsWith("[waiting]"));
    check("the turn the pickup watch aborted is not read as QA's verdict", (res?.structuredOutput as { summary?: string } | undefined)?.summary?.startsWith(`ACK ${label}`) === true, JSON.stringify(res));
    check("…nor reported to the owner as a verdict that skipped their instruction", waiting.length === 0, JSON.stringify(waiting.map((m) => m.content)));
    const row = internals.reviewInjections.listThread(id)[0] as { status: string; reviewerAcknowledgedAt?: number | null } | undefined;
    check(
      "…and the instruction is recorded as acknowledged, not failed",
      row?.reviewerAcknowledgedAt != null && row.status !== "failed",
      JSON.stringify(row),
    );
  });

  console.log("\ninjectThread — no agent running (cold inject)");
  await withManager(async ({ mgr, db, internals, seedLive }) => {
    const { id } = seedLive();
    internals.live.delete(id);
    db.updateThread(id, { state: "review" });
    const resumed: string[] = [];
    internals.resumeThread = async (threadId: string) => {
      resumed.push(threadId);
      return { ok: true, state: "implementing" };
    };
    await mgr.injectThread(id, "are you there?", "append");
    const echo = db.listMessagePage(id, 50).messages.find((m) => m.kind === "system" && m.content.includes("are you there?"));
    check("the cold inject still resumes the task", resumed.length === 1, JSON.stringify(resumed));
    check("its feed line says an agent is starting, so a slow boot does not read as a frozen task", !!echo?.content.startsWith("↪ injected (no agent was running, so one is starting to answer it): "), echo?.content);
  });
}

console.log("\n=== Injection pickup integration test ===\n");
await unitCases();
await wiringCases();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
