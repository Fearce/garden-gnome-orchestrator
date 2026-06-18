import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import { AgentRun, type AgentRunConfig } from "../agents/runner.js";
import { implementorConfig, plannerConfig, qaConfig, researcherConfig } from "../agents/roles.js";
import { createBusServer } from "../bus/busServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { compressSession, sessionAgeMs } from "./resumeCompress.js";
import { config } from "../config.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { contentWithImages, toImageBlock, type ImageBlock } from "../attachments.js";
import type {
  AgentEvent,
  AgentRunState,
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
  "awaiting_approval",
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
  // Threads whose manual resume is still *materializing* (compressing the prior session on the cold
  // path) — `live` isn't populated yet. Guards against a second resume/inject double-starting an
  // implementor in that window; injects that arrive are buffered in pendingResumeMsgs and flushed
  // once the implementor is live.
  private readonly resuming = new Set<string>();
  private readonly pendingResumeMsgs = new Map<string, string[]>();
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

  /** Any task left mid-flight by a server restart is dead in memory — fail it, and stamp its
   *  orphaned runs terminal. The DB still has them as starting/running/idle but their in-memory
   *  AgentRun is gone, so without this they'd inflate the live counter forever. */
  private markInterrupted(): void {
    for (const t of this.db.listThreads()) {
      if (IN_FLIGHT.has(t.state)) {
        this.db.updateThread(t.id, { state: "failed", error: "interrupted by a server restart — click Resume to continue from where it left off (finished stages are reused)" });
      }
    }
    const at = Date.now();
    for (const r of this.db.listActiveRuns()) {
      this.db.updateRun(r.id, { state: "interrupted", endedAt: r.endedAt ?? at });
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

  /** Bump a thread's updatedAt (recent-activity timestamp) without changing its state, and
   *  republish it so the board re-sorts it to the front. Used for events like inject that are
   *  "activity" but not state transitions. */
  private touchThread(threadId: string): void {
    const t = this.db.updateThread(threadId, {});
    if (t) this.hub.publish({ type: "thread.upsert", thread: t });
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

  /**
   * The agent-routed pipeline. There is no fixed sequence: the **planner always runs first**,
   * reads the codebase, and routes to either a **researcher** (external info) or straight to the
   * **implementor**; the implementor always hands off to **QA**; and QA is the only role that can
   * declare the task done (or bounce it back to the implementor). The shape is
   *   planner → [researcher →] implementor → QA → [implementor → QA → …].
   *
   * It is also resume-aware: every completed stage is persisted (updateThreadStageOutputs), so a
   * task that died mid-pipeline re-enters here (via resumeThread on a 'failed' thread) and skips
   * the stages already done — feeding their saved outputs forward — instead of starting over. A
   * fresh dispatch simply finds no saved stages and runs them all.
   */
  private async runPipeline(threadId: string): Promise<void> {
    const thread = this.db.getThread(threadId);
    if (!thread) return;
    if (!existsSync(thread.workspace)) {
      this.setState(threadId, "failed", `Workspace "${thread.workspace}" does not exist on disk — agents can't run there. Re-dispatch with a valid path.`);
      return;
    }
    const saved = this.db.getThreadStageOutputs(threadId);
    try {
      // 1. Planner — always first. It owns codebase reading and decides what comes next.
      // planDone (mirrors researchDone) makes a deliberate "no structured plan" outcome sticky across
      // resume — without it, a planner that ran but produced null re-runs a whole Opus pass every resume.
      let plan = saved.plan ?? undefined;
      if (!saved.planDone) {
        this.setState(threadId, "planning");
        plan = await this.runPlanner(thread).catch((e) => {
          this.hub.log("warn", `Planner failed on ${threadId.slice(0, 8)}: ${String(e)}`);
          return undefined;
        });
        if (this.cancelled(threadId)) return;
        this.db.updateThreadStageOutputs(threadId, { plan: plan ?? null, planDone: true });
      }

      // 2. Researcher — only when the planner routed to it (external info needed). Always →
      //    implementor afterward. researchDone guards against re-running it on resume.
      let research = saved.research ?? undefined;
      if (plan?.nextAgent === "researcher" && !saved.researchDone) {
        this.setState(threadId, "researching");
        research = await this.runResearcher(thread, plan).catch((e) => {
          this.hub.log("warn", `Researcher failed on ${threadId.slice(0, 8)}: ${String(e)}`);
          return undefined;
        });
        if (this.cancelled(threadId)) return;
        this.db.updateThreadStageOutputs(threadId, { research: research ?? null, researchDone: true });
      }

      // 3. Approval gate — after the full context (plan + any research) exists, so the human sees
      //    everything before approving. Skipped on resume if already approved.
      const kickoff = composeKickoff(thread, plan, research);
      if (this.approvalMode() && !saved.approved) {
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
        this.db.updateThreadStageOutputs(threadId, { approved: true });
      }
      this.db.updateThreadStageOutputs(threadId, { kickoff });

      // 4. Implementor → QA. On resume, pick up the implementor's prior SDK session (recovered from
      //    its agent_run, which survives a restart) so its work-in-progress isn't thrown away.
      await this.runImplementorQa(thread, kickoff, plan?.effort, this.latestImplementorSession(threadId));
    } catch (err) {
      if (!this.cancelled(threadId)) this.setState(threadId, "failed", err instanceof Error ? err.message : String(err));
    } finally {
      // Every role's kickoff has been built by now; free the base64 blocks. A live
      // implementor still remembers them, and a later resume reloads them from its
      // session, so dropping them here doesn't blind anything.
      this.threadImages.delete(threadId);
    }
  }

  /** The most recent implementor run's SDK session id for a thread, or undefined if none has one.
   *  Sourced from the DB (not the in-memory lastImplementorSession map) so it survives a server
   *  restart — that's the whole point of resume. Latest-by-startedAt handles failover (one role,
   *  several runs): we want the session the implementor was actually on when it died. */
  private latestImplementorSession(threadId: string): string | undefined {
    return (
      this.db
        .listRuns(threadId)
        .filter((r) => r.role === "implementor" && r.sessionId)
        .sort((a, b) => b.startedAt - a.startedAt)[0]?.sessionId ?? undefined
    );
  }

  /** The most recent QA run's SDK session id, so fix-rounds 2..N can resume it. DB-sourced (like
   *  latestImplementorSession) so it survives a restart and reflects whichever account QA ended on. */
  private latestQaSession(threadId: string): string | undefined {
    return (
      this.db
        .listRuns(threadId)
        .filter((r) => r.role === "qa" && r.sessionId)
        .sort((a, b) => b.startedAt - a.startedAt)[0]?.sessionId ?? undefined
    );
  }

  /** Run a one-shot role (planner/researcher/qa) to a result. If its account hits a 5h/weekly
   *  cap mid-run, relaunch on another account resuming the session — transparently. */
  private async runRole(
    thread: Thread,
    role: "planner" | "researcher" | "qa",
    model: string,
    kickoff: string | unknown[],
    makeCfg: (ctx: { token: string | undefined; resume?: string; runId: string }) => AgentRunConfig,
    initialResume?: string,
  ): Promise<ResultEvent | undefined> {
    let acct = this.dispatchAccount();
    let resume: string | undefined = initialResume;
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

  private async runResearcher(thread: Thread, plan: PlanOutput | undefined): Promise<ResearchOutput | undefined> {
    const res = await this.runRole(thread, "researcher", config.models.researcher, this.kickoffContent(thread.id, researcherKickoff(thread, plan)), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "researcher", getRunId: () => runId });
      const memory = createMemoryServer(this.memory);
      const cfg = researcherConfig(thread.workspace, { bus, memory });
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      return cfg;
    });
    return res?.structuredOutput as ResearchOutput | undefined;
  }

  private async runQA(thread: Thread, opts: { round: number }): Promise<QaOutput | undefined> {
    // Fix-rounds 2..N resume the SAME QA session — a warm cache read of the diff/files/tests it
    // already ingested — instead of a fresh Opus session that re-reads everything from scratch. QA
    // still re-runs `git diff` and the checks itself (independent verification preserved); it just
    // doesn't re-pay to reconstruct context it holds. Round 1, or a cold/missing prior session, is fresh.
    const prior = opts.round > 1 ? this.latestQaSession(thread.id) : undefined;
    const ageMs = prior ? sessionAgeMs(prior) : null;
    const resume = prior && (config.resumeFullSession || (ageMs != null && ageMs < config.resumeWarmMinutes * 60_000)) ? prior : undefined;
    // A fresh QA session gets a scope hint (plan summary + touched files) so it starts from the real
    // change surface instead of spending Opus turns rediscovering it; resumed QA already knows it.
    const plan = resume ? undefined : (this.db.getThreadStageOutputs(thread.id).plan ?? undefined);
    const kickoff = resume ? qaRecheckKickoff() : qaKickoff(thread, plan);
    const res = await this.runRole(
      thread,
      "qa",
      config.models.qa,
      // On resume the QA session already holds the pasted images; only wrap them for a fresh start.
      resume ? kickoff : this.kickoffContent(thread.id, kickoff),
      ({ token, resume: r, runId }) => {
        const bus = createBusServer(this, { threadId: thread.id, role: "qa", getRunId: () => runId });
        const cfg = qaConfig(thread.workspace, { bus });
        cfg.oauthToken = token;
        if (r) cfg.resume = r;
        return cfg;
      },
      resume,
    );
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
    const run = this.db.createRun({ threadId: thread.id, role: "implementor", model: config.models.implementor, account: acct.label, effort: opts?.effort ?? "high" });
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
      this.finalizeRun(run.id, agent);
    });
    // Wrap pasted images into the kickoff only when STARTING a fresh session. On a resume the prior
    // session already holds them in context, so re-attaching the base64 would re-bill vision tokens
    // for no gain (and a failover can relaunch several times).
    agent.start(opts?.resume ? kickoff : this.kickoffContent(thread.id, kickoff));
    return { run: agent, runId: run.id, accountId: acct.id };
  }

  /**
   * Start the implementor for a resume, picking the cheap path so a resume never silently reloads a
   * whole prior session. The gate (shared by the pipeline's implementor→QA loop AND manual resume /
   * cold inject, so EVERY resume route goes through it):
   *   - no prior session  → start fresh from the full kickoff (folding in any director note);
   *   - warm prompt cache (or RESUME_FULL_SESSION) → full session resume — a cache read is ~0.1× and
   *     keeps full fidelity, so compressing then would only burn a Haiku call and lose detail;
   *   - cold cache → a FRESH session seeded with a locally Haiku-compressed handoff of the prior
   *     session instead of the pricey full-transcript reload (the expensive part of a cold resume).
   * `resumeNudge` is the message sent on a warm full-resume; `directorNote` is any new instruction
   * from this resume (woven into the cold seed, since that path doesn't continue the live session).
   */
  private async startResumedImplementor(
    thread: Thread,
    baseKickoff: string,
    resumeSession: string | undefined,
    opts: { effort?: Effort; resumeNudge: string; directorNote?: string; qaFollows: boolean; account?: Acct },
  ): Promise<LiveImplementor | null> {
    if (this.cancelled(thread.id)) return null; // cancelled before we got here
    if (!resumeSession) {
      const text = opts.directorNote ? `${baseKickoff}\n\n[New information from the director]\n${opts.directorNote}` : baseKickoff;
      return this.startImplementor(thread, text, { effort: opts.effort, account: opts.account });
    }
    const ageMs = sessionAgeMs(resumeSession);
    const warm = ageMs != null && ageMs < config.resumeWarmMinutes * 60_000;
    if (config.resumeFullSession || warm) {
      const why = config.resumeFullSession ? "forced" : `cache likely warm (${Math.round((ageMs ?? 0) / 60000)}m < ${config.resumeWarmMinutes}m)`;
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: full session resume — ${why}.`);
      // Only append the director note when it adds something beyond the nudge — on a manual resume
      // the nudge already IS the user's message, so passing it again would duplicate it.
      const nudge =
        opts.directorNote && opts.directorNote !== opts.resumeNudge
          ? `${opts.resumeNudge}\n\n[New information from the director]\n${opts.directorNote}`
          : opts.resumeNudge;
      return this.startImplementor(thread, nudge, { effort: opts.effort, resume: resumeSession, account: opts.account });
    }
    // Cold cache: composeResumeKickoff compresses the prior session (Haiku + git) and logs how. This
    // is the only awaited step, so re-check cancellation after it before spending an Opus start.
    const seed = await this.composeResumeKickoff(thread, baseKickoff, resumeSession, {
      directorNote: opts.directorNote,
      qaFollows: opts.qaFollows,
    });
    if (this.cancelled(thread.id)) return null; // user cancelled while we were compressing
    return this.startImplementor(thread, seed, { effort: opts.effort, account: opts.account });
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

  /** Implementor → QA → fix, repeated until QA passes or we run out of rounds. The live
   *  implementor is stopped on every exit so a finished/parked task stops counting as live;
   *  later injects fall back to the resume path (lastImplementorSession). */
  private async runImplementorQa(thread: Thread, kickoff: string, effort?: Effort, resumeSession?: string): Promise<void> {
    try {
      await this.runImplementorQaLoop(thread, kickoff, effort, resumeSession);
    } finally {
      await this.stopLive(thread.id);
    }
  }

  /** A cheap resume seed that still preserves the prior session's reasoning. Three small parts:
   *  the original kickoff (brief + plan + research, from the persisted stage outputs); a locally
   *  Haiku-compressed **handoff** of the prior implementor session (its decisions, what it tried,
   *  what's left — instead of reloading the whole transcript, which is what makes a cold resume
   *  expensive); and the workspace's current git progress. Falls back to plan + git when the
   *  transcript can't be compressed. */
  private async composeResumeKickoff(
    thread: Thread,
    kickoff: string,
    sessionId?: string,
    opts?: { directorNote?: string; qaFollows?: boolean },
  ): Promise<string> {
    const git = (args: string[]): Promise<string> =>
      new Promise((res) =>
        execFile("git", ["-C", thread.workspace, "--no-pager", ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) =>
          res((out || errOut || (err ? err.message : "")).trim()),
        ),
      );
    const gitProgress = async (): Promise<string> => {
      const [log, stat, diff] = await Promise.all([git(["log", "--oneline", "-8"]), git(["diff", "--stat"]), git(["diff"])]);
      const cappedDiff = diff.length > 6000 ? diff.slice(0, 6000) + "\n… (diff truncated — read the files for the rest)" : diff;
      return [
        "Recent commits:",
        log || "(none yet)",
        "",
        "Uncommitted changes (git diff --stat):",
        stat || "(none)",
        cappedDiff ? `\nUncommitted diff:\n${cappedDiff}` : "",
      ].join("\n");
    };

    // Compress the prior session locally (free static strip + cheap Haiku summary) rather than
    // reloading it. Runs alongside the git read; tolerates failure (→ plan + git only).
    const [progress, handoff] = await Promise.all([
      gitProgress(),
      sessionId
        ? compressSession(sessionId, this.dispatchAccount().token).catch((e) => {
            this.hub.log("warn", `Resume compression failed on ${thread.id.slice(0, 8)}: ${String(e)}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    if (handoff) {
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: compressed prior session via ${handoff.haiku ? "Haiku" : "static strip"} — no full transcript reload.`);
    }

    const parts: string[] = [
      kickoff,
      "",
      "---",
      "## ⏪ Resuming — you already worked on this task in an earlier session",
    ];
    if (opts?.directorNote) {
      parts.push(`**New information from the director for this resume:** ${opts.directorNote}`, "");
    }
    if (handoff) {
      parts.push(
        `Your earlier session was compressed locally (${handoff.haiku ? "Haiku summary of the older turns + the most recent turns verbatim" : "static strip of the transcript"}) instead of reloaded in full — reloading the whole transcript is the costly part of a resume. Absorb this handoff to recover your prior context, then continue; do NOT summarize it back.`,
        "",
        handoff.markdown,
        "",
      );
    } else {
      parts.push(
        "Your earlier session's transcript wasn't available to compress, so continue from the plan above and the workspace state below.",
        "",
      );
    }
    const tail =
      opts?.qaFollows === false
        ? "When the work is complete, commit and push per the doctrine (the user will then review it)."
        : "A QA agent will review your work when you're done.";
    parts.push(
      "## Current workspace progress (git)",
      progress,
      "",
      `Continue from here against the plan above: re-read any current file you need (contents may have changed since the handoff), finish the remaining work, and don't redo what's already done. ${tail}`,
    );
    return parts.join("\n");
  }

  private async runImplementorQaLoop(thread: Thread, kickoff: string, effort?: Effort, resumeSession?: string): Promise<void> {
    const start = await this.startResumedImplementor(thread, kickoff, resumeSession, {
      effort,
      resumeNudge:
        "Your session was resumed after an interruption (a crash or server restart). Continue exactly where you left off and finish the task completely. A QA agent will review your work when you're done.",
      qaFollows: true,
    });
    if (!start) return; // cancelled while compressing the prior session for the resume
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
      const qa = await this.runQA(thread, { round }).catch((e) => {
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
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `↪ injected: ${message}${blocks.length ? ` [+${blocks.length} image(s)]` : ""}`,
      });
      // Echo it into the task feed live (otherwise the injected note only appears on a later
      // history refetch) and bump recency so the task jumps to the front of the board.
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      this.hub.log("info", `Injected (${mode}) into ${threadId.slice(0, 8)}`);
      return { ok: true, state: "implementing" };
    }
    // A resume is mid-materialization (live not yet set) — buffer this inject so it isn't lost, then
    // resumeImplementorOnly delivers it the moment the implementor comes live.
    if (this.resuming.has(threadId)) {
      const q = this.pendingResumeMsgs.get(threadId) ?? [];
      q.push(message);
      this.pendingResumeMsgs.set(threadId, q);
      const m = this.db.addMessage({ threadId, role: "director", kind: "system", content: `↪ injected: ${message}` });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      this.hub.log("info", `Buffered inject into ${threadId.slice(0, 8)} (resume materializing)`);
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
    if (!existsSync(thread.workspace)) {
      this.setState(threadId, "failed", `Can't resume — workspace "${thread.workspace}" does not exist. Re-dispatch this task with a valid path.`);
      return { ok: false, error: `Workspace "${thread.workspace}" does not exist.` };
    }
    const live = this.live.get(threadId);
    if (live) {
      live.run.send(message ?? "Continue.", { priority: "now" });
      this.setState(threadId, "implementing");
      return { ok: true, state: "implementing" };
    }
    // A task that died mid-pipeline re-enters the resume-aware pipeline: it may have failed before
    // the implementor ever ran (during planning/research/approval), so we can't assume an
    // implementor session exists. runPipeline skips the stages already persisted and continues from
    // the failure point — and clears the error via the first stage's setState.
    if (thread.state === "failed") {
      if (message?.trim()) this.db.addMessage({ threadId, role: "director", kind: "system", content: `resume: ${message}` });
      void this.runPipeline(threadId);
      return { ok: true, state: "planning" };
    }
    // A resume is already materializing (compressing the prior session on the cold path) — treat a
    // second click as a no-op rather than double-starting a second implementor on the same workspace.
    if (this.resuming.has(threadId)) return { ok: true, state: "implementing" };
    // Reserve the thread synchronously BEFORE backgrounding, flip the board immediately, then resume
    // in the background — the cold path may compress the prior session first and this WS command must
    // not block on a Haiku call.
    this.resuming.add(threadId);
    this.setState(threadId, "implementing");
    void this.resumeImplementorOnly(thread, message);
    return { ok: true, state: "implementing" };
  }

  /** Manual resume (the Resume control, or an inject into a cold/non-live task) that talks ONLY to
   *  the implementor — no QA loop; it settles to 'review' when the implementor finishes so the user
   *  gets the result. Crucially it reuses the prior session through the SAME warm/cold gate as the
   *  pipeline, so a manual resume on a cold cache compresses the prior session instead of paying the
   *  full-transcript reload it used to. Runs in the background so the triggering command returns at
   *  once; failover-aware via awaitImplementorResult. The caller must have added threadId to
   *  `resuming`; this clears it once the implementor is live (or the start was abandoned). */
  private async resumeImplementorOnly(thread: Thread, message?: string): Promise<void> {
    const resume = this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id);
    const baseKickoff = this.db.getThreadStageOutputs(thread.id).kickoff ?? thread.brief;
    const resumeNudge = message ?? "Continue where you left off.";
    let start: LiveImplementor | null;
    try {
      start = await this.startResumedImplementor(thread, baseKickoff, resume, { resumeNudge, directorNote: message, qaFollows: false });
    } catch (e) {
      this.hub.log("warn", `Resume on ${thread.id.slice(0, 8)} failed to start: ${String(e)}`);
      start = null;
    } finally {
      // Materialization is done (live now set, or abandoned) — stop coalescing concurrent triggers.
      this.resuming.delete(thread.id);
    }
    if (!start) {
      // Either cancelled while compressing (leave it cancelled) or the start genuinely failed.
      this.pendingResumeMsgs.delete(thread.id);
      if (!this.cancelled(thread.id) && this.db.getThread(thread.id)?.state === "implementing") {
        this.setState(thread.id, "review", "Resume failed to start — needs your review.");
      }
      return;
    }
    // The kickoff has consumed any stashed images; drop them so a later resume doesn't re-send the
    // base64 (wasted vision tokens) — the live/resumed session already holds them.
    this.threadImages.delete(thread.id);
    // Deliver anything the director injected while the resume was still materializing.
    const buffered = this.pendingResumeMsgs.get(thread.id);
    if (buffered?.length) {
      this.pendingResumeMsgs.delete(thread.id);
      for (const m of buffered) start.run.send(`[New information from the director]\n${m}`, { priority: "next" });
    }
    await this.awaitImplementorResult(thread, undefined, start.run, start.accountId, false, resumeNudge)
      .then(() => {
        if (this.db.getThread(thread.id)?.state === "implementing") this.setState(thread.id, "review");
      })
      .catch((e) => this.hub.log("warn", `Resume on ${thread.id.slice(0, 8)} ended in error: ${String(e)}`))
      .finally(() => void this.stopLive(thread.id));
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
    // A resume may be mid-materialization (compressing) with no live run yet — drop its bookkeeping
    // so it can't resurrect the cancelled task. startResumedImplementor re-checks cancelled() after
    // compressing and won't start once this setState lands.
    this.resuming.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
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

  /** Idempotently stamp a run terminal (state + endedAt). Implementor runs go through this on
   *  their `onEnd` because they aren't part of runRole's explicit finishRun. The endedAt guard
   *  makes repeated calls (stop → onEnd, boot sweep) no-ops, so the clock freezes once. */
  private finalizeRun(runId: string, agent: AgentRun): void {
    const run = this.db.getRun(runId);
    if (!run || run.endedAt != null) return;
    const res = agent.lastResult;
    const state: AgentRunState = res ? (res.isError ? "error" : "done") : "interrupted";
    this.db.updateRun(runId, {
      state,
      endedAt: Date.now(),
      costUsd: res?.costUsd ?? run.costUsd ?? null,
      numTurns: res?.numTurns ?? run.numTurns ?? null,
      sessionId: agent.sessionId ?? run.sessionId ?? null,
    });
    this.emitRun(runId);
  }

  /** Stop the live implementor for a thread, if any. Closing its session ends the run, whose
   *  onEnd finalizes the DB row — so a completed/parked task stops counting agents as live. */
  private async stopLive(threadId: string): Promise<void> {
    const live = this.live.get(threadId);
    if (!live) return;
    try {
      await live.run.stop();
    } catch {
      /* already down */
    }
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

/** The researcher's structured brief as markdown, folded into the implementor's kickoff (the
 *  planner runs first and no longer reads it — the researcher now enriches the build, not the plan). */
function formatResearch(research: ResearchOutput): string {
  const parts: string[] = [research.summary];
  if (research.facts?.length) {
    parts.push("", "Key facts:");
    research.facts.forEach((f) => parts.push(`- ${f.claim}${f.source ? ` (${f.source})` : ""}`));
  }
  if (research.memories?.length) {
    parts.push("", "Relevant memory:");
    research.memories.forEach((m) => parts.push(`- ${m.name} — ${m.gist}`));
  }
  if (research.warnings?.length) parts.push("", "Warnings: " + research.warnings.join("; "));
  return parts.join("\n");
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

  // The researcher only runs when the planner routed to it; omit the section entirely otherwise so
  // the implementor isn't told to "go gather context yourself" when the plan already has all it needs.
  if (research) {
    parts.push("## Research (from the researcher) — external findings only; the plan above covers the codebase");
    parts.push(formatResearch(research));
    parts.push("");
  }
  // Task-specific marching orders only. The standing doctrine (commit/push/myaccount, QA fix-rounds, no
  // half-measures) lives in the implementor's cache-stable system prompt — restating it here would
  // just re-bill those tokens in every per-task message.
  parts.push("Implement this now, completely. Post findings as you go; ask_user immediately on a blocker only the user can fix.");
  return parts.join("\n");
}

/** The researcher's kickoff. Planner-first means the researcher is handed the plan and told to
 *  resolve its open questions with EXTERNAL sources only — it must not re-read the codebase. */
function researcherKickoff(thread: Thread, plan: PlanOutput | undefined): string {
  const parts: string[] = [`# Research request for task: ${thread.title}`, "", "## Brief", thread.brief, ""];
  if (plan) {
    parts.push(
      "## The planner read the codebase and flagged that this task needs EXTERNAL information before it can be built",
      "",
      `Planner's working plan: ${plan.summary}`,
    );
    if (plan.openQuestions?.length) {
      parts.push("", "Open questions to resolve with external sources:");
      plan.openQuestions.forEach((q) => parts.push(`- ${q}`));
    }
    parts.push("");
  }
  parts.push(
    "Gather ONLY external context: web search, official docs, library/API references, GitHub issues, Stack Overflow, changelogs/release notes, error-message lookups, plus relevant entries from the user's memory (search_memory). Do NOT read the codebase — the planner already did. Return your structured brief with sourced facts so the implementor inherits them.",
  );
  return parts.join("\n");
}

function qaKickoff(thread: Thread, plan?: PlanOutput): string {
  const parts: string[] = [
    `# QA review for task: ${thread.title}`,
    "",
    "The implementor just finished an attempt at this brief:",
    "",
    thread.brief,
  ];
  // Scope hint: point QA at the real change surface so it doesn't spend Opus turns rediscovering it.
  // It still independently runs git diff + the checks — this just narrows where it looks first.
  if (plan) {
    const files = [...new Set((plan.steps ?? []).flatMap((s) => s.files ?? []))];
    const hint: string[] = [];
    if (plan.summary) hint.push(`Planner's intent: ${plan.summary}`);
    if (files.length) hint.push(`Files the plan expected to touch: ${files.join(", ")}`);
    if (hint.length) parts.push("", "## Scope hint (verify against the ACTUAL git diff, not just this)", ...hint);
  }
  parts.push(
    "",
    "Verify the work in this repo: inspect the changes (git diff), run the project's build/typecheck/tests, and check correctness and completeness against the brief. Then return your structured verdict (pass + issues). Pass only if you'd actually ship it.",
  );
  return parts.join("\n");
}

/** The kickoff for a RESUMED QA session (fix-rounds 2..N): the session already holds the brief, the
 *  prior diff, and the test output, so this is just a short re-check nudge — no re-statement. */
function qaRecheckKickoff(): string {
  return [
    "The implementor reports it has addressed the issues you raised. Re-verify:",
    "- Re-run `git diff` to see the NEW state and re-run the project's build/typecheck/tests.",
    "- Confirm each issue you raised is actually resolved, and watch for any regression the fix introduced.",
    "Then return your updated structured verdict (pass + remaining issues). Pass only if you'd ship it.",
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
