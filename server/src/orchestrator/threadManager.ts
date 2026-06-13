import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import { AgentRun } from "../agents/runner.js";
import { implementorConfig, plannerConfig, researcherConfig } from "../agents/roles.js";
import { createBusServer } from "../bus/busServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { config } from "../config.js";
import type {
  AgentEvent,
  Finding,
  PlanOutput,
  ResearchOutput,
  Role,
  Thread,
} from "../types.js";
import type {
  AskUserInput,
  DispatchInput,
  OrchestratorApi,
  PostFindingInput,
  ThreadActionResult,
} from "./api.js";

interface LiveImplementor {
  run: AgentRun;
  runId: string;
}

const MAX_RESULT_PREVIEW = 600;
const QUESTION_TIMEOUT_MS = 20 * 60 * 1000;

export class ThreadManager implements OrchestratorApi {
  private readonly live = new Map<string, LiveImplementor>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  private readonly lastImplementorSession = new Map<string, string>();
  private readonly stopping = new Set<string>();

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    readonly memory: MemoryService,
  ) {}

  // ---- OrchestratorApi: reads ----

  listThreads(): Thread[] {
    return this.db.listThreads();
  }
  getThread(id: string): Thread | null {
    return this.db.getThread(id);
  }

  // ---- clarifying questions ----

  askUser(input: AskUserInput): Promise<string> {
    const q = this.db.addQuestion({
      threadId: input.threadId,
      runId: input.runId ?? null,
      header: input.header,
      question: input.question,
      options: input.options,
      multiSelect: input.multiSelect,
    });
    this.hub.publish({ type: "question.ask", question: q });
    // Resolve (never reject) after a bound so an unanswered question can't wedge
    // the director's streaming turn for the whole CLAUDE_CODE_STREAM_CLOSE_TIMEOUT.
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingQuestions.has(q.id)) return;
        this.pendingQuestions.delete(q.id);
        this.db.answerQuestion(q.id, "(no answer — timed out)");
        this.hub.publish({ type: "question.resolved", questionId: q.id, answer: "(timed out)" });
        resolve("(the user did not answer this in time — proceed using your best judgment, and ask again only if essential.)");
      }, QUESTION_TIMEOUT_MS);
      this.pendingQuestions.set(q.id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  resolveQuestion(questionId: string, answer: string): boolean {
    const resolver = this.pendingQuestions.get(questionId);
    this.db.answerQuestion(questionId, answer);
    this.hub.publish({ type: "question.resolved", questionId, answer });
    if (resolver) {
      this.pendingQuestions.delete(questionId);
      resolver(answer);
      return true;
    }
    return false;
  }

  // ---- dispatch + pipeline ----

  async dispatch(input: DispatchInput): Promise<string> {
    const thread = this.db.createThread({
      title: input.title,
      workspace: input.workspace,
      rawPrompt: "",
      brief: input.brief,
    });
    this.hub.publish({ type: "thread.upsert", thread });
    this.hub.log("info", `Dispatched task ${thread.id.slice(0, 8)} "${thread.title}"`);
    void this.runPipeline(thread.id);
    return thread.id;
  }

  private setState(threadId: string, state: Thread["state"], error?: string | null): void {
    const t = this.db.updateThread(threadId, { state, error: error ?? null });
    if (t) this.hub.publish({ type: "thread.upsert", thread: t });
  }

  private async runPipeline(threadId: string): Promise<void> {
    const thread = this.db.getThread(threadId);
    if (!thread) return;
    try {
      this.setState(threadId, "planning");
      const [plan, research] = await Promise.all([
        this.runPlanner(thread).catch((e) => {
          this.hub.log("warn", `Planner failed on ${threadId.slice(0, 8)}: ${String(e)}`);
          return undefined;
        }),
        this.runResearcher(thread).catch((e) => {
          this.hub.log("warn", `Researcher failed on ${threadId.slice(0, 8)}: ${String(e)}`);
          return undefined;
        }),
      ]);

      const current = this.db.getThread(threadId);
      if (!current || current.state === "cancelled") return;

      const kickoff = composeKickoff(thread, plan, research);
      await this.startImplementor(thread, kickoff);
    } catch (err) {
      this.setState(threadId, "failed", err instanceof Error ? err.message : String(err));
    }
  }

  private async runPlanner(thread: Thread): Promise<PlanOutput | undefined> {
    const run = this.db.createRun({ threadId: thread.id, role: "planner", model: config.models.planner });
    this.emitRun(run.id);
    const bus = createBusServer(this, { threadId: thread.id, role: "planner", getRunId: () => run.id });
    const agent = new AgentRun(plannerConfig(thread.workspace, { bus }));
    this.wireRun(agent, thread.id, run.id, "planner");
    agent.start(thread.brief);
    const res = await agent.result();
    await agent.stop();
    this.db.updateRun(run.id, {
      state: res?.isError ? "error" : "done",
      endedAt: Date.now(),
      costUsd: res?.costUsd ?? null,
      numTurns: res?.numTurns ?? null,
      sessionId: agent.sessionId ?? null,
    });
    this.emitRun(run.id);
    return res?.structuredOutput as PlanOutput | undefined;
  }

  private async runResearcher(thread: Thread): Promise<ResearchOutput | undefined> {
    const run = this.db.createRun({ threadId: thread.id, role: "researcher", model: config.models.researcher });
    this.emitRun(run.id);
    const bus = createBusServer(this, { threadId: thread.id, role: "researcher", getRunId: () => run.id });
    const memory = createMemoryServer(this.memory);
    const agent = new AgentRun(researcherConfig(thread.workspace, { bus, memory }));
    this.wireRun(agent, thread.id, run.id, "researcher");
    agent.start(thread.brief);
    const res = await agent.result();
    await agent.stop();
    this.db.updateRun(run.id, {
      state: res?.isError ? "error" : "done",
      endedAt: Date.now(),
      costUsd: res?.costUsd ?? null,
      numTurns: res?.numTurns ?? null,
      sessionId: agent.sessionId ?? null,
    });
    this.emitRun(run.id);
    return res?.structuredOutput as ResearchOutput | undefined;
  }

  private async startImplementor(thread: Thread, kickoff: string, opts?: { resume?: string }): Promise<void> {
    this.setState(thread.id, "implementing");
    const run = this.db.createRun({ threadId: thread.id, role: "implementor", model: config.models.implementor });
    this.emitRun(run.id);
    const bus = createBusServer(this, { threadId: thread.id, role: "implementor", getRunId: () => run.id });
    const agent = new AgentRun(implementorConfig(thread.workspace, { bus }, opts));
    this.wireRun(agent, thread.id, run.id, "implementor");
    this.live.set(thread.id, { run: agent, runId: run.id });

    agent.onEnd(() => {
      this.live.delete(thread.id);
      if (this.stopping.has(thread.id)) {
        this.stopping.delete(thread.id);
        return; // deliberate teardown (cancel) sets the terminal state itself
      }
      const cur = this.db.getThread(thread.id);
      if (cur && cur.state !== "cancelled" && cur.state !== "review" && cur.state !== "done") {
        this.setState(thread.id, "done");
      }
    });

    // When the implementor finishes a turn (a result), move to review but keep
    // the session alive so the director / the user can inject follow-ups.
    const off = agent.onEvent((e: AgentEvent) => {
      if (e.type === "result") {
        if (agent.sessionId) this.lastImplementorSession.set(thread.id, agent.sessionId);
        const cur = this.db.getThread(thread.id);
        if (cur && cur.state === "implementing") this.setState(thread.id, "review");
      }
    });
    void off;

    agent.start(kickoff);
  }

  // ---- live thread controls ----

  async injectThread(threadId: string, message: string, mode: "append" | "interrupt"): Promise<ThreadActionResult> {
    const live = this.live.get(threadId);
    if (live) {
      if (mode === "interrupt") {
        await live.run.interrupt();
        this.setState(threadId, "implementing");
      }
      live.run.send(`[New information from the director]\n${message}`, mode === "interrupt" ? { priority: "now" } : undefined);
      this.db.addMessage({ threadId, role: "director", kind: "system", content: `inject(${mode}): ${message}` });
      this.hub.log("info", `Injected (${mode}) into ${threadId.slice(0, 8)}`);
      return { ok: true, state: "implementing" };
    }
    // No live implementor — resume the session with the message.
    return this.resumeThread(threadId, message);
  }

  async interruptThread(threadId: string): Promise<ThreadActionResult> {
    const live = this.live.get(threadId);
    if (!live) return { ok: false, error: "No running implementor on that task." };
    await live.run.interrupt();
    this.setState(threadId, "paused");
    return { ok: true, state: "paused" };
  }

  async resumeThread(threadId: string, message?: string): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    const live = this.live.get(threadId);
    if (live) {
      live.run.send(message ?? "Continue.", { priority: "now" });
      this.setState(threadId, "implementing");
      return { ok: true, state: "implementing" };
    }
    const resume = this.lastImplementorSession.get(threadId);
    const kickoff = message ?? "Continue where you left off.";
    await this.startImplementor(thread, kickoff, resume ? { resume } : undefined);
    return { ok: true, state: "implementing" };
  }

  async cancelThread(threadId: string): Promise<ThreadActionResult> {
    const live = this.live.get(threadId);
    if (live) {
      this.stopping.add(threadId);
      await live.run.stop();
      this.live.delete(threadId);
    }
    this.setState(threadId, "cancelled");
    return { ok: true, state: "cancelled" };
  }

  // ---- findings + routing ----

  postFinding(input: PostFindingInput): Finding {
    const finding = this.db.addFinding(input);
    this.hub.publish({ type: "finding", finding });
    this.route(finding);
    return finding;
  }

  private route(finding: Finding): void {
    const live = this.live.get(finding.threadId);
    if (!live) return;
    // Never re-inject a finding the live implementor posted itself.
    if (finding.fromRunId && finding.fromRunId === live.runId) return;
    if (finding.severity === "critical") {
      void this.injectThread(
        finding.threadId,
        `${finding.summary}${finding.detail ? `\n${finding.detail}` : ""}`,
        "interrupt",
      );
      this.db.markFindingRouted(finding.id);
    } else if (finding.severity === "warning") {
      live.run.send(`[Heads-up finding] ${finding.summary}${finding.detail ? `\n${finding.detail}` : ""}`, {
        priority: "next",
      });
      this.db.markFindingRouted(finding.id);
    }
  }

  // ---- run event wiring ----

  private emitRun(runId: string): void {
    const run = this.db.getRun(runId);
    if (run) this.hub.publish({ type: "run.upsert", run });
  }

  private wireRun(agent: AgentRun, threadId: string, runId: string, role: Role): void {
    const off = agent.onEvent((e: AgentEvent) => {
      switch (e.type) {
        case "init":
          this.db.updateRun(runId, { sessionId: e.sessionId, state: "running" });
          this.emitRun(runId);
          break;
        case "text_delta":
          this.hub.publish({ type: "agent.delta", threadId, runId, role, text: e.text });
          break;
        case "thinking_delta":
          this.hub.publish({ type: "agent.thinking", threadId, runId, role, text: e.text });
          break;
        case "text":
          this.db.addMessage({ threadId, runId, role, kind: "text", content: e.text });
          this.hub.publish({ type: "agent.text", threadId, runId, role, text: e.text });
          break;
        case "tool_use":
          this.db.addMessage({ threadId, runId, role, kind: "tool", content: `${e.name} ${safeJson(e.input)}` });
          this.hub.publish({ type: "agent.tool", threadId, runId, role, name: e.name, input: e.input, id: e.id });
          break;
        case "tool_result":
          this.hub.publish({
            type: "agent.tool_result",
            threadId,
            runId,
            id: e.id,
            isError: e.isError,
            preview: preview(e.content),
          });
          break;
        case "result":
          this.db.updateRun(runId, {
            costUsd: e.costUsd ?? null,
            numTurns: e.numTurns ?? null,
            state: e.isError ? "error" : "idle",
          });
          this.emitRun(runId);
          break;
        case "error":
          this.db.updateRun(runId, { state: "error", error: e.message });
          this.emitRun(runId);
          this.hub.log("error", `${role} on ${threadId.slice(0, 8)}: ${e.message}`);
          break;
        default:
          break;
      }
    });
    agent.onEnd(() => off());
  }
}

