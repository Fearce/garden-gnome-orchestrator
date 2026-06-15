import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import { AgentRun, type AgentRunConfig } from "../agents/runner.js";
import { implementorConfig, plannerConfig, qaConfig, researcherConfig } from "../agents/roles.js";
import { createBusServer } from "../bus/busServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { config } from "../config.js";
import { execFile } from "node:child_process";
import { contentWithImages, toImageBlock, type ImageBlock } from "../attachments.js";
import type {
  AgentEvent,
  Effort,
  Finding,
  ImageAttachment,
  PlanOutput,
  QaOutput,
  RateLimitInfo,
  ResearchOutput,
  Role,
  Thread,
} from "../types.js";

type ResultEvent = Extract<AgentEvent, { type: "result" }>;
type Acct = { id: string; label: string; token: string | undefined };
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
  accountId: string;
}

const MAX_RESULT_PREVIEW = 600;
const QUESTION_TIMEOUT_MS = 20 * 60 * 1000;
// On a mid-run 5h/weekly cap, relaunch on another account (resuming the session) up to N times.
const MAX_ACCOUNT_FAILOVERS = 3;
const IN_FLIGHT: ReadonlySet<Thread["state"]> = new Set([
  "intake",
  "enriching",
  "awaiting_user",
  "planning",
  "researching",
  "implementing",
  "qa",
  "paused",
]);

