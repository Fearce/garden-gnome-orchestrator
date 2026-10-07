/** Real CLI parser/close/answer flow + real question storage/events; no model calls or live data. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import { CliQuestionGate } from "../agents/cliQuestions.js";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { ThreadManager } from "../orchestrator/threadManager.js";
import type { ServerEvent } from "../ws/protocol.js";
import type { ThreadState } from "../types.js";

const dir = mkdtempSync(join(tmpdir(), "cli-questions-"));
const db = new Db(join(dir, "test.sqlite"));
const hub = new EventHub();
const events: ServerEvent[] = [];
hub.subscribe((event) => events.push(event));
// Exercise production question methods without starting account polling, routing, or real agents.
const manager = Object.assign(Object.create(ThreadManager.prototype), {
  db, hub, pendingQuestions: new Map(), awaitingPrev: new Map(),
  notifyOwner() {}, touchThread() {},
  setState(id: string, state: ThreadState) { db.updateThread(id, { state }); },
}) as ThreadManager;
const question = { header: "Credit source", question: "Where are the credits?", options: [{ label: "Cloud" }, { label: "API" }], multiSelect: false };
const marker = `ASK_USER: ${JSON.stringify(question)}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Internals = {
  turnActive: boolean;
  sawTerminal: boolean;
  pendingTerminalResult: { subtype: string; isError: boolean; result: string };
  handleEvent(event: unknown): void;
  onTurnClose(code: number | null): Promise<void>;
  runTurn(prompt: string, resume?: string): Promise<void>;
  textBuf: string;
  streamInText: boolean;
  endTextSegment(): void;
};

try {
  for (const provider of ["codex", "grok"] as const) {
    const thread = db.createThread({ title: "Question bridge test", workspace: dir, rawPrompt: "Check credits" });
    db.updateThread(thread.id, { state: "implementing" });
    const run = db.createRun({ threadId: thread.id, role: "implementor", model: "test-model" });
    const onAskUser = (input: typeof question) => manager.askUser({ ...input, threadId: thread.id, runId: run.id });
    const agent = provider === "codex"
      ? new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", onAskUser })
      : new GrokAgentRun({ model: "grok-4.7", effort: "high", cwd: dir, onAskUser });
    const internal = agent as unknown as Internals;
    const resumes: Array<{ prompt: string; resume?: string }> = [];
    const visible: string[] = [];
    let results = 0;
    agent.sessionId = `test-${provider}-session`;
    internal.turnActive = true;
    internal.sawTerminal = true;
    internal.pendingTerminalResult = { subtype: "success", isError: false, result: "Question asked" };
    internal.runTurn = async (prompt, resume) => { resumes.push({ prompt, resume }); };
    agent.onEvent((event) => {
      if (event.type === "result") results++;
      if (event.type === "text") visible.push(event.text);
    });
    if (provider === "codex") {
      internal.handleEvent({ type: "item.completed", item: { type: "agent_message", text: marker } });
    } else {
      internal.streamInText = true;
      internal.textBuf = marker.slice(0, -2);
      internal.endTextSegment();
      assert.equal(internal.textBuf, marker.slice(0, -2), "a thought boundary must not terminate partial question JSON");
      assert.equal(db.listOpenQuestions().length, 0);
      internal.textBuf += marker.slice(-2); // Final flush receives the remaining streaming bytes.
    }
    const closed = internal.onTurnClose(0);
    await tick();
    const open = db.listOpenQuestions().filter((q) => q.threadId === thread.id);
    assert.equal(open.length, 1, `${provider} creates exactly one chip`);
    assert.equal(open[0]!.runId, run.id);
    assert.deepEqual(open[0]!.options, question.options);
    assert.equal(db.getThread(thread.id)!.state, "awaiting_user");
    assert.equal(results, 0, "completion cannot advance QA while owner input is pending");
    assert.equal(agent.finished, false);
    assert.equal(resumes.length, 0);
    assert.ok(!visible.join("\n").includes("ASK_USER:"), "transport JSON is removed from persisted chat");
    // Ordinary peer steering must queue behind the same answer gate.
    agent.send("Keep the scope small.");
    assert.equal(resumes.length, 0);
    manager.answerOwnerQuestion(open[0]!.id, "Cloud");
    await closed;
    assert.equal(db.getThread(thread.id)!.state, "implementing");
    assert.equal(db.listOpenQuestions().length, 0);
    assert.equal(results, 0, "the asking turn is superseded by the answer continuation");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]!.resume, agent.sessionId);
    assert.match(resumes[0]!.prompt, /Where are the credits.*Cloud/s);
    assert.match(resumes[0]!.prompt, /Keep the scope small/);
    // The resumed turn alone owns the final completion result.
    internal.turnActive = true;
    internal.pendingTerminalResult = { subtype: "success", isError: false, result: "Done" };
    await internal.onTurnClose(0);
    assert.equal(results, 1);
    assert.equal(agent.finished, true);
  }

  // Cancellation releases the run without resuming it when the outstanding chip is closed.
  {
    let answer!: (value: string) => void;
    const agent = new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", onAskUser: () => new Promise((resolve) => { answer = resolve; }) });
    const internal = agent as unknown as Internals;
    let resumed = false;
    internal.runTurn = async () => { resumed = true; };
    internal.turnActive = true;
    internal.handleEvent({ type: "item.completed", item: { type: "agent_message", text: marker } });
    const closed = internal.onTurnClose(0);
    await agent.stop();
    answer("(task cancelled)");
    await closed;
    assert.equal(resumed, false);
    assert.equal(agent.finished, true);
  }

  // Multiple chips stay held until the final answer, then restore the original role state.
  const t = db.createThread({ title: "Two questions", workspace: dir, rawPrompt: "Review" });
  db.updateThread(t.id, { state: "qa" });
  const first = manager.askUser({ ...question, threadId: t.id });
  const second = manager.askUser({ ...question, header: "Account", threadId: t.id });
  const open = db.listOpenQuestions();
  manager.answerOwnerQuestion(open[0]!.id, "Cloud");
  await first;
  assert.equal(db.getThread(t.id)!.state, "awaiting_user");
  manager.answerOwnerQuestion(open[1]!.id, "Test account");
  await second;
  assert.equal(db.getThread(t.id)!.state, "qa");
  assert.equal(events.filter((e) => e.type === "question.ask").length, 4);
  assert.equal(events.filter((e) => e.type === "question.resolved").length, 4);

  // Bridge errors are returned to the session, without an unhandled rejection or a fake answer.
  const replies: string[] = [];
  const gate = new CliQuestionGate(() => { throw new Error("storage unavailable"); }, (text) => replies.push(text));
  gate.submit(question);
  await gate.wait();
  assert.match(replies[0]!, /could not be posted.*storage unavailable/s);
  assert.equal(gate.waiting, false);
  console.log("CLI questions: Codex/Grok chips, completion holds, same-session answers, multi-chip state and bridge failure passed.");
} finally {
  for (const q of db.listOpenQuestions()) manager.resolveQuestion(q.id, "(test cleanup)");
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