function composeKickoff(thread: Thread, plan: PlanOutput | undefined, research: ResearchOutput | undefined): string {
  const parts: string[] = [`# Task: ${thread.title}`, "", "## Brief", thread.brief, ""];

  parts.push("## Plan (from the planner)");
  if (plan) {
    parts.push(plan.summary, "");
    parts.push("Steps:");
    plan.steps.forEach((s, i) => {
      const files = s.files?.length ? ` [files: ${s.files.join(", ")}]` : "";
      parts.push(`${i + 1}. ${s.title} — ${s.detail}${files}`);
    });
    if (plan.risks.length) parts.push("", `Risks: ${plan.risks.join("; ")}`);
    if (plan.openQuestions.length) parts.push(`Open questions: ${plan.openQuestions.join("; ")}`);
  } else {
    parts.push("(planner produced no structured plan — proceed from the brief and your own analysis)");
  }
  parts.push("");

  parts.push("## Research (from the researcher)");
  if (research) {
    parts.push(research.summary, "");
    if (research.relevantFiles.length) {
      parts.push("Relevant files:");
      research.relevantFiles.forEach((f) => parts.push(`- ${f.path} — ${f.why}`));
    }
    if (research.facts.length) {
      parts.push("Key facts:");
      research.facts.forEach((f) => parts.push(`- ${f.claim}${f.source ? ` (${f.source})` : ""}`));
    }
    if (research.memories.length) {
      parts.push("Relevant memory:");
      research.memories.forEach((m) => parts.push(`- ${m.name} — ${m.gist}`));
    }
    if (research.warnings.length) parts.push("Warnings: " + research.warnings.join("; "));
  } else {
    parts.push("(researcher produced no structured brief — gather any context you need yourself)");
  }
  parts.push("");
  parts.push("Implement this now, completely, at high effort. Post findings as you go. When done, commit and push per the doctrine.");
  return parts.join("\n");
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(v);
  }
}

function preview(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : safeJson(b)))
      .join(" ");
  } else s = safeJson(content);
  return s.length > MAX_RESULT_PREVIEW ? s.slice(0, MAX_RESULT_PREVIEW) + "…" : s;
}
