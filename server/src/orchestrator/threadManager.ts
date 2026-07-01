import type { AccountManager } from "../accounts/accountManager.js";
import { untilReset } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import { AgentRun, type AgentRunConfig, type AgentRunLike } from "../agents/runner.js";
import { CodexAgentRun, chatgptLoginAvailable, codexAuthAvailable, testOpenAiKey, type CodexTestResult } from "../agents/codexRunner.js";
import { implementorConfig, plannerConfig, qaConfig, researcherConfig, resolveEffort } from "../agents/roles.js";
import { CODEX_IMPLEMENTOR_DOCTRINE } from "../agents/prompts.js";
import { createBusServer } from "../bus/busServer.js";
import { createOfficeServer } from "../bus/officeServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { compressSession, sessionAgeMs } from "./resumeCompress.js";
import { titleFromInjection } from "./titleFromInjection.js";
import { config } from "../config.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { contentWithImages, toImageBlock, type ImageBlock } from "../attachments.js";
import type {
  AgentEvent,
  AgentRunState,
  AttachmentRef,
  ChatMessage,
  Effort,
  Finding,
  ImageAttachment,
  ImplementorProvider,
  OrchestratorSettings,
  PlanOutput,
  QaOutput,
  RateLimitInfo,
  ResearchOutput,
  Role,
  Thread,
} from "../types.js";
import { GENERAL_ROOM, GNOME_NAMES, gnomeName, normalizeWorkspace, repoRoom } from "../types.js";

type ResultEvent = Extract<AgentEvent, { type: "result" }>;
type Acct = { id: string; label: string; token: string | undefined };
import type {
  AskUserInput,
  ChatPostInput,
  ChatReadInput,
  DispatchInput,
  OrchestratorApi,
  PostFindingInput,
  RosterEntry,
  ThreadActionResult,
} from "./api.js";

interface LiveImplementor {
  run: AgentRunLike;
  runId: string;
  accountId: string;
}

/** A settings.set patch: the writable subset of OrchestratorSettings plus the write-only raw key. The
 *  read-only masked indicators (hasOpenaiKey/openaiKeyLast4) are derived, never set by a client. */
export type SettingsPatch = Partial<Omit<OrchestratorSettings, "hasOpenaiKey" | "openaiKeyLast4" | "codexChatgptLogin">> & { openaiApiKey?: string };

/** The slice of operator settings the implementor→QA stage needs, captured at pipeline start. */
interface PipeOpts {
  qaEnabled: boolean;
  maxQaRounds: number;
}

const MAX_RESULT_PREVIEW = 600;
const QUESTION_TIMEOUT_MS = 20 * 60 * 1000;
// SDK result subtypes that mean "involuntarily cut off, not finished" — the orchestrator silently
// warm-resumes these instead of carrying half-done work into QA. A genuine finish is `success`; a usage
// cap is detected separately (agent.rateLimited). Kept as a set so more cutoff subtypes can join here.
const LIMIT_SUBTYPES: ReadonlySet<string> = new Set(["error_max_turns"]);
// Explicit, terminal completion phrasing in the implementor's last words — deliberately narrow, since a
// false "done" suppresses a needed auto-resume (the bug), while a missed "done" only costs one cheap warm
// resume. Forward-looking phrasing ("doing that now", "starting that next") must NOT match.
const IMPLEMENTOR_DONE_RE =
  /\b(all done|task (?:is )?(?:now )?complete|everything is (?:complete|done)|nothing (?:more|else) (?:to do|left)|ready for (?:qa|review)|handing (?:off |this )?(?:to )?qa|the work is (?:complete|done|finished))\b/;
// Forward-looking "I'll come back and confirm later" phrasing in the implementor's FINAL words — it ended
// its turn (a VOLUNTARY success, not a cutoff/cap) waiting to be woken when some process it kicked off
// finishes. Nothing wakes a voluntary turn-end, so the task would park for hours; we treat this like a
// turn-limit stop and auto-resume with a nudge to block in-turn instead. Narrow on purpose: it must promise
// future confirmation/continuation gated on something finishing — a genuine finish (IMPLEMENTOR_DONE_RE) and
// a real blocker (which goes through ask_user, never a bare turn-end) are both excluded.
const IMPLEMENTOR_STALL_RE =
  /\b(i'll|i will|i'm going to|i am going to|let me)\b[^.!?\n]*\b(confirm|report back|reporting back|let you know|update you|check back|circle back|follow up|come back|verify)\b[^.!?\n]*\b(once|when|after|as soon as)\b|\b(once|when|after)\b[^.!?\n]*\b(finish|finishes|finished|complete|completes|completed|done|ready)\b[^.!?\n]*\bi'll\b|\bwaiting (?:for|on)\b[^.!?\n]*\bto (?:finish|complete|build|restore|run|rebuild)\b/;
// The nudge sent when we auto-resume a voluntary stall: tell the agent the hard truth (no callback) and
// make it block in-turn on whatever it started, rather than ending the turn waiting to be woken.
const STALL_NUDGE =
  "You ended your turn saying you'd confirm or continue once something finishes — but NOTHING wakes you. " +
  "There is no background callback and no one resumes you automatically; ending the turn just parks the task " +
  "until a human notices, possibly hours later. If you kicked off a long-running command (a build, install, " +
  "restore, test run, server start), WAIT for it to finish IN THIS TURN — block on it, await it, or poll it in " +
  "a loop — then act on the result. Continue now and finish the task completely, or call ask_user if you're " +
  `genuinely blocked on ${config.ownerName}.`;
// On a mid-run 5h/weekly cap, relaunch on another account (resuming the session) up to N times.
const MAX_ACCOUNT_FAILOVERS = 3;
// After a server restart, auto-resume tasks that were ACTIVELY running (not human-gated) so a bounce
// doesn't need a manual Resume click. Human-gated phases (a pending question/approval, paused, or
// pre-planner intake) were waiting on a person, so they're left failed for a manual Resume instead.
const AUTO_RESUME_STATES: ReadonlySet<Thread["state"]> = new Set(["planning", "researching", "implementing", "qa"]);
// Crash-loop guard: if a task's resumes keep dying within CRASH_FAST_MS of starting, that's a crash
// loop (not progress) — stop auto-resuming after MAX_FAST_INTERRUPTS such deaths in the window.
const RESTART_LOOP_WINDOW_MS = 15 * 60_000;
const CRASH_FAST_MS = 60_000;
const MAX_FAST_INTERRUPTS = 3;
// Defer the resume so the HTTP/WS listeners are up (and the UI is connected) before agents respawn.
const AUTO_RESUME_DELAY_MS = 4_000;
// Marker prefix on a 'review' task's error when it parked ONLY because every Claude account was
// rate-limited mid-task (no headroom to fail over to). The cap supervisor scans for this prefix and
// auto-resumes those tasks once an account frees up — so a cap wave doesn't leave the owner to
// hand-resume every task. A normal "needs your review" park carries no such prefix and is left alone.
const CAP_PARK_PREFIX = "⏳ Auto-resume pending";
// Don't re-ping the external webhook about auto-resuming the SAME task more often than this — a task
// that keeps re-capping every interval would otherwise flood the channel. The in-app log isn't throttled.
const CAP_RESUME_NOTIFY_COOLDOWN_MS = 30 * 60_000;
// Shared prefix for every "a server restart killed this thread" error, so startResumedImplementor can
// recognise a restart-triggered resume from the thread's persisted error alone.
const RESTART_ERROR_PREFIX = "interrupted by a server restart";
const RESTART_FAILED_MSG = `${RESTART_ERROR_PREFIX} — click Resume to continue from where it left off (finished stages are reused)`;
const RESTART_AUTO_RESUME_MSG = `${RESTART_ERROR_PREFIX} — auto-resuming…`;
// Woven into the resume nudge/seed ONLY when this resume was triggered by a server restart, so the
// worker realizes the restart already happened. Implementor workers are child processes of the
// orchestrator server, so a worker that restarts the orchestrator kills its own session and is then
// auto-resumed by the rebooted server — without this it can wake unaware and restart it AGAIN (a loop).
const RESTART_RESUME_NOTE =
  "⚠️ IMPORTANT — this resume was triggered by a restart of the orchestrator server itself (the " +
  "`claude-orchestrator` service), which you may have just restarted to deploy a change. You are a child " +
  "process of that server, so restarting it killed your previous session and the now-rebooted server " +
  "auto-resumed you on its freshly-built code. The restart has ALREADY completed successfully and the " +
  "server is back up running the new build — do NOT restart it again to deploy. Verify your change is " +
  "live (e.g. hit the API / check the built dist), finish any remaining work, then commit/push and hand off.";
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
// Pipeline phases where a pre-implementor stage owns the task (queued for a slot, planner/researcher
// running, or the approval gate) and NO implementor is live. An inject that lands here is HELD for that
// stage — it must never start an implementor alongside the still-running planner, nor jump a queued task
// past the concurrency cap. The buffered note is folded into the implementor's kickoff once the pipeline
// reaches it. ('awaiting_user' is omitted: a question can also pause a live implementor, where the inject
// belongs to that implementor; the pre-implementor case is caught instead by a live planner handle in
// `liveRole`.)
const PRE_IMPLEMENTOR: ReadonlySet<Thread["state"]> = new Set([
  "queued",
  "intake",
  "enriching",
  "planning",
  "researching",
  "awaiting_approval",
]);
// Soft-close: a closed task stays in the DB (restorable) but off the main board, and is permanently
// purged 30 days after it was closed. The CLOSEABLE set is the only states a task may be closed FROM —
// it excludes the genuinely-running states (implementing/qa/planning/…) AND awaiting_user/
// awaiting_approval (those hold an in-memory resolver promise that closing wouldn't settle).
const CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_SWEEP_MS = 24 * 60 * 60 * 1000;
const CLOSEABLE: ReadonlySet<Thread["state"]> = new Set(["done", "failed", "cancelled", "review", "paused"]);
// Parked states a human can manually accept as finished. 'review' (QA bounced it, or an inject/manual
// resume settled here with no QA loop) and 'paused' are work the owner can sign off on directly — the
// pipeline's own only-QA-marks-done rule never applies to these, so without this they'd be stuck.
const DONEABLE: ReadonlySet<Thread["state"]> = new Set(["review", "paused"]);

