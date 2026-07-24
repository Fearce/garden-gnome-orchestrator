import type { AccountDispatchPreview, AccountManager } from "../accounts/accountManager.js";
import { bySafetyHeadroom, untilReset, weeklySafetyPool } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import { AgentRun, type AgentRunConfig, type AgentRunLike } from "../agents/runner.js";
import { CodexAgentRun, chatgptLoginAvailable, codexAuthAvailable, testOpenAiKey, type CodexTestResult } from "../agents/codexRunner.js";
import { codexUsageCapped, readCodexUsage } from "../agents/codexUsage.js";
import { GrokAgentRun, grokAuthAvailable, readGrokAuth } from "../agents/grokRunner.js";
import { noteGrokCap, readGrokUsage, grokUsageCapped } from "../agents/grokUsage.js";
import { ModelCatalog, CURATED_CLAUDE_MODELS, CURATED_CODEX_MODELS, CURATED_GROK_MODELS, uniq } from "../agents/modelCatalog.js";
import { clampEffort, implementorConfig, plannerConfig, qaConfig, readerConfig, researcherConfig, resolveEffort } from "../agents/roles.js";
import { jsonContractInstruction } from "../agents/structuredText.js";
import { CODEX_IMPLEMENTOR_DOCTRINE, GROK_IMPLEMENTOR_DOCTRINE } from "../agents/prompts.js";
import { createBusServer } from "../bus/busServer.js";
import { createGitReadServer } from "../bus/gitReadServer.js";
import { createOfficeServer } from "../bus/officeServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { compressSession, sessionAgeMs } from "./resumeCompress.js";
import { collectTaskWrittenFiles, detectUnsurfacedArtifacts } from "./deliverableCheck.js";
import { getFileDiff, getTaskGitStatus, getHeadSha, getTaskGitSummary, type GitFileDiff, type GitStatus, type GitSummary } from "../gitService.js";
import { titleFromInjection, titleFromBrief } from "./titleFromInjection.js";
import { completionAnnouncement } from "./voiceAnnounce.js";
import { config, fallbackModelFor } from "../config.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { contentWithImages, toImageBlock, type ImageBlock } from "../attachments.js";
import type {
  AgentEvent,
  AgentRunState,
  AttachmentRef,
  ChatMessage,
  CodexEffort,
  Effort,
  Finding,
  GrokEffort,
  ImageAttachment,
  ImplementorProvider,
  ModelOverrides,
  OrchestratorSettings,
  PlanOutput,
  QaOutput,
  RateLimitInfo,
  ReaderOutput,
  ResearchOutput,
  Role,
  Thread,
} from "../types.js";
import { agentKey, CODEX_EFFORTS, CODEX_SUB_ID, DEFAULT_SUB_ID, EFFORTS, GENERAL_ROOM, GNOME_NAMES, gnomeName, GROK_EFFORTS, GROK_SUB_ID, MODEL_ROLES, normalizeWorkspace, repoRoom, resolveCodexEffort } from "../types.js";

// A real setup has a handful of subscriptions (Claude accounts + codex + the "default" layer); this
// caps a LAN-reachable client from bloating the single kv blob that's re-parsed on every dispatch.
const MAX_MODEL_SUB_ENTRIES = 64;

/** Validate an incoming model-overrides map: keep only known roles, trim + length-cap the model ids,
 *  drop blanks, drop subscriptions left with no entries, and cap the number of subscriptions. Bounds a
 *  client-supplied blob before it's persisted (subscription ids and model ids both originate from the client). */
function sanitizeModelOverrides(input: ModelOverrides): ModelOverrides {
  const out: ModelOverrides = {};
  for (const [subId, roles] of Object.entries(input ?? {})) {
    if (typeof subId !== "string" || subId.length > 64 || !roles || typeof roles !== "object") continue;
    const clean: Partial<Record<Role, string>> = {};
    for (const role of MODEL_ROLES) {
      const v = roles[role];
      if (typeof v === "string" && v.trim()) clean[role] = v.trim().slice(0, 100);
    }
    if (Object.keys(clean).length) out[subId] = clean;
    if (Object.keys(out).length >= MAX_MODEL_SUB_ENTRIES) break;
  }
  return out;
}

/** Validate an incoming per-account effort-cap map: keep only known effort tiers, drop everything else,
 *  and cap the entry count. Bounds a client-supplied blob (account ids + tiers both originate client-side)
 *  before it's persisted. A missing/`max` entry means uncapped, so those are dropped to keep the map lean. */
function sanitizeAccountEffortCaps(input: Record<string, Effort>): Record<string, Effort> {
  const out: Record<string, Effort> = {};
  for (const [id, eff] of Object.entries(input ?? {})) {
    if (typeof id !== "string" || id.length > 64) continue;
    if (typeof eff === "string" && EFFORTS.includes(eff) && eff !== "max") out[id] = eff;
    if (Object.keys(out).length >= MAX_MODEL_SUB_ENTRIES) break;
  }
  return out;
}

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

export interface ProviderCandidate {
  provider: ImplementorProvider;
  hasHeadroom: boolean;
  fiveHour: number | null;
  sevenDay: number | null;
  sevenDayReset: number | null;
  weeklySafetyPct: number; // 1-100 soft weekly ceiling; at/above it this backend is de-preferred (100 = off)
}

/** A settings.set patch: the writable subset of OrchestratorSettings plus the write-only raw key. The
 *  read-only masked indicators (hasOpenaiKey/openaiKeyLast4) are derived, never set by a client. */
export type SettingsPatch = Partial<
  Omit<
    OrchestratorSettings,
    | "hasOpenaiKey"
    | "openaiKeyLast4"
    | "codexChatgptLogin"
    | "grokSignedIn"
    | "grokAccount"
    | "xhighEnabled"
    | "modelDefaults"
    | "claudeModels"
    | "codexModels"
    | "grokModels"
  >
