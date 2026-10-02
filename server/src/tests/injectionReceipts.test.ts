import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import { InputLedger } from "../agents/inputLedger.js";
import type { AgentRunLike, UserContent } from "../agents/runner.js";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { acknowledgedInjection } from "../orchestrator/injection.js";
import { acknowledges, carriesInstruction, InjectionReceipts } from "../orchestrator/injectionReceipts.js";
import type { AgentEvent, InjectionReceipt, InjectionRecipient } from "../types.js";

// Read receipts for injected owner messages: every transition is earned at a run's input, never by the
// route that accepted or queued the message.

/** A run with the same input surface as the real runners: send issues an input id, the test decides
 *  when the provider "consumes" it, emits model events, and ends the run. */
class FakeRun {
  readonly inputs = new InputLedger();
  marker: string | undefined;
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly endCbs: (() => void)[] = [];
  constructor(private readonly signals = true) {}
  get lastInputId(): string | undefined {
    return this.signals ? this.inputs.lastId : undefined;
  }
  onInputConsumed(id: string, cb: () => void): () => void {
    return this.inputs.onConsumed(id, cb);
  }
  send(content: UserContent): string {
    this.marker = String(content).match(/\[GGO receipt (IR-[\w-]+)\]/)?.[1];
    return this.inputs.issue();
  }
  consumeLatest(): void {
    if (this.inputs.lastId) this.inputs.consume([this.inputs.lastId]);
  }
  emit(e: AgentEvent): void {
    for (const cb of this.listeners) cb(e);
  }
  onEvent(cb: (e: AgentEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onEnd(cb: () => void): void {
    this.endCbs.push(cb);
  }
  end(): void {
    for (const cb of this.endCbs.splice(0)) cb();
  }
  asRun(): AgentRunLike {
    return this as unknown as AgentRunLike;
  }
}

const dir = mkdtempSync(join(tmpdir(), "gg-receipts-"));
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const published: InjectionReceipt[] = [];
hub.subscribe((e) => {
  if (e.type === "thread.receipt") published.push(e.receipt);
});
const receipts = new InjectionReceipts(db, hub);

function thread(): string {
  return db.createThread({ title: "receipts", workspace: dir, rawPrompt: "p" }).id;
}
function echo(threadId: string, text: string): string {
  return db.addMessage({ threadId, role: "director", kind: "system", content: `injected: ${text}` }).id;
}
function receiptOf(messageId: string, recipient: InjectionRecipient = "implementor"): InjectionReceipt {
  const row = db.raw.prepare("SELECT id FROM injection_receipts WHERE message_id=? AND recipient=?").get(messageId, recipient) as { id: string } | undefined;
  assert.ok(row, `a ${recipient} receipt exists for ${messageId}`);
  return receipts.get(row.id)!;
}
function countFor(messageId: string): number {
  return (db.raw.prepare("SELECT COUNT(*) c FROM injection_receipts WHERE message_id=?").get(messageId) as { c: number }).c;
}
function sendTo(run: FakeRun, threadId: string, recipient: InjectionRecipient, content: UserContent, runId = "run-1"): void {
  const prepared = receipts.prepare(threadId, recipient, run.asRun(), content);
  run.send(prepared);
  receipts.observe(threadId, recipient, { run: run.asRun(), runId, provider: "claude" }, prepared);
}
function ack(run: FakeRun, text = "ACK: switching to the new clip design."): void {
  if (acknowledges(text) && run.marker) text += `\nACK ${run.marker}: applied.`;
  run.emit({ type: "text", text } as AgentEvent);
}

// 1. Accepting or queueing only opens a pending receipt; handing it over, consumption and the ACK each
//    earn their own step, in that order.
{
  const t = thread();
  const text = "Use the new clip design.";
  const m = echo(t, text);
  receipts.expect(t, m, text, ["implementor"], "Queued until the implementor's next hand-off.");
  assert.equal(receiptOf(m).status, "pending", "queueing never marks a message read");
  const run = new FakeRun();
  sendTo(run, t, "implementor", acknowledgedInjection("an unrelated instruction"));
  assert.equal(receiptOf(m).status, "pending", "an input without the instruction's text does not bind it");
  sendTo(run, t, "implementor", acknowledgedInjection(text));
  const sent = receiptOf(m);
  assert.equal(sent.status, "sent");
  assert.ok(sent.sentAt && sent.runId === "run-1" && sent.provider === "claude");
  ack(run);
  assert.equal(receiptOf(m).status, "sent", "an ACK before the provider confirms consumption does not count");
  run.consumeLatest();
  const delivered = receiptOf(m);
  assert.equal(delivered.status, "delivered");
  assert.ok(delivered.deliveredAt);
  ack(run, "Working on it.");
  assert.equal(receiptOf(m).status, "delivered", "plain output is not an acknowledgement");
  ack(run);
  const read = receiptOf(m);
  assert.equal(read.status, "read");
  assert.ok(read.readAt && read.readAt >= read.deliveredAt!);
  run.end();
  assert.equal(receiptOf(m).status, "read", "the end of the run keeps a proven receipt");
}

// 2. QA takes the message while the implementor's copy is still queued: separate receipts per recipient.
{
  const t = thread();
  const text = "Also check the export dialog.";
  const m = echo(t, text);
  receipts.expect(t, m, text, ["qa", "implementor"]);
  const qa = new FakeRun();
  sendTo(qa, t, "qa", `RI prompt\n${text}`, "qa-run");
  qa.consumeLatest();
  assert.equal(receiptOf(m, "qa").status, "delivered");
  assert.equal(receiptOf(m, "implementor").status, "pending", "QA's delivery says nothing about the implementor");
  ack(qa, "**ACK RI-1a2b3c4d:** reviewing the dialog too.");
  assert.equal(receiptOf(m, "qa").status, "read", "a reviewer's labelled ACK counts");
  const impl = new FakeRun();
  sendTo(impl, t, "implementor", `kickoff\n\nStanding directives:\n- ${text}`, "impl-run");
  impl.consumeLatest();
  assert.equal(receiptOf(m, "implementor").status, "delivered");
}

// 3. A route that sends before it echoes (interrupt awaiting a resume) still binds: the live input is
//    remembered, and a provider that already consumed it delivers at once.
{
  const t = thread();
  const text = "Stop and revert the last migration.";
  const run = new FakeRun();
  const m = echo(t, text);
  receipts.withInjection(t, text, () => {
    sendTo(run, t, "implementor", acknowledgedInjection(text));
    run.consumeLatest();
    receipts.expect(t, m, text, ["implementor"]);
  });
  assert.equal(receiptOf(m).status, "delivered");
  run.end();
  const later = echo(t, text);
  receipts.expect(t, later, text, ["implementor"]);
  assert.equal(receiptOf(later).status, "pending", "an ended run's inputs are forgotten");
}

// 4. Retry: a run that ends before taking the input returns the receipt to pending, and the retry
//    binds the SAME receipt (no duplicate) without moving the first hand-over time.
{
  const t = thread();
  const text = "Use port 4400.";
  const m = echo(t, text);
  receipts.expect(t, m, text, ["implementor"]);
  const first = new FakeRun();
  sendTo(first, t, "implementor", acknowledgedInjection(text), "run-a");
  const firstSent = receiptOf(m).sentAt;
  first.end();
  assert.equal(receiptOf(m).status, "pending", "a run that died before reading it did not read it");
  const retry = new FakeRun();
  sendTo(retry, t, "implementor", acknowledgedInjection(text), "run-b");
  sendTo(retry, t, "implementor", acknowledgedInjection(text), "run-b");
  const again = receiptOf(m);
  assert.equal(again.status, "sent");
  assert.equal(again.runId, "run-b");
  assert.equal(again.sentAt, firstSent, "the first hand-over time is kept");
  retry.consumeLatest();
  assert.equal(receiptOf(m).status, "delivered");
  assert.equal(countFor(m), 1);
  receipts.expect(t, m, text, ["implementor"]);
  assert.equal(countFor(m), 1, "re-expecting a message is idempotent");
}

// 5. A provider without a consumption signal stops at "sent" and says why.
{
  const t = thread();
  const text = "Keep the old palette.";
  const m = echo(t, text);
  receipts.expect(t, m, text, ["implementor"]);
  const run = new FakeRun(false);
  sendTo(run, t, "implementor", acknowledgedInjection(text));
  const r = receiptOf(m);
  assert.equal(r.status, "sent");
  assert.match(r.detail ?? "", /no read signal/);
  ack(run);
  assert.equal(receiptOf(m).status, "sent", "without delivery proof an ACK cannot be tied to this input");
}

// 6. Restart, settle and refusal.
{
  const t = thread();
  const handed = echo(t, "first");
  const proven = echo(t, "second");
  receipts.expect(t, handed, "first", ["implementor"]);
  receipts.expect(t, proven, "second", ["implementor"]);
  const run = new FakeRun();
  sendTo(run, t, "implementor", acknowledgedInjection("first"));
  sendTo(run, t, "implementor", acknowledgedInjection("second"));
  run.consumeLatest();
  receipts.recoverAfterRestart();
  assert.equal(receiptOf(handed).status, "pending", "a hand-over the restart lost is pending again");
  assert.equal(receiptOf(proven).status, "delivered", "a proven delivery survives restart");

  receipts.settleLane(t, "review");
  assert.equal(receiptOf(handed).status, "pending", "a parked task can still deliver it");
  receipts.settleLane(t, "done");
  const failed = receiptOf(handed);
  assert.equal(failed.status, "failed");
  assert.ok(failed.failedAt && /done before this agent took/.test(failed.detail ?? ""));
  assert.equal(receiptOf(proven).status, "delivered");

  const p = thread();
  const planned = echo(p, "plan with SQLite");
  receipts.expect(p, planned, "plan with SQLite", ["planner", "implementor"]);
  receipts.settleLane(p, "planning");
  assert.equal(receiptOf(planned, "planner").status, "pending");
  receipts.settleLane(p, "implementing");
  assert.equal(receiptOf(planned, "planner").status, "failed", "planning ended without the planner taking it");
  assert.equal(receiptOf(planned, "implementor").status, "pending");

  const refused = echo(p, "stop QA");
  receipts.refuse(p, refused, "stop QA", ["implementor"], "Could not stop QA: boom");
  assert.equal(receiptOf(refused).status, "failed");
  assert.equal(receipts.expect(p, echo(p, "  "), "  ", ["implementor"]).length, 0, "an images-only inject has no text to follow");
}

// 7. Every change is published for live clients, and the ACK grammar.
assert.ok(published.some((r) => r.status === "read") && published.some((r) => r.status === "failed"));
const EM_DASH = String.fromCharCode(0x2014);
for (const yes of ["ACK: on it", "**ACK:** on it", "intro\nACK - will do", "ACK RI-1a2b3c4d + RI-5e6f7a8b: done", `> ACK ${EM_DASH} fine`]) {
  assert.ok(acknowledges(yes), yes);
}
for (const no of ["I will ACK later", "ACKNOWLEDGED", "back: ACK: no"]) {
  assert.ok(!acknowledges(no), no);
}

// 7b. Binding needs the instruction on whole lines, in every shape a route sends it.
assert.ok(carriesInstruction(acknowledgedInjection("ok"), "ok"), "the steering frame puts it on its own line");
assert.ok(carriesInstruction("## Owner instructions\n1. use  port\n4400\n2. other", "use port 4400"), "a numbered standing directive, whitespace reflowed");
assert.ok(carriesInstruction("[CURRENT OWNER INSTRUCTION -- RI-1]\nRI-1 (append):\nok\n", "ok"), "an RI prompt");
assert.ok(carriesInstruction("QA handoff\nRI-1a2b3c4d: use port 4400\n", "use port 4400"), "an implementor's RI handoff");
assert.ok(!carriesInstruction("Review the diff and say ok when done.", "ok"), "a short instruction does not bind to a word inside other text");
assert.ok(!carriesInstruction("please use port 4400 now", "use port 4400"), "nor to the middle of a line");
{
  const t = thread();
  const m = echo(t, "ok");
  receipts.expect(t, m, "ok", ["implementor"]);
  const run = new FakeRun();
  sendTo(run, t, "implementor", "Continue the task. Reply ok when the build passes.");
  assert.equal(receiptOf(m).status, "pending", "an unrelated input mentioning the word leaves it pending");
}

// Exact message identity: repeated owner text cannot borrow a prior input's receipt, and ACKs name
// only their input even when multiple delivered messages wait on the same live run.
{
  const t = thread();
  const text = "Keep the export dialog.";
  const first = echo(t, text);
  receipts.expect(t, first, text, ["implementor"]);
  const run = new FakeRun();
  sendTo(run, t, "implementor", acknowledgedInjection(text));
  const firstToken = run.marker!;
  run.consumeLatest();
  run.emit({ type: "text", text: "ACK: unrelated earlier direction." });
  assert.equal(receiptOf(first).status, "delivered", "a generic ACK is not exact-message proof");
  const second = echo(t, text);
  receipts.withInjection(t, text, () => receipts.expect(t, second, text, ["implementor"]));
  assert.equal(receiptOf(second).status, "pending", "identical text cannot borrow an older live input");
  sendTo(run, t, "implementor", acknowledgedInjection(text));
  const secondToken = run.marker!;
  run.consumeLatest();
  run.emit({ type: "text", text: `ACK ${firstToken}: keeping it.` });
  assert.equal(receiptOf(first).status, "read");
  assert.equal(receiptOf(second).status, "delivered", "an old input ACK cannot read the new message");
  run.emit({ type: "result", subtype: "success", isError: false, structuredOutput: { summary: `ACK ${secondToken}: keeping it.` } });
  assert.equal(receiptOf(second).status, "read", "a schema-valid summary can acknowledge its exact input");
}

// 8. The real CLI runners: an input is consumed only once the turn carrying it produces model output.
{
  const t = thread();
  const text = "Retry both sends independently.";
  const m = echo(t, text);
  receipts.expect(t, m, text, ["implementor"]);
  const run = new FakeRun();
  sendTo(run, t, "implementor", acknowledgedInjection(text));
  const firstId = run.lastInputId!;
  sendTo(run, t, "implementor", acknowledgedInjection(text));
  const secondId = run.lastInputId!;
  run.inputs.consume([firstId]);
  run.inputs.consume([secondId]);
  ack(run);
  assert.equal(receiptOf(m).status, "read", "consuming the first send does not discard the retry's acknowledgement watch");
  run.end();
}

{
  const t = thread();
  const text = "Check persistence after restart.";
  const m = echo(t, text);
  receipts.expect(t, m, text, ["implementor"]);
  const first = new FakeRun();
  sendTo(first, t, "implementor", acknowledgedInjection(text));
  first.consumeLatest();
  const oldToken = first.marker!;
  const deliveredAt = receiptOf(m).deliveredAt;
  first.end();
  const reopenedDb = new Db(join(dir, "orchestrator.sqlite"));
  const recovered = new InjectionReceipts(reopenedDb, hub);
  recovered.recoverAfterRestart();
  assert.equal(recovered.list(t)[0]?.status, "delivered", "a new tracker loads proven delivery from disk");
  const resumed = new FakeRun();
  const prepared = recovered.prepare(t, "implementor", resumed.asRun(), acknowledgedInjection(text));
  resumed.send(prepared);
  recovered.observe(t, "implementor", { run: resumed.asRun(), runId: "resumed-run", provider: "codex" }, prepared);
  resumed.consumeLatest();
  resumed.emit({ type: "text", text: `ACK ${oldToken}: from the old run.` });
  assert.equal(recovered.list(t)[0]?.status, "delivered", "a replacement run cannot borrow the old run's ACK");
  ack(resumed);
  const row = recovered.list(t)[0]!;
  assert.equal(row.status, "read");
  assert.equal(row.runId, "resumed-run");
  assert.equal(row.deliveredAt, deliveredAt, "the original delivery time survives a resend");
  assert.equal(recovered.list(t).length, 1);
  resumed.end();
  reopenedDb.raw.close();
}

{
  const ledgerOf = (run: unknown) => (run as { inputs: InputLedger }).inputs;
  const codex = new CodexAgentRun({ model: "gpt-6-sol", effort: "low", cwd: process.cwd(), apiKey: "test-key" });
  const c = codex as unknown as { turnActive: boolean; sessionId: string; requestInterrupt(): void; pendingSends: { inputId: string }[]; turnInputIds: string[]; handleEvent(ev: unknown): void };
  c.turnActive = true;
  c.sessionId = "live";
  c.requestInterrupt = () => {};
  codex.send("steer");
  const queuedId = codex.lastInputId!;
  assert.ok(queuedId && c.pendingSends.some((s) => s.inputId === queuedId), "a send during a batch is queued with its id");
  assert.ok(!ledgerOf(codex).has(queuedId), "queued is not consumed");
  c.turnInputIds = [queuedId];
  c.handleEvent({ type: "turn.started" });
  assert.ok(!ledgerOf(codex).has(queuedId), "a spawned turn has not read anything yet");
  c.handleEvent({ type: "item.completed", item: { type: "error", message: "Not authenticated" } });
  assert.ok(!ledgerOf(codex).has(queuedId), "an error item does not prove delivery into model context");
  c.handleEvent({ type: "item.started", item: { id: "i1", type: "reasoning", text: "" } });
  assert.ok(ledgerOf(codex).has(queuedId), "the first model item proves the prompt was read");

  const grok = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  const g = grok as unknown as { turnActive: boolean; sessionId: string; requestInterrupt(): void; turnInputIds: string[]; handleEvent(ev: unknown): void };
  g.turnActive = true;
  g.sessionId = "live";
  g.requestInterrupt = () => {};
  grok.send("steer");
  const gid = grok.lastInputId!;
  g.turnInputIds = [gid];
  g.handleEvent({ type: "text", data: "" });
  assert.ok(!ledgerOf(grok).has(gid), "an empty frame is not model output");
  g.handleEvent({ type: "text", data: "ACK: ok" });
  assert.ok(!ledgerOf(grok).has(gid), "partial text waits for a completed response so a cap notice cannot earn delivery");
  g.handleEvent({ type: "end" });
  assert.ok(ledgerOf(grok).has(gid));
  const rejected = new GrokAgentRun({ model: "grok-4.5", effort: "low", cwd: process.cwd() });
  const rejectedInternal = rejected as unknown as typeof g;
  rejectedInternal.turnActive = true;
  rejected.send("steer");
  const rejectedId = rejected.lastInputId!;
  rejectedInternal.turnInputIds = [rejectedId];
  rejectedInternal.handleEvent({ type: "end", stopReason: "rate limit exceeded" });
  assert.ok(!ledgerOf(rejected).has(rejectedId), "a provider rejection end is not delivery");
}

db.raw.close();
rmSync(dir, { recursive: true, force: true });
console.log("injectionReceipts: pending/sent/delivered/read/failed transitions, recipients, retries and restart verified");