export class ThreadManager implements OrchestratorApi {
  private readonly live = new Map<string, LiveImplementor>();
  private readonly activeRuns = new Map<string, Set<AgentRunLike>>();
  // The implementor backend chosen for each thread at the start of its implementor stage (the hard
  // routing gate). Read by startImplementor's provider factory; survives failover/auto-resume so a
  // task never swaps provider mid-run (which would feed a Claude session id to a Codex resume).
  private readonly implementorProvider = new Map<string, ImplementorProvider>();
  // Threads whose Codex `exec resume` has wedged (0% CPU, no output) at least once. Once a thread is
  // here, every later turn skips the resume attempt and starts a fresh Codex session directly — resume
  // keeps wedging on the same interrupted session, so retrying it just burns the 60s startup watchdog
  // and spams the self-heal notice every turn (and historically dropped the QA fix-feedback). Cleared
  // when the thread settles (done/cancel) — a fresh dispatch's first session may resume fine.
  private readonly codexResumeWedged = new Set<string>();
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
  // Images attached to the original dispatch prompt. Every isolated fresh role session must see these
  // in its first SDKUserMessage; keep them separate from later injected images so a resume/inject path
  // cannot replace the dispatch screenshots before the implementor starts.
  private readonly dispatchImages = new Map<string, ImageBlock[]>();
  private readonly threadImages = new Map<string, ImageBlock[]>();
  private readonly pendingApprovals = new Map<string, (d: { approved: boolean; feedback?: string }) => void>();
  // The planner is the only role running during the pre-implementor phase, and it has NO `live`
  // implementor handle — so an inject that arrives then has nothing in `live`/`resuming` to catch it
  // and used to fall through to a resume that double-started an implementor beside the running
  // planner. liveRole holds the steerable planner run so inject can interrupt/re-plan it instead;
  // directorNotes buffers the injected steering until the planner drains it (a re-plan) or the
  // pipeline folds it into the implementor's kickoff.
  private readonly liveRole = new Map<string, AgentRunLike>();
  private readonly directorNotes = new Map<string, string[]>();
  // Per-thread count of consecutive turn-limit auto-resumes inside the current implementor→QA loop.
  // Reset when the loop (re)enters, cleared when it exits, and capped at config.maxAutoResumes so a
  // wedged implementor that keeps hitting the turn ceiling without progress can't spin forever.
  private readonly autoResumes = new Map<string, number>();
  // During QA the implementor is fully stopped (the slot is exclusive — one agent at a time), so the
  // QA agent is the only thing running. An inject must reach THAT QA agent and must never wake/spawn an
  // implementor beside it — that's what put two agents in one slot. liveQa holds the steerable QA run
  // so injectThread's / resumeThread's qa-stage gates can forward steering to it (the next fix-round's
  // re-launched implementor drains anything buffered while QA had no steerable handle).
  private readonly liveQa = new Map<string, AgentRunLike>();
  // Concurrency control. activePipelines holds the threads whose pipeline (dispatch OR resume) is
  // currently executing; a fresh dispatch beyond maxConcurrent waits in dispatchQueue (FIFO) in the
  // 'queued' state and starts when a slot frees. Resumes of in-flight work aren't gated — they
  // continue existing work — but they still count toward the active total.
  private readonly activePipelines = new Set<string>();
  private readonly dispatchQueue: string[] = [];
  // "No invisible workers": each (thread, role) auto-announces itself in the general office room the
  // first time it goes live. Keyed so a failover relaunch / warm resume of the same role doesn't spam,
  // and reset on restart (a resumed agent re-announcing once after a bounce is fine — even welcome).
  private readonly checkedIn = new Set<string>();
  // Threads whose current run gave up to 'review' because every account was capped (no failover
  // headroom). Set the instant the give-up happens, read+cleared when the task settles so the review
  // message carries the CAP_PARK marker the supervisor keys off. In-memory only — the durable signal
  // is the persisted error prefix, so a restart still finds (and resumes) cap-parked tasks.
  private readonly capParked = new Set<string>();
  // Last time we externally announced auto-resuming a given thread — throttles the webhook ping so a
  // task stuck in a re-cap loop doesn't spam the channel each interval (see CAP_RESUME_NOTIFY_COOLDOWN_MS).
  private readonly capResumeNotifiedAt = new Map<string, number>();
  private capSupervisor: NodeJS.Timeout | undefined;
  // One-shot latch for the token-safety auto-stop: set when a crossing fires the stop, cleared once
  // utilization drops back below the threshold — so the stop fires once per crossing, not on every ping
  // while the window stays hot (which would re-stop tasks the owner just re-dispatched).
  private tokenLimitTripped = false;

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    readonly memory: MemoryService,
    readonly accounts: AccountManager,
  ) {
    this.markInterrupted();
    this.applyAccountEnabled();
    // Sweep expired closed tasks on boot, then daily. unref so the timer never holds the process open.
    this.purgeExpiredClosed();
    setInterval(() => this.purgeExpiredClosed(), PURGE_SWEEP_MS).unref();
    this.startCapSupervisor();
    // React to every live usage refresh — the token-safety limit stops running agents when burn crosses
    // the operator threshold. Registered here (before accounts.start() fires the first ping in index.ts).
    this.accounts.onUsageRefresh(() => this.enforceTokenSafetyLimit());
  }

  /** Poll for rate-limit-parked tasks and resume them the moment an account regains headroom, so a
   *  cap wave (every sub at its 5h/weekly limit) doesn't leave the owner to hand-resume each task.
   *  CAP_RETRY_MS=0 disables it (the timer is unref'd, so it never holds the process open). */
  private startCapSupervisor(): void {
    if (config.capRetryMs <= 0) return;
    // A 'review' task isn't auto-resumed on boot (markInterrupted only revives IN_FLIGHT states), so a
    // restart would otherwise strand tasks that were cap-parked before the bounce until the first
    // interval tick. Sweep once shortly after start — after the account pings have had a moment to land
    // (hasHeadroom gates it, so a too-early sweep before the first ping simply no-ops and the interval
    // catches it) — mirroring the boot auto-resume's deferral.
    setTimeout(() => this.resumeCapParked(), AUTO_RESUME_DELAY_MS).unref?.();
    this.capSupervisor = setInterval(() => this.resumeCapParked(), config.capRetryMs);
    this.capSupervisor.unref?.();
  }

  /** Resume tasks parked because all accounts were capped — but only once an account actually has
   *  headroom again, and only enough to fill the FREE concurrency slots (oldest-parked first). Resuming
   *  every parked task at once would bypass the cap and let one freed window get swarmed by N concurrent
   *  implementors that instantly re-cap it; instead we fill the open slots and leave the rest marked, to
   *  be picked up on a later tick as running pipelines settle. A task that re-caps simply re-parks with
   *  the marker; one that fails for any other reason settles WITHOUT the marker and is left alone. Routes
   *  through the same failed→runPipeline path the boot auto-resume uses (full resume-aware pipeline, QA
   *  included), clearing the marker so a later non-cap park isn't misread. */
  private resumeCapParked(): void {
    if (!this.accounts.hasHeadroom()) return;
    let slots = this.settings().maxConcurrent - this.activePipelines.size;
    if (slots <= 0) return;
    const parked = this.db
      .listThreads()
      .filter((t) => t.state === "review" && (t.error ?? "").startsWith(CAP_PARK_PREFIX))
      .sort((a, b) => a.updatedAt - b.updatedAt); // oldest-parked first — fairest, and bounded by free slots
    for (const t of parked) {
      if (slots <= 0) break;
      slots--;
      this.hub.log("info", `An account freed up — auto-resuming rate-limit-parked "${t.title.slice(0, 48)}".`);
      const now = Date.now();
      if (now - (this.capResumeNotifiedAt.get(t.id) ?? 0) > CAP_RESUME_NOTIFY_COOLDOWN_MS) {
        this.capResumeNotifiedAt.set(t.id, now);
        this.notifyExternal(`↪ account freed up — auto-resuming "${t.title}".`);
      }
      // Mirror the boot auto-resume: flip to 'failed' with a null error (no restart note) so resumeThread
      // enters runPipeline and continues from the failure point instead of the QA-less manual-resume path.
      this.db.updateThread(t.id, { state: "failed", error: null });
      const id = t.id;
      void this.resumeThread(id).catch((e) => this.hub.log("error", `Cap auto-resume of ${id.slice(0, 8)} failed: ${String(e)}`));
    }
  }

  /**
   * Token-usage safety limit (opt-in). When live utilization reaches the operator-set threshold, stop
   * every running pipeline and surface a notice. Driven by the AccountManager usage-refresh hook (~10-min
   * ping + window-reset pings) and by setSettings, so it lags a fast burn by minutes — a proactive net
   * layered UNDER the immediate HARD_LIMIT=98 failover, not a hard realtime cutoff. Latched so it fires
   * once per crossing and re-arms only after utilization falls back below the threshold (so the owner can
   * re-dispatch the cancelled tasks without them being instantly stopped again on the next ping).
   */
  private enforceTokenSafetyLimit(): void {
    const { tokenLimitEnabled, tokenLimitPercent } = this.settings();
    const util = this.accounts.effectiveUtilization();
    if (!tokenLimitEnabled || util == null || util < tokenLimitPercent) {
      this.tokenLimitTripped = false; // disabled / no data / back under the line — disarm for the next crossing
      return;
    }
    if (this.tokenLimitTripped) return; // already fired for this crossing
    this.tokenLimitTripped = true;
    void this.stopAllForTokenLimit(util, tokenLimitPercent);
  }

  /** Stop everything that would keep burning the budget through the EXISTING cancel flow (each lands in
   *  'cancelled', re-dispatchable): the running pipelines AND any tasks still queued for a slot — a queued
   *  task left alone would auto-start the instant a stopped pipeline frees its slot (pumpQueue), defeating
   *  the stop. Then warn the console and emit the user-facing notice explaining why. */
  private async stopAllForTokenLimit(util: number, threshold: number): Promise<void> {
    // De-dupe across both sources; cancelThread mutates activePipelines/dispatchQueue as it stops each.
    const targets = [...new Set([...this.activePipelines, ...this.dispatchQueue])];
    const pct = Math.round(util);
    this.hub.log("warn", `Token safety limit reached (${pct}% ≥ ${threshold}%) — stopping ${targets.length} task(s).`);
    for (const id of targets) {
      await this.cancelThread(id).catch((e) => this.hub.log("error", `Token-limit stop of ${id.slice(0, 8)} failed: ${String(e)}`));
    }
    const title = "Token safety limit reached";
    const message =
      targets.length > 0
        ? `Token usage reached ${pct}% (your safety limit is ${threshold}%). ${targets.length} task${targets.length === 1 ? " was" : "s were"} stopped to protect your remaining allowance — they're in Cancelled and can be re-dispatched once a window frees up.`
        : `Token usage reached ${pct}% (your safety limit is ${threshold}%). No tasks were running, so none were stopped.`;
    this.hub.publish({ type: "notice", level: "warn", title, message });
    this.notifyExternal(`🛑 ${title} — ${message}`);
  }

  /** Any task left mid-flight by a server restart is dead in memory — its in-memory AgentRun is gone
   *  even though the DB still has runs as starting/running/idle. Stamp those runs terminal, then
   *  AUTO-RESUME the tasks that were actively running (so a restart doesn't silently end live work and
   *  wait for a manual Resume click — the "auto-resume" half of the failover story). Human-gated and
   *  crash-looping tasks are left failed for a person instead. */
  private markInterrupted(): void {
    // Stamp orphaned runs terminal FIRST, so the crash-loop guard below counts THIS boot's just-killed
    // run when it looks for resumes that keep dying within seconds.
    const at = Date.now();
    for (const r of this.db.listActiveRuns()) {
      this.db.updateRun(r.id, { state: "interrupted", endedAt: r.endedAt ?? at });
    }
    for (const t of this.db.listThreads()) {
      if (!IN_FLIGHT.has(t.state)) continue;
      if (!AUTO_RESUME_STATES.has(t.state)) {
        // Was waiting on a person (question/approval/paused/intake) — leave it for a manual Resume.
        this.db.updateThread(t.id, { state: "failed", error: RESTART_FAILED_MSG });
        continue;
      }
      // Crash-loop guard: count this task's implementor runs that were interrupted within seconds of
      // starting (resume-then-die), recently. Long-lived interrupted runs made progress and don't count.
      const fastInterrupts = this.db
        .listRuns(t.id)
        .filter(
          (r) =>
            r.role === "implementor" &&
            r.state === "interrupted" &&
            r.endedAt != null &&
            at - r.endedAt < RESTART_LOOP_WINDOW_MS &&
            r.endedAt - r.startedAt < CRASH_FAST_MS,
        ).length;
      if (fastInterrupts >= MAX_FAST_INTERRUPTS) {
        this.db.updateThread(t.id, {
          state: "failed",
          error: `Auto-resume stopped — this task kept getting interrupted within seconds of resuming ${fastInterrupts}× (likely a crash loop, not progress). Click Resume to retry once the cause is fixed.`,
        });
        continue;
      }
      // Route through the SAME resume-aware path as a manual Resume: 'failed' is that path's entry
      // state, and runPipeline skips already-finished stages and resumes the implementor session.
      // The persisted RESTART_AUTO_RESUME_MSG error is what startResumedImplementor reads (it survives
      // until the implementor relaunches) to flag this as a restart-triggered resume — so the worker is
      // told the restart already completed and must not restart the orchestrator, which it's a child of,
      // again, the loop these warnings exist for.
      this.db.updateThread(t.id, { state: "failed", error: RESTART_AUTO_RESUME_MSG });
      const id = t.id;
      const title = t.title;
      setTimeout(() => {
        this.hub.log("warn", `Auto-resuming "${title.slice(0, 48)}" after a server restart.`);
        void this.resumeThread(id).catch((e) => this.hub.log("error", `Auto-resume of ${id.slice(0, 8)} failed: ${String(e)}`));
      }, AUTO_RESUME_DELAY_MS);
    }
    // Re-arm any task left 'queued' by the restart: the in-memory dispatch queue starts empty, so
    // without this they'd wait forever. Deferred like the auto-resumes so the listeners are up first;
    // enqueueOrRun re-queues or starts each depending on the live concurrency cap.
    const queued = this.db.listThreads().filter((t) => t.state === "queued");
    if (queued.length) {
      setTimeout(() => {
        // Re-check state at fire time — a queued task could have been cancelled/dismissed during the
        // delay, and enqueueOrRun would otherwise stamp it 'queued' again (resurrecting a dead row).
        for (const t of queued) if (this.db.getThread(t.id)?.state === "queued") this.enqueueOrRun(t.id);
      }, AUTO_RESUME_DELAY_MS);
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

  private track(threadId: string, agent: AgentRunLike): void {
    let set = this.activeRuns.get(threadId);
    if (!set) {
      set = new Set();
      this.activeRuns.set(threadId, set);
    }
    set.add(agent);
  }
  private untrack(threadId: string, agent: AgentRunLike): void {
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
        resolve(`(${config.ownerName} did not answer this in time — proceed using your best judgment, and ask again only if essential.)`);
      }, QUESTION_TIMEOUT_MS);
      this.pendingQuestions.set(q.id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  resolveQuestion(questionId: string, answer: string): boolean {
    const resolver = this.pendingQuestions.get(questionId);
    const q = this.db.answerQuestion(questionId, answer);
    this.hub.publish({ type: "question.resolved", questionId, answer });
    if (q?.threadId) {
      const m = this.db.addMessage({
        threadId: q.threadId,
        role: "director",
        kind: "system",
        content: `↪ replied: ${answer}`,
      });
      this.hub.publish({ type: "thread.message", threadId: q.threadId, message: m });
      this.touchThread(q.threadId);
    }
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
    if (input.images?.length) this.dispatchImages.set(thread.id, input.images.map(toImageBlock));
    this.hub.publish({ type: "thread.upsert", thread });
    this.hub.log("info", `Dispatched task ${thread.id.slice(0, 8)} "${thread.title}"`);
    this.enqueueOrRun(thread.id);
    return thread.id;
  }

  // ---- settings (operator-tunable, persisted in kv, broadcast like approvalMode) ----

  /** The current pipeline settings, read live from kv (defaults when unset). Read at dispatch/pipeline
   *  time so a change applies to the next task — the agent toggles especially are flipped per task. */
  settings(): OrchestratorSettings {
    const key = this.openaiApiKey();
    return {
      plannerEnabled: this.settingBool("setting_planner_enabled", true),
      researcherEnabled: this.settingBool("setting_researcher_enabled", true),
      qaEnabled: this.settingBool("setting_qa_enabled", true),
      autoPush: this.settingBool("setting_auto_push", true),
      maxQaRounds: this.settingNum("setting_max_qa_rounds", config.maxQaRounds, 1, 12),
      maxConcurrent: this.settingNum("setting_max_concurrent", config.maxConcurrent, 1, 20),
      tokenLimitEnabled: this.settingBool("setting_token_limit_enabled", false),
      tokenLimitPercent: this.settingNum("setting_token_limit_percent", 80, 50, 99),
      codexEnabled: this.settingBool("setting_codex_enabled", false),
      codexModel: this.codexModel(),
      hasOpenaiKey: !!key,
      openaiKeyLast4: key && key.length >= 4 ? key.slice(-4) : null,
      codexChatgptLogin: chatgptLoginAvailable(),
    };
  }

  private settingBool(key: string, dflt: boolean): boolean {
    const v = this.db.kvGet(key);
    return v == null ? dflt : v === "1";
  }
  private settingNum(key: string, dflt: number, min: number, max: number): number {
    const v = this.db.kvGet(key);
    const n = v == null ? dflt : Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
  }

  /** The selected Codex model (free-text — any id the OpenAI key can access), or the default if unset. */
  private codexModel(): string {
    return this.db.kvGet("setting_codex_model")?.trim() || config.codex.defaultModel;
  }

  /** The raw OpenAI key: the kv-stored UI value if present, else the server/.env fallback. NEVER
   *  broadcast — only its presence + last 4 chars leave the server (settings()). */
  private openaiApiKey(): string | undefined {
    return this.db.kvGet("openai_api_key")?.trim() || config.codex.envKey;
  }

  /** Persist a partial settings change, broadcast the full new set, and pump the queue (a raised
   *  maxConcurrent may have freed slots). Returns the resulting settings. */
  setSettings(patch: SettingsPatch): OrchestratorSettings {
    if (patch.plannerEnabled !== undefined) this.db.kvSet("setting_planner_enabled", patch.plannerEnabled ? "1" : "0");
    if (patch.researcherEnabled !== undefined) this.db.kvSet("setting_researcher_enabled", patch.researcherEnabled ? "1" : "0");
    if (patch.qaEnabled !== undefined) this.db.kvSet("setting_qa_enabled", patch.qaEnabled ? "1" : "0");
    if (patch.autoPush !== undefined) this.db.kvSet("setting_auto_push", patch.autoPush ? "1" : "0");
    if (patch.maxQaRounds !== undefined) this.db.kvSet("setting_max_qa_rounds", String(patch.maxQaRounds));
    if (patch.maxConcurrent !== undefined) this.db.kvSet("setting_max_concurrent", String(patch.maxConcurrent));
    if (patch.tokenLimitEnabled !== undefined) this.db.kvSet("setting_token_limit_enabled", patch.tokenLimitEnabled ? "1" : "0");
    if (patch.tokenLimitPercent !== undefined) this.db.kvSet("setting_token_limit_percent", String(patch.tokenLimitPercent));
    if (patch.codexEnabled !== undefined) this.db.kvSet("setting_codex_enabled", patch.codexEnabled ? "1" : "0");
    if (patch.codexModel !== undefined && patch.codexModel.trim()) this.db.kvSet("setting_codex_model", patch.codexModel.trim());
    // Write-only key: store the trimmed value, or clear it (empty string) so settings() falls back to
    // the env key (if any). The raw key is never returned to clients — only hasOpenaiKey/last4 are.
    if (patch.openaiApiKey !== undefined) this.db.kvSet("openai_api_key", patch.openaiApiKey.trim());
    const settings = this.settings();
    this.hub.publish({ type: "settings", settings });
    this.pumpQueue();
    // Re-evaluate the token-safety limit now, so enabling it (or lowering the threshold) while already
    // over the line stops running tasks immediately instead of waiting for the next ~10-min usage ping.
    this.enforceTokenSafetyLimit();
    return settings;
  }

  /** Validate the stored (or a just-typed) OpenAI key against the API for the Test-connection button. */
  async testCodexConnection(apiKey?: string): Promise<CodexTestResult> {
    return testOpenAiKey(apiKey?.trim() || this.openaiApiKey());
  }

  /** Restore each Claude account's persisted enabled flag into the live AccountManager on boot. */
  private applyAccountEnabled(): void {
    for (const a of config.accounts) {
      const v = this.db.kvGet(`account_enabled_${a.id}`);
      if (v != null) this.accounts.applyEnabled(a.id, v === "1");
    }
  }

  /** Toggle a Claude account in/out of the dispatch+failover rotation, persisting the flag. Refused
   *  (returns false) when it would disable the last enabled account; either way the accounts strip is
   *  re-broadcast so a refused optimistic toggle snaps back on every client. */
  setAccountEnabled(id: string, enabled: boolean): boolean {
    const applied = this.accounts.setEnabled(id, enabled);
    if (applied) this.db.kvSet(`account_enabled_${id}`, enabled ? "1" : "0");
    this.hub.publish({ type: "accounts", accounts: this.accounts.dto() });
    return applied;
  }

  /** Resolve which backend implements tasks right now from the subscription toggles, or an error
   *  explaining why none can. Codex wins when enabled (it's the opt-in implementor, requires a valid
   *  key); otherwise Claude, gated by its own toggle. Planner/researcher/QA always run on Claude. */
  private resolveImplementorProvider(): { provider?: ImplementorProvider; error?: string } {
    // Codex is the opt-in implementor: when enabled with usable auth it takes over building tasks.
    // Usable auth is EITHER a ChatGPT-plan `codex login` (preferred — no API billing) OR a valid
    // OpenAI API key. Otherwise the implementor is Claude (the default; planner/researcher/QA always are).
    if (this.settings().codexEnabled) {
      const key = this.openaiApiKey();
      const hasKey = !!key && /^sk-/.test(key);
      if (!codexAuthAvailable(hasKey)) {
        return { error: "Codex is enabled but has no usable auth: no ChatGPT `codex login` was found and no valid OpenAI API key (sk-…) is set. Sign in with `codex login --device-auth` (uses your ChatGPT plan), or add an API key under Settings → Subscriptions, or turn Codex off to use Claude." };
      }
      return { provider: "codex" };
    }
    return { provider: "claude" };
  }

  /** Hard routing gate, run once at the start of a thread's implementor stage: resolve + remember the
   *  backend. A blocked routing parks the task (failed) with a clear reason + a finding, returns null. */
  private gateImplementorProvider(thread: Thread): ImplementorProvider | null {
    const { provider, error } = this.resolveImplementorProvider();
    if (!provider) {
      this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "Dispatch blocked by subscription settings", detail: error, severity: "warning" });
      this.setState(thread.id, "failed", error);
      return null;
    }
    this.implementorProvider.set(thread.id, provider);
    return provider;
  }

  // ---- concurrency queue ----

  /** Start a freshly-dispatched task's pipeline now, or hold it in 'queued' if we're at the
   *  concurrency cap. Queued tasks start (FIFO) the moment a running pipeline settles. */
  private enqueueOrRun(threadId: string): void {
    if (this.activePipelines.size >= this.settings().maxConcurrent) {
      if (!this.dispatchQueue.includes(threadId)) this.dispatchQueue.push(threadId);
      this.setState(threadId, "queued");
      this.hub.log("info", `Task ${threadId.slice(0, 8)} queued — ${this.activePipelines.size} pipeline(s) at the concurrency cap.`);
      return;
    }
    this.startPipeline(threadId);
  }

  /** Named seam for the two queue call sites. runPipeline itself reserves the concurrency slot (at its
   *  top) and releases it + pumps the queue (in its finally), so this is just `void runPipeline`. */
  private startPipeline(threadId: string): void {
    void this.runPipeline(threadId);
  }

  /** Start queued tasks while slots are free (a pipeline settled, or maxConcurrent was raised). Skips
   *  entries no longer in 'queued' — cancelled/dismissed while waiting. */
  private pumpQueue(): void {
    const cap = this.settings().maxConcurrent;
    while (this.dispatchQueue.length && this.activePipelines.size < cap) {
      const id = this.dispatchQueue.shift()!;
      if (this.db.getThread(id)?.state !== "queued") continue;
      this.startPipeline(id);
    }
  }

  private dropFromQueue(threadId: string): void {
    const i = this.dispatchQueue.indexOf(threadId);
    if (i >= 0) this.dispatchQueue.splice(i, 1);
  }

  /** Wrap a role's kickoff text with the thread's pasted images so each isolated agent sees them. */
  private kickoffContent(threadId: string, text: string): string | unknown[] {
    const blocks = [...(this.dispatchImages.get(threadId) ?? []), ...(this.threadImages.get(threadId) ?? [])];
    return contentWithImages(text, blocks);
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
    // A cap-park lands in 'review' too, but it's auto-handled by the supervisor — don't ping "needs your
    // review" (misleading, and it would re-fire every time a re-capping task re-parks).
    else if (state === "review" && !(t.error ?? "").startsWith(CAP_PARK_PREFIX)) this.notifyExternal(`⚠ needs your review: "${t.title}"`);
    else if (state === "failed") this.notifyExternal(`✗ failed: "${t.title}"${t.error ? ` — ${t.error}` : ""}`);
  }

  /** Settle a task to 'review' after an incomplete run. If the run gave up ONLY because every account
   *  was capped (the `capParked` flag), tag it with the CAP_PARK marker so the supervisor auto-resumes
   *  it when an account frees up; otherwise use the human-facing reason (a genuine needs-your-eyes park).
   *  The flag is consumed here so it never leaks into an unrelated later settle of the same thread. */
  private settleReview(threadId: string, humanReason: string): void {
    if (this.capParked.delete(threadId)) this.setState(threadId, "review", this.capParkMessage());
    else this.setState(threadId, "review", humanReason);
  }

  /** Review message for a cap-park — doubles as the supervisor's marker (CAP_PARK_PREFIX) and tells the
   *  owner it'll resume itself, naming when the soonest account frees up if we know it. */
  private capParkMessage(): string {
    const reset = this.accounts.soonestResetAt();
    const when = reset ? ` Soonest account resets ${untilReset(reset, Date.now())}.` : "";
    return `${CAP_PARK_PREFIX} — every account was rate-limited mid-task.${when} It will resume automatically when one frees up (no manual Resume needed).`;
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
  private async runPipeline(threadId: string, directorNote?: string): Promise<void> {
    const thread = this.db.getThread(threadId);
    if (!thread) return;
    this.activePipelines.add(threadId);
    const releaseSlot = () => {
      this.activePipelines.delete(threadId);
      this.pumpQueue();
    };
    if (!existsSync(thread.workspace)) {
      this.setState(threadId, "failed", `Workspace "${thread.workspace}" does not exist on disk — agents can't run there. Re-dispatch with a valid path.`);
      releaseSlot();
      return;
    }
    const settings = this.settings();
    const saved = this.db.getThreadStageOutputs(threadId);
    try {
      // A persisted kickoff means this task already cleared the whole pre-implementor phase (planner +
      // any researcher + approval) in an earlier run and reached the implementor. A resume must NOT
      // re-run the planner/researcher and clobber that work — not even if an older build never persisted
      // planDone (the exact "planner re-ran after a restart" bug). So treat planning as settled whenever
      // a kickoff exists, independent of the per-stage *Done flags.
      const planningSettled = saved.kickoff != null;

      // 1. Planner — runs first unless disabled, already done, or planning already completed. planDone
      // (mirrors researchDone) makes a deliberate "no structured plan" outcome sticky across resume.
      // When the planner is disabled the implementor runs straight from the brief (composeKickoff notes it).
      let plan = saved.plan ?? undefined;
      if (!planningSettled && !saved.planDone) {
        if (settings.plannerEnabled) {
          this.setState(threadId, "planning");
          plan = await this.runPlanner(thread).catch((e) => {
            this.hub.log("warn", `Planner failed on ${threadId.slice(0, 8)}: ${String(e)}`);
            return undefined;
          });
          if (this.cancelled(threadId)) return;
        } else {
          this.hub.log("info", `Planner disabled — ${threadId.slice(0, 8)} skips planning, straight to the implementor.`);
        }
        // Persist planDone even when the planner was SKIPPED (disabled), so a later resume — including
        // one after the toggle is flipped back on — never re-runs it.
        this.db.updateThreadStageOutputs(threadId, { plan: plan ?? null, planDone: true });
      }

      // 2. Researcher — only when the planner routed to it (external info needed). Always →
      //    implementor afterward. researchDone (and a settled-planning resume) guard against re-running it.
      let research = saved.research ?? undefined;
      if (!planningSettled && settings.researcherEnabled && plan?.nextAgent === "researcher" && !saved.researchDone) {
        this.setState(threadId, "researching");
        research = await this.runResearcher(thread, plan).catch((e) => {
          this.hub.log("warn", `Researcher failed on ${threadId.slice(0, 8)}: ${String(e)}`);
          return undefined;
        });
        if (this.cancelled(threadId)) return;
        this.db.updateThreadStageOutputs(threadId, { research: research ?? null, researchDone: true });
      }

      // 3. Approval gate — after the full context (plan + any research) exists, so the human sees
      //    everything before approving. Skipped on resume if already approved. Reuse the saved kickoff
      //    when planning already happened so a re-derivation can't strip a real plan down to "no plan".
      const kickoff = saved.kickoff ?? composeKickoff(thread, plan, research, { autoPush: settings.autoPush, qaEnabled: settings.qaEnabled });
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
      //    Any director notes injected after the planner finished (during research or at the approval
      //    gate, where there was no planner to re-plan) are folded in here so they still reach the
      //    implementor instead of being dropped.
      const buffered = this.directorNotes.get(threadId);
      this.directorNotes.delete(threadId);
      const note = [directorNote, ...(buffered ?? [])].filter((s): s is string => Boolean(s)).join("\n\n") || undefined;
      await this.runImplementorQa(thread, kickoff, plan?.effort, this.latestImplementorSession(threadId), note, {
        qaEnabled: settings.qaEnabled,
        maxQaRounds: settings.maxQaRounds,
      });
    } catch (err) {
      if (!this.cancelled(threadId)) this.setState(threadId, "failed", err instanceof Error ? err.message : String(err));
    } finally {
      // Every role's kickoff has been built by now; free the base64 blocks. A live
      // implementor still remembers them, and a later resume reloads them from its
      // session, so dropping them here doesn't blind anything.
      this.dispatchImages.delete(threadId);
      this.threadImages.delete(threadId);
      // Safety net: drop any held notes that an early return (e.g. a rejected plan) left behind, so
      // they can't leak into an unrelated later run of this thread.
      this.directorNotes.delete(threadId);
      releaseSlot();
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

  /** Which backend produced the most recent implementor session for a thread — derived from the run's
   *  account label ("codex:…" ⇒ Codex). A session id is provider-specific (a Claude SDK session vs a
   *  Codex thread id), so a resume must only reuse one whose backend matches the now-resolved provider. */
  private priorImplementorProvider(threadId: string): ImplementorProvider | undefined {
    const run = this.db
      .listRuns(threadId)
      .filter((r) => r.role === "implementor" && r.sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!run) return undefined;
    return run.account?.startsWith("codex:") ? "codex" : "claude";
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
      this.officeCheckIn(thread.id, role);
      this.ensureGroup(thread.id);
      // The planner and QA are each steerable mid-flight via their own handle, because each runs while
      // NO implementor is active in the slot: a planning inject must reshape the plan (liveRole, drained
      // into a re-plan); a QA inject must reach the running QA agent (liveQa) and NOT wake/spawn an
      // implementor — during QA the implementor is fully stopped and re-launched only for a fix-round.
      // (Researcher-phase notes flow forward into the implementor's kickoff instead.)
      if (role === "planner") this.liveRole.set(thread.id, agent);
      if (role === "qa") this.liveQa.set(thread.id, agent);
      agent.start(message);
      let res = await agent.result();
      if (role === "planner" && res && !res.isError) res = await this.drainDirectorNotes(thread, agent, res);
      if (role === "planner") this.liveRole.delete(thread.id);
      if (role === "qa") this.liveQa.delete(thread.id);
      await agent.stop();
      this.untrack(thread.id, agent);
      this.finishRun(run.id, res, agent);
      if ((res && !res.isError) || this.cancelled(thread.id) || !agent.rateLimited) return res;
      const next = this.failoverAccount(acct.id);
      // QA is the only runRole role whose cap settles the task to 'review' (a planner/researcher cap
      // degrades to no-plan/no-research and proceeds). Flag it so that settle tags it for the supervisor.
      if (!next) {
        if (role === "qa") this.capParked.add(thread.id);
        return res;
      }
      this.logFailover(thread, role, next.label, agent.rateLimitInfo);
      acct = next;
      resume = agent.sessionId;
      message = "Your session was switched to another account after a usage limit. Continue exactly where you left off and finish.";
    }
    // Loop exhausted MAX_ACCOUNT_FAILOVERS via repeated cap-failovers (the only fall-through path). For
    // QA — the one runRole role whose cap parks the task — flag it so the settle tags it for the supervisor.
    if (role === "qa") this.capParked.add(thread.id);
    return undefined;
  }

  /** Before the planner hands off, fold in any steering the director injected while it was running:
   *  re-run the planner with the note(s) so the plan — and everything downstream — reflects them,
   *  instead of letting the pipeline march an implementor off a now-stale plan. Loops until the buffer
   *  is empty (a note can arrive during the re-plan too). Returns the latest structured result. */
  private async drainDirectorNotes(thread: Thread, agent: AgentRunLike, res: ResultEvent | undefined): Promise<ResultEvent | undefined> {
    while (!this.cancelled(thread.id) && !agent.rateLimited) {
      const notes = this.directorNotes.get(thread.id);
      if (!notes?.length) break;
      this.directorNotes.delete(thread.id);
      this.hub.log("info", `Re-planning ${thread.id.slice(0, 8)} with ${notes.length} injected note(s) before the implementor starts.`);
      agent.send(
        `[New information from the director — revise your plan to account for this, then re-emit your structured plan]\n${notes.join("\n\n")}`,
        { priority: "now" },
      );
      const next = await agent.nextResult();
      if (!next) break;
      res = next;
      if (res.isError) break;
    }
    return res;
  }

  private async runPlanner(thread: Thread): Promise<PlanOutput | undefined> {
    const res = await this.runRole(thread, "planner", config.models.planner, this.kickoffContent(thread.id, thread.brief), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "planner", getRunId: () => runId });
      const office = createOfficeServer(this, { threadId: thread.id, role: "planner", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
      const cfg = plannerConfig(thread.workspace, { bus, office });
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
      const office = createOfficeServer(this, { threadId: thread.id, role: "researcher", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
      const cfg = researcherConfig(thread.workspace, { bus, memory, office });
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
        const office = createOfficeServer(this, { threadId: thread.id, role: "qa", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
        const cfg = qaConfig(thread.workspace, { bus, office });
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
    opts?: { resume?: string; effort?: Effort; account?: Acct; freshFallback?: string },
  ): { run: AgentRunLike; runId: string; accountId: string } {
    this.setState(thread.id, "implementing");
    // Coerce a gated `xhigh` down to `high` here too, so the stored/displayed effort matches what the
    // implementor actually runs at (implementorConfig applies the same gate before the SDK call).
    const effort = resolveEffort(opts?.effort);
    // Provider factory: the routing gate (gateImplementorProvider) stored the backend for this thread.
    // Codex runs the CLI (no Claude account/oauth); Claude runs the SDK on a selected subscription.
    const provider = this.implementorProvider.get(thread.id) ?? "claude";
    let agent: AgentRunLike;
    let runId: string;
    let accountId: string;
    // The standing implementor doctrine (commit/push/myaccount, no half-measures) reaches the Claude backend
    // via its SDK system prompt; the Codex CLI gets no system prompt from us, so prepend it to a FRESH
    // Codex kickoff (resume turns retain it through the resumed Codex thread). Without this a Codex run
    // patches the working tree and stops, never committing — breaking the implementor→commit contract.
    let startKickoff = kickoff;
    if (provider === "codex") {
      const model = this.codexModel();
      accountId = "openai-codex";
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: `codex:${model}`, effort });
      runId = run.id;
      this.emitRun(run.id);
      // The Codex CLI is a separate process; the in-process bus MCP server can't attach to it, so a
      // Codex implementor runs without post_finding/ask_user/read_findings (and no office chat) — a
      // documented degradation. The QA loop still reviews its output, and the doctrine makes it commit.
      // A fresh start still gets the doctrine + (toolless) peer heads-up so it knows to avoid collisions.
      if (!opts?.resume) startKickoff = [CODEX_IMPLEMENTOR_DOCTRINE, kickoff, this.peerNote(thread, false)].filter(Boolean).join("\n\n");
      // freshFallback lets the runner self-heal a wedged `exec resume` (hangs at 0% CPU on an interrupted
      // gpt-5 session) by restarting fresh — so it must carry the SAME doctrine + task a fresh start gets.
      const codexAgent = new CodexAgentRun({ model, cwd: thread.workspace, apiKey: this.openaiApiKey() ?? "", resume: opts?.resume, freshFallback: opts?.freshFallback });
      // If this run had to self-heal a wedged resume, remember it so every later turn skips the resume
      // attempt (and its 60s watchdog) and goes straight to fresh — resume keeps wedging on this thread.
      codexAgent.onEnd(() => { if (codexAgent.resumeHealed) this.codexResumeWedged.add(thread.id); });
      agent = codexAgent;
    } else {
      const acct = opts?.account ?? this.dispatchAccount();
      accountId = acct.id;
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model: config.models.implementor, account: acct.label, effort });
      runId = run.id;
      this.emitRun(run.id);
      const bus = createBusServer(this, { threadId: thread.id, role: "implementor", getRunId: () => run.id });
      const office = createOfficeServer(this, { threadId: thread.id, role: "implementor", workspace: thread.workspace, title: thread.title, getRunId: () => run.id });
      const cfg = implementorConfig(thread.workspace, { bus, office }, { resume: opts?.resume, effort });
      cfg.oauthToken = acct.token;
      // On a fresh start, fold in a heads-up naming any teammates already live in this repo so the
      // implementor coordinates from turn one (a resumed session already saw the office context).
      if (!opts?.resume) {
        const note = this.peerNote(thread, true);
        if (note) startKickoff = `${kickoff}\n\n${note}`;
      }
      agent = new AgentRun(cfg);
    }
    this.wireRun(agent, thread.id, runId, "implementor", accountId);
    this.live.set(thread.id, { run: agent, runId, accountId });
    this.track(thread.id, agent);
    this.officeCheckIn(thread.id, "implementor");
    this.ensureGroup(thread.id);
    agent.onEvent((e) => {
      if (e.type === "init" && e.sessionId) this.lastImplementorSession.set(thread.id, e.sessionId);
    });
    agent.onEnd(() => {
      // Only clear the live handle if it's still THIS run — a failover relaunch may have already
      // replaced it before this (dead) run's end fires, and we must not clobber the new handle.
      if (this.live.get(thread.id)?.run === agent) this.live.delete(thread.id);
      this.untrack(thread.id, agent);
      this.stopping.delete(thread.id);
      this.finalizeRun(runId, agent);
    });
    // Wrap pasted images into the kickoff only when STARTING a fresh session. On a resume the prior
    // session already holds them in context, so re-attaching the base64 would re-bill vision tokens
    // for no gain (and a failover can relaunch several times). Both backends honor the image blocks —
    // Claude natively, Codex by materializing them to temp files and attaching via `codex --image`.
    agent.start(opts?.resume ? kickoff : this.kickoffContent(thread.id, startKickoff));
    return { run: agent, runId, accountId };
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
    // Re-derive the restart signal from the thread's PERSISTED error at this single resume chokepoint,
    // so both the warm nudge and the cold seed tell the worker the restart already completed (don't
    // restart again). A server-restart interruption stamps RESTART_ERROR_PREFIX, and that error survives
    // until startImplementor (below) flips the state, so every resume that skips finished stages reaches
    // here with it still set. Reading fresh means no in-memory flag to leak or mis-fire on a later resume.
    const restartNote = this.db.getThread(thread.id)?.error?.startsWith(RESTART_ERROR_PREFIX) ? RESTART_RESUME_NOTE : undefined;
    if (restartNote) this.hub.log("info", `Resume on ${thread.id.slice(0, 8)} carries the restart-already-completed notice (won't restart again).`);
    // The resolved backend can differ from the one that produced this session id if the provider was
    // toggled across a restart (implementorProvider is in-memory, re-derived from CURRENT settings here).
    // A session id is provider-specific, so feeding a Codex thread id to a Claude resume (or vice versa)
    // would be invalid — discard the incompatible session and start fresh on the resolved backend instead.
    const resolvedProvider = this.implementorProvider.get(thread.id) ?? "claude";
    if (resumeSession && this.priorImplementorProvider(thread.id) !== resolvedProvider) {
      this.hub.log("warn", `Resume on ${thread.id.slice(0, 8)}: implementor backend changed to ${resolvedProvider} since the prior session — its session id is incompatible, starting fresh.`);
      resumeSession = undefined;
    }
    if (!resumeSession) {
      const extras = [restartNote, opts.directorNote && `[New information from the director]\n${opts.directorNote}`].filter(Boolean);
      const text = extras.length ? `${baseKickoff}\n\n${extras.join("\n\n")}` : baseKickoff;
      return this.startImplementor(thread, text, { effort: opts.effort, account: opts.account });
    }
    // Codex resumes by its own thread id via `codex exec resume <id>` — there is no local Claude
    // transcript to age-check or Haiku-compress, so the warm/cold gate below (keyed on transcript mtime)
    // would always fall to the cold path and start a FRESH Codex run, throwing away the prior session.
    // Resume the Codex thread directly with the nudge/note as the new turn's prompt.
    if (resolvedProvider === "codex") {
      const parts = [
        restartNote,
        opts.resumeNudge,
        opts.directorNote && opts.directorNote !== opts.resumeNudge && `[New information from the director]\n${opts.directorNote}`,
      ].filter(Boolean);
      const continuation = parts.join("\n\n");
      // The fresh-start kickoff used both when resume wedges (runner self-heal) AND when we skip resume
      // outright (below). It MUST carry this turn's continuation (the QA fix-feedback / nudge), not just
      // the original task — otherwise the fresh session re-runs the original task WITHOUT the requested
      // fixes, QA keeps bouncing it, and the task eventually fails. The prior edits live in the working
      // tree, so the fresh session re-reads them and applies the feedback on top.
      const freshKickoff = [CODEX_IMPLEMENTOR_DOCTRINE, baseKickoff, this.peerNote(thread, false), continuation].filter(Boolean).join("\n\n");
      // Codex resume already wedged for this thread → don't pay the 60s watchdog + self-heal spam again;
      // start fresh directly. (startImplementor with no `resume` re-prepends doctrine + peerNote, so pass
      // just task + continuation here to avoid duplicating them.)
      if (this.codexResumeWedged.has(thread.id)) {
        this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: Codex resume previously wedged — starting a fresh session directly.`);
        const freshText = [baseKickoff, continuation].filter(Boolean).join("\n\n");
        return this.startImplementor(thread, freshText, { effort: opts.effort, account: opts.account });
      }
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: resuming the Codex session ${resumeSession.slice(0, 8)} via the CLI.`);
      return this.startImplementor(thread, continuation, { effort: opts.effort, resume: resumeSession, account: opts.account, freshFallback: freshKickoff });
    }
    const ageMs = sessionAgeMs(resumeSession);
    const warm = ageMs != null && ageMs < config.resumeWarmMinutes * 60_000;
    if (config.resumeFullSession || warm) {
      const why = config.resumeFullSession ? "forced" : `cache likely warm (${Math.round((ageMs ?? 0) / 60000)}m < ${config.resumeWarmMinutes}m)`;
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: full session resume — ${why}.`);
      // Only append the director note when it adds something beyond the nudge — on a manual resume
      // the nudge already IS the user's message, so passing it again would duplicate it.
      // restartNote first: it's CONTEXT about what just happened, not a task, so the actionable nudge /
      // director instruction stays the freshest (last) thing the model reads — matching the cold seed,
      // where composeResumeKickoff also pushes the restart note ahead of the director note.
      const parts = [
        restartNote,
        opts.resumeNudge,
        opts.directorNote && opts.directorNote !== opts.resumeNudge && `[New information from the director]\n${opts.directorNote}`,
      ].filter(Boolean);
      return this.startImplementor(thread, parts.join("\n\n"), { effort: opts.effort, resume: resumeSession, account: opts.account });
    }
    // Cold cache: composeResumeKickoff compresses the prior session (Haiku + git) and logs how. This
    // is the only awaited step, so re-check cancellation after it before spending an Opus start.
    const seed = await this.composeResumeKickoff(thread, baseKickoff, resumeSession, {
      directorNote: opts.directorNote,
      qaFollows: opts.qaFollows,
      restartNote,
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
    current: AgentRunLike,
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
      // No account with headroom (vs. a missing session) means a cap parked this — flag it so the
      // settle tags it for the supervisor, which resumes the task once an account frees up.
      if (!next && current.rateLimited) this.capParked.add(thread.id);
      if (!next || !sessionId) return undefined;
      this.logFailover(thread, "implementor", next.label, current.rateLimitInfo);
      await current.stop();
      const relaunch = this.startImplementor(thread, continueMsg, { resume: sessionId, effort, account: next });
      current = relaunch.run;
      currentAccountId = relaunch.accountId;
      useNext = false;
    }
    // Reaching here means the loop exhausted MAX_ACCOUNT_FAILOVERS via repeated cap-failovers (the only
    // path that falls through — every other outcome returns inside the loop). Each fresh account also
    // capped, so this is still a cap-park: flag it so the settle tags it for the supervisor rather than
    // mis-parking it as a needs-human review that never auto-resumes.
    if (current.rateLimited) this.capParked.add(thread.id);
    return undefined;
  }

  /**
   * Await the implementor's result, but transparently CONTINUE it when the run ended only because it
   * hit the per-session turn ceiling (subtype "error_max_turns") mid-task — the bug this fixes: the
   * implementor said "doing that now", the SDK cut it off at the turn cap, and the task parked on a
   * manual Resume button. A turn-limit stop is always involuntary (a genuine finish ends with success),
   * so we relaunch the warm session and keep going until it really finishes, is cancelled, looks done,
   * or the auto-resume cap is reached — at which point `res` flows into the unchanged QA/review logic.
   *
   * Relaunch = stop the maxed-out query, then warm-resume its session in a FRESH query. maxTurns is a
   * per-query ceiling ("max turns before the query stops"), and num_turns does NOT reset within a still-
   * open streaming-input query — so steering the same query in place would instantly re-hit the exceeded
   * cap with zero forward progress. A fresh resume query starts num_turns at 0, giving a real budget to
   * advance the work. This is exactly the path the rate-limit failover already uses (stop → resume).
   */
  private async awaitImplementorCompletion(
    thread: Thread,
    effort: Effort | undefined,
    kickoff: string,
    run: AgentRunLike,
    accountId: string,
    useNext: boolean,
    continueMsg: string,
  ): Promise<ResultEvent | undefined> {
    let res = await this.awaitImplementorResult(thread, effort, run, accountId, useNext, continueMsg);
    let current = run;
    while (
      (this.isTurnLimitStop(res) || this.implementorStalled(thread.id, res)) &&
      !this.cancelled(thread.id) &&
      !this.implementorLooksDone(thread.id) &&
      (this.autoResumes.get(thread.id) ?? 0) < config.maxAutoResumes
    ) {
      const session = this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id);
      if (!session) break; // no session to resume from — fall through to the QA/review handling
      const n = (this.autoResumes.get(thread.id) ?? 0) + 1;
      this.autoResumes.set(thread.id, n);
      // Two involuntary-park cases share this resume: a turn-ceiling cutoff (error_max_turns) and a
      // voluntary stall (the agent ended its turn promising to "confirm once it finishes"). Both leave
      // the task waiting on a wake-up that never comes; the only difference is which nudge we send.
      const turnLimit = this.isTurnLimitStop(res);
      this.logAutoResume(thread.id, n, turnLimit ? "turn limit hit" : "ended its turn without finishing");
      const nudge = turnLimit
        ? "You haven't finished — you stopped at a turn limit, not because the work is done. Continue exactly " +
          "where you left off and complete the task. A QA agent will review your work when you're genuinely done."
        : STALL_NUDGE;
      // Close the turn-maxed query before resuming so we never run two implementors on one workspace;
      // startImplementor's onEnd guard tolerates the relaunch replacing `this.live` first either way.
      await current.stop();
      if (this.cancelled(thread.id)) break;
      const start = await this.startResumedImplementor(thread, kickoff, session, {
        effort,
        resumeNudge: nudge,
        qaFollows: true,
      });
      if (!start) break; // cancelled while compressing the prior session
      this.flushDirectorNotes(thread.id, start.run);
      current = start.run;
      res = await this.awaitImplementorResult(thread, effort, start.run, start.accountId, false, nudge);
    }
    return res;
  }

  /** A turn-ceiling cutoff (vs. a genuine finish, a usage cap, or a crash) — the only stop we silently
   *  resume. Backed by a set so future involuntary-cutoff subtypes can be added in one place. */
  private isTurnLimitStop(res: ResultEvent | undefined): boolean {
    return !!res && res.isError && LIMIT_SUBTYPES.has(res.subtype);
  }

  /** Whether the implementor's most recent text message reads as a genuine completion rather than a
   *  mid-thought cutoff. Used as a secondary guard so that even on a turn-limit stop we DON'T auto-resume
   *  when the agent clearly signalled it was done — and (deliberately strict) we DO resume on anything
   *  forward-looking ("doing that now"), because a missed resume costs a manual click while an extra warm
   *  resume of an already-done task is cheap and harmless. */
  private implementorLooksDone(threadId: string): boolean {
    const last = this.db.lastMessageOf(threadId, "implementor", "text");
    return !!last && IMPLEMENTOR_DONE_RE.test(last.content.slice(-600).toLowerCase());
  }

  /** Whether the implementor's run ended VOLUNTARILY (a success result — not a turn-ceiling cutoff or a
   *  usage cap, both handled elsewhere) while its last words only promised to confirm/continue later: the
   *  "I'll confirm once it finishes" stall that parks the task waiting for a wake-up that never comes. A
   *  genuine completion is excluded, so we auto-resume only the stalls — nudging the agent to block in-turn. */
  private implementorStalled(threadId: string, res: ResultEvent | undefined): boolean {
    if (!res || res.isError) return false;
    const last = this.db.lastMessageOf(threadId, "implementor", "text");
    if (!last) return false;
    const tail = last.content.slice(-700).toLowerCase().replace(/’/g, "'");
    return IMPLEMENTOR_STALL_RE.test(tail) && !IMPLEMENTOR_DONE_RE.test(tail);
  }

  /** Surface an auto-resume both in the global activity log and as a system line in the task feed, so the
   *  continuation is visible without the user ever touching the Resume button. `reason` distinguishes a
   *  turn-limit cutoff from a voluntary "promised to confirm later" stall. */
  private logAutoResume(threadId: string, n: number, reason: string): void {
    const text = `Auto-resuming implementor (${reason}, continuing… ${n}/${config.maxAutoResumes})`;
    this.hub.log("info", text);
    const m = this.db.addMessage({ threadId, role: "implementor", kind: "system", content: `↻ ${text}` });
    this.hub.publish({ type: "thread.message", threadId, message: m });
  }

  /** Implementor → QA → fix, repeated until QA passes or we run out of rounds. The live
   *  implementor is stopped on every exit so a finished/parked task stops counting as live;
   *  later injects fall back to the resume path (lastImplementorSession). */
  private async runImplementorQa(
    thread: Thread,
    kickoff: string,
    effort?: Effort,
    resumeSession?: string,
    directorNote?: string,
    pipe: PipeOpts = { qaEnabled: true, maxQaRounds: config.maxQaRounds },
  ): Promise<void> {
    // Hard routing gate — resolve + remember the implementor backend from the subscription toggles.
    // A blocked routing (provider off / Codex without a valid key) parks the task here, before any
    // agent spawns. Covers every fresh dispatch and pipeline resume (both reach here via runPipeline).
    if (!this.gateImplementorProvider(thread)) return;
    try {
      await this.runImplementorQaLoop(thread, kickoff, effort, resumeSession, directorNote, pipe);
    } finally {
      this.autoResumes.delete(thread.id);
      this.implementorProvider.delete(thread.id);
      this.codexResumeWedged.delete(thread.id);
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
    opts?: { directorNote?: string; qaFollows?: boolean; restartNote?: string },
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
        ? // auxToken() is a read-only token grab — it must NOT run the dispatch selector (which would
          // bump round-robin state and flicker the "active account" badge for a non-dispatch).
          compressSession(sessionId, this.accounts.auxToken()).catch((e) => {
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
    if (opts?.restartNote) {
      parts.push(opts.restartNote, "");
    }
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
        ? `When the work is complete, commit and push per the doctrine (${config.ownerName} will then review it).`
        : "A QA agent will review your work when you're done.";
    parts.push(
      "## Current workspace progress (git)",
      progress,
      "",
      `Continue from here against the plan above: re-read any current file you need (contents may have changed since the handoff), finish the remaining work, and don't redo what's already done. ${tail}`,
    );
    return parts.join("\n");
  }

  private async runImplementorQaLoop(
    thread: Thread,
    kickoff: string,
    effort?: Effort,
    resumeSession?: string,
    directorNote?: string,
    pipe: PipeOpts = { qaEnabled: true, maxQaRounds: config.maxQaRounds },
  ): Promise<void> {
    this.autoResumes.set(thread.id, 0);
    this.capParked.delete(thread.id); // fresh run — drop any stale cap flag from a prior attempt
    const start = await this.startResumedImplementor(thread, kickoff, resumeSession, {
      effort,
      resumeNudge: pipe.qaEnabled
        ? "Your session was resumed after an interruption (a crash or server restart). Continue exactly where you left off and finish the task completely. A QA agent will review your work when you're done."
        : "Your session was resumed after an interruption (a crash or server restart). Continue exactly where you left off and finish the task completely. QA review is disabled for this task — verify your own work, then commit per the doctrine.",
      // A steering note from the Resume/inject that re-entered the pipeline — delivered to the
      // implementor (woven into the seed/kickoff or sent with the nudge) so it isn't silently lost.
      directorNote,
      qaFollows: pipe.qaEnabled,
    });
    if (!start) return; // cancelled while compressing the prior session for the resume
    // A cold resume compresses the prior session first (an await), and runPipeline already folded the
    // notes that existed before that into the kickoff. Any note injected DURING that window was buffered
    // (state was still pre-implementor) after the fold — deliver it now that the implementor is live, so
    // it isn't stranded in the buffer. Notes arriving after this point hit the live-inject path directly.
    this.flushDirectorNotes(thread.id, start.run);
    let res = await this.awaitImplementorCompletion(
      thread,
      effort,
      kickoff,
      start.run,
      start.accountId,
      false,
      "Continue exactly where you left off and finish the task completely.",
    );

    // QA disabled — the implementor's output is final. A clean finish goes straight to 'done'
    // (the only non-QA path to 'done' besides a manual markDone); an incomplete one parks for review.
    if (!pipe.qaEnabled) {
      if (this.cancelled(thread.id)) return;
      if (res && !res.isError) {
        this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "Implementor finished — QA review is disabled, accepted as done.", severity: "info" });
        this.setState(thread.id, "done");
      } else {
        this.settleReview(thread.id, "Implementor ended without completing — needs your review (QA is disabled for this task).");
      }
      return;
    }

    for (let round = 1; round <= pipe.maxQaRounds; round++) {
      if (this.cancelled(thread.id)) return;
      if (!res) {
        this.settleReview(thread.id, "Implementor ended without completing — needs your review.");
        return;
      }
      this.setState(thread.id, "qa");
      // Fully end the implementor BEFORE QA so only one agent is ever active in the pipeline slot.
      // Flipping to "qa" first means any inject/resume landing during the stop routes to the QA gate
      // (checked ahead of the this.live branch in injectThread/resumeThread) instead of waking the
      // about-to-be-stopped implementor. stopLive closes its query → onEnd clears this.live and
      // finalizes the run, so this.live stays empty for the whole QA stage; the session id survives in
      // lastImplementorSession for the fix-round resume.
      await this.stopLive(thread.id);
      const qa = await this.runQA(thread, { round }).catch((e) => {
        this.hub.log("warn", `QA failed on ${thread.id.slice(0, 8)}: ${String(e)}`);
        return undefined;
      });
      if (this.cancelled(thread.id)) return;

      if (!qa) {
        this.postFinding({ threadId: thread.id, fromRole: "qa", summary: "QA could not complete — needs your review", severity: "warning" });
        this.settleReview(thread.id, "QA could not complete — needs your review.");
        return;
      }
      if (qa.pass) {
        this.postFinding({ threadId: thread.id, fromRole: "qa", summary: `QA passed: ${qa.summary}`, severity: "info" });
        this.setState(thread.id, "done");
        return;
      }
      if (round >= pipe.maxQaRounds) {
        this.postFinding({
          threadId: thread.id,
          fromRole: "qa",
          summary: `QA still not satisfied after ${pipe.maxQaRounds} rounds — needs your review`,
          detail: qa.summary,
          severity: "warning",
        });
        // A genuine "QA isn't satisfied" park — route through settleReview so the one review-settle that
        // would otherwise bypass it can't leak a stale cap flag into a false-positive auto-resume.
        this.settleReview(thread.id, `QA still not satisfied after ${pipe.maxQaRounds} rounds — needs your review.`);
        return;
      }

      this.postFinding({ threadId: thread.id, fromRole: "qa", summary: `QA round ${round}: ${qa.summary}`, severity: "note" });
      // Drain any director note buffered during the QA stage (a forwarded-to-QA inject that hit the
      // mid-QA failover window, or a resume-during-QA inject) into the fix message so it reaches the
      // implementor when IT is the one running again — never alongside QA, never stranded.
      const qaNotes = this.directorNotes.get(thread.id);
      this.directorNotes.delete(thread.id);
      const noteBlock = qaNotes?.length ? `\n\n[New information from the director]\n${qaNotes.join("\n\n")}` : "";
      const fixMsg = `QA review found issues — fix ALL of these, then we'll re-check:\n${formatQaIssues(qa)}${noteBlock}`;
      // The implementor was fully stopped before QA, so RE-LAUNCH it through the same resume gate the
      // rest of the pipeline uses (warm full-session resume when the cache is fresh — fix-rounds are
      // minutes apart so it usually is — else a Haiku-compressed cold seed). This is what keeps the slot
      // exclusive: at no point do an implementor and QA run together. fixMsg goes in as BOTH resumeNudge
      // (warm path) and directorNote (cold path weaves only the note, ignoring the nudge); on warm the
      // two are identical so startResumedImplementor de-dups them. State stays "qa" across the (possibly
      // awaited) compression — startImplementor flips it to "implementing" only once the run is live — so
      // an inject/resume during that window routes to the QA buffer rather than spawning a second agent.
      const start = await this.startResumedImplementor(
        thread,
        kickoff,
        this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
        { effort, resumeNudge: fixMsg, directorNote: fixMsg, qaFollows: true },
      );
      if (!start) return; // cancelled while compressing the prior session for the resume
      this.flushDirectorNotes(thread.id, start.run);
      res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, fixMsg);
    }
  }

  // ---- live thread controls ----

  async injectThread(
    threadId: string,
    message: string,
    mode: "append" | "interrupt",
    images?: ImageAttachment[],
  ): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    // Auto-retitle the lane to reflect the LATEST directive — the user runs several tasks at once and
    // loses track when a lane's scope drifts from its original title. Fire-and-forget (void): the
    // model call must never block, slow, or throw into the inject path. Covers every inject branch
    // below (live, QA-forward, pre-implementor buffer, resume, cold-resume) from this one spot.
    if (thread) void this.retitleFromInjection(threadId, message);
    // Persist injected images as attachments so the feed can render them as thumbnails (the blocks
    // sent to the model are transient). Lazy + memoized: only the branch that actually echoes a feed
    // message calls it, so the cold-resume path (which adds no feed row) never orphans attachment
    // rows; the memo means a branch reached more than once still saves the bytes only once.
    let savedRefs: AttachmentRef[] | undefined;
    let didSave = false;
    const injectRefs = (): AttachmentRef[] | undefined => {
      if (!didSave) {
        didSave = true;
        savedRefs = images?.length
          ? images.map((img) => this.db.addAttachment({ name: img.name, mediaType: img.mediaType, data: img.dataBase64 }))
          : undefined;
      }
      return savedRefs;
    };
    // QA stage gate (checked BEFORE `this.live`): during QA the implementor is fully stopped and the QA
    // agent runs alone in the slot. Falling through would either `send` to a live implementor (there is
    // none now, but this gate is the structural guarantee of that) or take the cold-resume path and SPAWN
    // one beside the running QA — two agents in one pipeline slot, the exact race this guards. Forward the
    // steering to the QA agent instead so the invariant (≤1 active agent per slot) holds.
    if (thread?.state === "qa") {
      this.hub.log("info", "[INJECT] QA in progress — forwarding context to QA agent, not re-spawning implementor");
      const qa = this.liveQa.get(threadId);
      if (qa) {
        // Forward to the running QA agent but do NOT call qa.interrupt(): QA runs as a one-shot under
        // runRole, which stop()s it the instant it emits its verdict result, and the SDK surfaces an
        // interrupt as an (error) result — so interrupting would tear QA down into 'review' rather than
        // steer it, and race the follow-up send against teardown. A priority "now" send is the
        // best-effort way to reach QA's current turn; 'append' queues normally. If the note lands after
        // QA already emitted its verdict it simply doesn't change THIS round — accepted, since the
        // invariant (never a second agent), not this round's verdict, is what this gate must guarantee.
        const blocks = images?.length ? images.map(toImageBlock) : [];
        qa.send(
          contentWithImages(`[New information from the director]\n${message}`, blocks),
          mode === "interrupt" ? { priority: "now" } : undefined,
        );
      } else {
        // No QA handle while state is "qa" — either a mid-QA account failover (runRole deleted the old
        // handle and hasn't registered the relaunched one yet) or the fix-round window after QA returned
        // but before the re-launched implementor goes live (state is held at "qa" across that compression).
        // Buffer the note; the next fix-round's implementor drains directorNotes into its fix message
        // (runImplementorQaLoop), so it reaches the implementor when IT is running — never alongside QA, never lost.
        this.bufferDirectorNote(threadId, message);
        if (images?.length) {
          this.threadImages.set(threadId, [...(this.threadImages.get(threadId) ?? []), ...images.map(toImageBlock)]);
        }
      }
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `↪ injected (forwarded to QA): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
        attachments: injectRefs(),
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      return { ok: true, state: "qa" };
    }
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
        attachments: injectRefs(),
      });
      // Echo it into the task feed live (otherwise the injected note only appears on a later
      // history refetch) and bump recency so the task jumps to the front of the board.
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      this.hub.log("info", `Injected (${mode}) into ${threadId.slice(0, 8)}`);
      return { ok: true, state: "implementing" };
    }
    // No live implementor — but the task may still be in its PRE-IMPLEMENTOR phase: the planner is
    // running, or we're parked at the approval gate. Steering here must NEVER start an implementor
    // beside the still-running planner (the race this guards). Hold the note for that stage instead:
    // a live planner re-plans with it (drainDirectorNotes); otherwise it's folded into the
    // implementor's kickoff once the pipeline reaches it. The implementor start stays gated on the
    // planner finishing and routing normally.
    const phase = thread;
    if (phase && (this.liveRole.has(threadId) || PRE_IMPLEMENTOR.has(phase.state))) {
      this.bufferDirectorNote(threadId, message);
      if (images?.length) {
        this.threadImages.set(threadId, [...(this.threadImages.get(threadId) ?? []), ...images.map(toImageBlock)]);
      }
      const planner = this.liveRole.get(threadId);
      // 'interrupt' aborts the planner's now-stale turn so the re-plan starts immediately; 'append'
      // lets the current turn finish first. Either way runRole's drain loop picks up the buffered note
      // and re-plans before handing off. With no live planner (research / approval gate) the note just
      // waits in the buffer for the implementor kickoff.
      if (planner && mode === "interrupt") {
        // A planner parked in awaiting_user is blocked inside ask_user, not running a turn — interrupting
        // it would strand the open question (and never reach the drain). Resolve the question instead so
        // the planner unblocks and the buffered note lands as a re-plan; only a genuinely-running planner
        // gets interrupted.
        const openQ = this.db.listOpenQuestions().find((q) => q.threadId === threadId);
        if (openQ) {
          this.resolveQuestion(openQ.id, "(superseded — the director sent new instructions mid-question; see the note that follows and proceed accordingly)");
        } else {
          await planner.interrupt();
        }
      }
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `↪ injected (held for the ${phase.state} stage): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
        attachments: injectRefs(),
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      this.hub.log(
        "info",
        `Inject (${mode}) on ${threadId.slice(0, 8)} HELD for the ${phase.state} stage — implementor start gated on planner completion${planner ? " (steered the live planner)" : ""}.`,
      );
      return { ok: true, state: phase.state };
    }
    // A resume is mid-materialization (live not yet set) — buffer this inject so it isn't lost, then
    // resumeImplementorOnly delivers it the moment the implementor comes live.
    if (this.resuming.has(threadId)) {
      const q = this.pendingResumeMsgs.get(threadId) ?? [];
      q.push(message);
      this.pendingResumeMsgs.set(threadId, q);
      const m = this.db.addMessage({ threadId, role: "director", kind: "system", content: `↪ injected: ${message}`, attachments: injectRefs() });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      this.hub.log("info", `Buffered inject into ${threadId.slice(0, 8)} (resume materializing)`);
      return { ok: true, state: "implementing" };
    }
    // Not live → resume. Stash any images so the resumed implementor's kickoff carries them.
    if (images?.length) this.threadImages.set(threadId, images.map(toImageBlock));
    // Echo the inject into the feed BEFORE resuming. The cold-resume path used to swallow the note —
    // it reached the resumed implementor via the kickoff's directorNote but never showed in the
    // history. This branch now OWNS the feed echo for every cold inject (review/paused/done/failed);
    // resumeThread no longer echoes, so there's exactly one message and no state-dependent double.
    const m = this.db.addMessage({
      threadId,
      role: "director",
      kind: "system",
      content: `↪ injected: ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
      attachments: injectRefs(),
    });
    this.hub.publish({ type: "thread.message", threadId, message: m });
    this.touchThread(threadId);
    return this.resumeThread(threadId, message);
  }

  /** Regenerate a task's board title from a freshly-injected directive (short → verbatim, longer →
   *  a ≤8-word Haiku summary), then broadcast the rename so the lane updates live. Best-effort: any
   *  failure is swallowed and the title simply stays as-is — this must never disturb the inject path. */
  private async retitleFromInjection(threadId: string, message: string): Promise<void> {
    try {
      const title = await titleFromInjection(message, this.accounts.auxToken());
      if (!title) return;
      const current = this.db.getThread(threadId);
      if (!current || current.title === title) return; // gone, or no change — skip the churn
      const t = this.db.updateThread(threadId, { title });
      if (!t) return;
      this.hub.publish({ type: "thread.upsert", thread: t });
      this.hub.log("info", `Retitled ${threadId.slice(0, 8)} from injection → "${title}"`);
    } catch (e) {
      this.hub.log("warn", `Auto-retitle failed for ${threadId.slice(0, 8)}: ${String(e)}`);
    }
  }

  private bufferDirectorNote(threadId: string, note: string): void {
    const q = this.directorNotes.get(threadId) ?? [];
    q.push(note);
    this.directorNotes.set(threadId, q);
  }

  /** Deliver to a now-live implementor any director notes buffered while it was still materializing
   *  (the cold-resume compression window), then clear the buffer. A no-op when nothing was buffered. */
  private flushDirectorNotes(threadId: string, run: AgentRunLike): void {
    const notes = this.directorNotes.get(threadId);
    if (!notes?.length) return;
    this.directorNotes.delete(threadId);
    this.hub.log("info", `Delivering ${notes.length} buffered director note(s) to the now-live implementor on ${threadId.slice(0, 8)}.`);
    run.send(`[New information from the director]\n${notes.join("\n\n")}`, { priority: "now" });
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
    // A queued task hasn't started yet — it has no implementor session and is waiting for a slot, so a
    // resume must NOT start it past the concurrency cap (it'll start via pumpQueue when a slot frees) and
    // must NOT take the planner-less manual-resume path. Just buffer any steering for its eventual kickoff.
    if (thread.state === "queued") {
      if (message?.trim()) this.bufferDirectorNote(threadId, message);
      return { ok: true, state: "queued" };
    }
    // QA-stage gate — mirror injectThread's: during the QA stage the implementor is fully stopped and
    // the QA agent owns the slot, so a resume here must NEVER wake or spawn an implementor beside it.
    // Forward any steering to the running QA agent if present, else buffer it for the next fix-round's
    // implementor to drain (runImplementorQaLoop folds directorNotes into the fix message). A boot
    // auto-resume of a mid-QA task doesn't hit this — markInterrupted flips the thread to "failed"
    // first, so that path routes through the failed→runPipeline branch below, not here.
    if (thread.state === "qa") {
      if (message?.trim()) {
        const qa = this.liveQa.get(threadId);
        if (qa) qa.send(`[New information from the director]\n${message}`, { priority: "now" });
        else this.bufferDirectorNote(threadId, message);
      }
      return { ok: true, state: "qa" };
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
      const note = message?.trim() ? message : undefined;
      // Thread the steering note INTO the pipeline so the implementor actually receives it — not just
      // the UI feed. The feed echo is owned by the caller (injectThread echoes before resuming); a
      // direct resume carries no message, so nothing is dropped from the history.
      void this.runPipeline(threadId, note);
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
   *  the implementor — no QA loop; it settles to 'review' when the implementor finishes so the owner
   *  gets the result. Crucially it reuses the prior session through the SAME warm/cold gate as the
   *  pipeline, so a manual resume on a cold cache compresses the prior session instead of paying the
   *  full-transcript reload it used to. Runs in the background so the triggering command returns at
   *  once; failover-aware via awaitImplementorResult. The caller must have added threadId to
   *  `resuming`; this clears it once the implementor is live (or the start was abandoned). */
  private async resumeImplementorOnly(thread: Thread, message?: string): Promise<void> {
    // A manual resume occupies a concurrency slot for the run's lifetime (like a pipeline), so it
    // counts toward maxConcurrent and frees a queued task when it settles.
    this.activePipelines.add(thread.id);
    this.capParked.delete(thread.id); // fresh resume — drop any stale cap flag before this run sets its own
    const releaseSlot = () => {
      this.activePipelines.delete(thread.id);
      this.implementorProvider.delete(thread.id);
      this.codexResumeWedged.delete(thread.id); // a fresh dispatch's first session may resume fine
      this.pumpQueue();
    };
    // Same hard routing gate as the pipeline: a manual resume / cold inject must also respect the
    // subscription toggles. A blocked routing parks the task (failed, set by the gate) and stops here.
    if (!this.gateImplementorProvider(thread)) {
      this.resuming.delete(thread.id);
      this.pendingResumeMsgs.delete(thread.id);
      releaseSlot();
      return;
    }
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
      releaseSlot();
      return;
    }
    // The kickoff has consumed any stashed images; drop them so a later resume doesn't re-send the
    // base64 (wasted vision tokens) — the live/resumed session already holds them.
    this.dispatchImages.delete(thread.id);
    this.threadImages.delete(thread.id);
    // Deliver anything the director injected while the resume was still materializing.
    const buffered = this.pendingResumeMsgs.get(thread.id);
    if (buffered?.length) {
      this.pendingResumeMsgs.delete(thread.id);
      for (const m of buffered) start.run.send(`[New information from the director]\n${m}`, { priority: "next" });
    }
    await this.awaitImplementorResult(thread, undefined, start.run, start.accountId, false, resumeNudge)
      .then(() => {
        // A re-cap during the manual resume tags it for the supervisor; a clean finish parks for review.
        if (this.db.getThread(thread.id)?.state === "implementing") this.settleReview(thread.id, "Resume finished — needs your review.");
      })
      .catch((e) => this.hub.log("warn", `Resume on ${thread.id.slice(0, 8)} ended in error: ${String(e)}`))
      .finally(() => {
        releaseSlot();
        void this.stopLive(thread.id);
      });
  }

  async cancelThread(threadId: string): Promise<ThreadActionResult> {
    this.stopping.add(threadId);
    this.dropFromQueue(threadId); // if it was waiting for a slot, it never starts now
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
    this.dispatchImages.delete(threadId);
    this.threadImages.delete(threadId);
    // A resume may be mid-materialization (compressing) with no live run yet — drop its bookkeeping
    // so it can't resurrect the cancelled task. startResumedImplementor re-checks cancelled() after
    // compressing and won't start once this setState lands.
    this.resuming.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
    this.liveRole.delete(threadId);
    this.liveQa.delete(threadId);
    this.directorNotes.delete(threadId);
    this.implementorProvider.delete(threadId);
    this.codexResumeWedged.delete(threadId);
    this.capParked.delete(threadId); // a cancelled task must never be cap-auto-resumed

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

  /** Soft-close a parked task: move it to the 'closed' holding area (kept in the DB, off the main
   *  board, restorable) instead of deleting it. Guarded ONLY on CLOSEABLE membership — deliberately
   *  NOT on hasActiveRun: a review/paused task can keep a STALE live/activeRuns/stopping entry after
   *  the QA loop settles, and refusing on that is exactly the "can't close a review task" bug. So we
   *  FORCE-STOP any lingering agent (mirrors cancelThread's teardown, minus the delete) and then
   *  close, rather than refuse. Async because stopLive awaits the SDK session closing. */
  async closeThread(threadId: string): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (thread.state === "closed") return { ok: true, state: "closed" };
    if (!CLOSEABLE.has(thread.state)) {
      return { ok: false, error: `A ${thread.state} task is still active — cancel it before closing.` };
    }
    // Force-stop any lingering run and clear the in-memory bookkeeping (like cancelThread, but we keep
    // the row) so nothing can resurrect or keep counting the task as live after it's closed.
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
    await this.stopLive(threadId);
    this.live.delete(threadId);
    this.dispatchImages.delete(threadId);
    this.threadImages.delete(threadId);
    this.resuming.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
    this.liveRole.delete(threadId);
    this.directorNotes.delete(threadId);
    this.stopping.delete(threadId);
    const updated = this.db.closeThread(threadId);
    if (updated) this.hub.publish({ type: "thread.upsert", thread: updated });
    this.hub.log("info", `Closed task ${threadId.slice(0, 8)} (was ${thread.state}).`);
    return { ok: true, state: "closed" };
  }

  /** Manually accept a parked task (review/paused) as finished — the only path by which the owner,
   *  rather than QA, moves a task to 'done'. The pipeline reserves 'done' for QA, so injected/manual-
   *  resume work (which runs with no QA loop and settles to 'review') and QA-bounced work would
   *  otherwise have no way to reach 'done' but cancelling. Mirrors closeThread's force-stop teardown
   *  (a settled review/paused task can keep a STALE live/activeRuns entry) but keeps the row on the
   *  board and lands it in 'done'. */
  async markDone(threadId: string): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (thread.state === "done") return { ok: true, state: "done" };
    if (!DONEABLE.has(thread.state)) {
      return { ok: false, error: `A ${thread.state} task can't be marked done — only a parked (review/paused) task can.` };
    }
    await this.forceStopThreadRuns(threadId);
    this.setState(threadId, "done");
    this.hub.log("info", `Marked task ${threadId.slice(0, 8)} done (was ${thread.state}).`);
    return { ok: true, state: "done" };
  }

  /** Force-stop any lingering agent run for a thread and drop its in-memory bookkeeping, leaving the
   *  persisted state untouched. A parked task can hold a stale activeRuns/live entry after its loop
   *  settles; clearing it stops anything resurrecting the task or counting it as live. */
  private async forceStopThreadRuns(threadId: string): Promise<void> {
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
    await this.stopLive(threadId);
    this.live.delete(threadId);
    this.dispatchImages.delete(threadId);
    this.threadImages.delete(threadId);
    this.resuming.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
    this.liveRole.delete(threadId);
    // A task settles to 'review' straight out of the QA loop, so a mid-QA account failover can leave a
    // stale liveQa handle behind (the window the QA-inject gate also guards) — drop it so it can't leak.
    this.liveQa.delete(threadId);
    this.directorNotes.delete(threadId);
    this.implementorProvider.delete(threadId);
    this.codexResumeWedged.delete(threadId);
    this.stopping.delete(threadId);
  }

  /** Restore a closed task back to the state it was closed from, returning it to the main board. */
  restoreThread(threadId: string): ThreadActionResult {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (thread.state !== "closed") return { ok: false, error: "That task isn't closed." };
    const updated = this.db.restoreThread(threadId);
    if (updated) this.hub.publish({ type: "thread.upsert", thread: updated });
    this.hub.log("info", `Restored task ${threadId.slice(0, 8)} → ${updated?.state ?? "review"}.`);
    return { ok: true, state: updated?.state ?? "review" };
  }

  /** Permanently delete closed tasks whose 30-day window has elapsed. Runs on boot (after
   *  markInterrupted) and daily. Reuses deleteThread (FK cascade) + broadcasts thread.removed so
   *  clients prune them. */
  private purgeExpiredClosed(): void {
    const cutoff = Date.now() - CLOSED_TTL_MS;
    for (const t of this.db.listClosedBefore(cutoff)) {
      this.db.deleteThread(t.id);
      this.hub.publish({ type: "thread.removed", threadId: t.id });
      this.hub.log("info", `Auto-purged closed task ${t.id.slice(0, 8)} "${t.title.slice(0, 48)}" (closed > 30 days ago).`);
    }
  }

  /** Whether a live agent run is actually executing this thread right now — an active SDK run, a
   *  still-live implementor session, or a resume mid-materialization (compressing, no run yet). This
   *  is the real "is something running" signal, distinct from the thread's *state label*: a `review`
   *  (or `paused`/`awaiting_*`) thread carries no live run and so is safe to close. After a server
   *  restart these in-memory maps are empty, so a thread that was `implementing` in the DB reports no
   *  active run and becomes closeable — consistent with there being no process to kill. */
  private hasActiveRun(threadId: string): boolean {
    return (
      (this.activeRuns.get(threadId)?.size ?? 0) > 0 ||
      this.live.has(threadId) ||
      this.resuming.has(threadId) ||
      this.stopping.has(threadId)
    );
  }

  /** Permanently discard a task with no live run: delete it (FK cascade drops its runs/findings/
   *  messages/questions) and broadcast thread.removed so clients prune it. Server-authoritative and
   *  guarded on the *actual* run state, not the status label — a missing task or one with a genuinely
   *  live agent (implementing/qa/planning, or a review still resuming) is refused so in-flight work is
   *  never silently killed (use cancelThread to stop active work first). A parked task (review/paused/
   *  awaiting_*) has nothing running and is closeable. */
  dismissThread(threadId: string): void {
    const thread = this.db.getThread(threadId);
    if (!thread) {
      this.hub.publish({ type: "log", level: "warn", message: `dismiss ignored: thread ${threadId} not found` });
      return;
    }
    if (this.hasActiveRun(threadId)) {
      this.hub.publish({
        type: "log",
        level: "warn",
        message: `dismiss refused: thread ${threadId} (${thread.state}) has a live agent run — cancel it first`,
      });
      return;
    }
    // Clear any in-memory bookkeeping keyed by this thread (mirrors cancelThread) so nothing can
    // resurrect or reference the deleted task.
    this.dropFromQueue(threadId);
    this.live.delete(threadId);
    this.dispatchImages.delete(threadId);
    this.threadImages.delete(threadId);
    this.resuming.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
    this.liveRole.delete(threadId);
    this.directorNotes.delete(threadId);
    const pendingApproval = this.pendingApprovals.get(threadId);
    if (pendingApproval) {
      this.pendingApprovals.delete(threadId);
      pendingApproval({ approved: false });
    }
    // Unblock any agent/UI waiting on a question for this task (mirrors cancelThread) — a parked task
    // being closed must not leave a dangling open question behind.
    for (const q of this.db.listOpenQuestions()) {
      if (q.threadId === threadId) this.resolveQuestion(q.id, "(task dismissed)");
    }
    this.db.deleteThread(threadId);
    this.hub.publish({ type: "thread.removed", threadId });
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

  // ---- the office: cross-agent chat + grouping ----

  /** Picked names live in one kv JSON map; the default is derived from the thread id. */
  private officeNameMap(): Record<string, string> {
    try {
      const v = this.db.kvGet("office_names");
      return v ? (JSON.parse(v) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  officeName(threadId: string): string {
    return this.officeNameMap()[threadId] || gnomeName(threadId);
  }

  /** Assign a stable office name the first time a task needs one, picking the deterministic default
   *  but walking to the next free name if a currently-live coworker already holds it — so two gnomes
   *  on screen at once never share a name. Persisted + broadcast so the UI and the agent agree. */
  private ensureNamed(threadId: string): string {
    const map = this.officeNameMap();
    if (map[threadId]) return map[threadId];
    const used = new Set(
      this.liveAgentThreads()
        .filter((l) => l.threadId !== threadId)
        .map((l) => this.officeName(l.threadId)),
    );
    const names = GNOME_NAMES as readonly string[];
    const start = Math.max(0, names.indexOf(gnomeName(threadId)));
    let chosen = gnomeName(threadId);
    for (let i = 0; i < names.length; i++) {
      const cand = names[(start + i) % names.length]!;
      if (!used.has(cand)) {
        chosen = cand;
        break;
      }
    }
    map[threadId] = chosen;
    this.db.kvSet("office_names", JSON.stringify(map));
    this.hub.publish({ type: "chat.name", threadId, name: chosen });
    return chosen;
  }

  setOfficeName(threadId: string, name: string): string {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 24) || gnomeName(threadId);
    const map = this.officeNameMap();
    map[threadId] = clean;
    this.db.kvSet("office_names", JSON.stringify(map));
    this.hub.publish({ type: "chat.name", threadId, name: clean });
    return clean;
  }

  /** The current name overrides (picked names only) — sent in the hello snapshot for the office UI. */
  officeNameOverrides(): Record<string, string> {
    return this.officeNameMap();
  }

  chatPost(input: ChatPostInput): ChatMessage {
    const t = this.db.getThread(input.threadId);
    const workspace = t?.workspace ?? "";
    const project = input.scope === "project";
    const m = this.db.addChatMessage({
      room: project ? repoRoom(workspace) : GENERAL_ROOM,
      scope: input.scope,
      workspace: project ? workspace : null,
      threadId: input.threadId,
      runId: input.runId ?? null,
      role: input.role,
      kind: "chat",
      body: input.body,
      senderName: this.officeName(input.threadId),
    });
    this.hub.publish({ type: "chat.message", message: m });
    // A team post is pushed straight into the session of every other live implementor in the same
    // repo — agents don't poll, so without this a teammate's message just sits unread (the bug this
    // fixes). Delivered at the recipient's next turn boundary (priority "next"), like a heads-up finding.
    if (project) this.deliverChatToPeers(m);
    return m;
  }

  /** Push a team-room message into peer implementors working the same repo, so they actually see it
   *  instead of having to poll chat_read. Targets `this.live` (implementors) only — the same handle
   *  finding routing uses — so a one-shot planner/QA's structured output is never disrupted; those
   *  roles read the room themselves. Returns how many live peers were pinged. */
  private deliverChatToPeers(m: ChatMessage): number {
    if (m.scope !== "project" || !m.workspace) return 0;
    const norm = normalizeWorkspace(m.workspace);
    const who = m.senderName || (m.threadId ? this.officeName(m.threadId) : "a teammate");
    const text =
      `💬 [Office — ${who} (${m.role}) posted to your team room]: ${m.body}\n` +
      `(A teammate working in this same repo sent this. If it touches your work or asks something, reply with ` +
      `chat_post(scope:"team") — address them as ${who} — and adjust; don't keep editing blind.)`;
    let pinged = 0;
    for (const [tid, live] of this.live) {
      if (tid === m.threadId) continue; // never echo back to the sender
      const t = this.db.getThread(tid);
      if (!t || normalizeWorkspace(t.workspace) !== norm) continue;
      live.run.send(text, { priority: "next" });
      pinged++;
    }
    return pinged;
  }

  /** The display workspace for a project-room key (`repo:<normalized>`), recovered from any thread in
   *  that repo; falls back to the normalized suffix if none is known. */
  private workspaceForRoom(room: string): string {
    const norm = room.replace(/^repo:/, "");
    const t = this.db.listThreads().find((x) => normalizeWorkspace(x.workspace) === norm);
    return t?.workspace ?? norm;
  }

  /** Let the human post into a room AS THE DIRECTOR: it lands in the office chat AND is pushed into the
   *  live implementors who should act on it — a project-room post reaches the agents in that repo, an
   *  office post reaches every active agent. So instead of injecting one specific task, the owner drops
   *  the change into the room and the agents coordinate who picks it up. */
  directorChatPost(room: string, body: string): ChatMessage {
    const text = body.trim();
    if (!text) throw new Error("empty director message");
    const general = room === GENERAL_ROOM;
    const workspace = general ? null : this.workspaceForRoom(room);
    const m = this.db.addChatMessage({
      room: general ? GENERAL_ROOM : room,
      scope: general ? "general" : "project",
      workspace,
      threadId: null,
      runId: null,
      role: "director",
      kind: "chat",
      body: text,
      senderName: "Director",
    });
    this.hub.publish({ type: "chat.message", message: m });
    // Push it into the sessions of the live implementors who should act on it (priority "next", so it
    // arrives at their next turn boundary — same mechanism as a teammate ping / heads-up finding).
    const where = general ? "the office" : "this repo";
    const push =
      `📣 [Director → ${general ? "office" : "your team"}] ${text}\n` +
      `(A directive from ${config.ownerName} to all agents in ${where}. Coordinate among yourselves who takes it — don't all grab it, and don't all assume someone else will — then reply with chat_post so the others know.)`;
    const norm = general ? null : normalizeWorkspace(workspace ?? room.replace(/^repo:/, ""));
    let pinged = 0;
    for (const [tid, live] of this.live) {
      if (!general) {
        const t = this.db.getThread(tid);
        if (!t || normalizeWorkspace(t.workspace) !== norm) continue;
      }
      live.run.send(push, { priority: "next" });
      pinged++;
    }
    this.hub.log("info", `Director posted to ${general ? "the office" : `team ${workspace}`} — pinged ${pinged} live agent(s).`);
    return m;
  }

  chatRead(input: ChatReadInput): ChatMessage[] {
    const t = this.db.getThread(input.threadId);
    const ws = t?.workspace ?? "";
    const limit = input.limit ?? 40;
    const scope = input.scope ?? "all";
    if (scope === "general") return this.db.listRoomMessages(GENERAL_ROOM, limit);
    if (scope === "project") return this.db.listRoomMessages(repoRoom(ws), limit);
    // "all": newest `limit` across the two rooms the caller belongs to, merged chronologically.
    return [...this.db.listRoomMessages(GENERAL_ROOM, limit), ...this.db.listRoomMessages(repoRoom(ws), limit)]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit);
  }

  officeRoster(threadId: string): RosterEntry[] {
    const me = this.db.getThread(threadId);
    const myNorm = normalizeWorkspace(me?.workspace ?? "");
    return this.liveAgentThreads().map((l) => ({
      threadId: l.threadId,
      name: this.officeName(l.threadId),
      title: l.title,
      workspace: l.workspace,
      role: l.role,
      self: l.threadId === threadId,
      sameRepo: l.threadId !== threadId && normalizeWorkspace(l.workspace) === myNorm,
    }));
  }

  /** The threads with a live in-memory agent right now (activeRuns is the in-process truth, kept in
   *  sync with track/untrack), each tagged with the role of its most recent still-running run — the
   *  single source both the office roster and the grouping logic read from. */
  private liveAgentThreads(): { threadId: string; role: Role; workspace: string; title: string }[] {
    const out: { threadId: string; role: Role; workspace: string; title: string }[] = [];
    for (const [tid, set] of this.activeRuns) {
      if (!set.size) continue;
      const t = this.db.getThread(tid);
      if (!t) continue;
      const runs = this.db.listRuns(tid);
      const active = runs
        .filter((r) => r.state === "starting" || r.state === "running" || r.state === "idle")
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const role = (active ?? runs.sort((a, b) => b.startedAt - a.startedAt)[0])?.role ?? "implementor";
      out.push({ threadId: tid, role, workspace: t.workspace, title: t.title });
    }
    return out;
  }

  /** Other live agents sharing a thread's workspace — the teammates it can collide with. */
  private repoPeers(thread: Thread): { threadId: string; role: Role; title: string }[] {
    const myNorm = normalizeWorkspace(thread.workspace);
    return this.liveAgentThreads()
      .filter((l) => l.threadId !== thread.id && normalizeWorkspace(l.workspace) === myNorm)
      .map((l) => ({ threadId: l.threadId, role: l.role, title: l.title }));
  }

  /** Called when an agent starts: if 2+ distinct tasks are now live in the same repo, they form a
   *  project room. Announce each not-yet-announced participant once (durably, via chatThreadInRoom)
   *  so every current member is recorded in the room — that's what surfaces the "Chatroom" button on
   *  their tasks and the standing huddle in the office strip. */
  private ensureGroup(threadId: string): void {
    const t = this.db.getThread(threadId);
    if (!t) return;
    const myNorm = normalizeWorkspace(t.workspace);
    const distinct = new Set(
      this.liveAgentThreads()
        .filter((l) => normalizeWorkspace(l.workspace) === myNorm)
        .map((l) => l.threadId),
    );
    if (distinct.size < 2) return;
    const room = repoRoom(t.workspace);
    for (const tid of distinct) {
      if (this.db.chatThreadInRoom(room, tid)) continue;
      const peer = this.db.getThread(tid);
      if (!peer) continue;
      const m = this.db.addChatMessage({
        room,
        scope: "project",
        workspace: t.workspace,
        threadId: tid,
        role: "system",
        kind: "system",
        body: `🤝 "${peer.title}" joined — ${distinct.size} agents are now working in ${t.workspace}. Coordinate here so you don't edit the same files.`,
      });
      this.hub.publish({ type: "chat.message", message: m });
    }
  }

  /** Enforce "no invisible workers": the first time a role goes live for a task, post a short check-in
   *  to the general office so every active agent is visible in the chat, not just the gnome strip. The
   *  orchestrator posts it (not the LLM) so it's guaranteed — agents can't forget to show up. Deduped
   *  per (thread, role) so resume/failover relaunches don't repeat it. */
  private officeCheckIn(threadId: string, role: Role): void {
    const key = `${threadId}:${role}`;
    if (this.checkedIn.has(key)) return;
    this.checkedIn.add(key);
    const t = this.db.getThread(threadId);
    if (!t) return;
    const name = this.ensureNamed(threadId);
    const leaf = t.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t.workspace;
    const m = this.db.addChatMessage({
      room: GENERAL_ROOM,
      scope: "general",
      workspace: null,
      threadId,
      runId: null,
      role,
      kind: "chat",
      body: `👋 ${name} (${role}) here — starting on "${t.title}" in ${leaf}.`,
      senderName: name,
    });
    this.hub.publish({ type: "chat.message", message: m });
  }

  /** A concrete heads-up folded into a fresh implementor kickoff when teammates already share its repo
   *  — names them and tells it to coordinate. `withTools` is false for the Codex backend (no office
   *  MCP), where the note still warns about collisions but can't point at chat tools it doesn't have. */
  private peerNote(thread: Thread, withTools: boolean): string | undefined {
    const peers = this.repoPeers(thread);
    if (!peers.length) return undefined;
    const list = peers.map((p) => `• ${p.role} on "${p.title}"`).join("\n");
    const how = withTools
      ? "Use the office chat to coordinate: call `office_look`, then `chat_post(scope:\"team\")` to claim the files/areas you'll touch and `chat_read` what they've claimed before editing."
      : "Be careful not to edit the same files they are; prefer non-overlapping areas, and re-check `git status`/`git diff` before committing so you only commit your own hunks.";
    return `⚠️ OFFICE — you're NOT alone in this repo. ${peers.length} other agent(s) are working in ${thread.workspace} right now:\n${list}\nYou share this workspace, so you can step on each other's changes. ${how} Commit only your own hunks.`;
  }

  // ---- run event wiring ----

  private emitRun(runId: string): void {
    const run = this.db.getRun(runId);
    if (run) this.hub.publish({ type: "run.upsert", run });
  }

  private finishRun(runId: string, res: Extract<AgentEvent, { type: "result" }> | undefined, agent: AgentRunLike): void {
    this.db.updateRun(runId, {
      state: res?.isError ? "error" : "done",
      // Persist the failure reason so a dead run is diagnosable instead of a silent error row.
      error: res?.isError ? (res.result ?? "Run failed.").slice(0, 2000) : null,
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
  private finalizeRun(runId: string, agent: AgentRunLike): void {
    const run = this.db.getRun(runId);
    if (!run || run.endedAt != null) return;
    const res = agent.lastResult;
    const state: AgentRunState = res ? (res.isError ? "error" : "done") : "interrupted";
    this.db.updateRun(runId, {
      state,
      error: res?.isError ? (res.result ?? "Run failed.").slice(0, 2000) : run.error ?? null,
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

  private wireRun(agent: AgentRunLike, threadId: string, runId: string, role: Role, accountId: string): void {
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

function composeKickoff(
  thread: Thread,
  plan: PlanOutput | undefined,
  research: ResearchOutput | undefined,
  opts: { autoPush: boolean; qaEnabled: boolean },
): string {
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
  // just re-bill those tokens in every per-task message. The two notes below are exceptions: they
  // OVERRIDE that standing doctrine for this task (QA off / push off), so they must be stated here.
  const directives: string[] = [
    `Implement this now, completely. Post findings as you go; ask_user immediately on a blocker only ${config.ownerName} can fix.`,
  ];
  if (!opts.qaEnabled) {
    directives.push(
      "NOTE — automated QA review is DISABLED for this task: your output is final and won't be checked by a QA agent. Verify your own work thoroughly (build, typecheck, tests, and a real browser pass for any UI) before you finish.",
    );
  }
  if (!opts.autoPush) {
    directives.push(
      `NOTE — auto-push is OFF for this task: commit your work locally as usual, but do NOT push to the remote — ${config.ownerName} will push manually. This overrides the standing "commit AND push" doctrine for this task only.`,
    );
  }
  parts.push(directives.join("\n\n"));
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
    `Gather ONLY external context: web search, official docs, library/API references, GitHub issues, Stack Overflow, changelogs/release notes, error-message lookups, plus relevant entries from ${config.ownerName}'s memory (search_memory). Do NOT read the codebase — the planner already did. Return your structured brief with sourced facts so the implementor inherits them.`,
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