export class ThreadManager implements OrchestratorApi {
  private readonly live = new Map<string, LiveImplementor>();
  private readonly activeRuns = new Map<string, Set<AgentRun>>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  private readonly awaitingPrev = new Map<string, Thread["state"]>();
  private readonly lastImplementorSession = new Map<string, string>();
  private readonly stopping = new Set<string>();
  private readonly threadImages = new Map<string, ImageBlock[]>();
  private readonly pendingApprovals = new Map<string, (d: { approved: boolean; feedback?: string }) => void>();

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    readonly memory: MemoryService,
    readonly accounts: AccountManager,
  ) {
    this.markInterrupted();
  }

  /** Any task left mid-flight by a server restart is dead in memory — fail it. */
  private markInterrupted(): void {
    for (const t of this.db.listThreads()) {
      if (IN_FLIGHT.has(t.state)) {
        this.db.updateThread(t.id, { state: "failed", error: "interrupted by server restart — re-dispatch to retry" });
      }
    }
  }

  private dispatchAccount(): Acct {
    const { account } = this.accounts.select();
    return { id: account.id, label: account.label, token: account.token || undefined };
  }

  /** A usable account other than `excludeId` for failover, or null if none has headroom. */
  private failoverAccount(excludeId: string): Acct | null {
    const a = this.accounts.selectFailover(excludeId);
    return a ? { id: a.id, label: a.label, token: a.token || undefined } : null;
  }

  private logFailover(thread: Thread, role: Role, toLabel: string, info?: RateLimitInfo): void {
    const win = info?.rateLimitType ?? "usage";
    this.hub.log("warn", `${role} on "${thread.title.slice(0, 48)}" hit the ${win} limit — auto-switched account → ${toLabel}, resuming the session.`);
    this.notifyExternal(`↪ ${role} hit a ${win} limit mid-task — auto-switched to ${toLabel}, continuing "${thread.title}".`);
  }

  private track(threadId: string, agent: AgentRun): void {
    let set = this.activeRuns.get(threadId);
    if (!set) {
      set = new Set();
      this.activeRuns.set(threadId, set);
    }
    set.add(agent);
  }
  private untrack(threadId: string, agent: AgentRun): void {
    this.activeRuns.get(threadId)?.delete(agent);
  }

  // ---- OrchestratorApi: reads ----

  listThreads(): Thread[] {
    return this.db.listThreads();
  }
  getThread(id: string): Thread | null {
    return this.db.getThread(id);
  }

  // ---- questions (clarify / blockers) ----

  askUser(input: AskUserInput): Promise<string> {
    const q = this.db.addQuestion({
      threadId: input.threadId,
      runId: input.runId ?? null,
      header: input.header,
      question: input.question,
      options: input.options,
      multiSelect: input.multiSelect,
    });
    // A task-scoped question pauses the task into awaiting_user; restore on answer.
    if (input.threadId) {
      const t = this.db.getThread(input.threadId);
      if (t && t.state !== "awaiting_user") {
        this.awaitingPrev.set(q.id, t.state);
        this.setState(input.threadId, "awaiting_user");
      }
    }
    this.notifyExternal(`🔔 needs you: ${input.header} — ${input.question}`);
    this.hub.publish({ type: "question.ask", question: q });
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingQuestions.has(q.id)) return;
        this.pendingQuestions.delete(q.id);
        this.db.answerQuestion(q.id, "(no answer — timed out)");
        this.hub.publish({ type: "question.resolved", questionId: q.id, answer: "(timed out)" });
        this.restoreAfterQuestion(q.id);
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
    this.restoreAfterQuestion(questionId);
    if (resolver) {
      this.pendingQuestions.delete(questionId);
      resolver(answer);
      return true;
    }
    return false;
  }

  private restoreAfterQuestion(questionId: string): void {
    const prev = this.awaitingPrev.get(questionId);
    if (prev === undefined) return;
    this.awaitingPrev.delete(questionId);
    const q = this.db.getQuestion(questionId);
    if (q?.threadId) {
      const t = this.db.getThread(q.threadId);
      if (t && t.state === "awaiting_user") this.setState(q.threadId, prev);
    }
  }

  // ---- dispatch + pipeline ----

  async dispatch(input: DispatchInput): Promise<string> {
    const thread = this.db.createThread({ title: input.title, workspace: input.workspace, rawPrompt: "", brief: input.brief });
    if (input.images?.length) this.threadImages.set(thread.id, input.images.map(toImageBlock));
    this.hub.publish({ type: "thread.upsert", thread });
    this.hub.log("info", `Dispatched task ${thread.id.slice(0, 8)} "${thread.title}"`);
    void this.runPipeline(thread.id);
    return thread.id;
  }

  /** Wrap a role's kickoff text with the thread's pasted images so each isolated agent sees them. */
  private kickoffContent(threadId: string, text: string): string | unknown[] {
    return contentWithImages(text, this.threadImages.get(threadId) ?? []);
  }

  approvalMode(): boolean {
    return this.db.kvGet("require_plan_approval") === "1";
  }

  setApprovalMode(on: boolean): void {
    this.db.kvSet("require_plan_approval", on ? "1" : "0");
    this.hub.publish({ type: "approval.mode", on });
  }

  private waitForApproval(threadId: string): Promise<{ approved: boolean; feedback?: string }> {
    return new Promise((resolve) => this.pendingApprovals.set(threadId, resolve));
  }

  /** Resolve an awaiting_approval thread; false if it wasn't waiting. */
  approvePlan(threadId: string, approved: boolean, feedback?: string): boolean {
    const resolve = this.pendingApprovals.get(threadId);
    if (!resolve) return false;
    this.pendingApprovals.delete(threadId);
    resolve({ approved, feedback });
    return true;
  }

  /** git diff + recent log of a thread's workspace, for in-GUI change review. */
  async getChanges(threadId: string): Promise<{ diff: string; log: string }> {
    const t = this.db.getThread(threadId);
    if (!t) return { diff: "", log: "(no such task)" };
    const run = (args: string[]): Promise<string> =>
      new Promise((res) =>
        execFile("git", ["-C", t.workspace, "--no-pager", ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
          res(stdout || stderr || (err ? err.message : "")),
        ),
      );
    const [diff, log] = await Promise.all([run(["diff"]), run(["log", "--oneline", "-10"])]);
    return { diff: diff.trim() || "(no uncommitted changes)", log: log.trim() || "(no commits / not a git repo)" };
  }

  private setState(threadId: string, state: Thread["state"], error?: string | null): void {
    const t = this.db.updateThread(threadId, { state, error: error ?? null });
    if (!t) return;
    this.hub.publish({ type: "thread.upsert", thread: t });
    if (state === "done") this.notifyExternal(`✓ done: "${t.title}"`);
    else if (state === "review") this.notifyExternal(`⚠ needs your review: "${t.title}"`);
    else if (state === "failed") this.notifyExternal(`✗ failed: "${t.title}"${t.error ? ` — ${t.error}` : ""}`);
  }

  /** One-line ping to an external webhook (Discord etc.) when configured — for when you're away from the tab. */
  private notifyExternal(text: string): void {
    const url = config.notifyWebhookUrl;
    if (!url) return;
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `[orchestrator] ${text}` }),
    }).catch(() => {});
  }

  private cancelled(threadId: string): boolean {
    return this.db.getThread(threadId)?.state === "cancelled";
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
      if (this.cancelled(threadId)) return;
      const kickoff = composeKickoff(thread, plan, research);
      if (this.approvalMode()) {
        this.setState(threadId, "awaiting_approval");
        this.hub.publish({ type: "plan.ready", threadId, brief: kickoff });
        const decision = await this.waitForApproval(threadId);
        if (this.cancelled(threadId)) return;
        if (!decision.approved) {
          this.postFinding({
            threadId,
            fromRole: "planner",
            summary: `Plan rejected${decision.feedback ? `: ${decision.feedback}` : ""}`,
            severity: "warning",
          });
          this.setState(threadId, "review", decision.feedback ? `Plan rejected: ${decision.feedback}` : "Plan rejected.");
          return;
        }
      }
      await this.runImplementorQa(thread, kickoff, plan?.effort);
    } catch (err) {
      if (!this.cancelled(threadId)) this.setState(threadId, "failed", err instanceof Error ? err.message : String(err));
    } finally {
      // Every role's kickoff has been built by now; free the base64 blocks. A live
      // implementor still remembers them, and a later resume reloads them from its
      // session, so dropping them here doesn't blind anything.
      this.threadImages.delete(threadId);
    }
  }

  /** Run a one-shot role (planner/researcher/qa) to a result. If its account hits a 5h/weekly
   *  cap mid-run, relaunch on another account resuming the session — transparently. */
  private async runRole(
    thread: Thread,
    role: "planner" | "researcher" | "qa",
    model: string,
    kickoff: string | unknown[],
    makeCfg: (ctx: { token: string | undefined; resume?: string; runId: string }) => AgentRunConfig,
  ): Promise<ResultEvent | undefined> {
    let acct = this.dispatchAccount();
    let resume: string | undefined;
    let message: string | unknown[] = kickoff;
    for (let attempt = 0; attempt <= MAX_ACCOUNT_FAILOVERS; attempt++) {
      const run = this.db.createRun({ threadId: thread.id, role, model, account: acct.label });
      this.emitRun(run.id);
      const agent = new AgentRun(makeCfg({ token: acct.token, resume, runId: run.id }));
      this.wireRun(agent, thread.id, run.id, role, acct.id);
      this.track(thread.id, agent);
      agent.start(message);
      const res = await agent.result();
      await agent.stop();
      this.untrack(thread.id, agent);
      this.finishRun(run.id, res, agent);
      if ((res && !res.isError) || this.cancelled(thread.id) || !agent.rateLimited) return res;
      const next = this.failoverAccount(acct.id);
      if (!next) return res;
      this.logFailover(thread, role, next.label, agent.rateLimitInfo);
      acct = next;
      resume = agent.sessionId;
      message = "Your session was switched to another account after a usage limit. Continue exactly where you left off and finish.";
    }
    return undefined;
  }

  private async runPlanner(thread: Thread): Promise<PlanOutput | undefined> {
    const res = await this.runRole(thread, "planner", config.models.planner, this.kickoffContent(thread.id, thread.brief), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "planner", getRunId: () => runId });
      const cfg = plannerConfig(thread.workspace, { bus });
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      return cfg;
    });
    return res?.structuredOutput as PlanOutput | undefined;
  }

  private async runResearcher(thread: Thread): Promise<ResearchOutput | undefined> {
    const res = await this.runRole(thread, "researcher", config.models.researcher, this.kickoffContent(thread.id, thread.brief), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "researcher", getRunId: () => runId });
      const memory = createMemoryServer(this.memory);
      const cfg = researcherConfig(thread.workspace, { bus, memory });
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      return cfg;
    });
    return res?.structuredOutput as ResearchOutput | undefined;
  }

  private async runQA(thread: Thread): Promise<QaOutput | undefined> {
    const res = await this.runRole(thread, "qa", config.models.qa, this.kickoffContent(thread.id, qaKickoff(thread)), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "qa", getRunId: () => runId });
      const cfg = qaConfig(thread.workspace, { bus });
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      return cfg;
    });
    return res?.structuredOutput as QaOutput | undefined;
  }

  /** Start the implementor (stays live for QA fix-rounds + injects). Returns the handle.
   *  `opts.account` pins a specific account (used by failover); otherwise it's selected. */
  private startImplementor(
    thread: Thread,
    kickoff: string,
    opts?: { resume?: string; effort?: Effort; account?: Acct },
  ): { run: AgentRun; runId: string; accountId: string } {
    this.setState(thread.id, "implementing");
    const acct = opts?.account ?? this.dispatchAccount();
    const run = this.db.createRun({ threadId: thread.id, role: "implementor", model: config.models.implementor, account: acct.label });
    this.emitRun(run.id);
    const bus = createBusServer(this, { threadId: thread.id, role: "implementor", getRunId: () => run.id });
    const cfg = implementorConfig(thread.workspace, { bus }, { resume: opts?.resume, effort: opts?.effort });
    cfg.oauthToken = acct.token;
    const agent = new AgentRun(cfg);
    this.wireRun(agent, thread.id, run.id, "implementor", acct.id);
    this.live.set(thread.id, { run: agent, runId: run.id, accountId: acct.id });
    this.track(thread.id, agent);
    agent.onEvent((e) => {
      if (e.type === "init" && e.sessionId) this.lastImplementorSession.set(thread.id, e.sessionId);
    });
    agent.onEnd(() => {
      // Only clear the live handle if it's still THIS run — a failover relaunch may have already
      // replaced it before this (dead) run's end fires, and we must not clobber the new handle.
      if (this.live.get(thread.id)?.run === agent) this.live.delete(thread.id);
      this.untrack(thread.id, agent);
      this.stopping.delete(thread.id);
    });
    agent.start(this.kickoffContent(thread.id, kickoff));
    return { run: agent, runId: run.id, accountId: acct.id };
  }

  /**
   * Await the implementor's result, failing over to another account if its account hits a
   * 5h/weekly cap mid-run: relaunch resuming the session (so the work-so-far is preserved),
   * re-send `continueMsg`, and await again — until it completes or no account has headroom.
   */
  private async awaitImplementorResult(
    thread: Thread,
    effort: Effort | undefined,
    current: AgentRun,
    currentAccountId: string,
    useNext: boolean,
    continueMsg: string,
  ): Promise<ResultEvent | undefined> {
    for (let attempt = 0; attempt <= MAX_ACCOUNT_FAILOVERS; attempt++) {
      const res = useNext ? await current.nextResult() : await current.result();
      if ((res && !res.isError) || this.cancelled(thread.id) || !current.rateLimited) return res;
      // Rate-limited: fail over to another account, or give up to "review" (return undefined so the
      // caller doesn't run QA on / mark done a half-finished implementation).
      const next = this.failoverAccount(currentAccountId);
      const sessionId = this.lastImplementorSession.get(thread.id);
      if (!next || !sessionId) return undefined;
      this.logFailover(thread, "implementor", next.label, current.rateLimitInfo);
      await current.stop();
      const relaunch = this.startImplementor(thread, continueMsg, { resume: sessionId, effort, account: next });
      current = relaunch.run;
      currentAccountId = relaunch.accountId;
      useNext = false;
    }
    return undefined;
  }

  /** Implementor → QA → fix, repeated until QA passes or we run out of rounds. */
  private async runImplementorQa(thread: Thread, kickoff: string, effort?: Effort): Promise<void> {
    const start = this.startImplementor(thread, kickoff, { effort });
    let res = await this.awaitImplementorResult(
      thread,
      effort,
      start.run,
      start.accountId,
      false,
      "Continue exactly where you left off and finish the task completely.",
    );

    for (let round = 1; round <= config.maxQaRounds; round++) {
      if (this.cancelled(thread.id)) return;
      if (!res) {
        this.setState(thread.id, "review", "Implementor ended without completing — needs your review.");
        return;
      }
      this.setState(thread.id, "qa");
      const qa = await this.runQA(thread).catch((e) => {
        this.hub.log("warn", `QA failed on ${thread.id.slice(0, 8)}: ${String(e)}`);
        return undefined;
      });
      if (this.cancelled(thread.id)) return;

      if (!qa) {
        this.postFinding({ threadId: thread.id, fromRole: "qa", summary: "QA could not complete — needs your review", severity: "warning" });
        this.setState(thread.id, "review");
        return;
      }
      if (qa.pass) {
        this.postFinding({ threadId: thread.id, fromRole: "qa", summary: `QA passed: ${qa.summary}`, severity: "info" });
        this.setState(thread.id, "done");
        return;
      }
      if (round >= config.maxQaRounds) {
        this.postFinding({
          threadId: thread.id,
          fromRole: "qa",
          summary: `QA still not satisfied after ${config.maxQaRounds} rounds — needs your review`,
          detail: qa.summary,
          severity: "warning",
        });
        this.setState(thread.id, "review");
        return;
      }

      const live = this.live.get(thread.id);
      if (!live) {
        this.setState(thread.id, "review", "Implementor is no longer live for the QA fix round.");
        return;
      }
      this.postFinding({ threadId: thread.id, fromRole: "qa", summary: `QA round ${round}: ${qa.summary}`, severity: "note" });
      this.setState(thread.id, "implementing");
      const fixMsg = `QA review found issues — fix ALL of these, then we'll re-check:\n${formatQaIssues(qa)}`;
      live.run.send(fixMsg, { priority: "now" });
      res = await this.awaitImplementorResult(thread, effort, live.run, live.accountId, true, fixMsg);
    }
  }

  // ---- live thread controls ----

  async injectThread(
    threadId: string,
    message: string,
    mode: "append" | "interrupt",
    images?: ImageAttachment[],
  ): Promise<ThreadActionResult> {
    const live = this.live.get(threadId);
    if (live) {
      if (mode === "interrupt") {
        await live.run.interrupt();
        this.setState(threadId, "implementing");
      }
      const blocks = images?.length ? images.map(toImageBlock) : [];
      live.run.send(
        contentWithImages(`[New information from the director]\n${message}`, blocks),
        mode === "interrupt" ? { priority: "now" } : undefined,
      );
      this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `inject(${mode}): ${message}${blocks.length ? ` [+${blocks.length} image(s)]` : ""}`,
      });
      this.hub.log("info", `Injected (${mode}) into ${threadId.slice(0, 8)}`);
      return { ok: true, state: "implementing" };
    }
    // Not live → resume. Stash any images so the resumed implementor's kickoff carries them.
    if (images?.length) this.threadImages.set(threadId, images.map(toImageBlock));
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
    const msg = message ?? "Continue where you left off.";
    const start = this.startImplementor(thread, msg, resume ? { resume } : undefined);
    // Manual resume isn't part of the QA loop — settle to review when it finishes (failover-aware).
    void this.awaitImplementorResult(thread, undefined, start.run, start.accountId, false, msg).then(() => {
      if (this.db.getThread(threadId)?.state === "implementing") this.setState(threadId, "review");
    });
    return { ok: true, state: "implementing" };
  }

  async cancelThread(threadId: string): Promise<ThreadActionResult> {
    this.stopping.add(threadId);
    const set = this.activeRuns.get(threadId);
    if (set) {
      for (const r of set) {
        try {
          await r.stop();
        } catch {
          /* already down */
        }
      }
      set.clear();
    }
    this.live.delete(threadId);
    this.threadImages.delete(threadId);
    const pendingApproval = this.pendingApprovals.get(threadId);
    if (pendingApproval) {
      this.pendingApprovals.delete(threadId);
      pendingApproval({ approved: false });
    }
    // Unblock any agent waiting on a question for this task.
    for (const q of this.db.listOpenQuestions()) {
      if (q.threadId === threadId) this.resolveQuestion(q.id, "(task cancelled)");
    }
    this.setState(threadId, "cancelled");
    this.stopping.delete(threadId);
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
    if (finding.fromRunId && finding.fromRunId === live.runId) return; // not its own
    if (finding.severity === "critical") {
      void this.injectThread(finding.threadId, `${finding.summary}${finding.detail ? `\n${finding.detail}` : ""}`, "interrupt");
      this.db.markFindingRouted(finding.id);
    } else if (finding.severity === "warning") {
      live.run.send(`[Heads-up finding] ${finding.summary}${finding.detail ? `\n${finding.detail}` : ""}`, { priority: "next" });
      this.db.markFindingRouted(finding.id);
    }
  }

  // ---- run event wiring ----

  private emitRun(runId: string): void {
    const run = this.db.getRun(runId);
    if (run) this.hub.publish({ type: "run.upsert", run });
  }

  private finishRun(runId: string, res: Extract<AgentEvent, { type: "result" }> | undefined, agent: AgentRun): void {
    this.db.updateRun(runId, {
      state: res?.isError ? "error" : "done",
      endedAt: Date.now(),
      costUsd: res?.costUsd ?? null,
      numTurns: res?.numTurns ?? null,
      sessionId: agent.sessionId ?? null,
    });
    this.emitRun(runId);
  }

  private wireRun(agent: AgentRun, threadId: string, runId: string, role: Role, accountId: string): void {
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
        case "text": {
          const m = this.db.addMessage({ threadId, runId, role, kind: "text", content: e.text });
          this.hub.publish({ type: "agent.text", threadId, runId, role, text: e.text, messageId: m.id });
          break;
        }
        case "tool_use": {
          const m = this.db.addMessage({ threadId, runId, role, kind: "tool", content: `${e.name} ${safeJson(e.input)}` });
          this.hub.publish({ type: "agent.tool", threadId, runId, role, name: e.name, input: e.input, id: e.id, messageId: m.id });
          break;
        }
        case "tool_result": {
          const pv = preview(e.content);
          const m = this.db.addMessage({ threadId, runId, role, kind: "result", content: pv });
          this.hub.publish({ type: "agent.tool_result", threadId, runId, id: e.id, isError: e.isError, preview: pv, messageId: m.id });
          break;
        }
        case "result":
          this.db.updateRun(runId, { costUsd: e.costUsd ?? null, numTurns: e.numTurns ?? null, state: e.isError ? "error" : "idle" });
          this.emitRun(runId);
          break;
        case "error":
          this.db.updateRun(runId, { state: "error", error: e.message });
          this.emitRun(runId);
          this.hub.log("error", `${role} on ${threadId.slice(0, 8)}: ${e.message}`);
          break;
        case "rate_limit":
          this.accounts.updateFromRateLimit(accountId, e.info);
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
    const steps = plan.steps ?? [];
    if (steps.length) {
      parts.push("Steps:");
      steps.forEach((s, i) => {
        const files = s.files?.length ? ` [files: ${s.files.join(", ")}]` : "";
        parts.push(`${i + 1}. ${s.title} — ${s.detail}${files}`);
      });
    }
    if (plan.risks?.length) parts.push("", `Risks: ${plan.risks.join("; ")}`);
    if (plan.openQuestions?.length) parts.push(`Open questions: ${plan.openQuestions.join("; ")}`);
    if (plan.parallelism) parts.push(`Parallelism: ${plan.parallelism}`);
  } else {
    parts.push("(planner produced no structured plan — proceed from the brief and your own analysis)");
  }
  parts.push("");

  parts.push("## Research (from the researcher)");
  if (research) {
    parts.push(research.summary, "");
    if (research.relevantFiles?.length) {
      parts.push("Relevant files:");
      research.relevantFiles.forEach((f) => parts.push(`- ${f.path} — ${f.why}`));
    }
    if (research.facts?.length) {
      parts.push("Key facts:");
      research.facts.forEach((f) => parts.push(`- ${f.claim}${f.source ? ` (${f.source})` : ""}`));
    }
    if (research.memories?.length) {
      parts.push("Relevant memory:");
      research.memories.forEach((m) => parts.push(`- ${m.name} — ${m.gist}`));
    }
    if (research.warnings?.length) parts.push("Warnings: " + research.warnings.join("; "));
  } else {
    parts.push("(researcher produced no structured brief — gather any context you need yourself)");
  }
  parts.push("");
  parts.push(
    "Implement this now, completely. Post findings as you go; ask_user immediately if you hit a blocker only the user can fix. A QA agent will then test and review your work and send back issues to fix. When QA is satisfied, commit and push per the doctrine.",
  );
  return parts.join("\n");
}

function qaKickoff(thread: Thread): string {
  return [
    `# QA review for task: ${thread.title}`,
    "",
    "The implementor just finished an attempt at this brief:",
    "",
    thread.brief,
    "",
    "Verify the work in this repo: inspect the changes (git diff), run the project's build/typecheck/tests, and check correctness and completeness against the brief. Then return your structured verdict (pass + issues). Pass only if you'd actually ship it.",
  ].join("\n");
}

function formatQaIssues(qa: QaOutput): string {
  const lines = (qa.issues ?? []).map((i) => `- [${i.severity ?? "issue"}] ${i.description}${i.location ? ` (${i.location})` : ""}`);
  return (qa.summary ? `${qa.summary}\n` : "") + (lines.length ? lines.join("\n") : "(see QA summary)");
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
