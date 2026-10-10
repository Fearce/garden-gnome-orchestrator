/** Bounded follow-up batching for CLI runners: queued office traffic must not overflow the provider's
 * input limit, omit owner/control input, or earn delivery receipts for text the model never received.
 * No model calls, child processes, or live data. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCHED_INPUT_BUDGET_CHARS, boundBatchedInput, CODEX_TURN_INPUT_MAX_CHARS, OWNER_STEERING_TAG } from "../agents/batchedInput.js";
import type { CliQuestionGate } from "../agents/cliQuestions.js";
import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import type { InputLedger } from "../agents/inputLedger.js";
import { CLI_QUESTION_DOCTRINE } from "../agents/prompts.js";
import type { UserContent } from "../agents/runner.js";
import { acknowledgedInjection, OWNER_STEERING_TAG as INJECTION_TAG, neutralizeSteeringMarkers } from "../orchestrator/injection.js";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// A real office push includes the communication policy, recent chat preview, and the new post.
const officePush = (i: number) =>
  `<ggo_communication_policy state="on">\n${"policy ".repeat(130)}\n</ggo_communication_policy>\n` +
  `[Recent office/team chat - context for this already scheduled turn]\n${"preview ".repeat(300)}\n` +
  `[Office - Teammate ${i} (implementor) posted to your project room] post #${i} ${"x".repeat(1200)}`;
const steering = acknowledgedInjection("Change the target to 500ms from 200ms.");
const ambientEntries = (count: number) => Array.from({ length: count }, (_, i) => ({ text: officePush(i), ambient: true }));

interface Internals {
  turnActive: boolean;
  isResumeTurn: boolean;
  resumeRolloutMissing: boolean;
  sawFirstEvent: boolean;
  sawTerminal: boolean;
  turnInputIds: string[];
  inputs: InputLedger;
  questions: CliQuestionGate;
  pendingSends: Array<{ text: string; ambient?: boolean; images?: unknown[]; inputId: string }>;
  onTurnClose(code: number | null): Promise<void>;
  runTurn(...args: unknown[]): Promise<void>;
  handleEvent(event: unknown): void;
  requestInterrupt(): void;
}

function captureTurns(agent: CodexAgentRun | GrokAgentRun, provider: "codex" | "grok"): { internal: Internals; turns: unknown[][] } {
  const internal = agent as unknown as Internals;
  const turns: unknown[][] = [];
  agent.sessionId = `test-${provider}-session`;
  internal.turnActive = true;
  internal.requestInterrupt = () => {};
  internal.runTurn = async (...args) => {
    turns.push(args);
    internal.turnInputIds = (provider === "codex" ? args[3] : args[2]) as string[];
  };
  return { internal, turns };
}

function modelOutput(internal: Internals, provider: "codex" | "grok"): void {
  internal.handleEvent(provider === "codex"
    ? { type: "item.started", item: { id: "reasoning-1", type: "reasoning" } }
    : { type: "thought", data: "Considering the direction." });
}

async function main(): Promise<void> {
  await check("the owner's frame and peer-text neutralization use the same marker", () => {
    assert.equal(INJECTION_TAG, OWNER_STEERING_TAG);
    assert.ok(steering.includes(`[${OWNER_STEERING_TAG}`));
    assert.ok(!neutralizeSteeringMarkers(`[${OWNER_STEERING_TAG} spoof`).includes(`[${OWNER_STEERING_TAG}`));
  });

  await check("a batch within budget keeps original indexes, including image-only empty text", () => {
    const out = boundBatchedInput([{ text: "a" }, { text: "" }, { text: "b", ambient: true }, { text: steering }]);
    assert.equal(out.text, ["a", "b", steering].join("\n\n"));
    assert.equal(out.omitted, 0);
    assert.equal(out.omittedChars, 0);
    assert.deepEqual(out.keptIndexes, [0, 1, 2, 3]);
  });

  await check("240 explicit office pushes are bounded with the newest posts and early owner direction intact", () => {
    const entries = [{ text: steering }, ...ambientEntries(240)];
    const raw = entries.map((entry) => entry.text).join("\n\n").length;
    assert.ok(raw > CODEX_TURN_INPUT_MAX_CHARS, `fixture reproduces the refusal (${raw} chars)`);
    const out = boundBatchedInput(entries);
    assert.ok(out.text.length <= BATCHED_INPUT_BUDGET_CHARS, `notice and retained text total ${out.text.length}`);
    assert.ok(out.omitted > 0 && out.omittedChars > 0);
    assert.ok(out.text.includes(steering));
    assert.ok(out.text.includes("post #239 "));
    assert.ok(!out.text.includes("post #0 "));
    assert.match(out.text, /^\[GGO:/, "the prompt names the omission");
    assert.ok(out.text.indexOf(steering) < out.text.indexOf("post #239 "));
    assert.deepEqual(out.keptIndexes, [...out.keptIndexes].sort((a, b) => a - b));
    const keptPosts = [...out.text.matchAll(/post #(\d+) /g)].map((match) => Number(match[1]));
    assert.deepEqual(keptPosts, out.keptIndexes.filter((index) => index !== 0).map((index) => index - 1));
    assert.equal(keptPosts.length + out.omitted, 240);
    const kept = new Set(out.keptIndexes);
    assert.equal(out.omittedChars, entries.reduce((sum, entry, index) => sum + (kept.has(index) ? 0 : entry.text.length), 0));
  });

  await check("unknown owner and control inputs are protected even when they exceed the ambient budget", () => {
    const huge = "Owner answered your question: " + "y".repeat(BATCHED_INPUT_BUDGET_CHARS + 10);
    const out = boundBatchedInput([{ text: officePush(1), ambient: true }, { text: huge }]);
    assert.ok(out.text.includes(huge), "untagged owner text stays verbatim");
    assert.equal(out.omitted, 1);
    assert.deepEqual(out.keptIndexes, [1]);
    const protectedOnly = boundBatchedInput([{ text: huge }]);
    assert.equal(protectedOnly.text, huge);
    assert.equal(protectedOnly.omitted, 0);
  });

  await check("owner frames and receipt-bearing messages survive mistaken ambient classification", () => {
    const receipt = "Required owner direction\n[GGO receipt IR-test-id]\nACK IR-test-id: apply this direction.";
    const out = boundBatchedInput([
      { text: steering, ambient: true },
      { text: receipt, ambient: true },
      ...ambientEntries(240),
    ]);
    assert.ok(out.omitted > 0);
    assert.ok(out.text.includes(steering));
    assert.ok(out.text.includes(receipt));
    assert.ok(out.keptIndexes.includes(0) && out.keptIndexes.includes(1));
  });

  await check("the exact-size boundary includes separators and permits the full batch without a notice", () => {
    const entries = [{ text: "a".repeat(498), ambient: true }, { text: "b".repeat(500), ambient: true }];
    const out = boundBatchedInput(entries, 1_000);
    assert.equal(out.text.length, 1_000);
    assert.equal(out.omitted, 0);
    assert.deepEqual(out.keptIndexes, [0, 1]);
  });

  await check("the omission notice itself fits the same budget as the newest retained update", () => {
    const out = boundBatchedInput([
      { text: "old " + "a".repeat(446), ambient: true },
      { text: "new " + "b".repeat(446), ambient: true },
    ], 900);
    assert.equal(out.omitted, 1);
    assert.ok(out.text.length <= 900, `notice must count toward the cap (${out.text.length})`);
    assert.ok(out.text.includes("new " + "b".repeat(446)));
    assert.deepEqual(out.keptIndexes, [1]);
  });

  await check("an almost-full required input stays valid when even the omission notice cannot fit", () => {
    const required = "r".repeat(999);
    const out = boundBatchedInput([{ text: required }, { text: officePush(1), ambient: true }], 1_000);
    assert.equal(out.text, required);
    assert.equal(out.omitted, 1, "the runner can still report the omission in the feed");
    assert.deepEqual(out.keptIndexes, [0]);
  });

  const dir = mkdtempSync(join(tmpdir(), "batched-input-"));
  try {
    for (const provider of ["codex", "grok"] as const) {
      await check(`${provider}: actual sends preserve questions, director input and controls; only retained ids earn receipts`, async () => {
        const onAskUser = async () => "Cloud";
        const agent = provider === "codex"
          ? new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", onAskUser })
          : new GrokAgentRun({ model: "grok-4.7", effort: "high", cwd: dir, onAskUser });
        const { internal, turns } = captureTurns(agent, provider);
        internal.questions.submit({ header: "Credits", question: "Which credits should this task use?", options: [], multiSelect: false });
        await internal.questions.wait();
        const protectedTexts = [
          steering,
          "Use the revised owner requirement before continuing.",
          "[Director (director) -> your team] Pause deployment until the review passes.",
          "[Owner direction queued] Change the Co-work target to 500ms.",
          "RI-abcdef01: Include the owner's new scope in your review.",
          "The deliverable was refused. Copy it into the task workspace before finishing.",
        ];
        protectedTexts.forEach((text, index) => agent.send(text, {
          priority: index === 2 ? "now" : "next",
          source: index === 2 ? "ambient" : undefined,
        }));
        for (const entry of ambientEntries(240)) agent.send(entry.text, { source: "ambient", priority: "next" });
        const batch = [...internal.pendingSends];
        const questionReply = batch[0]!;
        assert.match(questionReply.text, /Owner answered your question.*Cloud/s, "the real chip answer gate queues the reply");
        const expected = boundBatchedInput(batch);
        const expectedIds = expected.keptIndexes.map((index) => batch[index]!.inputId);
        const omittedIds = batch.filter((_, index) => !expected.keptIndexes.includes(index)).map((entry) => entry.inputId);
        assert.ok(omittedIds.length > 0, "the real send options classify expendable office entries");
        const callbacks = new Set<string>();
        for (const entry of batch) agent.onInputConsumed(entry.inputId, () => callbacks.add(entry.inputId));
        const visible: string[] = [];
        agent.onEvent((event) => { if (event.type === "text") visible.push(event.text); });
        await internal.onTurnClose(0);
        assert.equal(turns.length, 1);
        const prompt = turns[0]![0] as string;
        const ids = (provider === "codex" ? turns[0]![3] : turns[0]![2]) as string[];
        assert.equal(turns[0]![1], `test-${provider}-session`);
        assert.ok(prompt.length <= BATCHED_INPUT_BUDGET_CHARS);
        assert.ok(prompt.includes(questionReply.text));
        for (const text of protectedTexts) assert.ok(prompt.includes(text), `protected text is kept: ${text.slice(0, 80)}`);
        assert.ok(prompt.includes("post #239 ") && !prompt.includes("post #0 "));
        assert.deepEqual(ids, expectedIds, "dropped text cannot borrow the retained turn's delivery proof");
        assert.equal(callbacks.size, 0, "starting a turn is not delivery");
        modelOutput(internal, provider);
        assert.deepEqual([...callbacks], expectedIds, "only actual prompt inputs earn callbacks");
        for (const id of omittedIds) assert.ok(!internal.inputs.has(id), "omitted input stays unconsumed");
        for (const id of expectedIds) assert.ok(internal.inputs.has(id), "retained input is consumed on model output");
        assert.ok(visible.some((text) => text.includes("left out of the next")), "the task feed reports omissions");
      });

      await check(`${provider}: fresh recovery replays required inputs already drained into a failed resume`, async () => {
        const fallback = "Recovery brief before the owner's revised target.\n" + "f".repeat(500_000);
        const onAskUser = async () => "Cloud";
        const agent = provider === "codex"
          ? new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", freshFallback: fallback, onAskUser })
          : new GrokAgentRun({ model: "grok-4.7", effort: "high", cwd: dir, freshFallback: fallback, onAskUser });
        const { internal, turns } = captureTurns(agent, provider);
        const required = "Owner revised target: implement 500ms instead of 200ms.";
        agent.send(required);
        const originalId = agent.lastInputId!;
        for (const entry of ambientEntries(240)) agent.send(entry.text, { source: "ambient" });
        const originalBatch = [...internal.pendingSends];
        await internal.onTurnClose(0);
        assert.equal(turns.length, 1);
        assert.ok((turns[0]![0] as string).includes(required), "the queued input entered the resumed invocation");
        assert.equal(internal.pendingSends.length, 0, "the original input has left the pending queue");
        assert.ok(!internal.inputs.has(originalId), "a zero-event resume has no delivery proof");
        internal.isResumeTurn = true;
        internal.sawFirstEvent = false;
        internal.sawTerminal = false;
        internal.turnActive = true;
        const newer = "Owner answer while the resume fails: use the subscription balance.";
        agent.send(newer);
        const newerId = agent.lastInputId!;
        for (let i = 240; i < 480; i++) agent.send(officePush(i), { source: "ambient" });
        const newerBatch = [...internal.pendingSends];
        const callbacks = new Set<string>();
        const results: unknown[] = [];
        const allEntries = [...originalBatch, ...newerBatch];
        for (const entry of allEntries) agent.onInputConsumed(entry.inputId, () => callbacks.add(entry.inputId));
        agent.onEvent((event) => { if (event.type === "result") results.push(event); });
        await internal.onTurnClose(1);
        assert.equal(turns.length, 2);
        assert.equal(turns[1]![1], undefined, "the wedged resume recovers fresh");
        const recovered = turns[1]![0] as string;
        assert.ok(recovered.startsWith(fallback));
        assert.ok(recovered.includes(required), "unconsumed required input must survive fresh recovery");
        assert.ok(recovered.includes(newer), "a newer owner answer survives the same recovery");
        assert.ok(recovered.indexOf(required) < recovered.indexOf(newer), "original and newer direction retain arrival order");
        assert.ok(recovered.includes("post #479 ") && !recovered.includes("post #0 "), "recovery favors newest ambient state");
        const withDoctrine = `${CLI_QUESTION_DOCTRINE}\n\n${recovered}`;
        assert.ok(withDoctrine.length <= (provider === "codex" ? CODEX_TURN_INPUT_MAX_CHARS : BATCHED_INPUT_BUDGET_CHARS), "recovery reserves fallback and question doctrine before selecting ambient input");
        const ids = turns[1]![provider === "codex" ? 3 : 2] as string[];
        assert.ok(ids.includes(originalId) && ids.includes(newerId));
        const omittedIds = allEntries.filter((entry) => !ids.includes(entry.inputId)).map((entry) => entry.inputId);
        assert.ok(omittedIds.length > 0, "the two ambient queues must be trimmed together");
        const retainedPosts = new Set([...recovered.matchAll(/post #(\d+) /g)].map((match) => match[1]));
        for (const entry of allEntries) {
          if (entry.ambient) assert.equal(ids.includes(entry.inputId), retainedPosts.has(entry.text.match(/post #(\d+) /)![1]), "only replayed ambient text carries a receipt ID");
        }
        assert.ok(!internal.inputs.has(originalId), "restarting still is not delivery");
        assert.equal(callbacks.size, 0);
        assert.equal(results.length, 0, "the failed resume cannot terminate the task before recovery");
        modelOutput(internal, provider);
        assert.ok(internal.inputs.has(originalId), "replayed text earns its original receipt on model output");
        assert.deepEqual([...callbacks], ids);
        for (const id of omittedIds) assert.ok(!internal.inputs.has(id), "discarded ambient input cannot borrow recovery's proof");
      });

      await check(`${provider}: an idle owner send keeps its text and original receipt through recovery`, async () => {
        const agent = provider === "codex"
          ? new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", freshFallback: "Recovery brief" })
          : new GrokAgentRun({ model: "grok-4.7", effort: "high", cwd: dir, freshFallback: "Recovery brief" });
        const { internal, turns } = captureTurns(agent, provider);
        internal.turnActive = false;
        const direction = "Owner direction while idle: use the revised target.";
        agent.send(direction);
        const inputId = agent.lastInputId!;
        assert.equal(turns.length, 1);
        assert.equal(internal.pendingSends.length, 0);
        internal.isResumeTurn = true;
        internal.sawFirstEvent = false;
        await internal.onTurnClose(1);
        assert.equal(turns.length, 2);
        assert.ok((turns[1]![0] as string).includes(direction));
        assert.deepEqual(turns[1]![provider === "codex" ? 3 : 2], [inputId]);
        modelOutput(internal, provider);
        assert.ok(internal.inputs.has(inputId));
      });
    }

    await check("Codex initial-resume recovery keeps an image-only kickoff without duplicating its attachment", async () => {
      const agent = new CodexAgentRun({
        model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", resume: "missing-session", freshFallback: "Recovery brief",
      });
      const { internal, turns } = captureTurns(agent, "codex");
      const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
      agent.start([image] as UserContent);
      const inputId = agent.lastInputId!;
      assert.equal(turns.length, 1);
      internal.isResumeTurn = true;
      internal.sawFirstEvent = false;
      await internal.onTurnClose(1);
      assert.equal(turns.length, 2);
      assert.deepEqual(turns[1]![2], [{ mediaType: "image/png", dataBase64: "AA==" }]);
      assert.deepEqual(turns[1]![3], [inputId]);
      assert.ok(!internal.inputs.has(inputId));
      modelOutput(internal, "codex");
      assert.ok(internal.inputs.has(inputId));
    });

    await check("Codex retains image-only and text-plus-image owner sends even if marked ambient", async () => {
      const agent = new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", freshFallback: "Recovery kickoff" });
      const { internal, turns } = captureTurns(agent, "codex");
      const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
      agent.send([image] as UserContent, { source: "ambient" });
      const imageOnlyId = agent.lastInputId!;
      const caption = "Use this owner's screenshot to fix the target.";
      agent.send([{ type: "text", text: caption }, image] as UserContent, { source: "ambient" });
      const captionId = agent.lastInputId!;
      for (const entry of ambientEntries(240)) agent.send(entry.text, { source: "ambient" });
      await internal.onTurnClose(0);
      assert.equal(turns.length, 1);
      assert.ok((turns[0]![0] as string).includes(caption));
      assert.deepEqual(turns[0]![2], [
        { mediaType: "image/png", dataBase64: "AA==" },
        { mediaType: "image/png", dataBase64: "AA==" },
      ]);
      const ids = turns[0]![3] as string[];
      assert.ok(ids.includes(imageOnlyId) && ids.includes(captionId));
      internal.isResumeTurn = true;
      internal.sawFirstEvent = false;
      internal.sawTerminal = false;
      await internal.onTurnClose(1);
      assert.equal(turns.length, 2);
      assert.equal(turns[1]![1], undefined);
      assert.ok((turns[1]![0] as string).includes(caption));
      assert.deepEqual(turns[1]![2], turns[0]![2], "both drained screenshot attachments survive fresh recovery");
      const recoveredIds = turns[1]![3] as string[];
      assert.ok(recoveredIds.includes(imageOnlyId) && recoveredIds.includes(captionId));
      assert.ok(!internal.inputs.has(imageOnlyId) && !internal.inputs.has(captionId));
      modelOutput(internal, "codex");
      assert.ok(internal.inputs.has(imageOnlyId) && internal.inputs.has(captionId));
    });

    await check("Codex keeps the kickoff and its images when queued steering follows an exit before thread.started", async () => {
      const agent = new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "" });
      const { internal, turns } = captureTurns(agent, "codex");
      agent.sessionId = undefined;
      const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
      const kickoff = "Kickoff brief: fix the attached reminder badge.\n" + "k".repeat(500_000);
      agent.start([{ type: "text", text: kickoff }, image] as UserContent);
      const kickoffId = agent.lastInputId!;
      agent.send(steering, { priority: "now" });
      const steeringId = agent.lastInputId!;
      for (const entry of ambientEntries(240)) agent.send(entry.text, { source: "ambient" });
      await internal.onTurnClose(1);
      assert.equal(turns.length, 2);
      assert.equal(turns[1]![1], undefined, "without a thread id the queued turn must start fresh");
      const prompt = turns[1]![0] as string;
      assert.ok(prompt.includes(kickoff), "the original task must survive the startup failure");
      assert.ok(prompt.includes(steering) && prompt.length <= BATCHED_INPUT_BUDGET_CHARS);
      assert.ok(prompt.indexOf(kickoff) < prompt.indexOf(steering), "the task and steering retain arrival order");
      assert.deepEqual(turns[1]![2], [{ mediaType: "image/png", dataBase64: "AA==" }]);
      const ids = turns[1]![3] as string[];
      assert.ok(ids.includes(kickoffId) && ids.includes(steeringId));
      assert.ok(!internal.inputs.has(kickoffId) && !internal.inputs.has(steeringId));
      modelOutput(internal, "codex");
      assert.ok(internal.inputs.has(kickoffId) && internal.inputs.has(steeringId));
    });

    await check("Codex steering that interrupts a new session before its rollout exists restarts from the run's own kickoff", async () => {
      // Task 30f120db (2026-10-09): an inject 1.5s into a fresh Codex run resumed a thread whose rollout
      // was not written yet; with no freshFallback the run failed and the task left Codex for Claude.
      const agent = new CodexAgentRun({ model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "" });
      const { internal, turns } = captureTurns(agent, "codex");
      agent.sessionId = undefined;
      agent.start("Kickoff brief: add the reminder badge.");
      const kickoffId = agent.lastInputId!;
      assert.equal(turns[0]![1], undefined, "the kickoff starts a fresh session");
      agent.sessionId = "test-codex-session";
      internal.turnActive = true;
      agent.send("Owner steering: also show which reminder raised the badge.", { priority: "now" });
      const steeringId = agent.lastInputId!;
      await internal.onTurnClose(null);
      assert.equal(turns[1]![1], "test-codex-session", "the steering resumes the new session");
      const results: unknown[] = [];
      agent.onEvent((event) => { if (event.type === "result") results.push(event); });
      internal.isResumeTurn = true;
      internal.resumeRolloutMissing = true;
      internal.sawFirstEvent = false;
      internal.turnActive = true;
      await internal.onTurnClose(1);
      assert.equal(turns.length, 3, "the missing rollout is recovered, not reported as a failure");
      assert.equal(turns[2]![1], undefined, "recovery starts fresh");
      const prompt = turns[2]![0] as string;
      assert.ok(prompt.indexOf("Kickoff brief") === 0 && prompt.includes("Owner steering"), prompt);
      assert.deepEqual(turns[2]![3], [kickoffId, steeringId], "kickoff and steering keep their receipts");
      assert.equal(results.length, 0);
    });

    await check("Codex fresh recovery reserves the actual fallback and question doctrine before keeping ambient sends", async () => {
      const fallback = "Full recovery brief\n" + "f".repeat(500_000);
      const agent = new CodexAgentRun({
        model: "gpt-6.1-sol", effort: "high", cwd: dir, apiKey: "", freshFallback: fallback, onAskUser: async () => "Cloud",
      });
      const { internal, turns } = captureTurns(agent, "codex");
      internal.isResumeTurn = true;
      internal.resumeRolloutMissing = true;
      agent.send(steering);
      const steeringId = agent.lastInputId!;
      for (const entry of ambientEntries(240)) agent.send(entry.text, { source: "ambient" });
      const batch = [...internal.pendingSends];
      await internal.onTurnClose(0);
      assert.equal(turns.length, 1);
      assert.equal(turns[0]![1], undefined, "a missing rollout recovers fresh");
      const prompt = turns[0]![0] as string;
      const withDoctrine = prompt.includes(CLI_QUESTION_DOCTRINE) ? prompt : `${CLI_QUESTION_DOCTRINE}\n\n${prompt}`;
      assert.ok(withDoctrine.length <= CODEX_TURN_INPUT_MAX_CHARS, `combined recovery input is ${withDoctrine.length} chars`);
      assert.ok(prompt.startsWith(fallback), "the full recovery brief stays verbatim");
      assert.ok(prompt.includes(steering));
      assert.ok(prompt.includes("post #239 ") && !prompt.includes("post #0 "));
      const ids = turns[0]![3] as string[];
      assert.ok(ids.includes(steeringId));
      const omittedIds = batch.filter((entry) => !ids.includes(entry.inputId)).map((entry) => entry.inputId);
      assert.ok(omittedIds.length > 0);
      modelOutput(internal, "codex");
      assert.ok(internal.inputs.has(steeringId));
      for (const id of omittedIds) assert.ok(!internal.inputs.has(id));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nall ${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