> & { openaiApiKey?: string };

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
// turn-limit stop and auto-resume with a nudge to block in-turn instead. Leans BROAD: a false positive
// costs one cheap warm resume (the nudged agent just re-states it's done), while a miss parks the task
// on a manual Resume click — the subject is optional because agents drop it ("Will report once…"), and
// describing an operation as still in flight in the final words counts as waiting on it. A genuine finish
// (IMPLEMENTOR_DONE_RE) and a real blocker (which goes through ask_user, never a bare turn-end) are excluded.
const IMPLEMENTOR_STALL_RE = new RegExp(
  [
    // "I'll report back once the build finishes" — and subject-dropped: "Will report once the server is up"
    /\b(?:i'll|i will|will|i'm going to|i am going to|going to|let me)\b[^.!?\n]*\b(?:confirm|report(?: back)?|reporting(?: back)?|let you know|update you|check back|circle back|follow up|come back|verify|validate)\b[^.!?\n]*\b(?:once|when|after|as soon as)\b/,
    // "Once the restore completes, (I)'ll verify …"
    /\b(?:once|when|after)\b[^.!?\n]*\b(?:finish(?:es|ed)?|complete[sd]?|done|ready|back up)\b[^.!?\n]*\b(?:i'll|i will|will)\b/,
    // "waiting for the build to finish"
    /\bwaiting (?:for|on)\b[^.!?\n]*\bto (?:finish|complete|build|restore|run|rebuild)\b/,
    // an operation left in flight as the last words: "deploy is in flight", "the migration is still running"
    /\b(?:deploy(?:ment)?|build|restore|install|restart|migration|rollout|job|script|process|pipeline|run)\b[^.!?\n]*\b(?:in flight|in progress|underway|still running)\b/,
    // "monitoring the script output for the … milestones"
    /\b(?:monitoring|watching|tracking)\b[^.!?\n]*\b(?:output|progress|logs?|milestones?|status|completion)\b/,
  ]
    .map((r) => r.source)
    .join("|"),
);
// The nudge sent when we auto-resume a voluntary stall: tell the agent the hard truth (no callback) and
// make it block in-turn on whatever it started, rather than ending the turn waiting to be woken.
const STALL_NUDGE =
  "You ended your turn saying you'd confirm or continue once something finishes — but NOTHING wakes you. " +
  "There is no background callback and no one resumes you automatically; ending the turn just parks the task " +
  "until a human notices, possibly hours later. If you kicked off a long-running command (a build, install, " +
  "restore, test run, server start), WAIT for it to finish IN THIS TURN — block on it, await it, or poll it in " +
  "a loop — then act on the result. Continue now and finish the task completely, or call ask_user if you're " +
  `genuinely blocked on ${config.ownerName}.`;
// The opt-in post-completion prompt (the "Self-improve after tasks" setting): once a task is done —
// QA passed, or the implementor finished clean with QA disabled — the implementor gets one extra round
// with this message so the lessons of the session turn into real tooling instead of evaporating with it.
// The task is already complete when this runs, so the round is best-effort: it never blocks 'done'.
const SELF_IMPROVE_MSG =
  "[Post-task self-improvement round — the task itself is COMPLETE and accepted; this is an opt-in bonus " +
  `round ${config.ownerName} enabled in settings]\n` +
  `First, ground yourself in ${config.ownerName}'s memories so you know the setup you're improving: read the ` +
  `global index at ${join(config.memoryDir, "MEMORY.md")} (grep ${config.memoryDir} for topics related to what ` +
  "you just worked on) and this project's memory/rules if present — they tell you what already exists, so you " +
  "extend instead of duplicating. Know your reach: you have FULL control of this computer and are NOT confined " +
  "to this task's repo — you may create new folders, projects, and git repos, install tools, add " +
  "scripts/skills/memories, and register services, whatever the improvement needs.\n" +
  "Then: what tools/apps/skills/memories/scripts/docs/etc could have made this session easier, faster, or " +
  "better? If any, BUILD or implement them now — don't just list them. If improvements to existing tooling, " +
  "project docs (CLAUDE.md / .claude/rules), saved memories, or workflows would have made this task easier, " +
  "make those improvements. Keep this work in its own commit(s), separate from the task's commits, and follow " +
  "the same commit/push doctrine the task used. Scope it to what THIS session actually taught you — no " +
  "speculative frameworks. If nothing genuinely worth building surfaced, say so in one line and finish.";
// On a mid-run 5h/weekly cap, relaunch on another account (resuming the session) up to N times.
const MAX_ACCOUNT_FAILOVERS = 3;
const MAX_TRANSIENT_API_FAILURES = config.maxTransientApiFailures;
// On a model-pool cap (Fable's own gated allowance, separate from the 5h/weekly windows) the run
// relaunches on the SAME account with the fallback model — this is that relaunch's continuation nudge,
// mirroring the account-failover one.
const MODEL_FALLBACK_CONTINUE_MSG =
  "Your session was switched to a fallback model after a model-specific usage limit. Continue exactly where you left off and finish.";
// When Codex hits its usage cap we route implementors to the Claude backend until its window resets. The
// real reset epoch (from the usage snapshot) is preferred; this cooldown is the fallback when it's unknown,
// after which Codex is tried again (a failing turn simply re-arms the latch). kv key persists it across boots.
const CODEX_CAP_COOLDOWN_MS = 60 * 60_000;
const CODEX_CAP_KV_KEY = "codex_cap_until";
// Grok's weekly scrape normally supplies the reset epoch; before it lands, a rejected turn falls back to
// a fixed cooldown (config.grok.capCooldownMs). kv-persisted.
const GROK_CAP_KV_KEY = "grok_cap_until";
const PROVIDER_HARD_LIMIT = 98;
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
// Marker written into QA-stage cap-park messages so logs/search can still find them. Historical parks
// may still carry the older "(QA runs on Claude)" wording — resumeCapParked no longer gates on either
// string (runRole fails QA over to Codex/Grok, so any free backend unparks).
const CAP_PARK_QA_MARK = "(QA stage)";
// Don't re-ping the external webhook about auto-resuming the SAME task more often than this — a task
// that keeps re-capping every interval would otherwise flood the channel. The in-app log isn't throttled.
const CAP_RESUME_NOTIFY_COOLDOWN_MS = 30 * 60_000;
// Fire the token-reset auto-resume a touch AFTER the window's reset epoch — the reset time is an
// estimate and can be slightly fuzzy, so a small grace avoids waking straight into an instant re-cap.
const TOKEN_RESUME_BUFFER_MS = 60_000;
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
  // Messages the director QUEUED (the composer's Queue button) for the implementor to pick up at its
  // hand-off boundary rather than mid-run: held here while the implementor works, then drained by
  // drainQueuedImplementor when the run finishes — the implementor does this work too before QA gets it.
  private readonly queuedForImplementor = new Map<string, string[]>();
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
  // Per-thread identity of the pipeline that currently owns the concurrency slot. A cancel→retry can
  // start a NEW pipeline for a thread while the old one is still unwinding; the newer pipeline replaces
  // this token, so the old pipeline's late releaseSlot() sees a mismatch and must NOT delete the slot
  // the new run now holds (which would under-count activePipelines and let dispatch exceed maxConcurrent).
  private readonly activePipelineToken = new Map<string, symbol>();
  private readonly dispatchQueue: string[] = [];
  // "No invisible workers": each (thread, role) auto-announces itself in the general office room the
  // first time it goes live. Keyed so a failover relaunch / warm resume of the same role doesn't spam,
  // and reset on restart (a resumed agent re-announcing once after a bounce is fine — even welcome).
  private readonly checkedIn = new Set<string>();
  // Threads whose current run gave up to 'review' because every account was capped (no failover
  // headroom). Set the instant the give-up happens, read+cleared when the task settles so the review
  // message carries the CAP_PARK marker the supervisor keys off. The value records WHICH stage capped
  // (used for the park message wording); any free backend can unpark either kind now that runRole
  // fails QA over to Codex/Grok. In-memory only — the durable signal is the persisted error text
  // (prefix + optional historical QA marker), so a restart still finds cap-parked tasks.
  private readonly capParked = new Map<string, "qa" | "implementor">();
  // Last time we externally announced auto-resuming a given thread — throttles the webhook ping so a
  // task stuck in a re-cap loop doesn't spam the channel each interval (see CAP_RESUME_NOTIFY_COOLDOWN_MS).
  private readonly capResumeNotifiedAt = new Map<string, number>();
  private capSupervisor: NodeJS.Timeout | undefined;
  // One-shot latch for the token-safety auto-stop: set when a crossing fires the stop, cleared once
  // utilization drops back below the threshold — so the stop fires once per crossing, not on every ping
  // while the window stays hot (which would re-stop tasks the owner just re-dispatched).
  private tokenLimitTripped = false;
  // Token-reset auto-resume: the reset epoch (soonestResetAt) we've currently armed a wakeup timer for,
  // and the timer itself. armedFor doubles as the idempotency latch — re-crossing the threshold for the
  // SAME window is a no-op, so we schedule exactly one resume per window. Persisted to kv
  // (token_resume_wakeup_at) so a restart re-arms (or fires, if the reset already passed while we were down).
  private tokenResumeArmedFor: number | undefined;
  private tokenResumeTimer: NodeJS.Timeout | undefined;
  // Epoch ms until which Codex is treated as usage-capped, so implementors route to the Claude backend
  // instead of dispatching straight into an instant 429. Set when a live Codex run caps (real reset epoch
  // preferred, else a cooldown); auto-clears when the window passes. Persisted in kv so a restart's
  // auto-resume wave doesn't slam Codex again on stale-good routing. Undefined = Codex not latched-capped.
  private codexCapUntil: number | undefined;
  // Epoch ms until which Grok is treated as usage-capped (route implementors elsewhere). Set when a live
  // Grok run is rejected; a fixed cooldown (no reset epoch is exposed). Persisted so a restart's auto-resume
  // wave doesn't slam a still-capped Grok. Undefined = Grok not latched-capped.
  private grokCapUntil: number | undefined;
  // Owns the live pickable-model lists (Settings dropdowns). Rebroadcasts settings when a list changes.
  private readonly modelCatalog: ModelCatalog;

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    readonly memory: MemoryService,
    readonly accounts: AccountManager,
  ) {
    this.modelCatalog = new ModelCatalog(
      db,
      accounts,
      () => this.openaiApiKey(),
      () => this.hub.publish({ type: "settings", settings: this.settings() }),
    );
    this.markInterrupted();
    this.applyAccountEnabled();
    this.applyAccountWeeklySafety();
    this.accounts.setSpreadUsage(this.settingBool("setting_spread_usage", false));
    this.loadCodexCap();
    this.loadGrokCap();
    // Sweep expired closed tasks on boot, then daily. unref so the timer never holds the process open.
    this.purgeExpiredClosed();
    setInterval(() => this.purgeExpiredClosed(), PURGE_SWEEP_MS).unref();
    this.startCapSupervisor();
    // Re-arm (or fire) a token-reset auto-resume that a restart interrupted — after the cap supervisor,
    // mirroring its boot sweep. Reads the persisted wakeup epoch; the account pings needed by fireTokenResume
    // land shortly after via onUsageRefresh, so an "already elapsed" restore is deferred like the boot resume.
    this.restoreTokenResume();
    // React to every live usage refresh — the token-safety limit stops running agents when burn crosses
    // the operator threshold, and (independently) the token-reset auto-resume arms a wakeup at the window
    // reset. onUsageRefresh holds a single callback, so BOTH run from this one wrapper. Registered here
    // (before accounts.start() fires the first ping in index.ts).
    this.accounts.onUsageRefresh(() => {
      this.enforceTokenSafetyLimit();
      this.maybeScheduleTokenResume();
    });
    // Honor a persisted "Fast usage polling" opt-in on boot — set before accounts.start() arms the
    // ping timer in index.ts, so the first interval already uses the chosen cadence.
    this.applyUsagePollInterval();
  }

  /** Kick off the live model-list catalog (boot fetch + slow refresh). Called from index.ts after the
   *  account manager has started, so a subscription token is available for the Anthropic models fetch. */
  startModelCatalog(): void {
    this.modelCatalog.start();
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
    // Headroom on ANY backend can unpark work. Claude free → resume anything. CLI free (Codex/Grok
    // enabled+authed+under caps) → also resume QA-phase parks: runRole fails planner/researcher/QA over
    // to a ready CLI when Claude is still capped (see the Claude→CLI handoff in runRole). Older parks
    // that still carry CAP_PARK_QA_MARK in their error text are therefore unblocked by CLI headroom too.
    const claudeFree = this.accounts.hasHeadroom();
    const cliFree = this.codexImplementorReady() || this.grokImplementorReady();
    if (!claudeFree && !cliFree) return;
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

  /**
   * Token-reset auto-resume (opt-in, off by default). When live utilization crosses the operator
   * threshold, work is about to freeze on the cap — so arm a wakeup timed to the soonest window reset
   * that resumes whatever froze, letting the orchestrator recover while the owner is away. Driven by the
   * same usage-refresh hook as the safety limit (and re-evaluated on a settings change). Idempotent per
   * window: `tokenResumeArmedFor` holds the reset epoch we've armed for, so re-crossing the threshold for
   * the same window doesn't re-schedule. Layered independently of (and compatible with) the safety limit.
   */
  private maybeScheduleTokenResume(): void {
    const { autoResumeOnTokenReset, autoResumeThresholdPercent } = this.settings();
    if (!autoResumeOnTokenReset) {
      this.disarmTokenResume(); // toggled off — cancel any pending wakeup so "off" truly does nothing
      return;
    }
    const util = this.accounts.effectiveUtilization();
    if (util == null || util < autoResumeThresholdPercent) return; // no data / under the line — leave any arm intact
    const resetAt = this.accounts.soonestResetAt();
    if (resetAt == null) return; // usage is high but no reset epoch known yet — a later ping will carry one
    if (this.tokenResumeArmedFor === resetAt) return; // already scheduled for this window
    this.hub.log(
      "info",
      `Token threshold hit (${Math.round(util)}%). Scheduling resume ${untilReset(resetAt, Date.now())}.`,
    );
    this.armTokenResume(resetAt);
  }

  /** Arm (or re-arm) the wakeup timer for a given reset epoch and persist it so a restart can restore it.
   *  Split from the threshold check so restoreTokenResume can re-arm without re-logging a fresh crossing. */
  private armTokenResume(resetAt: number): void {
    if (this.tokenResumeTimer) clearTimeout(this.tokenResumeTimer);
    this.tokenResumeArmedFor = resetAt;
    this.db.kvSet("token_resume_wakeup_at", String(resetAt));
    const delay = Math.max(0, resetAt + TOKEN_RESUME_BUFFER_MS - Date.now());
    this.tokenResumeTimer = setTimeout(() => this.fireTokenResume(), delay);
    this.tokenResumeTimer.unref?.();
  }

  /** Cancel any pending token-reset wakeup and clear the persisted arm — used when the feature is
   *  toggled off and after a wakeup fires. */
  private disarmTokenResume(): void {
    if (this.tokenResumeTimer) {
      clearTimeout(this.tokenResumeTimer);
      this.tokenResumeTimer = undefined;
    }
    this.tokenResumeArmedFor = undefined;
    this.db.kvSet("token_resume_wakeup_at", "");
  }

  /** The wakeup fired: the token window should have reset. Resume the work that froze on the cap —
   *  paused tasks (nothing else auto-resumes these) and cap-parked review tasks — up to the free
   *  concurrency slots, oldest first, and tell the owner. If the reset estimate was early and there's
   *  still no headroom, re-arm for the next known reset rather than waking into an instant re-cap. */
  private fireTokenResume(): void {
    this.tokenResumeTimer = undefined;
    this.tokenResumeArmedFor = undefined;
    this.db.kvSet("token_resume_wakeup_at", "");
    if (!this.settings().autoResumeOnTokenReset) return; // toggled off while the timer was pending
    if (!this.accounts.hasHeadroom()) {
      const next = this.accounts.soonestResetAt();
      if (next != null) {
        this.hub.log("info", `Token window reset fired early — no headroom yet, re-arming resume ${untilReset(next, Date.now())}.`);
        this.armTokenResume(next);
      } else {
        this.hub.log("info", "Token window reset fired but no account has headroom yet — will re-arm on the next usage ping.");
      }
      return;
    }
    const stuck = this.db
      .listThreads()
      .filter((t) => t.state === "paused" || (t.state === "review" && (t.error ?? "").startsWith(CAP_PARK_PREFIX)))
      .sort((a, b) => a.updatedAt - b.updatedAt); // oldest-stuck first — same fairness as the cap supervisor
    const slots = this.settings().maxConcurrent - this.activePipelines.size;
    if (stuck.length === 0 || slots <= 0) {
      this.hub.log("info", `Token window reset — ${stuck.length} task(s) waiting${slots <= 0 ? ", but no free slots" : ", none stuck"}.`);
      return;
    }
    const resuming = stuck.slice(0, slots);
    const n = resuming.length;
    this.hub.log("info", `Token window reset. Resuming ${n} paused/parked task${n === 1 ? "" : "s"}.`);
    this.hub.publish({
      type: "notice",
      level: "info",
      title: "Token window reset",
      message: `Your token window reset — resuming ${n} ${n === 1 ? "task that was" : "tasks that were"} frozen on the cap.`,
    });
    this.notifyExternal(`↪ Token window reset. Resuming ${n} ${n === 1 ? "task" : "tasks"}.`);
    for (const t of resuming) {
      // Cap-parked review tasks re-enter via the failed→runPipeline path (like resumeCapParked), clearing
      // the marker; a paused task resumes its implementor directly. resumeThread's own resuming/live guards
      // keep this from double-starting a task the cap supervisor is also picking up.
      if (t.state === "review") this.db.updateThread(t.id, { state: "failed", error: null });
      const id = t.id;
      void this.resumeThread(id).catch((e) => this.hub.log("error", `Token-reset resume of ${id.slice(0, 8)} failed: ${String(e)}`));
    }
  }

  /** Restore a token-reset wakeup across a restart: re-arm the timer if the reset is still ahead, or fire
   *  shortly (deferred like the boot auto-resume, so the account pings have landed) if it elapsed while
   *  we were down. Cleared silently if the feature was turned off before the reboot. */
  private restoreTokenResume(): void {
    const raw = this.db.kvGet("token_resume_wakeup_at");
    const at = raw ? Number(raw) : NaN;
    if (!Number.isFinite(at) || at <= 0) return;
    if (!this.settings().autoResumeOnTokenReset) {
      this.db.kvSet("token_resume_wakeup_at", "");
      return;
    }
    if (at + TOKEN_RESUME_BUFFER_MS > Date.now()) {
      this.hub.log("info", `Re-arming token-reset auto-resume after a restart (fires ${untilReset(at, Date.now())}).`);
      this.armTokenResume(at);
    } else {
      this.hub.log("info", "Token window reset elapsed during a restart — resuming frozen tasks shortly.");
      this.tokenResumeArmedFor = at; // hold the latch so a concurrent usage ping doesn't double-arm
      setTimeout(() => this.fireTokenResume(), AUTO_RESUME_DELAY_MS).unref?.();
    }
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

  /** The configured Claude account with this id as dispatch metadata, or null (e.g. the Codex
   *  pseudo-account) — used to relaunch a model-fallback run on the SAME subscription. */
  private acctById(id: string): Acct | null {
    const a = this.accounts.byId(id);
    return a ? { id: a.id, label: a.label, token: a.token || undefined } : null;
  }

  /**
   * When a rate-limited run's model has its OWN metered pool (Fable) and a fresh usage read shows the
   * account's normal windows still have headroom, the cap is the pool's — classifyCap latches it (so
   * modelFor resolves the fallback for this sub) and this reports true: the caller relaunches on the
   * SAME account, resuming the session. False means a real account cap → normal account failover.
   */
  private async modelCapFallback(thread: Thread, role: Role, model: string, acct: Acct, agent: AgentRunLike): Promise<boolean> {
    const fb = fallbackModelFor(model);
    if (!fb || !agent.rateLimited) return false;
    if ((await this.accounts.classifyCap(acct.id, model, agent.rateLimitInfo)) !== "model") return false;
    this.hub.log(
      "warn",
      `${role} on "${thread.title.slice(0, 48)}" hit the ${model} usage pool on ${acct.label} — falling back to ${fb} on the same account, resuming the session.`,
    );
    this.notifyExternal(`↪ ${role} hit the ${model} pool limit mid-task — continuing "${thread.title}" on ${fb} (same account).`);
    return true;
  }

  private logFailover(thread: Thread, role: Role, toLabel: string, info?: RateLimitInfo): void {
    const win = info?.rateLimitType ?? "usage";
    this.hub.log("warn", `${role} on "${thread.title.slice(0, 48)}" hit the ${win} limit — auto-switched account → ${toLabel}, resuming the session.`);
    this.notifyExternal(`↪ ${role} hit a ${win} limit mid-task — auto-switched to ${toLabel}, continuing "${thread.title}".`);
  }

  private async waitForTransientRetry(thread: Thread, role: Role, failure: number, provider: ImplementorProvider): Promise<void> {
    const delayMs = config.transientApiRetryBaseMs * Math.max(1, failure);
    this.hub.log(
      "warn",
      `${role} on "${thread.title.slice(0, 48)}" hit a transient ${providerLabel(provider)} API failure (${failure}/${MAX_TRANSIENT_API_FAILURES}) — retrying${delayMs ? ` in ${delayMs}ms` : " now"}.`,
    );
    if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private providerForRun(agent: AgentRunLike): ImplementorProvider {
    return agent instanceof CodexAgentRun ? "codex" : agent instanceof GrokAgentRun ? "grok" : "claude";
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
    const thread = this.db.createThread({ title: input.title, workspace: input.workspace, rawPrompt: "", brief: input.brief, effortOverride: input.effort ?? null, lane: input.lane ?? null });
    // Stamp the repo's HEAD NOW, before any agent runs — the "before" point for scoping this task's
    // Changes chip to its own diff. Captured pre-enqueue so a foreign commit that lands between here and
    // the implementor starting is still excluded (its files aren't in the task's written-file set). Null
    // when the workspace isn't a git repo; getTaskGitSummary then degrades to a HEAD-relative diff.
    this.db.setBaselineHead(thread.id, await getHeadSha(input.workspace).catch(() => null));
    if (input.images?.length) this.dispatchImages.set(thread.id, input.images.map(toImageBlock));
    this.hub.publish({ type: "thread.upsert", thread });
    // Screenshots attached to the dispatching message reach the implementor model via dispatchImages
    // (transient blocks), but the feed only renders images it can find as attachment rows. Persist
    // them and echo a feed row — exactly what injectThread does — so a screenshot the owner sent with
    // the brief shows as a thumbnail under the brief instead of vanishing.
    if (input.images?.length) {
      const refs = input.images.map((img) => this.db.addAttachment({ name: img.name, mediaType: img.mediaType, data: img.dataBase64 }));
      const m = this.db.addMessage({
        threadId: thread.id,
        role: "director",
        kind: "system",
        content: input.images.length === 1 ? "Image attached to the brief." : `${input.images.length} images attached to the brief.`,
        attachments: refs,
      });
      this.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
    }
    this.hub.log("info", `Dispatched task ${thread.id.slice(0, 8)} "${thread.title}"`);
    this.enqueueOrRun(thread.id);
    return thread.id;
  }

  // ---- settings (operator-tunable, persisted in kv, broadcast like approvalMode) ----

  /** The current pipeline settings, read live from kv (defaults when unset). Read at dispatch/pipeline
   *  time so a change applies to the next task — the agent toggles especially are flipped per task. */
  settings(): OrchestratorSettings {
    const key = this.openaiApiKey();
    const grokAuth = readGrokAuth();
    return {
      plannerEnabled: this.settingBool("setting_planner_enabled", true),
      researcherEnabled: this.settingBool("setting_researcher_enabled", true),
      qaEnabled: this.settingBool("setting_qa_enabled", true),
      autoPush: this.settingBool("setting_auto_push", true),
      directorName: this.directorName(),
      maxQaRounds: this.settingNum("setting_max_qa_rounds", config.maxQaRounds, 1, 12),
      maxConcurrent: this.settingNum("setting_max_concurrent", config.maxConcurrent, 1, 20),
      selfImproveEnabled: this.settingBool("setting_self_improve_enabled", false),
      tokenLimitEnabled: this.settingBool("setting_token_limit_enabled", false),
      tokenLimitPercent: this.settingNum("setting_token_limit_percent", 80, 50, 99),
      autoResumeOnTokenReset: this.settingBool("setting_auto_resume_on_token_reset", false),
      autoResumeThresholdPercent: this.settingNum("setting_auto_resume_threshold_percent", 80, 50, 95),
      fastUsagePolling: this.settingBool("setting_fast_usage_polling", false),
      spreadUsage: this.settingBool("setting_spread_usage", false),
      codexEnabled: this.settingBool("setting_codex_enabled", false),
      codexModel: this.codexModel(),
      codexEffort: this.codexEffort(),
      codexWeeklySafetyPct: this.settingNum("setting_codex_weekly_safety", 100, 1, 100),
      hasOpenaiKey: !!key,
      openaiKeyLast4: key && key.length >= 4 ? key.slice(-4) : null,
      codexChatgptLogin: chatgptLoginAvailable(),
      grokEnabled: this.settingBool("setting_grok_enabled", false),
      grokModel: this.grokModel(),
      grokEffort: this.grokEffort(),
      grokWeeklySafetyPct: this.settingNum("setting_grok_weekly_safety", 100, 1, 100),
      grokPreferred: this.settingBool("setting_grok_preferred", false),
      grokSignedIn: grokAuth.signedIn,
      grokAccount: grokAuth.email,
      skipDirector: this.settingBool("setting_skip_director", false),
      showComposerPickers: this.settingBool("setting_show_composer_pickers", false),
      showAgentModel: this.settingBool("setting_show_agent_model", true),
      skipDirectorEffort: this.skipDirectorEffort(),
      xhighEnabled: config.enableXhigh,
      skipDirectorRetitle: this.settingBool("setting_skip_director_retitle", true),
      maxRecentRepos: this.settingNum("setting_max_recent_repos", 5, 1, 20),
      recentRepos: this.recentRepos(),
      modelOverrides: this.modelOverrides(),
      accountEffortCaps: this.accountEffortCaps(),
      modelDefaults: { ...config.models },
      claudeModels: this.pickableClaudeModels(),
      codexModels: this.pickableCodexModels(),
      grokModels: this.pickableGrokModels(),
    };
  }

  // ---- per-(subscription × role) model selection ----

  /** The operator-picked model overrides ({subId → {role → modelId}}), parsed from kv. A corrupt or
   *  absent value degrades to an empty map rather than throwing. */
  private modelOverrides(): ModelOverrides {
    const raw = this.db.kvGet("setting_model_overrides");
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as ModelOverrides) : {};
    } catch {
      return {};
    }
  }

  /** The Claude model a given subscription runs a role on: the sub's own per-role override, else the
   *  global "default" override, else the built-in config.models default. The Settings "Agent models"
   *  section that used to edit the default layer is gone (model selection now lives in the per-subscription
   *  cards), but the composer's quick implementor/director model picker still writes that default layer
   *  (Director.tsx), so it stays a live fallback. Used at dispatch so a change applies to the next run.
   *  `subId` is the AccountDTO.id the role will run on. */
  modelFor(subId: string, role: Role): string {
    const ov = this.modelOverrides();
    const model = ov[subId]?.[role]?.trim() || ov[DEFAULT_SUB_ID]?.[role]?.trim() || config.models[role];
    // A model whose OWN metered pool is exhausted on this sub (Fable's gated allowance) dispatches on
    // its fallback until the pool frees — the sub's normal windows still have headroom, so neither
    // parking the task nor switching accounts would be right. classifyCap latches the limit.
    const fb = fallbackModelFor(model);
    return fb && this.accounts.isModelLimited(subId, model) ? fb : model;
  }

  /** Set (or, with a blank value, clear) one (subId, role) model override in the persisted matrix. */
  private setModelOverride(subId: string, role: Role, model: string): void {
    const ov = this.modelOverrides();
    const sub = { ...(ov[subId] ?? {}) };
    if (model.trim()) sub[role] = model.trim().slice(0, 100);
    else delete sub[role];
    if (Object.keys(sub).length) ov[subId] = sub;
    else delete ov[subId];
    this.db.kvSet("setting_model_overrides", JSON.stringify(ov));
  }

  /** Pickable Claude model ids for the Settings dropdowns: the live list unioned with the curated
   *  fallback and every currently-selected Claude model, so a picked model never drops out of its list. */
  private pickableClaudeModels(): string[] {
    const ov = this.modelOverrides();
    const selected: string[] = [];
    for (const [subId, roles] of Object.entries(ov)) {
      if (subId === CODEX_SUB_ID || subId === GROK_SUB_ID) continue; // non-Claude ids belong to their own lists
      for (const m of Object.values(roles)) if (m) selected.push(m);
    }
    return uniq([...this.modelCatalog.claudeModels(), ...CURATED_CLAUDE_MODELS, ...Object.values(config.models), ...selected]);
  }

  /** Pickable Codex model ids for the Settings dropdown: curated flagships first, then any additional
   *  live models the key exposes, plus the currently-selected Codex model. */
  private pickableCodexModels(): string[] {
    const selected = [this.codexModel(), this.modelOverrides()[CODEX_SUB_ID]?.implementor].filter((x): x is string => !!x);
    return uniq([...CURATED_CODEX_MODELS, ...this.modelCatalog.codexModels(), ...selected]);
  }

  /** Pickable Grok model ids for the Settings dropdown: curated defaults first, then any additional models
   *  the CLI's local cache reports, plus the currently-selected Grok model. */
  private pickableGrokModels(): string[] {
    const selected = [this.grokModel(), this.modelOverrides()[GROK_SUB_ID]?.implementor].filter((x): x is string => !!x);
    return uniq([...CURATED_GROK_MODELS, ...this.modelCatalog.grokModels(), ...selected]);
  }

  /** The persisted recent-repo paths (most-recent first), trimmed to the configured cap. Stored as a
   *  JSON array in kv; a corrupt/absent value degrades to an empty list rather than throwing. */
  private recentRepos(): string[] {
    const raw = this.db.kvGet("setting_recent_repos");
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const max = this.settingNum("setting_max_recent_repos", 5, 1, 20);
      return list.slice(0, max);
    } catch {
      return [];
    }
  }

  /** The director persona's operator-chosen display name. Defaults to a conspicuous placeholder so a
   *  fresh install visibly prompts the operator to set their own in Settings. Unlike the gnome-pool
   *  agents, the director is a singleton persona, so its name is one global setting — not a per-task
   *  (thread, role) assignment. Trimmed + length-capped to match what the UI/office can render. */
  directorName(): string {
    return this.db.kvGet("setting_director_name")?.trim() || "ChangeNameInSettings";
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

  /** The selected Codex implementor model. Resolution: the model-overrides matrix (codex.implementor),
   *  then the legacy `setting_codex_model` kv (so pre-matrix configs migrate seamlessly), then the
   *  built-in default. Never inherits a Claude default — a Claude model id is invalid for the Codex CLI. */
  private codexModel(): string {
    return (
      this.modelOverrides()[CODEX_SUB_ID]?.implementor?.trim() ||
      this.db.kvGet("setting_codex_model")?.trim() ||
      config.codex.defaultModel
    );
  }

  /** The Codex CLI reasoning-effort override, normalized to the selected model's accepted range.
   * GPT-5.6 accepts `max`; earlier Codex models cap at `xhigh`. */
  private codexEffort(model = this.codexModel()): CodexEffort {
    const v = this.db.kvGet("setting_codex_effort")?.trim();
    const requested = CODEX_EFFORTS.includes(v as CodexEffort) ? (v as CodexEffort) : "high";
    return resolveCodexEffort(model, requested);
  }

  /** The selected Grok implementor model. Resolution: the model-overrides matrix (grok.implementor), then
   *  the legacy `setting_grok_model` kv (migration fallback), then the built-in default. Never inherits a
   *  Claude/Codex default — those model ids are invalid for the Grok CLI. */
  private grokModel(): string {
    return (
      this.modelOverrides()[GROK_SUB_ID]?.implementor?.trim() ||
      this.db.kvGet("setting_grok_model")?.trim() ||
      config.grok.defaultModel
    );
  }

  /** The Grok CLI reasoning-effort override (low/medium/high; the model default is high). */
  private grokEffort(): GrokEffort {
    const v = this.db.kvGet("setting_grok_effort")?.trim();
    return GROK_EFFORTS.includes(v as GrokEffort) ? (v as GrokEffort) : "high";
  }

  /** Per-Claude-account MAX reasoning-effort caps ({accountId → effort}), parsed from kv. The
   *  director/planner still chooses the per-task effort; this only caps it so a heavy tier never runs on a
   *  sub the operator wants kept cheap. A corrupt/absent value degrades to an empty map (uncapped). */
  private accountEffortCaps(): Record<string, Effort> {
    const raw = this.db.kvGet("setting_account_effort_caps");
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, Effort> = {};
      for (const [id, eff] of Object.entries(v as Record<string, unknown>)) {
        if (typeof eff === "string" && EFFORTS.includes(eff as Effort)) out[id] = eff as Effort;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** The effort cap for one Claude account — the operator-set max, else `max` (uncapped). xhigh is coerced
   *  to high while the ENABLE_XHIGH opt-in is off, mirroring resolveEffort so a cap can't smuggle in a tier
   *  this machine can't send. */
  private accountMaxEffort(accountId: string): Effort {
    const cap = this.accountEffortCaps()[accountId] ?? "max";
    return cap === "xhigh" && !config.enableXhigh ? "high" : cap;
  }

  /** The composer's implementor-effort pick for skip-director dispatches. "auto" (default) leaves the
   *  planner's per-task pick in charge; a concrete tier is snapshotted onto the thread at dispatch and
   *  beats the plan. A stored `xhigh` degrades to `high` while the ENABLE_XHIGH opt-in is off, mirroring
   *  resolveEffort — so the dropdown never claims a tier this machine can't send. */
  private skipDirectorEffort(): Effort | "auto" {
    const v = this.db.kvGet("setting_skip_director_effort")?.trim();
    if (!v || !EFFORTS.includes(v as Effort)) return "auto";
    return v === "xhigh" && !config.enableXhigh ? "high" : (v as Effort);
  }

  /** The raw OpenAI key: the kv-stored UI value if present, else the server/.env fallback. NEVER
   *  broadcast — only its presence + last 4 chars leave the server (settings()). Public for the one
   *  out-of-band server-side consumer (the Codex usage ping seeds auth with it); it must never
   *  cross the WS. */
  openaiApiKey(): string | undefined {
    return this.db.kvGet("openai_api_key")?.trim() || config.codex.envKey;
  }

  /** Persist a partial settings change, broadcast the full new set, and pump the queue (a raised
   *  maxConcurrent may have freed slots). Returns the resulting settings. */
  setSettings(patch: SettingsPatch): OrchestratorSettings {
    if (patch.plannerEnabled !== undefined) this.db.kvSet("setting_planner_enabled", patch.plannerEnabled ? "1" : "0");
    if (patch.researcherEnabled !== undefined) this.db.kvSet("setting_researcher_enabled", patch.researcherEnabled ? "1" : "0");
    if (patch.qaEnabled !== undefined) this.db.kvSet("setting_qa_enabled", patch.qaEnabled ? "1" : "0");
    if (patch.autoPush !== undefined) this.db.kvSet("setting_auto_push", patch.autoPush ? "1" : "0");
    if (patch.directorName !== undefined) this.db.kvSet("setting_director_name", patch.directorName.trim().slice(0, 40));
    if (patch.maxQaRounds !== undefined) this.db.kvSet("setting_max_qa_rounds", String(patch.maxQaRounds));
    if (patch.maxConcurrent !== undefined) this.db.kvSet("setting_max_concurrent", String(patch.maxConcurrent));
    if (patch.selfImproveEnabled !== undefined) this.db.kvSet("setting_self_improve_enabled", patch.selfImproveEnabled ? "1" : "0");
    if (patch.tokenLimitEnabled !== undefined) this.db.kvSet("setting_token_limit_enabled", patch.tokenLimitEnabled ? "1" : "0");
    if (patch.tokenLimitPercent !== undefined) this.db.kvSet("setting_token_limit_percent", String(patch.tokenLimitPercent));
    if (patch.autoResumeOnTokenReset !== undefined) this.db.kvSet("setting_auto_resume_on_token_reset", patch.autoResumeOnTokenReset ? "1" : "0");
    if (patch.autoResumeThresholdPercent !== undefined) this.db.kvSet("setting_auto_resume_threshold_percent", String(patch.autoResumeThresholdPercent));
    if (patch.fastUsagePolling !== undefined) this.db.kvSet("setting_fast_usage_polling", patch.fastUsagePolling ? "1" : "0");
    if (patch.spreadUsage !== undefined) {
      this.db.kvSet("setting_spread_usage", patch.spreadUsage ? "1" : "0");
      this.accounts.setSpreadUsage(patch.spreadUsage);
    }
    if (patch.codexEnabled !== undefined) this.db.kvSet("setting_codex_enabled", patch.codexEnabled ? "1" : "0");
    if (patch.codexEffort !== undefined && CODEX_EFFORTS.includes(patch.codexEffort)) this.db.kvSet("setting_codex_effort", patch.codexEffort);
    if (patch.codexWeeklySafetyPct !== undefined) this.db.kvSet("setting_codex_weekly_safety", String(patch.codexWeeklySafetyPct));
    // Legacy free-text codex model field: mirror it into the matrix (codex.implementor) so the two stay
    // coherent regardless of which UI wrote it, and keep the legacy kv as a migration fallback.
    if (patch.codexModel !== undefined && patch.codexModel.trim()) {
      this.db.kvSet("setting_codex_model", patch.codexModel.trim());
      this.setModelOverride(CODEX_SUB_ID, "implementor", patch.codexModel.trim());
    }
    if (patch.grokEnabled !== undefined) this.db.kvSet("setting_grok_enabled", patch.grokEnabled ? "1" : "0");
    if (patch.grokWeeklySafetyPct !== undefined) this.db.kvSet("setting_grok_weekly_safety", String(patch.grokWeeklySafetyPct));
    if (patch.grokPreferred !== undefined) this.db.kvSet("setting_grok_preferred", patch.grokPreferred ? "1" : "0");
    if (patch.grokEffort !== undefined && GROK_EFFORTS.includes(patch.grokEffort)) this.db.kvSet("setting_grok_effort", patch.grokEffort);
    // Legacy free-text grok model field mirrors into the matrix (grok.implementor), same as codex.
    if (patch.grokModel !== undefined && patch.grokModel.trim()) {
      this.db.kvSet("setting_grok_model", patch.grokModel.trim());
      this.setModelOverride(GROK_SUB_ID, "implementor", patch.grokModel.trim());
    }
    if (patch.modelOverrides !== undefined) this.db.kvSet("setting_model_overrides", JSON.stringify(sanitizeModelOverrides(patch.modelOverrides)));
    if (patch.accountEffortCaps !== undefined) this.db.kvSet("setting_account_effort_caps", JSON.stringify(sanitizeAccountEffortCaps(patch.accountEffortCaps)));
    // Write-only key: store the trimmed value, or clear it (empty string) so settings() falls back to
    // the env key (if any). The raw key is never returned to clients — only hasOpenaiKey/last4 are.
    if (patch.openaiApiKey !== undefined) {
      this.db.kvSet("openai_api_key", patch.openaiApiKey.trim());
      // A freshly-entered key can now list its models — refresh the Codex dropdown right away instead of
      // waiting for the slow timer (it rebroadcasts settings itself when the list changes).
      void this.modelCatalog.refresh();
    }
    if (patch.skipDirector !== undefined) this.db.kvSet("setting_skip_director", patch.skipDirector ? "1" : "0");
    if (patch.showComposerPickers !== undefined) this.db.kvSet("setting_show_composer_pickers", patch.showComposerPickers ? "1" : "0");
    if (patch.showAgentModel !== undefined) this.db.kvSet("setting_show_agent_model", patch.showAgentModel ? "1" : "0");
    if (patch.skipDirectorEffort !== undefined && (patch.skipDirectorEffort === "auto" || EFFORTS.includes(patch.skipDirectorEffort)))
      this.db.kvSet("setting_skip_director_effort", patch.skipDirectorEffort);
    if (patch.skipDirectorRetitle !== undefined) this.db.kvSet("setting_skip_director_retitle", patch.skipDirectorRetitle ? "1" : "0");
    if (patch.maxRecentRepos !== undefined) this.db.kvSet("setting_max_recent_repos", String(patch.maxRecentRepos));
    // Recent repos: de-dupe (most-recent first), drop blanks, and cap at the current max before persisting
    // so the stored list can never outgrow the display cap regardless of what a client sends.
    if (patch.recentRepos !== undefined) {
      const max = patch.maxRecentRepos ?? this.settingNum("setting_max_recent_repos", 5, 1, 20);
      const cleaned = patch.recentRepos.map((p) => p.trim()).filter(Boolean);
      const deduped = [...new Set(cleaned)].slice(0, Math.min(max, 20));
      this.db.kvSet("setting_recent_repos", JSON.stringify(deduped));
    }
    const settings = this.settings();
    this.hub.publish({ type: "settings", settings });
    this.pumpQueue();
    // Re-evaluate the token-safety limit now, so enabling it (or lowering the threshold) while already
    // over the line stops running tasks immediately instead of waiting for the next ~10-min usage ping.
    this.enforceTokenSafetyLimit();
    // And re-evaluate the token-reset auto-resume, so toggling it off cancels a pending wakeup at once and
    // turning it on (or lowering the threshold) while usage is already high arms the resume immediately.
    this.maybeScheduleTokenResume();
    // Retune the account usage-ping cadence in case the fast-polling toggle just flipped.
    this.applyUsagePollInterval();
    return settings;
  }

  /** Point the account manager's periodic usage ping at the cadence the "Fast usage polling" setting
   *  selects — the 30s fast interval when opted in, else the default. Called on boot and whenever
   *  settings change; setPingInterval no-ops when the cadence is unchanged. */
  private applyUsagePollInterval(): void {
    this.accounts.setPingInterval(this.settings().fastUsagePolling ? config.fastAccountPingMs : config.accountPingMs);
  }

  /** Validate the stored (or a just-typed) OpenAI key against the API for the Test-connection button. */
  async testCodexConnection(apiKey?: string): Promise<CodexTestResult> {
    return testOpenAiKey(apiKey?.trim() || this.openaiApiKey());
  }

  /** Restore the persisted Codex usage-cap latch on boot, so a restart's auto-resume wave keeps routing
   *  implementors to Claude until the window resets instead of re-slamming a still-capped Codex. */
  private loadCodexCap(): void {
    const v = this.db.kvGet(CODEX_CAP_KV_KEY);
    const until = v ? Number(v) : NaN;
    if (Number.isFinite(until) && until > Date.now()) this.codexCapUntil = until;
    else if (v) this.db.kvSet(CODEX_CAP_KV_KEY, ""); // stale/expired — clear it
  }

  /** Latch Codex as usage-capped until its window resets, so implementors route to the Claude backend.
   *  Prefers the real reset epoch from the usage snapshot; falls back to a fixed cooldown when unknown. */
  private noteCodexCap(): void {
    const now = Date.now();
    const u = readCodexUsage();
    const snapReset = [u?.fiveHourReset, u?.sevenDayReset].filter((r): r is number => !!r && r > now);
    const until = snapReset.length ? Math.min(...snapReset) : now + CODEX_CAP_COOLDOWN_MS;
    if (this.codexCapUntil && this.codexCapUntil >= until) return; // already latched at least this long
    this.codexCapUntil = until;
    this.db.kvSet(CODEX_CAP_KV_KEY, String(until));
    this.hub.log("warn", `Codex hit its usage cap — routing implementors to Claude until ${new Date(until).toLocaleString()}.`);
  }

  /** Whether Codex should be treated as usage-capped right now (route implementors to Claude). True while
   *  the live-run latch is active OR the latest usage snapshot shows a window fully consumed. Clears an
   *  expired latch as a side effect so Codex is retried the moment its window resets. */
  private codexCapActive(): boolean {
    const now = Date.now();
    if (this.codexCapUntil != null) {
      if (now < this.codexCapUntil) return true;
      this.codexCapUntil = undefined;
      this.db.kvSet(CODEX_CAP_KV_KEY, "");
    }
    return codexUsageCapped(now);
  }

  /** Restore the persisted Grok usage-cap latch on boot (mirrors loadCodexCap). */
  private loadGrokCap(): void {
    const v = this.db.kvGet(GROK_CAP_KV_KEY);
    const until = v ? Number(v) : NaN;
    if (Number.isFinite(until) && until > Date.now()) {
      this.grokCapUntil = until;
      noteGrokCap(until);
    } else if (v) this.db.kvSet(GROK_CAP_KV_KEY, ""); // stale/expired — clear it
  }

  /** Latch Grok as usage-capped after a rejected turn, routing implementors to another backend. The live
   *  weekly scrape normally supplies the true reset; before it lands, a fixed cooldown keeps the latch
   *  self-expiring. Mirrors the chip's countdown via noteGrokCap. */
  private noteGrokCap(): void {
    const now = Date.now();
    // Prefer the real weekly reset from the live `/usage show` scrape; fall back to a fixed cooldown when
    // no scrape has landed yet (so the latch always self-expires rather than sticking forever).
    const reset = readGrokUsage().sevenDayReset;
    const until = reset != null && reset > now ? reset : now + config.grok.capCooldownMs;
    if (this.grokCapUntil && this.grokCapUntil >= until) return; // already latched at least this long
    this.grokCapUntil = until;
    this.db.kvSet(GROK_CAP_KV_KEY, String(until));
    noteGrokCap(until);
    this.hub.log("warn", `Grok hit its usage cap — routing implementors elsewhere until ${new Date(until).toLocaleString()}.`);
  }

  /** Whether Grok should be treated as usage-capped right now. Clears an expired latch as a side effect. */
  private grokCapActive(): boolean {
    const now = Date.now();
    if (this.grokCapUntil != null) {
      if (now < this.grokCapUntil) return true;
      this.grokCapUntil = undefined;
      this.db.kvSet(GROK_CAP_KV_KEY, "");
      noteGrokCap(null);
    }
    // Also honor the scraped weekly window: if `/usage show` shows 100% used (not yet reset), Grok is
    // capped even without a live-run rejection.
    return grokUsageCapped(now);
  }

  private claudeProviderCandidate(): ProviderCandidate {
    const c = this.accounts.dispatchPreview();
    return providerCandidateFromClaude(c);
  }

  /** Grok's dispatch candidate. Weekly used-% + reset come from the CLI log / winpty scrape; monthly
   *  credits from the HTTP billing ping (see grokUsagePing). Grok competes by soonest weekly reset like
   *  Claude/Codex. Headroom = not cap-latched, not near the weekly hard limit, and not monthly-exhausted.
   *  When no reading has landed yet the windows are null (treated as headroom, sorts last) until the first
   *  ping fills in. */
  private grokProviderCandidate(): ProviderCandidate {
    const now = Date.now();
    const u = readGrokUsage();
    const nearWeekly =
      u.sevenDay != null && u.sevenDay >= PROVIDER_HARD_LIMIT && (u.sevenDayReset == null || u.sevenDayReset > now);
    const monthlyExhausted =
      u.monthlyUsed != null &&
      u.monthlyLimit != null &&
      u.monthlyLimit > 0 &&
      u.monthlyUsed >= u.monthlyLimit &&
      (u.monthlyReset == null || u.monthlyReset > now);
    return {
      provider: "grok",
      hasHeadroom: !this.grokCapActive() && !nearWeekly && !monthlyExhausted,
      fiveHour: null,
      sevenDay: u.sevenDay,
      sevenDayReset: u.sevenDayReset,
      weeklySafetyPct: this.settings().grokWeeklySafetyPct,
    };
  }

  /** Whether the Grok backend could take an implementor RIGHT NOW — enabled, signed in, and not
   *  usage-capped. Used by the failover ladder + cap supervisor so "every account is rate-limited" is only
   *  ever claimed when Grok genuinely can't step in either. */
  private grokImplementorReady(): boolean {
    if (!this.settings().grokEnabled) return false;
    if (!grokAuthAvailable()) return false;
    return !this.grokCapActive();
  }

  private codexProviderCandidate(): ProviderCandidate {
    const now = Date.now();
    const u = readCodexUsage();
    const nearLimit = (pct: number | null, reset: number | null): boolean =>
      pct != null && pct >= PROVIDER_HARD_LIMIT && (reset == null || reset > now);
    return {
      provider: "codex",
      hasHeadroom:
        !nearLimit(u?.fiveHour ?? null, u?.fiveHourReset ?? null) &&
        !nearLimit(u?.sevenDay ?? null, u?.sevenDayReset ?? null),
      fiveHour: u?.fiveHour ?? null,
      sevenDay: u?.sevenDay ?? null,
      sevenDayReset: u?.sevenDayReset ?? null,
      weeklySafetyPct: this.settings().codexWeeklySafetyPct,
    };
  }

  /** Pick the best implementor backend from N candidates: prefer any WITH headroom, and within a headroom
   *  class break ties by providerPriority (soonest weekly reset, then most headroom) — see the "Spread
   *  usage" exception below, which flips that to lowest-weekly-usage. Grok's null windows sort it last among
   *  headroom-havers, making it the resilient fallback. The caller always passes at least the Claude
   *  candidate, so this never sees an empty list. Reused by nextReadyImplementor.
   *
   *  Exception — "Prefer Grok": when the operator opts in (grokPreferred) and Grok remains below its
   *  weekly safety ceiling, it takes the implementor outright instead of participating in reset ranking.
   *  Safety and hard-cap detection still handle fallback to another provider.
   *
   *  "Spread usage": when the operator opts in (spreadUsage), the tie-break flips from soonest-reset to
   *  LOWEST weekly usage — the backend with the most weekly headroom takes the implementor — so burn
   *  evens out across all platforms. "Prefer Grok" still overrides it; the safety fallback still supersedes. */
  private preferredImplementorProvider(candidates: ProviderCandidate[]): ImplementorProvider {
    const withHeadroom = candidates.filter((c) => c.hasHeadroom);
    const base = withHeadroom.length ? withHeadroom : candidates;
    // Soft weekly ceiling (per-backend): a backend whose weekly usage crossed its safety % is de-preferred in
    // favor of one still under its own ceiling — but never dropped entirely (falls through when all are over,
    // so this can't freeze a dispatch). Claude carries the selected account's own ceiling; Codex and Grok
    // carry their backend ceilings.
    const safety = weeklySafetyPool(base);
    const pool = safety.candidates;
    // Preference is applied only AFTER the safety filter: it cannot re-add an over-threshold Grok candidate.
    // "Prefer Grok" is a more specific explicit override, so it still wins over the spread-usage balancer.
    if (this.settings().grokPreferred && pool.some((c) => c.provider === "grok" && c.hasHeadroom)) return "grok";
    // Spread usage: balance across ALL backends by lowest weekly usage. The all-over-safety no-freeze
    // fallback (most headroom) supersedes both it and the default soonest-reset order.
    const priority = safety.allOver
      ? providerSafetyFallbackPriority
      : this.settings().spreadUsage
        ? providerSpreadUsage
        : providerPriority;
    return pool.reduce((best, c) => (priority(best, c) <= 0 ? best : c)).provider;
  }

  /** The best implementor backend OTHER than `exclude` that can take over RIGHT NOW (has headroom), or
   *  undefined when none can. Drives cross-provider failover: a capped backend hands off to whichever of
   *  the remaining ones is readiest. */
  private nextReadyImplementor(exclude: ImplementorProvider, unavailable: ReadonlySet<ImplementorProvider> = new Set()): ImplementorProvider | undefined {
    const cands: ProviderCandidate[] = [];
    if (exclude !== "claude" && !unavailable.has("claude")) {
      const c = this.claudeProviderCandidate();
      if (c.hasHeadroom) cands.push(c);
    }
    if (exclude !== "codex" && !unavailable.has("codex") && this.codexImplementorReady()) cands.push(this.codexProviderCandidate());
    if (exclude !== "grok" && !unavailable.has("grok") && this.grokImplementorReady()) cands.push(this.grokProviderCandidate());
    if (!cands.length) return undefined;
    return this.preferredImplementorProvider(cands);
  }

  /** Whether the Codex backend could take an implementor RIGHT NOW — enabled, authed, not usage-capped,
   *  and with window headroom. The Claude-cap failover and the cap supervisor use this, so "every account
   *  is rate-limited" is only ever claimed (and frozen on) when Codex genuinely can't step in either.
   *  Deliberately treats "no usage reading yet" as headroom: API-key-billed Codex has no plan windows and
   *  never produces one, so requiring a reading would permanently disable the failover for those setups.
   *  A blind flip onto a secretly-capped Codex is bounded — the run 429s and flips back or parks. */
  private codexImplementorReady(): boolean {
    if (!this.settings().codexEnabled) return false;
    const key = this.openaiApiKey();
    if (!codexAuthAvailable(!!key && /^sk-/.test(key))) return false;
    if (this.codexCapActive()) return false;
    return this.codexProviderCandidate().hasHeadroom;
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

  /** Restore each Claude account's persisted weekly-safety ceiling into the live AccountManager on boot. */
  private applyAccountWeeklySafety(): void {
    for (const a of config.accounts) {
      const v = this.db.kvGet(`account_weekly_safety_${a.id}`);
      if (v != null) this.accounts.applyWeeklySafetyPct(a.id, Number(v));
    }
  }

  /** Set a Claude account's soft weekly-safety ceiling (1-100; 100 = off), persisting it. Above this weekly
   *  utilization the sub sheds new dispatches to a fresher one — no freeze. Re-broadcasts the strip so a
   *  no-op change still reconciles every client. */
  setAccountWeeklySafety(id: string, pct: number): boolean {
    const applied = this.accounts.setWeeklySafetyPct(id, pct);
    if (applied) this.db.kvSet(`account_weekly_safety_${id}`, String(this.accounts.dto().find((a) => a.id === id)?.weeklySafetyPct ?? pct));
    this.hub.publish({ type: "accounts", accounts: this.accounts.dto() });
    return applied;
  }

  /** Resolve which backend implements tasks right now from the subscription toggles, or an error
   *  explaining why none can. Claude is always in the pool; Codex and Grok are opt-in and, when enabled +
   *  authed + uncapped, compete with Claude under the same weekly-reset (or, with Spread usage on,
   *  lowest-weekly-usage) policy instead of overriding it. Planner/researcher/QA start on Claude and fail
   *  over to a ready CLI when Claude is exhausted. */
  private resolveImplementorProvider(): { provider?: ImplementorProvider; error?: string } {
    const s = this.settings();
    const candidates: ProviderCandidate[] = [this.claudeProviderCandidate()];

    // Codex: usable auth is EITHER a ChatGPT-plan `codex login` (preferred — no API billing) OR a valid
    // OpenAI API key. Enabled + authed but usage-capped → simply excluded from this dispatch (the latch
    // auto-clears when its window resets, so Codex rejoins on its own).
    if (s.codexEnabled) {
      const key = this.openaiApiKey();
      if (!codexAuthAvailable(!!key && /^sk-/.test(key))) {
        return { error: "Codex is enabled but has no usable auth: no ChatGPT `codex login` was found and no valid OpenAI API key (sk-…) is set. Sign in with `codex login --device-auth` (uses your ChatGPT plan), or add an API key under Settings → Subscriptions, or turn Codex off to use Claude." };
      }
      if (this.codexCapActive()) this.hub.log("info", "Codex is usage-capped — excluding it from this dispatch until its window resets.");
      else candidates.push(this.codexProviderCandidate());
    }

    // Grok: usable auth is a `grok login` (~/.grok/auth.json) or an XAI_API_KEY. Same cap-exclusion policy.
    if (s.grokEnabled) {
      if (!grokAuthAvailable()) {
        return { error: "Grok is enabled but has no usable auth: no `grok login` was found (~/.grok/auth.json) and no XAI_API_KEY is set. Run `grok login` (or `grok login --device-auth` on a headless box), or turn Grok off to use Claude." };
      }
      if (this.grokCapActive()) this.hub.log("info", "Grok is usage-capped — excluding it from this dispatch until it frees up.");
      else candidates.push(this.grokProviderCandidate());
    }

    const provider = this.preferredImplementorProvider(candidates);
    if (candidates.length > 1) {
      const now = Date.now();
      const parts = candidates.map(
        (c) => `${c.provider} weekly ${fmtUsage(c.sevenDay)}${c.sevenDayReset != null ? ` reset ${untilReset(c.sevenDayReset, now)}` : ""}`,
      );
      this.hub.log("info", `Implementor provider: ${provider} (${parts.join("; ")}).`);
    }
    return { provider };
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
    if (state === "done") {
      this.notifyExternal(`✓ done: "${t.title}"`);
      void this.announceDone(t);
    }
    // A cap-park lands in 'review' too, but it's auto-handled by the supervisor — don't ping "needs your
    // review" (misleading, and it would re-fire every time a re-capping task re-parks).
    else if (state === "review" && !(t.error ?? "").startsWith(CAP_PARK_PREFIX)) this.notifyExternal(`⚠ needs your review: "${t.title}"`);
    else if (state === "failed") this.notifyExternal(`✗ failed: "${t.title}"${t.error ? ` — ${t.error}` : ""}`);
  }

  /** Voice mode: speak a task-tailored completion line through the gateway. completionAnnouncement
   *  returns null when voice mode is off (gateway down or mic toggled off) — nothing is published or spent. */
  private async announceDone(t: Thread): Promise<void> {
    const text = await completionAnnouncement(t, this.accounts.auxToken()).catch(() => null);
    if (text) this.hub.publish({ type: "voice.announce", threadId: t.id, text });
  }

  /** Settle a task to 'review' after an incomplete run. If the run gave up ONLY because every account
   *  was capped (the `capParked` flag), tag it with the CAP_PARK marker so the supervisor auto-resumes
   *  it when an account frees up; otherwise use the human-facing reason (a genuine needs-your-eyes park).
   *  The flag is consumed here so it never leaks into an unrelated later settle of the same thread. */
  private settleReview(threadId: string, humanReason: string): void {
    const need = this.capParked.get(threadId);
    this.capParked.delete(threadId);
    if (need) this.setState(threadId, "review", this.capParkMessage(need));
    else this.setState(threadId, "review", humanReason);
  }

  /** Review message for a cap-park — doubles as the supervisor's marker (CAP_PARK_PREFIX, plus the
   *  historical CAP_PARK_QA_MARK for QA-stage parks) and tells the owner it'll resume itself, naming when
   *  the soonest account frees up if we know it. Scoped honestly: it only claims "every account" when
   *  CLI backends were genuinely unavailable too (Claude→Codex/Grok failover already tried them). */
  private capParkMessage(need: "qa" | "implementor"): string {
    const now = Date.now();
    const codexOn = this.settings().codexEnabled;
    const grokOn = this.settings().grokEnabled;
    const cliOn = codexOn || grokOn;
    const resets = [this.accounts.soonestResetAt()];
    if (cliOn) {
      if (codexOn) {
        const u = readCodexUsage();
        resets.push(u?.fiveHourReset ?? null, u?.sevenDayReset ?? null);
      }
      if (grokOn) {
        const u = readGrokUsage();
        resets.push(u?.sevenDayReset ?? null);
      }
    }
    const future = resets.filter((r): r is number => r != null && r > now);
    const when = future.length ? ` Soonest account resets ${untilReset(Math.min(...future), now)}.` : "";
    const cliLabel = codexOn && grokOn ? "Codex and Grok" : codexOn ? "Codex" : grokOn ? "Grok" : "";
    const scope =
      need === "qa"
        ? cliOn
          ? `every backend — Claude subscriptions and ${cliLabel} — was rate-limited during QA ${CAP_PARK_QA_MARK}`
          : `every Claude subscription was rate-limited during QA ${CAP_PARK_QA_MARK}`
        : cliOn
          ? `every account — Claude subscriptions and ${cliLabel} — was rate-limited mid-task`
          : "every Claude subscription was rate-limited mid-task";
    return `${CAP_PARK_PREFIX} — ${scope}.${when} It will resume automatically when one frees up (no manual Resume needed).`;
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
    const slotToken = Symbol("pipeline");
    this.activePipelines.add(threadId);
    this.activePipelineToken.set(threadId, slotToken);
    const releaseSlot = () => {
      // Superseded by a newer pipeline for this thread (cancel→retry within our unwind window)? It owns
      // the slot now — a stale finalizer deleting its entry would under-count the concurrency gate.
      if (this.activePipelineToken.get(threadId) !== slotToken) return;
      this.activePipelineToken.delete(threadId);
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
      // Read lane (dispatch_read): short-circuit the whole planner→implementor→QA pipeline to a single
      // read-only reader stage. readerDone (mirroring planDone) makes the answer sticky across resume, so
      // a server restart mid-read can't re-run the reader and double-post the answer. releaseSlot still
      // runs in `finally`.
      if (thread.lane === "read") {
        if (!saved.readerDone) await this.runReader(thread, directorNote);
        return;
      }

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
      await this.runImplementorQa(thread, kickoff, thread.effortOverride ?? plan?.effort, this.latestImplementorSession(threadId), note, {
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
   *  account label ("codex:…" ⇒ Codex, "grok:…" ⇒ Grok, else Claude). A session id is provider-specific (a
   *  Claude SDK session vs a Codex thread id vs a Grok session id), so a resume must only reuse one whose
   *  backend matches the now-resolved provider. */
  private priorImplementorProvider(threadId: string): ImplementorProvider | undefined {
    const run = this.db
      .listRuns(threadId)
      .filter((r) => r.role === "implementor" && r.sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!run) return undefined;
    return run.account?.startsWith("codex:") ? "codex" : run.account?.startsWith("grok:") ? "grok" : "claude";
  }

  /** The most recent QA run that has a session id (any backend), so fix-rounds 2..N can resume it. */
  private latestQaRun(threadId: string): { sessionId: string; provider: ImplementorProvider } | undefined {
    const run = this.db
      .listRuns(threadId)
      .filter((r) => r.role === "qa" && r.sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!run?.sessionId) return undefined;
    const provider: ImplementorProvider = run.account?.startsWith("codex:")
      ? "codex"
      : run.account?.startsWith("grok:")
        ? "grok"
        : "claude";
    return { sessionId: run.sessionId, provider };
  }

  /** The most recent QA run's session id (any backend). Prefer `latestQaRun` when the provider matters. */
  private latestQaSession(threadId: string): string | undefined {
    return this.latestQaRun(threadId)?.sessionId;
  }

  /** Run a one-shot role to a result. Usage caps switch Claude accounts as before. Transient provider
   *  failures retry three times, then planner/researcher/QA can continue on an enabled CLI backend.
   *  `opts.preferredProvider` starts the role on a CLI backend (e.g. warm-resuming a prior Grok QA
   *  session — session ids are not portable across providers). */
  private async runRole(
    thread: Thread,
    role: "planner" | "researcher" | "qa" | "reader",
    kickoff: string | unknown[],
    makeCfg: (ctx: { token: string | undefined; resume?: string; runId: string }) => AgentRunConfig,
    initialResume?: string,
    opts?: { preferredProvider?: ImplementorProvider },
  ): Promise<ResultEvent | undefined> {
    let acct = this.dispatchAccount();
    let resume: string | undefined = initialResume;
    let message: string | unknown[] = kickoff;
    let provider: ImplementorProvider = "claude";
    let accountFailovers = 0;
    let transientFailures = 0;
    const unavailableProviders = new Set<ImplementorProvider>();

    // Start on a preferred CLI when asked (warm QA resume) and it's still ready. Session ids are
    // provider-specific — never resume a Grok/Codex id on Claude or vice versa.
    const pref = opts?.preferredProvider;
    if (pref && pref !== "claude" && role !== "reader") {
      const ready = pref === "codex" ? this.codexImplementorReady() : this.grokImplementorReady();
      if (ready) {
        provider = pref;
      } else {
        resume = undefined; // can't resume a CLI session on another backend
      }
    } else if (role !== "reader" && !this.accounts.hasHeadroom()) {
      // Claude is already exhausted — skip the doomed first attempt and go straight to a ready CLI.
      // (Reader can't fail over: it needs harness-enforced read-only tools + post_finding.)
      const cli = this.nextReadyImplementor("claude", unavailableProviders);
      if (cli) {
        this.postFinding({
          threadId: thread.id,
          fromRole: role,
          summary: `All Claude subscriptions are usage-capped — running ${role} on ${providerLabel(cli)}`,
          detail: `Every enabled Claude account is at its usage limit, so the ${role} stage is starting on ${providerLabel(cli)} rather than burning a rejected Claude turn first.`,
          severity: "warning",
        });
        provider = cli;
        resume = undefined;
      }
    }

    while (!this.cancelled(thread.id)) {
      const model = provider === "codex" ? this.codexModel() : provider === "grok" ? this.grokModel() : this.modelFor(acct.id, role);
      const accountLabel = provider === "codex" ? `codex:${model}` : provider === "grok" ? `grok:${model}` : acct.label;
      const effort = provider === "codex" ? this.codexEffort(model) : provider === "grok" ? this.grokEffort() : undefined;
      const run = this.db.createRun({ threadId: thread.id, role, model, account: accountLabel, effort });
      this.emitRun(run.id);
      const cfg = makeCfg({ token: provider === "claude" ? acct.token : undefined, resume: provider === "claude" ? resume : undefined, runId: run.id });
      cfg.model = model;
      let agent: AgentRunLike;
      let startMessage: string | unknown[] = message;
      let accountId = acct.id;
      if (provider === "codex") {
        accountId = "openai-codex";
        if (!resume) startMessage = cliRoleKickoff(cfg, message, role, "Codex");
        agent = new CodexAgentRun({
          model,
          effort: this.codexEffort(model),
          cwd: thread.workspace,
          apiKey: this.openaiApiKey() ?? "",
          resume,
          outputSchema: cfg.outputFormat?.schema,
          onOfficeChat: (scope, body) => {
            this.chatPost({ threadId: thread.id, runId: run.id, role, scope, body });
          },
        });
      } else if (provider === "grok") {
        accountId = "xai-grok";
        if (!resume) startMessage = cliRoleKickoff(cfg, message, role, "Grok");
        agent = new GrokAgentRun({
          model,
          effort: this.grokEffort(),
          cwd: thread.workspace,
          resume,
          outputSchema: cfg.outputFormat?.schema,
          onOfficeChat: (scope, body) => {
            this.chatPost({ threadId: thread.id, runId: run.id, role, scope, body });
          },
        });
      } else {
        agent = new AgentRun(cfg);
      }
      this.wireRun(agent, thread.id, run.id, role, accountId);
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
      agent.start(startMessage);
      let res = await agent.result();
      if (role === "planner" && res && !res.isError) res = await this.drainDirectorNotes(thread, agent, res);
      if (role === "planner") this.liveRole.delete(thread.id);
      if (role === "qa") this.liveQa.delete(thread.id);
      await agent.stop();
      this.untrack(thread.id, agent);
      this.finishRun(run.id, res, agent);
      if ((res && !res.isError) || this.cancelled(thread.id)) return res;

      if (agent.transientApiError) {
        transientFailures++;
        if (transientFailures < MAX_TRANSIENT_API_FAILURES) {
          await this.waitForTransientRetry(thread, role, transientFailures, provider);
          resume = agent.sessionId;
          message = resume
            ? `The ${providerLabel(provider)} API returned a temporary server error. Retry the interrupted work now and continue exactly where you left off.`
            : kickoff;
          continue;
        }
        unavailableProviders.add(provider);
        // The read-only reader depends on harness-enforced MCP/tool restrictions and post_finding, which
        // the CLI adapters cannot provide. Other structured roles can safely use their schema adapters.
        const next: ImplementorProvider | undefined = role === "reader" ? undefined : this.nextReadyImplementor(provider, unavailableProviders);
        if (!next) return res;
        const fromName = providerLabel(provider);
        const toName = providerLabel(next);
        this.postFinding({
          threadId: thread.id,
          fromRole: role,
          summary: `${fromName} API failed ${MAX_TRANSIENT_API_FAILURES} times — switched ${role} to ${toName}`,
          detail: `${agent.transientApiErrorMessage ?? "The provider returned repeated temporary server errors."} The ${role} stage is continuing on ${toName}.`,
          severity: "warning",
        });
        this.notifyExternal(`↪ ${role} hit repeated ${fromName} API errors — continuing "${thread.title}" on ${toName}.`);
        provider = next;
        transientFailures = 0;
        accountFailovers = 0;
        resume = undefined;
        message = prependUserContent(kickoff, `[Provider outage handoff]\n${fromName} failed ${MAX_TRANSIENT_API_FAILURES} consecutive times. Continue this ${role} stage on ${toName} and complete it fully.`);
        continue;
      }

      if (provider !== "claude") {
        const capped = (agent instanceof CodexAgentRun || agent instanceof GrokAgentRun) && agent.capped;
        if (!capped) return res;
        if (provider === "codex") this.noteCodexCap();
        else this.noteGrokCap();
        unavailableProviders.add(provider);
        const next = this.nextReadyImplementor(provider, unavailableProviders);
        if (!next) return res;
        provider = next;
        transientFailures = 0;
        accountFailovers = 0;
        resume = undefined;
        message = prependUserContent(kickoff, `[Provider usage-limit handoff]\nContinue this ${role} stage on ${providerLabel(next)} and complete it fully.`);
        continue;
      }

      if (!agent.rateLimited) return res;
      // A rejection on a model with its OWN metered pool (Fable) while this account's normal windows
      // still have headroom isn't an account cap — another sub's Fable pool is just as gated, and
      // parking would idle a sub with headroom. Relaunch on the SAME account: modelFor resolves the
      // fallback (Opus) for it now that classifyCap latched the pool limit.
      if (await this.modelCapFallback(thread, role, model, acct, agent)) {
        resume = agent.sessionId ?? resume;
        message = MODEL_FALLBACK_CONTINUE_MSG;
        continue; // bounded: the latched pool makes modelFor resolve the fallback next pass, which has no fallback of its own
      }
      const next = this.failoverAccount(acct.id);
      // Claude exhausted for this run — no other account has headroom, or the per-run failover budget is
      // spent. Before parking, keep planner/researcher/QA alive by continuing on a ready CLI backend
      // (Codex/Grok) — this is the "don't lose researcher/QA when the Claude subs are maxed" path. The
      // reader can't fail over (it relies on harness-enforced read-only tools + post_finding the CLI
      // adapters lack). A planner/researcher cap otherwise degrades to no-plan/no-research; QA otherwise
      // parks the task to 'review' (capParked flags it for the supervisor).
      if (!next || accountFailovers >= MAX_ACCOUNT_FAILOVERS) {
        const cli = role === "reader" ? undefined : this.nextReadyImplementor("claude", unavailableProviders);
        if (cli) {
          this.postFinding({
            threadId: thread.id,
            fromRole: role,
            summary: `All Claude subscriptions are usage-capped — switched ${role} to ${providerLabel(cli)}`,
            detail: `Every enabled Claude account hit its usage limit, so the ${role} stage is continuing on ${providerLabel(cli)} rather than parking the task.`,
            severity: "warning",
          });
          this.notifyExternal(`↪ ${role} — all Claude subs maxed; continuing "${thread.title}" on ${providerLabel(cli)}.`);
          provider = cli;
          transientFailures = 0;
          accountFailovers = 0;
          resume = undefined;
          message = prependUserContent(kickoff, `[Claude usage-limit handoff]\nEvery Claude subscription is capped. Continue this ${role} stage on ${providerLabel(cli)} and complete it fully.`);
          continue;
        }
        if (role === "qa") this.capParked.set(thread.id, "qa");
        return res;
      }
      this.logFailover(thread, role, next.label, agent.rateLimitInfo);
      acct = next;
      accountFailovers++;
      resume = agent.sessionId;
      message = "Your session was switched to another account after a usage limit. Continue exactly where you left off and finish.";
    }
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
    const res = await this.runRole(thread, "planner", this.kickoffContent(thread.id, thread.brief), ({ token, resume, runId }) => {
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
    const res = await this.runRole(thread, "researcher", this.kickoffContent(thread.id, researcherKickoff(thread, plan)), ({ token, resume, runId }) => {
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

  /** The read lane: run ONE read-only reader that answers the question (posting its answer as a finding)
   *  and finalizes the task — no QA. It mirrors runPlanner's shape (runRole + per-(thread,role) MCP
   *  servers) but adds the git_read server for read-only history. Disposition comes from the reader's
   *  structured output: an answer → 'done' (with the deliverables backstop, though a reader rarely writes
   *  files); an escalation → parked in 'review' with a warning finding so the director can re-dispatch the
   *  full pipeline. It never half-answers. readerDone is persisted so a resume can't re-run/double-post. */
  private async runReader(thread: Thread, directorNote?: string): Promise<void> {
    const res = await this.runRole(
      thread,
      "reader",
      this.kickoffContent(thread.id, readerKickoff(thread, directorNote)),
      ({ token, resume, runId }) => {
        const bus = createBusServer(this, { threadId: thread.id, role: "reader", getRunId: () => runId });
        const office = createOfficeServer(this, { threadId: thread.id, role: "reader", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
        const git = createGitReadServer(thread.workspace);
        const cfg = readerConfig(thread.workspace, { bus, office, git });
        cfg.oauthToken = token;
        if (resume) cfg.resume = resume;
        return cfg;
      },
    );
    if (this.cancelled(thread.id)) return;
    await this.finalizeReader(thread, res);
  }

  /** Disposition of a completed read-lane run — factored out of runReader so the three terminal paths are
   *  exercisable without spawning the reader agent (see reader.itest.ts §C):
   *    - errored/no-result → parked in 'review' (stays visible; never auto-closed);
   *    - escalated         → parked in 'review' with a warning finding for re-dispatch (never auto-closed);
   *    - answered read-only → 'done' AND then auto-closed (the answer already landed as a finding, so
   *      leaving the card open on the board is pure bookkeeping noise the owner would close by hand).
   *  readerDone is persisted FIRST so a restart between here and the state change can't re-enter runReader
   *  and post a second answer. */
  async finalizeReader(thread: Thread, res: ResultEvent | undefined): Promise<void> {
    // Sticky across resume — set BEFORE any settle so a restart between here and the state change can't
    // re-enter runReader and post a second answer.
    this.db.updateThreadStageOutputs(thread.id, { readerDone: true });

    const out = res?.structuredOutput as ReaderOutput | undefined;
    if (!res || res.isError) {
      this.settleReview(thread.id, "Reader could not complete — needs your review (or a full re-dispatch).");
      return;
    }
    if (out?.escalated) {
      // The reader posted its own 'needs full pipeline because …' warning finding; record the disposition
      // and park in 'review' (NOT done) so the director re-dispatches through the normal pipeline.
      this.postFinding({
        threadId: thread.id,
        fromRole: "reader",
        summary: `Reader escalated — needs the full pipeline${out.reason ? `: ${out.reason}` : ""}`,
        severity: "warning",
      });
      this.settleReview(thread.id, `Reader escalated to the full pipeline${out.reason ? `: ${out.reason}` : ""} — re-dispatch with the normal \`dispatch\`.`);
      return;
    }
    // Answered read-only. The answer already landed as a finding, so record the disposition, settle 'done'
    // (which fires the owner completion notification), THEN auto-close so the card moves straight to the
    // closed tray — identical to a manual close, with no lingering "needs attention" affordance. Only this
    // clean-answer path auto-closes: an escalation or an error settled to 'review' above and returned, so
    // both stay visible for action. Closing AFTER 'done' (not instead of it) leaves closed_prev_state='done',
    // so the closed card still shows the finished-correctly checkmark and the answer finding stays readable.
    this.postFinding({ threadId: thread.id, fromRole: "reader", summary: "Reader answered the lookup read-only — no QA (read lane).", severity: "info" });
    this.setState(thread.id, "done");
    await this.closeThread(thread.id);
  }

  private async runQA(thread: Thread, opts: { round: number }): Promise<QaOutput | undefined> {
    // Fix-rounds 2..N resume the SAME QA session — a warm cache read of the diff/files/tests it
    // already ingested — instead of a fresh session that re-reads everything from scratch. QA still
    // re-runs `git diff` and the checks itself (independent verification preserved); it just doesn't
    // re-pay to reconstruct context it holds. Round 1, or a cold/missing prior session, is fresh.
    // Session ids are provider-specific: a Grok QA id must resume on Grok (never Claude), and the
    // reverse. Claude sessions use transcript-mtime warm/cold; CLI sessions resume when that backend
    // is still ready (no local Claude transcript to age-check).
    const prior = opts.round > 1 ? this.latestQaRun(thread.id) : undefined;
    let resume: string | undefined;
    let preferredProvider: ImplementorProvider | undefined;
    if (prior) {
      if (prior.provider === "claude") {
        const ageMs = sessionAgeMs(prior.sessionId);
        if (config.resumeFullSession || (ageMs != null && ageMs < config.resumeWarmMinutes * 60_000)) {
          resume = prior.sessionId;
          preferredProvider = "claude";
        }
      } else {
        const ready = prior.provider === "codex" ? this.codexImplementorReady() : this.grokImplementorReady();
        if (ready) {
          resume = prior.sessionId;
          preferredProvider = prior.provider;
        }
      }
    }
    // A fresh QA session gets a scope hint (plan summary + touched files) so it starts from the real
    // change surface instead of spending Opus turns rediscovering it; resumed QA already knows it.
    const plan = resume ? undefined : (this.db.getThreadStageOutputs(thread.id).plan ?? undefined);
    // Deterministic deliverables backstop: hand QA the artifact files the implementor produced but
    // never surfaced (computed from the run's own tool calls + findings), so its mandatory
    // deliverables check starts from a concrete list instead of the model's memory. Recomputed each
    // round — a fix-round that emits a forgotten deliverable drops it from the next round's hint.
    const unsurfaced = detectUnsurfacedArtifacts(this.db, thread);
    const kickoff = resume ? qaRecheckKickoff(unsurfaced) : qaKickoff(thread, plan, unsurfaced);
    const res = await this.runRole(
      thread,
      "qa",
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
      preferredProvider && preferredProvider !== "claude" ? { preferredProvider } : undefined,
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
    // Claude uses the planner's per-task effort (with the xhigh gate applied). Codex has its own
    // operator-selected reasoning effort because the CLI takes a persistent model_reasoning_effort.
    const plannerEffort = resolveEffort(opts?.effort);
    // Provider factory: the routing gate (gateImplementorProvider) stored the backend for this thread.
    // Codex runs the CLI (no Claude account/oauth); Claude runs the SDK on a selected subscription.
    const provider = this.implementorProvider.get(thread.id) ?? "claude";
    let agent: AgentRunLike;
    let runId: string;
    let accountId: string;
    // The standing implementor doctrine (commit/push/no-push-rule, no half-measures) reaches the Claude backend
    // via its SDK system prompt; the Codex CLI gets no system prompt from us, so prepend it to a FRESH
    // Codex kickoff (resume turns retain it through the resumed Codex thread). Without this a Codex run
    // patches the working tree and stops, never committing — breaking the implementor→commit contract.
    let startKickoff = kickoff;
    if (provider === "codex") {
      const model = this.codexModel();
      // The director/planner picks the per-task effort; the Codex subscription's setting is its MAX cap, so
      // a tiny task still runs cheap while nothing exceeds what the operator allowed for this backend.
      const effort = clampEffort(plannerEffort, this.codexEffort(model)) as CodexEffort;
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
      const codexAgent = new CodexAgentRun({
        model,
        effort,
        cwd: thread.workspace,
        apiKey: this.openaiApiKey() ?? "",
        resume: opts?.resume,
        freshFallback: opts?.freshFallback,
        onOfficeChat: (scope, body) => {
          this.chatPost({ threadId: thread.id, runId, role: "implementor", scope, body });
        },
      });
      // If this run had to self-heal a wedged resume, remember it so every later turn skips the resume
      // attempt (and its 60s watchdog) and goes straight to fresh — resume keeps wedging on this thread.
      codexAgent.onEnd(() => { if (codexAgent.resumeHealed) this.codexResumeWedged.add(thread.id); });
      agent = codexAgent;
    } else if (provider === "grok") {
      const model = this.grokModel();
      // Same as Codex: the per-task effort is capped at the Grok subscription's configured maximum.
      const effort = clampEffort(plannerEffort, this.grokEffort()) as GrokEffort;
      accountId = "xai-grok";
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: `grok:${model}`, effort });
      runId = run.id;
      this.emitRun(run.id);
      // Like Codex, the Grok CLI is a separate process with no in-process bus MCP tools (no
      // post_finding/ask_user) and no per-tool feed events — a documented degradation. The doctrine makes
      // it commit; the QA loop still reviews the real diff. A fresh start gets the doctrine + peer heads-up.
      if (!opts?.resume) startKickoff = [GROK_IMPLEMENTOR_DOCTRINE, kickoff, this.peerNote(thread, false)].filter(Boolean).join("\n\n");
      const grokAgent = new GrokAgentRun({
        model,
        effort,
        cwd: thread.workspace,
        resume: opts?.resume,
        freshFallback: opts?.freshFallback,
        onOfficeChat: (scope, body) => {
          this.chatPost({ threadId: thread.id, runId, role: "implementor", scope, body });
        },
      });
      // Reuse the CLI-resume-wedged set (shared by both CLI backends): once a resume self-heals to fresh,
      // every later turn on this thread starts fresh directly instead of re-attempting a wedging resume.
      grokAgent.onEnd(() => { if (grokAgent.resumeHealed) this.codexResumeWedged.add(thread.id); });
      agent = grokAgent;
    } else {
      const acct = opts?.account ?? this.dispatchAccount();
      accountId = acct.id;
      // The per-task effort is capped at this Claude account's configured maximum (default: uncapped).
      const effort = clampEffort(plannerEffort, this.accountMaxEffort(acct.id));
      // Model resolved from the subscription this implementor runs on (per-sub override → default → built-in).
      const model = this.modelFor(acct.id, "implementor");
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: acct.label, effort });
      runId = run.id;
      this.emitRun(run.id);
      const bus = createBusServer(this, { threadId: thread.id, role: "implementor", getRunId: () => run.id });
      const office = createOfficeServer(this, { threadId: thread.id, role: "implementor", workspace: thread.workspace, title: thread.title, getRunId: () => run.id });
      const cfg = implementorConfig(thread.workspace, { bus, office }, { resume: opts?.resume, effort });
      cfg.model = model;
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
    // A CLI backend (Codex or Grok) resumes by its own session id via the CLI — there is no local Claude
    // transcript to age-check or Haiku-compress, so the warm/cold gate below (keyed on transcript mtime)
    // would always fall to the cold path and start a FRESH run, throwing away the prior session. Resume
    // the CLI session directly with the nudge/note as the new turn's prompt.
    if (resolvedProvider === "codex" || resolvedProvider === "grok") {
      const doctrine = resolvedProvider === "grok" ? GROK_IMPLEMENTOR_DOCTRINE : CODEX_IMPLEMENTOR_DOCTRINE;
      const label = providerLabel(resolvedProvider);
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
      const freshKickoff = [doctrine, baseKickoff, this.peerNote(thread, false), continuation].filter(Boolean).join("\n\n");
      // CLI resume already wedged for this thread → don't pay the 60s watchdog + self-heal spam again;
      // start fresh directly. (startImplementor with no `resume` re-prepends doctrine + peerNote, so pass
      // just task + continuation here to avoid duplicating them.)
      if (this.codexResumeWedged.has(thread.id)) {
        this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: ${label} resume previously wedged — starting a fresh session directly.`);
        const freshText = [baseKickoff, continuation].filter(Boolean).join("\n\n");
        return this.startImplementor(thread, freshText, { effort: opts.effort, account: opts.account });
      }
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: resuming the ${label} session ${resumeSession.slice(0, 8)} via the CLI.`);
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
    kickoff: string,
    current: AgentRunLike,
    currentAccountId: string,
    useNext: boolean,
    continueMsg: string,
  ): Promise<ResultEvent | undefined> {
    let accountFailovers = 0;
    let transientFailures = 0;
    while (accountFailovers <= MAX_ACCOUNT_FAILOVERS) {
      const res = useNext ? await current.nextResult() : await current.result();
      if ((res && !res.isError) || this.cancelled(thread.id)) return res;

      // 500/529/overload/transport failures are provider incidents, not quota. Retry the SAME provider
      // twice (three consecutive failures total) and preserve its session whenever one was established.
      // The enclosing completion layer switches backend after the third failure.
      if (current.transientApiError) {
        transientFailures++;
        if (transientFailures >= MAX_TRANSIENT_API_FAILURES) return res;
        const provider = this.providerForRun(current);
        await this.waitForTransientRetry(thread, "implementor", transientFailures, provider);
        await current.stop();
        if (this.cancelled(thread.id)) return res;
        const session = current.sessionId ?? this.lastImplementorSession.get(thread.id);
        const acct = provider === "claude" ? this.acctById(currentAccountId) ?? undefined : undefined;
        const retryMessage = `The ${providerLabel(provider)} API returned a temporary server error. Retry the interrupted work now and continue exactly where you left off.`;
        const relaunch = session
          ? this.startImplementor(thread, retryMessage, { resume: session, effort, account: acct })
          : this.startImplementor(thread, `${kickoff}\n\n${retryMessage}`, { effort, account: acct });
        current = relaunch.run;
        currentAccountId = relaunch.accountId;
        useNext = false;
        continue;
      }

      if (!current.rateLimited) return res;
      // A Fable-pool rejection with normal-window headroom relaunches on the SAME account — modelFor
      // resolves the fallback model now that classifyCap latched the pool limit (see modelCapFallback).
      // acctById is null for the Codex pseudo-account, so a Codex cap can never take this branch. The
      // rejected model comes from the newest run ROW (the model actually dispatched), not a re-resolve
      // that a limit latched by a concurrent thread could have already redirected.
      const sameAcct = this.acctById(currentAccountId);
      const fbSession = this.lastImplementorSession.get(thread.id);
      const runModel = this.db
        .listRuns(thread.id)
        .filter((r) => r.role === "implementor")
        .sort((a, b) => b.startedAt - a.startedAt)[0]?.model;
      if (
        sameAcct &&
        fbSession &&
        runModel &&
        (await this.modelCapFallback(thread, "implementor", runModel, sameAcct, current))
      ) {
        await current.stop();
        const relaunch = this.startImplementor(thread, MODEL_FALLBACK_CONTINUE_MSG, { resume: fbSession, effort, account: sameAcct });
        current = relaunch.run;
        currentAccountId = relaunch.accountId;
        useNext = false;
        continue; // bounded: the relaunch's run row records the fallback model, which has no fallback of its own
      }
      // Rate-limited: fail over to another account, or give up to "review" (return undefined so the
      // caller doesn't run QA on / mark done a half-finished implementation).
      const next = this.failoverAccount(currentAccountId);
      const sessionId = this.lastImplementorSession.get(thread.id);
      // No account with headroom (vs. a missing session) means a cap parked this — flag it so the
      // settle tags it for the supervisor, which resumes the task once an account frees up.
      if (!next && current.rateLimited) this.capParked.set(thread.id, "implementor");
      if (!next || !sessionId) return undefined;
      this.logFailover(thread, "implementor", next.label, current.rateLimitInfo);
      await current.stop();
      const relaunch = this.startImplementor(thread, continueMsg, { resume: sessionId, effort, account: next });
      current = relaunch.run;
      currentAccountId = relaunch.accountId;
      useNext = false;
      accountFailovers++;
    }
    // Reaching here means the loop exhausted MAX_ACCOUNT_FAILOVERS via repeated cap-failovers (the only
    // path that falls through — every other outcome returns inside the loop). Each fresh account also
    // capped, so this is still a cap-park: flag it so the settle tags it for the supervisor rather than
    // mis-parking it as a needs-human review that never auto-resumes.
    if (current.rateLimited) this.capParked.set(thread.id, "implementor");
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
    qaFollows = true, // false on a manual resume (no QA loop follows), so nudges/seeds don't promise QA
    unavailableProviders: Set<ImplementorProvider> = new Set(),
  ): Promise<ResultEvent | undefined> {
    let res = await this.awaitImplementorResult(thread, effort, kickoff, run, accountId, useNext, continueMsg);
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
          "where you left off and complete the task. " +
          (qaFollows ? "A QA agent" : config.ownerName) +
          " will review your work when you're genuinely done."
        : STALL_NUDGE;
      // Close the turn-maxed query before resuming so we never run two implementors on one workspace;
      // startImplementor's onEnd guard tolerates the relaunch replacing `this.live` first either way.
      await current.stop();
      if (this.cancelled(thread.id)) break;
      const start = await this.startResumedImplementor(thread, kickoff, session, {
        effort,
        resumeNudge: nudge,
        qaFollows,
      });
      if (!start) break; // cancelled while compressing the prior session
      this.flushDirectorNotes(thread.id, start.run);
      current = start.run;
      res = await this.awaitImplementorResult(thread, effort, kickoff, start.run, start.accountId, false, nudge);
    }
    // Three consecutive transient API failures exhausted the same-provider retries. Hand the task to
    // another enabled backend from the durable working-tree state. Track failed providers through the
    // recursive handoff so a multi-provider outage is bounded instead of ping-ponging forever.
    const failedRun = this.live.get(thread.id)?.run ?? current;
    if (res?.isError && failedRun.transientApiError && !this.cancelled(thread.id)) {
      const from = this.providerForRun(failedRun);
      unavailableProviders.add(from);
      const next = this.nextReadyImplementor(from, unavailableProviders);
      await failedRun.stop();
      if (next) {
        this.implementorProvider.set(thread.id, next);
        const fromName = providerLabel(from);
        const toName = providerLabel(next);
        this.postFinding({
          threadId: thread.id,
          fromRole: "implementor",
          summary: `${fromName} API failed ${MAX_TRANSIENT_API_FAILURES} times — switched this task to ${toName}`,
          detail: `${failedRun.transientApiErrorMessage ?? "The provider returned repeated temporary server errors."} The task is continuing on ${toName} from the current working-tree state.`,
          severity: "warning",
        });
        this.notifyExternal(`↪ ${fromName} API errors persisted — continuing "${thread.title}" on ${toName}.`);
        const seed = await this.composeResumeKickoff(thread, kickoff, undefined, {
          directorNote: `${fromName} returned ${MAX_TRANSIENT_API_FAILURES} consecutive temporary API errors, so you're taking over on ${toName}. Review the existing working-tree progress and finish the task completely.`,
          qaFollows,
        });
        if (!this.cancelled(thread.id)) {
          const relaunch = this.startImplementor(thread, seed, { effort });
          return this.awaitImplementorCompletion(
            thread,
            effort,
            kickoff,
            relaunch.run,
            relaunch.accountId,
            false,
            continueMsg,
            qaFollows,
            unavailableProviders,
          );
        }
      }
      return res;
    }
    // A CLI implementor backend (Codex or Grok) hit its usage cap mid-run → fail OVER to another ready
    // backend rather than parking (a CLI has no account-headroom of its own to fail over to). Its session
    // id is incompatible with any other backend's resume, so relaunch FRESH from a git-progress seed: the
    // working-tree edits persist, so the next backend picks up on top of them. Guarded by the provider
    // flip → switches at most once per cap; the recursive await then handles the new backend's own
    // turn-limit/stall/account-failover from there.
    if (
      res?.isError &&
      !this.cancelled(thread.id) &&
      (current instanceof CodexAgentRun || current instanceof GrokAgentRun) &&
      current.capped
    ) {
      const from = this.implementorProvider.get(thread.id) ?? "claude";
      if (from === "codex") this.noteCodexCap();
      else if (from === "grok") this.noteGrokCap();
      const next = this.nextReadyImplementor(from) ?? "claude";
      this.implementorProvider.set(thread.id, next);
      // Fully end the capped CLI run BEFORE anything else — postFinding routes a warning to this.live's
      // run, so stopping first guarantees it can never resume a fresh doomed turn on the just-capped session
      // (matches the "end the implementor before the next stage" ordering used across this file).
      await current.stop();
      const fromName = providerLabel(from);
      const toName = providerLabel(next);
      this.postFinding({
        threadId: thread.id,
        fromRole: "implementor",
        summary: `${fromName} hit its usage cap — switched this task to the ${toName} implementor`,
        detail: `${fromName}'s usage is exhausted; the task continues on ${toName} from the current working-tree state.`,
        severity: "warning",
      });
      if (!this.cancelled(thread.id)) {
        const seed = await this.composeResumeKickoff(thread, kickoff, undefined, {
          directorNote: `The ${fromName} implementor hit its usage cap partway through this task, so you're taking over on the ${toName} backend. Its changes are already in the working tree — review the git progress below, then continue and finish the task completely.`,
          qaFollows,
        });
        if (!this.cancelled(thread.id)) {
          const relaunch = this.startImplementor(thread, seed, { effort });
          res = await this.awaitImplementorCompletion(thread, effort, kickoff, relaunch.run, relaunch.accountId, false, continueMsg, qaFollows, unavailableProviders);
        }
      }
    }
    // The REVERSE flip: every Claude account capped mid-run (awaitImplementorResult found no failover
    // headroom and flagged the cap-park) while a CLI backend (Codex/Grok) is enabled, authed and ready →
    // continue on it instead of freezing the task under "every account is rate-limited" with a ready CLI
    // sitting idle. A Claude SDK session can't resume on a CLI, so relaunch FRESH from a compressed-handoff
    // + git-progress seed. Each direction only flips TO a ready backend, so the blocks can't ping-pong; if
    // the CLI then caps too, the block above hands back or parks.
    if (
      res === undefined &&
      !this.cancelled(thread.id) &&
      this.capParked.get(thread.id) === "implementor" &&
      this.implementorProvider.get(thread.id) === "claude"
    ) {
      const next = this.nextReadyImplementor("claude"); // codex or grok, whichever is readiest (claude excluded)
      if (next) {
        this.capParked.delete(thread.id);
        this.implementorProvider.set(thread.id, next);
        // Fully end the capped Claude run before relaunching, so two implementors never share the
        // workspace (same ordering as the CLI→other flip above).
        await current.stop();
        const toName = providerLabel(next);
        this.postFinding({
          threadId: thread.id,
          fromRole: "implementor",
          summary: `Every Claude subscription hit its usage cap — switched this task to the ${toName} implementor`,
          detail: `All Claude accounts are rate-limited; the task continues on the ${toName} backend from the current working-tree state.`,
          severity: "warning",
        });
        this.notifyExternal(`↪ every Claude sub is capped — continuing "${thread.title}" on ${toName}.`);
        const seed = await this.composeResumeKickoff(thread, kickoff, this.lastImplementorSession.get(thread.id), {
          directorNote: `Every Claude subscription hit its usage cap partway through this task, so you're taking over on the ${toName} backend. The prior implementor's changes are already in the working tree — review the git progress below, then continue and finish the task completely.`,
          qaFollows,
        });
        if (!this.cancelled(thread.id)) {
          const relaunch = this.startImplementor(thread, seed, { effort });
          res = await this.awaitImplementorCompletion(thread, effort, kickoff, relaunch.run, relaunch.accountId, false, continueMsg, qaFollows, unavailableProviders);
        }
      }
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
      // The loop drained the queue at each hand-off; drop any leftover (e.g. queued after the final
      // drain, as the task settled) so it can't leak into an unrelated later run of this thread.
      this.queuedForImplementor.delete(thread.id);
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
    // Durable QA-round budget. `round` used to be a fresh local counter, so EVERY re-entry (a server
    // restart's auto-resume, or a cap-resume) started the loop at round 1 and ran a full fresh QA pass —
    // with a frequently-bouncing server that's an unbounded implementor↔QA loop that drained a whole Grok
    // subscription. Resume from the persisted count instead: a mid-episode resume continues the SAME
    // budget (and, being round > 1, warm-resumes the prior QA session rather than re-reading everything).
    // Fresh dispatch = 0; a retry nulls stage_outputs, so it resets too.
    const priorRounds = pipe.qaEnabled ? this.db.getThreadStageOutputs(thread.id).qaRoundsUsed ?? 0 : 0;
    if (pipe.qaEnabled && priorRounds >= pipe.maxQaRounds) {
      // A prior episode already spent the full QA budget and an interrupt re-entered before it could park.
      // Don't re-run the implementor + a fresh QA pass on the (already usage-heavy) backend — park it.
      this.postFinding({
        threadId: thread.id,
        fromRole: "qa",
        summary: `QA still not satisfied after ${pipe.maxQaRounds} rounds — needs your review`,
        severity: "warning",
      });
      this.settleReview(thread.id, `QA still not satisfied after ${pipe.maxQaRounds} rounds — needs your review.`);
      return;
    }
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
      pipe.qaEnabled,
    );
    // Before the hand-off: if the director queued follow-ups while the implementor worked, it does that
    // work too now (re-launched with them) instead of proceeding — the Queue button's whole point.
    res = await this.drainQueuedImplementor(thread, effort, kickoff, res, pipe.qaEnabled);

    // QA disabled — the implementor's output is final. A clean finish goes straight to 'done'
    // (the only non-QA path to 'done' besides a manual markDone); an incomplete one parks for review.
    if (!pipe.qaEnabled) {
      if (this.cancelled(thread.id)) return;
      if (res && !res.isError) {
        this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "Implementor finished — QA review is disabled, accepted as done.", severity: "info" });
        await this.runSelfImprovement(thread, effort, kickoff);
        if (this.cancelled(thread.id)) return;
        this.setState(thread.id, "done");
      } else {
        this.settleReview(thread.id, "Implementor ended without completing — needs your review (QA is disabled for this task).");
      }
      return;
    }

    for (let round = priorRounds + 1; round <= pipe.maxQaRounds; round++) {
      if (this.cancelled(thread.id)) return;
      if (!res || res.isError) {
        this.settleReview(thread.id, "Implementor ended without completing — needs your review.");
        return;
      }
      this.setState(thread.id, "qa");
      // Spend the round from the DURABLE budget BEFORE running QA, so a QA run killed by a restart still
      // counts — otherwise a bouncing server could relaunch the same round's fresh QA pass indefinitely.
      this.db.updateThreadStageOutputs(thread.id, { qaRoundsUsed: round });
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
        // Prefer the latest QA run's error (e.g. Grok structured-output miss after retries) so the park
        // message is diagnosable rather than a bare "could not complete".
        const lastQa = this.db
          .listRuns(thread.id)
          .filter((r) => r.role === "qa")
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        const detail = lastQa?.error?.trim() || undefined;
        this.postFinding({
          threadId: thread.id,
          fromRole: "qa",
          summary: "QA could not complete — needs your review",
          detail,
          severity: "warning",
        });
        this.settleReview(thread.id, detail ? `QA could not complete — ${detail}` : "QA could not complete — needs your review.");
        return;
      }
      if (qa.pass) {
        // A follow-up queued during QA (routed to queuedForImplementor)? The implementor does it before
        // we call the task done — the Queue button promises delivery at the hand-off, and a QA pass is
        // one. At the round cap we still run the queued work but accept it without another QA pass.
        if (this.queuedForImplementor.get(thread.id)?.length && res && !res.isError && !this.cancelled(thread.id)) {
          res = await this.drainQueuedImplementor(thread, effort, kickoff, res, true);
          if (this.cancelled(thread.id)) return;
          if (round < pipe.maxQaRounds) continue; // re-QA the newly-done work
        }
        this.postFinding({ threadId: thread.id, fromRole: "qa", summary: `QA passed: ${qa.summary}`, severity: "info" });
        await this.runSelfImprovement(thread, effort, kickoff);
        if (this.cancelled(thread.id)) return;
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
      const fixMsg = `${this.officeName(thread.id, "qa")} (your QA reviewer) found issues — fix ALL of these, then they'll re-check:\n${formatQaIssues(qa)}${noteBlock}`;
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
      // Honor anything queued during this fix round too, before we loop back to QA.
      res = await this.drainQueuedImplementor(thread, effort, kickoff, res, true);
    }
  }

  /** After the implementor finishes, deliver any messages the director QUEUED (the composer's Queue
   *  button) so it completes that work too BEFORE handing off to QA — the queued note is held (never
   *  injected mid-run) exactly so it lands at this boundary. Re-launches the warm session with the note,
   *  the same proven path a QA fix-round uses. Loops so a note queued while draining is also honored;
   *  stops on cancel, an errored/parked run (don't pile work onto a task that's already failing), or an
   *  empty queue. A no-op (returns `res` untouched) when nothing was queued — the common case. */
  private async drainQueuedImplementor(
    thread: Thread,
    effort: Effort | undefined,
    kickoff: string,
    res: ResultEvent | undefined,
    qaFollows: boolean,
  ): Promise<ResultEvent | undefined> {
    while (this.queuedForImplementor.get(thread.id)?.length && !this.cancelled(thread.id) && res && !res.isError) {
      const queued = this.queuedForImplementor.get(thread.id)!;
      this.queuedForImplementor.delete(thread.id);
      const msg = `[Queued follow-up from ${config.ownerName} — do this too before you finish and hand off]\n${queued.join("\n\n")}`;
      // End the just-finished run before relaunching so only one implementor ever holds the slot (the
      // same ordering QA fix-rounds use); the session id survives for the warm resume.
      await this.stopLive(thread.id);
      if (this.cancelled(thread.id)) break;
      const start = await this.startResumedImplementor(
        thread,
        kickoff,
        this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
        { effort, resumeNudge: msg, directorNote: msg, qaFollows },
      );
      if (!start) break; // cancelled while compressing the prior session
      this.flushDirectorNotes(thread.id, start.run);
      res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, msg, qaFollows);
    }
    return res;
  }

  /** Opt-in post-completion round (the "Self-improve after tasks" setting): once the task is accepted —
   *  QA passed, or a clean finish with QA disabled — re-launch the finished implementor ONCE with
   *  SELF_IMPROVE_MSG so it builds the tools/skills/memories this session showed were missing, before the
   *  task settles to done. Read live so flipping the toggle applies to tasks already in flight. Strictly
   *  best-effort: the task is already complete, so an errored or capped round is noted and the task goes
   *  'done' anyway — it never parks a finished task back into review. */
  private async runSelfImprovement(thread: Thread, effort: Effort | undefined, kickoff: string): Promise<void> {
    if (!this.settings().selfImproveEnabled || this.cancelled(thread.id)) return;
    const session = this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id);
    if (!session) return; // no implementor session to build on — nothing this round could reflect over
    this.postFinding({
      threadId: thread.id,
      fromRole: "implementor",
      summary: "Self-improvement round: building the tools/skills/memories that would have made this task easier",
      severity: "info",
    });
    const m = this.db.addMessage({
      threadId: thread.id,
      role: "implementor",
      kind: "system",
      content: "🛠 Task accepted — running the opt-in self-improvement round before settling to done.",
    });
    this.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
    // Same slot discipline as a QA fix-round: fully end the finished run, then re-launch through the
    // resume gate (warm resume when the cache is fresh, else a compressed cold seed).
    await this.stopLive(thread.id);
    if (this.cancelled(thread.id)) return;
    const start = await this.startResumedImplementor(thread, kickoff, session, {
      effort,
      resumeNudge: SELF_IMPROVE_MSG,
      directorNote: SELF_IMPROVE_MSG,
      qaFollows: false,
    });
    if (!start) return; // cancelled while compressing the prior session
    this.flushDirectorNotes(thread.id, start.run);
    const res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, SELF_IMPROVE_MSG, false);
    // A cap flagged during this bonus round must not tag the task's settle — the task is going 'done',
    // and a stale flag could otherwise leak into a later settle of this thread.
    this.capParked.delete(thread.id);
    if (!res || res.isError) {
      this.postFinding({
        threadId: thread.id,
        fromRole: "implementor",
        summary: "Self-improvement round didn't finish cleanly — the task itself is already complete and unaffected",
        severity: "note",
      });
    }
  }

  // ---- live thread controls ----

  async injectThread(
    threadId: string,
    message: string,
    mode: "append" | "interrupt" | "queue",
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
    // Queue mode: DON'T touch the implementor's current turn — hold the message until it reaches its
    // hand-off boundary, where drainQueuedImplementor gives it to the implementor before QA. A live
    // implementor OR the QA stage (implementor stopped for review, about to re-run on a bounce or settle
    // on a pass) both drain from queuedForImplementor — so routing QA-stage queues there, not to the
    // director-note buffer, is what lets a QA-pass pick them up before 'done' instead of dropping them.
    // A pre-implementor phase has no run yet, so buffer it as a note that folds into the kickoff. Either
    // way it's delivered when the implementor next works — never injected mid-turn, never lost.
    if (mode === "queue") {
      if (!thread) return { ok: false, error: "No such task." };
      if (this.live.has(threadId) || thread.state === "qa") {
        this.queuedForImplementor.set(threadId, [...(this.queuedForImplementor.get(threadId) ?? []), message]);
      } else {
        this.bufferDirectorNote(threadId, message);
      }
      if (images?.length) this.threadImages.set(threadId, [...(this.threadImages.get(threadId) ?? []), ...images.map(toImageBlock)]);
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `⧗ queued for the implementor: ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
        attachments: injectRefs(),
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      this.hub.log("info", `Queued a follow-up for ${threadId.slice(0, 8)} (delivered at the implementor's hand-off).`);
      return { ok: true, state: thread.state };
    }
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
    await this.applyRetitle(threadId, await titleFromInjection(message, this.accounts.auxToken()).catch(() => null), "injection");
  }

  /** Give a skip-director task a real board title (short → verbatim, longer → a ≤8-word Haiku summary)
   *  in place of the truncated first line it was dispatched with. Best-effort and fired after dispatch,
   *  so it never blocks the pipeline; gated by the skipDirectorRetitle setting at the call site. */
  async retitleFromBrief(threadId: string, brief: string): Promise<void> {
    await this.applyRetitle(threadId, await titleFromBrief(brief, this.accounts.auxToken()).catch(() => null), "brief");
  }

  /** Operator rename from the console: set a task's board title verbatim and broadcast it. Trims +
   *  length-caps (mirroring the protocol bound), no-ops on an empty result or an unchanged title, and
   *  updates every open board live via thread.upsert. */
  renameThread(threadId: string, title: string): Thread | null {
    // Collapse interior whitespace/newlines so a pasted multi-line string can't produce a broken lane
    // label — the title is operator-supplied over the LAN socket, so sanitize at this trust boundary.
    const trimmed = title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!trimmed) return null;
    const current = this.db.getThread(threadId);
    if (!current || current.title === trimmed) return current;
    const t = this.db.updateThread(threadId, { title: trimmed });
    if (!t) return null;
    this.hub.publish({ type: "thread.upsert", thread: t });
    this.hub.log("info", `Renamed ${threadId.slice(0, 8)} → "${trimmed}"`);
    return t;
  }

  /** Apply a best-effort auto-generated title (or null to leave it as-is) and broadcast the rename. */
  private applyRetitle(threadId: string, title: string | null, reason: string): void {
    try {
      if (!title) return;
      const current = this.db.getThread(threadId);
      if (!current || current.title === title) return; // gone, or no change — skip the churn
      const t = this.db.updateThread(threadId, { title });
      if (!t) return;
      this.hub.publish({ type: "thread.upsert", thread: t });
      this.hub.log("info", `Retitled ${threadId.slice(0, 8)} from ${reason} → "${title}"`);
    } catch (e) {
      this.hub.log("warn", `Auto-retitle (${reason}) failed for ${threadId.slice(0, 8)}: ${String(e)}`);
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
   *  once. Awaited via awaitImplementorCompletion — the same account-failover PLUS turn-limit/stall
   *  auto-continue the pipeline gets: a manually-resumed agent that ends its turn promising to "report
   *  once the deploy finishes" is nudged to block in-turn instead of re-parking on the Resume button.
   *  The caller must have added threadId to `resuming`; this clears it once the implementor is live
   *  (or the start was abandoned). */
  private async resumeImplementorOnly(thread: Thread, message?: string): Promise<void> {
    // A manual resume occupies a concurrency slot for the run's lifetime (like a pipeline), so it
    // counts toward maxConcurrent and frees a queued task when it settles.
    this.activePipelines.add(thread.id);
    this.capParked.delete(thread.id); // fresh resume — drop any stale cap flag before this run sets its own
    this.autoResumes.set(thread.id, 0); // fresh budget for the stall/turn-limit auto-continues
    const releaseSlot = () => {
      this.activePipelines.delete(thread.id);
      this.implementorProvider.delete(thread.id);
      this.autoResumes.delete(thread.id);
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
      start = await this.startResumedImplementor(thread, baseKickoff, resume, { effort: thread.effortOverride ?? undefined, resumeNudge, directorNote: message, qaFollows: false });
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
    await this.awaitImplementorCompletion(thread, thread.effortOverride ?? undefined, baseKickoff, start.run, start.accountId, false, resumeNudge, false)
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
    this.queuedForImplementor.delete(threadId);
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

  /** Restart a cancelled task from the very beginning: re-run the whole pipeline (planner →
   *  [researcher →] implementor → QA) from the brief the director first dispatched, as if freshly
   *  created. Wipes the prior attempt's runs, findings, feed and every saved stage output — so no
   *  stale plan is reused and, crucially, no dead implementor SDK session gets resumed (runPipeline
   *  would otherwise pick it up via latestImplementorSession) — tells clients to drop that stale
   *  slice, then re-enqueues through the normal concurrency gate. Cancelled-only: a live or parked
   *  task has its own controls (Interrupt/Resume/Cancel). */
  async retryThread(threadId: string): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (thread.state !== "cancelled") {
      return { ok: false, error: `Only a cancelled task can be retried (this one is ${thread.state}).` };
    }
    if (!existsSync(thread.workspace)) {
      this.setState(threadId, "failed", `Can't retry — workspace "${thread.workspace}" no longer exists on disk.`);
      return { ok: false, error: "Workspace does not exist." };
    }

    // A cancelled task should already be fully torn down, but clear any lingering bookkeeping so
    // nothing from the prior attempt bleeds into the fresh run.
    this.stopping.delete(threadId);
    this.dropFromQueue(threadId);
    this.resuming.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
    this.directorNotes.delete(threadId);
    this.queuedForImplementor.delete(threadId);
    this.liveRole.delete(threadId);
    this.liveQa.delete(threadId);
    this.capParked.delete(threadId);
    this.implementorProvider.delete(threadId);
    this.codexResumeWedged.delete(threadId);
    this.dispatchImages.delete(threadId);
    this.threadImages.delete(threadId);
    // The DB wipe makes latestImplementorSession() return undefined, but the in-memory session map
    // still holds the dead attempt's id — clear it too so a fresh run that errors before its first
    // `init` event can't fall back onto the cancelled session.
    this.lastImplementorSession.delete(threadId);
    // Re-arm the office check-in dedupe so the retried run's agents re-announce themselves ("no
    // invisible workers") instead of being silenced by the prior attempt's keys.
    for (const role of ["planner", "researcher", "implementor", "qa"] as Role[]) this.checkedIn.delete(`${threadId}:${role}`);

    // Wipe the prior attempt in the DB, then tell clients to drop the now-deleted runs/findings/feed
    // for this thread BEFORE the fresh pipeline starts streaming new ones (else the stale slice
    // lingers in the UI until the next full snapshot).
    this.db.resetThreadForRetry(threadId);
    this.hub.publish({ type: "thread.reset", threadId });

    // Leave the 'cancelled' state BEFORE dispatch — the pipeline's cancelled() guards (and the "planner
    // disabled → no early setState('planning')" branch) would otherwise abort the retry as a silent no-op,
    // leaving the task stuck in 'cancelled' with an ok:true response and no agent ever running.
    this.setState(threadId, "queued");
    this.hub.log("info", `Retrying task ${threadId.slice(0, 8)} from the top.`);
    this.enqueueOrRun(threadId);
    // enqueueOrRun either started the pipeline synchronously (slot free → now on activePipelines) or
    // parked it in the queue — report which, rather than re-reading the DB (still "cancelled" until the
    // pipeline's first async setState).
    return { ok: true, state: this.activePipelines.has(threadId) ? "planning" : "queued" };
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
    this.queuedForImplementor.delete(threadId);
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

  /** Assigned/picked office names live in one kv JSON map keyed by agentKey(thread, role) — each role
   *  in a task is a distinct agent with its own name. The default for an unlisted key is gnomeName. */
  private officeNameMap(): Record<string, string> {
    try {
      const v = this.db.kvGet("office_names");
      return v ? (JSON.parse(v) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  officeName(threadId: string, role: Role): string {
    // The director is a singleton persona with one operator-chosen name, not a gnome from the pool.
    if (role === "director") return this.directorName();
    return this.officeNameMap()[agentKey(threadId, role)] || gnomeName(threadId, role);
  }

  /** Guarantee no two CURRENTLY-LIVE agents share an office name — the invariant a one-shot, first-
   *  check-in assignment can't hold: two tasks whose default (or persisted) names collide need not have
   *  been live at the same instant when each was first named, so both can end up persisted as e.g.
   *  "Rune" and only clash once both go live again (a resume / a QA fix-round). This runs on every
   *  go-live and re-derives uniqueness across the whole live set: walk the live agents in seniority
   *  order (earliest-started run first) so whoever has been using a name longest keeps it, reassigning
   *  any later collider to the next free gnome name. Directors are skipped (they carry the settings
   *  name). Only changed names are persisted + broadcast, so a stable live set is a no-op. */
  private ensureLiveNamesUnique(): void {
    const live = this.liveAgentThreads()
      .filter((l) => l.role !== "director")
      .map((l) => ({ ...l, key: agentKey(l.threadId, l.role) }))
      .sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
    const map = this.officeNameMap();
    const names = GNOME_NAMES as readonly string[];
    const used = new Set<string>();
    let dirty = false;
    for (const l of live) {
      // Also steer clear of names held by this task's OTHER roles (which may not be live) so a single
      // task's feed never shows two same-named agents across its phases.
      const taskMates = new Set(
        Object.entries(map)
          .filter(([k]) => k.startsWith(`${l.threadId}::`) && k !== l.key)
          .map(([, v]) => v),
      );
      const preferred = map[l.key] || gnomeName(l.threadId, l.role);
      let chosen = preferred;
      if (used.has(preferred) || taskMates.has(preferred)) {
        const start = Math.max(0, names.indexOf(preferred));
        for (let i = 1; i <= names.length; i++) {
          const cand = names[(start + i) % names.length]!;
          if (!used.has(cand) && !taskMates.has(cand)) {
            chosen = cand;
            break;
          }
        }
      }
      used.add(chosen);
      if (map[l.key] !== chosen) {
        map[l.key] = chosen;
        dirty = true;
        this.hub.publish({ type: "chat.name", threadId: l.threadId, role: l.role, name: chosen });
      }
    }
    if (dirty) this.db.kvSet("office_names", JSON.stringify(map));
  }

  setOfficeName(threadId: string, role: Role, name: string): string {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 24) || gnomeName(threadId, role);
    const map = this.officeNameMap();
    map[agentKey(threadId, role)] = clean;
    this.db.kvSet("office_names", JSON.stringify(map));
    // A self-chosen name can collide with a live coworker; the uniqueness pass walks this agent to a
    // free name if a senior live coworker already holds `clean`, and broadcasts whatever it changes.
    // We therefore broadcast + return the RESOLVED name (not the raw pick) so the tool's confirmation
    // to the agent matches what everyone else sees — and only broadcast ourselves when the pass, having
    // found no collision, left the name untouched (else its own chat.name already went out).
    this.ensureLiveNamesUnique();
    const resolved = this.officeName(threadId, role);
    if (resolved === clean) this.hub.publish({ type: "chat.name", threadId, role, name: clean });
    return resolved;
  }

  /** The current name overrides (assigned/picked names, keyed by agentKey) — sent in the hello snapshot
   *  for the office UI, which falls back to the deterministic gnomeName for any agent not listed here. */
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
      senderName: this.officeName(input.threadId, input.role),
    });
    this.hub.publish({ type: "chat.message", message: m });
    // A team post is pushed straight into the session of every other live implementor in the same
    // repo — agents don't poll, so without this a teammate's message just sits unread (the bug this
    // fixes). Delivered at the recipient's next turn boundary (priority "next"), like a heads-up finding.
    if (project) this.deliverChatToPeers(m);
    return m;
  }

  /** True for CLI implementor backends (Codex, Grok) that have no office MCP and reply via the
   *  `OFFICE[team|office]:` text bridge instead of `chat_post`. */
  private isCliOfficeBridge(accountId: string): boolean {
    return accountId === "openai-codex" || accountId === "xai-grok";
  }

  /** Push a team-room message into peer implementors working the same repo, so they actually see it
   *  instead of having to poll chat_read. Targets `this.live` (implementors) only — the same handle
   *  finding routing uses — so a one-shot planner/QA's structured output is never disrupted; those
   *  roles read the room themselves. Returns how many live peers were pinged. */
  private deliverChatToPeers(m: ChatMessage): number {
    if (m.scope !== "project" || !m.workspace) return 0;
    const norm = normalizeWorkspace(m.workspace);
    const who = m.senderName || (m.threadId && m.role !== "system" ? this.officeName(m.threadId, m.role) : "a teammate");
    const text =
      `💬 [Office — ${who} (${m.role}) posted to your team room]: ${m.body}\n` +
      `(A teammate working in this same repo sent this. If it touches your work or asks something, reply with ` +
      `chat_post(scope:"team") — address them as ${who} — and adjust; don't keep editing blind.)`;
    let pinged = 0;
    for (const [tid, live] of this.live) {
      if (tid === m.threadId) continue; // never echo back to the sender
      const t = this.db.getThread(tid);
      if (!t || normalizeWorkspace(t.workspace) !== norm) continue;
      // CLI backends (Codex/Grok) have no chat_post — tell them to reply via the OFFICE text bridge.
      live.run.send(this.isCliOfficeBridge(live.accountId) ? this.cliTeamChatPush(m, who) : text, { priority: "next" });
      pinged++;
    }
    return pinged;
  }

  private cliTeamChatPush(m: ChatMessage, who: string): string {
    return (
      `[Office - ${who} (${m.role}) posted to your team room]: ${m.body}\n` +
      `(A teammate working in this same repo sent this. If it touches your work or asks something, reply with a standalone ` +
      `OFFICE[team]: ... line addressed to ${who}, then adjust; don't keep editing blind.)`
    );
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
    const who = this.directorName();
    const m = this.db.addChatMessage({
      room: general ? GENERAL_ROOM : room,
      scope: general ? "general" : "project",
      workspace,
      threadId: null,
      runId: null,
      role: "director",
      kind: "chat",
      body: text,
      senderName: who,
    });
    this.hub.publish({ type: "chat.message", message: m });
    // Push it into the sessions of the live implementors who should act on it with human-priority
    // steering. Claude can consume priority "now" in its streaming query; the batch-oriented Codex
    // runner interrupts its pre-message turn and immediately resumes with this directive. Without that
    // distinction a long Codex turn keeps visibly working on stale context while the user's post is unread.
    const where = general ? "the office" : "this repo";
    const push =
      `📣 [${who} (director) → ${general ? "office" : "your team"}] ${text}\n` +
      `(A directive from ${config.ownerName} to all agents in ${where}. Coordinate among yourselves who takes it — don't all grab it, and don't all assume someone else will — then reply with chat_post so the others know.)`;
    const norm = general ? null : normalizeWorkspace(workspace ?? room.replace(/^repo:/, ""));
    let pinged = 0;
    for (const [tid, live] of this.live) {
      if (!general) {
        const t = this.db.getThread(tid);
        if (!t || normalizeWorkspace(t.workspace) !== norm) continue;
      }
      live.run.send(this.isCliOfficeBridge(live.accountId) ? this.cliDirectorChatPush(text, general) : push, { priority: "now" });
      pinged++;
    }
    this.hub.log("info", `Director posted to ${general ? "the office" : `team ${workspace}`} — pinged ${pinged} live agent(s).`);
    return m;
  }

  private cliDirectorChatPush(text: string, general: boolean): string {
    const marker = general ? "OFFICE[office]" : "OFFICE[team]";
    const where = general ? "the office" : "your team room";
    return (
      `[${this.directorName()} (director) -> ${general ? "office" : "your team"}] ${text}\n` +
      `(A directive from ${config.ownerName} to all agents in ${where}. Coordinate who takes it, then reply with a standalone ` +
      `${marker}: ... line so the others know.)`
    );
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
      name: this.officeName(l.threadId, l.role),
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
  private liveAgentThreads(): { threadId: string; role: Role; workspace: string; title: string; startedAt: number }[] {
    const out: { threadId: string; role: Role; workspace: string; title: string; startedAt: number }[] = [];
    for (const [tid, set] of this.activeRuns) {
      if (!set.size) continue;
      const t = this.db.getThread(tid);
      if (!t) continue;
      const runs = this.db.listRuns(tid);
      const active = runs
        .filter((r) => r.state === "starting" || r.state === "running" || r.state === "idle")
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const run = active ?? runs.sort((a, b) => b.startedAt - a.startedAt)[0];
      out.push({ threadId: tid, role: run?.role ?? "implementor", workspace: t.workspace, title: t.title, startedAt: run?.startedAt ?? 0 });
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
   *  per (thread, role) so resume/failover relaunches don't repeat it — but the name-uniqueness pass
   *  runs UNCONDITIONALLY (before the dedupe) so a resume/fix-round re-go-live still resolves any name
   *  collision with a coworker that's now live. */
  private officeCheckIn(threadId: string, role: Role): void {
    this.ensureLiveNamesUnique();
    const key = `${threadId}:${role}`;
    if (this.checkedIn.has(key)) return;
    this.checkedIn.add(key);
    const t = this.db.getThread(threadId);
    if (!t) return;
    const name = this.officeName(threadId, role);
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
   *  — names them and tells it to coordinate. `withTools` is false for CLI backends (Codex/Grok — no
   *  office MCP), where the runner exposes a text marker bridge instead. */
  private peerNote(thread: Thread, withTools: boolean): string | undefined {
    const peers = this.repoPeers(thread);
    if (!peers.length) return undefined;
    const list = peers.map((p) => `• ${p.role} on "${p.title}"`).join("\n");
    const how = withTools
      ? "Use the office chat to coordinate: call `office_look`, then `chat_post(scope:\"team\")` to claim the files/areas you'll touch and `chat_read` what they've claimed before editing."
      : "Coordinate through the CLI office bridge: include a standalone `OFFICE[team]: <short message>` line in your assistant response to claim the files/areas you'll touch, answer teammate messages the same way, prefer non-overlapping areas, and re-check `git status`/`git diff` before committing so you only commit your own hunks.";
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
    let leftStarting = false;
    const markRunning = (sessionId?: string) => {
      if (leftStarting && !sessionId) return;
      leftStarting = true;
      this.db.updateRun(runId, {
        state: "running",
        ...(sessionId ? { sessionId } : {}),
      });
      this.emitRun(runId);
    };
    const off = agent.onEvent((e: AgentEvent) => {
      switch (e.type) {
        case "init":
          // sessionId may be absent on the first Grok stream event (CLI only reports it on `end`); a later
          // init with the real id still updates the row. Always promote out of "starting".
          markRunning(e.sessionId);
          break;
        case "text_delta":
          // CLI backends can stream for minutes before emitting `init` — don't leave the chip on "starting".
          markRunning();
          this.hub.publish({ type: "agent.delta", threadId, runId, role, text: e.text });
          break;
        case "thinking_delta":
          markRunning();
          this.hub.publish({ type: "agent.thinking", threadId, runId, role, text: e.text });
          break;
        case "text": {
          const m = this.db.addMessage({ threadId, runId, role, kind: "text", content: e.text });
          this.hub.publish({ type: "agent.text", threadId, runId, role, text: e.text, messageId: m.id });
          break;
        }
        case "thinking": {
          const m = this.db.addMessage({ threadId, runId, role, kind: "thinking", content: e.text });
          this.hub.publish({ type: "agent.reasoning", threadId, runId, role, text: e.text, messageId: m.id });
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

  // ---- read-only Git/Changes drawer (per-task diff) ----

  async getGitStatus(threadId: string): Promise<GitStatus> {
    const t = this.db.getThread(threadId);
    if (!t) return { isRepo: false, repoRoot: null, branch: null, detached: false, branches: [], upstreamRef: null, pushRef: null, behind: 0, unpushed: 0, isVota: false, pushState: "no-remote", hasUncommitted: false, files: [], commits: [], hasDiffAnchor: false, error: "No such task." };
    const taskFiles = collectTaskWrittenFiles(this.db, t);
    return getTaskGitStatus(t.workspace, { threadId, baselineHead: t.baselineHead ?? null, taskFiles });
  }

  async getGitSummary(threadId: string): Promise<GitSummary> {
    const t = this.db.getThread(threadId);
    if (!t) return { isRepo: false, fileCount: 0, added: 0, removed: 0, commitCount: 0, branch: null, unpushed: 0, isVota: false, pushState: "no-remote" };
    const taskFiles = collectTaskWrittenFiles(this.db, t);
    return getTaskGitSummary(t.workspace, { threadId, baselineHead: t.baselineHead ?? null, taskFiles });
  }

  async getFileDiff(threadId: string, path: string): Promise<GitFileDiff> {
    const t = this.db.getThread(threadId);
    if (!t) return { path, binary: false, patch: "", truncated: false };
    return getFileDiff(t.workspace, path, t.baselineHead ?? null);
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
  // Task-specific marching orders only. The standing doctrine (commit/push/no-push-rule, QA fix-rounds, no
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

/** The reader lane's kickoff: the question to answer, plus the two rules that keep the lane honest —
 *  post the answer as a finding, and escalate rather than half-answer. The full read-only doctrine lives
 *  in READER_PROMPT (the system prompt); this is just the task hand-off. */
function readerKickoff(thread: Thread, directorNote?: string): string {
  const parts: string[] = [
    `# Read task: ${thread.title}`,
    "",
    "## Question / brief",
    thread.brief,
    "",
    "You are the READER on the read-only lane — there is no planner, implementor, or QA behind you. Investigate the repo (Read/Grep/Glob for code, git_read for history — you have NO shell and cannot edit) and ANSWER the question above by calling `post_finding` with the answer and concrete file references. That posted finding IS the deliverable of this task.",
    "",
    "Do NOT half-answer. If answering actually requires editing files, running a build/tests, verification you can't do read-only, or a broad multi-file investigation beyond a lookup, STOP: call `post_finding` (severity `warning`) explaining \"needs full pipeline because …\", and return structured output with `escalated: true` and a one-line `reason`. Otherwise, once you've posted the answer, return `answered: true`.",
  ];
  if (directorNote) parts.push("", "## Note from the director", directorNote);
  return parts.join("\n");
}

function qaKickoff(thread: Thread, plan?: PlanOutput, unsurfacedArtifacts: string[] = []): string {
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
    "",
    deliverablesCheckBlock(unsurfacedArtifacts),
  );
  return parts.join("\n");
}

/** The kickoff for a RESUMED QA session (fix-rounds 2..N): the session already holds the brief, the
 *  prior diff, and the test output, so this is just a short re-check nudge — no re-statement. The
 *  deliverables check is repeated (with the freshly-recomputed unsurfaced list) because a fix-round
 *  is exactly where a forgotten deliverable gets emitted — or still doesn't. */
function qaRecheckKickoff(unsurfacedArtifacts: string[] = []): string {
  return [
    "The implementor reports it has addressed the issues you raised. Re-verify:",
    "- Re-run `git diff` to see the NEW state and re-run the project's build/typecheck/tests.",
    "- Confirm each issue you raised is actually resolved, and watch for any regression the fix introduced.",
    "Then return your updated structured verdict (pass + remaining issues). Pass only if you'd ship it.",
    "",
    deliverablesCheckBlock(unsurfacedArtifacts),
  ].join("\n");
}

/** The mandatory deliverables-verification step folded into every QA kickoff. Deliverable emission is
 *  a discretionary tool call the implementor can forget, and QA is the gate that marks a task done —
 *  so QA is where the reliability backstop lives. When the harness detected artifact files the
 *  implementor wrote but never surfaced, they're listed as concrete candidates; either way QA must
 *  confirm every owner-facing artifact this task produced was surfaced, and fail (blocker) if not. */
function deliverablesCheckBlock(unsurfacedArtifacts: string[]): string {
  const lines = [
    "## Deliverables check (REQUIRED — do this every round)",
    "A deliverable is a file the owner should be able to open/download from the console; the implementor surfaces one by calling `post_deliverable`, which is easy to forget. Verify it did so for EVERY owner-facing artifact this task produced — a report, generated document, CSV/data export, diagram, rendered image/video, or generated asset (NOT ordinary source-code or config edits). Cross-check the actual git diff / new files against the deliverables already recorded (use `read_findings` — deliverables show as `[info]` findings whose summary is the file's label).",
    "If any produced artifact was NOT surfaced, that is a **blocker** issue: fail the review and tell the implementor exactly which file(s) to `post_deliverable` (with an absolute path so the card resolves). Do not surface them yourself — bounce it back.",
  ];
  if (unsurfacedArtifacts.length) {
    lines.push(
      "",
      "The harness flagged these files the implementor WROTE but did not surface as deliverables — check each; if it's an owner-facing artifact, its absence is a blocker (if it's genuinely just a source/support file, note that and move on):",
      ...unsurfacedArtifacts.map((p) => `- ${p}`),
    );
  } else {
    lines.push(
      "",
      "(The harness did not auto-detect any unsurfaced artifact from the implementor's file writes, but that detection misses files generated via scripts/Bash — still verify against the real git diff yourself.)",
    );
  }
  return lines.join("\n");
}

function formatQaIssues(qa: QaOutput): string {
  const lines = (qa.issues ?? []).map((i) => `- [${i.severity ?? "issue"}] ${i.description}${i.location ? ` (${i.location})` : ""}`);
  return (qa.summary ? `${qa.summary}\n` : "") + (lines.length ? lines.join("\n") : "(see QA summary)");
}

function prependUserContent(content: string | unknown[], note: string): string | unknown[] {
  if (typeof content === "string") return `${note}\n\n${content}`;
  return [{ type: "text", text: note }, ...content];
}

/** Turn a Claude structured-role config into a self-contained CLI kickoff. CLI backends cannot attach
 * the in-process bus MCP servers, but they can perform the role's core repo/web/test work and both expose
 * structured-output adapters. The prompt preserves the original system doctrine and schema contract. */
function cliRoleKickoff(
  cfg: AgentRunConfig,
  content: string | unknown[],
  role: "planner" | "researcher" | "qa" | "reader",
  provider: "Codex" | "Grok",
): string | unknown[] {
  const system =
    typeof cfg.systemPrompt === "string"
      ? cfg.systemPrompt
      : cfg.systemPrompt && typeof cfg.systemPrompt === "object"
        ? cfg.systemPrompt.append ?? ""
        : "";
  const schema = cfg.outputFormat?.schema;
  const safety =
    role === "qa"
      ? "You are a reviewer: inspect and run checks, but do not edit the implementation."
      : role === "planner"
        ? "Plan only: inspect the repository, but do not edit it."
        : role === "researcher"
          ? "Research external sources only; do not edit the repository."
          : "Remain read-only.";
  // Grok streams one status JSON object per model turn into a single text buffer; tell it explicitly
  // that ONLY the final object is read, and prefer a trailing fenced block so multi-turn drafts don't
  // poison the parse (the runner still recovers the last schema-valid object either way).
  const schemaBlock = schema
    ? [
        jsonContractInstruction(schema),
        "Do NOT emit intermediate status JSON objects mid-work — only the final schema-matching object at the end counts.",
      ].join("\n\n")
    : "";
  const noMcp =
    role === "qa"
      ? [
          "The orchestrator-specific bus/office MCP tools (post_finding, post_deliverable, read_findings, office_look, chat_post, chat_read) are UNAVAILABLE on this fallback.",
          "Complete the core QA review directly: inspect git, run checks/browser tests yourself, and emit the final schema JSON.",
          "For deliverables: check the git diff / new files yourself — do not call read_findings. Do not invent tool calls.",
        ].join(" ")
      : "The orchestrator-specific bus/office MCP tools are unavailable on this fallback. Complete the core role directly; do not invent tool calls.";
  const prelude = [
    `[Temporary provider fallback: run the ${role} role on ${provider}.]`,
    system,
    safety,
    noMcp,
    schemaBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
  return prependUserContent(content, prelude);
}

/** Human label for an implementor backend, for the failover findings/notices. */
function providerLabel(p: ImplementorProvider): string {
  return p === "codex" ? "Codex" : p === "grok" ? "Grok" : "Claude";
}

function providerCandidateFromClaude(c: AccountDispatchPreview): ProviderCandidate {
  return {
    provider: "claude",
    hasHeadroom: c.hasHeadroom,
    fiveHour: c.fiveHour,
    sevenDay: c.sevenDay,
    sevenDayReset: c.sevenDayReset,
    weeklySafetyPct: c.weeklySafetyPct,
  };
}

function providerPriority(x: ProviderCandidate, y: ProviderCandidate): number {
  return (
    providerWeeklyResetAt(x) - providerWeeklyResetAt(y) ||
    providerHeadroom(y.sevenDay) - providerHeadroom(x.sevenDay) ||
    providerHeadroom(y.fiveHour) - providerHeadroom(x.fiveHour)
  );
}

/** All providers over their soft ceilings is explicitly a no-freeze condition: keep routing, choosing
 *  the backend with the most weekly (then 5h) headroom instead of the normal soonest-reset winner. */
function providerSafetyFallbackPriority(x: ProviderCandidate, y: ProviderCandidate): number {
  return bySafetyHeadroom(x, y) || providerPriority(x, y);
}

/** "Spread usage" order across backends — target the provider (Claude / Codex / Grok) with the LOWEST
 *  weekly usage (most weekly headroom) so burn evens out across ALL platforms, not the default
 *  soonest-reset winner. 5h headroom then soonest reset break ties. Mirrors AccountManager.bySpreadUsage,
 *  which balances the Claude subs INSIDE the Claude candidate the same way. Exported for unit tests. */
export function providerSpreadUsage(x: ProviderCandidate, y: ProviderCandidate): number {
  return (
    providerHeadroom(y.sevenDay) - providerHeadroom(x.sevenDay) ||
    providerHeadroom(y.fiveHour) - providerHeadroom(x.fiveHour) ||
    providerWeeklyResetAt(x) - providerWeeklyResetAt(y)
  );
}

function providerWeeklyResetAt(c: ProviderCandidate): number {
  return c.sevenDayReset ?? Number.POSITIVE_INFINITY;
}

function providerHeadroom(pct: number | null): number {
  return 100 - (pct ?? 0);
}

function fmtUsage(n: number | null): string {
  return n == null ? "-" : `${Math.round(n)}%`;
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
