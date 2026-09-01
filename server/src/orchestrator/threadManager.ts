import type { AccountDispatchPreview, AccountManager } from "../accounts/accountManager.js";
import { bySafetyHeadroom, untilReset, weeklySafetyPool } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import {
  AgentRun,
  ZaiAgentRun,
  parseUsageLimitResetAt,
  usageLimitResetWasExplicitlyElapsed,
  providerErrorLooksRateLimited,
  type AgentRunConfig,
  type AgentRunLike,
  type SendOpts,
  type UserContent,
} from "../agents/runner.js";
import { CodexAgentRun, chatgptLoginAvailable, codexAuthAvailable, testOpenAiKey, type CodexTestResult } from "../agents/codexRunner.js";
import { withCommunicationSystemPolicy, withCommunicationTurnPolicy } from "../agents/communicationPolicy.js";
import { codexPools, codexUsageCapped, liveCodexUsage, readCodexUsage } from "../agents/codexUsage.js";
import {
  detectTimedComplete,
  formatDuration,
  isHollowRound,
  remainingMs,
  timedBriefBlock,
  timedClosingNote,
  timedDecision,
  timedExtensionMessage,
  timedWindow,
  type TimedWindow,
} from "./timedTasks.js";
import {
  MAX_AGENTS,
  SHOTGUN_SCHEMA,
  clampAgentCount,
  collaboratorSettled,
  decompositionKickoff,
  integrationBrief,
  isShotgun,
  ownershipBlock,
  validateDecomposition,
  type CollaboratorOutcome,
  type ShotgunAssignment,
  type ShotgunPlan,
} from "./shotgun.js";
import {
  dedicatedPools,
  dedicatedPoolModel,
  describePool,
  normalizeModelId,
  POOL_HARD_LIMIT_PCT,
  poolForModel,
  poolHasHeadroom,
  poolLatched,
  roleMayUseDedicatedPool,
  type CodexPool,
} from "../agents/codexPools.js";
import { GrokAgentRun, grokAuthAvailable, readGrokAuth } from "../agents/grokRunner.js";
import { noteGrokCap, readGrokUsage, grokUsageCapped } from "../agents/grokUsage.js";
import { noteZaiCap, readZaiUsage, zaiUsageCapped } from "../agents/zaiUsage.js";
import { ModelCatalog, CURATED_CLAUDE_MODELS, CURATED_CODEX_MODELS, CURATED_GROK_MODELS, CURATED_ZAI_MODELS, uniq } from "../agents/modelCatalog.js";
import { clampEffort, coworkerRunOptions, implementorConfig, plannerConfig, qaConfig, readerConfig, researcherConfig, resolveEffort, reviewerConfig } from "../agents/roles.js";
import { jsonContractInstruction, type JsonSchemaLike } from "../agents/structuredText.js";
import { CODEX_IMPLEMENTOR_DOCTRINE, COWORKER_PROMPT, GROK_IMPLEMENTOR_DOCTRINE } from "../agents/prompts.js";
import { createBusServer } from "../bus/busServer.js";
import { createGitReadServer } from "../bus/gitReadServer.js";
import { createOfficeServer } from "../bus/officeServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { OperatorNotes } from "./notes.js";
import { compressSession, sessionAgeMs } from "./resumeCompress.js";
import { gradeSettledTask, outcomeOfState } from "./modelGrading.js";
import { buildSelectionPrompt, defaultCandidateEffort, modelNote, parseSelection, type ModelCandidate } from "./modelSelector.js";
import { providerIntent } from "./providerIntent.js";
import { detectModelRequest, resolveModelRequest, type ModelRequestCandidate } from "./modelRequest.js";
import { LiveBenchScores } from "./liveBenchScores.js";
import {
  assessCapacity,
  capacityWindowsWithFreshness,
  demandForRole,
  demandSummary,
  describeCapacity as describeRoutingCapacity,
  formatUntil,
  nextViableAt,
  preferCapacity,
  standardCapacityWindows,
  type CapacityDemand,
  type CapacityWindow,
} from "./capacityRouting.js";
import { collectTaskWrittenFiles, detectUnsurfacedArtifacts } from "./deliverableCheck.js";
import { selectRoute } from "./routeSelection.js";
import { getFileDiff, getTaskGitStatus, getHeadSha, getTaskGitSummary, type GitFileDiff, type GitStatus, type GitSummary } from "../gitService.js";
import { validRepoPath } from "../git/repoOps.js";
import { titleFromInjection, titleFromBrief } from "./titleFromInjection.js";
import { MAX_RUN_ERROR_LEN, runErrorText } from "./runError.js";
import { completionAnnouncement } from "./voiceAnnounce.js";
import { DiscordNotifier, parseChannelId, type OwnerNotice } from "./discordNotify.js";
import type { CoworkTarget, PreparedCoworkRun } from "./cowork.js";
import { DirectorSupervisor, SUPERVISOR_JUDGE_MAX_TURNS, type SupervisorJudgement } from "./supervisor.js";
import { FreeProviderAgentRun } from "../freeProviders/agentRun.js";
import type { FreeProviderService } from "../freeProviders/service.js";
import { config, fallbackModelFor } from "../config.js";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { contentWithImages, toImageBlock, type ImageBlock } from "../attachments.js";
import { acknowledgedInjection, injectionSendOptions, structuredAcknowledgedInjection } from "./injection.js";
import type {
  AgentEvent,
  AgentRunState,
  AttachmentRef,
  AutoReviewSource,
  ChatMessage,
  CodexEffort,
  CoworkMessage,
  CoworkSession,
  Effort,
  Finding,
  GrokEffort,
  ImageAttachment,
  ImplementorProvider,
  ModelOverrides,
  ModelPick,
  ModelRequest,
  OrchestratorSettings,
  PlanOutput,
  QaOutput,
  RateLimitInfo,
  ReaderOutput,
  ResearchOutput,
  ReviewerOutput,
  Role,
  RouteDecision,
  StageOutputs,
  SupervisorSnapshot,
  Thread,
  ZaiEffort,
} from "../types.js";
import { agentKey, CLAUDE_EFFORTS, claudeEffortsForModel, CODEX_EFFORTS, CODEX_SUB_ID, codexEffortsForModel, DEFAULT_SUB_ID, EFFORTS, GENERAL_ROOM, GNOME_NAMES, gnomeName, grokEffortsForModel, GROK_EFFORTS, GROK_SUB_ID, isRole, MODEL_ROLES, normalizeWorkspace, NOTE_MAX_CHARS, repoRoom, resolveClaudeEffort, resolveCodexEffort, ZAI_EFFORTS, ZAI_SUB_ID } from "../types.js";
import type { LocalAgentSnapshot, OnlineOffice } from "../office/onlineOffice.js";
import { OFFICE_ROOM as ONLINE_OFFICE_ROOM } from "../office/onlineProtocol.js";
import type { RelayChat, RelayPresentAgent } from "../office/onlineProtocol.js";

// A real setup has a handful of subscriptions (Claude accounts + codex + the "default" layer); this
// caps a LAN-reachable client from bloating the single kv blob that's re-parsed on every dispatch.
const MAX_MODEL_SUB_ENTRIES = 64;
const IMAGE_MEDIA_TYPES = new Set<ImageAttachment["mediaType"]>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A concrete backend/model/account the provider-neutral director can start on. `key` is persisted by
 *  Director so auto-selection happens once and is reused until this target loses headroom. */
export interface DirectorTarget {
  key: string;
  provider: ImplementorProvider;
  model: string;
  accountId: string;
  accountLabel: string;
  /** Live allowance used by this target, shown to the smart selector. */
  capacity?: string;
}

const DIRECTOR_PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key"],
  properties: { key: { type: "string" } },
};

/** The planner's own findings, flattened for the model selector: what the task turned out to involve,
 *  which files it touches, what's risky, and how hard the planner judged it. This is the only view of the
 *  REPO the selector gets — the planner already read the code, so re-reading it would be a second cost
 *  for a worse answer. */
function planDigest(plan?: PlanOutput): string | undefined {
  if (!plan) return undefined;
  const parts = [plan.summary];
  if (plan.steps?.length) {
    parts.push("", "Steps:");
    for (const s of plan.steps) parts.push(`- ${s.title}${s.files?.length ? ` (${s.files.join(", ")})` : ""}: ${s.detail}`);
  }
  if (plan.risks?.length) parts.push("", "Risks:", ...plan.risks.map((r) => `- ${r}`));
  if (plan.effort) parts.push("", `The planner judged this task's effort as: ${plan.effort}.`);
  return parts.join("\n");
}

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
    if (typeof eff === "string" && CLAUDE_EFFORTS.includes(eff) && eff !== "max") out[id] = eff;
    if (Object.keys(out).length >= MAX_MODEL_SUB_ENTRIES) break;
  }
  return out;
}

/** Bucket remote agents by the machine they work on — the unit the office announces and counts in. */
function byInstance(agents: RelayPresentAgent[]): Map<string, RelayPresentAgent[]> {
  const out = new Map<string, RelayPresentAgent[]>();
  for (const a of agents) out.set(a.instanceName, [...(out.get(a.instanceName) ?? []), a]);
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

class LabQaAgentRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined = "lab-qa-fixture";
  finished = false;
  lastResult: ResultEvent | undefined;
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;

  start(_firstMessage: UserContent): this {
    this.emitter.emit("event", { type: "init", sessionId: this.sessionId });
    return this;
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  onEnd(cb: () => void): void {
    this.emitter.once("end", cb);
  }

  send(_content: UserContent, _opts?: SendOpts): void {}

  async interrupt(): Promise<void> {
    await this.stop();
  }

  async setModel(_model?: string): Promise<void> {}

  async setPermissionMode(_mode: unknown): Promise<void> {}

  endInput(): void {}

  async stop(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.emitter.emit("end");
  }

  result(): Promise<ResultEvent | undefined> {
    return new Promise(() => {});
  }

  nextResult(): Promise<ResultEvent | undefined> {
    return this.result();
  }
}

/** A resumable agent session: the id AND the backend that produced it. Session ids are provider-specific
 *  (a Claude SDK session vs a Codex thread id vs a Grok session id), so the two only ever travel together. */
interface RoleSession {
  sessionId: string;
  provider: ImplementorProvider;
}

export interface ProviderCandidate {
  provider: ImplementorProvider;
  hasHeadroom: boolean;
  fiveHour: number | null;
  fiveHourReset?: number | null;
  sevenDay: number | null;
  sevenDayReset: number | null;
  weeklySafetyPct: number; // 1-100 soft weekly ceiling; at/above it this backend is de-preferred (100 = off)
  capacityLabel?: string;
  /** Every window that gates this exact account/provider/model pool, including monthly credits. */
  capacityWindows?: CapacityWindow[];
}

interface RoleCapacityOption {
  provider: ImplementorProvider;
  label: string;
  windows: CapacityWindow[];
  hasHeadroom: boolean;
}

interface RoleCapacitySnapshot {
  options: RoleCapacityOption[];
  ready: RoleCapacityOption[];
  /** Earliest future reset that makes one option viable. Undefined while one is viable now. */
  nextAt?: number;
}

interface ClaudeCapacityOption extends RoleCapacityOption {
  accountId: string;
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
    | "zaiKeyPresent"
    | "zaiKeyLast4"
    | "discordTokenPresent"
    | "discordTokenLast4"
    | "xhighEnabled"
    | "modelDefaults"
    | "claudeModels"
    | "codexModels"
    | "grokModels"
    | "zaiModels"
  >
> & { openaiApiKey?: string; zaiApiKey?: string; discordBotToken?: string };

/** The slice of operator settings the implementor→QA stage needs, captured at pipeline start. */
interface PipeOpts {
  qaEnabled: boolean;
  maxQaRounds: number;
  autoPush?: boolean;
  /** Opt-in: QA fixes its own findings, then another QA run verifies every changed tree. */
  qaAppliesFixes?: boolean;
}

/** One QA attempt: which round it belongs to, the QA-fixes options, and whether it is continuing a
 *  reviewer that was cut off at its turn ceiling rather than starting that round's review. */
interface QaRoundOpts {
  round: number;
  applyFixes?: boolean;
  autoPush?: boolean;
  forcedProvider?: ImplementorProvider;
  forceFresh?: boolean;
  priorFixSummary?: string;
  continuation?: boolean;
}

// The roles whose empty runs are detected and recovered: each one's verdict (or finished work) GATES what
// the pipeline does next, so a run that produced nothing must not read as an answer. The one-shot
// planner/researcher/reader are excluded on purpose — their park IS the design.
type SilentCapableRole = Extract<Role, "implementor" | "qa" | "reviewer">;

const MAX_RESULT_PREVIEW = 600;
const QUESTION_TIMEOUT_MS = 20 * 60 * 1000;
// SDK result subtypes that mean "involuntarily cut off, not finished" — the orchestrator silently
// warm-resumes these instead of carrying half-done work into QA. A genuine finish is `success`; a usage
// cap is detected separately (agent.rateLimited). Kept as a set so more cutoff subtypes can join here.
const LIMIT_SUBTYPES: ReadonlySet<string> = new Set(["error_max_turns"]);
// How many times ONE review may be woken after stopping at its turn ceiling before returning a verdict.
// Per review, not per task: what this bounds is a reviewer WEDGED on one pass, and a round that did reach
// a verdict has proven it isn't wedged, so the next round starts with a full allowance again. The task's
// total is still bounded — maxQaRounds rounds each spending at most this many.
const MAX_QA_CUTOFF_RESUMES = 2;
// How many times ONE task may re-run a QA review that came back EMPTY (a session that never reached the
// model). Only one, deliberately: unlike a cutoff — where waking a warm session resumes real, half-finished
// work — the retry here is a full fresh review, and a FRESH session that still produces nothing is not a
// stale-resume problem, so a second attempt would just repeat the same experiment at Opus prices. One retry,
// then park with the run's own diagnosable reason.
const MAX_QA_SILENT_RETRIES = 1;
// The same allowance for the on-demand auto-reviewer, shared across BOTH involuntary stops it recovers
// from (a turn-ceiling cutoff and an empty run), since either can follow the other. It is one
// owner-initiated run rather than a loop, so the budget lives in-process: a restart re-parks the task for a
// fresh click instead of resuming it.
const MAX_REVIEW_RECOVERIES = 2;
// Explicit, terminal completion phrasing in the implementor's last words — deliberately narrow, since a
// false "done" suppresses a needed auto-resume (the bug), while a missed "done" only costs one cheap warm
// resume. Forward-looking phrasing ("doing that now", "starting that next") must NOT match.
const IMPLEMENTOR_DONE_RE =
  /\b(all done|task (?:is )?(?:now )?complete|everything is (?:complete|done)|nothing (?:more|else) (?:to do|left)|ready for (?:qa|review)|handing (?:off |this )?(?:to )?qa|the work is (?:complete|done|finished))\b/;
/** A task-feed injection can explicitly override the task's sticky automatic QA route. Require BOTH a
 * clear rejection of QA and a command to finish/end the task; ordinary discussion such as "don't skip
 * QA" or "fix this before QA" must never accept work accidentally. This is intentionally narrow because
 * a false positive marks owner-visible work done. */
export function ownerRequestsFinishWithoutQa(message: string): boolean {
  const text = message.normalize("NFKC").toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (
    /\b(?:do not|don't|dont|never)\s+(?:(?:ever|need|want)\s+(?:to\s+)?)?(?:skip|bypass|disable|stop|cancel)\s+(?:the\s+)?qa\b/.test(
      text,
    )
  )
    return false;
  if (/\bnot\s+without\s+(?:the\s+)?qa\b/.test(text)) return false;
  if (/\b(?:do not|don't|dont)\s+(?:end|finish|complete|close|mark)\b/.test(text)) return false;
  const rejectsQa =
    /\b(?:skip|bypass|disable|stop|cancel)\s+(?:the\s+)?qa\b/.test(text) ||
    /\b(?:no|without)\s+(?:more\s+)?qa\b/.test(text) ||
    /\b(?:we\s+)?(?:do not|don't|dont)\s+need\s+(?:(?:a|any|the)\s+)?qa\b/.test(text) ||
    /\bqa\s+(?:is\s+not|isn't|isnt)\s+(?:needed|required|necessary)\b/.test(text) ||
    /\b(?:do not|don't|dont)\s+(?:run|start)\s+(?:the\s+)?qa\b/.test(text);
  const finishesTask =
    /\b(?:end|finish|complete|close)\s+(?:(?:this|the)\s+)?task\b/.test(text) ||
    /\bmark\s+(?:(?:this|the)\s+)?(?:task\s+)?(?:as\s+)?done\b/.test(text) ||
    /\b(?:end|finish|close)\s+(?:this|it)\b/.test(text) ||
    /\b(?:end|finish|complete|close)\s+(?:this\s+)?without\s+qa\b/.test(text);
  return rejectsQa && finishesTask;
}
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
// The nudge sent when a resume came back having produced NOTHING. The agent never saw the previous nudge —
// that session returned without ever reaching the model — so this one has to re-state the whole situation
// from scratch rather than referring back to it.
const SILENT_RESUME_NUDGE =
  "Your previous session ended before the work was finished — it stopped at a turn limit or was cut off, not " +
  "because the task was complete. Your earlier changes are already in the working tree. Review the current " +
  "state, then continue from there and finish the task completely.";
// What a silent run's `agent_runs` row records instead of a misleading `done`. `probe:run-errors` classifies
// on this exact text (CLASSES key "silent"), so the two must not drift.
const SILENT_RUN_ERROR =
  "Resumed session produced no output — the run returned without ever reaching the model (0 turns, $0).";
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
// A provider-stated reset is more authoritative than a generic live-usage probe. Keep its provenance
// across a deploy so a fresh app-server reading cannot route work back to a provider that explicitly
// told us "try again at …".
const CODEX_CAP_SOURCE_KV_KEY = "codex_cap_reset_source";
// A cap can originate in a director turn, which deliberately has no `agent_runs` row. Keep the time
// at which the durable latch was observed so boot reconciliation never lets an older pipeline success
// erase a newer director-origin cap.
const CODEX_CAP_RECORDED_AT_KV_KEY = "codex_cap_recorded_at";
/** Per-pool Codex cap latches ({limitId: epochMs}), separate from the general pool's own latch. */
const POOL_CAP_KV_KEY = "codex_pool_cap_until";
// Grok's weekly scrape normally supplies the reset epoch; before it lands, a rejected turn falls back to
// a fixed cooldown (config.grok.capCooldownMs). kv-persisted.
const GROK_CAP_KV_KEY = "grok_cap_until";
const GROK_CAP_RECORDED_AT_KV_KEY = "grok_cap_recorded_at";
// z.ai's quota scrape supplies the true 5h/weekly reset; before it lands, a rejected turn falls back to a
// fixed cooldown (config.zai.capCooldownMs). kv-persisted so a restart's auto-resume wave doesn't slam a
// still-capped z.ai.
const ZAI_CAP_KV_KEY = "zai_cap_until";
const ZAI_CAP_RECORDED_AT_KV_KEY = "zai_cap_recorded_at";
const PROVIDER_HARD_LIMIT = 98;
const STARTUP_HEALTH_COOLDOWN_LABEL = "startup health cooldown";
// Provider usage caches older than their normal polling horizon are availability hints, not current
// runway. Hard-limit holds remain conservative; apparent headroom becomes unknown (see capacityRouting).
const ROUTING_USAGE_STALE_MS = 40 * 60_000;
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
// That delay is held in memory, so a SECOND bounce landing inside it kills the resume with the process —
// and the thread is 'failed' by then, which the IN_FLIGHT scan skips. The next boot re-arms from the
// persisted promise instead. Bounded: each attempt costs a spawn, so a task that never gets running
// again becomes a person's to look at rather than every boot's to retry.
const MAX_STRANDED_REVIVALS = 3;
// …and bounded in time as well as in attempts. The original promise means "in 4 seconds"; a revival can be
// arbitrarily later, and resuming a day-old session onto a workspace other agents have since committed to
// is a surprise, not a recovery. Past this, hand it to a person instead.
const MAX_STRANDED_AGE_MS = 24 * 3600_000;
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
/** Operator-appointed active-task hard stops. This marker is deliberately distinct from CAP_PARK_PREFIX:
 * every autonomous recovery path may revive a cap park, while a deadline park requires a fresh operator
 * decision. Exported only so focused regression tests can assert the durable contract without copying it. */
export const ACTIVE_DEADLINE_PARK_PREFIX = "⏰ Hard deadline reached";
export const ACTIVE_DEADLINE_MAX_MS = 30 * 24 * 3_600_000;
const ACTIVE_DEADLINE_RUN_REASON = "Stopped by the active-task hard deadline; the saved session and partial work were preserved.";
const DEADLINE_TERMINAL_STATES: ReadonlySet<Thread["state"]> = new Set(["done", "cancelled", "closed"]);
// Shared prefix for every "a server restart killed this thread" error, so startResumedImplementor can
// recognise a restart-triggered resume from the thread's persisted error alone.
const RESTART_ERROR_PREFIX = "interrupted by a server restart";
const RESTART_FAILED_MSG = `${RESTART_ERROR_PREFIX} — click Resume to continue from where it left off (finished stages are reused)`;
const RESTART_AUTO_RESUME_MSG = `${RESTART_ERROR_PREFIX} — auto-resuming…`;
const RESTART_REVIVAL_SPENT_MSG =
  `${RESTART_ERROR_PREFIX} — auto-resume was re-armed ${MAX_STRANDED_REVIVALS}× across restarts and never got this task running again. ` +
  `Click Resume to continue from where it left off (finished stages are reused).`;
const RESTART_REVIVAL_STALE_MSG =
  `${RESTART_ERROR_PREFIX} — the auto-resume it was promised never fired, and the task is now too old to pick up on its own. ` +
  `Click Resume to continue from where it left off (finished stages are reused).`;
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
  "reviewing",
  "paused",
]);
// A server restart during an on-demand auto-review: the task was PARKED before the reviewer started, so
// there is nothing to resume — put it straight back where it came from rather than through the generic
// 'failed' + manual-Resume path (which would re-enter the implementor pipeline on already-finished work).
const REVIEW_INTERRUPTED_MSG =
  "Auto-review was interrupted by a server restart and is parked for your review. It will not relaunch automatically; click “Auto-review & mark done” only if you want a fresh manual pass.";
// Same restart, but it landed during the fix round the auto-review had started: the implementor's work so
// far is in the working tree, and re-running the review is what picks the episode back up from there.
const REVIEW_FIX_INTERRUPTED_MSG =
  "Auto-review was fixing the issues it found when a server restart interrupted it — anything the implementor had already changed is still in the working tree. It is parked and will not relaunch automatically; click “Auto-review & mark done” only when you want to re-review that retained work.";
// A restart during the opt-in self-improvement round. That round starts only once the task has ALREADY been
// accepted (QA passed, or a clean finish with QA disabled) and is explicitly best-effort, so 'done' is where
// the task was headed the moment the round began. Auto-resuming it through the generic 'failed' path instead
// re-enters runImplementorQaLoop on accepted work and spends another implementor + QA round on it — and
// again on every subsequent bounce, since each one lands in the same window. (Seen in production: an
// accepted task took a fresh Codex implementor + a second Opus QA round off ONE bounce.)
const SELF_IMPROVE_INTERRUPTED_MSG =
  "The post-task self-improvement round was cut short by a server restart. The task itself was already complete and accepted, so it is marked done — anything the round had started building may still be sitting uncommitted in the working tree.";
// A re-park message is the reviewer's own prose, and it lands in the thread's `error` — which the board
// card and the detail header render inline. Cap it so a chatty verdict can't push the whole summary into
// the header; the full text stays readable as the finding the verdict also posts.
const MAX_REVIEW_ERROR_LEN = 400;
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
const COWORK_CONFLICT_STATES: ReadonlySet<Thread["state"]> = new Set([
  "planning",
  "researching",
  "implementing",
  "qa",
  "reviewing",
  "awaiting_user",
]);
// Reader results normally reach the owner through the in-process MCP bus (`post_finding`). Codex is the
// safe CLI exception: it has a real read-only sandbox and its schema carries the answer for ThreadManager
// to post. Grok has no equivalent harness-level read-only boundary, so it remains excluded.
const MCP_DEPENDENT_ROLES: ReadonlySet<Role> = new Set(["reader"]);
// Backends that reach the bus/office through the runner's `OFFICE[...]` TEXT bridge instead of real MCP
// servers, so the tools above simply aren't there. z.ai is deliberately NOT one: it drives the same Claude
// SDK against an Anthropic-compatible endpoint and keeps the MCP servers and structured output `makeCfg`
// built, so gating it out here would park a role that could have run (see the `provider === "zai"` branch).
const CLI_BRIDGED_PROVIDERS: ReadonlySet<ImplementorProvider> = new Set(["codex", "grok"]);

/** Whether a backend can serve a role at all — the fitness test the failover paths gate on. Exported for
 *  the provider-serves-role unit gate (the role×provider matrix IS the failover contract). */
export function providerServesRole(role: Role, provider: ImplementorProvider): boolean {
  if (role === "reader" && provider === "codex") return true;
  return !MCP_DEPENDENT_ROLES.has(role) || !CLI_BRIDGED_PROVIDERS.has(provider);
}
/** The roles `runRole` drives: every non-implementor agent, each one-shot and schema-bound. */
type StructuredRole = "planner" | "researcher" | "qa" | "reader" | "reviewer";
type QaStopOutcome =
  | { status: "stopped" }
  | { status: "no-live-handle" }
  | { status: "failed"; error: string };
/** A pipeline stage that can be paused solely because every provider is quota-capped.  This is kept
 * separate from `Role`: auto-review is an owner-initiated, post-pipeline action and must never be
 * restarted as though it were a normal pipeline. */
type CapParkStage = "planner" | "researcher" | "implementor" | "qa" | "reader";

/** Where the remote-chat dedup set is persisted. The relay replays a room's backlog on every entry, and
 *  a restart is an entry — so this guard has to be durable, not in-memory. */
const REMOTE_CHAT_SEEN_KV = "online_office_seen_chat";
const GROK_XHIGH_DEFAULT_MIGRATION_KV = "migration_grok_xhigh_default_v1";
const CODEX_ULTRA_DEFAULT_MIGRATION_KV = "migration_codex_ultra_default_v1";
/** How many relay message ids to remember. Comfortably above `ROOM_HISTORY` (60) per shared room, so a
 *  replayed backlog is still recognised after a bounce; trimmed oldest-first. */
const REMOTE_CHAT_SEEN_MAX = 500;

export class ThreadManager implements OrchestratorApi {
  private readonly live = new Map<string, LiveImplementor>();
  private readonly activeRuns = new Map<string, Set<AgentRunLike>>();
  // The cross-machine office, when the operator has joined one. Null is the normal, fully-working state:
  // every office path degrades to the local-only behaviour it had before the feature existed.
  private online: OnlineOffice | null = null;
  // Relay message ids already persisted locally, mirrored into kv. A room's backlog is replayed whenever
  // this instance (re)enters it — and the connect after a RESTART is an entry, when an in-memory set is
  // empty — so the guard outlives the process. Otherwise every bounce re-persisted up to ROOM_HISTORY
  // lines per shared room AND re-pushed them at the auto-resumed implementors as if they were new.
  private readonly remoteChatSeen = new Set<string>();
  private remoteChatSeenLoaded = false;
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
  // Threads whose on-demand auto-review is live. The reviewer settles the task itself (done, or back to
  // 'review'), so this is purely the double-click guard: the button is clickable again the instant the
  // task re-parks, and two reviewers deciding one task's fate concurrently must never happen.
  private readonly reviewing = new Set<string>();
  // Threads whose opt-in post-task self-improvement round is live. That round runs on ALREADY-accepted
  // work, so the inject/resume gates must steer it rather than spawn beside it — and like the auto-review
  // fix round it runs under 'implementing', where the implementor's own onEnd clears `this.live` while the
  // awaited result is still in flight. A state-only check falls through in exactly that window and
  // cold-resumes a SECOND implementor onto the workspace, so those gates key on this episode instead.
  private readonly selfImproving = new Set<string>();
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
  // QA agent is the only thing running. Append steering reaches THAT QA agent; interrupt steering stops
  // or supersedes it and resumes the implementor. Either path must never wake/spawn an implementor beside
  // active QA — that's what put two agents in one slot. liveQa holds the steerable/stoppable QA run.
  private readonly liveQa = new Map<string, AgentRunLike>();
  // A QA verdict has already failed and the loop is awaiting the normal fix-round implementor resume.
  // State remains 'qa' and liveQa is absent during session compression, so interrupt/inject commands in
  // this window must join that already-starting implementor instead of creating a QA-supersede resume.
  private readonly qaFixHandoff = new Set<string>();
  // Same idea for the on-demand auto-reviewer: it owns the slot alone while it decides the task's fate,
  // so an inject/resume must reach IT rather than wake an implementor beside it.
  private readonly liveReviewer = new Map<string, AgentRunLike>();
  // Concurrency control. activePipelines holds the threads whose pipeline (dispatch OR resume) is
  // currently executing; a fresh dispatch beyond maxConcurrent waits in dispatchQueue (FIFO) in the
  // 'queued' state and starts when a slot frees. Resumes of in-flight work aren't gated — they
  // continue existing work — but they still count toward the active total.
  private readonly activePipelines = new Set<string>();
  // Co-work owns a separate lifecycle but shares repositories with task agents. This callback is
  // attached after CoworkManager is constructed; queue/resume gates consult it so neither surface can
  // start a writer underneath the other.
  private coworkWorkspaceBusy: ((workspace: string) => boolean) | null = null;
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
  // (used for the park message wording); any free backend can unpark it now that runRole
  // fails QA over to Codex/Grok. In-memory only — the durable signal is the persisted error text
  // (prefix + optional historical QA marker), so a restart still finds cap-parked tasks.
  private readonly capParked = new Map<string, CapParkStage>();
  // Last time we externally announced auto-resuming a given thread — throttles the webhook ping so a
  // task stuck in a re-cap loop doesn't spam the channel each interval (see CAP_RESUME_NOTIFY_COOLDOWN_MS).
  private readonly capResumeNotifiedAt = new Map<string, number>();
  private capSupervisor: NodeJS.Timeout | undefined;
  // The interval supervisor is a safety net. This one-shot wakes at the earliest provider/account reset
  // we actually know, so provider exhaustion does not wait for a human (or for the next coarse poll).
  private capResumeWake: NodeJS.Timeout | undefined;
  private capResumeWakeAt: number | undefined;
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
  // One absolute timer per task with an operator hard stop. The timestamp itself lives on the thread
  // row; this map is only the live alarm and is rebuilt on every boot. expiring deduplicates the timer,
  // a boundary check, and an operator action all noticing the same instant together.
  private readonly activeDeadlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly expiringDeadlines = new Set<string>();
  // Epoch ms until which Codex is treated as usage-capped, so implementors route to the Claude backend
  // instead of dispatching straight into an instant 429. Set when a live Codex run caps (real reset epoch
  // preferred, else a cooldown); auto-clears when the window passes. Persisted in kv so a restart's
  // auto-resume wave doesn't slam Codex again on stale-good routing. Undefined = Codex not latched-capped.
  private codexCapUntil: number | undefined;
  private codexCapUntilProviderStated = false;
  /** Per-pool cap latches, keyed by the plan's `limitId`. Independent of `codexCapUntil` by design —
   *  a dedicated pool (Spark) and the general pool have separate allowances and separate resets, so a
   *  429 in one must never disable the other. Persisted so a bounce doesn't retry a known-capped pool. */
  private readonly poolCapUntil = new Map<string, number>();
  private codexCapRecordedAt: number | undefined;
  // Epoch ms until which Grok is treated as usage-capped (route implementors elsewhere). Set when a live
  // Grok run is rejected; a fixed cooldown (no reset epoch is exposed). Persisted so a restart's auto-resume
  // wave doesn't slam a still-capped Grok. Undefined = Grok not latched-capped.
  private grokCapUntil: number | undefined;
  private grokCapRecordedAt: number | undefined;
  // Epoch ms until which z.ai is treated as usage-capped (route implementors elsewhere). Set when a live
  // z.ai run is rejected; the real 5h/weekly reset from the quota scrape is preferred, else a cooldown.
  // Persisted so a restart's auto-resume wave doesn't slam a still-capped z.ai. Undefined = not latched.
  private zaiCapUntil: number | undefined;
  private zaiCapRecordedAt: number | undefined;
  // Owns the live pickable-model lists (Settings dropdowns). Rebroadcasts settings when a list changes.
  private readonly modelCatalog: ModelCatalog;
  // Persistent 24h LiveBench capability prior. It informs the smart selectors but never gates routing:
  // a stale or unavailable leaderboard simply leaves local outcome history + the judging agent in charge.
  private readonly liveBench: LiveBenchScores;
  // Posts the owner's phone notifications (task done / needs you / failed) to their Discord channel.
  private readonly discord: DiscordNotifier;
  // The Director Supervisor watchdog (off by default) — see orchestrator/supervisor.ts. Standalone over a
  // narrow SupervisorHost view of this manager, so its logic never entangles with the pipeline internals.
  private readonly supervisor: DirectorSupervisor;

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    readonly memory: MemoryService,
    readonly accounts: AccountManager,
    readonly freeProviders?: FreeProviderService,
  ) {
    this.migrateProviderDefaults();
    this.modelCatalog = new ModelCatalog(
      db,
      accounts,
      () => this.openaiApiKey(),
      () => this.zaiApiKey(),
      () => this.hub.publish({ type: "settings", settings: this.settings() }),
      (level, message) => this.hub.log(level, message),
    );
    this.liveBench = new LiveBenchScores(db, (level, message) => this.hub.log(level, message));
    // Reads its config lazily on every notice, so flipping the toggle applies to tasks already running.
    this.discord = new DiscordNotifier(
      () => ({ enabled: this.settingBool("setting_discord_notify", false), token: this.discordBotToken(), channelId: this.discordChannelId() }),
      (level, message) => this.hub.log(level, message),
    );
    this.supervisor = new DirectorSupervisor(this);
    // Park already-expired rows BEFORE restart reconciliation scans in-flight states. That ordering is
    // what prevents a task whose deadline elapsed while the service was down from receiving the normal
    // four-second boot auto-resume. Future alarms are re-armed from the same durable timestamps.
    this.restoreActiveDeadlines();
    this.markInterrupted();
    this.applyAccountEnabled();
    this.applyAccountWeeklySafety();
    this.accounts.setSpreadUsage(this.settingBool("setting_spread_usage", false));
    this.loadCodexCap();
    this.loadPoolCaps();
    this.loadGrokCap();
    this.loadZaiCap();
    // A restart can interrupt a task after its provider has emitted a cap but before the cap latch was
    // persisted (or an older build may have only recorded the capped run). Rehydrate any still-future
    // provider-stated reset before auto-resume is armed, so that task cannot immediately select the
    // same exhausted provider again.
    this.restoreRecordedProviderCapLatches();
    // Earlier builds parked a capped QA pass as a manual "needs your review" task. Convert only
    // those provably quota-caused legacy parks into the durable QA-only retry state before the boot
    // supervisor scans them; completed/cancelled tasks remain untouched.
    this.recoverLegacyQaCapParks();
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
      // An account reset is the best signal that a cap-park can run again. Do not wait for the
      // periodic supervisor after the usage reader has already established fresh headroom.
      this.resumeCapParked();
      this.armCapResumeWake();
    });
    // Honor a persisted "Fast usage polling" opt-in on boot — set before accounts.start() arms the
    // ping timer in index.ts, so the first interval already uses the chosen cadence.
    this.applyUsagePollInterval();
    // Boot-apply the supervisor toggle — without this it silently reverts to off on every restart even
    // when the operator turned it on (see add-a-setting.md's 3-touch pattern).
    this.supervisor.setEnabled(this.settings().directorSupervisorEnabled);
  }

  /** Preserve old "highest available" defaults when a provider adds a new top tier. Each marker is
   * independent so an installation that already migrated Grok still receives the newer Codex migration. */
  private migrateProviderDefaults(): void {
    if (!this.db.kvGet(CODEX_ULTRA_DEFAULT_MIGRATION_KV)) {
      if (this.db.kvGet("setting_codex_effort") === "max") this.db.kvSet("setting_codex_effort", "ultra");
      this.db.kvSet(CODEX_ULTRA_DEFAULT_MIGRATION_KV, "1");
    }
    if (!this.db.kvGet(GROK_XHIGH_DEFAULT_MIGRATION_KV)) {
      if (this.db.kvGet("setting_grok_effort") === "high") this.db.kvSet("setting_grok_effort", "xhigh");
      this.db.kvSet(GROK_XHIGH_DEFAULT_MIGRATION_KV, "1");
    }
  }

  /** Convert the pre-fallback QA terminal shape into the durable cap-park protocol. Older versions
   * wrote a normal human-review message even when the latest QA run clearly says quota/rate-limit;
   * resuming that row took the manual implementor-only path and redid already-reviewed work. This runs
   * on every boot but is idempotent: once the CAP marker + qaCapRetryRound are present it leaves the
   * task alone, and it never touches done/cancelled/manual-review rows. */
  private recoverLegacyQaCapParks(): void {
    let recovered = 0;
    for (const thread of this.db.listThreads()) {
      if (thread.state !== "review" && thread.state !== "failed") continue;
      // Older settleReview paths did not use one stable suffix: some wrote "needs your review",
      // while a raw provider rejection produced `QA could not complete — <provider text>`. The
      // latest QA run is the authority below, so accept either terminal QA shape here and still
      // require positive cap/capacity evidence before converting it to an automatic retry.
      if (!/^QA could not complete —\s+/i.test(thread.error ?? "")) continue;
      const stage = this.db.getThreadStageOutputs(thread.id);
      if (!stage.kickoff || stage.qaCapRetryRound != null) continue;
      const latestQa = this.db
        .listRuns(thread.id)
        .filter((run) => run.role === "qa")
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!latestQa || (latestQa.capFlagged !== true && !providerErrorLooksRateLimited(latestQa.error ?? ""))) continue;

      this.latchLegacyProviderCap(latestQa.account ?? null, latestQa.error ?? "");
      const round = Math.max(1, stage.qaRoundsUsed ?? 0);
      this.db.updateThreadStageOutputs(thread.id, { qaCapRetryRound: round });
      this.db.updateThread(thread.id, { state: "review", error: this.capParkMessage(thread.id, "qa") });
      this.postFinding({
        threadId: thread.id,
        fromRole: "qa",
        summary: "Recovered a legacy QA usage-limit park — QA will retry automatically",
        detail: "The completed implementation is preserved; the next available provider reruns only the interrupted QA round.",
        severity: "note",
      });
      recovered++;
    }
    if (recovered) this.hub.log("warn", `Recovered ${recovered} legacy QA usage-limit ${recovered === 1 ? "park" : "parks"} for automatic provider fallback.`);
  }

  /** Reconcile persisted provider latches with recorded capped runs. This deliberately does not change a
   * task's state: it is a routing repair used before boot auto-resume and legacy-park migration. A dated
   * provider reset remains authoritative until a later clean run disproves it; a later reset-less capacity
   * rejection alone must not shorten that hold, while a restart after a reset-less cap still gets a bounded
   * fallback latch. */
  private restoreRecordedProviderCapLatches(): void {
    const now = Date.now();
    type RecordedOutcome = {
      account: string;
      error?: string;
      reset?: number;
      explicitResetExpired: boolean;
      capped: boolean;
      endedAt: number;
      startedAt: number;
    };
    const latestByAccount = new Map<string, RecordedOutcome>();
    const latestFutureReset = new Map<string, RecordedOutcome>();
    const latestCleanSuccess = new Map<string, RecordedOutcome>();
    // CLI quota is plan-wide, while run.account includes the selected model (`codex:gpt-...`). A
    // success on one Codex model therefore disproves an older cap recorded on another model too.
    const outcomeKey = (account: string): string => {
      if (account.startsWith("codex:")) return "codex";
      if (account.startsWith("grok:")) return "grok";
      if (account === "zai" || account.startsWith("zai:")) return "zai";
      return account;
    };
    const newer = (candidate: RecordedOutcome, prior: RecordedOutcome): boolean =>
      candidate.endedAt > prior.endedAt || (candidate.endedAt === prior.endedAt && candidate.startedAt > prior.startedAt);
    const rememberNewer = (map: Map<string, RecordedOutcome>, key: string, outcome: RecordedOutcome): void => {
      const prior = map.get(key);
      if (!prior || newer(outcome, prior)) map.set(key, outcome);
    };
    for (const thread of this.db.listThreads()) {
      for (const run of this.db.listRuns(thread.id)) {
        if (!run.account || run.endedAt == null) continue;
        const capped = run.capFlagged === true || providerErrorLooksRateLimited(run.error ?? "");
        // A newer clean completion proves an older recorded cap reset is stale. Ignore other errors:
        // they say nothing about whether the provider's quota reopened.
        if (!capped && run.state !== "done") continue;
        const error = run.error ?? undefined;
        const outcome: RecordedOutcome = {
          account: run.account,
          error,
          reset: capped && error ? parseUsageLimitResetAt(error, now) : undefined,
          explicitResetExpired: capped && error ? usageLimitResetWasExplicitlyElapsed(error, now) : false,
          capped,
          endedAt: run.endedAt,
          startedAt: run.startedAt,
        };
        const key = outcomeKey(outcome.account);
        rememberNewer(latestByAccount, key, outcome);
        if (outcome.capped && outcome.reset != null) rememberNewer(latestFutureReset, key, outcome);
        if (!outcome.capped) rememberNewer(latestCleanSuccess, key, outcome);
      }
    }

    const managedKey = (key: string): key is "codex" | "grok" | "zai" => key === "codex" || key === "grok" || key === "zai";
    const clearManagedCap = (key: "codex" | "grok" | "zai"): void => {
      if (key === "codex") this.clearCodexCap();
      else if (key === "grok") this.clearGrokCap();
      else this.clearZaiCap();
    };
    const managedCapUntil = (key: "codex" | "grok" | "zai"): number | undefined => {
      if (key === "codex") return this.codexCapUntil;
      if (key === "grok") return this.grokCapUntil;
      return this.zaiCapUntil;
    };
    const managedCapRecordedAt = (key: "codex" | "grok" | "zai"): number | undefined => {
      if (key === "codex") return this.codexCapRecordedAt;
      if (key === "grok") return this.grokCapRecordedAt;
      return this.zaiCapRecordedAt;
    };
    let restored = 0;
    for (const [key, outcome] of latestByAccount) {
      const stated = latestFutureReset.get(key);
      const success = latestCleanSuccess.get(key);
      const statedStillAuthoritative = !!stated && (!success || !newer(success, stated));

      if (!managedKey(key)) {
        // Claude's AccountManager owns its own persisted per-subscription cap state. Preserve the
        // existing boot repair for a provider-stated future reset without synthesizing a new fallback.
        if (outcome.capped && outcome.error && outcome.reset != null) {
          this.latchLegacyProviderCap(outcome.account, outcome.error);
          restored++;
        }
        continue;
      }

      // Not every capped provider turn creates an agent-run record: a director cap is recorded only in
      // the durable latch. Do not rewrite a live KV latch from older history. Legacy latches without
      // provenance are also retained conservatively until their already-persisted reset, rather than
      // risking a boot-time retry of a provider that just told us it was unavailable.
      const activeCapUntil = managedCapUntil(key);
      const capRecordedAt = managedCapRecordedAt(key);
      if (activeCapUntil != null && (capRecordedAt == null || outcome.endedAt <= capRecordedAt)) continue;
      if (activeCapUntil != null && outcome.capped && outcome.reset == null) {
        // A newer bare capacity rejection renews a short fallback hold, but note*Cap deliberately
        // preserves a longer existing provider reset. An expired historical date is neither evidence
        // to clear the current latch nor a reason to create a new cooldown.
        if (!outcome.explicitResetExpired && outcome.error) this.latchLegacyProviderCap(outcome.account, outcome.error);
        continue;
      }

      // A new explicit reset wins. A bare capacity/429 cap only replaces an older reset after a clean
      // completion proved that reset stale; an explicitly expired reset installs no fresh cooldown.
      const selected =
        !outcome.capped
          ? undefined
          : outcome.reset != null
            ? outcome
            : statedStillAuthoritative
              ? stated
              : outcome.explicitResetExpired
                ? undefined
                : outcome;
      clearManagedCap(key);
      if (!selected) continue;
      this.latchLegacyProviderCap(selected.account, selected.error ?? "");
      if (selected.reset != null) restored++;
    }
    if (restored) {
      this.hub.log("warn", `Restored ${restored} recorded provider usage-cap ${restored === 1 ? "latch" : "latches"} before auto-resume.`);
    }
  }

  /** A legacy failed row will never re-emit the runner's rate_limit event, so restore its provider
   * latch before scheduling recovery. This prevents an old Codex "try again at Sep 2" record from
   * immediately selecting Codex again on the first direct QA retry. */
  private latchLegacyProviderCap(accountLabel: string | null, error: string): void {
    const reset = parseUsageLimitResetAt(error);
    const info: RateLimitInfo = {
      status: "rejected",
      resetsAt: reset,
      resetSource: reset == null ? "fallback" : "provider",
    };
    if (accountLabel?.startsWith("codex:")) {
      this.noteCodexCap(info);
      return;
    }
    if (accountLabel?.startsWith("grok:")) {
      this.noteGrokCap(info);
      return;
    }
    if (accountLabel === "zai" || accountLabel?.startsWith("zai:")) {
      this.noteZaiCap(info);
      return;
    }
    const account = this.accounts.dto().find((entry) => entry.label === accountLabel);
    if (account) this.accounts.updateFromRateLimit(account.id, info);
  }

  /** Kick off the live model-list catalog (boot fetch + slow refresh). Called from index.ts after the
   *  account manager has started, so a subscription token is available for the Anthropic models fetch. */
  startModelCatalog(): void {
    this.modelCatalog.start();
    this.liveBench.start();
  }

  /** Poll for rate-limit-parked tasks and resume them the moment an account regains headroom, so a
   *  cap wave (every sub at its 5h/weekly limit) doesn't leave the owner to hand-resume each task.
   *  CAP_RETRY_MS=0 disables only the coarse poll; the reset-timed wake remains armed. */
  private startCapSupervisor(): void {
    if (config.capRetryMs <= 0) {
      this.armCapResumeWake();
      return;
    }
    // A 'review' task isn't auto-resumed on boot (markInterrupted only revives IN_FLIGHT states), so a
    // restart would otherwise strand tasks that were cap-parked before the bounce until the first
    // interval tick. Sweep once shortly after start — after the account pings have had a moment to land
    // (hasHeadroom gates it, so a too-early sweep before the first ping simply no-ops and the interval
    // catches it) — mirroring the boot auto-resume's deferral.
    setTimeout(() => this.resumeCapParked(), AUTO_RESUME_DELAY_MS).unref?.();
    this.capSupervisor = setInterval(() => this.resumeCapParked(), config.capRetryMs);
    this.capSupervisor.unref?.();
    this.armCapResumeWake();
  }

  /** Cap-park rows are durable (unlike the in-memory `capParked` set), so both the interval and the
   * reset-timed wake work across a server restart. Keep this predicate in one place so a normal review
   * is never resurrected by a quota timer. */
  private capParkedThreads(): Thread[] {
    return this.db
      .listThreads()
      .filter(
        (t) =>
          (t.state === "review" || t.state === "failed") &&
          (t.error ?? "").startsWith(CAP_PARK_PREFIX) &&
          !this.cancelled(t.id),
      );
  }

  private capParkStage(thread: Thread): CapParkStage {
    const match = /\((planner|researcher|implementor|qa|reader) stage\)/i.exec(thread.error ?? "");
    if (match) return match[1]!.toLowerCase() as CapParkStage;
    if (/\bQA\b/i.test(thread.error ?? "")) return "qa"; // legacy marker: "QA runs on Claude"
    return "implementor";
  }

  /** Earliest reset that actually makes a compatible pool viable for one of the parked workloads.
   * Simulating all gating windows avoids waking on a 5h reset while the weekly/monthly window still
   * blocks the same account, and includes independently-metered Codex model pools. */
  private earliestCapResetAt(now = Date.now()): number | undefined {
    const future: number[] = [];
    for (const thread of this.capParkedThreads()) {
      const role = this.capParkStage(thread);
      const demand = this.capacityDemand(thread, role);
      const next = this.capacitySnapshotForThread(thread, role, demand, now).nextAt;
      if (next != null) future.push(next);
    }
    return future.length ? Math.min(...future) : undefined;
  }

  /** Schedule one bounded wake at the first provider reset. The regular poll remains a fallback for
   * missing/changed provider clocks, but this removes the "sit in review until someone notices" gap. */
  private armCapResumeWake(): void {
    const parked = this.capParkedThreads();
    const resetAt = parked.length ? this.earliestCapResetAt() : undefined;
    if (this.capResumeWake && this.capResumeWakeAt === resetAt) return;
    if (this.capResumeWake) clearTimeout(this.capResumeWake);
    this.capResumeWake = undefined;
    this.capResumeWakeAt = resetAt;
    if (resetAt == null) return;
    // Node clamps values beyond a signed 32-bit timeout. Re-arm if an unusually distant provider
    // reset exceeds that bound; normal 5h/weekly windows are comfortably below it.
    const delay = Math.min(Math.max(0, resetAt - Date.now()) + 25, 0x7fffffff);
    this.capResumeWake = setTimeout(() => {
      this.capResumeWake = undefined;
      this.capResumeWakeAt = undefined;
      this.resumeCapParked();
      this.armCapResumeWake();
    }, delay);
    this.capResumeWake.unref?.();
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
    let slots = this.settings().maxConcurrent - this.activePipelines.size;
    if (slots <= 0) {
      this.armCapResumeWake();
      return;
    }
    const parked = this.capParkedThreads().sort((a, b) => a.updatedAt - b.updatedAt); // oldest-parked first — fairest, and bounded by free slots
    for (const t of parked) {
      if (slots <= 0) break;
      // Reader stages need a durable owner-answer channel. z.ai shares the Anthropic SDK, and Codex
      // now returns its read-only answer through the schema for ThreadManager to post; Grok remains
      // bridge-only, so waking on Grok-only headroom would create a deterministic cap/repark loop.
      const role = this.capParkStage(t);
      const demand = this.capacityDemand(t, role);
      const { ready } = this.capacitySnapshotForThread(t, role, demand);
      if (!ready.length) continue;
      // A prior supervisor tick may already have changed this row to failed and started its pipeline.
      // Keep the marker durable for a crash between that update and resumeThread, but never double-spawn
      // it while this process still owns the slot.
      if (this.activePipelines.has(t.id) || this.resuming.has(t.id)) continue;
      // Honor the per-repo cap too (the global cap is the `slots` gate above). resumeThread reserves the
      // slot synchronously, so activeCountForRepo already counts tasks resumed earlier in THIS pass — a
      // repo at its cap is left parked for a later supervisor tick rather than reviving two at once.
      if (this.repoAtCapacity(t.workspace)) continue;
      slots--;
      this.hub.log("info", `${ready[0]!.label} has viable runway — auto-resuming capacity-parked "${t.title.slice(0, 48)}".`);
      const now = Date.now();
      if (now - (this.capResumeNotifiedAt.get(t.id) ?? 0) > CAP_RESUME_NOTIFY_COOLDOWN_MS) {
        this.capResumeNotifiedAt.set(t.id, now);
        this.notifyExternal(`↪ ${ready[0]!.label} has viable quota runway — auto-resuming "${t.title}".`);
      }
      // Enter the resume-aware failed path without losing the durable cap marker. If this process dies
      // before resumeThread gets CPU, the next boot's supervisor still knows the task is auto-resumable.
      if (t.state === "review") this.db.updateThread(t.id, { state: "failed", error: t.error });
      const id = t.id;
      void this.resumeThread(id).catch((e) => this.hub.log("error", `Cap auto-resume of ${id.slice(0, 8)} failed: ${String(e)}`));
    }
    this.armCapResumeWake();
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
      .filter(
        (t) =>
          (t.state === "paused" || (t.state === "review" && (t.error ?? "").startsWith(CAP_PARK_PREFIX))) &&
          !this.cancelled(t.id),
      )
      .sort((a, b) => a.updatedAt - b.updatedAt); // oldest-stuck first — same fairness as the cap supervisor
    const slots = this.settings().maxConcurrent - this.activePipelines.size;
    if (stuck.length === 0 || slots <= 0) {
      this.hub.log("info", `Token window reset — ${stuck.length} task(s) waiting${slots <= 0 ? ", but no free slots" : ", none stuck"}.`);
      return;
    }
    // Select up to `slots` tasks (global cap), skipping any whose repo is already at its per-repo cap.
    // This loop chooses BEFORE starting any, so a `pending` tally counts the tasks picked this batch that
    // activePipelines won't reflect until resumeThread runs — otherwise two same-repo tasks would both pass.
    const pending = new Map<string, number>();
    const resuming: typeof stuck = [];
    for (const t of stuck) {
      if (resuming.length >= slots) break;
      if (this.repoAtCapacityWith(t.workspace, pending)) continue;
      resuming.push(t);
      const key = normalizeWorkspace(t.workspace);
      pending.set(key, (pending.get(key) ?? 0) + 1);
    }
    if (resuming.length === 0) {
      this.hub.log("info", `Token window reset — ${stuck.length} task(s) waiting, but all are at their per-repo cap.`);
      return;
    }
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
      // Keep the CAP marker durable until runPipeline has actually claimed the task. A restart in
      // the tiny gap between this write and resumeThread used to leave an ordinary failed row that
      // neither the cap supervisor nor boot recovery could discover.
      if (t.state === "review") this.db.updateThread(t.id, { state: "failed", error: t.error });
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

  // ---- operator active-task hard deadlines ------------------------------------------------------

  private deadlineParked(thread: Thread | null | undefined): boolean {
    return !!thread && (thread.error ?? "").startsWith(ACTIVE_DEADLINE_PARK_PREFIX);
  }

  private deadlineDue(thread: Thread | null | undefined, at = Date.now()): boolean {
    return !!thread && thread.activeDeadlineAt != null && thread.activeDeadlineAt <= at && !DEADLINE_TERMINAL_STATES.has(thread.state);
  }

  private disarmActiveDeadline(threadId: string): void {
    const timer = this.activeDeadlineTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.activeDeadlineTimers.delete(threadId);
  }

  /** Arm from the persisted absolute timestamp. Long horizons are re-armed in bounded chunks because
   *  Node clamps setTimeout beyond a signed 32-bit delay. The callback re-reads the row and expected
   *  timestamp, so an edit/clear racing an old callback can never enforce the superseded deadline. */
  private armActiveDeadline(thread: Thread): void {
    this.disarmActiveDeadline(thread.id);
    const deadlineAt = thread.activeDeadlineAt;
    if (deadlineAt == null || DEADLINE_TERMINAL_STATES.has(thread.state)) return;
    const delay = Math.min(Math.max(0, deadlineAt - Date.now()), 0x7fffffff);
    const timer = setTimeout(() => {
      if (this.activeDeadlineTimers.get(thread.id) !== timer) return;
      this.activeDeadlineTimers.delete(thread.id);
      const current = this.db.getThread(thread.id);
      if (!current || current.activeDeadlineAt !== deadlineAt || DEADLINE_TERMINAL_STATES.has(current.state)) return;
      if (current.activeDeadlineAt > Date.now()) this.armActiveDeadline(current);
      else void this.expireActiveDeadline(thread.id, deadlineAt);
    }, delay);
    timer.unref?.();
    this.activeDeadlineTimers.set(thread.id, timer);
  }

  /** Rebuild alarms on boot, enforcing anything that elapsed while the process was down. Called before
   *  markInterrupted so an expired in-flight row is a durable review park before boot auto-resume scans. */
  private restoreActiveDeadlines(): void {
    for (const thread of this.db.listThreads()) {
      if (thread.activeDeadlineAt == null || DEADLINE_TERMINAL_STATES.has(thread.state)) continue;
      if (this.deadlineDue(thread)) void this.expireActiveDeadline(thread.id, thread.activeDeadlineAt);
      else this.armActiveDeadline(thread);
    }
  }

  /** Persist the park FIRST, then stop every live role. Pipeline boundary guards observe the marker and
   *  cannot mistake a stop-generated success/empty result for completion. Runs, messages, stage outputs,
   *  commits and session ids are retained; only live execution/bookkeeping is torn down. */
  private async expireActiveDeadline(threadId: string, expectedDeadline?: number): Promise<void> {
    if (this.expiringDeadlines.has(threadId)) return;
    const thread = this.db.getThread(threadId);
    if (!thread || thread.activeDeadlineAt == null || DEADLINE_TERMINAL_STATES.has(thread.state)) {
      this.disarmActiveDeadline(threadId);
      return;
    }
    if (expectedDeadline != null && thread.activeDeadlineAt !== expectedDeadline) {
      this.armActiveDeadline(thread);
      return;
    }
    if (thread.activeDeadlineAt > Date.now()) {
      this.armActiveDeadline(thread);
      return;
    }

    this.expiringDeadlines.add(threadId);
    this.disarmActiveDeadline(threadId);
    const deadlineAt = thread.activeDeadlineAt;
    const reached = new Date(deadlineAt).toLocaleString();
    const reason =
      `${ACTIVE_DEADLINE_PARK_PREFIX} at ${reached}. All live agents were stopped and automatic dispatch/resume is blocked. ` +
      "The run trail, saved session, handoff, partial files and commits are preserved. Extend or clear the deadline, then click Resume to continue deliberately.";
    const alreadyParked = this.deadlineParked(thread);
    const activeRunIds = this.db.listActiveRuns().filter((run) => run.threadId === threadId).map((run) => run.id);
    const prior = thread.error && !alreadyParked ? `\n\nThe task was previously reporting: ${thread.error}` : "";

    // Remove every autonomous-recovery identity before yielding to runner teardown. A cap/token/boot
    // callback already queued in the event loop then sees a normal deadline park, never its old marker.
    this.dropFromQueue(threadId);
    this.capParked.delete(threadId);
    this.capResumeNotifiedAt.delete(threadId);
    this.pendingResumeMsgs.delete(threadId);
    this.directorNotes.delete(threadId);
    this.queuedForImplementor.delete(threadId);

    const acceptedBonusRound = this.db.getThreadStageOutputs(threadId).selfImproving === true;
    if (!alreadyParked) {
      const message = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `${reason}${prior}`,
      });
      this.hub.publish({ type: "thread.message", threadId, message });
      this.postFinding({
        threadId,
        fromRole: "director",
        summary: acceptedBonusRound ? "Hard deadline stopped the optional post-task round" : "Hard deadline reached — task stopped and parked",
        detail: `${reason}${prior}`,
        severity: "info",
      });
      if (acceptedBonusRound) {
        this.db.updateThreadStageOutputs(threadId, { selfImproving: false });
        this.setState(threadId, "done");
      } else {
        this.setState(threadId, "review", reason);
      }
      this.hub.publish({
        type: "notice",
        level: "warn",
        title: "Task hard deadline reached",
        message: `“${thread.title}” was stopped and ${acceptedBonusRound ? "left done" : "parked with its saved session intact"}.`,
      });
    }

    // Unblock owner gates whose in-memory promises otherwise outlive the now-parked task.
    const approval = this.pendingApprovals.get(threadId);
    if (approval) {
      this.pendingApprovals.delete(threadId);
      approval({ approved: false });
    }
    for (const q of this.db.listOpenQuestions()) {
      if (q.threadId === threadId) this.resolveQuestion(q.id, "(task hard deadline reached; the task was parked)");
    }

    try {
      await this.forceStopThreadRuns(threadId);
      const stoppedAt = Date.now();
      for (const runId of activeRunIds) {
        const run = this.db.getRun(runId);
        if (!run) continue;
        this.db.updateRun(runId, {
          state: "interrupted",
          error: ACTIVE_DEADLINE_RUN_REASON,
          endedAt: run.endedAt ?? stoppedAt,
        });
        this.emitRun(runId);
      }
    } finally {
      this.reviewing.delete(threadId);
      this.selfImproving.delete(threadId);
      this.expiringDeadlines.delete(threadId);
      this.hub.log("warn", `Hard deadline stopped task ${threadId.slice(0, 8)} at ${new Date(deadlineAt).toISOString()}.`);
    }
  }

  /** Public task control used by the authenticated WS API. A deadline is an absolute hard stop and may
   *  be edited repeatedly. Clearing/extension never resumes an expired task by itself: the subsequent
   *  Resume click is the second deliberate action that prevents a stale supervisor callback taking over. */
  async setActiveDeadline(threadId: string, deadlineAt: number | null): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    const now = Date.now();
    if (deadlineAt != null) {
      if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now) {
        return { ok: false, state: thread.state, error: "Choose a hard deadline in the future." };
      }
      if (deadlineAt - now > ACTIVE_DEADLINE_MAX_MS) {
        return { ok: false, state: thread.state, error: "A task hard deadline can be at most 30 days away." };
      }
      if (DEADLINE_TERMINAL_STATES.has(thread.state)) {
        return { ok: false, state: thread.state, error: `A ${thread.state} task is not active. Restore or retry it before setting a deadline.` };
      }
    }

    const updated = this.db.setActiveDeadline(threadId, deadlineAt);
    if (!updated) return { ok: false, error: "No such task." };
    if (deadlineAt == null) this.disarmActiveDeadline(threadId);
    else this.armActiveDeadline(updated);
    this.hub.publish({ type: "thread.upsert", thread: updated });

    const wasParked = this.deadlineParked(thread);
    const content = deadlineAt == null
      ? `⏰ Hard deadline cleared by the operator.${wasParked ? " The task remains parked; click Resume when you want the saved session to continue." : ""}`
      : `⏰ Hard deadline ${thread.activeDeadlineAt == null ? "set" : "changed"} to ${new Date(deadlineAt).toLocaleString()} (${formatDuration(deadlineAt - now)} from now).${wasParked ? " The task remains parked until you click Resume." : ""}`;
    const message = this.db.addMessage({ threadId, role: "director", kind: "system", content });
    this.hub.publish({ type: "thread.message", threadId, message });
    this.hub.log("info", `${content} [${threadId.slice(0, 8)}]`);
    return { ok: true, state: updated.state, message: content };
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
    // Tallied so the boot leaves one greppable line saying what it did to the previous process's work —
    // see logRestartReconcile. Without it, "did that bounce eat something?" is a cross-table reconstruction.
    const tally = { runs: 0, resumed: 0, revived: 0, gaveUp: 0, reParked: 0, handedBack: 0, settled: 0, requeued: 0 };
    for (const r of this.db.listActiveRuns()) {
      this.db.updateRun(r.id, { state: "interrupted", endedAt: r.endedAt ?? at });
      tally.runs++;
    }
    // Safety net for the missed-cleanup path: a run left in a live state but already ended (endedAt set)
    // is a corrupted orphan `listActiveRuns` can't reach — a late agent event that resurrected a
    // finalized run's state to "running". The gnome strip draws it forever (it filters on state, not
    // endedAt), so a closed/done task keeps a phantom walking gnome across restarts. Enforce the
    // invariant that an ended run is terminal; keep its real end time.
    for (const r of this.db.listEndedButLiveStateRuns()) {
      this.db.updateRun(r.id, { state: "interrupted" });
    }
    // A reviewer claim is durable even though its process is not. Consume every orphan token BEFORE the
    // generic in-flight scan so `implementing` fix rounds and `awaiting_user` reviewer questions cannot be
    // mistaken for resumable pipeline work. No verdict survived atomically, so none may be accepted.
    for (const episode of this.db.listRunningAutoReviewEpisodes()) {
      const interrupted = this.db.getThread(episode.threadId);
      if (!interrupted) continue;
      const stage = this.db.getThreadStageOutputs(episode.threadId);
      const openQuestions = this.db.listOpenQuestions().filter((q) => q.threadId === episode.threadId);
      const reason = openQuestions.length
        ? `Auto-review was waiting for your answer when a server restart interrupted it: “${openQuestions[0]!.question}” No accepted verdict was recorded, so the task is parked for your review and will not relaunch automatically.`.slice(0, MAX_REVIEW_ERROR_LEN)
        : stage.reviewFixing
          ? REVIEW_FIX_INTERRUPTED_MSG
          : REVIEW_INTERRUPTED_MSG;
      for (const question of openQuestions) {
        this.db.answerQuestion(question.id, "(auto-review interrupted by a server restart; task parked for owner review)");
      }
      const reconciled = this.db.reconcileInterruptedAutoReview(episode.threadId, episode.claimToken!, reason);
      if (reconciled && reconciled.state === "review" && interrupted.state !== "review") tally.reParked++;
      if (stage.reviewFixing) this.db.updateThreadStageOutputs(episode.threadId, { reviewFixing: false });
    }
    // Before the scan below stamps THIS boot's promises: keep the ones an earlier boot made and couldn't.
    const strays = this.reviveStrandedAutoResumes(at);
    tally.revived = strays.revived;
    tally.gaveUp = strays.gaveUp;
    for (const t of this.db.listThreads()) {
      if (!IN_FLIGHT.has(t.state)) continue;
      // The auto-review lane is in-process: re-park it for a fresh click rather than resuming. That covers
      // its fix round too, which runs under 'implementing' (an auto-resume state) and would otherwise be
      // revived into the normal pipeline — re-entering the QA loop this episode had already left behind.
      const stage = this.db.getThreadStageOutputs(t.id);
      // The bonus self-improvement round holds an already-ACCEPTED task through 'qa' and then, once its
      // implementor is live, 'implementing' — both AUTO_RESUME states. Which one the bounce caught it in
      // doesn't matter, so this keys on the marker, not the state: settle the task where the pipeline was
      // about to put it either way. See SELF_IMPROVE_INTERRUPTED_MSG.
      if (stage.selfImproving) {
        this.db.updateThreadStageOutputs(t.id, { selfImproving: false });
        // The round's implementor may have been blocked on an ask_user; its resolver died with the
        // process, so close the question rather than leave one pending on a task nobody can resume.
        for (const q of this.db.listOpenQuestions()) {
          if (q.threadId === t.id) this.resolveQuestion(q.id, "(the self-improvement round was interrupted; the task itself is already complete)");
        }
        this.postFinding({ threadId: t.id, fromRole: "implementor", summary: SELF_IMPROVE_INTERRUPTED_MSG, severity: "info" });
        this.setState(t.id, "done");
        tally.settled++;
        continue;
      }
      const fixing = stage.reviewFixing;
      if (t.state === "reviewing" || fixing) {
        this.db.updateThreadStageOutputs(t.id, { reviewFixing: false });
        this.db.updateThread(t.id, { state: "review", error: fixing ? REVIEW_FIX_INTERRUPTED_MSG : REVIEW_INTERRUPTED_MSG });
        tally.reParked++;
        continue;
      }
      if (!AUTO_RESUME_STATES.has(t.state)) {
        // Was waiting on a person (question/approval/paused/intake) — leave it for a manual Resume.
        this.db.updateThread(t.id, { state: "failed", error: RESTART_FAILED_MSG });
        tally.handedBack++;
        continue;
      }
      const fastInterrupts = this.fastInterruptCount(t.id, at);
      if (fastInterrupts >= MAX_FAST_INTERRUPTS) {
        this.db.updateThread(t.id, { state: "failed", error: this.crashLoopMsg(fastInterrupts) });
        tally.handedBack++;
        continue;
      }
      // Route through the SAME resume-aware path as a manual Resume: 'failed' is that path's entry
      // state, and runPipeline skips already-finished stages and resumes the implementor session.
      // The persisted RESTART_AUTO_RESUME_MSG error is what startResumedImplementor reads (it survives
      // until the implementor relaunches) to flag this as a restart-triggered resume — so the worker is
      // told the restart already completed and must not restart the orchestrator, which it's a child of,
      // again, the loop these warnings exist for.
      // QA begins only after the implementor has stopped and its completed work is durable. A restart
      // here must retry that charged review directly, not relaunch the implementor and duplicate work.
      if (t.state === "qa") {
        if (stage.qaFixHandoff) {
          this.qaFixHandoff.add(t.id);
        } else {
          this.db.updateThreadStageOutputs(t.id, { qaInterruptedRetryRound: Math.max(1, stage.qaRoundsUsed ?? 0) });
        }
      }
      this.db.updateThread(t.id, { state: "failed", error: RESTART_AUTO_RESUME_MSG });
      // A fresh interruption is a fresh episode: what the budget below counts is how many boots in a row
      // failed to get THIS interruption's resume airborne, not how many the task has survived in its life.
      this.db.updateThreadStageOutputs(t.id, { autoResumeRevivals: 0 });
      this.scheduleAutoResume(t.id, t.title);
      tally.resumed++;
    }
    // Re-arm any task left 'queued' by the restart: the in-memory dispatch queue starts empty, so
    // without this they'd wait forever. Deferred like the auto-resumes so the listeners are up first;
    // enqueueOrRun re-queues or starts each depending on the live concurrency cap.
    const queued = this.db.listThreads().filter((t) => t.state === "queued");
    if (queued.length) {
      tally.requeued = queued.length;
      setTimeout(() => {
        // Re-check state at fire time — a queued task could have been cancelled/dismissed during the
        // delay, and enqueueOrRun would otherwise stamp it 'queued' again (resurrecting a dead row).
        for (const t of queued) if (this.db.getThread(t.id)?.state === "queued") this.enqueueOrRun(t.id);
      }, AUTO_RESUME_DELAY_MS);
    }
    const touched = Object.entries(tally).filter(([, n]) => n > 0);
    this.bootReconcile = touched.length ? touched.map(([k, n]) => `${k}=${n}`).join(" ") : null;
  }

  /** An auto-resume the PREVIOUS process promised but never delivered — it schedules the resume in memory,
   *  so a second bounce inside that window took it down with the process, leaving a task stamped 'failed'
   *  that markInterrupted's IN_FLIGHT scan will never look at again. The persisted RESTART_AUTO_RESUME_MSG
   *  outlives the process and no other path writes it, so it is exactly the record that a resume is still
   *  owed: re-arm from it. (2026-08-08: two tasks, one of them the nightly sweep itself, sat two days
   *  showing that promise with nothing coming back for them.) */
  private reviveStrandedAutoResumes(at: number): { revived: number; gaveUp: number } {
    const counts = { revived: 0, gaveUp: 0 };
    for (const t of this.db.listThreads()) {
      if (t.state !== "failed" || t.error !== RESTART_AUTO_RESUME_MSG) continue;
      const attempt = (this.db.getThreadStageOutputs(t.id).autoResumeRevivals ?? 0) + 1;
      const giveUp = this.revivalGiveUpMsg(t, attempt, at);
      if (giveUp) {
        // Stop claiming a resume is coming — the promise in the error is what a person reads.
        this.db.updateThread(t.id, { state: "failed", error: giveUp });
        counts.gaveUp++;
        continue;
      }
      this.db.updateThreadStageOutputs(t.id, { autoResumeRevivals: attempt });
      this.hub.log("warn", `Re-arming the auto-resume of "${t.title.slice(0, 48)}" (attempt ${attempt}) — a restart landed before the last one fired.`);
      this.scheduleAutoResume(t.id, t.title);
      counts.revived++;
    }
    return counts;
  }

  /** Why this stranded task should be handed to a person instead of re-armed again, or null to re-arm.
   *  `updatedAt` is when the promise was stamped — nothing touches it while a task sits stranded. */
  private revivalGiveUpMsg(t: Thread, attempt: number, at: number): string | null {
    const fastInterrupts = this.fastInterruptCount(t.id, at);
    if (fastInterrupts >= MAX_FAST_INTERRUPTS) return this.crashLoopMsg(fastInterrupts);
    if (at - t.updatedAt > MAX_STRANDED_AGE_MS) return RESTART_REVIVAL_STALE_MSG;
    if (attempt > MAX_STRANDED_REVIVALS) return RESTART_REVIVAL_SPENT_MSG;
    return null;
  }

  /** Implementor runs this task lost within seconds of starting, recently: a resume-then-die crash loop
   *  rather than progress. Long-lived interrupted runs got somewhere and don't count. */
  private fastInterruptCount(threadId: string, at: number): number {
    return this.db
      .listRuns(threadId)
      .filter(
        (r) =>
          r.role === "implementor" &&
          r.state === "interrupted" &&
          r.endedAt != null &&
          at - r.endedAt < RESTART_LOOP_WINDOW_MS &&
          r.endedAt - r.startedAt < CRASH_FAST_MS,
      ).length;
  }

  private crashLoopMsg(fastInterrupts: number): string {
    return `Auto-resume stopped — this task kept getting interrupted within seconds of resuming ${fastInterrupts}× (likely a crash loop, not progress). Click Resume to retry once the cause is fixed.`;
  }

  /** Defer the resume so the HTTP/WS listeners are up before agents respawn. Held in memory by design —
   *  reviveStrandedAutoResumes is what makes it survive a bounce landing inside the delay. */
  private scheduleAutoResume(id: string, title: string): void {
    setTimeout(() => {
      this.hub.log("warn", `Auto-resuming "${title.slice(0, 48)}" after a server restart.`);
      void this.resumeThread(id).catch((e) => this.hub.log("error", `Auto-resume of ${id.slice(0, 8)} failed: ${String(e)}`));
    }, AUTO_RESUME_DELAY_MS);
  }

  /** One shared workload estimate for account, provider, model-pool, and reset-wait decisions. */
  private capacityDemand(thread: Thread, role: Role, effort?: Effort): CapacityDemand {
    const plan = this.db.getThreadStageOutputs(thread.id).plan ?? undefined;
    const files = new Set(plan?.steps.flatMap((step) => step.files ?? []) ?? []);
    return demandForRole(role, {
      effort: role === "implementor" ? (effort ?? thread.effortOverride ?? plan?.effort) : undefined,
      stepCount: plan?.steps.length,
      fileCount: files.size,
      riskCount: plan?.risks.length,
      durationMs: thread.durationMs,
      deadlineAt: thread.deadlineAt,
    });
  }

  private dispatchAccount(demand?: CapacityDemand): Acct {
    const { account } = this.accounts.select(demand);
    return { id: account.id, label: account.label, token: account.token || undefined };
  }

  /** A usable account other than `excludeId` for failover, or null if none has headroom. */
  private failoverAccount(excludeId: string, demand?: CapacityDemand): Acct | null {
    const a = this.accounts.selectFailover(excludeId, demand);
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
    // ZaiAgentRun extends AgentRun, so it must be checked before the "claude" fallback (Codex/Grok are
    // separate classes). z.ai is AgentRun-based but not a Claude account — this identity is what routes
    // its cap through the provider-flip path instead of a Claude-account failover.
    return agent instanceof CodexAgentRun
      ? "codex"
      : agent instanceof GrokAgentRun
        ? "grok"
        : agent instanceof ZaiAgentRun
          ? "zai"
          : "claude";
  }

  /** Only a zero-event FRESH process is evidence that the provider is unhealthy. A resume wedge belongs
   * to one saved CLI session; both CLI runners can discard that session and retry from workspace state. */
  private isProviderStartupWedge(agent: AgentRunLike): boolean {
    return agent.startupWedged === true && agent.startupWedgeScope !== "session";
  }

  private providerStartupCooldownKey(provider: ImplementorProvider): string {
    return `provider_startup_cooldown_${provider}_until`;
  }

  /** A startup watchdog means the backend itself failed before the task reached a model. Persist a short
   *  quarantine so concurrent/new tasks cannot pile onto the same wedged CLI while this task fails over. */
  private quarantineStartupWedge(provider: ImplementorProvider, reason?: string): void {
    const until = Date.now() + config.providerStartupCooldownMs;
    this.db.kvSet(this.providerStartupCooldownKey(provider), String(until));
    this.hub.log("warn", `${providerLabel(provider)} startup wedged — quarantined for ${Math.ceil(config.providerStartupCooldownMs / 60_000)}m. ${reason ?? ""}`.trim());
  }

  private providerStartupCooldownUntil(provider: ImplementorProvider, now = Date.now()): number | undefined {
    const key = this.providerStartupCooldownKey(provider);
    const until = Number(this.db.kvGet(key) ?? 0);
    if (!Number.isFinite(until) || until <= now) {
      if (until) this.db.kvSet(key, "0");
      return undefined;
    }
    return until;
  }

  private providerStartupCoolingDown(provider: ImplementorProvider, now = Date.now()): boolean {
    return this.providerStartupCooldownUntil(provider, now) != null;
  }

  private track(threadId: string, agent: AgentRunLike): void {
    let set = this.activeRuns.get(threadId);
    if (!set) {
      set = new Set();
      this.activeRuns.set(threadId, set);
    }
    set.add(agent);
    // The online office advertises this instance's live agents; re-publish the moment the set changes so
    // a teammate on another machine sees a new worker in seconds instead of at the next presence tick.
    this.online?.refreshPresence();
  }
  private untrack(threadId: string, agent: AgentRunLike): void {
    this.activeRuns.get(threadId)?.delete(agent);
    this.online?.refreshPresence();
  }

  // ---- OrchestratorApi: reads ----

  listThreads(): Thread[] {
    return this.db.listThreads();
  }
  getThread(id: string): Thread | null {
    return this.db.getThread(id);
  }

  /** What this boot did to the work the previous process left mid-flight (`runs=2 resumed=1 …`), or null
   *  if it found none. `index.ts` writes it to crash.log — the durable trail lives with the other
   *  process-lifecycle records, and constructing a manager in a test must not append to the real log. */
  bootReconcile: string | null = null;

  /** A one-line snapshot of what the pipeline is DOING right now — the live agent runs plus the running
   *  thread titles. Registered as a crash-context provider so a crash record shows the in-flight work
   *  (invaluable for telling "died while idle" from "died mid-heavy-task"). Cheap + never throws. */
  describeActiveWork(): string {
    let runs = 0;
    for (const set of this.activeRuns.values()) runs += set.size;
    const active = this.db
      .listThreads()
      .filter((t) => AUTO_RESUME_STATES.has(t.state))
      .map((t) => `${t.id.slice(0, 8)}[${t.state}]"${(t.title ?? "").slice(0, 40)}"`);
    return (
      `${runs} live agent run(s) across ${this.activeRuns.size} thread(s); ` +
      `${active.length} in-flight${active.length ? ": " + active.join(", ") : ""}`
    );
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
    const t = input.threadId ? this.db.getThread(input.threadId) : undefined;
    if (input.threadId && t && t.state !== "awaiting_user") {
      this.awaitingPrev.set(q.id, t.state);
      this.setState(input.threadId, "awaiting_user");
    }
    // The director asks questions of its own, with no task behind them — then the header IS the subject.
    this.notifyOwner(`🔔 needs you: ${input.header} — ${input.question}`, {
      kind: "input",
      title: t?.title ?? input.header,
      detail: t ? `${input.header} — ${input.question}` : input.question,
      repo: t?.workspace,
    });
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
    // Keep a requested window dormant while this task waits in the concurrency queue. Its absolute
    // deadline is stamped only when runPipeline actually claims a slot — queued time is not work time.
    const durationMs = input.durationMs && input.durationMs > 0 ? input.durationMs : null;
    const modelRequest = input.lane === "read"
      ? null
      : input.requestedModel?.trim()
        ? resolveModelRequest(input.requestedModel, this.modelRequestCandidates())
        : detectModelRequest(input.brief, this.modelRequestCandidates());
    const thread = this.db.createThread({
      title: input.title,
      workspace: input.workspace,
      rawPrompt: "",
      brief: input.brief,
      effortOverride: input.effort ?? null,
      modelRequest,
      lane: input.lane ?? null,
      durationMs,
      deadlineAt: null,
      agentCount: input.agentCount ?? null,
      parentId: input.parentId ?? null,
      assignment: input.assignment ?? null,
    });
    // Stamp the repo's HEAD NOW, before any agent runs — the "before" point for scoping this task's
    // Changes chip to its own diff. Captured pre-enqueue so a foreign commit that lands between here and
    // the implementor starting is still excluded (its files aren't in the task's written-file set). Null
    // when the workspace isn't a git repo; getTaskGitSummary then degrades to a HEAD-relative diff.
    this.db.setBaselineHead(thread.id, await getHeadSha(input.workspace).catch(() => null));
    if (input.images?.length) this.dispatchImages.set(thread.id, input.images.map(toImageBlock));
    this.hub.publish({ type: "thread.upsert", thread });
    if (modelRequest) this.announceModelRequest(thread, modelRequest);
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
      conciseAgentCommunication: this.settingBool("setting_concise_agent_communication", true),
      plannerEnabled: this.settingBool("setting_planner_enabled", true),
      researcherEnabled: this.settingBool("setting_researcher_enabled", true),
      qaEnabled: this.settingBool("setting_qa_enabled", true),
      differentProviderQa: this.settingBool("setting_different_provider_qa", false),
      qaAppliesFixes: this.settingBool("setting_qa_applies_fixes", false),
      autoPush: this.settingBool("setting_auto_push", true),
      directorName: this.directorName(),
      maxQaRounds: this.settingNum("setting_max_qa_rounds", config.maxQaRounds, 1, 12),
      maxReviewFixRounds: this.settingNum("setting_max_review_fix_rounds", config.maxReviewFixRounds, 0, 3),
      maxConcurrent: this.settingNum("setting_max_concurrent", config.maxConcurrent, 1, 20),
      maxConcurrentPerRepo: this.settingNum("setting_max_concurrent_per_repo", 0, 0, 20),
      selfImproveEnabled: this.settingBool("setting_self_improve_enabled", false),
      autoModelSelection: this.settingBool("setting_auto_model_selection", false),
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
      grokSignedIn: grokAuth.signedIn,
      grokAccount: grokAuth.email,
      zaiEnabled: this.settingBool("setting_zai_enabled", false),
      zaiModel: this.zaiModel(),
      zaiEffort: this.zaiEffort(),
      zaiWeeklySafetyPct: this.settingNum("setting_zai_weekly_safety", 100, 1, 100),
      zaiKeyPresent: !!this.zaiApiKey(),
      zaiKeyLast4: this.zaiKeyLast4(),
      zaiModels: this.pickableZaiModels(),
      discordNotify: this.settingBool("setting_discord_notify", false),
      discordChannelId: this.discordChannelId(),
      discordTokenPresent: !!this.discordBotToken(),
      discordTokenLast4: this.discordTokenLast4(),
      skipDirector: this.settingBool("setting_skip_director", false),
      taskDurationMinutes: this.settingNum("setting_task_duration_minutes", 0, 0, 7 * 24 * 60),
      taskAgentCount: this.settingNum("setting_task_agent_count", 1, 1, MAX_AGENTS),
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
      codexModelEfforts: Object.fromEntries(
        this.pickableCodexModels().map((model) => [model, [...this.codexSupportedEfforts(model)]]),
      ),
      grokModels: this.pickableGrokModels(),
      directorSupervisorEnabled: this.settingBool("setting_director_supervisor_enabled", false),
    };
  }

  /** Read at the moment a role/turn starts. A persisted toggle therefore applies to new work and warm
   *  resumes immediately; no prompt files or server process need rebuilding. */
  private communicationPolicyOptions(): { conciseCommunication: boolean } {
    return { conciseCommunication: this.settingBool("setting_concise_agent_communication", true) };
  }

  /** Prefix trusted wording policy without touching the owner/task payload or any structured schema. */
  private communicationContent(content: UserContent): UserContent {
    return withCommunicationTurnPolicy(
      content,
      this.settingBool("setting_concise_agent_communication", true),
    );
  }

  private sendCommunication(run: AgentRunLike, content: UserContent, opts?: SendOpts): void {
    run.send(this.communicationContent(content), opts);
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
    return this.poolResolved(subId, ov[subId]?.[role]?.trim() || ov[DEFAULT_SUB_ID]?.[role]?.trim() || config.models[role]);
  }

  /** A model whose OWN metered pool is exhausted on this sub (Fable's gated allowance) dispatches on its
   *  fallback until the pool frees — the sub's normal windows still have headroom, so neither parking the
   *  task nor switching accounts would be right. classifyCap latches the limit. Applies to an
   *  auto-selected model exactly as it does to a configured one. */
  private poolResolved(subId: string, model: string): string {
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
      if (subId === CODEX_SUB_ID || subId === GROK_SUB_ID || subId === ZAI_SUB_ID) continue; // non-Claude ids belong to their own lists
      for (const m of Object.values(roles)) if (m) selected.push(m);
    }
    return uniq([...this.modelCatalog.claudeModels(), ...CURATED_CLAUDE_MODELS, ...Object.values(config.models), ...selected]);
  }

  /** Pickable Codex model ids for the Settings dropdown: curated flagships first, then any additional
   *  models the ACTIVE auth mode exposes, plus the currently-selected model so a manual pin never vanishes. */
  private pickableCodexModels(): string[] {
    const selected = [this.codexModel(), ...Object.values(this.modelOverrides()[CODEX_SUB_ID] ?? {})].filter((x): x is string => !!x);
    return uniq([...this.codexRosterModels(), ...selected]);
  }

  /** Models this running installation can name without guessing. Live provider catalogs are preferred;
   * configured selections remain valid cold-start candidates, and dedicated Codex pool labels supply
   * the canonical Spark mapping (the pool id itself is intentionally opaque). */
  private modelRequestCandidates(): ModelRequestCandidate[] {
    const out: ModelRequestCandidate[] = [];
    const add = (provider: ImplementorProvider, model: string | null | undefined, labels: Array<string | null | undefined> = []): void => {
      if (!model?.trim()) return;
      out.push({ provider, model: model.trim(), labels: labels.filter((label): label is string => !!label?.trim()) });
    };

    const claudeLive = this.modelCatalog.claudeModels();
    for (const model of claudeLive) add("claude", model);
    for (const account of config.accounts) add("claude", this.modelFor(account.id, "implementor"));
    add("claude", this.modelFor(DEFAULT_SUB_ID, "implementor"));

    const codexLive = chatgptLoginAvailable()
      ? this.modelCatalog.codexCliModels().map((entry) => entry.id)
      : this.modelCatalog.codexModels();
    for (const model of codexLive) add("codex", model);
    add("codex", this.codexModel());
    for (const pool of dedicatedPools(this.codexPoolSnapshot() ?? [])) {
      add("codex", pool.modelSlug, [pool.limitName]);
    }

    for (const model of this.modelCatalog.grokModels()) add("grok", model);
    add("grok", this.grokModel());
    for (const model of this.modelCatalog.zaiModels()) add("zai", model);
    add("zai", this.zaiModel());
    return out;
  }

  /** Legacy tasks may predate the Director bridge's model field. Detect their direct persisted brief
   * command lazily before any selection/spawn, persist it, and supersede a stale automatic pick. */
  private ensureThreadModelRequest(thread: Thread): Thread {
    const candidates = this.modelRequestCandidates();
    let request = thread.modelRequest ?? null;
    if (request && !request.model) {
      const resolved = resolveModelRequest(request.requested, candidates);
      if (resolved.model) request = resolved;
    } else if (!request && thread.lane !== "read") {
      request = detectModelRequest([thread.rawPrompt, thread.brief].filter(Boolean).join("\n"), candidates);
    }
    if (!request) return thread;
    if (
      thread.modelRequest &&
      thread.modelRequest.requested === request.requested &&
      thread.modelRequest.provider === request.provider &&
      thread.modelRequest.model === request.model
    ) return thread;

    const updated = this.db.setModelRequest(thread.id, request);
    if (!updated) return thread;
    // A legacy task may already hold the exact wrong auto-pick that exposed this bug. The strict owner
    // request owns the task now; retaining that pick would reintroduce it on resume.
    this.db.updateThreadStageOutputs(thread.id, { modelPick: undefined });
    this.hub.publish({ type: "thread.upsert", thread: updated });
    this.announceModelRequest(updated, request);
    return updated;
  }

  private announceModelRequest(thread: Thread, request: ModelRequest): void {
    const exact = request.model && request.provider
      ? `${request.model} on ${providerLabel(request.provider)}`
      : "not currently resolvable from the installed provider catalogs";
    this.postFinding({
      threadId: thread.id,
      fromRole: "director",
      summary: request.model
        ? `Strict model request pinned — ${request.model}`
        : `Strict model request recorded but unresolved — ${request.requested}`,
      detail: `Requested: ${request.requested}. Resolved: ${exact}. This task will wait or fail visibly if that exact model is unavailable; automatic routing and failover may not substitute another model.`,
      severity: request.model ? "info" : "warning",
    });
  }

  /** Every model the Codex runner's active auth can actually use. ChatGPT auth uses the CLI's own live
   * catalog; API-key auth uses `/v1/models`. Mixing them would offer models the active credential rejects. */
  private codexRosterModels(): string[] {
    if (chatgptLoginAvailable()) {
      const cli = this.modelCatalog.codexCliModels().map((model) => model.id);
      return cli.length ? cli : CURATED_CODEX_MODELS;
    }
    const live = this.modelCatalog.codexModels();
    return live.length ? live : CURATED_CODEX_MODELS;
  }

  /** Exact CLI-advertised tiers under ChatGPT auth; documented family fallbacks cover cold start and
   * API-key models, whose `/v1/models` response carries no effort-capability metadata. */
  private codexSupportedEfforts(model: string): readonly CodexEffort[] {
    return (chatgptLoginAvailable() ? this.modelCatalog.codexCliEfforts(model) : undefined) ?? codexEffortsForModel(model);
  }

  /** Pickable Grok model ids for the Settings dropdown: curated defaults first, then any additional models
   *  the CLI's local cache reports, plus the currently-selected Grok model. */
  private pickableGrokModels(): string[] {
    const selected = [this.grokModel(), ...Object.values(this.modelOverrides()[GROK_SUB_ID] ?? {})].filter((x): x is string => !!x);
    return uniq([...CURATED_GROK_MODELS, ...this.modelCatalog.grokModels(), ...selected]);
  }

  /** Pickable z.ai (GLM) model ids for the Settings dropdown: whatever the key can actually access,
   *  then the curated fallback and the current pick so a manual pin never vanishes. */
  private pickableZaiModels(): string[] {
    const selected = [this.zaiModel(), ...Object.values(this.modelOverrides()[ZAI_SUB_ID] ?? {})].filter((x): x is string => !!x);
    return uniq([...this.modelCatalog.zaiModels(), ...CURATED_ZAI_MODELS, ...selected]);
  }

  // ---- auto model selection (the "Auto model selection" setting) ----

  /** Every Claude model this subscription can access. The live endpoint is authoritative when present;
   *  curated + selected models are only the cold-start fallback before the first successful refresh. */
  private claudeRosterModels(): string[] {
    const live = this.modelCatalog.claudeModels();
    return live.length ? live : this.pickableClaudeModels();
  }

  private providerRoleModel(provider: ImplementorProvider, role: Role, accountId?: string): string {
    const ov = this.modelOverrides();
    if (provider === "claude") return this.modelFor(accountId ?? this.accounts.dispatchPreview().account.id, role);
    if (provider === "codex") return ov[CODEX_SUB_ID]?.[role]?.trim() || this.codexModel();
    if (provider === "grok") return ov[GROK_SUB_ID]?.[role]?.trim() || this.grokModel();
    return ov[ZAI_SUB_ID]?.[role]?.trim() || this.zaiModel();
  }

  /** Every backend/model the director may actually start on now. With `allModels`, expose the same
   *  capability roster as implementor auto-selection; otherwise return each provider's configured
   *  director model. A provider is present only when enabled, authenticated and under its live caps. */
  directorTargets(allModels = false): DirectorTarget[] {
    const out: DirectorTarget[] = [];
    const demand = demandForRole("director");
    const add = (provider: ImplementorProvider, accountId: string, accountLabel: string, models: string[], capacity: string): void => {
      for (const model of uniq(models).filter(Boolean)) {
        out.push({ key: `${provider}|${accountId}|${model}`, provider, accountId, accountLabel, model, capacity });
      }
    };
    const claude = this.accounts.dispatchPreview(demand);
    if (claude.hasHeadroom) {
      const models = allModels
        ? this.claudeRosterModels().map((m) => this.poolResolved(claude.account.id, m))
        : [this.providerRoleModel("claude", "director", claude.account.id)];
      const candidate = providerCandidateFromClaude(claude);
      for (const model of uniq(models)) {
        add("claude", claude.account.id, claude.account.label, [model], modelCapacityNote("claude", model, candidate, demand));
      }
    }
    const codexKey = this.openaiApiKey();
    if (this.settings().codexEnabled && codexAuthAvailable(!!codexKey && /^sk-/.test(codexKey))) {
      const pools = this.codexPoolSnapshot();
      const models = allModels
        ? this.codexRosterModels().filter((model) => !poolForModel(pools ?? [], model)?.modelSlug)
        : [this.providerRoleModel("codex", "director")];
      for (const model of uniq(models)) {
        const candidate = this.codexProviderCandidate("director", demand, model);
        if (candidate.hasHeadroom) {
          add("codex", "openai-codex", "Codex", [model], describeProviderCapacity(candidate, demand));
        }
      }
    }
    if (this.grokProviderReady()) {
      const live = this.modelCatalog.grokModels();
      const models = allModels
        ? (live.length ? live : this.pickableGrokModels())
        : [this.providerRoleModel("grok", "director")];
      const available = live.length ? models.filter((m) => live.includes(m)) : models;
      if (available.length) {
        const candidate = this.grokProviderCandidate(demand);
        add("grok", "xai-grok", "Grok", available, describeProviderCapacity(candidate, demand));
      }
    }
    if (this.zaiImplementorReady()) {
      const candidate = this.zaiProviderCandidate(demand);
      add("zai", "zai", "z.ai", allModels ? this.pickableZaiModels() : [this.providerRoleModel("zai", "director")], describeProviderCapacity(candidate, demand));
    }
    return out;
  }

  /** Is a previously-selected target still dispatchable? The director remains sticky while true; it
   *  reselects only on a provider/account cap, hard usage ceiling, or the operator disabling/removing
   *  that backend. */
  directorTargetReady(target: DirectorTarget): boolean {
    const demand = demandForRole("director");
    const candidate = this.directorCandidateForTarget(target, demand);
    if (!candidate.hasHeadroom) return false;
    if (target.provider === "grok") {
      const live = this.modelCatalog.grokModels();
      if (live.length && !live.includes(target.model)) return false;
    }
    if (assessCapacity(candidateCapacityWindows(candidate), demand).status !== "at-risk") return true;
    // A sticky target may keep a tight pool only when there is genuinely nowhere safer to move. This
    // preserves the long-lived director session while still shedding it before a viable alternative.
    return !this.directorTargets(true).some((alternative) => {
      if (alternative.key === target.key) return false;
      const other = this.directorCandidateForTarget(alternative, demand);
      return other.hasHeadroom && assessCapacity(candidateCapacityWindows(other), demand).status !== "at-risk";
    });
  }

  private directorCandidateForTarget(target: DirectorTarget, demand: CapacityDemand): ProviderCandidate {
    if (target.provider === "claude") {
      const option = this.claudeCapacityOptions(demand).find((entry) => entry.accountId === target.accountId);
      const dto = this.accounts.dto().find((entry) => entry.id === target.accountId);
      return {
        provider: "claude",
        hasHeadroom: option?.hasHeadroom ?? false,
        fiveHour: dto?.fiveHour ?? null,
        fiveHourReset: dto?.fiveHourReset ?? null,
        sevenDay: dto?.sevenDay ?? null,
        sevenDayReset: dto?.sevenDayReset ?? null,
        weeklySafetyPct: dto?.weeklySafetyPct ?? 100,
        capacityLabel: `Claude ${target.accountLabel}`,
        capacityWindows: option?.windows ?? [],
      };
    }
    if (target.provider === "codex") {
      const key = this.openaiApiKey();
      const candidate = this.codexProviderCandidate("director", demand, target.model);
      return {
        ...candidate,
        hasHeadroom:
          this.settings().codexEnabled &&
          codexAuthAvailable(!!key && /^sk-/.test(key)) &&
          candidate.hasHeadroom,
      };
    }
    if (target.provider === "grok") {
      const candidate = this.grokProviderCandidate(demand);
      return { ...candidate, hasHeadroom: this.settings().grokEnabled && grokAuthAvailable() && candidate.hasHeadroom };
    }
    const candidate = this.zaiProviderCandidate(demand);
    return { ...candidate, hasHeadroom: this.settings().zaiEnabled && !!this.zaiApiKey() && candidate.hasHeadroom };
  }

  /** Usage-aware deterministic fallback for the director and for bootstrapping the smart selector. */
  preferredDirectorTarget(targets = this.directorTargets(false)): DirectorTarget | undefined {
    if (!targets.length) return undefined;
    const demand = demandForRole("director");
    const pairs = targets.map((target) => ({ target, candidate: this.directorCandidateForTarget(target, demand) }));
    const chosen = this.preferredProviderCandidate(pairs.map((pair) => pair.candidate), demand);
    return pairs.find((pair) => pair.candidate === chosen)?.target ?? targets[0];
  }

  /** Honest no-target status for the chat director, using every enabled provider/model pool and only a
   * reset that would actually make one of them viable. */
  directorCapacityWaitMessage(now = Date.now()): string {
    const demand = demandForRole("director");
    const { options, ready, nextAt: next } = this.roleCapacitySnapshot("director", demand, now);
    const startupCooling = options.some((option) => option.windows.some((window) =>
      window.label === STARTUP_HEALTH_COOLDOWN_LABEL &&
      window.usedPct === 100 &&
      (window.resetAt == null || window.resetAt > now),
    ));
    const reset = ready.length
      ? ` ${ready.map((option) => option.label).join(", ")} has viable capacity now.`
      : next != null
        ? ` The next viable pool is expected ${formatUntil(next, now)} (${new Date(next).toLocaleString()}).`
        : " No reliable reset time is available yet; live meters are still polled.";
    const status = options.length
      ? ` Capacity checked: ${options.map((option) => describeRoutingCapacity(option, demand, now)).join("; ")}.`
      : " No enabled, authenticated provider is available.";
    const reason = ready.length
      ? "The prior director attempt stopped, but a compatible target is ready for a fresh turn."
      : startupCooling
        ? "A compatible director provider is temporarily unavailable during a startup health cooldown, so I couldn't complete this turn."
        : "Every enabled director target is usage-capped, lacks safe runway, or is unavailable, so I couldn't complete this turn.";
    const retry = ready.length ? "Resend now" : "Resend after capacity frees";
    return `${reason}${reset}${status} ${retry}; routing will reselect automatically.`;
  }

  /** Construct the concrete runner for a director target. Claude/z.ai retain the native MCP tools in
   *  `cfg`; Codex/Grok use the structured server-command bridge and a read-only director mode. */
  createDirectorAgent(
    target: DirectorTarget,
    cfg: AgentRunConfig,
    opts?: { resume?: string; cliSchema?: JsonSchemaLike },
  ): AgentRunLike {
    const resolved = { ...cfg, model: target.model };
    if (opts?.resume) resolved.resume = opts.resume;
    if (target.provider === "claude") {
      resolved.oauthToken = this.accounts.byId(target.accountId)?.token || undefined;
      return new AgentRun(resolved);
    }
    if (target.provider === "zai") {
      resolved.baseUrl = config.zai.baseUrl;
      resolved.authToken = this.zaiApiKey();
      return new ZaiAgentRun(resolved);
    }
    const cwd = join(config.dataDir, "director-sandbox");
    mkdirSync(cwd, { recursive: true });
    if (target.provider === "codex") {
      return new CodexAgentRun({
        model: target.model, effort: this.codexEffort(target.model), cwd,
        apiKey: this.openaiApiKey() ?? "", resume: opts?.resume,
        outputSchema: opts?.cliSchema, directorMode: true,
      });
    }
    return new GrokAgentRun({
      model: target.model, effort: this.grokEffort(target.model), cwd, resume: opts?.resume,
      outputSchema: opts?.cliSchema, directorMode: true,
    });
  }

  directorRunCapped(target: DirectorTarget, agent: AgentRunLike): boolean {
    if (target.provider === "codex" && agent instanceof CodexAgentRun) return agent.capped;
    if (target.provider === "grok" && agent instanceof GrokAgentRun) return agent.capped;
    return agent.rateLimited;
  }

  noteDirectorProviderCap(target: DirectorTarget): void {
    if (target.provider === "codex") this.noteCodexCap(undefined, target.model);
    else if (target.provider === "grok") this.noteGrokCap();
    else if (target.provider === "zai") this.noteZaiCap();
  }

  /** Resolve and construct one Co-worker turn through the same auth, model, account, effort, and
   * capacity machinery as implementation. The first Auto turn freezes its concrete target; every
   * later turn validates and resumes that exact provider/model instead of falling through failover. */
  prepareCoworkerRun(input: {
    session: CoworkSession;
    prompt: string;
    history: CoworkMessage[];
  }): PreparedCoworkRun | { error: string } {
    const { session, prompt, history } = input;
    const demand = demandForRole("implementor", { effort: session.effort ?? "high" });
    let provider = session.provider ?? session.requestedProvider ?? undefined;
    let model = session.model ?? session.requestedModel ?? undefined;

    // A requested or already-resolved target is an exact pin. Reuse the task model gate's catalog,
    // authentication, independently-metered pool, and runway checks without ever creating a task row.
    if (provider && model) {
      const at = Date.now();
      const strictThread: Thread = {
        id: `cowork:${session.id}`,
        title: session.name,
        state: "intake",
        workspace: session.workspace,
        brief: "",
        rawPrompt: "",
        modelRequest: { requested: model, provider, model, strict: true },
        createdAt: at,
        updatedAt: at,
      };
      const snapshot = this.requestedModelCapacitySnapshot(strictThread, demand, at);
      if (snapshot.error) return { error: snapshot.error.replace(/task/gi, "Co-work session") };
      if (!snapshot.ready.length) {
        const wait = snapshot.nextAt
          ? ` Expected capacity ${formatUntil(snapshot.nextAt, at)} (${new Date(snapshot.nextAt).toLocaleString()}).`
          : " No reliable reset time is available yet.";
        return { error: `${model} does not currently have enough safe capacity for a Co-worker turn.${wait} No substitute was started.` };
      }
      if (provider === "claude" && session.account) {
        const accountOption = this.claudeCapacityOptions(demand, at).find((option) => option.accountId === session.account);
        if (!accountOption) {
          return { error: "The Claude subscription linked to this Co-work context is no longer enabled. Restore that subscription or create a new session; no account was substituted." };
        }
        if (!this.roleCapacityReady(accountOption, demand, at)) {
          const reset = nextViableAt(accountOption.windows, demand, at);
          const wait = reset ? ` Try again ${formatUntil(reset, at)} (${new Date(reset).toLocaleString()}).` : " No reliable reset time is available yet.";
          return { error: `The Claude subscription linked to this Co-work context does not currently have enough safe capacity.${wait} No account or model was substituted.` };
        }
      }
    } else if (provider || model) {
      return { error: "The saved Co-work target is incomplete. Choose both a provider and model in a new session." };
    } else {
      const route = this.resolveImplementorProvider(demand);
      if (route.error || !route.provider) return { error: route.error ?? "No authenticated coding provider is available." };
      if (route.allCandidatesCapped || route.allKnownInsufficient) {
        return { error: "No enabled coding provider currently has enough safe capacity for this Co-worker turn. Try again after capacity resets." };
      }
      provider = route.provider;
    }

    try {
      const resume = session.agentSessionId ?? undefined;
      let target: CoworkTarget;
      let agent: AgentRunLike;
      let startContent: UserContent;

      if (provider === "claude") {
        const account = session.account ? this.acctById(session.account) : this.dispatchAccount(demand);
        if (!account) return { error: "The Claude subscription linked to this Co-work context is unavailable. Restore it or create a new session; no account was substituted." };
        model ??= this.modelFor(account.id, "implementor");
        const requestedEffort = session.effort ?? "high";
        const effort = resolveClaudeEffort(model, clampEffort(requestedEffort, this.accountMaxEffort(account.id)));
        const cfg = coworkerRunOptions(session.workspace, {
          resume,
          effort,
          ...this.communicationPolicyOptions(),
        });
        cfg.model = model;
        cfg.oauthToken = account.token;
        target = { provider, model, effort, accountId: account.id, accountLabel: account.label };
        agent = new AgentRun(cfg);
        startContent = this.communicationContent(prompt);
      } else if (provider === "codex") {
        model ??= this.codexModel();
        const effort = (session.effort ?? this.codexEffort(model)) as CodexEffort;
        target = { provider, model, effort, accountId: "openai-codex", accountLabel: `codex:${model}` };
        const fresh = coworkFreshKickoff(history, prompt);
        agent = new CodexAgentRun({
          model,
          effort,
          cwd: session.workspace,
          apiKey: this.openaiApiKey() ?? "",
          resume,
          freshFallback: this.communicationContent(fresh),
        });
        startContent = this.communicationContent(resume ? prompt : [COWORKER_PROMPT, prompt].join("\n\n"));
      } else if (provider === "grok") {
        model ??= this.grokModel();
        const effort = (session.effort ?? this.grokEffort(model)) as GrokEffort;
        target = { provider, model, effort, accountId: "xai-grok", accountLabel: `grok:${model}` };
        const fresh = coworkFreshKickoff(history, prompt);
        agent = new GrokAgentRun({
          model,
          effort,
          cwd: session.workspace,
          resume,
          freshFallback: this.communicationContent(fresh),
        });
        startContent = this.communicationContent(resume ? prompt : [COWORKER_PROMPT, prompt].join("\n\n"));
      } else {
        model ??= this.zaiModel();
        const effort = session.effort ?? this.zaiEffort();
        const cfg = coworkerRunOptions(session.workspace, {
          resume,
          effort,
          ...this.communicationPolicyOptions(),
        });
        cfg.model = model;
        cfg.baseUrl = config.zai.baseUrl;
        cfg.authToken = this.zaiApiKey();
        target = { provider: "zai", model, effort, accountId: "zai", accountLabel: `zai:${model}` };
        agent = new ZaiAgentRun(cfg);
        startContent = this.communicationContent(prompt);
      }
      return { target, agent, startContent };
    } catch (error) {
      return { error: `Could not start the Co-worker: ${(error as Error).message || String(error)}` };
    }
  }

  coworkObserveRateLimit(target: CoworkTarget, info: RateLimitInfo): void {
    if (target.provider === "claude" && target.accountId) this.accounts.updateFromRateLimit(target.accountId, info);
  }

  coworkRunCapped(target: CoworkTarget, agent: AgentRunLike): boolean {
    if (target.provider === "codex" && agent instanceof CodexAgentRun) return agent.capped;
    if (target.provider === "grok" && agent instanceof GrokAgentRun) return agent.capped;
    return agent.rateLimited;
  }

  coworkNoteCap(target: CoworkTarget, agent: AgentRunLike): void {
    if (target.provider === "codex") this.noteCodexCap(agent.rateLimitInfo, target.model);
    else if (target.provider === "grok") this.noteGrokCap(agent.rateLimitInfo);
    else if (target.provider === "zai") this.noteZaiCap(agent.rateLimitInfo);
    else if (target.accountId) {
      // Preserve the account/model pool classification for future normal routing, but intentionally do
      // not relaunch this turn: Co-work failures always hand control back to the owner.
      void this.accounts.classifyCap(target.accountId, target.model, agent.rateLimitInfo).catch(() => {});
    }
  }

  /** One no-tools structured judgement call on whichever provider currently has headroom. This is the
   *  shared escape from the old hidden Anthropic dependency: both auto-selectors work while Claude is capped. */
  async askDirectorJson(prompt: string, schema: JsonSchemaLike, judge?: DirectorTarget): Promise<unknown | null> {
    const target = judge ?? this.preferredDirectorTarget();
    if (!target) return null;
    mkdirSync(join(config.dataDir, "director-sandbox"), { recursive: true });
    const cfg: AgentRunConfig = {
      model: target.model,
      cwd: join(config.dataDir, "director-sandbox"),
      systemPrompt: "Return only the requested structured answer. Do not use tools or inspect files.",
      permissionMode: "plan",
      allowedTools: [],
      disallowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "NotebookEdit", "Bash", "AskUserQuestion"],
      settingSources: [],
      outputFormat: { type: "json_schema", schema: schema as Record<string, unknown> },
      includePartialMessages: false,
      maxTurns: 2,
    };
    const agent = this.createDirectorAgent(target, cfg, { cliSchema: schema });
    const off = agent.onEvent((e) => {
      if (e.type === "rate_limit" && target.provider === "claude") this.accounts.updateFromRateLimit(target.accountId, e.info);
    });
    agent.start(`${prompt}\n\nReturn exactly one JSON object matching the supplied schema.`);
    const result = await agent.result().catch(() => undefined);
    off();
    await agent.stop().catch(() => {});
    if (this.directorRunCapped(target, agent)) this.noteDirectorProviderCap(target);
    return result && !result.isError ? result.structuredOutput ?? null : null;
  }

  /** The Director Supervisor's own cheap bounded judgement call — same no-tools, capacity-aware shape as
   *  askDirectorJson (including cross-provider fallback via preferredDirectorTarget), but additionally
   *  reports what it cost so the supervisor can keep a visible, bounded budget. Kept as its own method
   *  (rather than widening askDirectorJson's return shape) so every other caller's contract is untouched. */
  async supervisorJudge(prompt: string, schema: JsonSchemaLike): Promise<SupervisorJudgement | null> {
    const target = this.preferredDirectorTarget();
    if (!target) return null;
    const conciseCommunication = this.settingBool("setting_concise_agent_communication", true);
    mkdirSync(join(config.dataDir, "director-sandbox"), { recursive: true });
    const cfg: AgentRunConfig = {
      model: target.model,
      cwd: join(config.dataDir, "director-sandbox"),
      systemPrompt: withCommunicationSystemPolicy(
        "Return only the requested structured answer. Do not use tools or inspect files.",
        conciseCommunication,
      ),
      permissionMode: "plan",
      allowedTools: [],
      disallowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "NotebookEdit", "Bash", "AskUserQuestion"],
      settingSources: [],
      outputFormat: { type: "json_schema", schema: schema as Record<string, unknown> },
      includePartialMessages: false,
      maxTurns: SUPERVISOR_JUDGE_MAX_TURNS,
    };
    const agent = this.createDirectorAgent(target, cfg, { cliSchema: schema });
    const off = agent.onEvent((e) => {
      if (e.type === "rate_limit" && target.provider === "claude") this.accounts.updateFromRateLimit(target.accountId, e.info);
    });
    agent.start(withCommunicationTurnPolicy(
      `${prompt}\n\nReturn exactly one JSON object matching the supplied schema.`,
      conciseCommunication,
    ));
    const result = await agent.result().catch(() => undefined);
    off();
    await agent.stop().catch(() => {});
    if (this.directorRunCapped(target, agent)) this.noteDirectorProviderCap(target);
    if (!result || result.isError) return null;
    return {
      output: result.structuredOutput ?? null,
      costUsd: result.costUsd ?? 0,
      tokenUsage: result.tokenUsage,
      model: target.model,
      provider: target.provider,
    };
  }

  /** Smart director choice: one judgement for the stable director job, then Director persists the key
   *  and reuses it until that target caps. A malformed/failed judgement falls back to usage-aware routing. */
  async autoSelectDirectorTarget(excludeKeys: ReadonlySet<string> = new Set()): Promise<DirectorTarget | undefined> {
    await this.liveBench.prepareForSelection();
    const targets = this.directorTargets(true).filter((t) => !excludeKeys.has(t.key));
    if (targets.length <= 1) return targets[0];
    const judge = this.preferredDirectorTarget(targets);
    const prompt = [
      `Choose the best model to be ${config.ownerName}'s long-lived orchestrator director.`,
      "The director must understand rough requests, interpret screenshots, ask only useful questions, enrich precise coding briefs, and reliably dispatch/steer tasks. Pick the least expensive model you trust to do that unattended. This is one sticky choice, not a per-task choice.",
      "Available targets:",
      ...targets.map((t) => {
        const benchmark = this.liveBench.note(t.model);
        return `- key=${t.key} — ${providerLabel(t.provider)} ${t.model}${t.provider === "codex" || t.provider === "grok" ? " (structured command bridge)" : " (native director tools)"}${t.capacity ? `\n  ${t.capacity}` : ""}${benchmark ? `\n  ${benchmark}` : ""}`;
      }),
      "LiveBench is a secondary capability prior, not an availability signal. Prefer exact-model evidence over an older family prior; local task outcomes and native-tool fit beat a small benchmark gap.",
      "Reply with the exact key.",
    ].join("\n");
    const picked = await this.askDirectorJson(prompt, DIRECTOR_PICK_SCHEMA, judge) as { key?: unknown } | null;
    const stillReady = targets.filter((t) => this.directorTargetReady(t));
    const target = typeof picked?.key === "string" ? stillReady.find((t) => t.key === picked.key) : undefined;
    return target ?? this.preferredDirectorTarget(stillReady);
  }

  /** Every (provider, model) pair a task could ACTUALLY be dispatched to right now — each backend that is
   *  enabled, authed and not usage-capped, with the models its own picker offers. A roster built from
   *  anything looser would let the selector choose a backend that then can't run. */
  private implementorModelRoster(demand: CapacityDemand = demandForRole("implementor")): ModelCandidate[] {
    interface RosterEntry {
      provider: ImplementorProvider;
      model: string;
      efforts: Effort[];
      candidate: ProviderCandidate;
    }
    const entries: RosterEntry[] = [];
    const add = (
      provider: ImplementorProvider,
      models: string[],
      effortsFor: (model: string) => Effort[],
      candidateFor: (model: string) => ProviderCandidate,
    ): void => {
      for (const model of uniq(models)) {
        const candidate = candidateFor(model);
        if (candidate.hasHeadroom) entries.push({ provider, model, efforts: effortsFor(model), candidate });
      }
    };
    const underCap = (supported: readonly Effort[], cap: Effort): Effort[] =>
      supported.filter((effort) => EFFORTS.indexOf(effort) <= EFFORTS.indexOf(cap) && (effort !== "xhigh" || config.enableXhigh));
    if (this.accounts.hasHeadroom()) {
      const claude = this.claudeProviderCandidate(demand);
      const cap = this.accountMaxEffort(this.accounts.dispatchPreview(demand).account.id);
      add("claude", this.claudeRosterModels(), (model) => underCap(claudeEffortsForModel(model), cap), () => claude);
    }
    if (this.codexImplementorReady("implementor", demand)) {
      const pools = this.codexPoolSnapshot();
      // Dedicated one-shot models are intentionally excluded from implementation; see codexPools.ts.
      const models = this.codexRosterModels().filter((model) => !poolForModel(pools ?? [], model)?.modelSlug);
      add(
        "codex",
        models,
        (model) => underCap(this.codexSupportedEfforts(model), this.codexEffort(model)),
        (model) => this.codexProviderCandidate("implementor", demand, model),
      );
    }
    if (this.grokImplementorReady()) {
      const live = this.modelCatalog.grokModels();
      const models = live.length ? this.pickableGrokModels().filter((model) => live.includes(model)) : this.pickableGrokModels();
      const grok = this.grokProviderCandidate(demand);
      const routedGrok = grok.hasHeadroom ? grok : { ...grok, hasHeadroom: true, capacityWindows: [] };
      add("grok", models, (model) => underCap(grokEffortsForModel(model), this.grokEffort(model)), () => routedGrok);
    }
    if (this.zaiImplementorReady()) {
      const live = this.modelCatalog.zaiModels();
      const models = live.length ? this.pickableZaiModels().filter((model) => live.includes(model)) : this.pickableZaiModels();
      const zai = this.zaiProviderCandidate(demand);
      const routedZai = zai.hasHeadroom ? zai : { ...zai, hasHeadroom: true, capacityWindows: [] };
      add("zai", models, () => underCap(ZAI_EFFORTS, this.zaiEffort()), () => routedZai);
    }
    const capacity = preferCapacity(entries, (entry) => candidateCapacityWindows(entry.candidate), demand);
    if (demand.substantial && capacity.allKnownAtRisk) return [];
    const hasKnownViable = entries.some((entry) => assessCapacity(candidateCapacityWindows(entry.candidate), demand).status === "viable");
    // Unknown is still a real dispatchable pool (notably API-key Codex and a provider before its first
    // free meter read). Keep it visible to the smart selector with an explicit warning; only known-risk
    // models are removed when a viable option exists.
    const selected = hasKnownViable
      ? entries.filter((entry) => assessCapacity(candidateCapacityWindows(entry.candidate), demand).status !== "at-risk")
      : capacity.candidates;
    return selected.map((entry) => {
      const benchmark = this.liveBench.note(entry.model);
      return {
        provider: entry.provider,
        model: entry.model,
        efforts: entry.efforts,
        note: [modelNote(entry.provider, entry.model), benchmark].filter(Boolean).join(". "),
        capacity: modelCapacityNote(entry.provider, entry.model, entry.candidate, demand),
      };
    });
  }

  /** Union of the exact per-candidate effort sets, kept in canonical low→ultra order for the JSON schema. */
  private selectableEfforts(candidates: ModelCandidate[]): Effort[] {
    return EFFORTS.filter((effort) => candidates.some((candidate) => candidate.efforts.includes(effort)));
  }

  /**
   * Choose the implementor model + effort for one task. Runs once per episode, just before the implementor
   * stage, and persists the pick on the thread's stage outputs — a resume must land on the SAME backend
   * (session ids are provider-specific), and the grade written at settle has to name what was chosen.
   * Returns undefined when the setting is off or no usable pick came back, leaving normal usage-based
   * routing and the planner's effort in charge; a dispatch is never blocked by this.
   */
  private async autoSelectModel(thread: Thread, plan?: PlanOutput): Promise<ModelPick | undefined> {
    // A task-local owner pin is not a candidate for automatic judgement. It remains exact across every
    // resume/cap cycle and must never be overwritten by a cheaper/stronger model recommendation.
    if (this.db.getThread(thread.id)?.modelRequest) return undefined;
    if (!this.settings().autoModelSelection) return undefined;
    const saved = this.db.getThreadStageOutputs(thread.id).modelPick;
    if (saved) return saved; // already picked for this episode (a resume) — never re-decide mid-task
    if (saved === null) return undefined; // an earlier attempt already failed; don't pay for it twice
    await this.liveBench.prepareForSelection();
    const demand = this.capacityDemand(thread, "implementor", thread.effortOverride ?? plan?.effort);
    const candidates = this.implementorModelRoster(demand);
    // An empty roster means no backend is dispatchable/has safe runway for this workload RIGHT NOW — a
    // transient capacity state the cap-park protocol is about to wait out, not a selection attempt that
    // failed. Latching `null` below would silently disable auto-selection for the rest of the episode,
    // so the task would come back from its capacity park on the configured default model instead.
    if (!candidates.length) {
      this.hub.log("warn", `Auto model selection found no dispatchable model with safe runway for ${thread.id.slice(0, 8)} — using the configured model; it will re-select if this task resumes with capacity.`);
      return undefined;
    }
    const workspace = normalizeWorkspace(thread.workspace);
    const selection = {
      title: thread.title,
      workspace: thread.workspace,
      brief: thread.brief,
      planText: planDigest(plan),
      candidates,
      efforts: this.selectableEfforts(candidates),
      repoStats: this.db.modelStats(workspace),
      globalStats: this.db.modelStats(),
      repoEffortStats: this.db.modelEffortStats(workspace),
      globalEffortStats: this.db.modelEffortStats(),
    };
    let pick: ModelPick | null = null;
    if (candidates.length === 1) {
      const only = candidates[0]!;
      pick = { provider: only.provider, model: only.model, effort: defaultCandidateEffort(only), reason: "only dispatchable model" };
    } else if (candidates.length > 1) {
      const schema = {
        type: "object", additionalProperties: false, required: ["model", "effort", "reason"],
        properties: {
          model: { type: "string" },
          effort: { type: "string", enum: selection.efforts },
          reason: { type: "string" },
        },
      };
      const raw = await this.askDirectorJson(buildSelectionPrompt(selection), schema).catch(() => null);
      pick = raw ? parseSelection(JSON.stringify(raw), selection) : null;
    }
    pick = await Promise.resolve(pick).catch((e) => {
      this.hub.log("warn", `Auto model selection failed on ${thread.id.slice(0, 8)}: ${String(e)}`);
      return null;
    });
    this.db.updateThreadStageOutputs(thread.id, { modelPick: pick ?? null });
    if (!pick) {
      this.hub.log("warn", `Auto model selection produced no usable pick for ${thread.id.slice(0, 8)} — using the configured model and the planner's effort.`);
      return undefined;
    }
    this.db.recordModelSelection({
      threadId: thread.id,
      workspace,
      title: thread.title,
      provider: pick.provider,
      model: pick.model,
      effort: pick.effort,
      reason: pick.reason,
    });
    this.hub.log("info", `Auto model selection for ${thread.id.slice(0, 8)}: ${pick.model} @ ${pick.effort} (${providerLabel(pick.provider)}) — ${pick.reason || "no reason given"}`);
    this.postFinding({
      threadId: thread.id,
      fromRole: "director",
      summary: `Auto-selected ${pick.model} at ${pick.effort} effort for this task`,
      detail: [
        pick.reason,
        `Capacity target: ${demandSummary(demand)}.`,
        candidates.find((candidate) => candidate.provider === pick.provider && candidate.model === pick.model)?.capacity,
        `Considered: ${candidates.map((c) => c.model).join(", ")}.`,
        this.liveBench.note(pick.model) ? `Benchmark evidence used: ${this.liveBench.note(pick.model)}.` : undefined,
      ].filter(Boolean).join("\n\n"),
      severity: "info",
    });
    return pick;
  }

  /** The auto-selected model for this thread when the run is going to `provider`. A cap-failover onto
   *  another backend leaves the pick behind and uses that backend's own configured model — a Claude model
   *  id means nothing to the Codex CLI. */
  private pickedModel(threadId: string, provider: ImplementorProvider): string | undefined {
    const requested = this.db.getThread(threadId)?.modelRequest;
    if (requested?.model && requested.provider === provider) return requested.model;
    const pick = this.db.getThreadStageOutputs(threadId).modelPick;
    return pick && pick.provider === provider ? pick.model : undefined;
  }

  /** The implementor's effort for this task: an operator pin beats everything, then the auto-selected
   *  effort, then the planner's per-task judgement. */
  private implementorEffort(threadId: string, planEffort?: Effort): Effort | undefined {
    const thread = this.db.getThread(threadId);
    return thread?.effortOverride ?? this.db.getThreadStageOutputs(threadId).modelPick?.effort ?? planEffort;
  }

  /** Which backend an auto-picked task routes to. The pick owns the decision — that IS the feature — but
   *  only while its backend can still take the work with the reserve used for final dispatch. A pool that
   *  capped or lost safe runway since selection falls back to current usage-aware routing. */
  private routeForPick(threadId: string, routed: ImplementorProvider, demand: CapacityDemand): ImplementorProvider {
    const pick = this.db.getThreadStageOutputs(threadId).modelPick;
    if (!pick || pick.provider === routed) return routed;
    const pickedCandidate = this.readyRoleCandidates("implementor", demand).find((candidate) => candidate.provider === pick.provider);
    const pickedCapacity = pickedCandidate ? assessCapacity(candidateCapacityWindows(pickedCandidate), demand) : undefined;
    if (!pickedCandidate || (demand.substantial && pickedCapacity?.status === "at-risk")) {
      const why = !pickedCandidate ? "can't take the task now" : "no longer has enough safe quota runway";
      this.hub.log("warn", `Auto-selected ${providerLabel(pick.provider)} for ${threadId.slice(0, 8)} ${why} — routing to ${providerLabel(routed)} on its own model.`);
      return routed;
    }
    return pick.provider;
  }

  /**
   * Close the loop: score a settled auto-picked task and rebroadcast the scoreboard the NEXT selection
   * reads. Silent for every task that wasn't auto-picked, and for endings that say nothing about the model
   * (see gradeSettledTask). A task that settles twice — parked for review, then resumed to done — is
   * re-graded in place, so the final record describes how it actually ended.
   */
  private gradeAutoSelectedModel(thread: Thread): void {
    if (!outcomeOfState(thread.state)) return;
    const pending = this.db.getModelGrade(thread.id);
    if (!pending) return;
    const patch = gradeSettledTask({
      state: thread.state,
      runs: this.db.listRuns(thread.id),
      qaRounds: this.db.getThreadStageOutputs(thread.id).qaRoundsUsed ?? 0,
      dispatchedAt: pending.createdAt,
      settledAt: Date.now(),
      capParked: (thread.error ?? "").startsWith(CAP_PARK_PREFIX),
      restartInterrupted: (thread.error ?? "").startsWith(RESTART_ERROR_PREFIX),
    });
    if (!patch) return;
    const first = pending.gradedAt == null;
    this.db.gradeModelSelection(thread.id, patch);
    this.hub.publish({ type: "model.stats", stats: this.db.modelStats() });
    // Announce the first verdict only: a re-grade is the same task saying the same thing again.
    if (!first || patch.score == null) return;
    this.postFinding({
      threadId: thread.id,
      fromRole: "director",
      summary: `Auto-selected ${pending.model} scored ${patch.score}/100 on this task`,
      detail: `Outcome: ${patch.outcome}. QA rounds: ${patch.qaRounds}. Cost: $${patch.costUsd.toFixed(2)} over ${patch.numTurns} turns and ${formatTokenCount(patch.tokenUsage?.totalTokens)}${patch.tokenUsage && !patch.tokenUsageComplete ? " partially measured" : ""} tokens, ${Math.round(patch.durationMs / 60_000)} min.${patch.gradedModel ? "" : ` Ran on more than one model (${patch.ranModels}), so it doesn't count toward any model's average.`}`,
      severity: "info",
    });
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

  /** The Codex CLI effort cap, normalized to the selected model's live accepted range. */
  private codexEffort(model = this.codexModel()): CodexEffort {
    const v = this.db.kvGet("setting_codex_effort")?.trim();
    const supported = this.codexSupportedEfforts(model);
    const requested = CODEX_EFFORTS.includes(v as CodexEffort) ? (v as CodexEffort) : supported.at(-1)!;
    return resolveCodexEffort(model, requested, supported);
  }

  // ---- Codex capacity pools (the plan's independently-metered allowances) ----

  /** The live per-pool meters, or null when no fresh app-server ping has landed. Null is fail-CLOSED
   *  everywhere below: without a reading we route exactly as before rather than gamble a run on an
   *  allowance we cannot see. */
  private codexPoolSnapshot(): CodexPool[] | null {
    return codexPools();
  }

  /**
   * The Codex model this ROLE should run on. A bounded role (reader/planner/researcher) is moved onto a
   * model with its own dedicated allowance whenever that pool is visible, un-latched and has headroom —
   * spending capacity that is otherwise wasted while the general pool burns down. Every other role, and
   * every case where we can't see a usable pool, gets the configured Codex model unchanged.
   *
   * Restricted to the roles in DEDICATED_POOL_ROLES on capability grounds, not to save quota: see
   * `codexPools.ts` for why a model instructed never to verify its own work must not be an implementor
   * or a reviewer.
   */
  private codexRoleModel(role: Role, demand?: CapacityDemand): string {
    const configured = this.providerRoleModel("codex", role);
    if (!roleMayUseDedicatedPool(role)) return configured;
    const pools = this.codexPoolSnapshot();
    if (!pools) return configured;
    // An explicit per-role override in the model matrix is the operator's decision — never override it.
    if (this.modelOverrides()[CODEX_SUB_ID]?.[role]?.trim()) return configured;
    const pick = dedicatedPoolModel({
      pools,
      role,
      now: Date.now(),
      dispatchable: this.codexRosterModels(),
      capLatches: this.poolCapUntil,
      demand,
    });
    return pick ?? configured;
  }

  /** Restore the persisted per-pool cap latches on boot (mirrors loadCodexCap for the general pool). */
  private loadPoolCaps(): void {
    const raw = this.db.kvGet(POOL_CAP_KV_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [limitId, until] of Object.entries(parsed)) {
        if (Number.isFinite(until) && until > now) this.poolCapUntil.set(limitId, until);
      }
    } catch {
      /* corrupt latch blob — start clean rather than crash the boot */
    }
  }

  private persistPoolCaps(): void {
    const now = Date.now();
    const live: Record<string, number> = {};
    for (const [limitId, until] of this.poolCapUntil) if (until > now) live[limitId] = until;
    this.db.kvSet(POOL_CAP_KV_KEY, Object.keys(live).length ? JSON.stringify(live) : "");
  }

  /**
   * Latch ONE dedicated pool as capped. Deliberately separate from the general Codex latch: the pools
   * have independent allowances and independent resets, so folding a Spark 429 into `codexCapUntil`
   * would disable a general pool that still had most of its week left (and the reverse would strand
   * idle Spark capacity behind an exhausted general pool). Returns false when the model has no
   * dedicated pool, so the caller falls through to the general latch.
   */
  private notePoolCap(model: string, info?: RateLimitInfo): boolean {
    const pools = this.codexPoolSnapshot();
    const pool = pools ? poolForModel(pools, model) : undefined;
    if (!pool?.modelSlug) return false;
    const until = this.capResetUntil(info, [pool.fiveHourReset, pool.sevenDayReset], CODEX_CAP_COOLDOWN_MS);
    const held = this.poolCapUntil.get(pool.limitId);
    if (held == null || until > held) {
      this.poolCapUntil.set(pool.limitId, until);
      this.persistPoolCaps();
    }
    this.hub.log(
      "warn",
      `Codex pool "${pool.limitName ?? pool.limitId}" hit its usage cap — bounded roles fall back to the general Codex pool until ${new Date(until).toLocaleString()}. (${describePool(pool)})`,
    );
    return true;
  }

  /** The dedicated pool this role would actually spend right now, or undefined when the policy, the
   *  latches, the meters or the roster rule one out. The single resolver behind both the availability
   *  gate and the candidate's meters, so the two can never disagree about which pool a run will use. */
  private dedicatedPoolFor(role: Role | undefined, demand?: CapacityDemand): CodexPool | undefined {
    if (!role || !roleMayUseDedicatedPool(role)) return undefined;
    const pools = this.codexPoolSnapshot();
    if (!pools) return undefined;
    if (this.modelOverrides()[CODEX_SUB_ID]?.[role]?.trim()) return undefined; // operator pinned this role's model
    const now = Date.now();
    const model = dedicatedPoolModel({ pools, role, now, dispatchable: this.codexRosterModels(), capLatches: this.poolCapUntil, demand });
    if (!model) return undefined;
    const pool = poolForModel(pools, model);
    // Re-assert the two live gates on the resolved pool. dedicatedPoolModel already applied them, so
    // this only ever holds when a pool is chosen for a model it does not meter — a mapping bug, where
    // failing closed is the safe answer.
    return pool && !poolLatched(this.poolCapUntil, pool.limitId, now) && poolHasHeadroom(pool, now) ? pool : undefined;
  }

  /** Whether a dedicated pool can serve this role right now — the availability half of the routing
   *  policy, so a bounded role can still reach Codex when only the GENERAL pool is exhausted. */
  private dedicatedPoolReadyFor(role: Role | undefined, demand?: CapacityDemand): boolean {
    return this.dedicatedPoolFor(role, demand) != null;
  }

  /** The selected Grok implementor model. Resolution: the model-overrides matrix (grok.implementor), then
   *  the legacy `setting_grok_model` kv (migration fallback), then the built-in default. Never inherits a
   *  Claude/Codex default — those model ids are invalid for the Grok CLI. */
  private grokModel(): string {
    const configured = this.modelOverrides()[GROK_SUB_ID]?.implementor?.trim() || this.db.kvGet("setting_grok_model")?.trim();
    // A fresh login can expose a newer Grok model before the next release updates our curated fallback.
    // Prefer the CLI's cached default when the operator has not deliberately picked one.
    return configured || this.modelCatalog.grokModels()[0] || config.grok.defaultModel;
  }

  /** Preserve a manual model selection in Settings, but don't dispatch it after the authenticated CLI cache
   * confirms that this login can no longer use it. A missing cache remains permissive for first login. */
  private grokModelAvailable(): boolean {
    const available = this.modelCatalog.grokModels();
    return available.length === 0 || available.includes(this.grokModel());
  }

  /** The Grok CLI reasoning-effort cap. Grok 4.6+ exposes xhigh; older cached models stop at high. */
  private grokEffort(model = this.grokModel()): GrokEffort {
    const v = this.db.kvGet("setting_grok_effort")?.trim();
    const supported = grokEffortsForModel(model);
    const requested = GROK_EFFORTS.includes(v as GrokEffort) ? (v as GrokEffort) : supported.at(-1)!;
    return supported.includes(requested) ? requested : "high";
  }

  /** The selected z.ai (GLM) implementor model. Resolution mirrors codex/grok: the model-overrides matrix
   *  (zai.implementor), then the legacy `setting_zai_model` kv, then the built-in default. Never inherits a
   *  Claude/Codex/Grok default — those model ids aren't valid GLM ids for z.ai. */
  private zaiModel(): string {
    return (
      this.modelOverrides()[ZAI_SUB_ID]?.implementor?.trim() ||
      this.db.kvGet("setting_zai_model")?.trim() ||
      config.zai.defaultModel
    );
  }

  /** The z.ai reasoning-effort CAP (low/medium/high; default high) — the per-task effort is clamped to it. */
  private zaiEffort(): ZaiEffort {
    const v = this.db.kvGet("setting_zai_effort")?.trim();
    return ZAI_EFFORTS.includes(v as ZaiEffort) ? (v as ZaiEffort) : "high";
  }

  /** The z.ai API key: the kv-stored UI value if present, else the server/.env fallback. NEVER broadcast —
   *  only its presence + last 4 chars leave the server (settings()). Public for the out-of-band consumer
   *  (the z.ai usage ping polls the quota endpoint with it); it must never cross the WS. */
  zaiApiKey(): string | undefined {
    return this.db.kvGet("zai_api_key")?.trim() || config.zai.apiKey;
  }

  /** Last 4 chars of the stored z.ai key for the masked settings field (null when no key / too short). */
  private zaiKeyLast4(): string | null {
    const k = this.zaiApiKey();
    return k && k.length >= 4 ? k.slice(-4) : null;
  }

  /** The Discord bot token used for phone notifications: the kv-stored UI value if present, else the
   *  server/.env fallback. NEVER broadcast — only its presence + last 4 chars leave the server. */
  private discordBotToken(): string | undefined {
    return this.db.kvGet("discord_bot_token")?.trim() || config.discord.botToken;
  }

  /** The channel notices are posted to — the operator's value, else the env fallback, else empty. The
   *  env value is parsed too: an unset/garbled DISCORD_CHANNEL_ID must read as NO channel, or the panel
   *  offers a Send test that cannot work and every notice 404s against a nonsense id. */
  private discordChannelId(): string {
    return this.db.kvGet("setting_discord_channel_id")?.trim() || parseChannelId(config.discord.channelId ?? "");
  }

  /** Last 4 chars of the stored bot token for the masked settings field. */
  private discordTokenLast4(): string | null {
    const t = this.discordBotToken();
    return t && t.length >= 4 ? t.slice(-4) : null;
  }

  /** Send a test Discord message with the settings exactly as they stand — the panel's "Send test"
   *  button, so the owner can confirm it reaches their phone without waiting for a task to settle. */
  async testDiscordNotification(): Promise<{ ok: boolean; message: string }> {
    const result = await this.discord.test();
    return result.ok
      ? { ok: true, message: "Sent — check your phone." }
      : { ok: false, message: result.message };
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
        if (typeof eff === "string" && CLAUDE_EFFORTS.includes(eff as Effort)) out[id] = eff as Effort;
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

  /** The composer's implementor-effort pick for skip-director dispatches. "auto" (default) lets the
   *  task route inherit a planner pick when planning runs, otherwise the implementor uses its default
   *  effort. A concrete tier is snapshotted onto the thread at dispatch and beats the plan.
   *  A stored `xhigh` degrades to `high` while the ENABLE_XHIGH opt-in is off, mirroring
   *  resolveEffort — so the dropdown never claims a tier this machine can't send. */
  private skipDirectorEffort(): Effort | "auto" {
    const v = this.db.kvGet("setting_skip_director_effort")?.trim();
    if (!v || !CLAUDE_EFFORTS.includes(v as Effort)) return "auto";
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
    if (patch.conciseAgentCommunication !== undefined) {
      this.db.kvSet("setting_concise_agent_communication", patch.conciseAgentCommunication ? "1" : "0");
    }
    if (patch.plannerEnabled !== undefined) this.db.kvSet("setting_planner_enabled", patch.plannerEnabled ? "1" : "0");
    if (patch.researcherEnabled !== undefined) this.db.kvSet("setting_researcher_enabled", patch.researcherEnabled ? "1" : "0");
    if (patch.qaEnabled !== undefined) this.db.kvSet("setting_qa_enabled", patch.qaEnabled ? "1" : "0");
    if (patch.differentProviderQa !== undefined) this.db.kvSet("setting_different_provider_qa", patch.differentProviderQa ? "1" : "0");
    if (patch.qaAppliesFixes !== undefined) this.db.kvSet("setting_qa_applies_fixes", patch.qaAppliesFixes ? "1" : "0");
    if (patch.autoPush !== undefined) this.db.kvSet("setting_auto_push", patch.autoPush ? "1" : "0");
    if (patch.directorName !== undefined) this.db.kvSet("setting_director_name", patch.directorName.trim().slice(0, 40));
    if (patch.maxQaRounds !== undefined) this.db.kvSet("setting_max_qa_rounds", String(patch.maxQaRounds));
    if (patch.maxReviewFixRounds !== undefined) this.db.kvSet("setting_max_review_fix_rounds", String(patch.maxReviewFixRounds));
    if (patch.maxConcurrent !== undefined) this.db.kvSet("setting_max_concurrent", String(patch.maxConcurrent));
    if (patch.maxConcurrentPerRepo !== undefined) this.db.kvSet("setting_max_concurrent_per_repo", String(patch.maxConcurrentPerRepo));
    if (patch.selfImproveEnabled !== undefined) this.db.kvSet("setting_self_improve_enabled", patch.selfImproveEnabled ? "1" : "0");
    if (patch.autoModelSelection !== undefined) this.db.kvSet("setting_auto_model_selection", patch.autoModelSelection ? "1" : "0");
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
    if (patch.grokEffort !== undefined && GROK_EFFORTS.includes(patch.grokEffort)) this.db.kvSet("setting_grok_effort", patch.grokEffort);
    // Legacy free-text grok model field mirrors into the matrix (grok.implementor), same as codex.
    if (patch.grokModel !== undefined && patch.grokModel.trim()) {
      this.db.kvSet("setting_grok_model", patch.grokModel.trim());
      this.setModelOverride(GROK_SUB_ID, "implementor", patch.grokModel.trim());
    }
    if (patch.zaiEnabled !== undefined) this.db.kvSet("setting_zai_enabled", patch.zaiEnabled ? "1" : "0");
    if (patch.zaiWeeklySafetyPct !== undefined) this.db.kvSet("setting_zai_weekly_safety", String(patch.zaiWeeklySafetyPct));
    if (patch.zaiEffort !== undefined && ZAI_EFFORTS.includes(patch.zaiEffort)) this.db.kvSet("setting_zai_effort", patch.zaiEffort);
    // Legacy free-text z.ai model field mirrors into the matrix (zai.implementor), same as codex/grok.
    if (patch.zaiModel !== undefined && patch.zaiModel.trim()) {
      this.db.kvSet("setting_zai_model", patch.zaiModel.trim());
      this.setModelOverride(ZAI_SUB_ID, "implementor", patch.zaiModel.trim());
    }
    // Write-only z.ai key: store the trimmed value, or clear it (empty string) so settings() falls back to
    // the env key. The raw key is never returned to clients — only zaiKeyPresent/last4 are.
    if (patch.zaiApiKey !== undefined) this.db.kvSet("zai_api_key", patch.zaiApiKey.trim());
    if (patch.discordNotify !== undefined) this.db.kvSet("setting_discord_notify", patch.discordNotify ? "1" : "0");
    // A pasted channel LINK or `<#id>` mention is the common paste; stored verbatim it 404s on every
    // notice, so the id is lifted out of whichever shape arrived.
    if (patch.discordChannelId !== undefined) this.db.kvSet("setting_discord_channel_id", parseChannelId(patch.discordChannelId));
    // Write-only bot token: stored server-side, never echoed back (only discordTokenPresent/last4 are).
    // An empty string clears it, falling back to DISCORD_BOT_TOKEN.
    if (patch.discordBotToken !== undefined) this.db.kvSet("discord_bot_token", patch.discordBotToken.trim());
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
    if (patch.taskDurationMinutes !== undefined) this.db.kvSet("setting_task_duration_minutes", String(Math.max(0, Math.round(patch.taskDurationMinutes))));
    // The SETTING's domain is {1 = off} ∪ [MIN_AGENTS..MAX_AGENTS], which is NOT clampAgentCount's
    // domain: that clamps into the shotgun range, so it turns 1 into 2 and silently makes every
    // subsequent task a two-agent shotgun the owner never asked for. Let "off" through untouched.
    if (patch.taskAgentCount !== undefined) {
      const n = Math.round(patch.taskAgentCount);
      this.db.kvSet("setting_task_agent_count", String(n <= 1 ? 1 : clampAgentCount(n)));
    }
    if (patch.directorSupervisorEnabled !== undefined) {
      this.db.kvSet("setting_director_supervisor_enabled", patch.directorSupervisorEnabled ? "1" : "0");
      this.supervisor.setEnabled(patch.directorSupervisorEnabled);
    }
    if (patch.showComposerPickers !== undefined) this.db.kvSet("setting_show_composer_pickers", patch.showComposerPickers ? "1" : "0");
    if (patch.showAgentModel !== undefined) this.db.kvSet("setting_show_agent_model", patch.showAgentModel ? "1" : "0");
    if (patch.skipDirectorEffort !== undefined && (patch.skipDirectorEffort === "auto" || CLAUDE_EFFORTS.includes(patch.skipDirectorEffort)))
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
    if (Number.isFinite(until) && until > Date.now()) {
      this.codexCapUntil = until;
      this.codexCapUntilProviderStated = this.db.kvGet(CODEX_CAP_SOURCE_KV_KEY) === "provider";
      this.codexCapRecordedAt = this.persistedCapRecordedAt(CODEX_CAP_RECORDED_AT_KV_KEY);
    } else if (v) {
      this.clearCodexCap();
    }
  }

  private persistedCapRecordedAt(key: string): number | undefined {
    const recordedAt = Number(this.db.kvGet(key));
    return Number.isFinite(recordedAt) && recordedAt > 0 ? recordedAt : undefined;
  }

  /** Latch Codex as usage-capped until its window resets, so implementors route to the Claude backend.
   *  Prefers the real reset epoch from the usage snapshot; falls back to a fixed cooldown when unknown. */
  private capResetUntil(info: RateLimitInfo | undefined, observed: Array<number | null | undefined>, fallbackMs: number): number {
    const now = Date.now();
    // A provider's own future timestamp is the authority. In particular, do not shorten a plain-text
    // "try again at Sep 2" cap to an older 5h/weekly dashboard reset: that would route work straight
    // back to the provider before the provider said it was ready. The only non-authoritative timestamp
    // is our bounded fallback for a message that named no reset at all.
    if (info?.resetsAt != null && info.resetsAt > now && info.resetSource !== "fallback") return info.resetsAt;
    const snapshots = observed.filter((reset): reset is number => reset != null && reset > now);
    if (snapshots.length) return Math.min(...snapshots);
    if (info?.resetsAt != null && info.resetsAt > now) return info.resetsAt;
    return now + fallbackMs;
  }

  private noteCodexCap(info?: RateLimitInfo, model?: string): void {
    // A rejection on a model with its OWN allowance is that pool's cap, not the plan's: latch it
    // separately and leave the general pool (and everything routed to it) untouched.
    if (model && this.notePoolCap(model, info)) return;
    const now = Date.now();
    const u = readCodexUsage();
    const until = this.capResetUntil(info, [u?.fiveHourReset, u?.sevenDayReset], CODEX_CAP_COOLDOWN_MS);
    const providerStated = info?.resetsAt != null && info.resetsAt > now && info.resetSource !== "fallback";
    // Record every fresh rejection, including one that preserves a longer existing provider reset. A
    // later clean run can then prove that held reset stale, while an older historical success cannot.
    this.codexCapRecordedAt = now;
    this.db.kvSet(CODEX_CAP_RECORDED_AT_KV_KEY, String(now));
    if (this.codexCapUntil && this.codexCapUntil >= until && (!providerStated || this.codexCapUntilProviderStated)) return;
    this.codexCapUntil = until;
    this.codexCapUntilProviderStated = providerStated;
    this.db.kvSet(CODEX_CAP_KV_KEY, String(until));
    this.db.kvSet(CODEX_CAP_SOURCE_KV_KEY, providerStated ? "provider" : "fallback");
    this.hub.log("warn", `Codex hit its usage cap — routing implementors to Claude until ${new Date(until).toLocaleString()}.`);
  }

  private clearCodexCap(): void {
    this.codexCapUntil = undefined;
    this.codexCapUntilProviderStated = false;
    this.codexCapRecordedAt = undefined;
    this.db.kvSet(CODEX_CAP_KV_KEY, "");
    this.db.kvSet(CODEX_CAP_SOURCE_KV_KEY, "");
    this.db.kvSet(CODEX_CAP_RECORDED_AT_KV_KEY, "");
  }

  /** A provider-stated reset is authoritative until the provider proves otherwise. The task database is
   *  that proof when a later Codex run completed successfully: this happens after a usage reset/credit
   *  redemption, and also prevents the legacy-QA migration from reviving an overnight cap after newer
   *  Codex work already succeeded. Interrupted/restarted runs are deliberately ignored — they say
   *  nothing about quota. The newest conclusive Codex outcome wins (success vs cap). */
  private codexRecoveredAfterLastRecordedCap(): boolean {
    const latest = this.db
      .listAllRuns(5_000)
      .map((run) => ({
        run,
        // Pre-capFlagged rows can still carry a provider's textual 429/usage-limit signal. Keep
        // their meaning aligned with boot restoration: a later legacy cap must not be hidden by an
        // older successful run and clear the provider-stated reset early.
        capped: run.capFlagged === true || providerErrorLooksRateLimited(run.error ?? ""),
      }))
      .filter(
        ({ run, capped }) =>
          run.account?.startsWith("codex:") &&
          run.endedAt != null &&
          (capped || run.state === "done"),
      )
      .sort((a, b) => (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0))[0];
    return latest?.run.state === "done" && !latest.capped;
  }

  /** Whether Codex should be treated as usage-capped right now (route implementors to Claude). True while
   *  the live-run latch is active OR the latest usage snapshot shows a window fully consumed. Clears an
   *  expired latch as a side effect so Codex is retried the moment its window resets. */
  private codexCapActive(): boolean {
    const now = Date.now();
    if (this.codexCapUntil != null) {
      // A failed Codex turn may only tell us "usage limit" and therefore installs a bounded
      // cooldown. Do not let that pessimistic fallback overrule a newer app-server probe that says
      // the same plan has usable headroom — model/account limits can clear between the failure and
      // the next supervisor tick. Rollout snapshots are deliberately NOT enough here: they can be
      // old, whereas liveCodexUsage is a fresh plan-wide RPC reading.
      const liveHeadroom = liveCodexUsage() && this.codexProviderCandidate().hasHeadroom;
      const recoveredAfterCap = this.codexCapUntilProviderStated && this.codexRecoveredAfterLastRecordedCap();
      if (liveHeadroom && (!this.codexCapUntilProviderStated || recoveredAfterCap)) {
        this.hub.log(
          "info",
          recoveredAfterCap
            ? "Codex has a successful run newer than its recorded cap and live headroom — clearing the stale provider reset latch."
            : "Codex live usage probe reports headroom — clearing the stale Codex cap latch.",
        );
        this.clearCodexCap();
        return false;
      }
      if (now < this.codexCapUntil) return true;
      this.clearCodexCap();
    }
    return codexUsageCapped(now);
  }

  /** Called after a successful app-server usage probe. A fresh positive Codex reading can free
   * cap-parked work immediately instead of waiting for the cap supervisor's next interval. */
  onCodexUsageRefresh(): void {
    if (!liveCodexUsage()) return;
    if (!this.codexCapActive()) this.resumeCapParked();
    this.armCapResumeWake();
  }

  /** Restore the persisted Grok usage-cap latch on boot (mirrors loadCodexCap). */
  private loadGrokCap(): void {
    const v = this.db.kvGet(GROK_CAP_KV_KEY);
    const until = v ? Number(v) : NaN;
    if (Number.isFinite(until) && until > Date.now()) {
      this.grokCapUntil = until;
      this.grokCapRecordedAt = this.persistedCapRecordedAt(GROK_CAP_RECORDED_AT_KV_KEY);
      noteGrokCap(until);
    } else if (v) this.clearGrokCap(); // stale/expired
  }

  private clearGrokCap(): void {
    this.grokCapUntil = undefined;
    this.grokCapRecordedAt = undefined;
    this.db.kvSet(GROK_CAP_KV_KEY, "");
    this.db.kvSet(GROK_CAP_RECORDED_AT_KV_KEY, "");
    noteGrokCap(null);
  }

  /** Latch Grok as usage-capped after a rejected turn, routing implementors to another backend. The live
   *  weekly scrape normally supplies the true reset; before it lands, a fixed cooldown keeps the latch
   *  self-expiring. Mirrors the chip's countdown via noteGrokCap. */
  private noteGrokCap(info?: RateLimitInfo): void {
    const now = Date.now();
    // Prefer the real weekly reset from the live `/usage show` scrape; fall back to a fixed cooldown when
    // no scrape has landed yet. A cap response's stated reset is still authoritative enough to avoid
    // immediately retrying the same exhausted provider before the next scrape lands.
    const until = this.capResetUntil(info, [readGrokUsage().sevenDayReset], config.grok.capCooldownMs);
    this.grokCapRecordedAt = now;
    this.db.kvSet(GROK_CAP_RECORDED_AT_KV_KEY, String(now));
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
      this.clearGrokCap();
    }
    // Also honor the scraped weekly window: if `/usage show` shows 100% used (not yet reset), Grok is
    // capped even without a live-run rejection.
    return grokUsageCapped(now);
  }

  /** Restore the persisted z.ai usage-cap latch on boot (mirrors loadGrokCap). */
  private loadZaiCap(): void {
    const v = this.db.kvGet(ZAI_CAP_KV_KEY);
    const until = v ? Number(v) : NaN;
    if (Number.isFinite(until) && until > Date.now()) {
      this.zaiCapUntil = until;
      this.zaiCapRecordedAt = this.persistedCapRecordedAt(ZAI_CAP_RECORDED_AT_KV_KEY);
      noteZaiCap(until);
    } else if (v) this.clearZaiCap(); // stale/expired
  }

  private clearZaiCap(): void {
    this.zaiCapUntil = undefined;
    this.zaiCapRecordedAt = undefined;
    this.db.kvSet(ZAI_CAP_KV_KEY, "");
    this.db.kvSet(ZAI_CAP_RECORDED_AT_KV_KEY, "");
    noteZaiCap(null);
  }

  /** Latch z.ai as usage-capped after a rejected turn, routing implementors to another backend. The live
   *  quota scrape normally supplies the true 5h/weekly reset; before it lands, a fixed cooldown keeps the
   *  latch self-expiring. Mirrors the chip's countdown via noteZaiCap. */
  private noteZaiCap(info?: RateLimitInfo): void {
    const now = Date.now();
    const u = readZaiUsage();
    // Prefer the soonest real reset from the quota scrape (5h or weekly, whichever is nearer and in the
    // future). Preserve a rejected turn's stated reset too, so a transiently unavailable quota endpoint
    // cannot shorten the provider hold to an arbitrary cooldown.
    const until = this.capResetUntil(info, [u.fiveHourReset, u.sevenDayReset], config.zai.capCooldownMs);
    this.zaiCapRecordedAt = now;
    this.db.kvSet(ZAI_CAP_RECORDED_AT_KV_KEY, String(now));
    if (this.zaiCapUntil && this.zaiCapUntil >= until) return; // already latched at least this long
    this.zaiCapUntil = until;
    this.db.kvSet(ZAI_CAP_KV_KEY, String(until));
    noteZaiCap(until);
    this.hub.log("warn", `z.ai hit its usage cap — routing implementors elsewhere until ${new Date(until).toLocaleString()}.`);
  }

  /** Whether z.ai should be treated as usage-capped right now. Clears an expired latch as a side effect. */
  private zaiCapActive(): boolean {
    const now = Date.now();
    if (this.zaiCapUntil != null) {
      if (now < this.zaiCapUntil) return true;
      this.clearZaiCap();
    }
    // Also honor the scraped windows: either window at 100% (not yet reset) caps z.ai even without a rejection.
    return zaiUsageCapped(now);
  }

  private claudeProviderCandidate(demand?: CapacityDemand): ProviderCandidate {
    const preview = (this.accounts as unknown as { dispatchPreview?: (demand?: CapacityDemand) => Partial<AccountDispatchPreview> & { account: { id: string; label: string } } }).dispatchPreview;
    if (typeof preview === "function") {
      const c = preview.call(this.accounts, demand);
      return {
        provider: "claude",
        hasHeadroom: c.hasHeadroom ?? this.accounts.hasHeadroom(),
        fiveHour: c.fiveHour ?? null,
        fiveHourReset: c.fiveHourReset ?? null,
        sevenDay: c.sevenDay ?? null,
        sevenDayReset: c.sevenDayReset ?? null,
        weeklySafetyPct: c.weeklySafetyPct ?? 100,
        capacityLabel: `Claude ${c.account.label}`,
        capacityWindows: c.capacityWindows ?? standardCapacityWindows(c.fiveHour, c.fiveHourReset, c.sevenDay, c.sevenDayReset),
      };
    }
    const option = this.claudeCapacityOptions(demand ?? demandForRole("implementor"))[0];
    return {
      provider: "claude",
      hasHeadroom: option?.hasHeadroom ?? false,
      fiveHour: null,
      fiveHourReset: null,
      sevenDay: null,
      sevenDayReset: null,
      weeklySafetyPct: 100,
      capacityLabel: option?.label ?? "Claude",
      capacityWindows: option?.windows ?? [],
    };
  }

  /** Grok's dispatch candidate. Weekly used-% + reset come from the CLI log / winpty scrape; monthly
   *  credits from the HTTP billing ping (see grokUsagePing). Grok competes by soonest weekly reset like
   *  Claude/Codex. Headroom = not cap-latched, not near the weekly hard limit, and not monthly-exhausted.
   *  When no reading has landed yet the windows are null (treated as headroom, sorts last) until the first
   *  ping fills in. */
  private grokProviderCandidate(_demand?: CapacityDemand): ProviderCandidate {
    const now = Date.now();
    const u = readGrokUsage();
    const capActive = this.grokCapActive();
    const startupCooldownUntil = this.providerStartupCooldownUntil("grok", now);
    const nearWeekly =
      u.sevenDay != null && u.sevenDay >= PROVIDER_HARD_LIMIT && (u.sevenDayReset == null || u.sevenDayReset > now);
    const monthlyPct = u.monthlyUsed != null && u.monthlyLimit != null && u.monthlyLimit > 0
      ? Math.min(100, (u.monthlyUsed / u.monthlyLimit) * 100)
      : null;
    const monthlyExhausted =
      monthlyPct != null &&
      monthlyPct >= PROVIDER_HARD_LIMIT &&
      (u.monthlyReset == null || u.monthlyReset > now);
    return {
      provider: "grok",
      // Keep the actual latch guard in this expression: probe-accounts.cjs structurally mirrors every
      // dispatch door so its operator-facing failover ladder cannot overstate usable capacity.
      hasHeadroom: startupCooldownUntil == null && !capActive && !nearWeekly && !monthlyExhausted,
      fiveHour: null,
      fiveHourReset: null,
      sevenDay: u.sevenDay,
      sevenDayReset: u.sevenDayReset,
      weeklySafetyPct: this.settings().grokWeeklySafetyPct,
      capacityLabel: "Grok subscription",
      capacityWindows: withStartupHealthCooldown(
        withCapLatch(
          capacityWindowsWithFreshness(
            [
              { label: "weekly", usedPct: u.sevenDay, resetAt: u.sevenDayReset },
              { label: "monthly credits", usedPct: monthlyPct, resetAt: u.monthlyReset },
            ],
            PROVIDER_HARD_LIMIT,
            u.stale === true,
            now,
          ),
          "live usage cap",
          capActive,
          this.grokCapUntil,
        ),
        startupCooldownUntil,
      ),
    };
  }

  /** Whether Grok is enabled, authenticated, and below the shared hard usage ceiling. This intentionally
   *  does not inspect the selected implementor model: director routing validates each target model itself. */
  private grokProviderReady(): boolean {
    if (!this.settings().grokEnabled) return false;
    if (!grokAuthAvailable()) return false;
    return this.grokProviderCandidate().hasHeadroom;
  }

  /** Whether the Grok backend could take an implementor RIGHT NOW — provider-ready and compatible with
   *  the selected implementor model. Used by the failover ladder + cap supervisor so "every account is
   *  rate-limited" is only ever claimed when Grok genuinely can't step in either. */
  private grokImplementorReady(): boolean {
    return this.grokProviderReady() && this.grokModelAvailable();
  }

  /** z.ai's dispatch candidate. 5-hour + weekly used-% and resets come from the GLM Coding Plan's quota
   *  endpoint (see zaiUsagePing). z.ai competes by soonest weekly reset like Claude/Codex/Grok. Headroom =
   *  not cap-latched and neither window at/over the hard limit. Null windows (no reading yet) count as
   *  headroom (sorts last) until the first poll fills in. */
  private zaiProviderCandidate(_demand?: CapacityDemand): ProviderCandidate {
    const now = Date.now();
    const u = readZaiUsage();
    const capActive = this.zaiCapActive();
    const startupCooldownUntil = this.providerStartupCooldownUntil("zai", now);
    const near = (pct: number | null, reset: number | null): boolean =>
      pct != null && pct >= PROVIDER_HARD_LIMIT && (reset == null || reset > now);
    return {
      provider: "zai",
      hasHeadroom:
        startupCooldownUntil == null &&
        !capActive &&
        !near(u.fiveHour, u.fiveHourReset) &&
        !near(u.sevenDay, u.sevenDayReset),
      fiveHour: u.fiveHour,
      fiveHourReset: u.fiveHourReset,
      sevenDay: u.sevenDay,
      sevenDayReset: u.sevenDayReset,
      weeklySafetyPct: this.settings().zaiWeeklySafetyPct,
      capacityLabel: "z.ai coding-plan pool",
      capacityWindows: withStartupHealthCooldown(
        withCapLatch(
          capacityWindowsWithFreshness(
            standardCapacityWindows(u.fiveHour, u.fiveHourReset, u.sevenDay, u.sevenDayReset),
            PROVIDER_HARD_LIMIT,
            u.stale === true,
            now,
          ),
          "live usage cap",
          capActive,
          this.zaiCapUntil,
        ),
        startupCooldownUntil,
      ),
    };
  }

  /** Whether the z.ai backend could take an implementor RIGHT NOW — enabled, a key is present, not
   *  usage-capped, and with window headroom. Used by the failover ladder + cap supervisor so "every
   *  account is rate-limited" is only ever claimed when z.ai genuinely can't step in either. */
  private zaiImplementorReady(): boolean {
    if (!this.settings().zaiEnabled) return false;
    if (!this.zaiApiKey()) return false;
    if (this.zaiCapActive()) return false;
    return this.zaiProviderCandidate().hasHeadroom;
  }

  private codexProviderCandidate(role?: Role, demand?: CapacityDemand, modelOverride?: string): ProviderCandidate {
    const now = Date.now();
    const u = readCodexUsage();
    const startupCooldownUntil = this.providerStartupCooldownUntil("codex", now);
    // A role eligible to spend a DEDICATED allowance is metered by that pool, not the plan-wide one, so
    // both the doors and the reported windows switch to it. Quoting the general pool's exhausted weekly
    // for a run that will never touch it is exactly what would keep an idle pool out of the ladder —
    // and conversely, quoting the idle pool for an implementor would claim room it cannot use.
    const model = modelOverride ?? (role ? this.codexRoleModel(role, demand) : this.codexModel());
    const pools = this.codexPoolSnapshot();
    const pool = pools ? poolForModel(pools, model) : undefined;
    const dedicated = pool?.modelSlug ? pool : undefined;
    const nearLimit = (pct: number | null, reset: number | null): boolean =>
      pct != null && pct >= PROVIDER_HARD_LIMIT && (reset == null || reset > now);
    const poolCapped = dedicated
      ? poolLatched(this.poolCapUntil, dedicated.limitId, now)
      : this.codexCapActive();
    const fiveHour = pool ? pool.fiveHour : (u?.fiveHour ?? null);
    const fiveHourReset = pool ? pool.fiveHourReset : (u?.fiveHourReset ?? null);
    const sevenDay = pool ? pool.sevenDay : (u?.sevenDay ?? null);
    const sevenDayReset = pool ? pool.sevenDayReset : (u?.sevenDayReset ?? null);
    const stale = !pool && u != null && now - u.updatedAt > ROUTING_USAGE_STALE_MS;
    const capacityWindows = withStartupHealthCooldown(
      withCapLatch(
        capacityWindowsWithFreshness(
          standardCapacityWindows(fiveHour, fiveHourReset, sevenDay, sevenDayReset),
          dedicated ? POOL_HARD_LIMIT_PCT : PROVIDER_HARD_LIMIT,
          stale,
          now,
        ),
        dedicated ? `${dedicated.limitName ?? dedicated.limitId} cap` : "live usage cap",
        poolCapped,
        dedicated ? (this.poolCapUntil.get(dedicated.limitId) ?? null) : this.codexCapUntil,
      ),
      startupCooldownUntil,
    );
    const selectedPoolReady =
      !poolCapped &&
      !nearLimit(fiveHour, fiveHourReset) &&
      !nearLimit(sevenDay, sevenDayReset) &&
      (!dedicated || poolHasHeadroom(dedicated, now));
    return {
      provider: "codex",
      hasHeadroom:
        startupCooldownUntil == null &&
        // probe-accounts mirrors this exact general-or-dedicated pool decision as separate ladder rungs.
        selectedPoolReady,
      fiveHour: fiveHour,
      fiveHourReset,
      sevenDay,
      sevenDayReset,
      weeklySafetyPct: this.settings().codexWeeklySafetyPct,
      capacityLabel: dedicated?.limitName ?? (dedicated?.limitId ? `Codex ${dedicated.limitId}` : "Codex general pool"),
      capacityWindows,
    };
  }

  /** Pick the best implementor backend from N candidates: prefer any WITH headroom, and within a headroom
   *  class break ties by providerPriority (soonest weekly reset, then most headroom) — see the "Spread
   *  usage" exception below, which flips that to lowest-weekly-usage. Grok's null windows sort it last among
   *  headroom-havers, making it the resilient fallback. The caller always passes at least the Claude
   *  candidate, so this never sees an empty list. Reused by nextReadyImplementor.
   *
   *  "Spread usage": when the operator opts in (spreadUsage), the tie-break flips from soonest-reset to
   *  LOWEST weekly usage — the backend with the most weekly headroom takes the implementor — so burn
   *  evens out across all platforms; the safety fallback still supersedes. */
  private preferredProviderCandidate(candidates: ProviderCandidate[], demand?: CapacityDemand): ProviderCandidate {
    const withHeadroom = candidates.filter((c) => c.hasHeadroom);
    const base = withHeadroom.length ? withHeadroom : candidates;
    // Viable runway is the first cut. A soft weekly ceiling or perishable-first preference must never
    // put a long task on a pool forecast to cap when another pool can carry it.
    const capacity = demand
      ? preferCapacity(base, candidateCapacityWindows, demand)
      : undefined;
    const capacityPool = capacity?.candidates ?? base;
    // Soft weekly ceiling (per-backend): a backend whose weekly usage crossed its safety % is de-preferred in
    // favor of one still under its own ceiling — but never dropped entirely (falls through when all are over,
    // so this can't freeze a dispatch). Claude carries the selected account's own ceiling; Codex/Grok/z.ai
    // carry their backend ceilings.
    const safety = weeklySafetyPool(capacityPool);
    const pool = safety.candidates;
    // Spread usage: balance across ALL backends by lowest weekly usage. The all-over-safety no-freeze
    // fallback (most headroom) supersedes both it and the default soonest-reset order.
    const priority = safety.allOver
      ? providerSafetyFallbackPriority
      : this.settings().spreadUsage
        ? providerSpreadUsage
        : providerPriority;
    return pool.reduce((best, c) => (priority(best, c) <= 0 ? best : c));
  }

  private preferredImplementorProvider(candidates: ProviderCandidate[], demand?: CapacityDemand): ImplementorProvider {
    return this.preferredProviderCandidate(candidates, demand).provider;
  }

  /** Every backend that can serve this exact role now, with the pool the role would actually spend. */
  private readyRoleCandidates(role: Role, demand: CapacityDemand): ProviderCandidate[] {
    const candidates: ProviderCandidate[] = [];
    if (providerServesRole(role, "claude")) {
      const claude = this.claudeProviderCandidate(demand);
      if (claude.hasHeadroom) candidates.push(claude);
    }
    if (providerServesRole(role, "codex") && this.codexImplementorReady(role, demand)) {
      candidates.push(this.codexProviderCandidate(role, demand));
    }
    if (providerServesRole(role, "grok") && this.grokImplementorReady()) candidates.push(this.grokProviderCandidate(demand));
    if (providerServesRole(role, "zai") && this.zaiImplementorReady()) candidates.push(this.zaiProviderCandidate(demand));
    return candidates;
  }

  private preferredRoleProvider(role: Role, demand: CapacityDemand): {
    provider?: ImplementorProvider;
    candidates: ProviderCandidate[];
    allKnownAtRisk: boolean;
  } {
    const candidates = this.readyRoleCandidates(role, demand);
    const capacity = preferCapacity(candidates, candidateCapacityWindows, demand);
    return {
      provider: candidates.length ? this.preferredImplementorProvider(candidates, demand) : undefined,
      candidates,
      allKnownAtRisk: capacity.allKnownAtRisk,
    };
  }

  /** Hard availability only. Explicit owner provider instructions use this compatibility seam; normal
   * automatic dispatch uses the task-sized providerSafeForRole path below. */
  private providerReady(provider: ImplementorProvider): boolean {
    if (this.providerStartupCoolingDown(provider)) return false;
    switch (provider) {
      case "claude": return this.accounts.hasHeadroom();
      case "codex": return this.codexImplementorReady();
      case "grok": return this.grokImplementorReady();
      case "zai": return this.zaiImplementorReady();
    }
  }

  /** Capacity and compatibility for one strict task-local model. Unlike the ordinary role inventory,
   * this deliberately contains only the requested model's own provider/pool. */
  private requestedModelCapacity(
    thread: Thread,
    demand: CapacityDemand,
    now = Date.now(),
  ): { options: RoleCapacityOption[]; error?: string } {
    const request = thread.modelRequest;
    if (!request) return { options: [] };
    if (!request.provider || !request.model) {
      return {
        options: [],
        error: `Requested model "${request.requested}" could not be resolved from this installation's live/configured model catalogs. Refresh the provider login/catalog or name an exact available model; no substitute was started.`,
      };
    }
    const model = request.model;
    const exact = (values: readonly string[]): boolean => values.some((value) => normalizeModelId(value) === normalizeModelId(model));

    if (request.provider === "claude") {
      const live = this.modelCatalog.claudeModels();
      if (live.length && !exact(live)) {
        return { options: [], error: `Requested Claude model ${model} is not available to the authenticated subscriptions. Choose an available Claude model or restore access; no substitute was started.` };
      }
      return { options: this.claudeCapacityOptions(demand, now).map((option) => ({ ...option, label: `${option.label} · ${model}` })) };
    }

    if (request.provider === "codex") {
      if (!this.settings().codexEnabled) {
        return { options: [], error: `Requested model ${model} requires Codex, but Codex is disabled. Enable Codex under Settings → Subscriptions; no other model was substituted.` };
      }
      const key = this.openaiApiKey();
      if (!codexAuthAvailable(!!key && /^sk-/.test(key))) {
        return { options: [], error: `Requested model ${model} requires Codex authentication. Sign in with \`codex login --device-auth\` or configure an OpenAI API key; no other model was substituted.` };
      }
      const live = chatgptLoginAvailable()
        ? this.modelCatalog.codexCliModels().map((entry) => entry.id)
        : this.modelCatalog.codexModels();
      if (live.length && !exact(live)) {
        return { options: [], error: `Requested Codex model ${model} is not exposed by the authenticated Codex catalog. Refresh/login or choose an available model; no substitute was started.` };
      }
      const pools = this.codexPoolSnapshot();
      const pool = pools ? poolForModel(pools, model) : undefined;
      // A named Spark allowance is a dedicated pool. If its live mapping disappears, treating it as a
      // general-pool model would be the same silent capacity substitution under a different meter.
      if (/spark/i.test(request.requested + " " + model) && !pool?.modelSlug) {
        return { options: [], error: `Requested Spark model ${model} has no visible dedicated Spark pool/model mapping right now. Wait for the Codex usage/catalog refresh or restore that entitlement; the general Codex pool was not substituted.` };
      }
      const candidate = this.codexProviderCandidate("implementor", demand, model);
      return {
        options: [{
          provider: "codex",
          label: `Codex ${model}${candidate.capacityLabel ? ` (${candidate.capacityLabel})` : ""}`,
          windows: candidateCapacityWindows(candidate),
          hasHeadroom: candidate.hasHeadroom,
        }],
      };
    }

    if (request.provider === "grok") {
      if (!this.settings().grokEnabled) return { options: [], error: `Requested model ${model} requires Grok, but Grok is disabled. Enable it under Settings → Subscriptions; no substitute was started.` };
      if (!grokAuthAvailable()) return { options: [], error: `Requested model ${model} requires Grok authentication. Run \`grok login\` or configure XAI_API_KEY; no substitute was started.` };
      const live = this.modelCatalog.grokModels();
      if (live.length && !exact(live)) return { options: [], error: `Requested Grok model ${model} is not available to this login; no substitute was started.` };
      const candidate = this.grokProviderCandidate(demand);
      return { options: [{ provider: "grok", label: `Grok ${model}`, windows: candidateCapacityWindows(candidate), hasHeadroom: candidate.hasHeadroom }] };
    }

    if (!this.settings().zaiEnabled) return { options: [], error: `Requested model ${model} requires z.ai, but z.ai is disabled. Enable it under Settings → Subscriptions; no substitute was started.` };
    if (!this.zaiApiKey()) return { options: [], error: `Requested model ${model} requires a z.ai API key; no substitute was started.` };
    const live = this.modelCatalog.zaiModels();
    if (live.length && !exact(live)) return { options: [], error: `Requested z.ai model ${model} is not available to this key; no substitute was started.` };
    const candidate = this.zaiProviderCandidate(demand);
    return { options: [{ provider: "zai", label: `z.ai ${model}`, windows: candidateCapacityWindows(candidate), hasHeadroom: candidate.hasHeadroom }] };
  }

  private requestedModelCapacitySnapshot(thread: Thread, demand: CapacityDemand, now = Date.now()): RoleCapacitySnapshot & { error?: string } {
    const { options, error } = this.requestedModelCapacity(thread, demand, now);
    const ready = options.filter((option) => this.roleCapacityReady(option, demand, now));
    if (ready.length) return { options, ready, error };
    const future = options
      .map((option) => nextViableAt(option.windows, demand, now))
      .filter((at): at is number => at != null && at > now);
    return { options, ready, nextAt: future.length ? Math.min(...future) : undefined, error };
  }

  private capacitySnapshotForThread(thread: Thread, role: CapParkStage, demand: CapacityDemand, now = Date.now()): RoleCapacitySnapshot & { error?: string } {
    return role === "implementor" && thread.modelRequest
      ? this.requestedModelCapacitySnapshot(thread, demand, now)
      : this.roleCapacitySnapshot(role, demand, now);
  }

  /** Strict model routing runs before normal provider/model selection. A compatibility/auth failure is
   * actionable and stays failed; a visible quota/runway shortage joins the durable cap supervisor, but
   * that supervisor watches only this exact model's pool. */
  private gateRequestedModel(thread: Thread, demand: CapacityDemand): ImplementorProvider | null {
    const request = thread.modelRequest;
    if (!request) return null;
    const snapshot = this.requestedModelCapacitySnapshot(thread, demand);
    if (snapshot.error) {
      this.postFinding({
        threadId: thread.id,
        fromRole: "director",
        summary: `Strict model request cannot start — ${request.requested}`,
        detail: snapshot.error,
        severity: "warning",
      });
      this.setState(thread.id, "failed", snapshot.error);
      return null;
    }
    if (!snapshot.ready.length) {
      this.parkForExhaustedProviders(thread.id, "implementor");
      // settleReview consumes the cap marker synchronously and renders capParkMessage, which names the
      // exact requested model/pool. This is only the defensive fallback if that marker disappears.
      this.settleReview(thread.id, "needs your review.");
      return null;
    }
    this.implementorProvider.set(thread.id, request.provider!);
    return request.provider!;
  }

  private providerSafeForRole(provider: ImplementorProvider, role: Role, demand: CapacityDemand): boolean {
    return this.roleCapacityOptions(role, demand).some(
      (option) => option.provider === provider && this.roleCapacityReady(option, demand),
    );
  }

  /** AccountManager's full API is always present in production. The fallback keeps old embedders and
   * focused test harnesses that provide only hasHeadroom/dispatchPreview source-compatible; unknown
   * windows are safer than fabricating quota. */
  private claudeCapacityOptions(demand: CapacityDemand, now = Date.now()): ClaudeCapacityOption[] {
    const startupCooldownUntil = this.providerStartupCooldownUntil("claude", now);
    const api = this.accounts as unknown as {
      capacityOptions?: (demand: CapacityDemand, now?: number) => Array<{
        account: { id: string; label: string };
        windows: CapacityWindow[];
        hasHeadroom: boolean;
      }>;
      dispatchPreview?: (demand?: CapacityDemand) => Partial<AccountDispatchPreview> & {
        account: { id: string; label: string };
      };
      hasHeadroom: () => boolean;
    };
    if (typeof api.capacityOptions === "function") {
      return api.capacityOptions(demand, now).map((option) => ({
        provider: "claude",
        accountId: option.account.id,
        label: `Claude ${option.account.label}`,
        windows: withStartupHealthCooldown(option.windows, startupCooldownUntil),
        hasHeadroom: option.hasHeadroom && startupCooldownUntil == null,
      }));
    }
    if (typeof api.dispatchPreview === "function") {
      const preview = api.dispatchPreview(demand);
      return [{
        provider: "claude",
        accountId: preview.account.id,
        label: `Claude ${preview.account.label}`,
        windows: withStartupHealthCooldown(
          preview.capacityWindows ?? standardCapacityWindows(
            preview.fiveHour,
            preview.fiveHourReset,
            preview.sevenDay,
            preview.sevenDayReset,
          ),
          startupCooldownUntil,
        ),
        hasHeadroom: (preview.hasHeadroom ?? api.hasHeadroom()) && startupCooldownUntil == null,
      }];
    }
    return [{
      provider: "claude",
      accountId: "claude",
      label: "Claude",
      windows: withStartupHealthCooldown([], startupCooldownUntil),
      hasHeadroom: api.hasHeadroom() && startupCooldownUntil == null,
    }];
  }

  /** Every independently metered allowance that could serve this role. Unlike provider candidates,
   * this inventory keeps capped pools: reset scheduling needs to know what can become viable later. */
  private roleCapacityOptions(role: Role, demand: CapacityDemand, now = Date.now()): RoleCapacityOption[] {
    const options: RoleCapacityOption[] = [];
    if (providerServesRole(role, "claude")) {
      options.push(...this.claudeCapacityOptions(demand, now));
    }

    const codexStart = options.length;
    if (this.settings().codexEnabled && providerServesRole(role, "codex")) {
      const key = this.openaiApiKey();
      if (codexAuthAvailable(!!key && /^sk-/.test(key))) {
        const usage = readCodexUsage();
        const pools = this.codexPoolSnapshot();
        const configured = this.providerRoleModel("codex", role);
        const models = new Set<string>([configured]);
        const explicitRoleModel = !!this.modelOverrides()[CODEX_SUB_ID]?.[role]?.trim();
        if (this.settings().autoModelSelection && (role === "director" || role === "implementor")) {
          for (const model of this.codexRosterModels()) {
            if (!poolForModel(pools ?? [], model)?.modelSlug) models.add(model);
          }
        }
        if (!explicitRoleModel && roleMayUseDedicatedPool(role) && pools) {
          const dispatchable = new Set(this.codexRosterModels().map((model) => normalizeModelId(model)));
          for (const pool of dedicatedPools(pools)) {
            if (pool.modelSlug && dispatchable.has(pool.modelSlug)) models.add(pool.modelSlug);
          }
        }

        const seenPools = new Set<string>();
        const generalCapActive = this.codexCapActive();
        const startupCooldownUntil = this.providerStartupCooldownUntil("codex", now);
        for (const model of models) {
          const pool = pools ? poolForModel(pools, model) : undefined;
          const poolKey = pool?.limitId ?? "general";
          if (seenPools.has(poolKey)) continue;
          seenPools.add(poolKey);
          const dedicated = pool?.modelSlug ? pool : undefined;
          const capActive = dedicated
            ? poolLatched(this.poolCapUntil, dedicated.limitId, now)
            : generalCapActive;
          const fiveHour = pool ? pool.fiveHour : (usage?.fiveHour ?? null);
          const fiveHourReset = pool ? pool.fiveHourReset : (usage?.fiveHourReset ?? null);
          const sevenDay = pool ? pool.sevenDay : (usage?.sevenDay ?? null);
          const sevenDayReset = pool ? pool.sevenDayReset : (usage?.sevenDayReset ?? null);
          const stale = !pool && usage != null && now - usage.updatedAt > ROUTING_USAGE_STALE_MS;
          const near = (pct: number | null, reset: number | null): boolean =>
            pct != null && pct >= (dedicated ? POOL_HARD_LIMIT_PCT : PROVIDER_HARD_LIMIT) && (reset == null || reset > now);
          options.push({
            provider: "codex",
            label: dedicated ? `Codex ${dedicated.limitName ?? dedicated.limitId}` : "Codex general pool",
            windows: withStartupHealthCooldown(
              withCapLatch(
                capacityWindowsWithFreshness(
                  standardCapacityWindows(fiveHour, fiveHourReset, sevenDay, sevenDayReset),
                  dedicated ? POOL_HARD_LIMIT_PCT : PROVIDER_HARD_LIMIT,
                  stale,
                  now,
                ),
                dedicated ? `${dedicated.limitName ?? dedicated.limitId} cap` : "live usage cap",
                capActive,
                dedicated ? (this.poolCapUntil.get(dedicated.limitId) ?? null) : this.codexCapUntil,
              ),
              startupCooldownUntil,
            ),
            hasHeadroom:
              startupCooldownUntil == null &&
              !capActive &&
              !near(fiveHour, fiveHourReset) &&
              !near(sevenDay, sevenDayReset) &&
              (!dedicated || poolHasHeadroom(dedicated, now)),
          });
        }
      }
    }
    if (
      providerServesRole(role, "codex") &&
      options.length === codexStart &&
      this.codexImplementorReady(role, demand)
    ) {
      const candidate = this.codexProviderCandidate(role, demand);
      options.push({
        provider: "codex",
        label: candidate.capacityLabel ?? "Codex",
        windows: candidate.hasHeadroom ? candidateCapacityWindows(candidate) : [],
        // Trust the public readiness seam here. This branch exists only for older embedders/tests that
        // override it without exposing Settings/auth internals; production took the full branch above.
        hasHeadroom: true,
      });
    }

    const grokStart = options.length;
    if (
      this.settings().grokEnabled &&
      providerServesRole(role, "grok") &&
      grokAuthAvailable() &&
      this.grokModelAvailable()
    ) {
      const candidate = this.grokProviderCandidate(demand);
      options.push({
        provider: "grok",
        label: candidate.capacityLabel ?? "Grok subscription",
        windows: candidateCapacityWindows(candidate),
        hasHeadroom: candidate.hasHeadroom,
      });
    }
    if (providerServesRole(role, "grok") && options.length === grokStart && this.grokImplementorReady()) {
      const candidate = this.grokProviderCandidate(demand);
      options.push({ provider: "grok", label: candidate.capacityLabel ?? "Grok", windows: candidate.hasHeadroom ? candidateCapacityWindows(candidate) : [], hasHeadroom: true });
    }

    const zaiStart = options.length;
    if (this.settings().zaiEnabled && providerServesRole(role, "zai") && this.zaiApiKey()) {
      const candidate = this.zaiProviderCandidate(demand);
      options.push({
        provider: "zai",
        label: candidate.capacityLabel ?? "z.ai coding-plan pool",
        windows: candidateCapacityWindows(candidate),
        hasHeadroom: candidate.hasHeadroom,
      });
    }
    if (providerServesRole(role, "zai") && options.length === zaiStart && this.zaiImplementorReady()) {
      const candidate = this.zaiProviderCandidate(demand);
      options.push({ provider: "zai", label: candidate.capacityLabel ?? "z.ai", windows: candidate.hasHeadroom ? candidateCapacityWindows(candidate) : [], hasHeadroom: true });
    }
    return options;
  }

  private roleCapacityReady(option: RoleCapacityOption, demand: CapacityDemand, now = Date.now()): boolean {
    if (!option.hasHeadroom) return false;
    const status = assessCapacity(option.windows, demand, now).status;
    return !demand.substantial || status !== "at-risk";
  }

  /** One internally consistent capacity view for routing, supervisor wakeups, and owner-facing text.
   * Reading provider cache files twice can straddle a usage refresh: the first read can say "blocked"
   * while the second exposes a viable pool whose `now` result is then discarded as not-a-future-reset.
   * Derive readiness and the advertised reset from the same inventory so those claims cannot diverge. */
  private roleCapacitySnapshot(role: Role, demand: CapacityDemand, now = Date.now()): RoleCapacitySnapshot {
    const options = this.roleCapacityOptions(role, demand, now);
    const ready = options.filter((option) => this.roleCapacityReady(option, demand, now));
    if (ready.length) return { options, ready };
    const future = options
      .map((option) => nextViableAt(option.windows, demand, now))
      .filter((at): at is number => at != null && at > now);
    return {
      options,
      ready,
      nextAt: future.length ? Math.min(...future) : undefined,
    };
  }

  /** Earliest reset that makes any compatible pool safe for this role's workload. */
  private nextRoleCapacityAt(role: Role, demand: CapacityDemand, now = Date.now()): number | undefined {
    return this.roleCapacitySnapshot(role, demand, now).nextAt;
  }

  /** The best implementor backend OTHER than `exclude` that can take over RIGHT NOW, or undefined when
   * none can. Substantial work requires task-sized runway here just as it does at initial dispatch and
   * supervisor recovery; otherwise a cap failover can bypass both guards and burn another doomed turn. */
  private nextReadyImplementor(
    exclude: ImplementorProvider,
    unavailable: ReadonlySet<ImplementorProvider> = new Set(),
    role?: Role,
    demand?: CapacityDemand,
  ): ImplementorProvider | undefined {
    // The reader's only owner-channel is the in-process MCP bus, so it may only land
    // on a backend that actually serves those tools — skip the CLI text-bridge backends for it. The
    // implementor path passes no role, so it still considers every backend.
    const serves = (provider: ImplementorProvider): boolean => !role || providerServesRole(role, provider);
    const cands: ProviderCandidate[] = [];
    if (exclude !== "claude" && !unavailable.has("claude") && serves("claude")) {
      const c = this.claudeProviderCandidate(demand);
      if (c.hasHeadroom) cands.push(c);
    }
    if (exclude !== "codex" && !unavailable.has("codex") && serves("codex") && this.codexImplementorReady(role, demand)) cands.push(this.codexProviderCandidate(role, demand));
    if (exclude !== "grok" && !unavailable.has("grok") && serves("grok") && this.grokImplementorReady()) cands.push(this.grokProviderCandidate(demand));
    if (exclude !== "zai" && !unavailable.has("zai") && serves("zai") && this.zaiImplementorReady()) cands.push(this.zaiProviderCandidate(demand));
    if (!cands.length) return undefined;
    const capacity = demand ? preferCapacity(cands, candidateCapacityWindows, demand) : undefined;
    if (demand?.substantial && capacity?.allKnownAtRisk) return undefined;
    return this.preferredImplementorProvider(cands, demand);
  }

  /** Whether the Codex backend could take an implementor RIGHT NOW — enabled, authed, not usage-capped,
   *  and with window headroom. The Claude-cap failover and the cap supervisor use this, so "every account
   *  is rate-limited" is only ever claimed (and frozen on) when Codex genuinely can't step in either.
   *  Deliberately treats "no usage reading yet" as headroom: API-key-billed Codex has no plan windows and
   *  never produces one, so requiring a reading would permanently disable the failover for those setups.
   *  A blind flip onto a secretly-capped Codex is bounded — the run 429s and flips back or parks. */
  private codexImplementorReady(role?: Role, demand?: CapacityDemand): boolean {
    if (!this.settings().codexEnabled) return false;
    const key = this.openaiApiKey();
    if (!codexAuthAvailable(!!key && /^sk-/.test(key))) return false;
    // A bounded role routed to its own dedicated allowance is unaffected by the general pool's state,
    // so it stays available when only the general pool is capped or spent. Checked BEFORE the general
    // gates precisely so idle dedicated capacity is reachable rather than hidden behind them. Resolve
    // the exact model too: an operator-pinned dedicated model must retain that same independence even
    // though `dedicatedPoolFor` intentionally does not override explicit model choices.
    if (role && roleMayUseDedicatedPool(role)) {
      const model = this.codexRoleModel(role, demand);
      const pools = this.codexPoolSnapshot();
      const exactPool = pools ? poolForModel(pools, model) : undefined;
      if (exactPool?.modelSlug) return this.codexProviderCandidate(role, demand, model).hasHeadroom;
    }
    if (this.dedicatedPoolReadyFor(role, demand)) return true;
    if (this.codexCapActive()) return false;
    return this.codexProviderCandidate(role, demand).hasHeadroom;
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
  private resolveImplementorProvider(demand: CapacityDemand): {
    provider?: ImplementorProvider;
    error?: string;
    allCandidatesCapped?: boolean;
    allKnownInsufficient?: boolean;
    candidates?: ProviderCandidate[];
  } {
    const s = this.settings();
    const candidates: ProviderCandidate[] = [this.claudeProviderCandidate(demand)];

    // Codex: usable auth is EITHER a ChatGPT-plan `codex login` (preferred — no API billing) OR a valid
    // OpenAI API key. Enabled + authed but usage-capped → simply excluded from this dispatch (the latch
    // auto-clears when its window resets, so Codex rejoins on its own).
    if (s.codexEnabled) {
      const key = this.openaiApiKey();
      if (!codexAuthAvailable(!!key && /^sk-/.test(key))) {
        return { error: "Codex is enabled but has no usable auth: no ChatGPT `codex login` was found and no valid OpenAI API key (sk-…) is set. Sign in with `codex login --device-auth` (uses your ChatGPT plan), or add an API key under Settings → Subscriptions, or turn Codex off to use Claude." };
      }
      if (this.codexCapActive()) this.hub.log("info", "Codex is usage-capped — excluding it from this dispatch until its window resets.");
      else candidates.push(this.codexProviderCandidate("implementor", demand));
    }

    // Grok: usable auth is a `grok login` (~/.grok/auth.json) or an XAI_API_KEY. Same cap-exclusion policy.
    if (s.grokEnabled) {
      if (!grokAuthAvailable()) {
        return { error: "Grok is enabled but has no usable auth: no `grok login` was found (~/.grok/auth.json) and no XAI_API_KEY is set. Run `grok login` (or `grok login --device-auth` on a headless box), or turn Grok off to use Claude." };
      }
      if (this.grokCapActive()) this.hub.log("info", "Grok is usage-capped — excluding it from this dispatch until it frees up.");
      else if (!this.grokModelAvailable()) this.hub.log("warn", `Grok model ${this.grokModel()} is unavailable to this login; excluding Grok until the model selection is updated.`);
      else candidates.push(this.grokProviderCandidate(demand));
    }

    // z.ai: usable auth is an API key (kv-stored UI value or ZAI_API_KEY). Same cap-exclusion policy.
    if (s.zaiEnabled) {
      if (!this.zaiApiKey()) {
        return { error: "z.ai is enabled but has no API key: add your z.ai key under Settings → Subscriptions (or set ZAI_API_KEY in server/.env), or turn z.ai off to use Claude." };
      }
      if (this.zaiCapActive()) this.hub.log("info", "z.ai is usage-capped — excluding it from this dispatch until its window resets.");
      else candidates.push(this.zaiProviderCandidate(demand));
    }

    // `preferredImplementorProvider` deliberately returns a least-bad candidate when everything is
    // over a soft/hard limit, so ordinary dispatch never freezes merely because usage telemetry is
    // imperfect. Pipeline starts need to know that distinction, though: launching this fallback when
    // every already-configured backend is known capped burns a doomed provider turn before the normal
    // cap path can park it. Keep the route for callers that intentionally want that no-freeze behavior,
    // but report the exhausted ladder to the pipeline gate so it can wait for the reset directly.
    const allCandidatesCapped = candidates.length > 0 && candidates.every((candidate) => !candidate.hasHeadroom);
    const ready = candidates.filter((candidate) => candidate.hasHeadroom);
    const capacity = preferCapacity(ready, candidateCapacityWindows, demand);
    const allKnownInsufficient = ready.length > 0 && capacity.allKnownAtRisk;
    const provider = this.preferredImplementorProvider(candidates, demand);
    if (candidates.length > 1) {
      const now = Date.now();
      const parts = candidates.map((candidate) => describeProviderCapacity(candidate, demand, now));
      this.hub.log("info", `Implementor provider: ${provider} for ${demandSummary(demand)} (${parts.join("; ")}).`);
    }
    return { provider, allCandidatesCapped, allKnownInsufficient, candidates };
  }

  /** Hard routing gate, run once at the start of a thread's implementor stage: resolve + remember the
   *  backend. A blocked routing parks the task (failed) with a clear reason + a finding, returns null. */
  private gateImplementorProvider(
    thread: Thread,
    opts?: { capParkOnExhaustion?: boolean; effort?: Effort },
  ): ImplementorProvider | null {
    thread = this.ensureThreadModelRequest(this.db.getThread(thread.id) ?? thread);
    const demand = this.capacityDemand(thread, "implementor", opts?.effort);
    if (thread.modelRequest) return this.gateRequestedModel(thread, demand);
    const { provider, error, allCandidatesCapped, allKnownInsufficient, candidates = [] } = this.resolveImplementorProvider(demand);
    if (!provider) {
      this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "Dispatch blocked by subscription settings", detail: error, severity: "warning" });
      this.setState(thread.id, "failed", error);
      return null;
    }
    // Pipeline starts must never spend a known-doomed turn when every currently configured backend
    // is already usage-capped. Preserve the ordinary routing fallback for owner-triggered auto-review
    // fix rounds (which retain their existing human-review contract), but put resumable pipeline work
    // straight into the durable cap-park protocol and let its reset wake choose the first free backend.
    if ((allCandidatesCapped || (allKnownInsufficient && demand.substantial)) && opts?.capParkOnExhaustion) {
      this.parkForExhaustedProviders(thread.id, "implementor");
      // `settleReview` consumes the cap marker synchronously and supplies the durable auto-resume
      // message, so this fallback reason is intentionally only for a non-cap caller/race.
      this.settleReview(thread.id, "needs your review.");
      return null;
    }
    const routed = this.routeForPick(thread.id, provider, demand);
    const intent = providerIntent([thread.title, thread.rawPrompt, thread.brief].filter(Boolean).join("\n"));
    let chosen = routed;
    if (intent.preferred && this.providerReady(intent.preferred) && !intent.excluded.has(intent.preferred)) {
      chosen = intent.preferred;
    }
    if (intent.excluded.has(chosen)) {
      const alternate = this.nextReadyImplementor(chosen, intent.excluded, "implementor", demand);
      if (!alternate) {
        const names = [...intent.excluded].map(providerLabel).join(", ");
        const detail = `The task explicitly excludes ${names}, and no allowed implementor backend is currently ready.`;
        this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "Explicit provider requirement cannot be satisfied", detail, severity: "warning" });
        this.setState(thread.id, "failed", detail);
        return null;
      }
      chosen = alternate;
    }
    if (chosen !== routed) {
      this.postFinding({
        threadId: thread.id,
        fromRole: "director",
        summary: `Honored the task's explicit provider instruction — routing to ${providerLabel(chosen)}`,
        detail: `Automatic usage/model routing selected ${providerLabel(routed)}, but the task explicitly requested or excluded a provider. The implementor is starting on ${providerLabel(chosen)}.`,
        severity: "info",
      });
    }
    this.noteCapacityRoute(thread, demand, chosen, candidates);
    this.implementorProvider.set(thread.id, chosen);
    return chosen;
  }

  /** Put the same quota facts that made the decision on the task, rather than hiding them in a server log. */
  private noteCapacityRoute(
    thread: Thread,
    demand: CapacityDemand,
    chosen: ImplementorProvider,
    candidates: ProviderCandidate[],
  ): void {
    const selected = candidates.find((candidate) => candidate.provider === chosen);
    if (!selected) return;
    const assessment = assessCapacity(candidateCapacityWindows(selected), demand);
    if (candidates.length < 2 && !demand.substantial && assessment.status === "viable") return;
    const status = assessment.status === "viable"
      ? "enough quota runway"
      : assessment.status === "unknown"
        ? "quota telemetry unavailable"
        : "the least-risky available pool";
    this.postFinding({
      threadId: thread.id,
      fromRole: "director",
      summary: `Usage-aware routing chose ${providerLabel(chosen)} — ${status}`,
      detail: [
        `Workload reserve: ${demandSummary(demand)}.`,
        ...candidates.map((candidate) => describeProviderCapacity(candidate, demand)),
        assessment.status === "at-risk"
          ? "No visible provider had the full reserve. Reliable mid-task failover and reset auto-resume remain armed."
          : undefined,
      ].filter(Boolean).join("\n"),
      severity: assessment.status === "at-risk" ? "warning" : "info",
    });
  }

  // ---- concurrency queue ----

  attachCoworkWorkspaceGuard(isBusy: (workspace: string) => boolean): void {
    this.coworkWorkspaceBusy = isBusy;
  }

  /** Co-work asks before claiming a workspace. Query both the authoritative active slot set and the
   * visible task states because reviewer/fix lanes can own a live process outside an ordinary dispatch. */
  coworkTaskConflict(workspace: string): string | null {
    const key = normalizeWorkspace(workspace);
    const task = this.db.listThreads().find(
      (thread) =>
        normalizeWorkspace(thread.workspace) === key &&
        (this.activePipelines.has(thread.id) || COWORK_CONFLICT_STATES.has(thread.state)),
    );
    return task
      ? `Task "${task.title}" is already using this workspace (${task.state}). Wait for it to stop before starting a Co-worker turn.`
      : null;
  }

  /** A Co-worker turn just released its repository. Wake normal FIFO work that was held behind it. */
  coworkReleasedWorkspace(): void {
    this.recoverReleasedCapacity();
  }

  /** Start a freshly-dispatched task's pipeline now, or hold it in 'queued' if we're at the
   *  concurrency cap. Queued tasks start (FIFO) the moment a running pipeline settles. */
  private enqueueOrRun(threadId: string): void {
    const thread = this.db.getThread(threadId);
    // A shotgun COLLABORATOR is exempt from both concurrency caps, and this is a correctness
    // requirement rather than a preference: its lead is already holding a slot and is about to block
    // waiting for it, so queueing the collaborator behind a cap the lead itself occupies deadlocks the
    // pair outright (guaranteed at maxConcurrent=1, and reachable at any cap once enough tasks run).
    // The owner asked for N agents on this objective; the bound that keeps that honest is MAX_AGENTS at
    // the dispatch boundary, not a queue the parent is standing in front of. They still join
    // activePipelines, so unrelated dispatches see the real load.
    if (thread?.parentId) {
      this.startPipeline(threadId);
      return;
    }
    const globalFull = this.activePipelines.size >= this.settings().maxConcurrent;
    const coworkFull = !!thread && this.coworkWorkspaceBusy?.(thread.workspace) === true;
    const repoFull = !!thread && this.repoAtCapacity(thread.workspace);
    if (globalFull || repoFull) {
      if (!this.dispatchQueue.includes(threadId)) this.dispatchQueue.push(threadId);
      this.setState(threadId, "queued");
      const reason =
        coworkFull && !globalFull
          ? "a Co-worker turn is active in this repo"
          : repoFull && !globalFull
          ? `${this.activeCountForRepo(thread!.workspace)} task(s) already running in this repo (per-repo cap ${this.repoConcurrencyLimit()})`
          : `${this.activePipelines.size} pipeline(s) at the concurrency cap`;
      this.hub.log("info", `Task ${threadId.slice(0, 8)} queued — ${reason}.`);
      return;
    }
    this.startPipeline(threadId);
  }

  /** The operator's per-repo concurrency cap (0 = unlimited). Read live like the global cap so a change
   *  applies to the next pump without a restart. */
  private repoConcurrencyLimit(): number {
    return this.settingNum("setting_max_concurrent_per_repo", 0, 0, 20);
  }

  /** How many currently-running pipelines target the same repo as `workspace` (matched by normalized
   *  path, so "C:\\Repo\\" and "c:/repo" count as one repo). */
  private activeCountForRepo(workspace: string): number {
    const key = normalizeWorkspace(workspace);
    let n = 0;
    for (const id of this.activePipelines) {
      const t = this.db.getThread(id);
      if (t && normalizeWorkspace(t.workspace) === key) n++;
    }
    return n;
  }

  /** Whether starting another pipeline for `workspace` would exceed the per-repo cap. Always false when
   *  the cap is 0 (unlimited) — the global maxConcurrent is then the only gate. */
  private repoAtCapacity(workspace: string): boolean {
    if (this.coworkWorkspaceBusy?.(workspace)) return true;
    const limit = this.repoConcurrencyLimit();
    return limit > 0 && this.activeCountForRepo(workspace) >= limit;
  }

  /** Per-repo capacity check for a batch that SELECTS tasks before starting any of them (the token-reset
   *  resume): `pending` maps normalized workspace → count already chosen this pass, standing in for tasks
   *  not yet reflected in activePipelines. Use `repoAtCapacity` instead when each task is started inside
   *  the loop (a synchronous slot reserve means activeCountForRepo already sees the earlier ones). */
  private repoAtCapacityWith(workspace: string, pending: Map<string, number>): boolean {
    if (this.coworkWorkspaceBusy?.(workspace)) return true;
    const limit = this.repoConcurrencyLimit();
    if (limit <= 0) return false;
    const key = normalizeWorkspace(workspace);
    return this.activeCountForRepo(workspace) + (pending.get(key) ?? 0) >= limit;
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
    // Scan the FIFO queue rather than only peeling the head: a task blocked by its repo's per-repo cap
    // must NOT block a queued task for a DIFFERENT (free) repo behind it. startPipeline adds to
    // activePipelines synchronously (runPipeline reserves the slot before its first await), so both the
    // global count and the per-repo count reflect each just-started task on the next iteration.
    let i = 0;
    while (i < this.dispatchQueue.length && this.activePipelines.size < cap) {
      const id = this.dispatchQueue[i]!;
      const t = this.db.getThread(id);
      if (!t || t.state !== "queued") {
        this.dispatchQueue.splice(i, 1); // stale entry (cancelled/dismissed while waiting) — drop it
        continue;
      }
      if (this.repoAtCapacity(t.workspace)) {
        i++; // this repo is at its cap — leave the task queued and try the next one
        continue;
      }
      this.dispatchQueue.splice(i, 1);
      this.startPipeline(id);
    }
  }

  /** A cap park can be written while its current pipeline still owns the last concurrency slot. Recheck
   * immediately after any slot release so already-viable fallback capacity is not stranded until the
   * periodic supervisor sweep. FIFO queued work gets first claim; the cap supervisor fills what remains. */
  private recoverReleasedCapacity(): void {
    this.pumpQueue();
    this.resumeCapParked();
  }

  private dropFromQueue(threadId: string): void {
    const i = this.dispatchQueue.indexOf(threadId);
    if (i >= 0) this.dispatchQueue.splice(i, 1);
  }

  /** Wrap a role's kickoff text with the thread's pasted images so each isolated agent sees them. */
  /** A collaborator's ownership block, held from the moment its lead spawned it until its own pipeline
   *  composes a kickoff. In-memory only by design: it is re-derivable from the persisted `assignment`
   *  (see `collaboratorOwnershipBlock`), so a restart rebuilds it rather than depending on this map. */
  private readonly shotgunOwnership = new Map<string, string>();

  /** The ownership contract folded into a collaborator's kickoff — from the live map when its lead is
   *  still in the same process, else rebuilt from its own persisted share plus its siblings'. Ownership
   *  is the ONLY thing keeping parallel agents out of each other's files, so it must survive a restart. */
  private collaboratorOwnershipBlock(thread: Thread): string | undefined {
    if (!thread.parentId || !thread.assignment) return undefined;
    const held = this.shotgunOwnership.get(thread.id);
    if (held) return held;
    const siblings = this.db
      .listCollaborators(thread.parentId)
      .filter((t) => t.id !== thread.id && t.assignment)
      .map((t) => ({ title: t.assignment!.title, files: t.assignment!.files }));
    const lead = this.db.getThread(thread.parentId);
    const leadShare = this.db.getThreadStageOutputs(thread.parentId).shotgunAssignment;
    if (lead && leadShare) siblings.unshift({ title: leadShare.title, files: leadShare.files });
    return ownershipBlock(thread.assignment, siblings);
  }

  /** Rehydrate images from their durable feed attachments after a server restart. In-memory blocks are
   *  preferred while this process owns the task, so an ordinary hand-off doesn't send the same image
   *  twice. A reader escalation then carries the original screenshots into the selected normal route,
   *  including when a restart landed between the reader finding and the promoted implementor. */
  private persistedImageBlocks(threadId: string): ImageBlock[] {
    const seen = new Set<string>();
    const blocks: ImageBlock[] = [];
    for (const message of this.db.listMessages(threadId)) {
      for (const ref of message.attachments ?? []) {
        if (seen.has(ref.id) || !IMAGE_MEDIA_TYPES.has(ref.mediaType as ImageAttachment["mediaType"])) continue;
        seen.add(ref.id);
        const attachment = this.db.getAttachment(ref.id);
        if (!attachment || !IMAGE_MEDIA_TYPES.has(attachment.mediaType as ImageAttachment["mediaType"])) continue;
        blocks.push(toImageBlock({ name: attachment.name, mediaType: attachment.mediaType as ImageAttachment["mediaType"], dataBase64: attachment.data }));
      }
    }
    return blocks;
  }

  private attachmentImageBlocks(attachmentIds: string[] | undefined): ImageBlock[] {
    const seen = new Set<string>();
    const blocks: ImageBlock[] = [];
    for (const id of attachmentIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const attachment = this.db.getAttachment(id);
      if (!attachment || !IMAGE_MEDIA_TYPES.has(attachment.mediaType as ImageAttachment["mediaType"])) continue;
      blocks.push(toImageBlock({ name: attachment.name, mediaType: attachment.mediaType as ImageAttachment["mediaType"], dataBase64: attachment.data }));
    }
    return blocks;
  }

  private kickoffContent(threadId: string, text: string, extraImages: ImageBlock[] = []): UserContent {
    const inMemory = [...(this.dispatchImages.get(threadId) ?? []), ...(this.threadImages.get(threadId) ?? [])];
    const base = inMemory.length ? inMemory : this.persistedImageBlocks(threadId);
    return contentWithImages(text, uniqueImageBlocks([...base, ...extraImages]));
  }

  private implementorStartContent(
    threadId: string,
    resumeKickoff: string,
    freshKickoff: string,
    resume: boolean,
    images: ImageBlock[] = [],
  ): UserContent {
    return resume ? contentWithImages(resumeKickoff, images) : this.kickoffContent(threadId, freshKickoff, images);
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
        execFile("git", ["-C", t.workspace, "--no-pager", ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
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
    const current = this.db.getThread(threadId);
    // A provider can finish unwinding after its deadline stop and try to publish the stage it was
    // heading toward. Keep the durable deadline park authoritative against every such stale write.
    // Cancel/close remain available to the operator; a deliberate Resume first removes the marker.
    if (this.deadlineParked(current) && state !== "cancelled" && state !== "closed") {
      this.hub.log("warn", `Ignored stale ${state} transition for deadline-parked task ${threadId.slice(0, 8)}.`);
      return;
    }
    if (["review", "done", "cancelled", "paused", "closed"].includes(state)) {
      this.db.abandonAutoReview(
        threadId,
        error?.trim() || `Auto-review stopped because the task moved to ${state}.`,
      );
    }
    const t = this.db.updateThread(threadId, { state, error: error ?? null });
    if (!t) return;
    this.publishState(t);
  }

  /** Publish and apply side effects for a state row already written transactionally by the DB. The
   * auto-review lock/verdict and task transition therefore commit together without bypassing normal
   * owner notices, terminal cleanup, or model grading. */
  private publishState(t: Thread): void {
    this.hub.publish({ type: "thread.upsert", thread: t });
    if (t.state === "done") {
      this.notifyOwner(`✓ done: "${t.title}"`, { kind: "done", title: t.title, repo: t.workspace });
      void this.announceDone(t);
    }
    // A cap-park lands in 'review' too, but it's auto-handled by the supervisor — don't ping "needs your
    // review" (misleading, and it would re-fire every time a re-capping task re-parks).
    else if (t.state === "review" && !(t.error ?? "").startsWith(CAP_PARK_PREFIX))
      this.notifyOwner(`⚠ needs your review: "${t.title}"`, { kind: "input", title: t.title, detail: t.error, repo: t.workspace });
    else if (t.state === "failed")
      this.notifyOwner(`✗ failed: "${t.title}"${t.error ? ` — ${t.error}` : ""}`, { kind: "failed", title: t.title, detail: t.error, repo: t.workspace });
    // Truly-terminal states never resume under the same in-memory identity, so drop the per-thread
    // bookkeeping that must outlive the pipeline LOOP (so a parked task can still resume) but has no
    // reason to outlive the process. Deliberately EXCLUDES 'failed' (a transient state the pipeline
    // re-enters on cap/token/boot resume) and the parked states (review/paused stay resumable).
    if (t.state === "done" || t.state === "cancelled") {
      this.disarmActiveDeadline(t.id);
      this.dropTerminalBookkeeping(t.id);
    }
    // Score how an auto-selected model handled this task, so the next selection knows. Reads the FRESH
    // thread row (it carries the error text a cap-park is recognised by) and no-ops for every other task.
    this.gradeAutoSelectedModel(t);
  }

  /** Voice mode: speak a task-tailored completion line through the gateway. completionAnnouncement
   *  returns null when voice mode is off (gateway down or mic toggled off) — nothing is published or spent. */
  private async announceDone(t: Thread): Promise<void> {
    const text = await completionAnnouncement(t, this.accounts.auxToken()).catch(() => null);
    if (text) this.hub.publish({ type: "voice.announce", threadId: t.id, text });
  }

  /** Settle a task to 'review' after an incomplete run. If the run gave up ONLY because every provider
   *  was capped (the `capParked` flag), tag it with the CAP_PARK marker so the supervisor auto-resumes
   *  it when an account frees up; otherwise use the human-facing reason (a genuine needs-your-eyes park).
   *  The flag is consumed here so it never leaks into an unrelated later settle of the same thread. */
  private settleReview(threadId: string, humanReason: string): void {
    const need = this.capParked.get(threadId);
    this.capParked.delete(threadId);
    if (need) {
      this.setState(threadId, "review", this.capParkMessage(threadId, need));
      this.armCapResumeWake();
    } else this.setState(threadId, "review", humanReason);
  }

  /** Record an exhausted fallback ladder in the shared role runner. This keeps quota failures in every
   * pipeline stage resumable, rather than letting a non-QA stage silently degrade to partial context. */
  private parkForExhaustedProviders(threadId: string, role: StructuredRole | "implementor"): void {
    if (role === "reviewer") return; // auto-review is owner-initiated, not part of the resumable pipeline
    this.capParked.set(threadId, role);
  }

  /** Auto-review is owner-triggered and deliberately does not join the pipeline cap supervisor. Refuse
   * a known-doomed reviewer dispatch, but leave a precise finding so the owner knows when to click again. */
  private noteManualCapacityWait(thread: Thread, role: "reviewer", demand: CapacityDemand, now = Date.now()): string {
    const { options, ready, nextAt: next } = this.roleCapacitySnapshot(role, demand, now);
    const when = ready.length
      ? `${ready.map((option) => option.label).join(", ")} has viable reviewer capacity now; retry Auto-review.`
      : next != null
        ? `The next viable reviewer pool is expected ${formatUntil(next, now)} (${new Date(next).toLocaleString()}).`
        : "No reliable reviewer reset time is available yet; live meters are still polled.";
    const checked = options.length
      ? options.map((option) => describeRoutingCapacity(option, demand, now)).join("; ")
      : "No enabled, authenticated reviewer provider is available.";
    const why = ready.length
      ? "Auto-review's prior provider became unavailable before the turn started."
      : `Auto-review did not start because no compatible pool has safe runway for ${demandSummary(demand)}.`;
    const detail = `${why} ${when} Capacity checked: ${checked} The task remains in review.`;
    this.postFinding({
      threadId: thread.id,
      fromRole: "reviewer",
      summary: "Auto-review is waiting for safe quota runway",
      detail,
      severity: "warning",
    });
    return detail;
  }

  /** Review message for a cap-park — doubles as the supervisor's marker (CAP_PARK_PREFIX, plus the
   *  historical CAP_PARK_QA_MARK for QA-stage parks) and tells the owner it'll resume itself, naming when
   *  the soonest account frees up if we know it. Scoped honestly: it only claims "every account" when
   *  CLI backends were genuinely unavailable too (Claude→Codex/Grok failover already tried them). */
  private capParkMessage(threadId: string, need: CapParkStage): string {
    const now = Date.now();
    const thread = this.db.getThread(threadId);
    const demand = thread ? this.capacityDemand(thread, need) : demandForRole(need);
    const snapshot: RoleCapacitySnapshot & { error?: string } = thread
      ? this.capacitySnapshotForThread(thread, need, demand, now)
      : this.roleCapacitySnapshot(need, demand, now);
    const { options, ready, nextAt: next, error } = snapshot;
    const startupCooling = options.filter((option) => option.windows.some((window) =>
      window.label === STARTUP_HEALTH_COOLDOWN_LABEL &&
      window.usedPct === 100 &&
      (window.resetAt == null || window.resetAt > now),
    ));
    const hardReady = options.filter((option) => option.hasHeadroom);
    const runwayBlocked =
      demand.substantial &&
      hardReady.length > 0 &&
      hardReady.every((option) => assessCapacity(option.windows, demand, now).status === "at-risk");
    const when = ready.length
      ? ` ${ready.map((option) => option.label).join(", ")} has viable capacity now; recovery will start as soon as a pipeline slot is available.`
      : next != null
        ? ` Next viable capacity is expected ${formatUntil(next, now)} (${new Date(next).toLocaleString()}).`
        : " No reliable reset time is available yet; live meters are still polled.";
    const stage = need === "qa" ? `QA ${CAP_PARK_QA_MARK}` : `${need} (${need} stage)`;
    const reason = error
      ? `${stage} cannot use its strict requested model: ${error}`
      : ready.length
      ? `${stage} is waiting to recover after its prior provider capped`
      : startupCooling.length
        ? `${stage} is waiting for the ${startupCooling.map((option) => option.label).join(", ")} startup health cooldown`
      : runwayBlocked
        ? `no compatible pool has enough safe runway for ${demandSummary(demand)} during ${stage}`
        : `all compatible capacity is currently capped for ${stage}`;
    const status = options.length
      ? ` Capacity checked: ${options.map((option) => describeRoutingCapacity(option, demand, now)).join("; ")}.`
      : " No enabled, authenticated provider can serve this stage.";
    const recovery = thread?.modelRequest
      ? ` It will resume automatically only when the exact requested model ${thread.modelRequest.model ?? thread.modelRequest.requested} becomes viable; no fallback model is allowed.`
      : " It will resume automatically when a compatible pool becomes viable (no manual Resume needed).";
    return `${CAP_PARK_PREFIX} — ${reason}.${when}${recovery}${status}`;
  }

  /** An event the OWNER personally cares about: a task finished, needs their input, or failed. Goes to
   *  the webhook like any other ping AND — when the toggle is on — to their Discord channel, so it
   *  reaches their phone. Everything else notifyExternal carries is pipeline chatter (cap failover,
   *  account resume) and stays off the phone deliberately; use plain notifyExternal for those. */
  private notifyOwner(text: string, notice: OwnerNotice): void {
    this.notifyExternal(text);
    this.discord.notify(notice);
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

  /** The supervisor must not create a false "sent" record while Phone notifications is off or incomplete. */
  supervisorDiscordReady(): boolean {
    return this.settingBool("setting_discord_notify", false) && !!this.discordBotToken() && !!this.discordChannelId();
  }

  /** Supervisor corrections are urgent steering, not recovery. Only send one if ThreadManager currently
   *  has a live/materializing recipient that the normal injection gates know how to reach. */
  async injectSupervisorCorrection(threadId: string, message: string): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "Task no longer exists." };
    if (thread.state === "cancelled" || thread.state === "closed") {
      return { ok: false, state: thread.state, error: "Task is no longer active." };
    }
    const reachable =
      this.live.has(threadId) ||
      this.liveRole.has(threadId) ||
      this.liveQa.has(threadId) ||
      this.liveReviewer.has(threadId) ||
      this.resuming.has(threadId) ||
      this.reviewing.has(threadId) ||
      this.selfImproving.has(threadId);
    if (!reachable) {
      return { ok: false, state: thread.state, error: "No live agent remains to receive the correction." };
    }
    return this.injectThread(threadId, message, "interrupt");
  }

  /** An authenticated Supervisor-chat instruction uses the ordinary task injection machinery but is
   * not a new objective, so it must not auto-retitle the lane. The conversational supervisor has no
   * direct runner access; this is its only steering seam. */
  canInjectSupervisorInstruction(threadId: string): boolean {
    const thread = this.db.getThread(threadId);
    if (!thread || !["planning", "researching", "implementing", "qa", "reviewing"].includes(thread.state)) return false;
    return (
      this.live.has(threadId) ||
      this.liveRole.has(threadId) ||
      this.liveQa.has(threadId) ||
      this.liveReviewer.has(threadId) ||
      this.resuming.has(threadId) ||
      this.reviewing.has(threadId) ||
      this.selfImproving.has(threadId) ||
      (thread.state === "qa" && (this.qaFixHandoff.has(threadId) || !!this.qaFixHandoffPayload(threadId)))
    );
  }

  async injectSupervisorInstruction(
    threadId: string,
    message: string,
    mode: "append" | "interrupt" | "queue",
    options: { liveOnly?: boolean } = {},
  ): Promise<ThreadActionResult> {
    if (options.liveOnly && !this.canInjectSupervisorInstruction(threadId)) {
      return {
        ok: false,
        state: this.db.getThread(threadId)?.state,
        error: "No live task session remains to receive this board-wide instruction; it was not cold-resumed.",
      };
    }
    return this.injectThread(threadId, `Supervisor instruction from the owner: ${message}`, mode, undefined, { retitle: false });
  }

  /** Supervisor notices are Discord-only. They never spill into the generic webhook while the separately
   *  configured Phone notifications toggle is disabled. */
  notifySupervisor(kind: "done" | "input" | "failed", title: string, detail?: string, repo?: string): void {
    this.discord.notify({ kind, title: title.startsWith("Supervisor:") ? title : `Supervisor: ${title}`, detail, repo });
  }

  /** The supervisor's live snapshot for the console (WS hello + the supervisor.* broadcast). */
  supervisorSnapshot(): SupervisorSnapshot {
    return this.supervisor.snapshot();
  }

  /** An explicit "run now" from the console — one immediate pass over every current candidate task. */
  async supervisorRunNow(): Promise<void> {
    await this.supervisor.runManualNow();
  }

  /** Explicit task-supervision chat. Persistence and asynchronous execution live in DirectorSupervisor;
   * the WS handler returns immediately after the pending turn has been broadcast. */
  supervisorSendMessage(content: string, targetIds: string[], turnId?: string): void {
    this.supervisor.sendChatMessage(content, targetIds, turnId);
  }

  private cancelled(threadId: string): boolean {
    const thread = this.db.getThread(threadId);
    if (thread?.state === "cancelled" || this.deadlineParked(thread)) return true;
    if (this.deadlineDue(thread)) {
      // The durable state flip happens synchronously before expireActiveDeadline's first await. Calling
      // it from a boundary check therefore closes the tiny gap if an OS-delayed timer has not fired yet.
      void this.expireActiveDeadline(threadId, thread!.activeDeadlineAt!);
      return true;
    }
    return false;
  }

  /**
   * The agent-routed pipeline has no compulsory planner/QA sequence. A deterministic route pick decides
   * whether this task needs planning and/or QA; the implementor is the only required change/build role.
   * When selected, the planner routes to researcher-or-implementor and QA can bounce fixes; otherwise a
   * clean implementor result settles directly. Common shapes are
   *   implementor | implementor → QA | planner → [researcher →] implementor → QA → ….
   *
   * It is also resume-aware: every completed stage is persisted (updateThreadStageOutputs), so a
   * task that died mid-pipeline re-enters here (via resumeThread on a 'failed' thread) and skips
   * the stages already done — feeding their saved outputs forward — instead of starting over. A
   * fresh dispatch simply finds no saved stages and runs them all.
   */
  private async runPipeline(threadId: string, directorNote?: string): Promise<void> {
    let thread = this.db.getThread(threadId);
    if (!thread || this.cancelled(threadId)) return;
    thread = this.ensureThreadModelRequest(thread);
    const slotToken = Symbol("pipeline");
    this.activePipelines.add(threadId);
    this.activePipelineToken.set(threadId, slotToken);
    const releaseSlot = () => {
      // Superseded by a newer pipeline for this thread (cancel→retry within our unwind window)? It owns
      // the slot now — a stale finalizer deleting its entry would under-count the concurrency gate.
      if (this.activePipelineToken.get(threadId) !== slotToken) return;
      this.activePipelineToken.delete(threadId);
      this.activePipelines.delete(threadId);
      this.recoverReleasedCapacity();
    };
    // The slot above is the task's first real opportunity to work. Stamp the durable deadline here,
    // not at dispatch, so time spent queued behind other pipelines never eats an owner's work window.
    thread = this.activateTimedWindow(thread);
    if (!existsSync(thread.workspace)) {
      this.setState(threadId, "failed", `Workspace "${thread.workspace}" does not exist on disk — agents can't run there. Re-dispatch with a valid path.`);
      releaseSlot();
      return;
    }
    const settings = this.settings();
    const saved = this.db.getThreadStageOutputs(threadId);
    try {
      // Read lane (dispatch_read): short-circuit the normal task-aware implementation route to a single
      // read-only reader stage. readerDone (mirroring planDone) makes the answer sticky across resume, so
      // a server restart mid-read can't re-run the reader and double-post the answer. releaseSlot still
      // runs in `finally`. An ESCALATION is not a dead end: handleReadLane promotes the task in place
      // (clears the lane, folds the reader's evidence into the brief) and returns the updated thread so
      // this SAME run falls through into the normal pipeline below — no new dispatch, no click required.
      if (thread.lane === "read") {
        const promoted = await this.handleReadLane(thread, directorNote, saved);
        if (!promoted) return; // answered / errored / unrecoverable restart — already settled by finalizeReader
        thread = promoted;
      }

      // A persisted kickoff means this task already cleared the whole pre-implementor phase (planner +
      // any researcher + approval) in an earlier run and reached the implementor. A resume must NOT
      // re-run the planner/researcher and clobber that work — not even if an older build never persisted
      // planDone (the exact "planner re-ran after a restart" bug). So treat planning as settled whenever
      // a kickoff exists, independent of the per-stage *Done flags.
      // A shotgun COLLABORATOR arrives with its objective already decided by the lead's decomposition,
      // so it skips planning entirely (re-planning a share would just re-derive what it was handed) and
      // runs WITHOUT its own QA loop. That second part is the important one: a per-share QA would review
      // a deliberately partial tree — the other shares are half-written around it — and spend rounds
      // bouncing back "incomplete" work that is complete for this share. The lead reconciles every share
      // and ONE QA pass reviews the combined result.
      const collaborator = !!thread.parentId;
      const planningSettled = saved.kickoff != null || collaborator;

      // Task-aware route: whether THIS task benefits from the planner and/or QA, independent of whether
      // those roles are enabled below (enabled = available, not mandatory — routeSelection.ts). Skipped
      // for a collaborator — its planner/QA gates are already forced by `collaborator` regardless.
      const route = collaborator ? undefined : this.resolveRoute(thread, settings);

      // 1. Planner — runs first unless disabled, routed around, already done, or planning already
      // completed. planDone (mirrors researchDone) makes a deliberate "no structured plan" outcome sticky
      // across resume. When the planner doesn't run the implementor works straight from the brief
      // (composeKickoff notes it).
      let plan = saved.plan ?? undefined;
      if (!planningSettled && !saved.planDone) {
        if (settings.plannerEnabled && (route?.usePlanner ?? true)) {
          this.setState(threadId, "planning");
          plan = await this.runPlanner(thread).catch((e) => {
            this.hub.log("warn", `Planner failed on ${threadId.slice(0, 8)}: ${String(e)}`);
            return undefined;
          });
          if (this.cancelled(threadId)) return;
          // A quota-exhausted planner did not complete a deliberate "no plan" outcome. Preserve the
          // unfinished stage and park it with the durable cap marker, so the supervisor retries this
          // exact stage after a provider frees up instead of sending an implementor a fabricated blank plan.
          if (this.capParked.has(threadId)) {
            this.settleReview(threadId, "Planner could not complete — needs your review.");
            return;
          }
        } else {
          this.hub.log(
            "info",
            `Planner ${settings.plannerEnabled ? "routed around (narrow task)" : "disabled"} — ${threadId.slice(0, 8)} skips planning, straight to the implementor.`,
          );
        }
        // Persist planDone even when the planner was SKIPPED (disabled or routed around), so a later
        // resume — including one after the toggle is flipped back on — never re-runs it.
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
        // Same invariant as planning: quota exhaustion is not a valid empty research result and must
        // resume before the implementor sees the handoff.
        if (this.capParked.has(threadId)) {
          this.settleReview(threadId, "Researcher could not complete — needs your review.");
          return;
        }
        this.db.updateThreadStageOutputs(threadId, { research: research ?? null, researchDone: true });
      }

      // 3. Approval gate — after the full context (plan + any research) exists, so the human sees
      //    everything before approving. Skipped on resume if already approved. Reuse the saved kickoff
      //    when planning already happened so a re-derivation can't strip a real plan down to "no plan".
      const qaEnabled =
        settings.qaEnabled &&
        (route?.useQa ?? true) &&
        !collaborator &&
        !this.qaBypassedByOwner(threadId);
      const plannerRuns = settings.plannerEnabled && (route?.usePlanner ?? true) && !collaborator;
      let kickoff = saved.kickoff ?? composeKickoff(thread, plan, research, { autoPush: settings.autoPush, qaEnabled, plannerRuns, route });
      // Ownership is what keeps parallel agents out of each other's files, so it is rebuilt here (from
      // the persisted share) rather than only at spawn time — a collaborator revived by a restart must
      // be handed exactly the same contract, not a kickoff that has quietly lost it.
      if (collaborator) {
        const owned = this.collaboratorOwnershipBlock(thread);
        if (owned) kickoff = `${kickoff}\n\n${owned}`;
      }
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
      // A timed task tells its implementor about the window up front, so it plans work that fits rather
      // than racing to a finish and being asked for more. Composed once and persisted with the kickoff;
      // every later round carries its own live countdown in the extension directive.
      const window = this.timedWindowFor(thread);
      if (window && !saved.kickoff) kickoff = `${kickoff}\n\n${timedBriefBlock(window, Date.now())}`;

      // 4. Shotgun — decide the split ONCE, spawn the collaborators, and narrow this (lead) kickoff to
      //    its own share. A no-op for an ordinary task, a collaborator, or a task that can't be split
      //    safely; in the last case it degrades to a normal single-agent run and says why.
      kickoff = await this.prepareShotgun(thread, plan, kickoff);
      if (this.cancelled(threadId)) return;
      const prepared = this.db.getThreadStageOutputs(threadId);
      if (prepared.shotgunRecoveryBlocked) {
        this.settleReview(threadId, prepared.shotgunRecoveryBlocked);
        return;
      }
      // Planning/decomposition can use the whole short window. Never start a first implementor after
      // its deadline — including a collaborator that was committed safely but only got a CPU slot after
      // the shared deadline elapsed. Existing implementation still follows its normal final path.
      const hasImplementation = this.db.listRuns(threadId).some((run) => run.role === "implementor");
      const activeWindow = this.timedWindowFor(this.db.getThread(threadId) ?? thread);
      if (!hasImplementation && activeWindow && activeWindow.deadlineAt <= Date.now()) {
        const reason = prepared.shotgunDegraded ?? "The timed work window ended before implementation could start.";
        if (!prepared.timedFinalizing) this.closeTimedWindow(thread, { reason, extensions: prepared.timedExtensions ?? 0 });
        this.settleReview(threadId, reason);
        return;
      }
      if (this.capParked.has(threadId)) {
        this.settleReview(threadId, "Splitting the task across agents could not complete — needs your review.");
        return;
      }
      this.db.updateThreadStageOutputs(threadId, { kickoff });

      // 5. Implementor → QA. On resume, pick up the implementor's prior SDK session (recovered from
      //    its agent_run, which survives a restart) so its work-in-progress isn't thrown away.
      //    Any director notes injected after the planner finished (during research or at the approval
      //    gate, where there was no planner to re-plan) are folded in here so they still reach the
      //    implementor instead of being dropped.
      const buffered = this.directorNotes.get(threadId);
      this.directorNotes.delete(threadId);
      const rawNote = [directorNote, ...(buffered ?? [])].filter((s): s is string => Boolean(s)).join("\n\n");
      const note = rawNote ? acknowledgedInjection(rawNote) : undefined;
      // Pick the implementor model only when implementation will actually run. A capped or
      // restart-interrupted QA retry has durable completed implementation, so an extra model-selection
      // call would waste a provider turn and could itself derail the handoff.
      if (saved.qaCapRetryRound == null && saved.qaInterruptedRetryRound == null && saved.qaFixHandoff == null) await this.autoSelectModel(thread, plan);
      if (this.cancelled(threadId)) return;
      await this.runImplementorQa(thread, kickoff, this.implementorEffort(threadId, plan?.effort), this.latestImplementorSession(threadId), note, {
        qaEnabled,
        maxQaRounds: settings.maxQaRounds,
        qaAppliesFixes: settings.qaAppliesFixes,
        autoPush: settings.autoPush,
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

  /** Task-aware pipeline route (routeSelection.ts): whether THIS task benefits from the planner and/or
   *  QA, independent of whether those roles are enabled (the settings gates AND this at each call site).
   *  Sticky — computed and announced once per pipeline episode, then read back from stage_outputs on
   *  every later resume so a task can't reclassify mid-episode. A reader escalation contributes evidence
   *  to the same task-aware classifier; it is not a blanket full-route override. The original brief is
   *  preserved in readerEscalation so our appended handoff prose cannot falsely broaden a narrow edit.
   */
  private resolveRoute(thread: Thread, settings: OrchestratorSettings): RouteDecision {
    const existing = this.db.getThreadStageOutputs(thread.id).routeDecision;
    if (existing) return existing;
    // Keep reader evidence through a manual Retry too. A retry clears its route decision, but the
    // reader's conclusion is still part of the same user task and must not be mistaken for broad work
    // merely because its handoff prose was appended to the brief.
    const readerEscalation = this.db.getThreadStageOutputs(thread.id).readerEscalation;
    if (readerEscalation) {
      const decision = selectRoute({
        title: thread.title,
        brief: readerEscalation.originalBrief ?? thread.brief,
        shotgun: (thread.agentCount ?? 1) > 1,
        timedHours: thread.durationMs ? thread.durationMs / 3_600_000 : undefined,
        effortOverride: thread.effortOverride,
        readerEscalation,
      });
      this.db.updateThreadStageOutputs(thread.id, { routeDecision: decision });
      this.announceRoute(thread.id, decision, settings);
      return decision;
    }
    const decision = selectRoute({
      title: thread.title,
      brief: thread.brief,
      shotgun: (thread.agentCount ?? 1) > 1,
      timedHours: thread.durationMs ? thread.durationMs / 3_600_000 : undefined,
      effortOverride: thread.effortOverride,
    });
    this.db.updateThreadStageOutputs(thread.id, { routeDecision: decision });
    this.announceRoute(thread.id, decision, settings);
    return decision;
  }

  /** Post the route pick into the thread's own history (a system feed message, like an inject/queue
   *  note) so it's visible to the owner as a deliberate choice, not a silent omission — separately
   *  naming the route's own verdict and whatever the operator's global toggles further restrict, since
   *  the two can diverge (route wants QA, but QA is globally disabled). */
  private announceRoute(threadId: string, decision: RouteDecision, settings: OrchestratorSettings): void {
    const planner = !settings.plannerEnabled
      ? "no planning (disabled in settings)"
      : decision.usePlanner
        ? "planning"
        : "no planning (routed straight to the implementor)";
    const qa = !settings.qaEnabled ? "no QA (disabled in settings)" : decision.useQa ? "QA" : "no QA (implementor output is final)";
    const m = this.db.addMessage({
      threadId,
      role: "director",
      kind: "system",
      content: `🧭 Route selected — ${planner}, ${qa}. ${decision.reason}`,
    });
    this.hub.publish({ type: "thread.message", threadId, message: m });
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
    return this.latestRoleRun(threadId, "implementor")?.provider;
  }

  /** The most recent run of a role that left a session id, with the backend it ran on. Latest-by-startedAt
   *  handles failover (one role, several runs): we want the session the role was actually on when it
   *  stopped. Sourced from the DB, so it survives a restart — that is the whole point of a resume. */
  private latestRoleRun(threadId: string, role: Role): RoleSession | undefined {
    const run = this.db
      .listRuns(threadId)
      .filter((r) => r.role === role && r.sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!run?.sessionId) return undefined;
    return { sessionId: run.sessionId, provider: providerOfRunAccount(run.account) };
  }

  /** The most recent QA run that has a session id (any backend), so fix-rounds 2..N can resume it. */
  private latestQaRun(threadId: string): RoleSession | undefined {
    return this.latestRoleRun(threadId, "qa");
  }

  /** The most recent QA run's session id (any backend). Prefer `latestQaRun` when the provider matters. */
  private latestQaSession(threadId: string): string | undefined {
    return this.latestQaRun(threadId)?.sessionId;
  }

  /**
   * Give ONE confidently-small, first-attempt read-only stage to the authenticated free pool before
   * spending a subscription turn. Classification and quota admission live behind FreeProviderService's
   * only lease seam, so broad/uncertain work and every retry/continuation fail closed to the reliable
   * ladder. Any malformed result, quota rejection, tool failure, or outage records a failed free run and
   * returns control to the exact Claude/Codex/Grok/z.ai selection and failover path that already existed.
   */
  private async tryFreeStructuredRole(
    thread: Thread,
    role: "planner" | "reader",
    kickoff: string | unknown[],
    makeCfg: (ctx: { token: string | undefined; resume?: string; runId: string }) => AgentRunConfig,
  ): Promise<ResultEvent | undefined> {
    if (!this.freeProviders || this.cancelled(thread.id)) return undefined;
    const routed = await this.freeProviders.routeTask({
      role,
      lane: thread.lane,
      title: thread.title,
      brief: thread.brief,
      rawPrompt: thread.rawPrompt,
      effortOverride: thread.effortOverride,
      priorRoleRuns: this.db.listRuns(thread.id).filter((candidate) => candidate.role === role).length,
      hasAttachments: typeof kickoff !== "string",
    }).catch((error) => {
      this.hub.log("warn", `Free-provider policy check failed for ${thread.id.slice(0, 8)} ${role}: ${String(error)} — using the reliable provider ladder.`);
      return null;
    });
    if (!routed) return undefined;
    if (!routed.session) {
      // The policy runs even while the pool is off, but logging every ordinary task in that state would
      // be noise. Once the owner opts in, one line per eligible role explains every select/skip decision.
      if (routed.poolEnabled) {
        const action = routed.policy.eligible ? "unavailable after small-task admission" : `skipped (${routed.policy.size})`;
        this.hub.log(
          "info",
          `Free pool ${action} for ${thread.id.slice(0, 8)} ${role}: ${routed.availabilityReason ?? routed.policy.reason} Reliable routing continues.`,
        );
      }
      return undefined;
    }
    if (typeof kickoff !== "string") return undefined; // policy currently rejects this before leasing
    const session = routed.session;

    const run = this.db.createRun({
      threadId: thread.id,
      role,
      model: session.target.model,
      account: `free:${session.target.providerId}`,
    });
    this.emitRun(run.id);
    this.hub.log(
      "info",
      `Free small-task policy selected ${session.target.providerName}/${session.target.model} for ${thread.id.slice(0, 8)} ${role}: ${routed.policy.reason}`,
    );
    this.postFinding({
      threadId: thread.id,
      fromRole: "director",
      summary: `Small-task policy routed ${role} to ${session.target.providerName}'s free allowance`,
      detail: `${routed.policy.reason}\n\nFirst attempt only; bounded to ${config.freeTaskPolicy.maxModelCalls} model calls, ${config.freeTaskPolicy.maxToolCalls} tool calls, and ${config.freeTaskPolicy.maxTotalTokens} reported tokens. Any failure continues automatically on the reliable provider ladder.`,
      severity: "info",
    });
    const cfg = makeCfg({ token: undefined, runId: run.id });
    if (typeof cfg.systemPrompt !== "string" || !cfg.outputFormat?.schema) {
      session.close();
      this.db.updateRun(run.id, { state: "error", error: "Role is not compatible with the bounded free-provider harness.", endedAt: Date.now() });
      this.emitRun(run.id);
      return undefined;
    }

    const agent = new FreeProviderAgentRun(session, role, cfg, {
      postFinding: ({ summary, detail, severity }) => {
        const finding = this.postFinding({
          threadId: thread.id,
          fromRole: role,
          fromRunId: run.id,
          summary,
          detail: detail ?? null,
          severity,
        });
        return `Finding recorded (${finding.severity}): ${finding.summary}`;
      },
    });
    this.wireRun(agent, thread.id, run.id, role, `free:${session.target.providerId}`);
    this.track(thread.id, agent);
    this.officeCheckIn(thread.id, role);
    this.ensureGroup(thread.id);
    if (role === "planner") this.liveRole.set(thread.id, agent);
    agent.start(this.communicationContent(kickoff));
    let result = await agent.result();
    // A note arriving during this run changes the remaining work. Do not spend another free completion
    // revising the plan: leave the durable note buffered and let runRole's reliable path absorb it once.
    const needsReliableContinuation = role === "planner" && !!result && !result.isError && !!this.directorNotes.get(thread.id)?.length;
    if (role === "planner") this.liveRole.delete(thread.id);

    // A reader's structured `answered:true` is not enough: its finding is the actual user-facing answer.
    // Fail over if a model skipped the side effect instead of falsely settling the task as answered.
    if (role === "reader" && result && !result.isError) {
      const posted = this.db.listFindings(thread.id).some((finding) => finding.fromRunId === run.id);
      if (!posted) {
        result = {
          type: "result",
          subtype: "error_free_provider",
          isError: true,
          result: "The free reader returned a disposition without posting its answer finding.",
          errors: ["The free reader returned a disposition without posting its answer finding."],
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          tokenUsage: result.tokenUsage,
        };
        session.markHarnessFailure(result.result ?? "Reader finding missing.");
      }
    }

    await agent.stop();
    this.untrack(thread.id, agent);
    this.finishRun(run.id, result, agent);
    if (result && !result.isError && !needsReliableContinuation) return result;

    if (needsReliableContinuation) {
      this.hub.log("info", `Free planner for ${thread.id.slice(0, 8)} completed its initial result, but new steering requires a continuation — preserving free quota and re-planning once on the reliable ladder.`);
      this.postFinding({
        threadId: thread.id,
        fromRole: "planner",
        fromRunId: run.id,
        summary: "New steering moved the planner continuation to a reliable provider",
        detail: "The free planner completed its bounded first attempt. A note arrived while it ran, so the orchestrator preserved the free allowance and will incorporate that note in a fresh reliable-provider plan instead of spending free quota on a continuation.",
        severity: "note",
      });
      return undefined;
    }

    this.postFinding({
      threadId: thread.id,
      fromRole: role,
      fromRunId: run.id,
      summary: `${session.target.providerName} could not finish the free ${role} run — falling back automatically`,
      detail: result ? runErrorText(result) : "The free-provider run ended without a result.",
      severity: "note",
    });
    return undefined;
  }

  /** Single construction seam for a structured-role agent. Keeping provider selection beside the
   * construction makes the fallback loop testable without starting a real subscription-backed process. */
  private createRoleAgent(_provider: ImplementorProvider, create: () => AgentRunLike): AgentRunLike {
    return create();
  }

  /** Run a one-shot role to a result. Usage caps switch Claude accounts as before. Transient provider
   *  failures retry three times, then planner/researcher/QA can continue on an enabled CLI backend.
   *  `opts.preferredProvider` starts the role on a CLI backend (e.g. warm-resuming a prior Grok QA
   *  session — session ids are not portable across providers). */
  private async runRole(
    thread: Thread,
    role: StructuredRole,
    kickoff: string | unknown[],
    makeCfg: (ctx: { token: string | undefined; resume?: string; runId: string }) => AgentRunConfig,
    initialResume?: string,
    opts?: { preferredProvider?: ImplementorProvider; forcedProvider?: ImplementorProvider },
  ): Promise<ResultEvent | undefined> {
    if (this.cancelled(thread.id)) return undefined;
    if (
      (role === "planner" || role === "reader") &&
      !initialResume &&
      !opts?.preferredProvider &&
      !opts?.forcedProvider
    ) {
      const freeResult = await this.tryFreeStructuredRole(thread, role, kickoff, makeCfg);
      if (freeResult) return freeResult;
    }
    let roleKickoff: string | unknown[] = kickoff;
    if (role === "planner") {
      const notes = this.directorNotes.get(thread.id);
      if (notes?.length) {
        this.directorNotes.delete(thread.id);
        roleKickoff = prependUserContent(
          roleKickoff,
          `[Director steering received before reliable planning]\n${notes.join("\n\n")}\n\nIncorporate this into the plan you produce now.`,
        );
      }
    }
    const demand = this.capacityDemand(thread, role);
    // Do not select (and potentially wake) a Claude account before the provider is known. Bounded
    // roles can start on an independently metered Codex pool; touching Claude here would spend the
    // staggered reserve even though the run never uses that subscription.
    let acct: Acct | undefined;
    let resume: string | undefined = initialResume;
    let message: string | unknown[] = roleKickoff;
    let provider: ImplementorProvider = "claude";
    // A configured account is a one-shot candidate after a cap. Do not impose an arbitrary small
    // counter here: deployments can legitimately have more than three Claude subscriptions. The set
    // also prevents a misbehaving selector from cycling us back onto a known-capped account.
    const triedClaudeAccounts = new Set<string>();
    let transientFailures = 0;
    const unavailableProviders = new Set<ImplementorProvider>();

    // Different-provider QA (or any caller that pins the backend): run this role on the chosen provider
    // outright, not just on the natural default. The caller resolved a ready backend, so we don't
    // pre-empt to a CLI on Claude exhaustion here — the standard mid-run failover below still applies if
    // the forced backend gets capped. `initialResume` is trusted to match the forced provider (the caller
    // drops it when the prior session was on a different backend).
    const forced = opts?.forcedProvider;
    const pref = opts?.preferredProvider;
    let routeNaturally = true;
    if (forced && providerServesRole(role, forced)) {
      provider = forced;
      routeNaturally = false;
    } else if (pref && pref !== "claude" && providerServesRole(role, pref)) {
      if (this.providerSafeForRole(pref, role, demand)) {
        provider = pref;
        routeNaturally = false;
      } else {
        resume = undefined; // can't resume a CLI session on another backend
      }
    }
    if (routeNaturally) {
      // Natural role dispatch now considers every role-compatible pool up front. This is what lets a
      // planner/reader/researcher spend an independent Codex model pool while it is fresh, instead of
      // hiding that allowance until Claude has already capped.
      const routed = this.preferredRoleProvider(role, demand);
      if (routed.allKnownAtRisk && demand.substantial) {
        if (role === "reviewer") this.noteManualCapacityWait(thread, role, demand);
        else this.parkForExhaustedProviders(thread.id, role);
        return undefined;
      }
      if (routed.provider) {
        provider = routed.provider;
        if (provider !== "claude") resume = undefined;
      } else {
        // Every compatible provider is already known unavailable. Do not fire one more doomed turn after
        // a restart: park immediately and let the exact reset-time supervisor revive this role.
        if (role === "reviewer") this.noteManualCapacityWait(thread, role, demand);
        else this.parkForExhaustedProviders(thread.id, role);
        return undefined;
      }
      if (provider !== "claude") {
        const claudeFree = this.accounts.hasHeadroom();
        this.postFinding({
          threadId: thread.id,
          fromRole: role,
          summary: `Usage-aware routing selected ${providerLabel(provider)} for ${role}`,
          detail: [
            `Workload reserve: ${demandSummary(demand)}.`,
            ...routed.candidates.map((candidate) => describeProviderCapacity(candidate, demand)),
            !claudeFree ? "Every enabled Claude account is currently capped; this avoids a rejected Claude turn." : undefined,
          ].filter(Boolean).join("\n"),
          severity: claudeFree ? "info" : "warning",
        });
      }
    }

    while (!this.cancelled(thread.id)) {
      if (role === "qa" && this.qaSuperseded(thread.id)) return undefined;
      if (provider === "claude" && !acct) {
        acct = this.dispatchAccount(demand);
        triedClaudeAccounts.add(acct.id);
      }
      const model = provider === "codex" ? this.codexRoleModel(role, demand) : provider === "grok" ? this.grokModel() : provider === "zai" ? this.zaiModel() : this.modelFor(acct!.id, role);
      const accountLabel = provider === "codex" ? `codex:${model}` : provider === "grok" ? `grok:${model}` : provider === "zai" ? `zai:${model}` : acct!.label;
      const effort = provider === "codex" ? this.codexEffort(model) : provider === "grok" ? this.grokEffort(model) : provider === "zai" ? this.zaiEffort() : undefined;
      const run = this.db.createRun({ threadId: thread.id, role, model, account: accountLabel, effort });
      this.emitRun(run.id);
      const cfg = makeCfg({ token: provider === "claude" ? acct!.token : undefined, resume: provider === "claude" ? resume : undefined, runId: run.id });
      cfg.model = model;
      let agent: AgentRunLike;
      let startMessage: string | unknown[] = message;
      let accountId = provider === "claude" ? acct!.id : "";
      if (provider === "codex") {
        accountId = "openai-codex";
        const fullKickoff = cliRoleKickoff(cfg, roleKickoff, role, "Codex");
        if (!resume) startMessage = cliRoleKickoff(cfg, message, role, "Codex");
        agent = this.createRoleAgent("codex", () => new CodexAgentRun({
          model,
          effort: this.codexEffort(model),
          cwd: thread.workspace,
          apiKey: this.openaiApiKey() ?? "",
          resume,
          freshFallback: resume ? this.communicationContent(fullKickoff) : undefined,
          outputSchema: cfg.outputFormat?.schema,
          // A reader may inspect files/git through Codex's shell, but its lane contract is immutable:
          // enforce the same read-only sandbox used by the director instead of the implementor bypass.
          directorMode: role === "reader",
          onOfficeChat: (scope, body) => {
            this.chatPost({ threadId: thread.id, runId: run.id, role, scope, body });
          },
          onOperatorNote: (body, url) => {
            this.postCliOperatorNote(thread, role, body, url);
          },
          onDeliverable: (label, path) => {
            this.postCliDeliverable(thread, role, run.id, label, path);
          },
        }));
      } else if (provider === "grok") {
        accountId = "xai-grok";
        const fullKickoff = cliRoleKickoff(cfg, roleKickoff, role, "Grok");
        if (!resume) startMessage = cliRoleKickoff(cfg, message, role, "Grok");
        agent = this.createRoleAgent("grok", () => new GrokAgentRun({
          model,
          effort: this.grokEffort(model),
          cwd: thread.workspace,
          resume,
          freshFallback: resume ? this.communicationContent(fullKickoff) : undefined,
          outputSchema: cfg.outputFormat?.schema,
          onOfficeChat: (scope, body) => {
            this.chatPost({ threadId: thread.id, runId: run.id, role, scope, body });
          },
          onOperatorNote: (body, url) => {
            this.postCliOperatorNote(thread, role, body, url);
          },
          onDeliverable: (label, path) => {
            this.postCliDeliverable(thread, role, run.id, label, path);
          },
        }));
      } else if (provider === "zai") {
        // z.ai runs the Claude SDK path against its Anthropic-compatible endpoint, so it keeps the bus/office
        // MCP servers and structured output already built into `cfg` by makeCfg — just point it at z.ai. A
        // z.ai session id resumes only on z.ai (same endpoint), so carry the resume through here.
        accountId = "zai";
        cfg.baseUrl = config.zai.baseUrl;
        cfg.authToken = this.zaiApiKey();
        if (resume) cfg.resume = resume;
        agent = this.createRoleAgent("zai", () => new ZaiAgentRun(cfg));
      } else {
        agent = this.createRoleAgent("claude", () => new AgentRun(cfg));
      }
      this.wireRun(agent, thread.id, run.id, role, accountId);
      this.track(thread.id, agent);
      this.officeCheckIn(thread.id, role);
      this.ensureGroup(thread.id);
      // The planner and QA are each reachable mid-flight via their own handle, because each runs while
      // NO implementor is active in the slot: a planning inject must reshape the plan (liveRole, drained
      // into a re-plan); QA append steering reaches the running QA agent (liveQa), while QA interrupt
      // stops/supersedes that handle and resumes implementation without spawning beside the review.
      // (Researcher-phase notes flow forward into the implementor's kickoff instead.)
      if (role === "planner") this.liveRole.set(thread.id, agent);
      if (role === "qa") this.liveQa.set(thread.id, agent);
      if (role === "reviewer") this.liveReviewer.set(thread.id, agent);
      agent.start(this.communicationContent(startMessage));
      let res = await agent.result();
      // A provider can emit its cap signal before a success-shaped terminal result (for example an
      // assistant session-limit notice followed by `success`). The cap wins over that nominal result:
      // accepting it here would bypass the shared fallback ladder and turn a retryable quota event
      // into an empty plan/QA review.
      const capped =
        agent.rateLimited ||
        ((agent instanceof CodexAgentRun || agent instanceof GrokAgentRun) && agent.capped);
      if (role === "reader" && provider === "codex" && res && !res.isError && !capFlaggedBy(agent)) {
        const out = res.structuredOutput as ReaderOutput | undefined;
        const alreadyPosted = this.db.listFindings(thread.id).some((finding) => finding.fromRunId === run.id);
        if (!alreadyPosted && out?.answer?.trim()) {
          const answer = out.answer.trim();
          const firstLine = answer.split(/\r?\n/, 1)[0]!.trim();
          this.postFinding({
            threadId: thread.id,
            fromRole: "reader",
            fromRunId: run.id,
            summary: firstLine.slice(0, 240) || (out.escalated ? "Reader needs the full pipeline" : "Reader answer"),
            detail: answer,
            severity: out.escalated ? "warning" : "info",
          });
        }
      }
      if (role === "planner" && res && !res.isError && !capped) res = await this.drainDirectorNotes(thread, agent, res);
      if (role === "planner") this.liveRole.delete(thread.id);
      if (role === "qa") this.liveQa.delete(thread.id);
      if (role === "reviewer") this.liveReviewer.delete(thread.id);
      await agent.stop();
      this.untrack(thread.id, agent);
      const qaWasSuperseded = role === "qa" && this.qaSuperseded(thread.id);
      this.finishRun(run.id, res, agent, qaWasSuperseded ? "interrupted" : undefined);
      if (qaWasSuperseded) return undefined;
      if (this.cancelled(thread.id) || (res && !res.isError && !capped)) return res;

      if (!capped && agent.transientApiError) {
        const startupWedged = agent.startupWedged === true;
        const providerStartupWedged = this.isProviderStartupWedge(agent);
        if (providerStartupWedged) {
          this.quarantineStartupWedge(provider, agent.transientApiErrorMessage);
          // A zero-event startup never reached the model and is strong evidence that this backend is
          // locally unhealthy. Do not spend two more 60s watchdog windows proving the same thing.
          transientFailures = MAX_TRANSIENT_API_FAILURES;
        } else {
          transientFailures++;
        }
        if (transientFailures < MAX_TRANSIENT_API_FAILURES) {
          await this.waitForTransientRetry(thread, role, transientFailures, provider);
          // A session-scoped startup wedge must not replay the same poisoned session. Retry this provider
          // fresh; if that fresh process also emits nothing it is provider-scoped and quarantined.
          resume = startupWedged ? undefined : agent.sessionId;
          message = resume
            ? `The ${providerLabel(provider)} API returned a temporary server error. Retry the interrupted work now and continue exactly where you left off.`
            : roleKickoff;
          continue;
        }
        unavailableProviders.add(provider);
        // nextReadyImplementor(role) confines the MCP-dependent reader to MCP-capable backends: a flip onto
        // Codex/Grok would drop its in-process post_finding channel.
        const next: ImplementorProvider | undefined = this.nextReadyImplementor(provider, unavailableProviders, role, demand);
        if (!next) {
          if (providerStartupWedged) {
            this.parkForExhaustedProviders(thread.id, role);
            return undefined;
          }
          return res;
        }
        const fromName = providerLabel(provider);
        const toName = providerLabel(next);
        this.postFinding({
          threadId: thread.id,
          fromRole: role,
          summary: providerStartupWedged
            ? `${fromName} startup wedged — switched ${role} immediately to ${toName}`
            : startupWedged
              ? `${fromName} saved session wedged — restarted ${role} on ${toName}`
            : `${fromName} API failed ${MAX_TRANSIENT_API_FAILURES} times — switched ${role} to ${toName}`,
          detail: `${agent.transientApiErrorMessage ?? "The provider returned repeated temporary server errors."} The ${role} stage is continuing on ${toName}.`,
          severity: "warning",
        });
        this.notifyExternal(`↪ ${role} hit repeated ${fromName} API errors — continuing "${thread.title}" on ${toName}.`);
        provider = next;
        if (next === "claude") acct = undefined;
        transientFailures = 0;
        resume = undefined;
        message = prependUserContent(roleKickoff, providerStartupWedged
          ? `[Provider startup-wedge handoff]\n${fromName} emitted no startup events and was quarantined. Continue this ${role} stage on ${toName} and complete it fully.`
          : startupWedged
            ? `[Session resume-wedge handoff]\nA saved ${fromName} session emitted no startup events, but the provider remains healthy for unrelated work. Continue this ${role} stage fresh on ${toName} and complete it fully.`
          : `[Provider outage handoff]\n${fromName} failed ${MAX_TRANSIENT_API_FAILURES} consecutive times. Continue this ${role} stage on ${toName} and complete it fully.`);
        continue;
      }

      if (provider !== "claude") {
        // z.ai (AgentRun) signals a cap via rateLimited; the CLI backends via `.capped`.
        if (!capped) return res;
        if (provider === "codex") this.noteCodexCap(agent.rateLimitInfo, model);
        else if (provider === "grok") this.noteGrokCap(agent.rateLimitInfo);
        else if (provider === "zai") this.noteZaiCap(agent.rateLimitInfo);
        unavailableProviders.add(provider);
        const next = this.nextReadyImplementor(provider, unavailableProviders, role, demand);
        if (!next) {
          this.parkForExhaustedProviders(thread.id, role);
          return res;
        }
        provider = next;
        if (next === "claude") acct = undefined;
        transientFailures = 0;
        resume = undefined;
        message = prependUserContent(roleKickoff, `[Provider usage-limit handoff]\nContinue this ${role} stage on ${providerLabel(next)} and complete it fully.`);
        continue;
      }

      if (!agent.rateLimited) return res;
      // A rejection on a model with its OWN metered pool (Fable) while this account's normal windows
      // still have headroom isn't an account cap — another sub's Fable pool is just as gated, and
      // parking would idle a sub with headroom. Relaunch on the SAME account: modelFor resolves the
      // fallback (Opus) for it now that classifyCap latched the pool limit.
      if (await this.modelCapFallback(thread, role, model, acct!, agent)) {
        resume = agent.sessionId ?? resume;
        message = MODEL_FALLBACK_CONTINUE_MSG;
        continue; // bounded: the latched pool makes modelFor resolve the fallback next pass, which has no fallback of its own
      }
      const next = this.failoverAccount(acct!.id, demand);
      // Claude exhausted for this run — no other account has headroom, or the per-run failover budget is
      // spent. Before parking, keep the role alive on another ready backend — this is the "don't lose
      // planner/researcher/QA when the Claude subs are maxed" path; the reader can join it via z.ai, while
      // the reviewer can use any role-serving fallback. (nextReadyImplementor(role) excludes the reader
      // from the MCP-less CLI backends.) A planner/researcher cap
      // otherwise degrades to no-plan/no-research; QA otherwise parks the task to 'review' (capParked flags
      // it for the supervisor).
      if (!next || triedClaudeAccounts.has(next.id)) {
        const cli = this.nextReadyImplementor("claude", unavailableProviders, role, demand);
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
          acct = undefined; // the capped sub must be re-selected if a later provider hands back
          transientFailures = 0;
          resume = undefined;
          message = prependUserContent(roleKickoff, `[Claude usage-limit handoff]\nEvery Claude subscription is capped. Continue this ${role} stage on ${providerLabel(cli)} and complete it fully.`);
          continue;
        }
        this.parkForExhaustedProviders(thread.id, role);
        return res;
      }
      this.logFailover(thread, role, next.label, agent.rateLimitInfo);
      acct = next;
      triedClaudeAccounts.add(next.id);
      resume = agent.sessionId;
      message = resume
        ? "Your session was switched to another account after a usage limit. Continue exactly where you left off and finish."
        : prependUserContent(
            roleKickoff,
            "[Claude usage-limit handoff]\nThe previous Claude account was rejected before it created a resumable session. Start this stage fresh on the new account, re-read the task/workspace, and complete it fully.",
          );
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
      // This role is schema-bound, so its `summary` field carries the ACK instead of emitting free-form
      // text before its plan. Re-emitting that plan is the acknowledgement and the downstream hand-off.
      this.sendCommunication(
        agent,
        structuredAcknowledgedInjection(`${notes.join("\n\n")}\n\nRevise your plan to account for this, then re-emit your structured plan.`),
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
    const res = await this.runRole(thread, "planner", this.kickoffContent(thread.id, this.withOfficeNote(thread, "planner", thread.brief)), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "planner", getRunId: () => runId });
      const office = createOfficeServer(this, { threadId: thread.id, role: "planner", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
      const cfg = plannerConfig(thread.workspace, { bus, office }, this.communicationPolicyOptions());
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      return cfg;
    });
    return res?.structuredOutput as PlanOutput | undefined;
  }

  private async runResearcher(thread: Thread, plan: PlanOutput | undefined): Promise<ResearchOutput | undefined> {
    const res = await this.runRole(thread, "researcher", this.kickoffContent(thread.id, this.withOfficeNote(thread, "researcher", researcherKickoff(thread, plan))), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "researcher", getRunId: () => runId });
      const memory = createMemoryServer(this.memory);
      const office = createOfficeServer(this, { threadId: thread.id, role: "researcher", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
      const cfg = researcherConfig(thread.workspace, { bus, memory, office }, this.communicationPolicyOptions());
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      return cfg;
    });
    return res?.structuredOutput as ResearchOutput | undefined;
  }

  /** The read lane's entry point inside runPipeline. Returns null once the task is fully settled by the
   *  reader itself (answered → done+closed; errored, or a restart with no recoverable disposition →
   *  review). Returns the PROMOTED (lane-cleared) thread when the reader ESCALATED, so the caller falls
   *  through into the normal task-aware implementation route in the very same run — no separate dispatch,
   *  no new thread id, no click required. That fall-through is what turns the escalation from a dead end
   *  (the old design: park in review, wait for a human/director to notice and call `dispatch` again) into
   *  a complete hand-off. */
  private async handleReadLane(thread: Thread, directorNote: string | undefined, saved: StageOutputs): Promise<Thread | null> {
    // A read-lane task never gets its own "reading" state — it sits wherever dispatch left it: 'queued'
    // if it waited behind the concurrency cap, else 'intake' (untouched) when it got an immediate slot,
    // which is the common case. Both are "hasn't settled yet" — recognize both, not just 'queued', or an
    // immediate-slot task that dies mid-read never self-heals on the next boot.
    const unsettled = thread.state === "queued" || thread.state === "intake";
    let out: ReaderOutput | undefined;
    if (!saved.readerDone) {
      out = await this.runReader(thread, directorNote);
    } else if (unsettled && saved.readerEscalation) {
      // A restart landed after the escalation was durably recorded (finalizeReader) but before the
      // promotion below completed. Recover the exact disposition instead of re-running the reader — a
      // second run would repeat the investigation and could post a second escalation finding.
      out = { answered: false, escalated: true, answer: saved.readerEscalation.answer, reason: saved.readerEscalation.reason || undefined };
    } else if (unsettled) {
      // The reader ran (readerDone persisted) but neither a settle nor an escalation record survived —
      // genuinely lost to a restart mid-disposition. A read task only ever sits unsettled pre-settle,
      // so re-entering here still unsettled means we're wedged; park rather than loop forever.
      this.settleReview(thread.id, "Reader completed but its disposition was lost to a restart — re-dispatch to re-run it.");
      return null;
    } else {
      return null; // already settled (done/review) by an earlier run of this thread
    }
    if (!out?.escalated) return null; // answered or errored/capped — finalizeReader already settled it
    return this.promoteEscalatedReadTask(thread, out);
  }

  /** Turn an escalated read-lane task into a normal pipeline task, IN PLACE: same thread id, same
   *  workspace/attachments/message+finding history, no new dispatch. Clears `lane` (the structural
   *  guard — a lane-cleared thread can never re-enter the read-lane branch, so an escalation can't loop)
   *  and appends the reader's evidence to the brief so the planner/implementor inherit its investigation
   *  instead of repeating it — every downstream kickoff (planner, composeKickoff, QA) reads `thread.brief`
   *  directly, so this one append reaches all of them for free. */
  private promoteEscalatedReadTask(thread: Thread, out: ReaderOutput): Thread {
    const evidence = [
      "",
      "## Escalated from the read-only reader lane",
      `The read-only reader could not fully answer this from a lookup and escalated it for the full pipeline${out.reason ? `: ${out.reason}` : ""}.`,
      "",
      "What it found so far:",
      out.answer?.trim() || "(no partial answer recorded)",
    ].join("\n");
    const updated = this.db.promoteReadLane(thread.id, `${thread.brief}\n${evidence}`) ?? thread;
    this.hub.publish({ type: "thread.upsert", thread: updated });
    const m = this.db.addMessage({
      threadId: thread.id,
      role: "director",
      kind: "system",
      content: "↪ Promoted to the normal pipeline — the reader's findings were carried forward into the brief.",
    });
    this.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
    return updated;
  }

  /** The read lane: run ONE read-only reader that answers the question (posting its answer as a finding)
   *  and finalizes the task — no QA. It mirrors runPlanner's shape (runRole + per-(thread,role) MCP
   *  servers) but adds the git_read server for read-only history. Disposition comes from the reader's
   *  structured output: an answer → 'done'; an escalation → the caller (handleReadLane) promotes the
   *  task into the normal pipeline. It never half-answers. readerDone is persisted so a resume can't
   *  re-run/double-post. */
  private async runReader(thread: Thread, directorNote?: string): Promise<ReaderOutput | undefined> {
    const res = await this.runRole(
      thread,
      "reader",
      this.kickoffContent(thread.id, this.withOfficeNote(thread, "reader", readerKickoff(thread, directorNote))),
      ({ token, resume, runId }) => {
        const bus = createBusServer(this, { threadId: thread.id, role: "reader", getRunId: () => runId });
        const office = createOfficeServer(this, { threadId: thread.id, role: "reader", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
        const git = createGitReadServer(thread.workspace);
        const cfg = readerConfig(thread.workspace, { bus, office, git }, this.communicationPolicyOptions());
        cfg.oauthToken = token;
        if (resume) cfg.resume = resume;
        return cfg;
      },
    );
    if (this.cancelled(thread.id)) return undefined;
    return this.finalizeReader(thread, res);
  }

  /** Disposition of a completed read-lane run — factored out of runReader so the three terminal paths are
   *  exercisable without spawning the reader agent (see reader.itest.ts §C):
   *    - errored/no-result → parked in 'review' (stays visible; never auto-closed);
   *    - escalated         → the disposition is recorded (warning finding + a durable readerEscalation
   *      record) and handed back to the caller, which promotes the task into the normal pipeline —
   *      finalizeReader itself never settles an escalation, so it stays a pure "what happened" seam;
   *    - answered read-only → 'done' AND then auto-closed (the answer already landed as a finding, so
   *      leaving the card open on the board is pure bookkeeping noise the owner would close by hand).
   *  readerDone is persisted FIRST so a restart between here and the caller's next step can't re-enter
   *  runReader and post a second answer/escalation. */
  async finalizeReader(thread: Thread, res: ResultEvent | undefined): Promise<ReaderOutput | undefined> {
    // Sticky across resume — set BEFORE any settle so a restart between here and the state change can't
    // re-enter runReader and post a second answer.
    const out = res?.structuredOutput as ReaderOutput | undefined;
    // A capped reader did not answer. Keep readerDone clear so the supervisor resumes the lookup.
    if (this.capParked.has(thread.id)) {
      this.settleReview(thread.id, "Reader could not complete — needs your review (or a full re-dispatch).");
      return undefined;
    }
    this.db.updateThreadStageOutputs(thread.id, { readerDone: true });
    if (!res || res.isError) {
      this.settleReview(thread.id, "Reader could not complete — needs your review (or a full re-dispatch).");
      return undefined;
    }
    if (out?.escalated) {
      // The reader posted its own 'needs full pipeline because …' warning finding; record the disposition
      // durably BEFORE the caller promotes the task, so a restart landing in between can recover the exact
      // escalation (handleReadLane) instead of leaving the task stuck in 'queued' forever.
      this.postFinding({
        threadId: thread.id,
        fromRole: "reader",
        summary: `Reader escalated — needs the full pipeline${out.reason ? `: ${out.reason}` : ""}`,
        severity: "warning",
      });
      this.db.updateThreadStageOutputs(thread.id, {
        readerEscalation: { reason: out.reason ?? "", answer: out.answer ?? "", originalBrief: thread.brief },
      });
      return out;
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
    return out;
  }

  private async runQA(
    thread: Thread,
    opts: QaRoundOpts,
  ): Promise<QaOutput | undefined> {
    const qaDemand = this.capacityDemand(thread, "qa");
    // Fix-rounds 2..N resume the SAME QA session — a warm cache read of the diff/files/tests it
    // already ingested — instead of a fresh session that re-reads everything from scratch. QA still
    // re-runs `git diff` and the checks itself (independent verification preserved); it just doesn't
    // re-pay to reconstruct context it holds. Round 1, or a cold/missing prior session, is fresh.
    // Session ids are provider-specific: a Grok QA id must resume on Grok (never Claude), and the
    // reverse. Claude sessions use transcript-mtime warm/cold; CLI sessions resume when that backend
    // is still ready (no local Claude transcript to age-check).
    // "Different-provider QA": pin QA to a backend OTHER than the one that implemented this task, so the
    // review is genuinely independent (e.g. GPT checks Claude's work). Resolved once per round from the
    // implementor's provider + the currently-ready backends; undefined when only one provider is
    // available, in which case QA falls back to its normal (Claude-default) routing.
    const forcedQaProvider = opts.forcedProvider ?? (this.settings().differentProviderQa ? this.pickDifferentQaProvider(thread.id) : undefined);
    // The opt-in QA-fixes verifier may intentionally route back to the original provider. That is a
    // different policy from the operator's cross-provider toggle, so don't emit a misleading
    // "different-provider" finding for an explicit verifier choice.
    if (!opts.forcedProvider) this.noteDifferentProviderQa(thread, forcedQaProvider);

    // A continuation resumes for the same reason a fix-round does — the session is warm and already holds
    // the diff it was reading when the turn ceiling cut it off — so it's resume-eligible on round 1 too.
    const prior = !opts.forceFresh && (opts.round > 1 || opts.continuation) ? this.latestQaRun(thread.id) : undefined;
    let resume: string | undefined;
    let preferredProvider: ImplementorProvider | undefined;
    // A warm resume of the previous QA session is only valid on the SAME backend it ran on — and, when a
    // QA provider is pinned, that backend must also equal the pinned one (else we'd try to resume a
    // foreign session on the forced provider). A mismatch simply starts fresh on the target backend.
    if (prior && (!forcedQaProvider || prior.provider === forcedQaProvider)) {
      if (prior.provider === "claude") {
        const ageMs = sessionAgeMs(prior.sessionId);
        if (
          this.providerSafeForRole("claude", "qa", qaDemand) &&
          (config.resumeFullSession || (ageMs != null && ageMs < config.resumeWarmMinutes * 60_000))
        ) {
          resume = prior.sessionId;
          preferredProvider = "claude";
        }
      } else {
        if (this.providerSafeForRole(prior.provider, "qa", qaDemand)) {
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
    const baseKickoff = qaRoundKickoff(thread, { resume: !!resume, opts, plan, unsurfaced });
    const kickoff = opts.applyFixes ? `${baseKickoff}\n\n${qaFixCommitPolicy(opts.autoPush !== false)}` : baseKickoff;
    // Stamped BEFORE the run starts, so the silent-run check below can't count a message this attempt
    // emitted between spawning and the result coming back as belonging to an earlier attempt.
    const attemptFrom = Date.now();
    const res = await this.runRole(
      thread,
      "qa",
      // On resume the QA session already holds the pasted images; only wrap them for a fresh start.
      resume ? kickoff : this.kickoffContent(thread.id, this.withOfficeNote(thread, "qa", kickoff)),
      ({ token, resume: r, runId }) => {
        const bus = createBusServer(this, { threadId: thread.id, role: "qa", getRunId: () => runId });
        const office = createOfficeServer(this, { threadId: thread.id, role: "qa", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
        const cfg = qaConfig(thread.workspace, { bus, office }, {
          applyFixes: opts.applyFixes,
          ...this.communicationPolicyOptions(),
        });
        cfg.oauthToken = token;
        if (r) cfg.resume = r;
        return cfg;
      },
      resume,
      forcedQaProvider
        ? { forcedProvider: forcedQaProvider }
        : preferredProvider && preferredProvider !== "claude"
          ? { preferredProvider }
          : undefined,
    );
    if (this.qaSuperseded(thread.id)) return undefined;
    const verdict = res?.structuredOutput as QaOutput | undefined;
    if (verdict) {
      this.renewQaRecoveryAllowances(thread.id);
      return verdict;
    }
    // An empty run is NOT a review that found nothing — it never reached the model at all. Checked before
    // the turn-ceiling branch because it arrives as a SUCCESS result, so `isTurnLimitStop` is false and the
    // round would otherwise fall straight through to the owner.
    if (this.ranSilently(thread.id, "qa", attemptFrom, res)) return this.retrySilentQa(thread, opts);
    if (!this.isTurnLimitStop(res)) return undefined;
    return this.continueCutOffQa(thread, opts);
  }

  /** Why a QA round ended without a verdict, in the owner's words. Prefers the latest QA run's own error
   *  (e.g. a Grok structured-output miss after retries, or an empty run) over a bare "could not complete",
   *  and names a spent recovery budget — the difference between one involuntary stop and a reviewer that
   *  failed the same way every time we restarted it. */
  private qaParkDetail(threadId: string): string | undefined {
    const lastQa = this.db
      .listRuns(threadId)
      .filter((r) => r.role === "qa")
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return [lastQa?.error?.trim() || undefined, ...this.qaRecoveryNotes(threadId)].filter(Boolean).join(" ") || undefined;
  }

  /** What was already tried to get a verdict out of THIS review, for the park message. Both budgets are read
   *  per-review rather than per-task, so a note only appears when the mechanism it names actually ran for the
   *  round that parked — a spend an earlier round made and recovered from is not something to tell the owner
   *  about this one. Each reads as spent only once exhausted; a round that recovers never parks at all. */
  private qaRecoveryNotes(threadId: string): string[] {
    const stage = this.db.getThreadStageOutputs(threadId);
    const notes: string[] = [];
    if ((stage.qaCutoffResumesThisRound ?? 0) >= MAX_QA_CUTOFF_RESUMES)
      notes.push(`It was woken ${MAX_QA_CUTOFF_RESUMES} more times and cut off again each time.`);
    if ((stage.qaSilentRetriesThisRound ?? 0) >= MAX_QA_SILENT_RETRIES)
      notes.push("This review also came back empty without reaching the model, and was already restarted on a fresh session.");
    return notes;
  }

  /**
   * Give the next review a full recovery allowance for BOTH involuntary stops. Called the moment a round
   * produces a verdict, which is the proof that the reviewer is not wedged — the only failure these budgets
   * exist to stop. Without it each allowance is the TASK's, so spends in unrelated rounds pool: a task whose
   * round 1 and round 3 each needed one continuation had none left for round 5, and that round's first
   * cutoff parked it on the owner mid-verification with a paid Opus review thrown away.
   *
   * The empty-run budget renews here for exactly the same reason, and shipped without it: `7d776461`'s
   * round-3 continuation came back empty, its fresh retry then reached a verdict, and the round two
   * verdicts later was refused its own first retry and parked — over a recovery that had worked.
   */
  private renewQaRecoveryAllowances(threadId: string): void {
    const stage = this.db.getThreadStageOutputs(threadId);
    const patch: Partial<StageOutputs> = {};
    if ((stage.qaCutoffResumesThisRound ?? 0) !== 0) patch.qaCutoffResumesThisRound = 0;
    if ((stage.qaSilentRetriesThisRound ?? 0) !== 0) patch.qaSilentRetriesThisRound = 0;
    if (Object.keys(patch).length === 0) return;
    this.db.updateThreadStageOutputs(threadId, patch);
  }

  /**
   * A QA run that stopped at its per-session turn ceiling returned no verdict: the reviewer was cut off
   * mid-verification, which is the same involuntary stop the implementor path already resumes. Without
   * this the task parked on the owner with a finished-looking review it never got — and the review's cost
   * (an Opus QA pass) was spent for nothing. Wake the same session in a FRESH query, which restarts the
   * per-query turn budget, exactly as `awaitImplementorCompletion` does for the implementor.
   *
   * The counter is durable and spent BEFORE the retry, so a restart landing mid-continuation still counts
   * it; when it runs out the caller's existing park keeps its diagnosable turn-ceiling message.
   */
  private async continueCutOffQa(thread: Thread, opts: QaRoundOpts): Promise<QaOutput | undefined> {
    if (this.cancelled(thread.id)) return undefined;
    const stage = this.db.getThreadStageOutputs(thread.id);
    const used = stage.qaCutoffResumesThisRound ?? 0;
    if (used >= MAX_QA_CUTOFF_RESUMES) return undefined;
    this.db.updateThreadStageOutputs(thread.id, {
      qaCutoffResumesThisRound: used + 1,
      // The lifetime tally isn't a budget — it's what lets the run trail be reconciled afterwards
      // (`probe:task-runs`), since a continuation spends a QA launch without spending a round.
      qaCutoffResumes: (stage.qaCutoffResumes ?? 0) + 1,
    });
    this.postFinding({
      threadId: thread.id,
      fromRole: "qa",
      summary: "QA stopped at its turn ceiling before reaching a verdict — continuing the same review",
      detail: `The reviewer was cut off mid-verification, not finished. Waking its session with a fresh turn budget (continuation ${used + 1} of ${MAX_QA_CUTOFF_RESUMES}).`,
      severity: "note",
    });
    // `forceFresh` exists so an editing QA run can't warm-resume into approving its own edits. A
    // continuation resumes the run that was just cut off — for a verifier round that IS the fresh
    // verifier's own session, not the editor's — so the invariant holds and the guard is dropped;
    // keeping it would throw away the interrupted review and start a third full pass from scratch.
    return this.runQA(thread, { ...opts, continuation: true, forceFresh: false });
  }

  /**
   * A QA run that produced NOTHING never reviewed anything: the CLI loaded the session, emitted its init
   * event and exited without reaching the model (0 turns, $0). It arrives as a SUCCESS result carrying no
   * structured output, so before this the round read as "the reviewer declined to answer" and parked the
   * task on the owner with nothing to go on — while the console showed a QA run that looked fine.
   *
   * A warm resume is what breaks this way, so the retry is FRESH: re-running the same resume is the one
   * thing already known not to reach the model. The empty run is first stamped as the failure it is, so the
   * run history (and the park reason, if the retry also comes up empty) names the real cause.
   */
  private async retrySilentQa(thread: Thread, opts: QaRoundOpts): Promise<QaOutput | undefined> {
    this.markSilentRun(thread.id, "qa");
    if (this.cancelled(thread.id)) return undefined;
    const stage = this.db.getThreadStageOutputs(thread.id);
    const usedThisRound = stage.qaSilentRetriesThisRound ?? 0;
    if (usedThisRound >= MAX_QA_SILENT_RETRIES) return undefined;
    // Spent BEFORE the retry, so a restart landing mid-retry still counts it. The lifetime tally is what
    // reconciles this task's QA launches; the per-review allowance is what the budget is enforced against.
    this.db.updateThreadStageOutputs(thread.id, {
      qaSilentRetries: (stage.qaSilentRetries ?? 0) + 1,
      qaSilentRetriesThisRound: usedThisRound + 1,
    });
    this.postFinding({
      threadId: thread.id,
      fromRole: "qa",
      summary: "QA came back empty without reviewing anything — starting the review fresh",
      detail: `The review session returned without ever reaching the model (0 turns, $0), so nothing was verified. Re-running it on a fresh session (retry ${usedThisRound + 1} of ${MAX_QA_SILENT_RETRIES} for this review).`,
      severity: "note",
    });
    // Fresh, and no longer a continuation: a new session holds none of the cut-off review's context, so it
    // needs the full review brief rather than "carry on where you left off".
    return this.runQA(thread, { ...opts, forceFresh: true, continuation: false });
  }

  /** For the "different-provider QA" setting: pick an enabled + ready implementor backend OTHER than the
   *  one that implemented this task, so QA is an independent cross-provider review. Preference favors the
   *  strongest reviewer that keeps the in-app tools — Claude, then z.ai (Anthropic-SDK path, so it keeps
   *  the bus/office MCP tools), then Codex, then Grok. Returns undefined when no different backend is
   *  available (only one provider enabled, or the others are capped); the caller then runs normal QA. */
  private pickDifferentQaProvider(threadId: string): ImplementorProvider | undefined {
    const impProvider = this.priorImplementorProvider(threadId) ?? "claude";
    const thread = this.db.getThread(threadId);
    if (!thread) return undefined;
    const demand = this.capacityDemand(thread, "qa");
    const candidates = this.readyRoleCandidates("qa", demand).filter((candidate) => candidate.provider !== impProvider);
    const capacity = preferCapacity(candidates, candidateCapacityWindows, demand);
    if (!capacity.candidates.length || capacity.allKnownAtRisk) return undefined;
    return this.preferredImplementorProvider(capacity.candidates, demand);
  }

  /** Pick a ready QA backend other than `excluded`. Used only by the opt-in QA-fixes loop after a
   *  reviewer changed files: its changes must be inspected by a different provider when one is
   *  available. The normal QA routing remains untouched while that setting is off. */
  private pickReadyQaProviderExcept(thread: Thread, excluded: ImplementorProvider): ImplementorProvider | undefined {
    const demand = this.capacityDemand(thread, "qa");
    const candidates = this.readyRoleCandidates("qa", demand).filter((candidate) => candidate.provider !== excluded);
    const capacity = preferCapacity(candidates, candidateCapacityWindows, demand);
    if (!capacity.candidates.length || capacity.allKnownAtRisk) return undefined;
    return this.preferredImplementorProvider(capacity.candidates, demand);
  }

  /** The verifier after an editing QA run. Prefer the task's original implementor provider, so the
   *  implementor's provider gets an independent QA turn without re-launching the implementor session.
   *  When it was the editor itself, choose another ready backend. Single-provider setups gracefully
   *  fall back to the same provider — a fresh QA turn is still better than self-accepting an edit. */
  private qaFixVerifierProvider(threadId: string, editor: ImplementorProvider | undefined): ImplementorProvider | undefined {
    if (!editor) return undefined;
    const thread = this.db.getThread(threadId);
    if (!thread) return editor;
    const demand = this.capacityDemand(thread, "qa");
    const original = this.priorImplementorProvider(threadId);
    if (original && original !== editor && this.providerSafeForRole(original, "qa", demand)) return original;
    return this.pickReadyQaProviderExcept(thread, editor) ?? editor;
  }

  /** Announce how different-provider QA resolved: which backend is reviewing which — or, when the toggle
   *  is on but no other backend is available, that QA fell back to the normal one. Called each round; only
   *  posts a finding when the reviewer provider CHANGES from the previous QA round's (the provider is
   *  re-picked from live readiness each round, so it can hop mid-task), so it neither spams every round nor
   *  goes silently stale after a hop. Silent for the default single-provider setup (setting off). */
  private noteDifferentProviderQa(thread: Thread, qaProvider: ImplementorProvider | undefined): void {
    if (!this.settings().differentProviderQa) return;
    const impProvider = this.priorImplementorProvider(thread.id) ?? "claude";
    const prevQaProvider = this.latestQaRun(thread.id)?.provider; // undefined on round 1 (no QA run yet)
    if (qaProvider) {
      if (prevQaProvider === qaProvider) return; // same reviewer as last round — already announced
      this.postFinding({
        threadId: thread.id,
        fromRole: "qa",
        summary: `Different-provider QA: ${providerLabel(qaProvider)} is reviewing the ${providerLabel(impProvider)} implementation`,
        severity: "info",
      });
    } else if (!prevQaProvider) {
      // Toggle on but no different backend ready — log once (first round), not every round.
      this.hub.log(
        "info",
        `Different-provider QA is on for ${thread.id.slice(0, 8)} but no backend other than ${providerLabel(impProvider)} is enabled/ready — running QA on the default backend.`,
      );
    }
  }

  /** Start the implementor (stays live for QA fix-rounds + injects). Returns the handle.
   *  `opts.account` pins a specific account (used by failover); otherwise it's selected. */
  private startImplementor(
    thread: Thread,
    kickoff: string,
    opts?: { resume?: string; effort?: Effort; account?: Acct; freshFallback?: UserContent; images?: ImageBlock[] },
  ): { run: AgentRunLike; runId: string; accountId: string } {
    // Synchronous last gate before any provider process is constructed. It complements the timer:
    // an OS-delayed alarm still cannot let a new paid turn cross an already-elapsed hard deadline.
    if (this.cancelled(thread.id)) throw new Error("Task execution is stopped by its hard deadline.");
    this.setState(thread.id, "implementing");
    // Claude uses the planner's per-task effort (with the xhigh gate applied). Codex has its own
    // operator-selected reasoning effort because the CLI takes a persistent model_reasoning_effort.
    // Preserve Codex-only Ultra until the provider branch is known. Claude/z.ai paths clamp it to Max
    // before implementorConfig reaches the Anthropic SDK.
    const plannerEffort: Effort = opts?.effort === "ultra" ? "ultra" : resolveEffort(opts?.effort);
    const demand = this.capacityDemand(thread, "implementor", plannerEffort);
    // Provider factory: the routing gate (gateImplementorProvider) stored the backend for this thread.
    // Codex runs the CLI (no Claude account/oauth); Claude runs the SDK on a selected subscription.
    const provider = this.implementorProvider.get(thread.id) ?? "claude";
    // Direct QA retries and legacy resume paths can reach here without the initial routing gate. Persist
    // the resolved default too: mid-run failover must never mistake an absent map entry for an unknown
    // provider and strand a capped Claude run while Codex is ready.
    this.implementorProvider.set(thread.id, provider);
    let agent: AgentRunLike;
    let runId: string;
    let accountId: string;
    // The standing implementor doctrine (commit/push/no-push-rule, no half-measures) reaches the Claude backend
    // via its SDK system prompt; the Codex CLI gets no system prompt from us, so prepend it to a FRESH
    // Codex kickoff (resume turns retain it through the resumed Codex thread). Without this a Codex run
    // patches the working tree and stops, never committing — breaking the implementor→commit contract.
    let startKickoff = kickoff;
    if (provider === "codex") {
      const model = this.pickedModel(thread.id, "codex") ?? this.codexModel();
      // The director/planner picks the per-task effort; the Codex subscription's setting is its MAX cap, so
      // a tiny task still runs cheap while nothing exceeds what the operator allowed for this backend.
      const effort = clampEffort(plannerEffort, this.codexEffort(model)) as CodexEffort;
      accountId = "openai-codex";
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: `codex:${model}`, effort });
      runId = run.id;
      this.emitRun(run.id);
      // The Codex CLI is a separate process; the in-process bus MCP server can't attach to it, so a
      // Codex implementor runs without interactive post_finding/ask_user/read_findings — a documented
      // degradation. Text bridges preserve office chat, owner notes, and deliverable cards; the QA loop
      // still reviews its output, and the doctrine makes it commit. A fresh start gets the doctrine plus
      // the (toolless) peer heads-up so it knows to avoid collisions.
      if (!opts?.resume) startKickoff = [CODEX_IMPLEMENTOR_DOCTRINE, this.withOfficeNote(thread, "implementor", kickoff, false)].filter(Boolean).join("\n\n");
      // freshFallback lets the runner self-heal a wedged `exec resume` (hangs at 0% CPU on an interrupted
      // gpt-5 session) by restarting fresh — so it must carry the SAME doctrine + task a fresh start gets.
      const codexAgent = new CodexAgentRun({
        model,
        effort,
        cwd: thread.workspace,
        apiKey: this.openaiApiKey() ?? "",
        resume: opts?.resume,
        freshFallback: opts?.freshFallback ? this.communicationContent(opts.freshFallback) : undefined,
        onOfficeChat: (scope, body) => {
          this.chatPost({ threadId: thread.id, runId, role: "implementor", scope, body });
        },
        onOperatorNote: (body, url) => {
          this.postCliOperatorNote(thread, "implementor", body, url);
        },
        onDeliverable: (label, path) => {
          this.postCliDeliverable(thread, "implementor", runId, label, path);
        },
      });
      // If this run had to self-heal a wedged resume, remember it so every later turn skips the resume
      // attempt (and its 60s watchdog) and goes straight to fresh — resume keeps wedging on this thread.
      codexAgent.onEnd(() => { if (codexAgent.resumeHealed) this.codexResumeWedged.add(thread.id); });
      agent = codexAgent;
    } else if (provider === "grok") {
      const model = this.pickedModel(thread.id, "grok") ?? this.grokModel();
      // Same as Codex: the per-task effort is capped at the Grok subscription's configured maximum.
      const effort = clampEffort(plannerEffort, this.grokEffort(model)) as GrokEffort;
      accountId = "xai-grok";
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: `grok:${model}`, effort });
      runId = run.id;
      this.emitRun(run.id);
      // Like Codex, the Grok CLI is a separate process with no in-process bus MCP tools (no
      // post_finding/ask_user) and no per-tool feed events — a documented degradation. The doctrine makes
      // it commit; the QA loop still reviews the real diff. A fresh start gets the doctrine + peer heads-up.
      if (!opts?.resume) startKickoff = [GROK_IMPLEMENTOR_DOCTRINE, this.withOfficeNote(thread, "implementor", kickoff, false)].filter(Boolean).join("\n\n");
      const grokAgent = new GrokAgentRun({
        model,
        effort,
        cwd: thread.workspace,
        resume: opts?.resume,
        freshFallback: opts?.freshFallback ? this.communicationContent(opts.freshFallback) : undefined,
        onOfficeChat: (scope, body) => {
          this.chatPost({ threadId: thread.id, runId, role: "implementor", scope, body });
        },
        onOperatorNote: (body, url) => {
          this.postCliOperatorNote(thread, "implementor", body, url);
        },
        onDeliverable: (label, path) => {
          this.postCliDeliverable(thread, "implementor", runId, label, path);
        },
      });
      // Reuse the CLI-resume-wedged set (shared by both CLI backends): once a resume self-heals to fresh,
      // every later turn on this thread starts fresh directly instead of re-attempting a wedging resume.
      grokAgent.onEnd(() => { if (grokAgent.resumeHealed) this.codexResumeWedged.add(thread.id); });
      agent = grokAgent;
    } else if (provider === "zai") {
      // z.ai reuses the Claude SDK path (ZaiAgentRun) against its Anthropic-compatible endpoint, so — unlike
      // Codex/Grok — it gets the in-process bus + office MCP servers (post_finding/ask_user/deliverables,
      // real chat_post) and the standard implementor system prompt. The per-task effort is capped at the
      // z.ai subscription's configured maximum, like the other backends.
      const model = this.pickedModel(thread.id, "zai") ?? this.zaiModel();
      const effort = clampEffort(plannerEffort, this.zaiEffort());
      accountId = "zai";
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: `zai:${model}`, effort });
      runId = run.id;
      this.emitRun(run.id);
      const bus = createBusServer(this, { threadId: thread.id, role: "implementor", getRunId: () => run.id });
      const office = createOfficeServer(this, { threadId: thread.id, role: "implementor", workspace: thread.workspace, title: thread.title, getRunId: () => run.id });
      const cfg = implementorConfig(thread.workspace, { bus, office }, {
        resume: opts?.resume,
        effort,
        ...this.communicationPolicyOptions(),
      });
      cfg.model = model;
      cfg.baseUrl = config.zai.baseUrl;
      cfg.authToken = this.zaiApiKey();
      if (!opts?.resume) startKickoff = this.withOfficeNote(thread, "implementor", kickoff, true);
      agent = new ZaiAgentRun(cfg);
    } else {
      const acct = opts?.account ?? this.dispatchAccount(demand);
      accountId = acct.id;
      // The per-task effort is capped at this Claude account's configured maximum (default: uncapped).
      // The auto-selected model when this task has one, else the subscription's configured model (per-sub
      // override → default → built-in). Either way the Fable-pool fallback applies on this account.
      const requested = this.db.getThread(thread.id)?.modelRequest;
      const picked = this.pickedModel(thread.id, "claude");
      // Account-local gated-model fallback is valid for configured/automatic picks, but it would violate
      // a task-local strict request. A requested model either runs exactly or its gate parks the task.
      const model = requested?.provider === "claude" && requested.model
        ? requested.model
        : picked
          ? this.poolResolved(acct.id, picked)
          : this.modelFor(acct.id, "implementor");
      // Apply both the account ceiling and the chosen model's exact effort support.
      const effort = resolveClaudeEffort(model, clampEffort(plannerEffort, this.accountMaxEffort(acct.id)));
      const run = this.db.createRun({ threadId: thread.id, role: "implementor", model, account: acct.label, effort });
      runId = run.id;
      this.emitRun(run.id);
      const bus = createBusServer(this, { threadId: thread.id, role: "implementor", getRunId: () => run.id });
      const office = createOfficeServer(this, { threadId: thread.id, role: "implementor", workspace: thread.workspace, title: thread.title, getRunId: () => run.id });
      const cfg = implementorConfig(thread.workspace, { bus, office }, {
        resume: opts?.resume,
        effort,
        ...this.communicationPolicyOptions(),
      });
      cfg.model = model;
      cfg.oauthToken = acct.token;
      // On a fresh start, fold in a heads-up naming any teammates already live in this repo so the
      // implementor coordinates from turn one (a resumed session already saw the office context). When
      // it's alone in the repo, withOfficeNote returns the kickoff untouched — no office overhead.
      if (!opts?.resume) startKickoff = this.withOfficeNote(thread, "implementor", kickoff, true);
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
    // Base dispatch images stay on fresh kickoffs; explicit resume images are owner-provided handoff
    // context such as QA-interrupt attachments and must travel with the resumed turn.
    agent.start(this.communicationContent(
      this.implementorStartContent(thread.id, kickoff, startKickoff, !!opts?.resume, opts?.images),
    ));
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
    opts: {
      effort?: Effort;
      resumeNudge: string;
      directorNote?: string;
      qaFollows: boolean;
      account?: Acct;
      /** The prior session must NOT be continued in place (it returned empty) — take the fresh-session path
       *  for this backend: a compressed handoff seed on Claude/z.ai, a fresh CLI kickoff on Codex/Grok. */
      forceFresh?: boolean;
      images?: ImageBlock[];
    },
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
    const requestedModel = this.db.getThread(thread.id)?.modelRequest?.model;
    const priorModel = this.db
      .listRuns(thread.id)
      .filter((candidate) => candidate.role === "implementor")
      .sort((a, b) => b.startedAt - a.startedAt)[0]?.model;
    if (resumeSession && requestedModel && priorModel && normalizeModelId(priorModel) !== normalizeModelId(requestedModel)) {
      this.hub.log("warn", `Resume on ${thread.id.slice(0, 8)}: prior session used ${priorModel}, but the task is strictly pinned to ${requestedModel} — starting a fresh requested-model session.`);
      resumeSession = undefined;
    }
    if (!resumeSession) {
      const extras = [restartNote, opts.directorNote].filter(Boolean);
      const text = extras.length ? `${baseKickoff}\n\n${extras.join("\n\n")}` : baseKickoff;
      return this.startImplementor(thread, text, { effort: opts.effort, account: opts.account, images: opts.images });
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
        opts.directorNote && opts.directorNote !== opts.resumeNudge && opts.directorNote,
      ].filter(Boolean);
      const continuation = parts.join("\n\n");
      // The fresh-start kickoff used both when resume wedges (runner self-heal) AND when we skip resume
      // outright (below). It MUST carry this turn's continuation (the QA fix-feedback / nudge), not just
      // the original task — otherwise the fresh session re-runs the original task WITHOUT the requested
      // fixes, QA keeps bouncing it, and the task eventually fails. The prior edits live in the working
      // tree, so the fresh session re-reads them and applies the feedback on top.
      const freshKickoff = [doctrine, this.withOfficeNote(thread, "implementor", baseKickoff, false), continuation].filter(Boolean).join("\n\n");
      // CLI resume already wedged for this thread → don't pay the 60s watchdog + self-heal spam again;
      // start fresh directly. (startImplementor with no `resume` re-prepends doctrine + office note, so
      // pass just task + continuation here to avoid duplicating them.)
      if (opts.forceFresh || this.codexResumeWedged.has(thread.id)) {
        const why = opts.forceFresh ? "the prior session returned empty" : `${label} resume previously wedged`;
        this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: ${why} — starting a fresh session directly.`);
        const freshText = [baseKickoff, continuation].filter(Boolean).join("\n\n");
        return this.startImplementor(thread, freshText, { effort: opts.effort, account: opts.account, images: opts.images });
      }
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: resuming the ${label} session ${resumeSession.slice(0, 8)} via the CLI.`);
      return this.startImplementor(thread, continuation, {
        effort: opts.effort,
        resume: resumeSession,
        account: opts.account,
        freshFallback: contentWithImages(freshKickoff, opts.images ?? []),
        images: opts.images,
      });
    }
    const ageMs = sessionAgeMs(resumeSession);
    const warm = ageMs != null && ageMs < config.resumeWarmMinutes * 60_000;
    // forceFresh overrides the warm/forced gate: continuing this session in place is what just failed, so
    // fall through to the compressed seed — a NEW session that still carries the prior one's reasoning.
    if (opts.forceFresh) {
      this.hub.log("info", `Resume on ${thread.id.slice(0, 8)}: prior session returned empty — reseeding a fresh session from a compressed handoff.`);
    } else if (config.resumeFullSession || warm) {
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
        opts.directorNote && opts.directorNote !== opts.resumeNudge && opts.directorNote,
      ].filter(Boolean);
      return this.startImplementor(thread, parts.join("\n\n"), { effort: opts.effort, resume: resumeSession, account: opts.account, images: opts.images });
    }
    // Cold cache: composeResumeKickoff compresses the prior session (Haiku + git) and logs how. This
    // is the only awaited step, so re-check cancellation after it before spending an Opus start.
    const seed = await this.composeResumeKickoff(thread, baseKickoff, resumeSession, {
      // A forced reseed never sends the nudge as a live turn (there's no session to send it to), so it has
      // to travel in the seed — otherwise the fresh session is told nothing about why it's starting over.
      directorNote: opts.directorNote ?? (opts.forceFresh ? opts.resumeNudge : undefined),
      qaFollows: opts.qaFollows,
      restartNote,
    });
    if (this.cancelled(thread.id)) return null; // user cancelled while we were compressing
    return this.startImplementor(thread, seed, { effort: opts.effort, account: opts.account, images: opts.images });
  }

  /** The implementor's next real turn outcome — skipping any turn the owner's steering ABORTED.
   *
   *  Steering a live implementor (an office-chat post, "Interrupt & inject", Pause) aborts its turn in
   *  flight, and the CLI ends an aborted turn with a success-shaped, empty result. Accepting that as the
   *  implementor's outcome ended the stage and handed unfinished work to QA — which is how ONE message in
   *  a repo's chatroom finished off every implementor in that repo at once. The steering that caused the
   *  abort is already queued as the next turn, so the result to wait for is that turn's.
   *
   *  Can't hang: a run that is torn down (or paused with nothing queued and then cancelled) resolves
   *  through `nextResult`'s `end` handler instead, which never carries an aborted result. */
  private async awaitTurnResult(run: AgentRunLike, useNext: boolean): Promise<ResultEvent | undefined> {
    let res = useNext ? await run.nextResult() : await run.result();
    while (res?.aborted) res = await run.nextResult();
    return res;
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
    // Each account gets one attempt in this cap chain. This supports every configured subscription and
    // prevents a selector from cycling back onto a known-capped account.
    const triedClaudeAccounts = new Set<string>([currentAccountId]);
    const demand = this.capacityDemand(thread, "implementor", effort);
    let transientFailures = 0;
    while (true) {
      const res = await this.awaitTurnResult(current, useNext);
      const capped =
        current.rateLimited ||
        ((current instanceof CodexAgentRun || current instanceof GrokAgentRun) && current.capped);
      if (this.cancelled(thread.id) || (res && !res.isError && !capped)) return res;

      // 500/529/overload/transport failures are provider incidents, not quota. Retry the SAME provider
      // twice (three consecutive failures total) and preserve its session whenever one was established.
      // The enclosing completion layer switches backend after the third failure.
      if (!capped && current.transientApiError) {
        if (current.startupWedged) return res;
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

      if (!capped) return res;
      // CLI cap notices can be followed by a success-shaped terminal result. Normalize that into
      // the error-shaped outcome awaitImplementorCompletion already routes through its provider flip.
      if (current instanceof CodexAgentRun || current instanceof GrokAgentRun) {
        return res?.isError
          ? res
          : { type: "result", subtype: "error_during_execution", isError: true, result: "CLI provider usage cap" };
      }
      // z.ai is AgentRun-based but a single-key subscription, not a Claude account — there's no sibling
      // account to fail over to. Latch its cap and return an error result so awaitImplementorCompletion's
      // provider-flip continues the task on another backend (mirrors the CLI cap handling).
      if (current instanceof ZaiAgentRun) {
        this.noteZaiCap(current.rateLimitInfo);
        return res?.isError ? res : { type: "result", subtype: "error_during_execution", isError: true, result: "z.ai usage cap" };
      }
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
        !this.db.getThread(thread.id)?.modelRequest &&
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
      const next = this.failoverAccount(currentAccountId, demand);
      const sessionId = current.sessionId ?? this.lastImplementorSession.get(thread.id);
      // No account with headroom (vs. a missing session) means a cap parked this — flag it so the
      // settle tags it for the supervisor, which resumes the task once an account frees up.
      if (!next || triedClaudeAccounts.has(next.id)) {
        if (current.rateLimited) this.capParked.set(thread.id, "implementor");
        return undefined;
      }
      this.logFailover(thread, "implementor", next.label, current.rateLimitInfo);
      await current.stop();
      const handoff = sessionId
        ? continueMsg
        : `${kickoff}\n\n[Claude usage-limit handoff]\nThe previous account was rejected before a resumable session was created. Review the current workspace and complete the task from this fresh account.`;
      const relaunch = this.startImplementor(thread, handoff, { resume: sessionId, effort, account: next });
      current = relaunch.run;
      currentAccountId = relaunch.accountId;
      triedClaudeAccounts.add(currentAccountId);
      useNext = false;
    }
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
    const demand = this.capacityDemand(thread, "implementor", effort);
    let attemptFrom = this.attemptStart(thread.id);
    let res = await this.awaitImplementorResult(thread, effort, kickoff, run, accountId, useNext, continueMsg);
    let current = run;
    let silent = this.ranSilently(thread.id, "implementor", attemptFrom, res);
    if (silent) this.markSilentRun(thread.id, "implementor");
    while (
      (this.isTurnLimitStop(res) || this.implementorStalled(thread.id, res) || silent) &&
      !this.cancelled(thread.id) &&
      // The "looks done" guard reads the last implementor MESSAGE — but a silent run produced none, so that
      // message belongs to an EARLIER session and says nothing about this attempt. A QA fix-round resume is
      // the common case: the pre-QA session signed off with "all tests pass", so vetoing on it would skip
      // the retry entirely and park a task whose fix round never actually ran.
      (silent || !this.implementorLooksDone(thread.id)) &&
      (this.autoResumes.get(thread.id) ?? 0) < config.maxAutoResumes
    ) {
      const session = this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id);
      if (!session) break; // no session to resume from — fall through to the QA/review handling
      const n = (this.autoResumes.get(thread.id) ?? 0) + 1;
      this.autoResumes.set(thread.id, n);
      // Three involuntary-park cases share this resume: a turn-ceiling cutoff (error_max_turns), a voluntary
      // stall (the agent ended its turn promising to "confirm once it finishes"), and a silent run (the
      // session came back without producing anything). All three leave the task waiting on a wake-up that
      // never comes; they differ only in the nudge, and in whether the dead session may be resumed again.
      const turnLimit = this.isTurnLimitStop(res);
      const reason = silent ? "resumed session produced nothing" : turnLimit ? "turn limit hit" : "ended its turn without finishing";
      this.logAutoResume(thread.id, n, reason);
      const nudge = silent
        ? SILENT_RESUME_NUDGE
        : turnLimit
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
        // A session that just returned empty has proven it can't be continued in place — re-resuming the
        // same id would most likely return empty again and burn the whole auto-resume budget on no-ops.
        forceFresh: silent,
      });
      if (!start) break; // cancelled while compressing the prior session
      this.flushDirectorNotes(thread.id, start.run);
      current = start.run;
      attemptFrom = this.attemptStart(thread.id);
      res = await this.awaitImplementorResult(thread, effort, kickoff, start.run, start.accountId, false, nudge);
      silent = this.ranSilently(thread.id, "implementor", attemptFrom, res);
      if (silent) this.markSilentRun(thread.id, "implementor");
    }
    // Still silent on the way out (the auto-resume budget ran out, or there was no session left to resume):
    // the implementor did NOT finish, so replace its hollow success with a real failure. Without this the
    // caller reads `res && !res.isError` as a clean finish and hands unfinished work to QA — the exact bug.
    if (silent && !this.cancelled(thread.id)) {
      res = { type: "result", subtype: "error_during_execution", isError: true, result: SILENT_RUN_ERROR };
    }
    // Three consecutive transient API failures exhausted the same-provider retries. Hand the task to
    // another enabled backend from the durable working-tree state. Track failed providers through the
    // recursive handoff so a multi-provider outage is bounded instead of ping-ponging forever.
    const failedRun = this.live.get(thread.id)?.run ?? current;
    if (res?.isError && failedRun.transientApiError && !this.cancelled(thread.id)) {
      const from = this.providerForRun(failedRun);
      const startupWedged = failedRun.startupWedged === true;
      const providerStartupWedged = this.isProviderStartupWedge(failedRun);
      if (providerStartupWedged) this.quarantineStartupWedge(from, failedRun.transientApiErrorMessage);
      unavailableProviders.add(from);
      const strictRequest = this.db.getThread(thread.id)?.modelRequest;
      if (strictRequest) {
        await failedRun.stop();
        this.postFinding({
          threadId: thread.id,
          fromRole: "implementor",
          summary: `Strict model ${strictRequest.model ?? strictRequest.requested} was not substituted after repeated API failures`,
          detail: `${failedRun.transientApiErrorMessage ?? "The requested provider returned repeated temporary server errors."} Retry this task when that exact model is healthy; automatic failover is disabled by the owner's strict model request.`,
          severity: "warning",
        });
        return res;
      }
      const next = this.nextReadyImplementor(from, unavailableProviders, "implementor", demand);
      await failedRun.stop();
      if (next) {
        this.implementorProvider.set(thread.id, next);
        const fromName = providerLabel(from);
        const toName = providerLabel(next);
        this.postFinding({
          threadId: thread.id,
          fromRole: "implementor",
          summary: providerStartupWedged
            ? `${fromName} startup wedged — switched this task immediately to ${toName}`
            : startupWedged
              ? `${fromName} saved session wedged — restarted this task on ${toName}`
            : `${fromName} API failed ${MAX_TRANSIENT_API_FAILURES} times — switched this task to ${toName}`,
          detail: `${failedRun.transientApiErrorMessage ?? "The provider returned repeated temporary server errors."} The task is continuing on ${toName} from the current working-tree state.`,
          severity: "warning",
        });
        this.notifyExternal(`↪ ${fromName} API errors persisted — continuing "${thread.title}" on ${toName}.`);
        const seed = await this.composeResumeKickoff(thread, kickoff, undefined, {
          directorNote: providerStartupWedged
            ? `${fromName} emitted no startup events and was quarantined, so you're taking over immediately on ${toName}. Review the existing working-tree progress and finish the task completely.`
            : startupWedged
              ? `A saved ${fromName} session emitted no startup events, but the provider remains available to unrelated work. Take over fresh on ${toName}, review the existing working-tree progress, and finish the task completely.`
            : `${fromName} returned ${MAX_TRANSIENT_API_FAILURES} consecutive temporary API errors, so you're taking over on ${toName}. Review the existing working-tree progress and finish the task completely.`,
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
      if (providerStartupWedged) this.capParked.set(thread.id, "implementor");
      return res;
    }
    // A CLI implementor backend (Codex or Grok) hit its usage cap mid-run → fail OVER to another ready
    // backend rather than parking (a CLI has no account-headroom of its own to fail over to). Its session
    // id is incompatible with any other backend's resume, so relaunch FRESH from a git-progress seed: the
    // working-tree edits persist, so the next backend picks up on top of them. Guarded by the provider
    // flip → switches at most once per cap; the recursive await then handles the new backend's own
    // turn-limit/stall/account-failover from there.
    const cliCapped = (current instanceof CodexAgentRun || current instanceof GrokAgentRun) && current.capped;
    // z.ai is AgentRun-based, so its cap surfaces as `rateLimited` (not a CLI `.capped`) — same flip.
    const zaiCapped = current instanceof ZaiAgentRun && current.rateLimited;
    if (res?.isError && !this.cancelled(thread.id) && (cliCapped || zaiCapped)) {
      const from = this.implementorProvider.get(thread.id) ?? "claude";
      if (from === "codex") {
        const activeRunId = this.live.get(thread.id)?.runId;
        this.noteCodexCap(current.rateLimitInfo, activeRunId ? this.db.getRun(activeRunId)?.model : undefined);
      }
      else if (from === "grok") this.noteGrokCap(current.rateLimitInfo);
      else if (from === "zai") this.noteZaiCap(current.rateLimitInfo);
      unavailableProviders.add(from);
      const strictRequest = this.db.getThread(thread.id)?.modelRequest;
      if (strictRequest) {
        await current.stop();
        this.capParked.set(thread.id, "implementor");
        this.postFinding({
          threadId: thread.id,
          fromRole: "implementor",
          summary: `Requested model ${strictRequest.model ?? strictRequest.requested} hit its capacity — waiting without substitution`,
          detail: "The task remains pinned to the owner's exact model request. The capacity supervisor will retry only that model's own pool.",
          severity: "warning",
        });
        return res;
      }
      const next = this.nextReadyImplementor(from, unavailableProviders, "implementor", demand);
      // Fully end the capped CLI run BEFORE anything else — postFinding routes a warning to this.live's
      // run, so stopping first guarantees it can never resume a fresh doomed turn on the just-capped session
      // (matches the "end the implementor before the next stage" ordering used across this file).
      await current.stop();
      if (!next) {
        // No backend has headroom. Parking preserves the durable auto-resume marker rather than
        // relaunching a known-unready Claude provider and turning provider exhaustion into a task failure.
        this.capParked.set(thread.id, "implementor");
        return res;
      }
      this.implementorProvider.set(thread.id, next);
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
      this.providerForRun(current) === "claude" &&
      !this.db.getThread(thread.id)?.modelRequest
    ) {
      const next = this.nextReadyImplementor("claude", new Set(), "implementor", demand); // best ready non-Claude backend
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

  /** When the attempt about to be awaited actually began: the live run's own start, not "now". Anchoring on
   *  the clock would miss anything the run emitted between spawning and this call, and count it as silent. */
  private attemptStart(threadId: string): number {
    const runId = this.live.get(threadId)?.runId;
    return (runId ? this.db.getRun(runId)?.startedAt : undefined) ?? Date.now();
  }

  /** Whether a role's attempt returned a SUCCESS result having produced nothing at all — no text, no
   *  reasoning, no tool call — since `from`. Seen when a warm `--resume` comes back in seconds with 0 turns
   *  and $0: the CLI loads the session, emits `system:init`, and exits without ever reaching the model. That
   *  is not a finish, but it looks exactly like one to the caller, which is how half-done work reached QA.
   *
   *  Counted from the persisted messages rather than the run's own events on purpose: `awaitImplementorResult`
   *  can relaunch the run internally on an account failover, so the result may come from a DIFFERENT run than
   *  the one we were handed — the thread's message stream covers every relaunch in the attempt. `runRole`
   *  relaunches the same way, so QA and the reviewer read the same signal off their own role's messages. */
  private ranSilently(threadId: string, role: SilentCapableRole, from: number, res: ResultEvent | undefined): boolean {
    // A cancelled run legitimately stops without output — that's the user's doing, not a failed resume, and
    // mislabelling it would both retry a task the user killed and file it as a failure in the run history.
    if (!res || res.isError || this.cancelled(threadId)) return false;
    return this.db.countAgentMessagesSince(threadId, role, from) === 0;
  }

  /** Record a silent run as the failure it is instead of leaving a `done` row with 0 turns. The run-history
   *  triage (`probe:run-errors`, and the nightly sweep through it) only reads non-done runs, so a `done` row
   *  would hide this class of failure entirely.
   *
   *  Deliberately order-independent: the run's own `onEnd` (which clears `this.live` and finalizes the row
   *  as `done`) races the result we just awaited — for a silent run the CLI exits immediately, so it often
   *  wins. Keying off `this.live` alone, or bailing on an already-stamped `endedAt`, would therefore leave
   *  the misleading `done` row in place exactly when this matters most. So fall back to the thread's newest
   *  row for the role and overwrite a terminal state that carries no reason of its own. */
  private markSilentRun(threadId: string, role: SilentCapableRole): void {
    // Only the implementor keeps a `{runId}` live handle; `runRole` has already finalized a one-shot role's
    // run before its result reaches the caller, so there the newest row IS the attempt that came back empty.
    const runId = (role === "implementor" ? this.live.get(threadId)?.runId : undefined) ?? this.latestRunIdOf(threadId, role);
    if (!runId) return;
    const run = this.db.getRun(runId);
    // A row that already recorded a real failure keeps its own reason — that one says more than "empty".
    if (!run || run.error) return;
    this.db.updateRun(runId, { state: "error", error: SILENT_RUN_ERROR, endedAt: run.endedAt ?? Date.now() });
    this.emitRun(runId);
  }

  /** The thread's most recent run row for a role, by start time — the run whose result just came back
   *  once `onEnd` has already cleared the live handle. */
  private latestRunIdOf(threadId: string, role: Role): string | undefined {
    return this.db
      .listRuns(threadId)
      .filter((r) => r.role === role)
      .sort((a, b) => b.startedAt - a.startedAt)[0]?.id;
  }

  /** The owner-facing park reason for an implementor that ended on an error result instead of finishing.
   *  Lifting the run's own failure text — as the QA park below does — is what makes the console say WHY
   *  the task stopped; without it every involuntary end reads identically. `tail` is the generic ask used
   *  when the result carried no reason at all (a run that vanished with no result to read). */
  private implementorParkReason(res: ResultEvent | undefined, tail: string): string {
    const why = res?.isError ? runErrorText(res) : undefined;
    return `Implementor ended without completing — ${why ?? tail}`;
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


  // ================= TIMED TASKS — a single task with a wall-clock work window =====================

  /** The window this thread runs under, or null for an ordinary task. */
  private timedWindowFor(thread: Thread): TimedWindow | null {
    return timedWindow(thread);
  }

  /** Start a requested window exactly when its pipeline first owns a slot. A queued task therefore
   * keeps the owner-requested duration intact, while every later resume keeps this same absolute
   * deadline. The fallback call from runTimedWindow also repairs legacy/in-process callers that enter
   * the boundary helper directly rather than through runPipeline. */
  private activateTimedWindow(thread: Thread): Thread {
    if (thread.deadlineAt != null || !thread.durationMs || thread.durationMs <= 0) return thread;
    const deadlineAt = Date.now() + thread.durationMs;
    const activated = { ...thread, deadlineAt };
    this.db.setTimedWindow(thread.id, thread.durationMs, deadlineAt);
    this.hub.publish({ type: "thread.upsert", thread: activated });
    this.hub.log("info", `Timed task ${thread.id.slice(0, 8)} began its ${formatDuration(thread.durationMs)} work window.`);
    return activated;
  }

  /** Whether the implementor declared the objective complete in its most recent message. Read from the
   *  persisted message rather than the run result, so it survives the relaunch between rounds. */
  private timedDeclaredComplete(threadId: string): boolean {
    const last = this.db.lastMessageOf(threadId, "implementor", "text");
    return !!last && detectTimedComplete(last.content) !== null;
  }

  /**
   * Keep a timed task working until its window closes, then hand off to the normal final path.
   *
   * A no-op for an ordinary task, and for a task whose window an earlier episode already closed
   * (`timedFinalizing`) — which is what stops a restart from re-opening a finished window.
   *
   * The loop only ever runs BETWEEN rounds. Nothing here interrupts a live agent: a round that is
   * running when the deadline passes finishes normally and the deadline simply denies the next one.
   * Aborting mid-turn would return a success-shaped result with no output, which the pipeline cannot
   * distinguish from a genuine finish — the trap documented on `steerStructuredRole`.
   */
  private async runTimedWindow(
    thread: Thread,
    effort: Effort | undefined,
    kickoff: string,
    res: ResultEvent | undefined,
    qaFollows: boolean,
  ): Promise<ResultEvent | undefined> {
    thread = this.activateTimedWindow(thread);
    if (!this.timedWindowFor(thread)) return res;
    const saved = this.db.getThreadStageOutputs(thread.id);
    if (saved.timedFinalizing) return res;
    let extensions = saved.timedExtensions ?? 0;
    let hollow = saved.timedHollowRounds ?? 0;
    let completeEarly = saved.timedCompleteEarly === true;

    for (;;) {
      if (this.cancelled(thread.id)) return res;
      // A capacity park is a temporary interruption, not a failed work round. Keep the durable window
      // open so the cap supervisor resumes this same round/session and can still grant later useful
      // rounds. Other errors really do close the window: repeating a genuine failure for hours helps no
      // one. `settleReview` consumes this in-memory flag only after we return to the outer pipeline.
      if (!res || res.isError) {
        if (this.capParked.has(thread.id)) return res;
        this.closeTimedWindow(thread, { reason: "The work window stopped early because a work round did not finish cleanly.", extensions });
        return res;
      }
      if (!completeEarly && this.timedDeclaredComplete(thread.id)) {
        completeEarly = true;
        this.db.updateThreadStageOutputs(thread.id, { timedCompleteEarly: true });
      }
      // Re-read the window every round rather than closing over the value from entry: the thread row is
      // the source of truth for the deadline, so a window adjusted while the task runs takes effect at
      // the next boundary instead of being ignored for the rest of the episode.
      const window = this.timedWindowFor(this.db.getThread(thread.id) ?? thread);
      if (!window) {
        this.closeTimedWindow(thread, { reason: "The work window was removed while the task was running.", extensions });
        return res;
      }
      const decision = timedDecision({
        deadlineAt: window.deadlineAt,
        now: Date.now(),
        extensionsUsed: extensions,
        completeEarly,
        hollowRounds: hollow,
        maxExtensions: config.timedMaxExtensions,
        minSliceMs: config.timedMinSliceMs,
        maxHollowRounds: config.timedMaxHollowRounds,
      });
      if (decision.action === "finalize") {
        this.closeTimedWindow(thread, { reason: decision.reason, extensions });
        return res;
      }

      extensions += 1;
      this.db.updateThreadStageOutputs(thread.id, { timedExtensions: extensions });
      const message = timedExtensionMessage({ remainingMs: decision.remainingMs, round: extensions, maxExtensions: config.timedMaxExtensions });
      this.postFinding({
        threadId: thread.id,
        fromRole: "implementor",
        summary: `⏱ Work window round ${extensions} — ${formatDuration(decision.remainingMs)} left`,
        detail: decision.reason,
        severity: "info",
      });
      const note = this.db.addMessage({
        threadId: thread.id,
        role: "implementor",
        kind: "system",
        content: `⏱ ${decision.reason}`,
      });
      this.hub.publish({ type: "thread.message", threadId: thread.id, message: note });

      // Same slot discipline as a QA fix-round: fully end the finished run, then relaunch through the
      // shared resume gate (warm session when the cache is fresh, else a compressed cold seed).
      const roundStart = Date.now();
      await this.stopLive(thread.id);
      if (this.cancelled(thread.id)) return res;
      const start = await this.startResumedImplementor(
        thread,
        kickoff,
        this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
        { effort, resumeNudge: message, directorNote: message, qaFollows },
      );
      if (!start) return res; // cancelled while compressing the prior session
      this.flushDirectorNotes(thread.id, start.run);
      res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, message, qaFollows);
      res = await this.drainQueuedImplementor(thread, effort, kickoff, res, qaFollows);

      // The runaway guard. A round that came back almost instantly AND wrote nothing did no work —
      // three of those in a row means something is wedged in a way the error paths did not catch, and
      // the window must not spend its remaining hours repeating it. A round that produced anything, or
      // simply took a while, resets the counter.
      const produced = this.db.countAgentMessagesSince(thread.id, "implementor", roundStart) > 0;
      hollow = isHollowRound(Date.now() - roundStart, produced) ? hollow + 1 : 0;
      this.db.updateThreadStageOutputs(thread.id, { timedHollowRounds: hollow });
    }
  }

  /** Close a timed window: mark it durably finalized (so no later episode re-opens it) and record the
   *  reason where the owner will see it. The reason is deliberately specific — "the window ended" vs
   *  "it finished early" vs "it was stopped because nothing was progressing" call for different
   *  reactions, and a task must never just go quiet at its deadline. */
  private closeTimedWindow(thread: Thread, o: { reason: string; extensions: number }): void {
    this.db.updateThreadStageOutputs(thread.id, { timedFinalizing: true });
    const summary = timedClosingNote({ action: "finalize", reason: o.reason, remainingMs: 0 }, o.extensions);
    this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "⏱ Work window closed", detail: summary, severity: "note" });
    const m = this.db.addMessage({ threadId: thread.id, role: "implementor", kind: "system", content: `⏱ ${summary}` });
    this.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
    this.hub.log("info", `Timed task ${thread.id.slice(0, 8)} closed its window after ${o.extensions} round(s): ${o.reason}`);
  }

  // ================= SHOTGUN TASKS — N collaborators on one objective ==============================

  /**
   * Decide (once) how a shotgun task splits, spawn the collaborators, and return the LEAD's kickoff
   * narrowed to its own share. Returns the kickoff unchanged for an ordinary task, for a collaborator
   * (a share is never split again), and on every degrade path.
   *
   * `shotgunPlanned` is sticky: a resume must never re-decompose a task whose collaborators are already
   * running, which would spawn a second set of agents onto the same tree.
   */
  private async prepareShotgun(thread: Thread, plan: PlanOutput | undefined, kickoff: string): Promise<string> {
    thread = this.activateTimedWindow(thread);
    if (thread.parentId || !isShotgun(thread.agentCount)) return kickoff;
    const saved = this.db.getThreadStageOutputs(thread.id);
    if (saved.shotgunPlanned) return this.reconcileShotgunSplit(thread, saved, kickoff);
    const agentCount = thread.agentCount!;

    const raw = await this.runShotgunDecomposition(thread, plan, agentCount).catch((e) => {
      this.hub.log("warn", `Shotgun decomposition failed on ${thread.id.slice(0, 8)}: ${String(e)}`);
      return undefined;
    });
    if (this.cancelled(thread.id)) return kickoff;
    // A cap during decomposition is not a "cannot split" answer — park and let the supervisor retry the
    // stage, rather than silently spending the owner's multi-agent request on one agent.
    if (this.capParked.has(thread.id)) return kickoff;

    const decided = validateDecomposition(raw, agentCount);
    if (!decided.ok) return this.degradeShotgun(thread, decided.reason, kickoff);

    const [mine, ...theirs] = decided.assignments;
    if (!mine || !theirs.length) return this.degradeShotgun(thread, "the decomposition left no work for the other agents", kickoff);

    // The planner can take enough wall clock for a short timed task to expire. Do not turn a zero
    // remaining duration into an untimed child: that would let a collaborator keep editing after its
    // lead had entered the final path. With no share started yet, the honest outcome is a transparent
    // park rather than pretending there is time to launch a parallel implementation.
    const current = this.db.getThread(thread.id) ?? thread;
    if (current.deadlineAt != null && current.deadlineAt <= Date.now()) {
      return this.expireShotgunBeforeStart(current, kickoff);
    }

    const narrowedKickoff = this.shotgunLeadKickoff(kickoff, mine, theirs);
    let children: Thread[];
    try {
      // All split facts become durable together: lead scope + narrowed kickoff, every child assignment,
      // and the complete barrier list. No child is even enqueued until this returns committed.
      children = this.db.createShotgunSplit({
        leadId: current.id,
        leadAssignment: mine,
        leadKickoff: narrowedKickoff,
        children: theirs.map((assignment) => ({
          title: assignment.title,
          workspace: current.workspace,
          brief: [assignment.objective, "", "## The shared goal this is part of", current.brief].join("\n"),
          effortOverride: current.effortOverride ?? null,
          // A collaborator inherits the parent's already-started absolute deadline — never a freshly
          // calculated duration that could accidentally become null at expiry.
          durationMs: current.durationMs ?? null,
          deadlineAt: current.deadlineAt ?? null,
          assignment,
        })),
      });
    } catch (error) {
      // A duplicate caller may have lost the in-memory race but won no writes; re-read and recover the
      // committed split. Any other write failure is quarantined rather than falling through to a lead
      // working the whole brief beside an unknown partial set of collaborators.
      const after = this.db.getThreadStageOutputs(current.id);
      if (after.shotgunPlanned) return this.reconcileShotgunSplit(current, after, kickoff);
      return this.blockShotgunRecovery(current, kickoff, `The requested split could not be committed atomically: ${String(error)}`);
    }

    await this.launchShotgunCollaborators(current, mine, children);

    this.postFinding({
      threadId: thread.id,
      fromRole: "planner",
      summary: `🔀 Split across ${decided.assignments.length} agents working in parallel`,
      detail: decided.assignments.map((a) => `- "${a.title}" owns: ${a.files.join(", ")}`).join("\n"),
      severity: "note",
    });
    this.hub.log("info", `Shotgun ${thread.id.slice(0, 8)} split into ${decided.assignments.length} shares (${children.length} collaborator(s) spawned).`);
    return narrowedKickoff;
  }

  /** The lead obeys the same path boundaries as its collaborators, then receives a dedicated final
   * integration pass once they have all settled. */
  private shotgunLeadKickoff(kickoff: string, mine: ShotgunAssignment, peers: ShotgunAssignment[]): string {
    return [
      kickoff,
      "",
      ownershipBlock(mine, peers.map((assignment) => ({ title: assignment.title, files: assignment.files }))),
      "",
      "## Your share of this task",
      mine.objective,
    ].join("\n");
  }

  /** Build every child contract from the complete persisted split. This is called before any child is
   * started and again after a restart; the map is only a warm cache, while the rows are the durable
   * source of truth that collaboratorOwnershipBlock can reconstruct. */
  private installShotgunOwnership(lead: ShotgunAssignment, children: Thread[]): void {
    const shares = [
      { id: "lead", assignment: lead },
      ...children.filter((child) => child.assignment).map((child) => ({ id: child.id, assignment: child.assignment! })),
    ];
    for (const child of children) {
      if (!child.assignment) continue;
      const peers = shares
        .filter((share) => share.id !== child.id)
        .map((share) => ({ title: share.assignment.title, files: share.assignment.files }));
      this.shotgunOwnership.set(child.id, ownershipBlock(child.assignment, peers));
    }
  }

  /** Publish and enqueue a fully-persisted child set. A process can die before this point without
   * harm: reconcileShotgunSplit sees the durable complete set and starts the still-intake children on
   * the next parent resume. */
  private async launchShotgunCollaborators(lead: Thread, leadAssignment: ShotgunAssignment, children: Thread[]): Promise<void> {
    this.installShotgunOwnership(leadAssignment, children);
    const baseline = lead.baselineHead ?? (await getHeadSha(lead.workspace).catch(() => null));
    for (const child of children) {
      this.db.setBaselineHead(child.id, baseline);
      this.hub.publish({ type: "thread.upsert", thread: this.db.getThread(child.id) ?? child });
    }
    // Start only after every child row, every peer contract and the narrowed lead kickoff committed.
    for (const child of children) {
      const current = this.db.getThread(child.id);
      if (current?.state === "intake" || current?.state === "queued") this.enqueueOrRun(child.id);
    }
  }

  /** Rebuild a committed split after a restart or a second in-process entry. A full set is safe to
   * launch idempotently; an older partial set is not — it gets quarantined rather than guessing which
   * files a live/previous child was allowed to edit. */
  private async reconcileShotgunSplit(thread: Thread, saved: StageOutputs, kickoff: string): Promise<string> {
    if (saved.shotgunDegraded || saved.shotgunRecoveryBlocked) return saved.kickoff ?? kickoff;
    const children = this.db.listCollaborators(thread.id);
    const expected = saved.shotgunChildren ?? [];
    const expectedIds = new Set(expected);
    const complete =
      !!saved.shotgunAssignment &&
      expected.length > 0 &&
      expectedIds.size === expected.length &&
      children.length === expected.length &&
      children.every((child) => expectedIds.has(child.id) && !!child.assignment);
    if (!complete) {
      return this.blockShotgunRecovery(
        thread,
        kickoff,
        "A partial shotgun split from an interrupted older run was found without one complete ownership contract. No collaborator was resumed, because it would be unsafe to continue sharing this working tree without knowing every peer's boundaries.",
      );
    }
    const narrowedKickoff = saved.kickoff ?? this.shotgunLeadKickoff(kickoff, saved.shotgunAssignment!, children.map((child) => child.assignment!));
    if (!saved.kickoff) this.db.updateThreadStageOutputs(thread.id, { kickoff: narrowedKickoff });
    await this.launchShotgunCollaborators(thread, saved.shotgunAssignment!, children);
    return narrowedKickoff;
  }

  /** Stop and park any legacy partial split. This is intentionally not an automatic degradation to one
   * agent: an existing child may already have changed a subset of the tree, so continuing the lead on
   * the whole brief would recreate the overwrite race this feature is meant to prevent. */
  private async blockShotgunRecovery(thread: Thread, kickoff: string, reason: string): Promise<string> {
    const saved = this.db.getThreadStageOutputs(thread.id);
    if (saved.shotgunRecoveryBlocked) return saved.kickoff ?? kickoff;
    this.db.updateThreadStageOutputs(thread.id, { shotgunRecoveryBlocked: reason });
    for (const child of this.db.listCollaborators(thread.id)) {
      if (collaboratorSettled(child.state)) continue;
      await this.stopLive(child.id);
      if (!collaboratorSettled(this.db.getThread(child.id)?.state ?? child.state)) {
        this.setState(child.id, "review", "Shotgun split recovery was incomplete, so this collaborator was stopped to protect the shared working tree.");
      }
    }
    this.postFinding({ threadId: thread.id, fromRole: "planner", summary: "Shotgun split parked safely", detail: reason, severity: "warning" });
    this.hub.log("warn", `Shotgun ${thread.id.slice(0, 8)} quarantined: ${reason}`);
    return kickoff;
  }

  /** A timed lead that runs out of wall clock while planning its split must not create untimed children.
   * There is no implementation to integrate yet, so park with the exact reason rather than starting a
   * speculative first round after the deadline. */
  private expireShotgunBeforeStart(thread: Thread, kickoff: string): string {
    const reason = "The timed work window ended while the shotgun split was being prepared, before any collaborator could safely start.";
    const saved = this.db.getThreadStageOutputs(thread.id);
    if (!saved.timedFinalizing) this.closeTimedWindow(thread, { reason, extensions: saved.timedExtensions ?? 0 });
    this.db.updateThreadStageOutputs(thread.id, { shotgunPlanned: true, shotgunDegraded: reason });
    this.postFinding({ threadId: thread.id, fromRole: "planner", summary: "Shotgun split skipped — work window ended", detail: reason, severity: "note" });
    return kickoff;
  }

  /** Record why a shotgun request ran single-agent after all, and carry on as an ordinary task. This is
   *  a supported outcome, not an error: plenty of real work cannot be split safely, and one complete
   *  agent beats three colliding ones. The owner is told, because they asked for something else. */
  private degradeShotgun(thread: Thread, reason: string, kickoff: string): string {
    this.db.updateThreadStageOutputs(thread.id, { shotgunPlanned: true, shotgunDegraded: reason });
    this.postFinding({
      threadId: thread.id,
      fromRole: "planner",
      summary: `🔀 Running with one agent after all — this task can't be safely split`,
      detail: `${reason}. Splitting it anyway would put two agents in the same files in one working tree, where they would overwrite each other, so it is running as a normal single-agent task instead.`,
      severity: "note",
    });
    this.hub.log("info", `Shotgun ${thread.id.slice(0, 8)} degraded to a single agent: ${reason}`);
    return kickoff;
  }

  /** One structured planner call: can this task be split, and if so, into which owned shares? Runs on
   *  the planner role (it already owns repo reading, which is what naming file ownership requires). */
  private async runShotgunDecomposition(thread: Thread, plan: PlanOutput | undefined, agentCount: number): Promise<ShotgunPlan | undefined> {
    const kickoff = decompositionKickoff(thread.brief, planDigest(plan), agentCount);
    const res = await this.runRole(thread, "planner", this.kickoffContent(thread.id, kickoff), ({ token, resume, runId }) => {
      const bus = createBusServer(this, { threadId: thread.id, role: "planner", getRunId: () => runId });
      const office = createOfficeServer(this, { threadId: thread.id, role: "planner", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
      const cfg = plannerConfig(thread.workspace, { bus, office }, this.communicationPolicyOptions());
      cfg.oauthToken = token;
      if (resume) cfg.resume = resume;
      cfg.outputFormat = { type: "json_schema", schema: SHOTGUN_SCHEMA };
      return cfg;
    });
    return res?.structuredOutput as ShotgunPlan | undefined;
  }

  /**
   * The barrier + integration pass. The lead waits for every collaborator to settle, then reconciles the
   * combined tree before QA sees it.
   *
   * The wait polls the collaborators' DURABLE states rather than holding promises, and that is what makes
   * it restart-safe: after a bounce the lead is auto-resumed straight back into this method and simply
   * re-reads where its children got to. A promise map would have died with the process.
   */
  private async integrateShotgun(
    thread: Thread,
    effort: Effort | undefined,
    kickoff: string,
    res: ResultEvent | undefined,
    qaFollows: boolean,
  ): Promise<ResultEvent | undefined> {
    if (thread.parentId) return res; // a collaborator finishes its own share and stops
    const saved = this.db.getThreadStageOutputs(thread.id);
    const children = saved.shotgunChildren ?? [];
    if (!children.length || saved.shotgunIntegrated) return res;

    const outcomes = await this.awaitCollaborators(thread, children);
    if (this.cancelled(thread.id)) return res;
    this.db.updateThreadStageOutputs(thread.id, { shotgunIntegrated: true });
    if (!outcomes.length) return res;

    // The lead's own run may have ended in error. Integration still matters — the collaborators' work is
    // in the tree either way and someone has to make it coherent — but a failed lead has nothing to
    // resume from, so let the normal park path report it rather than launching a doomed round.
    if (!res || res.isError) {
      this.postFinding({
        threadId: thread.id,
        fromRole: "implementor",
        summary: "🔗 Integration skipped — the lead agent's own work didn't finish",
        detail: `The parallel shares have settled (${outcomes.map((o) => `"${o.title}": ${o.state}`).join(", ")}) but the lead run failed, so the combined tree has NOT been reconciled. It needs a human before it can be trusted.`,
        severity: "warning",
      });
      return res;
    }

    const message = integrationBrief(outcomes);
    this.postFinding({
      threadId: thread.id,
      fromRole: "implementor",
      summary: `🔗 All ${outcomes.length} parallel share(s) settled — reconciling the combined result`,
      detail: outcomes.map((o) => `- "${o.title}" → ${o.state}${o.error ? ` (${o.error})` : ""}`).join("\n"),
      severity: "note",
    });
    await this.stopLive(thread.id);
    if (this.cancelled(thread.id)) return res;
    const start = await this.startResumedImplementor(
      thread,
      kickoff,
      this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
      { effort, resumeNudge: message, directorNote: message, qaFollows },
    );
    if (!start) return res;
    this.flushDirectorNotes(thread.id, start.run);
    res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, message, qaFollows);
    return this.drainQueuedImplementor(thread, effort, kickoff, res, qaFollows);
  }

  /** Block until every collaborator has settled, or the barrier times out. Bounded so one wedged
   *  collaborator can't strand the lead forever — the integration pass is then told exactly which
   *  shares came back and which did not, so it reconciles what exists instead of assuming. */
  private async awaitCollaborators(thread: Thread, children: string[]): Promise<CollaboratorOutcome[]> {
    const deadline = Date.now() + config.shotgunBarrierTimeoutMs;
    let announced = false;
    for (;;) {
      const rows = children.map((id) => this.db.getThread(id)).filter((t): t is Thread => !!t);
      const pending = rows.filter((t) => !collaboratorSettled(t.state));
      if (!pending.length || Date.now() > deadline || this.cancelled(thread.id)) {
        if (pending.length) {
          this.hub.log("warn", `Shotgun ${thread.id.slice(0, 8)} stopped waiting: ${pending.length} collaborator(s) still running after ${formatDuration(config.shotgunBarrierTimeoutMs)}.`);
        }
        return rows.map((t) => ({
          title: t.title,
          state: collaboratorSettled(t.state) ? t.state : `still running (${t.state}) — the lead stopped waiting`,
          files: t.assignment?.files ?? [],
          error: t.error ?? null,
        }));
      }
      if (!announced) {
        announced = true;
        this.setState(thread.id, "implementing");
        const m = this.db.addMessage({
          threadId: thread.id,
          role: "implementor",
          kind: "system",
          content: `🔀 Share finished — waiting for ${pending.length} other agent(s) on this task before reconciling.`,
        });
        this.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
      }
      await new Promise((r) => setTimeout(r, config.shotgunBarrierPollMs));
    }
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
    // A QA-only retry already has a finished implementation and routes through runRole's QA fallback
    // chain; gating it as an implementor would unnecessarily block/restart work on a saturated backend.
    const stage = this.db.getThreadStageOutputs(thread.id);
    const qaOnlyRetry = pipe.qaEnabled && !stage.qaSuperseded && !stage.qaFixHandoff && (stage.qaCapRetryRound != null || stage.qaInterruptedRetryRound != null);
    if (!qaOnlyRetry && !this.gateImplementorProvider(thread, { capParkOnExhaustion: true, effort })) return;
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
        execFile("git", ["-C", thread.workspace, "--no-pager", ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out, errOut) =>
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
      parts.push(opts.directorNote, "");
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

  /** Settle a completed implementation when the owner explicitly replaced the sticky automatic QA
   * route with a finish-without-QA directive. This is checked at every async handoff, because the
   * pipeline's PipeOpts were captured before a later injection could change that decision. */
  private settleOwnerQaBypass(thread: Thread, res: ResultEvent | undefined): boolean {
    if (!this.qaBypassedByOwner(thread.id)) return false;
    if (this.cancelled(thread.id)) return true;

    // No reviewer or recovery marker may resurrect this episode after the terminal decision. Keep the
    // ownerQaBypassedAt timestamp itself as durable evidence of why the task skipped its sticky route.
    this.clearQaSupersede(thread.id);
    this.clearQaFixHandoff(thread.id);
    this.db.updateThreadStageOutputs(thread.id, {
      qaCapRetryRound: undefined,
      qaInterruptedRetryRound: undefined,
      reviewFixing: false,
      selfImproving: false,
    });
    this.capParked.delete(thread.id);

    if (res && !res.isError) {
      this.postFinding({
        threadId: thread.id,
        fromRole: "implementor",
        summary: "Owner requested completion without QA; the finished implementation was accepted as done.",
        severity: "info",
      });
      // "End the task" is terminal. Do not start the optional post-completion self-improvement turn.
      this.setState(thread.id, "done");
    } else {
      this.settleReview(
        thread.id,
        this.implementorParkReason(res, "could not finish cleanly. QA was disabled by the owner, so this needs your review."),
      );
    }
    return true;
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
    // This implementor belongs to the pipeline — not an auto-review fix round, and not a post-task
    // self-improvement round. Clearing both here also drops a marker a crash-loop park left behind.
    this.db.updateThreadStageOutputs(thread.id, { reviewFixing: false, selfImproving: false });
    // Durable QA-round budget. `round` used to be a fresh local counter, so EVERY re-entry (a server
    // restart's auto-resume, or a cap-resume) started the loop at round 1 and ran a full fresh QA pass —
    // with a frequently-bouncing server that's an unbounded implementor↔QA loop that drained a whole Grok
    // subscription. Resume from the persisted count instead: a mid-episode resume continues the SAME
    // budget (and, being round > 1, warm-resumes the prior QA session rather than re-reading everything).
    // Fresh dispatch = 0; a retry nulls stage_outputs, so it resets too.
    const savedQa = this.db.getThreadStageOutputs(thread.id);
    const ownerQaBypass = this.qaBypassedByOwner(thread.id);
    // A restart can re-enter with the effective QA route disabled while an owner-triggered QA->implementor
    // handoff is still durable. Keep consuming that handoff so any real work in the same instruction is
    // performed before the task settles; the override only removes the reviewer, never the requested work.
    const preserveOwnerHandoff = pipe.qaEnabled || ownerQaBypass;
    const startingQaSupersede = preserveOwnerHandoff ? this.qaSupersedeMessages(thread.id) : null;
    const pendingQaFixHandoff = preserveOwnerHandoff ? this.qaFixHandoffPayload(thread.id) : null;
    let priorRounds = pipe.qaEnabled ? savedQa.qaRoundsUsed ?? 0 : 0;
    if (startingQaSupersede) {
      const supersedeNote = qaSupersedeResumeNudge(startingQaSupersede);
      directorNote = [directorNote, supersedeNote].filter((s): s is string => Boolean(s)).join("\n\n") || undefined;
      priorRounds = Math.max(0, priorRounds - 1);
      this.db.updateThreadStageOutputs(thread.id, {
        qaCapRetryRound: undefined,
        qaInterruptedRetryRound: undefined,
        qaRoundsUsed: priorRounds,
      });
    }
    const qaCapRetryRound = pipe.qaEnabled && !startingQaSupersede && !pendingQaFixHandoff ? savedQa.qaCapRetryRound : undefined;
    const qaInterruptedRetryRound = pipe.qaEnabled && !startingQaSupersede && !pendingQaFixHandoff ? savedQa.qaInterruptedRetryRound : undefined;
    const qaRetryRound = qaCapRetryRound ?? qaInterruptedRetryRound;
    const qaOnlyRetry = qaRetryRound != null;
    if (pipe.qaEnabled && !ownerQaBypass && !qaOnlyRetry && !pendingQaFixHandoff && priorRounds >= pipe.maxQaRounds) {
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
    // A cap or restart during QA means the implementor already finished. Preserve that stage and retry
    // the exact charged QA round instead of needlessly resuming implementation from scratch.
    let res: ResultEvent | undefined = qaOnlyRetry
      ? { type: "result", subtype: "success", isError: false }
      : undefined;
    if (
      ownerQaBypass &&
      !startingQaSupersede &&
      !pendingQaFixHandoff &&
      (savedQa.qaCapRetryRound != null || savedQa.qaInterruptedRetryRound != null)
    ) {
      // The durable marker proves implementation had already completed and only QA was interrupted.
      // On restart there is no implementation work to replay, so accept that completed result directly.
      this.settleOwnerQaBypass(thread, { type: "result", subtype: "success", isError: false });
      return;
    }
    if (!qaOnlyRetry) {
      if (pendingQaFixHandoff) {
        this.qaFixHandoff.add(thread.id);
        const delivered = {
          messages: uniqueText(pendingQaFixHandoff.messages ?? []),
          attachmentIds: uniqueText(pendingQaFixHandoff.attachmentIds ?? []),
        };
        const resumeNudge = this.qaFixHandoffResumeNudge(pendingQaFixHandoff);
        const start = await this.startResumedImplementor(
          thread,
          kickoff,
          this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
          {
            effort,
            resumeNudge,
            directorNote: resumeNudge,
            qaFollows: pipe.qaEnabled && !this.qaBypassedByOwner(thread.id),
            images: this.qaFixHandoffImages(pendingQaFixHandoff),
          },
        );
        if (!start) return; // cancelled while compressing the prior session for the resume
        this.flushQaFixHandoffDelta(thread.id, start.run, delivered);
        this.clearQaFixHandoff(thread.id);
        this.flushDirectorNotes(thread.id, start.run);
        const qaFollows = pipe.qaEnabled && !this.qaBypassedByOwner(thread.id);
        res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, resumeNudge, qaFollows);
        res = await this.drainQueuedImplementor(thread, effort, kickoff, res, qaFollows);
      } else {
      const qaFollows = pipe.qaEnabled && !this.qaBypassedByOwner(thread.id);
      const initialResumeNudge = startingQaSupersede && directorNote
        ? directorNote
        : qaFollows
          ? "Your session was resumed after an interruption (a crash or server restart). Continue exactly where you left off and finish the task completely. A QA agent will review your work when you're done."
          : "Your session was resumed after an interruption (a crash or server restart). Continue exactly where you left off and finish the task completely. QA review is disabled for this task - verify your own work, then commit per the doctrine.";
      const start = await this.startResumedImplementor(thread, kickoff, resumeSession, {
        effort,
        resumeNudge: initialResumeNudge,
        // A steering note from the Resume/inject that re-entered the pipeline — delivered to the
        // implementor (woven into the seed/kickoff or sent with the nudge) so it isn't silently lost.
        directorNote,
        qaFollows,
        images: startingQaSupersede ? this.qaSupersedeImages(thread.id) : undefined,
      });
      if (!start) return; // cancelled while compressing the prior session for the resume
      if (startingQaSupersede) this.clearQaSupersede(thread.id);
      // A cold resume compresses the prior session first (an await), and runPipeline already folded the
      // notes that existed before that into the kickoff. Any note injected DURING that window was buffered
      // (state was still pre-implementor) after the fold — deliver it now that the implementor is live, so
      // it isn't stranded in the buffer. Notes arriving after this point hit the live-inject path directly.
      this.flushDirectorNotes(thread.id, start.run);
      res = await this.awaitImplementorCompletion(
        thread,
        effort,
        kickoff,
        start.run,
        start.accountId,
        false,
        "Continue exactly where you left off and finish the task completely.",
        qaFollows,
      );
      // Before the hand-off: if the director queued follow-ups while the implementor worked, it does that
      // work too now (re-launched with them) instead of proceeding — the Queue button's whole point.
      res = await this.drainQueuedImplementor(thread, effort, kickoff, res, qaFollows);
      // A TIMED task keeps working its window from here; a SHOTGUN lead then waits for its collaborators
      // and reconciles the combined tree. Both are no-ops for an ordinary task, and both sit BEFORE the
      // QA hand-off on purpose — QA reviews the finished, integrated result exactly once.
      res = await this.runTimedWindow(thread, effort, kickoff, res, qaFollows);
      if (this.cancelled(thread.id)) return;
      res = await this.integrateShotgun(thread, effort, kickoff, res, qaFollows);
      if (this.cancelled(thread.id)) return;
      }
    }

    // QA disabled — the implementor's output is final. A clean finish goes straight to 'done'
    // (the only non-QA path to 'done' besides a manual markDone); an incomplete one parks for review.
    // PipeOpts are captured at pipeline start; an injection may have replaced that sticky decision while
    // the implementor was running. All implementation, queue, timed, and shotgun work is complete here.
    if (this.settleOwnerQaBypass(thread, res)) return;

    if (!pipe.qaEnabled) {
      if (this.cancelled(thread.id)) return;
      if (res && !res.isError) {
        this.postFinding({ threadId: thread.id, fromRole: "implementor", summary: "Implementor finished — QA review is disabled, accepted as done.", severity: "info" });
        await this.runSelfImprovement(thread, effort, kickoff);
        if (this.cancelled(thread.id)) return;
        this.setState(thread.id, "done");
      } else {
        this.settleReview(thread.id, this.implementorParkReason(res, "needs your review (QA is disabled for this task)."));
      }
      return;
    }

    // In QA-fixes mode each changed QA pass is handed to an explicit verifier. The legacy path below
    // deliberately leaves these unset, preserving its existing implementor↔QA behavior exactly.
    let qaFixForcedProvider: ImplementorProvider | undefined;
    let qaFixForceFresh = false;
    let qaFixSummary: string | undefined;
    // The charged round must get exactly one replacement QA attempt even if an operator lowered
    // maxQaRounds while recovery was pending. It was already within the budget when it was charged;
    // silently dropping it would turn a recoverable interruption into a permanent review park.
    const qaRoundCeiling = qaOnlyRetry ? Math.max(pipe.maxQaRounds, qaRetryRound!) : pipe.maxQaRounds;
    for (let round = qaOnlyRetry ? qaRetryRound! : priorRounds + 1; round <= qaRoundCeiling; round++) {
      if (this.cancelled(thread.id)) return;
      if (this.settleOwnerQaBypass(thread, res)) return;
      if (!res || res.isError) {
        this.settleReview(thread.id, this.implementorParkReason(res, "needs your review."));
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
      const retryingDirectQaRound = qaOnlyRetry && round === qaRetryRound;
      const qa = await this.runQA(thread, {
        round,
        applyFixes: pipe.qaAppliesFixes,
        autoPush: pipe.autoPush,
        forcedProvider: pipe.qaAppliesFixes ? qaFixForcedProvider : undefined,
        forceFresh: pipe.qaAppliesFixes ? qaFixForceFresh : false,
        priorFixSummary: pipe.qaAppliesFixes ? qaFixSummary : undefined,
        // This is a continuation of a paid-but-cap-rejected or restart-interrupted QA pass, not another
        // implementor/QA cycle.
        // It warm-resumes only if that backend is still ready; runRole drops the session on a handoff.
        continuation: retryingDirectQaRound,
      }).catch((e) => {
        this.hub.log("warn", `QA failed on ${thread.id.slice(0, 8)}: ${String(e)}`);
        return undefined;
      });
      if (this.cancelled(thread.id)) return;
      const superseded = await this.resumeImplementorAfterQaSupersede(thread, effort, kickoff, round);
      if (superseded.handled) {
        if (this.settleOwnerQaBypass(thread, superseded.result)) return;
        if (!superseded.result || superseded.result.isError) {
          if (!this.cancelled(thread.id) && this.db.getThread(thread.id)?.state === "implementing") {
            this.settleReview(thread.id, this.implementorParkReason(superseded.result, "needs your review after the QA interrupt."));
          }
          return;
        }
        res = superseded.result;
        round--; // retry the same QA round; the interrupted review produced no usable verdict.
        continue;
      }

      // A queue-mode finish directive intentionally waits for the current QA turn. Do its queued work
      // now, but do not promise another reviewer to that implementor: the durable owner override wins.
      if (this.qaBypassedByOwner(thread.id) && this.queuedForImplementor.get(thread.id)?.length && res && !res.isError) {
        res = await this.drainQueuedImplementor(thread, effort, kickoff, res, false);
      }
      if (this.settleOwnerQaBypass(thread, res)) return;

      if (qa) {
        // A real QA verdict completed the retry. Clear before any later state transition so a restart
        // cannot mistake a normal non-pass/fix round for a still-pending direct QA handoff.
        this.db.updateThreadStageOutputs(thread.id, { qaCapRetryRound: undefined, qaInterruptedRetryRound: undefined });
      } else if (this.capParked.get(thread.id) === "qa") {
        // Preserve the charged round through review→failed→pipeline and even a server bounce, so the
        // supervisor retries QA itself rather than relaunching the already-complete implementor.
        this.db.updateThreadStageOutputs(thread.id, { qaCapRetryRound: round, qaInterruptedRetryRound: undefined });
      } else if (retryingDirectQaRound) {
        // The replacement reviewer failed for a real non-cap reason; leave a truthful human review,
        // not a stale automatic retry marker.
        this.db.updateThreadStageOutputs(thread.id, { qaCapRetryRound: undefined, qaInterruptedRetryRound: undefined });
      }

      if (!qa) {
        const detail = this.qaParkDetail(thread.id);
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
      if (pipe.qaAppliesFixes) {
        // `changed` is required by the editing-QA prompt. Treat a malformed/legacy omission as changed
        // rather than accepting potentially unverified edits; it costs one more review and fails safe.
        const changed = qa.changed !== false;
        if (changed) {
          if (round >= pipe.maxQaRounds) {
            this.postFinding({
              threadId: thread.id,
              fromRole: "qa",
              summary: `QA made changes in round ${round}, but the ${pipe.maxQaRounds}-round limit was reached - needs your review`,
              detail: qa.summary,
              severity: "warning",
            });
            this.settleReview(thread.id, `QA made changes in the final allowed round (${pipe.maxQaRounds}) and needs an independent re-check.`);
            return;
          }

          const editor = this.latestQaRun(thread.id)?.provider;
          qaFixForcedProvider = this.qaFixVerifierProvider(thread.id, editor);
          qaFixForceFresh = qaFixForcedProvider === editor;
          // Carry the issue LIST, not just the prose summary: an editing round can fix most defects
          // and still report one it could not safely resolve. Handing the verifier only the summary
          // drops that known-open issue, and a verifier that fails to independently rediscover it
          // would settle the task `done` with a blocker the previous reviewer had already named.
          qaFixSummary = formatQaIssues(qa);
          const verifier = qaFixForcedProvider ? providerLabel(qaFixForcedProvider) : "the next available QA provider";
          this.postFinding({
            threadId: thread.id,
            fromRole: "qa",
            summary: `QA round ${round} applied fixes: ${qa.summary}`,
            detail: `The changed tree is being sent to ${verifier} for another QA pass; it will not be accepted until a QA run makes no further code changes.`,
            severity: "note",
          });
          continue;
        }

        // An unchanged QA run is the acceptance decision. A fail here means it could not safely fix a
        // real issue, so park instead of silently bouncing it back to the implementor.
        if (!qa.pass) {
          this.postFinding({ threadId: thread.id, fromRole: "qa", summary: "QA found unresolved issues without making changes - needs your review", detail: qa.summary, severity: "warning" });
          this.settleReview(thread.id, "QA found unresolved issues it could not safely fix - needs your review.");
          return;
        }
        // A user-queued follow-up is still implementor work. Preserve the existing hand-off contract,
        // then begin a fresh editing-QA cycle for that new work rather than accepting it unreviewed.
        if (this.queuedForImplementor.get(thread.id)?.length && res && !res.isError && !this.cancelled(thread.id)) {
          res = await this.drainQueuedImplementor(thread, effort, kickoff, res, true);
          if (this.cancelled(thread.id)) return;
          if (this.settleOwnerQaBypass(thread, res)) return;
          if (round < pipe.maxQaRounds) {
            qaFixForcedProvider = undefined;
            qaFixForceFresh = false;
            qaFixSummary = undefined;
            continue;
          }
        }
        this.postFinding({ threadId: thread.id, fromRole: "qa", summary: `QA passed without further changes: ${qa.summary}`, severity: "info" });
        await this.runSelfImprovement(thread, effort, kickoff);
        if (this.cancelled(thread.id)) return;
        this.setState(thread.id, "done");
        return;
      }

      if (qa.pass) {
        // A follow-up queued during QA (routed to queuedForImplementor)? The implementor does it before
        // we call the task done — the Queue button promises delivery at the hand-off, and a QA pass is
        // one. At the round cap we still run the queued work but accept it without another QA pass.
        if (this.queuedForImplementor.get(thread.id)?.length && res && !res.isError && !this.cancelled(thread.id)) {
          res = await this.drainQueuedImplementor(thread, effort, kickoff, res, true);
          if (this.cancelled(thread.id)) return;
          if (this.settleOwnerQaBypass(thread, res)) return;
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
      const noteBlock = qaNotes?.length ? `\n\n${acknowledgedInjection(qaNotes.join("\n\n"))}` : "";
      const fixMsg = `${this.officeName(thread.id, "qa")} (your QA reviewer) found issues — fix ALL of these, then they'll re-check:\n${formatQaIssues(qa)}${noteBlock}`;
      // The implementor was fully stopped before QA, so RE-LAUNCH it through the same resume gate the
      // rest of the pipeline uses (warm full-session resume when the cache is fresh — fix-rounds are
      // minutes apart so it usually is — else a Haiku-compressed cold seed). This is what keeps the slot
      // exclusive: at no point do an implementor and QA run together. fixMsg goes in as BOTH resumeNudge
      // (warm path) and directorNote (cold path weaves only the note, ignoring the nudge); on warm the
      // two are identical so startResumedImplementor de-dups them. State stays "qa" across the (possibly
      // awaited) compression — startImplementor flips it to "implementing" only once the run is live — so
      // an inject/resume during that window routes to the QA buffer rather than spawning a second agent.
      const handoff = this.rememberQaFixHandoff(thread.id, fixMsg);
      const deliveredHandoff = {
        messages: uniqueText(handoff.messages ?? []),
        attachmentIds: uniqueText(handoff.attachmentIds ?? []),
      };
      const resumeNudge = this.qaFixHandoffResumeNudge(handoff);
      const start = await this.startResumedImplementor(
        thread,
        kickoff,
        this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
        { effort, resumeNudge, directorNote: resumeNudge, qaFollows: true, images: this.qaFixHandoffImages(handoff) },
      );
      if (!start) return; // cancelled while compressing the prior session for the resume
      this.flushQaFixHandoffDelta(thread.id, start.run, deliveredHandoff);
      this.clearQaFixHandoff(thread.id);
      this.flushDirectorNotes(thread.id, start.run);
      res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, resumeNudge);
      // Honor anything queued during this fix round too, before we loop back to QA.
      res = await this.drainQueuedImplementor(thread, effort, kickoff, res, true);
      if (this.settleOwnerQaBypass(thread, res)) return;
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
      const msg = acknowledgedInjection(`[Queued follow-up from ${config.ownerName} — do this too before you finish and hand off]\n${queued.join("\n\n")}`);
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

  private qaSuperseded(threadId: string): boolean {
    return !!this.db.getThreadStageOutputs(threadId).qaSuperseded;
  }

  private rememberQaSupersede(threadId: string, message?: string, attachmentRefs?: AttachmentRef[]): void {
    const stage = this.db.getThreadStageOutputs(threadId);
    const previous = qaSupersedeMessagesFrom(stage);
    const attachmentIds = uniqueText([...(stage.qaSuperseded?.attachmentIds ?? []), ...attachmentIdsFromRefs(attachmentRefs)]);
    const text = message?.trim();
    this.db.updateThreadStageOutputs(threadId, {
      qaSuperseded: {
        at: Date.now(),
        messages: text ? [...previous, text] : previous,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      },
    });
  }

  private qaSupersedeMessages(threadId: string): string[] | null {
    const stage = this.db.getThreadStageOutputs(threadId);
    if (!stage.qaSuperseded) return null;
    return uniqueText([...qaSupersedeMessagesFrom(stage), ...(this.queuedForImplementor.get(threadId) ?? [])]);
  }

  private clearQaSupersede(threadId: string, round?: number): void {
    const patch: Partial<StageOutputs> = {
      qaSuperseded: undefined,
      qaCapRetryRound: undefined,
      qaInterruptedRetryRound: undefined,
      qaCutoffResumesThisRound: 0,
      qaSilentRetriesThisRound: 0,
    };
    if (round != null) patch.qaRoundsUsed = Math.max(0, round - 1);
    this.db.updateThreadStageOutputs(threadId, patch);
    this.queuedForImplementor.delete(threadId);
  }

  private clearQaSupersedeMarker(threadId: string): void {
    this.db.updateThreadStageOutputs(threadId, { qaSuperseded: undefined });
  }

  private qaSupersedeImages(threadId: string): ImageBlock[] {
    return this.attachmentImageBlocks(this.db.getThreadStageOutputs(threadId).qaSuperseded?.attachmentIds);
  }

  private qaFixHandoffPayload(threadId: string): NonNullable<StageOutputs["qaFixHandoff"]> | null {
    const handoff = this.db.getThreadStageOutputs(threadId).qaFixHandoff;
    return handoff && typeof handoff.resumeNudge === "string" && handoff.resumeNudge.trim() ? handoff : null;
  }

  private rememberQaFixHandoff(threadId: string, resumeNudge: string): NonNullable<StageOutputs["qaFixHandoff"]> {
    const previous = this.qaFixHandoffPayload(threadId);
    const handoff = {
      at: previous?.at ?? Date.now(),
      resumeNudge,
      messages: previous?.messages?.length ? uniqueText(previous.messages) : undefined,
      attachmentIds: previous?.attachmentIds?.length ? uniqueText(previous.attachmentIds) : undefined,
    };
    this.qaFixHandoff.add(threadId);
    this.db.updateThreadStageOutputs(threadId, { qaFixHandoff: handoff });
    return handoff;
  }

  private appendQaFixHandoffInstruction(threadId: string, message: string, attachmentRefs?: AttachmentRef[]): NonNullable<StageOutputs["qaFixHandoff"]> {
    const previous = this.qaFixHandoffPayload(threadId);
    const text = message.trim();
    const messages = uniqueText([...(previous?.messages ?? []), ...(text ? [text] : [])]);
    const attachmentIds = uniqueText([...(previous?.attachmentIds ?? []), ...attachmentIdsFromRefs(attachmentRefs)]);
    const handoff = {
      at: previous?.at ?? Date.now(),
      resumeNudge: previous?.resumeNudge ?? acknowledgedInjection("QA is returning this task to implementation. Apply the appended instruction(s) before QA re-checks."),
      ...(messages.length ? { messages } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    };
    this.qaFixHandoff.add(threadId);
    this.db.updateThreadStageOutputs(threadId, { qaFixHandoff: handoff });
    return handoff;
  }

  private qaFixHandoffResumeNudge(handoff: NonNullable<StageOutputs["qaFixHandoff"]>): string {
    const messages = uniqueText(handoff.messages ?? []);
    if (!messages.length) return handoff.resumeNudge;
    return [
      handoff.resumeNudge,
      acknowledgedInjection(`[Instruction(s) received while QA was returning this task to implementation]\n${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`),
    ].join("\n\n");
  }

  private qaFixHandoffImages(handoff: NonNullable<StageOutputs["qaFixHandoff"]> | null): ImageBlock[] {
    return this.attachmentImageBlocks(handoff?.attachmentIds);
  }

  private flushQaFixHandoffDelta(
    threadId: string,
    run: AgentRunLike,
    delivered: { messages?: string[]; attachmentIds?: string[] },
  ): void {
    const current = this.qaFixHandoffPayload(threadId);
    if (!current) return;
    const deliveredMessages = new Set(uniqueText(delivered.messages ?? []));
    const deliveredIds = new Set(uniqueText(delivered.attachmentIds ?? []));
    const messages = uniqueText(current.messages ?? []).filter((m) => !deliveredMessages.has(m));
    const attachmentIds = uniqueText(current.attachmentIds ?? []).filter((id) => !deliveredIds.has(id));
    if (!messages.length && !attachmentIds.length) return;
    const text = messages.length
      ? `[Additional instruction(s) received while QA was returning this task to implementation]\n${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
      : "[Additional image attachment(s) received while QA was returning this task to implementation.]";
    this.sendCommunication(
      run,
      contentWithImages(acknowledgedInjection(text), this.attachmentImageBlocks(attachmentIds)),
      { priority: "now" },
    );
  }

  private clearQaFixHandoff(threadId: string): void {
    this.qaFixHandoff.delete(threadId);
    this.db.updateThreadStageOutputs(threadId, { qaFixHandoff: undefined });
  }

  private async stopQaForImplementor(threadId: string, qa = this.liveQa.get(threadId)): Promise<QaStopOutcome> {
    if (!qa) return { status: "no-live-handle" };
    try {
      await qa.stop();
      return { status: "stopped" };
    } catch (e) {
      this.hub.log("warn", `Could not stop QA for ${threadId.slice(0, 8)}: ${String(e)}`);
      return { status: "failed", error: String(e) };
    }
  }

  /** QA can return to implementation from inside a QA-only restart retry, after the outer implementor
   * gate was intentionally skipped. Reuse a still-safe provider when the pipeline retained it; otherwise
   * run the normal capacity gate at this handoff before starting any process. This prevents a restart-
   * cleared provider map from defaulting to a known-capped Claude turn while Codex is already viable. */
  private routeQaSupersedeImplementor(thread: Thread, effort: Effort | undefined): boolean {
    const demand = this.capacityDemand(thread, "implementor", effort);
    if (this.db.getThread(thread.id)?.modelRequest) {
      return this.gateImplementorProvider(thread, { capParkOnExhaustion: true, effort }) != null;
    }
    const current = this.implementorProvider.get(thread.id);
    if (current && this.providerSafeForRole(current, "implementor", demand)) return true;
    return this.gateImplementorProvider(thread, { capParkOnExhaustion: true, effort }) != null;
  }

  private async resumeImplementorAfterQaSupersede(
    thread: Thread,
    effort: Effort | undefined,
    kickoff: string,
    round: number,
  ): Promise<{ handled: true; result?: ResultEvent } | { handled: false }> {
    const messages = this.qaSupersedeMessages(thread.id);
    if (!messages) return { handled: false };
    const resumeMsg = qaSupersedeResumeNudge(messages);
    const detail = messages.length ? messages.join("\n\n") : "No additional instruction was supplied; the owner stopped QA and returned the task to implementation.";
    this.capParked.delete(thread.id);
    this.postFinding({
      threadId: thread.id,
      fromRole: "qa",
      summary: "QA was interrupted by the owner - returning to the implementor",
      detail,
      severity: "note",
    });
    if (!this.routeQaSupersedeImplementor(thread, effort)) {
      // The shared gate either wrote a durable capacity park or a concrete settings/auth failure. Keep
      // qaSuperseded intact so an automatic capacity resume delivers the owner's instruction exactly once.
      return { handled: true };
    }
    this.resuming.add(thread.id);
    this.setState(thread.id, "implementing");
    let start: LiveImplementor | null = null;
    try {
      start = await this.startResumedImplementor(
        thread,
        kickoff,
        this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id),
        {
          effort,
          resumeNudge: resumeMsg,
          directorNote: resumeMsg,
          qaFollows: !this.qaBypassedByOwner(thread.id),
          images: this.qaSupersedeImages(thread.id),
        },
      );
    } catch (e) {
      this.hub.log("warn", `QA interrupt on ${thread.id.slice(0, 8)} could not start the implementor: ${String(e)}`);
    } finally {
      this.resuming.delete(thread.id);
    }
    if (!start) {
      this.pendingResumeMsgs.delete(thread.id);
      if (!this.cancelled(thread.id) && this.db.getThread(thread.id)?.state === "implementing") {
        this.settleReview(thread.id, "QA was interrupted, but the implementor could not be resumed - needs your review.");
      }
      return { handled: true };
    }
    this.clearQaSupersede(thread.id, round);
    this.flushDirectorNotes(thread.id, start.run);
    const buffered = this.pendingResumeMsgs.get(thread.id);
    if (buffered?.length) {
      this.pendingResumeMsgs.delete(thread.id);
      for (const m of buffered) this.sendCommunication(start.run, acknowledgedInjection(m), { priority: "next" });
    }
    const qaFollows = !this.qaBypassedByOwner(thread.id);
    const result = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, resumeMsg, qaFollows);
    return { handled: true, result: await this.drainQueuedImplementor(thread, effort, kickoff, result, qaFollows) };
  }

  /** Opt-in post-completion round (the "Self-improve after tasks" setting): once the task is accepted —
   *  QA passed, or a clean finish with QA disabled — re-launch the finished implementor ONCE with
   *  SELF_IMPROVE_MSG so it builds the tools/skills/memories this session showed were missing, before the
   *  task settles to done. Read live so flipping the toggle applies to tasks already in flight. Strictly
   *  best-effort: the task is already complete, so an errored or capped round is noted and the task goes
   *  'done' anyway — it never parks a finished task back into review. */
  private async runSelfImprovement(thread: Thread, effort: Effort | undefined, kickoff: string): Promise<void> {
    if (!this.settings().selfImproveEnabled || this.cancelled(thread.id)) return;
    // A shotgun collaborator finished one SHARE, not a task. The reflection round is about what the whole
    // job needed, so it belongs to the lead — running it per share would spend N bonus Opus rounds on N
    // partial views, and each one would be reflecting on a tree the other shares are still changing.
    if (thread.parentId) return;
    const session = this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id);
    if (!session) return; // no implementor session to build on — nothing this round could reflect over
    // Two markers, two jobs. The DURABLE one survives the process: it is how markInterrupted knows a
    // restart landed on already-accepted work and must settle the task done instead of resuming it into
    // the pipeline. The IN-MEMORY one is the episode the inject/resume gates key on while we're alive.
    this.db.updateThreadStageOutputs(thread.id, { selfImproving: true });
    this.selfImproving.add(thread.id);
    try {
      await this.selfImprovementRound(thread, effort, kickoff, session);
    } catch (e) {
      // Best-effort by contract: the task is already accepted, so a throw in the bonus round must not
      // propagate into the caller's settle and strand a finished task mid-pipeline.
      this.hub.log("warn", `Self-improvement round on ${thread.id.slice(0, 8)} failed: ${String(e)}`);
    } finally {
      this.db.updateThreadStageOutputs(thread.id, { selfImproving: false });
      this.selfImproving.delete(thread.id);
    }
  }

  private async selfImprovementRound(thread: Thread, effort: Effort | undefined, kickoff: string, session: string): Promise<void> {
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
    let res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, SELF_IMPROVE_MSG, false);
    // Honor anything the owner queued during the round: the Queue button promises delivery at the
    // implementor's next hand-off boundary, and this is the task's LAST one — the caller settles it done
    // straight after, so nothing else would ever drain it.
    res = await this.drainQueuedImplementor(thread, effort, kickoff, res, false);
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

  installLabQaRun(threadId: string): ThreadActionResult {
    if (process.env.ORCH_LAB_FIXTURES !== "1") return { ok: false, error: "Lab fixtures are disabled." };
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (thread.state !== "qa") return { ok: false, state: thread.state, error: `Lab QA fixtures can only attach to a task in qa (this one is ${thread.state}).` };
    if (this.liveQa.has(threadId)) return { ok: true, state: "qa", message: "Lab QA handle already attached." };
    const row = this.db.createRun({ threadId, role: "qa", model: "lab-qa-fixture", account: "lab" });
    this.emitRun(row.id);
    const agent = new LabQaAgentRun();
    this.wireRun(agent, threadId, row.id, "qa", "lab");
    this.track(threadId, agent);
    this.liveQa.set(threadId, agent);
    agent.onEnd(() => {
      if (this.liveQa.get(threadId) === agent) this.liveQa.delete(threadId);
      this.untrack(threadId, agent);
      this.finalizeRun(row.id, agent);
    });
    agent.start("Lab QA fixture: wait until a test stops this run.");
    return { ok: true, state: "qa", message: "Lab QA handle attached." };
  }

  /** Deliver owner steering to a SCHEMA-BOUND one-shot role (QA, the auto-reviewer) — as a plain queued
   *  message, never as an interrupt, whatever mode the owner picked.
   *
   *  `priority: "now"` is not a "reach the current turn sooner" hint: it IS an interrupt. The CLI aborts
   *  the turn in flight the moment a "now" message is queued, and CodexAgentRun.send maps it straight to
   *  requestInterrupt(). The abort then comes back as a SUCCESS-shaped result carrying no structured
   *  output — so nothing downstream can tell it from a review that finished: runQA finds no verdict, it
   *  is neither an empty run nor a turn-ceiling stop, and the loop parks the task in `review` with "QA
   *  could not complete". That is how "Interrupt & inject" during QA killed a live task instead of
   *  steering it. A plain send stays in the same session for the role's next turn.
   *
   *  The planner is deliberately NOT on this path: interrupting it is safe precisely because it HAS a
   *  continuation — drainDirectorNotes re-plans off the aborted turn. Interrupt only a role that has one. */
  private steerStructuredRole(run: AgentRunLike, message: string, images?: ImageAttachment[]): void {
    this.sendCommunication(
      run,
      contentWithImages(structuredAcknowledgedInjection(message), images?.length ? images.map(toImageBlock) : []),
    );
  }

  /** Persist an explicit owner override before routing the injection anywhere. The automatic route is
   * deliberately sticky, but a later human decision outranks it and must survive both a warm handoff and
   * a server restart. Return true only for the conservative two-part directive grammar above. */
  private armOwnerQaBypass(threadId: string, message: string): boolean {
    if (!ownerRequestsFinishWithoutQa(message)) return false;
    const stage = this.db.getThreadStageOutputs(threadId);
    if (stage.ownerQaBypassedAt == null) {
      this.db.updateThreadStageOutputs(threadId, { ownerQaBypassedAt: Date.now() });
      this.hub.log("info", `Owner disabled QA for ${threadId.slice(0, 8)} and asked to finish the task.`);
    }
    return true;
  }

  private qaBypassedByOwner(threadId: string): boolean {
    return this.db.getThreadStageOutputs(threadId).ownerQaBypassedAt != null;
  }

  /** Process-local bookkeeping is only a fast path. The durable episode is the ownership authority for
   * a concurrent manager/process, especially while a fix round labels the task `implementing` or a
   * reviewer question labels it `awaiting_user`. */
  private autoReviewOwns(threadId: string): boolean {
    return this.reviewing.has(threadId) || this.db.getAutoReviewEpisode(threadId)?.status === "running";
  }

  async injectThread(
    threadId: string,
    message: string,
    mode: "append" | "interrupt" | "queue",
    images?: ImageAttachment[],
    options: { retitle?: boolean } = {},
  ): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    const qaBypassRequested = thread ? this.armOwnerQaBypass(threadId, message) : false;
    // Auto-retitle the lane to reflect the LATEST directive — the user runs several tasks at once and
    // loses track when a lane's scope drifts from its original title. Fire-and-forget (void): the
    // model call must never block, slow, or throw into the inject path. Covers every inject branch
    // below (live, QA-forward, pre-implementor buffer, resume, cold-resume) from this one spot.
    // A control-only "finish without QA" instruction is not a new task objective. Retitling the card to
    // that sentence hides the actual work title and makes this control flow unnecessarily confusing.
    if (thread && !qaBypassRequested && options.retitle !== false) void this.retitleFromInjection(threadId, message);
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
        const refs = injectRefs();
        this.appendQaFixHandoffInstruction(threadId, message, refs);
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
    // agent runs alone in the slot. Append steering still reaches QA as a plain send, but interrupt-mode
    // means "stop this review and return the task to implementation" so the cancelled/stale QA verdict
    // cannot settle the task after the owner has changed course.
    if (thread?.state === "qa") {
      const qa = this.liveQa.get(threadId);
      const inFixHandoff = this.qaFixHandoff.has(threadId) || !!this.qaFixHandoffPayload(threadId);
      if (!qa && inFixHandoff) {
        const refs = injectRefs();
        this.appendQaFixHandoffInstruction(threadId, message, refs);
        const m = this.db.addMessage({
          threadId,
          role: "director",
          kind: "system",
          content: `↪ ${mode === "interrupt" ? "interrupt requested" : "injected"} (QA already handed back; queued for the active implementor resume): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
          attachments: refs,
        });
        this.hub.publish({ type: "thread.message", threadId, message: m });
        this.touchThread(threadId);
        return {
          ok: true,
          state: "qa",
          message: qaBypassRequested
            ? "QA bypass recorded; the active implementor resume will finish this task without another QA run."
            : "QA is already returning this task to implementation; instruction queued for that implementor resume.",
        };
      }
      if (mode === "interrupt" || qaBypassRequested) {
        if (!qa) {
          if (qaBypassRequested) {
            const refs = injectRefs();
            // The handle can disappear briefly during provider failover. Persist the supersede instruction
            // anyway so the loop ignores that review result and resumes implementation exactly once.
            this.rememberQaSupersede(threadId, message, refs);
            const m = this.db.addMessage({
              threadId,
              role: "director",
              kind: "system",
              content: `Owner disabled QA. The in-flight review result will be ignored and the task will finish without another QA run: ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
              attachments: refs,
            });
            this.hub.publish({ type: "thread.message", threadId, message: m });
            this.touchThread(threadId);
            return {
              ok: true,
              state: "qa",
              message: "QA bypass recorded; the in-flight review result will be ignored and no new QA run will start.",
            };
          }
          return {
            ok: false,
            state: "qa",
            error: "QA has no live stop handle right now. The task is likely between QA runner processes; retry the interrupt when QA is visible again or when the implementor starts.",
          };
        }
        this.hub.log("info", "[INJECT] QA in progress - superseding QA and returning to the implementor");
        const refs = injectRefs();
        this.rememberQaSupersede(threadId, message, refs);
        const stopped = await this.stopQaForImplementor(threadId, qa);
        if (stopped.status === "failed") {
          if (qaBypassRequested) {
            const m = this.db.addMessage({
              threadId,
              role: "director",
              kind: "system",
              content: `Owner disabled QA. The current reviewer could not be stopped immediately, but its verdict will be ignored: ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}\n${stopped.error}`,
              attachments: refs,
            });
            this.hub.publish({ type: "thread.message", threadId, message: m });
            this.touchThread(threadId);
            return {
              ok: true,
              state: "qa",
              message: "QA bypass recorded; the current reviewer could not stop immediately, but its verdict will be ignored.",
            };
          }
          this.clearQaSupersedeMarker(threadId);
          const m = this.db.addMessage({
            threadId,
            role: "director",
            kind: "system",
            content: `↪ interrupt failed (QA is still running): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}\n${stopped.error}`,
            attachments: refs,
          });
          this.hub.publish({ type: "thread.message", threadId, message: m });
          this.touchThread(threadId);
          return { ok: false, state: "qa", error: `Could not stop QA: ${stopped.error}` };
        }
        this.resuming.add(threadId);
        this.setState(threadId, "implementing");
        const m = this.db.addMessage({
          threadId,
          role: "director",
          kind: "system",
          content: `↪ interrupt requested (QA is stopping; returning to the implementor): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
          attachments: refs,
        });
        this.hub.publish({ type: "thread.message", threadId, message: m });
        this.touchThread(threadId);
        return {
          ok: true,
          state: "implementing",
          message: qaBypassRequested
            ? "QA stop requested; the implementor will finish this task without another QA run."
            : "QA stop requested; implementor resume queued.",
        };
      }
      this.hub.log("info", "[INJECT] QA in progress - steering QA and queuing for the implementor, not re-spawning one");
      // No handle while the state is "qa" means a mid-QA account failover (runRole dropped the old handle
      // and hasn't registered the relaunched one) or the fix-round window after QA returned but before the
      // re-launched implementor goes live. Either way the queue below is what carries the note.
      if (images?.length) {
        this.threadImages.set(threadId, [...(this.threadImages.get(threadId) ?? []), ...images.map(toImageBlock)]);
      }
      if (qa) this.steerStructuredRole(qa, message, images);
      this.queuedForImplementor.set(threadId, [...(this.queuedForImplementor.get(threadId) ?? []), message]);
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `↪ injected (QA is reviewing — ${qa ? "sent to QA and queued" : "queued"} for the implementor): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
        attachments: injectRefs(),
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      return { ok: true, state: "qa" };
    }
    // Auto-review gate — the QA gate's twin, and load-bearing for the same reason: while the reviewer is
    // deciding this task's fate it is the only agent in the slot, and falling through would cold-resume an
    // implementor beside it. Steering goes to the reviewer (a `send`, never an interrupt — a one-shot
    // structured role tears down into a verdict-less result if interrupted). A note that lands after the
    // verdict simply doesn't change it; the invariant this gate guarantees is "never a second agent".
    // Keyed on the EPISODE, not just the state (see resumeThread's twin): the lane also owns the thread
    // through its fix round, which runs under 'implementing' with a window where the implementor's own
    // onEnd has cleared `this.live` — falling through there would cold-resume a second implementor.
    if (thread?.state === "reviewing" || this.autoReviewOwns(threadId)) {
      const reviewer = this.liveReviewer.get(threadId);
      const impl = this.live.get(threadId);
      const blocks = images?.length ? images.map(toImageBlock) : [];
      if (reviewer) {
        this.steerStructuredRole(reviewer, message, images);
      } else if (impl) {
        // Mid fix round: the implementor IS the agent to steer, and it takes the ordinary (non-structured)
        // injection — it has no output schema to corrupt.
        this.sendCommunication(
          impl.run,
          contentWithImages(acknowledgedInjection(message), blocks),
          mode === "interrupt" ? { priority: "now" } : undefined,
        );
      } else {
        // The sub-second window before the reviewer registers its handle (or just after it returned).
        // Buffer like the QA gate does; runAutoReview drops the buffer when the task settles, so a note
        // that missed the review can't leak into an unrelated later run of this thread.
        this.bufferDirectorNote(threadId, message);
      }
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `↪ injected (forwarded to ${reviewer ? "the auto-reviewer" : impl ? "the auto-review's fix round" : "the auto-review lane"}): ${message}${images?.length ? ` [+${images.length} image(s)]` : ""}`,
        attachments: injectRefs(),
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      return { ok: true, state: thread?.state ?? "reviewing" };
    }
    // Self-improvement gate — the auto-review gate's twin, for the same reason and with the same shape.
    // The bonus round runs on ALREADY-accepted work under 'implementing', and its implementor's own onEnd
    // clears `this.live` while the awaited result is still in flight; falling through in that window would
    // cold-resume a SECOND implementor onto the workspace and then re-park a task the caller is about to
    // settle done. Keyed on the episode, so it holds for the round's whole life.
    if (this.selfImproving.has(threadId)) {
      const impl = this.live.get(threadId);
      const blocks = images?.length ? images.map(toImageBlock) : [];
      // Buffered notes are drained by flushDirectorNotes when the round's implementor goes live, so the
      // pre-launch window (stopLive → compressed seed) loses nothing either.
      if (impl) {
        this.sendCommunication(
          impl.run,
          contentWithImages(acknowledgedInjection(message), blocks),
          mode === "interrupt" ? { priority: "now" } : undefined,
        );
      }
      else this.bufferDirectorNote(threadId, message);
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: `↪ injected (forwarded to the self-improvement round): ${message}${blocks.length ? ` [+${blocks.length} image(s)]` : ""}`,
        attachments: injectRefs(),
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      return { ok: true, state: thread?.state ?? "implementing" };
    }
    const live = this.live.get(threadId);
    if (live) {
      if (mode === "interrupt") {
        await live.run.interrupt();
        this.setState(threadId, "implementing");
      }
      const blocks = images?.length ? images.map(toImageBlock) : [];
      this.sendCommunication(
        live.run,
        contentWithImages(acknowledgedInjection(message), blocks),
        injectionSendOptions(live.run, mode),
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
      return {
        ok: true,
        state: "implementing",
        ...(qaBypassRequested
          ? { message: "QA bypass recorded; this task will settle when the implementor finishes." }
          : {}),
      };
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
    if (qaBypassRequested && thread?.state === "done") {
      return { ok: true, state: "done", message: "This task is already done; QA remains bypassed for this episode." };
    }
    if (qaBypassRequested && thread && DONEABLE.has(thread.state)) {
      return this.markDone(threadId);
    }
    return this.resumeThread(threadId, message, true);
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
    this.sendCommunication(run, acknowledgedInjection(notes.join("\n\n")), { priority: "now" });
  }

  async interruptThread(threadId: string): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (thread?.state === "qa") {
      const qa = this.liveQa.get(threadId);
      if (!qa && (this.qaFixHandoff.has(threadId) || !!this.qaFixHandoffPayload(threadId))) {
        const m = this.db.addMessage({
          threadId,
          role: "director",
          kind: "system",
          content: "↪ interrupt requested (QA already handed back; waiting for the active implementor resume)",
        });
        this.hub.publish({ type: "thread.message", threadId, message: m });
        this.touchThread(threadId);
        return {
          ok: true,
          state: "qa",
          message: "QA is already returning this task to implementation; waiting for that implementor resume.",
        };
      }
      if (!qa) {
        return {
          ok: false,
          state: "qa",
          error: "QA has no live stop handle right now. The task is likely between QA runner processes; retry the interrupt when QA is visible again or when the implementor starts.",
        };
      }
      this.rememberQaSupersede(threadId);
      const stopped = await this.stopQaForImplementor(threadId, qa);
      if (stopped.status === "failed") {
        this.clearQaSupersedeMarker(threadId);
        const m = this.db.addMessage({
          threadId,
          role: "director",
          kind: "system",
          content: `↪ interrupt failed (QA is still running)\n${stopped.error}`,
        });
        this.hub.publish({ type: "thread.message", threadId, message: m });
        this.touchThread(threadId);
        return { ok: false, state: "qa", error: `Could not stop QA: ${stopped.error}` };
      }
      this.resuming.add(threadId);
      this.setState(threadId, "implementing");
      const m = this.db.addMessage({
        threadId,
        role: "director",
        kind: "system",
        content: "↪ interrupt requested (QA is stopping; returning to the implementor)",
      });
      this.hub.publish({ type: "thread.message", threadId, message: m });
      this.touchThread(threadId);
      return {
        ok: true,
        state: "implementing",
        message: "QA stop requested; implementor resume queued.",
      };
    }
    const live = this.live.get(threadId);
    if (!live) return { ok: false, error: "No running implementor on that task." };
    await live.run.interrupt();
    this.setState(threadId, "paused");
    return { ok: true, state: "paused" };
  }

  async resumeThread(threadId: string, message?: string, operatorInitiated = false): Promise<ThreadActionResult> {
    let thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (this.deadlineDue(thread)) {
      await this.expireActiveDeadline(threadId, thread.activeDeadlineAt!);
      return {
        ok: false,
        state: "review",
        error: "This task's hard deadline has passed. Extend or clear it first, then click Resume to continue from the saved session.",
      };
    }
    if (this.deadlineParked(thread)) {
      if (!operatorInitiated) {
        return { ok: false, state: "review", error: "Automatic resume is blocked because this task reached its hard deadline." };
      }
      // Editing/clearing the clock is deliberately not itself a resume. Once the operator ALSO clicks
      // Resume, remove only the park marker; the finding/feed/run trail remain durable evidence.
      const released = this.db.updateThread(threadId, { error: null });
      if (released) {
        thread = released;
        this.hub.publish({ type: "thread.upsert", thread: released });
      }
    }
    // A restart's deferred auto-resume can fire after an operator has cancelled the task.  Cancellation
    // is terminal until an explicit Retry, so never let that stale timer resurrect gameplay or other
    // autonomous work behind the operator's back.
    if (thread.state === "cancelled") return { ok: false, error: "Task is cancelled. Retry it to start again." };
    if (!existsSync(thread.workspace)) {
      this.setState(threadId, "failed", `Can't resume — workspace "${thread.workspace}" does not exist. Re-dispatch this task with a valid path.`);
      return { ok: false, error: `Workspace "${thread.workspace}" does not exist.` };
    }
    // A queued task hasn't started yet — it has no implementor session and is waiting for a slot, so a
    // resume must NOT start it past the concurrency cap (it'll start via pumpQueue when a slot frees) and
    // must NOT take the planner-less manual-resume path. Just buffer any steering for its eventual kickoff.
    if (this.coworkWorkspaceBusy?.(thread.workspace)) {
      return {
        ok: false,
        state: thread.state,
        error: "A Co-worker turn is using this workspace. Stop it or wait for it to finish before resuming this task.",
      };
    }
    if (thread.state === "queued") {
      if (message?.trim()) this.bufferDirectorNote(threadId, message);
      return { ok: true, state: "queued" };
    }
    // QA-stage gate — mirror injectThread's, routing included: during the QA stage the implementor is
    // fully stopped and the QA agent owns the slot, so a resume here must NEVER wake or spawn an
    // implementor beside it. Steering reaches the running QA agent when there is one (a plain send — see
    // steerStructuredRole) and is queued for the implementor either way, so a QA pass can't settle the
    // task with the owner's direction unread. A boot auto-resume of a mid-QA task doesn't hit this —
    // markInterrupted flips the thread to "failed" first, so that routes through the branch below.
    if (thread.state === "qa") {
      if (message?.trim()) {
        const qa = this.liveQa.get(threadId);
        if (!qa && (this.qaFixHandoff.has(threadId) || !!this.qaFixHandoffPayload(threadId))) {
          this.appendQaFixHandoffInstruction(threadId, message);
        } else {
          if (qa) this.steerStructuredRole(qa, message);
          this.queuedForImplementor.set(threadId, [...(this.queuedForImplementor.get(threadId) ?? []), message]);
        }
      }
      return { ok: true, state: "qa" };
    }
    // Auto-review gate — same guarantee as the QA one above: the lane owns the slot, so a resume here must
    // never wake or spawn an agent beside it. Keyed on the EPISODE, not just the state, because the lane
    // also owns the thread through its fix round: that runs under 'implementing', and the implementor's own
    // onEnd clears `this.live` while the awaited result is still in flight — a state-only check would fall
    // through in exactly that window and cold-resume a SECOND implementor onto the same workspace. Steering
    // goes to whichever agent is actually live; a bare Resume is a no-op (the episode settles the task).
    if (thread.state === "reviewing" || this.autoReviewOwns(threadId)) {
      if (message?.trim()) {
        const reviewer = this.liveReviewer.get(threadId);
        const impl = this.live.get(threadId);
        if (reviewer) this.steerStructuredRole(reviewer, message);
        else if (impl) this.sendCommunication(impl.run, acknowledgedInjection(message), { priority: "now" });
        else this.bufferDirectorNote(threadId, message);
      }
      return { ok: true, state: thread.state };
    }
    // Self-improvement gate — injectThread's twin. The bonus round owns an already-accepted task through
    // 'implementing', including the window where its implementor's onEnd has already cleared `this.live`;
    // falling through there would start a second implementor and re-park a task that is about to settle
    // done. A bare Resume is a no-op (the round finishes on its own); steering reaches the round.
    if (this.selfImproving.has(threadId)) {
      if (message?.trim()) {
        const impl = this.live.get(threadId);
        if (impl) this.sendCommunication(impl.run, acknowledgedInjection(message), { priority: "now" });
        else this.bufferDirectorNote(threadId, message);
      }
      return { ok: true, state: thread.state };
    }
    const live = this.live.get(threadId);
    if (live) {
      this.sendCommunication(
        live.run,
        message?.trim() ? acknowledgedInjection(message) : "Continue.",
        { priority: "now" },
      );
      this.setState(threadId, "implementing");
      return { ok: true, state: "implementing" };
    }
    // A task that died mid-pipeline re-enters the resume-aware pipeline: it may have failed before
    // the implementor ever ran (during planning/research/approval), so we can't assume an
    // implementor session exists. runPipeline skips the stages already persisted and continues from
    // the failure point — and clears the error via the first stage's setState.
    if (thread.state === "failed") {
      const note = message?.trim() ? message : undefined;
      // A completed read task can be promoted into a real implementor session when the owner corrects
      // or extends the reader's answer. Its durable lane remains `read` for the card/history, so a
      // restart during that promoted session leaves state=failed + readerDone=true. Sending that back
      // through runPipeline would enter the read-lane short circuit, see readerDone, and return without
      // changing state — the Resume button would appear to do nothing forever. If an implementor really
      // ran, resume that promoted session directly; an interrupted reader with no implementor still
      // takes the normal resume-aware read pipeline below.
      const promotedRead =
        thread.lane === "read" &&
        this.db.getThreadStageOutputs(threadId).readerDone === true &&
        this.latestRoleRun(threadId, "implementor") != null;
      if (promotedRead) {
        this.resuming.add(threadId);
        this.setState(threadId, "implementing");
        void this.resumeImplementorOnly(thread, note);
        return { ok: true, state: "implementing" };
      }
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
    // A manual resume is never an auto-review fix round nor a post-task self-improvement round. Clearing
    // both matters most for a marker that leaked (a round whose process died outside an IN_FLIGHT state):
    // left set, the next bounce would settle this genuinely-unfinished work as done.
    this.db.updateThreadStageOutputs(thread.id, { reviewFixing: false, selfImproving: false });
    const releaseSlot = () => {
      this.activePipelines.delete(thread.id);
      this.implementorProvider.delete(thread.id);
      this.autoResumes.delete(thread.id);
      this.codexResumeWedged.delete(thread.id); // a fresh dispatch's first session may resume fine
      this.recoverReleasedCapacity();
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
    const resumeNudge = message ? acknowledgedInjection(message) : "Continue where you left off.";
    let start: LiveImplementor | null;
    try {
      start = await this.startResumedImplementor(thread, baseKickoff, resume, { effort: this.implementorEffort(thread.id), resumeNudge, directorNote: message ? resumeNudge : undefined, qaFollows: false });
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
      for (const m of buffered) this.sendCommunication(start.run, acknowledgedInjection(m), { priority: "next" });
    }
    await this.awaitImplementorCompletion(thread, this.implementorEffort(thread.id), baseKickoff, start.run, start.accountId, false, resumeNudge, false)
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
    this.clearQaFixHandoff(threadId);
    this.liveReviewer.delete(threadId);
    this.reviewing.delete(threadId);
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

  /** Restart a cancelled task from the very beginning: re-run the task-aware pipeline from the brief the
   *  director first dispatched, as if freshly
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
    if (thread.activeDeadlineAt != null && thread.activeDeadlineAt <= Date.now()) {
      return { ok: false, state: "cancelled", error: "This task's hard deadline has passed. Clear or extend it before retrying." };
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
    this.clearQaFixHandoff(threadId);
    this.liveReviewer.delete(threadId);
    this.reviewing.delete(threadId);
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
    for (const role of ["planner", "researcher", "implementor", "qa", "reviewer"] as Role[]) this.checkedIn.delete(`${threadId}:${role}`);

    // Wipe the prior attempt in the DB, then tell clients to drop the now-deleted runs/findings/feed
    // for this thread BEFORE the fresh pipeline starts streaming new ones (else the stale slice
    // lingers in the UI until the next full snapshot).
    this.db.resetThreadForRetry(threadId);
    this.hub.publish({ type: "thread.reset", threadId });

    // Leave the 'cancelled' state BEFORE dispatch — the pipeline's cancelled() guards (and the "planner
    // disabled → no early setState('planning')" branch) would otherwise abort the retry as a silent no-op,
    // leaving the task stuck in 'cancelled' with an ok:true response and no agent ever running.
    this.setState(threadId, "queued");
    const retried = this.db.getThread(threadId);
    if (retried?.activeDeadlineAt != null) this.armActiveDeadline(retried);
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
      // Issue every stop before awaiting any one of them. The normal one-role-per-slot invariant means
      // this is usually one handle; if a historical race left duplicates, a hard stop must not let the
      // second continue spending while the first provider takes time to tear down.
      await Promise.allSettled([...set].map((r) => r.stop()));
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
    this.disarmActiveDeadline(threadId);
    this.dropTerminalBookkeeping(threadId); // closed is terminal — closeThread settles via db, not setState
    this.db.abandonAutoReview(threadId, "Auto-review stopped because the task was closed.");
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
    if (this.deadlineParked(thread)) {
      return { ok: false, state: "review", error: "This task was stopped mid-work by its hard deadline. Clear or extend it and Resume before marking the work done." };
    }
    if (!DONEABLE.has(thread.state)) {
      return { ok: false, error: `A ${thread.state} task can't be marked done — only a parked (review/paused) task can.` };
    }
    await this.forceStopThreadRuns(threadId);
    this.setState(threadId, "done");
    this.hub.log("info", `Marked task ${threadId.slice(0, 8)} done (was ${thread.state}).`);
    return { ok: true, state: "done" };
  }

  /** "Auto-review & mark done": the owner delegates their OWN final review of a parked task to one agent
   *  instead of reading the diff themselves. It runs a single reviewer that verifies the work, asks them
   *  (bus ask_user) about anything only they can decide, and then either accepts the task — the same
   *  'done' markDone would have produced — or hands it back to 'review' with concrete reasons. Deliberately
   *  restricted to a genuine human-review park: a cap-parked task is mid-flight (the supervisor will resume
   *  it), so there is no finished work to judge yet. Returns immediately; the reviewer settles the task. */
  async autoReview(threadId: string, source: AutoReviewSource = "owner"): Promise<ThreadActionResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (this.coworkWorkspaceBusy?.(thread.workspace)) {
      return { ok: false, state: thread.state, error: "A Co-worker turn is using this workspace. Stop it or wait for it to finish before starting review." };
    }
    // In-memory is the fast path; the durable episode is the restart/concurrent-manager path. Report the
    // REAL state, not a blanket "reviewing" — mid fix round the board shows 'implementing'.
    if (this.autoReviewOwns(threadId)) {
      return { ok: true, state: thread.state, message: "Auto-review already owns this task." };
    }
    if (thread.state !== "review") {
      return { ok: false, error: `Only a task parked in review can be auto-reviewed — this one is ${thread.state}.` };
    }
    if (this.deadlineParked(thread)) {
      return { ok: false, error: "This task was stopped mid-work by its hard deadline. Extend or clear it and Resume the saved session; unfinished work cannot be auto-accepted." };
    }
    if ((thread.error ?? "").startsWith(CAP_PARK_PREFIX)) {
      return { ok: false, error: "This task is waiting on a usage limit and resumes itself — its work isn't finished yet, so there's nothing to review." };
    }
    if (!existsSync(thread.workspace)) {
      return { ok: false, error: `Workspace "${thread.workspace}" does not exist — the reviewer can't inspect the work.` };
    }
    const reviewerDemand = this.capacityDemand(thread, "reviewer");
    const reviewerRoute = this.preferredRoleProvider("reviewer", reviewerDemand);
    if (!reviewerRoute.provider || reviewerRoute.allKnownAtRisk) {
      return { ok: false, error: this.noteManualCapacityWait(thread, "reviewer", reviewerDemand) };
    }

    // The DB claim is the cross-tick/process lock and the unattended one-attempt-per-revision budget.
    // Explicit owner/API calls may deliberately retry an unchanged parked outcome.
    const claim = this.db.claimAutoReview(threadId, source === "supervisor" ? "supervisor" : "owner");
    if (!claim.ok) {
      const fresh = claim.thread ?? this.db.getThread(threadId);
      const active = this.db.getAutoReviewEpisode(threadId);
      if (active?.status === "running" && fresh && ["reviewing", "implementing", "awaiting_user"].includes(fresh.state)) {
        return { ok: true, state: fresh.state, message: "Auto-review already owns this task." };
      }
      return { ok: false, state: fresh?.state, error: claim.reason };
    }
    this.reviewing.add(threadId);
    // A review occupies a concurrency slot for its lifetime, exactly like a manual resume.
    this.activePipelines.add(threadId);
    // A settled task can still hold a stale live/activeRuns entry from the loop that parked it (the same
    // teardown markDone does before accepting), so the reviewer is the only agent on this thread. Claim
    // before publishing or awaiting teardown so a concurrent tick cannot enter either gap. Publishing is
    // inside the same failure boundary: an unexpected lifecycle-side-effect error must park the claim too.
    try {
      this.publishState(claim.thread);
      await this.forceStopThreadRuns(threadId);
    } catch (e) {
      const reason = `Auto-review couldn't start safely: ${String(e)}`.slice(0, MAX_REVIEW_ERROR_LEN);
      const settled = this.db.finishAutoReview({
        threadId,
        claimToken: claim.claimToken,
        status: "parked",
        reason,
      });
      if (settled.ok) this.publishState(settled.thread);
      this.reviewing.delete(threadId);
      this.activePipelines.delete(threadId);
      this.recoverReleasedCapacity();
      return { ok: false, state: settled.thread?.state, error: reason };
    }
    this.hub.log("info", `Auto-reviewing task ${threadId.slice(0, 8)} "${thread.title.slice(0, 48)}".`);
    void this.runAutoReview(thread, claim.claimToken);
    return { ok: true, state: "reviewing" };
  }

  /** Run the auto-reviewer and settle the task on its verdict — with the fix loop that makes the button
   *  mean what it says. A hand-back is rarely something the owner has to do by hand: the reviewer is
   *  read-only by design, so the one thing blocking a task is routinely work an implementor could finish in
   *  a minute (the case this was built for handed a whole task back because a report file sat outside the
   *  workspace). So each hand-back with concrete issues buys ONE implementor fix round plus a re-review,
   *  up to `maxReviewFixRounds`. Only the final verdict settles the task, and only an acceptance is 'done'.
   *
   *  Like runReader it never leaves the task in a running state: every exit — verdict, error, or a thrown
   *  run — puts it back in 'review' or moves it to 'done'. */
  private async runAutoReview(thread: Thread, claimToken: string): Promise<void> {
    try {
      const total = this.settings().maxReviewFixRounds;
      let res = await this.reviewToVerdict(thread, this.freshReviewKickoff(thread));
      let fixRounds = 0;
      for (let round = 1; round <= total; round++) {
        if (this.cancelled(thread.id)) return;
        const handedBack = this.handBackWithIssues(res);
        if (!handedBack) break;
        if (!(await this.runReviewFixRound(thread, handedBack, round, total, claimToken))) return; // the round settled it
        if (this.cancelled(thread.id)) return;
        fixRounds = round;
        res = await this.reviewRecheck(thread, handedBack);
      }
      if (this.cancelled(thread.id)) return;
      this.finalizeReview(thread, res, fixRounds, claimToken);
    } catch (e) {
      this.hub.log("warn", `Auto-review of ${thread.id.slice(0, 8)} failed: ${String(e)}`);
      const state = this.db.getThread(thread.id)?.state;
      if (!this.cancelled(thread.id) && (state === "reviewing" || state === "implementing")) {
        this.parkAutoReview(thread.id, claimToken, `Auto-review failed to run: ${String(e)}`.slice(0, MAX_REVIEW_ERROR_LEN));
      }
    } finally {
      this.clearReviewFixingIfOwned(thread.id, claimToken);
      this.reviewing.delete(thread.id);
      this.liveReviewer.delete(thread.id);
      // Anything the owner injected into the sub-second window where the reviewer had no steerable handle
      // was buffered by the inject gate; nothing downstream of a review drains it, so drop it here rather
      // than let it leak into an unrelated later run of this thread (runPipeline's finally does the same).
      this.directorNotes.delete(thread.id);
      this.activePipelines.delete(thread.id);
      this.recoverReleasedCapacity();
    }
  }

  /** Settle a claimed episode and publish the already-committed task row. A false return means another
   * lifecycle owner (restart, deadline, cancel, newer claim) won; the caller must not post a stale verdict
   * finding or mutate state after that point. */
  private persistAutoReviewOutcome(
    threadId: string,
    claimToken: string,
    status: "accepted" | "parked",
    reason: string,
    verdict?: ReviewerOutput | null,
  ): boolean {
    const settled = this.db.finishAutoReview({ threadId, claimToken, status, reason, verdict });
    if (!settled.ok) {
      this.hub.log("warn", `Discarded stale auto-review outcome for ${threadId.slice(0, 8)}: ${settled.reason}`);
      return false;
    }
    this.publishState(settled.thread);
    return true;
  }

  private parkAutoReview(threadId: string, claimToken: string, reason: string, verdict?: ReviewerOutput | null): boolean {
    return this.persistAutoReviewOutcome(threadId, claimToken, "parked", reason, verdict);
  }

  /** A dead process can finish unwinding after boot reconciliation and after the owner starts a newer
   * episode. Do not let that stale callback erase the new episode's restart marker. */
  private clearReviewFixingIfOwned(threadId: string, claimToken: string): void {
    const episode = this.db.getAutoReviewEpisode(threadId);
    if (episode?.status === "running" && episode.claimToken !== claimToken) return;
    this.db.updateThreadStageOutputs(threadId, { reviewFixing: false });
  }

  /** The full review request — the brief, the park reason, the plan's scope hint, the unsurfaced-artifact
   *  hint. Built from the thread SNAPSHOT taken before the state flipped to 'reviewing', so it still
   *  carries the park reason the owner would have read. Also the re-check's fallback when the reviewer
   *  left no session to resume. */
  private freshReviewKickoff(thread: Thread): string | unknown[] {
    const unsurfaced = detectUnsurfacedArtifacts(this.db, thread);
    const plan = this.db.getThreadStageOutputs(thread.id).plan ?? undefined;
    const kickoff = reviewerKickoff(thread, plan, unsurfaced, this.settings().maxReviewFixRounds);
    return this.kickoffContent(thread.id, this.withOfficeNote(thread, "reviewer", kickoff));
  }

  /** The reviewer's verdict when — and only when — it is a hand-back the implementor can act on. A
   *  verdict-less run has nothing to fix, and an `accept: false` with no concrete issues gives the
   *  implementor nothing to work from, so both fall through to the owner rather than paying for a fix
   *  round that would be guesswork. */
  private handBackWithIssues(res: ResultEvent | undefined): ReviewerOutput | undefined {
    const out = res?.structuredOutput as ReviewerOutput | undefined;
    if (!res || res.isError || !out || out.accept) return undefined;
    return out.issues?.length ? out : undefined;
  }

  /** One implementor fix round driven by the auto-reviewer's issue list. Returns true when the fix
   *  finished and the task is ready to be re-reviewed; false when this round SETTLED the task itself
   *  (parked, blocked by routing, or cancelled) and the caller must stop.
   *
   *  Reuses the pipeline's implementor path wholesale — the same warm/cold resume gate, account failover,
   *  and turn-limit/stall/empty auto-continue a QA fix-round gets — so a fix round is exactly as robust as
   *  any other implementor run. It deliberately does NOT re-enter the QA loop: the owner delegated their
   *  own final review to the reviewer, so the reviewer is the gate that decides, and QA already had its
   *  rounds earlier in this task's life. Every exit that isn't `true` has already parked the task. */
  private async runReviewFixRound(
    thread: Thread,
    out: ReviewerOutput,
    round: number,
    total: number,
    claimToken: string,
  ): Promise<boolean> {
    this.postFinding({
      threadId: thread.id,
      fromRole: "reviewer",
      summary: `Auto-review handed this back — sending it to the implementor to fix (round ${round} of ${total}): ${out.summary}`,
      detail: `${formatReviewIssues(out)}\n\nThe implementor is being relaunched with this list; the reviewer then re-checks its work and makes the final call.`,
      severity: "warning",
    });
    // The fix runs under 'implementing' — an auto-resume state — so a restart would otherwise revive it
    // into the normal pipeline. Mark the round durably; markInterrupted re-parks it for a fresh click.
    this.db.updateThreadStageOutputs(thread.id, { reviewFixing: true });
    this.capParked.delete(thread.id);
    this.autoResumes.set(thread.id, 0);
    try {
      if (!this.gateImplementorProvider(thread)) {
        // The shared gate parks 'failed', which is right for a fresh dispatch but wrong here: this task's
        // work is FINISHED and was parked for the owner, and 'failed' would arm a Resume into the pipeline.
        this.parkAutoReview(
          thread.id,
          claimToken,
          "Auto-review found issues but couldn't start a fix round — no implementor backend is available under the current subscription settings. Fix the routing, then run the auto-review again.",
          out,
        );
        return false;
      }
      const effort = this.implementorEffort(thread.id);
      const kickoff = this.db.getThreadStageOutputs(thread.id).kickoff ?? thread.brief;
      const fixMsg = reviewFixMessage(out, this.officeName(thread.id, "reviewer"));
      // State stays 'reviewing' across the (possibly awaited) session compression — startImplementor flips
      // it only once the run is live — so an inject landing in that window routes to the reviewer gate's
      // buffer instead of spawning a second agent, and flushDirectorNotes delivers it a moment later.
      const start = await this.startResumedImplementor(thread, kickoff, this.lastImplementorSession.get(thread.id) ?? this.latestImplementorSession(thread.id), {
        effort,
        resumeNudge: fixMsg,
        directorNote: fixMsg,
        qaFollows: false,
      });
      if (!start) return false; // cancelled while compressing the prior session
      this.flushDirectorNotes(thread.id, start.run);
      let res = await this.awaitImplementorCompletion(thread, effort, kickoff, start.run, start.accountId, false, fixMsg, false);
      // Honor anything the owner queued during the fix, exactly as the QA loop does at its hand-off — the
      // Queue button promises delivery at a boundary, and this is one. Nothing else on this lane drains it.
      res = await this.drainQueuedImplementor(thread, effort, kickoff, res, false);
      // Flip BEFORE the implementor is stopped (the QA loop's ordering, for the same reason): its own
      // onEnd races the awaited result and usually wins, so an 'implementing' thread with an empty
      // `this.live` is a window where a Resume/inject would fall through and spawn a SECOND implementor.
      if (!this.cancelled(thread.id)) this.setState(thread.id, "reviewing");
      if (this.cancelled(thread.id)) return false;
      if (!res || res.isError) {
        // Never leave the auto-resume marker on: `resumeCapParked` hands a CAP_PARK task to runPipeline,
        // which would finish this task through the QA loop and could mark it done — a verdict the reviewer
        // never gave, on a lane whose whole contract is that only its acceptance settles the task. So a cap
        // during a fix round parks like any other failure, with the button re-armed for a fresh review.
        const capped = this.capParked.get(thread.id);
        this.capParked.delete(thread.id);
        const why = capped
          ? "every backend was usage-capped mid-fix."
          : res?.isError
            ? runErrorText(res)
            : "The implementor ended its turn without finishing.";
        this.postFinding({
          threadId: thread.id,
          fromRole: "implementor",
          summary: "The auto-review fix round didn't complete — needs your review",
          detail: `${why}\n\nStill open:\n${formatReviewIssues(out)}`,
          severity: "warning",
        });
        this.parkAutoReview(
          thread.id,
          claimToken,
          `The auto-review's fix round didn't finish — ${why} The issues it was sent to fix are still open, so this needs your review.`.slice(0, MAX_REVIEW_ERROR_LEN),
          out,
        );
        return false;
      }
      return true;
    } finally {
      // The implementor must be down before the reviewer takes the slot back — one agent at a time — and
      // this is the only place that holds on a THROWN round too (which otherwise leaves an agent running
      // on a task the catch above has already parked).
      await this.stopLive(thread.id);
      this.clearReviewFixingIfOwned(thread.id, claimToken);
      this.autoResumes.delete(thread.id);
      this.implementorProvider.delete(thread.id);
      this.queuedForImplementor.delete(thread.id);
    }
  }

  /** Re-review after a fix round. Warm-resumes the reviewer's OWN session where it has one: it already
   *  knows the brief, the diff it read and precisely what it asked for, so re-checking is a fraction of a
   *  cold review — and it can't forget an issue it raised. Falls back to a full fresh review when the
   *  session is gone (an errored or empty first run leaves none). */
  private reviewRecheck(thread: Thread, out: ReviewerOutput): Promise<ResultEvent | undefined> {
    const prior = this.resumableReviewSession(thread.id);
    if (!prior) return this.reviewToVerdict(thread, this.freshReviewKickoff(thread));
    return this.reviewToVerdict(thread, reviewerRecheckKickoff(out), prior);
  }

  /** The reviewer's own last session, but only while the backend that produced it can still take the run.
   *  A session id doesn't travel between backends, and a re-check/continue nudge only means anything to a
   *  session that remembers the review — so when its backend is capped or gone the caller must start a full
   *  fresh review instead of nudging a stranger. (The reviewer runs on Claude by default and on z.ai when
   *  every Claude sub is capped, so the two can differ within one episode.) */
  private resumableReviewSession(threadId: string): RoleSession | undefined {
    const prior = this.latestRoleRun(threadId, "reviewer");
    if (!prior || !providerServesRole("reviewer", prior.provider)) return undefined;
    const thread = this.db.getThread(threadId);
    if (!thread) return undefined;
    return this.providerSafeForRole(prior.provider, "reviewer", this.capacityDemand(thread, "reviewer")) ? prior : undefined;
  }

  /** Run the auto-reviewer to a verdict, recovering it from the two ways it can stop without deciding:
   *  cut off at the per-session turn ceiling, or returning empty without ever reaching the model. The whole
   *  point of the button is that the owner does NOT have to read the diff, so handing the task back over a
   *  stop that says nothing about the work is exactly the outcome worth one more run — the same reasoning as
   *  the implementor and QA paths.
   *
   *  The budget is in-process only, unlike QA's: a restart during 'reviewing' re-parks the task for a fresh
   *  click (`markInterrupted`) rather than resuming it, so there is no cross-restart budget to keep.
   *
   *  `resumeFrom` starts from an existing review session (a post-fix re-check). Starting over then means
   *  a FULL fresh review, not re-sending the short re-check nudge — that nudge only makes sense to a session
   *  that still remembers what it asked for, and an empty run proves this one doesn't. */
  private async reviewToVerdict(thread: Thread, kickoff: string | unknown[], resumeFrom?: RoleSession): Promise<ResultEvent | undefined> {
    const startOver = (): Promise<ResultEvent | undefined> => this.runReviewer(thread, resumeFrom ? this.freshReviewKickoff(thread) : kickoff);
    let attemptFrom = Date.now();
    let res = await this.runReviewer(thread, kickoff, resumeFrom);
    let empty = this.markIfEmpty(thread.id, attemptFrom, res);
    for (let spent = 0; spent < MAX_REVIEW_RECOVERIES; spent++) {
      if (res?.structuredOutput || this.cancelled(thread.id)) break;
      if (!empty && !this.isTurnLimitStop(res)) break;
      // A cut-off review left real progress in the session and is worth waking — on the backend that holds
      // it. An empty run never reached the model, so waking it again is the one thing already known not to
      // work; and a session whose backend can no longer take it is unreachable in the same way. Both spend
      // the recovery on a full fresh review rather than nudging a session that can't answer.
      const prior = empty ? undefined : this.resumableReviewSession(thread.id);
      this.noteReviewRecovery(thread.id, { empty, resuming: !!prior, spent });
      attemptFrom = Date.now();
      res = prior ? await this.runReviewer(thread, reviewerContinueKickoff(), prior) : await startOver();
      empty = this.markIfEmpty(thread.id, attemptFrom, res);
    }
    return res;
  }

  /** Whether a reviewer attempt came back empty — recording it as the failure it is when so. An empty run
   *  arrives as a SUCCESS result, so it can only be recognised from the absence of any output; and it is
   *  stamped the moment it is seen, whether or not recovery budget remains, because the run history must not
   *  keep a `done` row with 0 turns and $0 and the park message reads its reason off that row. */
  private markIfEmpty(threadId: string, attemptFrom: number, res: ResultEvent | undefined): boolean {
    const empty = this.ranSilently(threadId, "reviewer", attemptFrom, res);
    if (empty) this.markSilentRun(threadId, "reviewer");
    return empty;
  }

  /** Say which involuntary stop the auto-review is recovering from, whether the recovery wakes the same
   *  session or starts over, and that it is bounded — the owner is watching a button they clicked, so a
   *  silent extra Opus run would look like a hang. */
  private noteReviewRecovery(threadId: string, r: { empty: boolean; resuming: boolean; spent: number }): void {
    const attempt = `(attempt ${r.spent + 2} of ${MAX_REVIEW_RECOVERIES + 1})`;
    const stop = r.empty
      ? {
          summary: "Auto-review came back empty without reviewing anything — starting it over",
          detail: `The review session returned without ever reaching the model (0 turns, $0), so nothing was verified. Running it again from scratch ${attempt}.`,
        }
      : r.resuming
        ? {
            summary: "Auto-review stopped at its turn ceiling before deciding — continuing the same review",
            detail: `The reviewer was cut off mid-review, not finished. Waking its session with a fresh turn budget ${attempt}.`,
          }
        : {
            summary: "Auto-review stopped at its turn ceiling, and its session can't be resumed — starting a fresh review",
            detail: `The reviewer was cut off mid-review, but the backend holding that session can't take the run now, and a "carry on" nudge means nothing to a session that never heard the question. Reviewing from scratch instead ${attempt}.`,
          };
    this.postFinding({ threadId, fromRole: "reviewer", ...stop, severity: "note" });
  }

  private runReviewer(thread: Thread, kickoff: string | unknown[], resumeFrom?: RoleSession): Promise<ResultEvent | undefined> {
    return this.runRole(
      thread,
      "reviewer",
      kickoff,
      ({ token, resume, runId }) => {
        const bus = createBusServer(this, { threadId: thread.id, role: "reviewer", getRunId: () => runId });
        const office = createOfficeServer(this, { threadId: thread.id, role: "reviewer", workspace: thread.workspace, title: thread.title, getRunId: () => runId });
        const cfg = reviewerConfig(thread.workspace, { bus, office }, this.communicationPolicyOptions());
        cfg.oauthToken = token;
        if (resume) cfg.resume = resume;
        return cfg;
      },
      resumeFrom?.sessionId,
      // The session only resumes on the backend that produced it, so the resume and its provider travel
      // together — `resumableReviewSession` has already checked that backend can take the run.
      resumeFrom ? { preferredProvider: resumeFrom.provider } : undefined,
    );
  }

  /** The reviewer's verdict decides the task: accepted → 'done' (identical to the owner clicking Mark
   *  done); anything else → back to 'review' with the reasons recorded as a finding so they're readable
   *  without re-opening the run. A run that produced no verdict (errored, capped, hit its turn ceiling)
   *  also re-parks — an absent decision is never an acceptance. `fixRounds` is how many implementor fix
   *  rounds this episode already spent, which is the difference between "the reviewer said no" and "it
   *  said no, was fixed, and still says no" — the second is worth the owner's attention, the first often
   *  isn't. */
  private finalizeReview(thread: Thread, res: ResultEvent | undefined, fixRounds: number, claimToken: string): void {
    const tried = fixRounds ? ` (after ${fixRounds} fix ${fixRounds === 1 ? "round" : "rounds"})` : "";
    const out = res?.structuredOutput as ReviewerOutput | undefined;
    if (!res || res.isError || !out) {
      const detail = res ? this.reviewFailureDetail(thread.id, res) : undefined;
      const reason = `Auto-review couldn't reach a verdict${tried}${detail ? ` — ${detail}` : ""} — still needs your review.`.slice(0, MAX_REVIEW_ERROR_LEN);
      if (!this.parkAutoReview(thread.id, claimToken, reason)) return;
      this.postFinding({
        threadId: thread.id,
        fromRole: "reviewer",
        summary: `Auto-review couldn't reach a verdict${tried} — the task stays parked for you`,
        detail,
        severity: "warning",
      });
      return;
    }
    if (!out.accept) {
      const reason = `Auto-review didn't accept it${tried}: ${out.summary}`.slice(0, MAX_REVIEW_ERROR_LEN);
      if (!this.parkAutoReview(thread.id, claimToken, reason, out)) return;
      this.postFinding({
        threadId: thread.id,
        fromRole: "reviewer",
        summary: `Auto-review handed this back${tried}: ${out.summary}`,
        detail: formatReviewIssues(out),
        severity: "warning",
      });
      return;
    }
    if (!this.persistAutoReviewOutcome(thread.id, claimToken, "accepted", out.summary, out)) return;
    this.postFinding({
      threadId: thread.id,
      fromRole: "reviewer",
      summary: `Auto-review accepted this as finished: ${out.summary}`,
      detail: formatReviewIssues(out) || undefined,
      severity: "info",
    });
    this.hub.log("info", `Auto-review accepted task ${thread.id.slice(0, 8)} — marked done.`);
  }

  /** Why an auto-review ended without a verdict, for the park message. A verdict-less SUCCESS result carries
   *  no reason of its own — `runErrorText` would render it as the nonsense "Run failed (success)." — so fall
   *  back to what the run row recorded, which for an empty run names the real cause. */
  private reviewFailureDetail(threadId: string, res: ResultEvent): string {
    if (res.isError) return runErrorText(res);
    const runId = this.latestRunIdOf(threadId, "reviewer");
    const recorded = runId ? this.db.getRun(runId)?.error?.trim() : undefined;
    return recorded || "The review ran but returned no verdict, so there is nothing to accept or hand back on.";
  }

  /** Force-stop any lingering agent run for a thread and drop its in-memory bookkeeping, leaving the
   *  persisted state untouched. A parked task can hold a stale activeRuns/live entry after its loop
   *  settles; clearing it stops anything resurrecting the task or counting it as live. */
  private async forceStopThreadRuns(threadId: string): Promise<void> {
    this.stopping.add(threadId);
    const set = this.activeRuns.get(threadId);
    if (set) {
      // Stop every handle concurrently. There should be one; if a prior race left duplicates, none
      // gets extra paid time merely because another provider is slow to tear down.
      await Promise.allSettled([...set].map((r) => r.stop()));
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
    this.clearQaFixHandoff(threadId);
    this.liveReviewer.delete(threadId);
    this.directorNotes.delete(threadId);
    this.queuedForImplementor.delete(threadId);
    this.implementorProvider.delete(threadId);
    this.codexResumeWedged.delete(threadId);
    this.stopping.delete(threadId);
  }

  /** Drop the per-thread bookkeeping that has to survive the pipeline LOOP — so a PARKED task can still
   *  resume — but has no reason to outlive a TRULY-terminal state (done / cancelled / closed / dismissed).
   *  These three structures are keyed by thread id and were previously cleared ONLY on retryThread, so
   *  every finished task leaked one entry each (a session-id string, a throttle epoch, ~4 check-in keys)
   *  for the whole process lifetime — a slow but genuinely unbounded climb toward an OOM on a long-running
   *  server. Called from every terminal exit (setState done/cancelled, closeThread, dismissThread). Must
   *  NEVER run on 'failed' (the pipeline re-enters it on cap/token/boot resume) or on a review/paused park
   *  (still resumable) — those keep the session cache warm. Reading the session elsewhere always falls back
   *  to latestImplementorSession(db), so dropping the cache here never loses a resumable session. */
  private dropTerminalBookkeeping(threadId: string): void {
    this.capResumeNotifiedAt.delete(threadId);
    this.lastImplementorSession.delete(threadId);
    for (const role of ["planner", "researcher", "implementor", "qa", "reviewer"] as Role[]) {
      this.checkedIn.delete(`${threadId}:${role}`);
    }
  }

  /** Restore a closed task back to the state it was closed from, returning it to the main board. */
  restoreThread(threadId: string): ThreadActionResult {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "No such task." };
    if (thread.state !== "closed") return { ok: false, error: "That task isn't closed." };
    const updated = this.db.restoreThread(threadId);
    if (updated) {
      this.hub.publish({ type: "thread.upsert", thread: updated });
      if (this.deadlineDue(updated)) void this.expireActiveDeadline(threadId, updated.activeDeadlineAt!);
      else if (updated.activeDeadlineAt != null) this.armActiveDeadline(updated);
    }
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
      this.liveReviewer.has(threadId) ||
      this.autoReviewOwns(threadId) ||
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
    this.dropTerminalBookkeeping(threadId); // the row is about to be deleted — drop its bookkeeping too
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
    this.disarmActiveDeadline(threadId);
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
      this.sendCommunication(
        live.run,
        `[Heads-up finding] ${finding.summary}${finding.detail ? `\n${finding.detail}` : ""}`,
        { priority: "next" },
      );
      this.db.markFindingRouted(finding.id);
    }
  }

  /** CLI backends cannot reach the in-process bus MCP server, so their runners turn a deliberately
   * simple `OPERATOR_NOTE:` line into this same service write. Keep the service here instead of a
   * runner-owned DB write: it is the single place that clips bodies, validates URLs, de-dupes a task's
   * same link, snapshots list metadata, and broadcasts the authoritative list. */
  private postCliOperatorNote(thread: Thread, role: Role, body: string, url?: string): void {
    const result = new OperatorNotes(this.db, this.hub).add({
      body,
      url: url ?? null,
      threadId: thread.id,
      threadTitle: thread.title,
      workspace: thread.workspace,
      fromRole: role,
      fromName: this.officeName(thread.id, role),
    });
    if (!result.ok) {
      this.hub.log("warn", `Ignored CLI operator note from ${role} on ${thread.id.slice(0, 8)}: ${result.error ?? "invalid note"}`);
    }
  }

  /** CLI runners turn `DELIVERABLE: label | path` into the same authoritative finding write as the
   * MCP `post_deliverable` tool. Carry the real run id so the QA backstop can prove this task surfaced
   * the file, and publish through postFinding so an already-open console receives the card immediately. */
  private postCliDeliverable(thread: Thread, role: Role, runId: string, label: string, path: string): void {
    this.postFinding({
      threadId: thread.id,
      fromRole: role,
      fromRunId: runId,
      kind: "deliverable",
      summary: label,
      detail: null,
      path,
      label,
      severity: "info",
    });
  }

  // ---- the online office: the same coordination, across machines ----

  /** Wire the cross-machine office in. Attached after construction (index.ts) rather than taken as a
   *  constructor argument, so every existing harness — and a console running with the office switched
   *  off — builds a ThreadManager the same way it always did. */
  attachOnlineOffice(office: OnlineOffice): void {
    this.online = office;
  }

  /** The agents this instance advertises to the relay: exactly the live set the local office strip
   *  shows, named the same way, plus the workspace the relay resolves a repo identity from. */
  onlineRoster(): LocalAgentSnapshot[] {
    return this.liveAgentThreads().map((l) => ({
      key: agentKey(l.threadId, l.role),
      name: this.officeName(l.threadId, l.role),
      role: l.role,
      title: l.title,
      workspace: l.workspace,
    }));
  }

  /**
   * A coordination line from an agent on someone else's machine. It is persisted into the LOCAL room it
   * belongs to — so it shows up in the console's chatroom, in `chat_read`, and in the room history that
   * survives a restart — and then pushed into the live implementors working that repo, exactly like a
   * local teammate's post. `workspaces` is empty for a repo nobody here is working, in which case the
   * line still lands in the office room so the console shows the office is alive.
   */
  receiveRemoteChat(msg: RelayChat, workspaces: string[]): void {
    const workspace = workspaces[0] ?? null;
    const project = msg.room !== ONLINE_OFFICE_ROOM && !!workspace;
    const senderName = `${msg.senderName} @ ${msg.instanceName}`;
    // Dedup on the relay's own message id: `history` replays a room's backlog on every (re)entry — a
    // reconnect after a dropped socket, and equally the first connect after a restart — so without this
    // the room's whole backlog would be re-persisted and re-delivered.
    const seen = this.seenRemoteChat();
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > REMOTE_CHAT_SEEN_MAX) {
      for (const id of [...seen].slice(0, Math.floor(REMOTE_CHAT_SEEN_MAX / 2))) seen.delete(id);
    }
    this.db.kvSet(REMOTE_CHAT_SEEN_KV, JSON.stringify([...seen]));
    const stored = this.db.addChatMessage({
      room: project ? repoRoom(workspace!) : GENERAL_ROOM,
      scope: project ? "project" : "general",
      workspace: project ? workspace : null,
      threadId: null,
      runId: null,
      role: isRole(msg.role) ? msg.role : "implementor",
      kind: "chat",
      body: msg.body,
      senderName,
      remoteInstance: msg.instanceName,
    });
    this.hub.publish({ type: "chat.message", message: stored });
    if (!project) return;
    this.pushToRepo(workspace!, (cli) => remoteChatPush(msg, senderName, cli));
  }

  /** The remote-chat dedup set, hydrated from kv on first use (Set iteration is insertion order, so the
   *  ids restored here stay the oldest and are the first trimmed). A corrupt or missing blob simply
   *  starts empty — dedup degrades to per-process, never throws on an incoming message. */
  private seenRemoteChat(): Set<string> {
    if (this.remoteChatSeenLoaded) return this.remoteChatSeen;
    this.remoteChatSeenLoaded = true;
    try {
      const raw = this.db.kvGet(REMOTE_CHAT_SEEN_KV);
      const ids: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.remoteChatSeen.add(id);
    } catch {
      /* not worth a log: the only cost is that this instance re-dedups from empty */
    }
    return this.remoteChatSeen;
  }

  /** Deliver one push into every live implementor working `workspace`. The builder is called per
   *  recipient with whether that backend reads the MCP office (Claude/z.ai) or the CLI text bridge. */
  private pushToRepo(workspace: string, build: (cli: boolean) => string): void {
    const norm = normalizeWorkspace(workspace);
    for (const [tid, live] of this.live) {
      const t = this.db.getThread(tid);
      if (!t || normalizeWorkspace(t.workspace) !== norm) continue;
      this.sendCommunication(live.run, build(this.isCliOfficeBridge(live.accountId)), { priority: "next" });
    }
  }

  /** Agents on another machine just started working a repo this instance is also in. Wake the live
   *  implementors here the same way `ensureGroup` wakes them for a local joiner — a remote teammate is
   *  exactly as able to land conflicting commits, and rather harder to notice. */
  remoteTeammatesJoined(repoLabel: string, workspaces: string[], joiners: RelayPresentAgent[]): void {
    if (!workspaces.length || !joiners.length) return;
    const home = workspaces[0]!;
    // One announcement per MACHINE, not per joiner: the room's participant count is a count of machines,
    // so a batch spanning two of them has to leave a row stamped with each — otherwise the second machine
    // is invisible to `isCollaborationRoom` until one of its agents happens to speak.
    for (const [instanceName, list] of byInstance(joiners)) {
      const who = list.map((j) => `${j.name} (${j.role}) on "${j.title}"`).join(", ");
      const line = `${who} from ${instanceName}`;
      for (const workspace of workspaces) this.pushToRepo(workspace, (cli) => remoteJoinPush(repoLabel, line, list.length, cli));
      const m = this.db.addChatMessage({
        room: repoRoom(home),
        scope: "project",
        workspace: home,
        threadId: null,
        role: "system",
        kind: "system",
        body: `🌐 ${line} joined ${repoLabel} from another machine — coordinate here.`,
        remoteInstance: instanceName,
      });
      this.hub.publish({ type: "chat.message", message: m });
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
    // …and out to the machines sharing this repository over the internet. Fire-and-forget: the local
    // copy is already persisted, so a relay that is down must never fail an agent's chat_post.
    this.online?.postChat({ workspace: project ? workspace : null, body: m.body, senderName: m.senderName ?? input.role, role: input.role });
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
      this.sendCommunication(
        live.run,
        this.isCliOfficeBridge(live.accountId) ? this.cliTeamChatPush(m, who) : text,
        { priority: "next" },
      );
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
  directorChatPost(room: string, body: string, messageId?: string): ChatMessage {
    const text = body.trim();
    if (!text) throw new Error("empty director message");
    const general = room === GENERAL_ROOM;
    const workspace = general ? null : this.workspaceForRoom(room);
    const who = this.directorName();
    const m = this.db.addChatMessage({
      id: messageId,
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
    // "now" IS an interrupt, and one post steers every implementor in the room at once — so the trailer
    // has to say that this is steering, not a hand-off. An implementor that answers the post and ENDS its
    // turn returns a finished-looking result, which settles its stage and sends the task to QA half-done.
    const where = general ? "the office" : "this repo";
    const carryOn =
      "This is steering for the work you're already on, not a hand-off: acknowledge it, apply it, and carry " +
      "straight on with your task — don't end your turn or stop working because of this message.";
    const push =
      `📣 [${who} (director) → ${general ? "office" : "your team"}] ${text}\n` +
      `(A directive from ${config.ownerName} to all agents in ${where}. Coordinate among yourselves who takes it — don't all grab it, and don't all assume someone else will — then reply with chat_post so the others know. ${carryOn})`;
    const norm = general ? null : normalizeWorkspace(workspace ?? room.replace(/^repo:/, ""));
    let pinged = 0;
    for (const [tid, live] of this.live) {
      if (!general) {
        const t = this.db.getThread(tid);
        if (!t || normalizeWorkspace(t.workspace) !== norm) continue;
      }
      this.sendCommunication(
        live.run,
        this.isCliOfficeBridge(live.accountId) ? this.cliDirectorChatPush(text, general) : push,
        { priority: "now" },
      );
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
      `${marker}: ... line so the others know. This is steering for the work you're already on, not a hand-off: apply it and ` +
      `carry straight on with your task — don't stop working because of this message.)`
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
    const local: RosterEntry[] = this.liveAgentThreads().map((l) => ({
      threadId: l.threadId,
      name: this.officeName(l.threadId, l.role),
      title: l.title,
      workspace: l.workspace,
      role: l.role,
      self: l.threadId === threadId,
      sameRepo: l.threadId !== threadId && normalizeWorkspace(l.workspace) === myNorm,
    }));
    // Coworkers on other machines. `sameRepo` is true only for the ones in the caller's repository —
    // the relay tells us that by repo IDENTITY, which is the whole point: their path is not ours.
    const remoteInRepo = new Set(this.online?.remotePeers(me?.workspace ?? "").map((a) => `${a.instanceId}:${a.key}`) ?? []);
    const remote: RosterEntry[] = (this.online?.status().remoteAgents ?? []).map((a) => ({
      threadId: `${a.instanceId}:${a.key}`,
      name: a.name,
      title: a.title,
      workspace: a.repoLabel || a.repoKey,
      role: isRole(a.role) ? a.role : "implementor",
      self: false,
      sameRepo: remoteInRepo.has(`${a.instanceId}:${a.key}`),
      instance: a.instanceName,
    }));
    return [...local, ...remote];
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

  /** Other live agents working a thread's repository — the teammates it can collide with. Local ones
   *  share the working tree; ONLINE ones share only the remote, and both are peers for the purpose of
   *  switching the office on: a remote agent can land a conflicting commit just as easily. */
  private repoPeers(thread: Thread): { threadId: string; role: Role; title: string; instance?: string }[] {
    const myNorm = normalizeWorkspace(thread.workspace);
    const local = this.liveAgentThreads()
      .filter((l) => l.threadId !== thread.id && normalizeWorkspace(l.workspace) === myNorm)
      .map((l) => ({ threadId: l.threadId, role: l.role, title: l.title }));
    const remote = (this.online?.remotePeers(thread.workspace) ?? []).map((a) => ({
      threadId: `${a.instanceId}:${a.key}`,
      role: isRole(a.role) ? a.role : ("implementor" as Role),
      title: a.title,
      instance: a.instanceName,
    }));
    return [...local, ...remote];
  }

  /** Called when an agent starts: if 2+ distinct tasks are now live in the same repo, they form a
   *  project room. Announce each not-yet-grouped participant once (durably, via chatThreadInRoom) so
   *  every current member is recorded in the room — that's what surfaces the "Chatroom" button on their
   *  tasks and the standing huddle in the office strip. It's also the office ON-switch: a task that
   *  started ALONE carried no office context, so as each member is first grouped we (a) backfill its
   *  general-office check-in (a solo worker stayed quiet) and (b) wake every already-running implementor
   *  incumbent with a "so-and-so joined" push so they start coordinating without polling — including the
   *  2nd, 3rd, … joiner, each announced exactly once. A member is a fresh "joiner" only the first time it
   *  enters the room; `chatThreadInRoom` is the durable dedup, so a bounce/auto-resume (every member
   *  already in the room) re-announces nobody and re-pings nobody. */
  private ensureGroup(threadId: string): void {
    const t = this.db.getThread(threadId);
    if (!t) return;
    const myNorm = normalizeWorkspace(t.workspace);
    const live = this.liveAgentThreads().filter((l) => normalizeWorkspace(l.workspace) === myNorm);
    const roleByThread = new Map(live.map((l) => [l.threadId, l.role] as const));
    const distinct = new Set(live.map((l) => l.threadId));
    if (distinct.size < 2) return;
    const room = repoRoom(t.workspace);
    // Members entering the room for the first time this call — the tasks the office is switching ON for.
    const joiners: Thread[] = [];
    for (const tid of distinct) {
      if (this.db.chatThreadInRoom(room, tid)) continue; // already grouped before (durable) — office already on for it
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
      // A newly-grouped member may have started solo (silent, no office note): backfill its general check-in.
      this.officeCheckIn(tid, roleByThread.get(tid) ?? "implementor");
      joiners.push(peer);
    }
    if (!joiners.length) return;
    // Wake every already-running implementor in the repo about the new joiner(s). The thread that just
    // went live (`threadId`) is skipped: its own fresh kickoff already carried the office note naming the
    // peers, and it isn't started yet at this point (ensureGroup runs before `agent.start`), so pushing
    // into it would be a pre-start send. Each remaining recipient is told only about the OTHER new joiners
    // (not itself). Deduped by room-entry above, so a given joiner triggers this exactly once.
    for (const inc of distinct) {
      if (inc === threadId) continue;
      if (!this.live.has(inc)) continue; // only a live implementor; a one-shot planner/QA is never interrupted
      const news = joiners.filter((j) => j.id !== inc);
      if (news.length) this.pushOfficeActivation(inc, news);
    }
  }

  /** Wake a running implementor now that teammate(s) have joined its repo: push the office-coordination
   *  instructions straight into its live session so it stops working blind. Only a live IMPLEMENTOR is
   *  pinged (this is called from `ensureGroup` guarded on `this.live`, the same targeting
   *  `deliverChatToPeers` uses) — a one-shot planner/QA's structured output is never disrupted; a short
   *  read-only phase reads the room itself and its next (implementor) phase gets the office note in its
   *  kickoff. CLI backends get the `OFFICE[team]:` text-bridge phrasing; Claude/z.ai get the MCP-tool one. */
  private pushOfficeActivation(tid: string, joiners: Thread[]): void {
    const live = this.live.get(tid);
    if (!live || !joiners.length) return;
    const cli = this.isCliOfficeBridge(live.accountId);
    const many = joiners.length > 1;
    const who = joiners.map((j) => `"${j.title}"`).join(", ");
    const workspace = joiners[0]?.workspace ?? "";
    const intro = `🤝 [Office — ${many ? "teammates" : "a teammate"} just joined this repo] ${who} ${many ? "are" : "is"} now working in ${workspace}, so you're no longer alone.`;
    const how = cli
      ? "Coordinate through the CLI office bridge from now on: write a standalone `OFFICE[team]: <short message>` line to claim the files/areas you'll touch, answer any teammate `OFFICE`/office message the same way, prefer non-overlapping areas, and re-check `git status`/`git diff` before committing so you only commit your own hunks. If a post needs multiple lines, indent each continuation by two spaces so it remains one lossless message."
      : "Office coordination is now ON: call `office_look` to see who's here and their names, `chat_read(scope:\"team\")` what they've posted, and `chat_post(scope:\"team\")` to claim the files/areas you're about to change before you edit — then re-check `git diff` before committing so you only commit your own hunks. Their team messages arrive straight in your session; answer with `chat_post(scope:\"team\")` and adjust.";
    this.sendCommunication(live.run, `${intro} ${how}`, { priority: "next" });
  }

  /** Post a task's check-in to the general office — but only once it's actually collaborating (2+ agents
   *  share its repo). A task working ALONE stays silent: it's already visible on the gnome strip, and
   *  announcing to an empty office is exactly the noise this feature removes. When a second task joins,
   *  `ensureGroup` backfills this check-in so the now-collaborating pair both show up. Deduped per
   *  (thread, role) so resume/failover relaunches don't repeat it. The name-uniqueness pass runs
   *  UNCONDITIONALLY (even for a solo task) so gnome names stay collision-free the moment a peer appears. */
  private officeCheckIn(threadId: string, role: Role): void {
    this.ensureLiveNamesUnique();
    const key = `${threadId}:${role}`;
    if (this.checkedIn.has(key)) return;
    const t = this.db.getThread(threadId);
    if (!t) return;
    // Solo in the repo → stay quiet, and DON'T mark checked-in, so the backfill from ensureGroup can
    // still post it the moment a teammate joins.
    if (!this.repoPeers(t).length) return;
    this.checkedIn.add(key);
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

  /** The office coordination note folded into a role's kickoff ONLY when another agent already shares
   *  this repo — the single reason a task hears about the office at all. A task alone in its repo gets
   *  `undefined` (no note, no wasted office tool round-trips); the moment a peer is present it's named and
   *  the agent is told to coordinate. `withTools` is false for CLI backends (Codex/Grok — no office MCP),
   *  which use the `OFFICE[team]:` text bridge instead. Editing roles (implementor) get the stronger
   *  "claim files / commit only your own hunks" framing; read-only roles just coordinate + share. */
  private officeNote(thread: Thread, role: Role, withTools: boolean): string | undefined {
    const peers = this.repoPeers(thread);
    if (!peers.length) return undefined;
    const list = peers
      .map((p) => `• ${p.role} on "${p.title}"${p.instance ? ` — on ${p.instance}, a DIFFERENT machine (same repo, different checkout)` : ""}`)
      .join("\n");
    const edits = role === "implementor";
    const how = !withTools
      ? "Coordinate through the CLI office bridge: include a standalone `OFFICE[team]: <short message>` line in your assistant response to claim the files/areas you'll touch, answer teammate messages the same way, prefer non-overlapping areas, and re-check `git status`/`git diff` before committing so you only commit your own hunks. If a post needs multiple lines, indent each continuation by two spaces so it remains one lossless message."
      : edits
        ? "Use the office chat to coordinate: call `office_look`, then `chat_post(scope:\"team\")` to claim the files/areas you'll touch and `chat_read` what they've claimed before editing. Commit only your own hunks."
        : "Coordinate via the office chat: `office_look` to see who's here (address people by name), `chat_read(scope:\"team\")` what they've said, and `chat_post(scope:\"team\")` what you're examining or find that affects them.";
    const localPeers = peers.filter((p) => !p.instance).length;
    const risk = !localPeers
      ? // Only remote peers: nothing of theirs is in this working tree, so the usual "commit your own
        // hunks" warning would point at the wrong hazard. The collision is at the remote.
        "None of them are in YOUR checkout — you meet at the git remote, so pull before you push and keep your commits narrow."
      : edits
        ? "You share this workspace, so you can step on each other's changes."
        : "You share this workspace.";
    return `⚠️ OFFICE — you're NOT alone in this repo. ${peers.length} other agent(s) are working in ${thread.workspace} right now:\n${list}\n${risk} ${how}`;
  }

  /** Append the office note to a kickoff when — and only when — a teammate already shares the repo.
   *  Returns `text` unchanged for a solo task, so the caller's kickoff carries zero office overhead
   *  until collaboration actually begins. */
  private withOfficeNote(thread: Thread, role: Role, text: string, withTools = true): string {
    const note = this.officeNote(thread, role, withTools);
    return note ? `${text}\n\n${note}` : text;
  }

  // ---- run event wiring ----

  private emitRun(runId: string): void {
    const run = this.db.getRun(runId);
    if (run) this.hub.publish({ type: "run.upsert", run });
  }

  private finishRun(
    runId: string,
    res: Extract<AgentEvent, { type: "result" }> | undefined,
    agent: AgentRunLike,
    stateOverride?: AgentRunState,
  ): void {
    // A hard-deadline teardown pre-finalizes the row with the operator-visible reason. A structured
    // role can finish unwinding afterward and otherwise overwrite it with a success-shaped/null result.
    const existing = this.db.getRun(runId);
    if (existing?.endedAt != null && existing.error === ACTIVE_DEADLINE_RUN_REASON) return;
    const state: AgentRunState = stateOverride ?? (res ? (res.isError ? "error" : "done") : "interrupted");
    this.db.updateRun(runId, {
      // A structured role that ends without a result was interrupted (cancellation, restart, or a
      // runner teardown), not successful. Besides keeping the run trail truthful, this must match
      // finalizeRun so such a row cannot be mistaken for proof that Codex recovered from a cap.
      state,
      // Persist the failure reason so a dead run is diagnosable instead of a silent error row.
      error: res?.isError ? runErrorText(res) : null,
      capFlagged: capFlaggedBy(agent),
      endedAt: Date.now(),
      costUsd: res?.costUsd ?? null,
      numTurns: res?.numTurns ?? null,
      tokenUsage: res?.tokenUsage ?? null,
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
      error: res?.isError ? runErrorText(res) : run.error ?? null,
      capFlagged: capFlaggedBy(agent),
      endedAt: Date.now(),
      costUsd: res?.costUsd ?? run.costUsd ?? null,
      numTurns: res?.numTurns ?? run.numTurns ?? null,
      tokenUsage: res?.tokenUsage ?? run.tokenUsage ?? null,
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
    // A finalized run (endedAt set) is immutable. finishRun/finalizeRun run OUTSIDE this listener — from
    // runRole's explicit finishRun and the implementor's onEnd — and can land while the SDK is still
    // flushing a buffered init/text/result as the session tears down. Without this guard, such a late
    // event flips the row back to a live state ("running") while endedAt stays set: a run the gnome strip
    // then draws forever and the boot reconciler (ended_at IS NULL) can never reconcile. Every state-
    // bearing write from an agent event goes through here so a dead run cannot be resurrected.
    const patchLiveRun = (patch: Parameters<Db["updateRun"]>[1]): void => {
      if (this.db.getRun(runId)?.endedAt != null) return;
      this.db.updateRun(runId, patch);
      this.emitRun(runId);
    };
    const markRunning = (sessionId?: string) => {
      if (leftStarting && !sessionId) return;
      leftStarting = true;
      patchLiveRun({
        state: "running",
        ...(sessionId ? { sessionId } : {}),
      });
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
          patchLiveRun({ costUsd: e.costUsd ?? null, numTurns: e.numTurns ?? null, state: e.isError ? "error" : "idle" });
          break;
        case "error":
          patchLiveRun({ state: "error", error: e.message.slice(0, MAX_RUN_ERROR_LEN) });
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
    // The path comes from the client, and getFileDiff's untracked-file branch diffs against the null
    // device — which would render a file OUTSIDE the repo as one big addition. Confine it to a
    // repo-relative path here rather than trusting the caller to only ask for files it listed.
    if (!t || !validRepoPath(path)) return { path, binary: false, patch: "", truncated: false };
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
  opts: { autoPush: boolean; qaEnabled: boolean; plannerRuns: boolean; route?: RouteDecision },
): string {
  const parts: string[] = [`# Task: ${thread.title}`, "", "## Brief", thread.brief, ""];

  if (opts.route) {
    parts.push(
      "## Selected Route",
      `For this task: ${opts.plannerRuns ? "planning" : "no planning"}, ${opts.qaEnabled ? "QA" : "no QA"}. ${opts.route.reason}`,
      "",
    );
  }

  if (plan) {
    parts.push("## Plan (from the planner)");
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
    parts.push(
      "## Planner Handoff",
      opts.plannerRuns
        ? "The planner did not return a structured handoff; proceed from the brief and your own repository inspection."
        : "No planner was selected for this task; proceed from the brief and your own repository inspection.",
    );
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

/** The RESUMED form for a reviewer the turn ceiling cut off mid-verification. It is not a re-check —
 * nothing else touched the repo while it was stopped — so the only thing it needs is to know it was not
 * finished. In QA-fixes mode it must also be told that its OWN pre-cutoff edits still count as changes:
 * a `changed: false` there would accept the reviewer's edits with no independent pass, which is exactly
 * what the fixes mode forbids. */
function qaContinueKickoff(unsurfacedArtifacts: string[] = [], applyFixes = false): string {
  const lines = [
    "You stopped at a per-session turn limit, not because your review was finished — nothing else has touched the repo since you stopped.",
    "Continue exactly where you left off: finish the checks you still had outstanding, then return your structured verdict (pass + issues).",
    "Work efficiently; you have a fresh turn budget but not an unlimited one, so prioritise the checks that decide the verdict.",
  ];
  if (applyFixes) {
    lines.push(
      "If you modified any task file at any point in this review — including before you were cut off — you must still report `changed: true`. Your own edits are the one thing that HAS changed, and they need an independent QA pass before the task can be accepted.",
    );
  }
  return [...lines, "", deliverablesCheckBlock(unsurfacedArtifacts)].join("\n");
}

/** The kickoff for one QA attempt. A RESUMED session already holds the brief, the plan and the diff it
 * read, so it gets only the reason it was woken; a fresh one gets the full review brief. */
function qaRoundKickoff(
  thread: Thread,
  o: { resume: boolean; opts: QaRoundOpts; plan?: PlanOutput; unsurfaced: string[] },
): string {
  if (!o.resume) {
    return o.opts.priorFixSummary
      ? qaFixFreshKickoff(thread, o.plan, o.opts.priorFixSummary, o.unsurfaced)
      : qaKickoff(thread, o.plan, o.unsurfaced);
  }
  if (o.opts.continuation) return qaContinueKickoff(o.unsurfaced, o.opts.applyFixes);
  return o.opts.priorFixSummary ? qaFixRecheckKickoff(o.opts.priorFixSummary, o.unsurfaced) : qaRecheckKickoff(o.unsurfaced);
}

/** Handoff between two editing-QA passes. Unlike qaRecheckKickoff, no implementor was relaunched:
 * the preceding reviewer changed the tree directly, so the next reviewer gets an honest description
 * of the boundary it must independently inspect. */
function qaFixHandoffBlock(previousSummary: string): string[] {
  return [
    "A previous QA reviewer just edited the working tree while fixing issues. Independently inspect the NEW state; do not trust its conclusion.",
    "Previous review summary (plus any issue it left unresolved — confirm each is genuinely resolved or still open):",
    previousSummary,
    "- Re-run `git diff` and the relevant build/typecheck/tests (and browser checks for UI work).",
    "- Verify the prior fixes, find and directly fix any remaining defects you can safely resolve, and check for regressions they introduced.",
    "- Return `changed: true` only if THIS QA run modified task files. The task is accepted only when a QA run passes with `changed: false`.",
  ];
}

/** The RESUMED form: the session already holds the brief, the plan and the prior diff, so it only
 * needs the handoff itself. */
function qaFixRecheckKickoff(previousSummary: string, unsurfacedArtifacts: string[] = []): string {
  return [...qaFixHandoffBlock(previousSummary), "", deliverablesCheckBlock(unsurfacedArtifacts)].join("\n");
}

/** The FRESH form. A verifier pass is a fresh session on almost every route — a different provider
 * cannot resume the editor's session, and a same-provider verifier is deliberately forced fresh — so
 * it holds none of the task context. Without the full brief/plan kickoff it would review the diff
 * blind and could not judge completeness against the brief at all. */
export function qaFixFreshKickoff(thread: Thread, plan: PlanOutput | undefined, previousSummary: string, unsurfacedArtifacts: string[] = []): string {
  return [qaKickoff(thread, plan, unsurfacedArtifacts), "", "## Prior QA fix handoff", ...qaFixHandoffBlock(previousSummary)].join("\n");
}

/** Editing QA runs are responsible for preserving their own fixes. This task-specific handoff is what
 * tells the shared QA system prompt whether the operator has disabled automatic pushes for this task. */
function qaFixCommitPolicy(autoPush: boolean): string {
  return autoPush
    ? "## QA fix commit policy\nIf you changed task files in this QA run, stage only your own hunks and make a focused Conventional Commit. Push it to the tracked remote before returning your verdict unless the repo's existing Vota no-push rule applies. Do not commit when you made no changes."
    : "## QA fix commit policy\nAuto-push is OFF for this task. If you changed task files in this QA run, stage only your own hunks and make a focused Conventional Commit, but do NOT push it. Do not commit when you made no changes.";
}

/** The mandatory deliverables-verification step folded into every QA kickoff. Deliverable emission is
 *  a discretionary tool call the implementor can forget, and QA is the gate that marks a task done —
 *  so QA is where the reliability backstop lives. When the harness detected artifact files the
 *  implementor wrote but never surfaced, they're listed as concrete candidates; either way QA must
 *  confirm every owner-facing artifact this task produced was surfaced, and fail (blocker) if not. */
function deliverablesCheckBlock(unsurfacedArtifacts: string[]): string {
  const lines = [
    "## Deliverables check (REQUIRED — do this every round)",
    "A deliverable is a file the owner should be able to open/download from the console; the implementor surfaces one with `post_deliverable`, or with its `DELIVERABLE: label | absolute path` bridge on a Codex/Grok CLI run. Either mechanism records the same deliverable finding and is easy to forget. Verify EVERY owner-facing artifact this task produced — a report, generated document, CSV/data export, diagram, rendered image/video, or generated asset (NOT ordinary source-code or config edits). Cross-check the actual git diff / new files against the deliverables already recorded (use `read_findings` — deliverables show as `[info]` findings whose summary is the file's label).",
    "If any produced artifact was NOT surfaced, that is a **blocker** issue: fail the review, name the exact file(s), and tell the implementor to use its available deliverable mechanism with an absolute path so the card resolves. Do not surface them yourself — bounce it back.",
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

function qaSupersedeMessagesFrom(stage: StageOutputs): string[] {
  const raw = stage.qaSuperseded?.messages;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim()) : [];
}

function attachmentIdsFromRefs(refs: AttachmentRef[] | undefined): string[] {
  return uniqueText((refs ?? []).map((ref) => ref.id));
}

function uniqueText(messages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const msg of messages.map((m) => m.trim()).filter(Boolean)) {
    if (seen.has(msg)) continue;
    seen.add(msg);
    out.push(msg);
  }
  return out;
}

function uniqueImageBlocks(blocks: ImageBlock[]): ImageBlock[] {
  const seen = new Set<string>();
  const out: ImageBlock[] = [];
  for (const block of blocks) {
    const key = `${block.source.media_type}:${block.source.data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

function qaSupersedeResumeNudge(messages: string[]): string {
  const body = [
    `QA was interrupted before reaching a verdict because ${config.ownerName} returned this task to implementation.`,
    messages.length
      ? `Apply these injected instruction(s) now:\n${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
      : "No extra instruction was supplied; continue implementation from the current workspace state and prior implementor context.",
    "Ignore any unfinished or stale QA verdict from the interrupted review. Complete the implementation before handing back.",
  ].join("\n\n");
  return acknowledgedInjection(body);
}

/** The auto-reviewer's kickoff: the brief it must judge the work against, the reason the task parked
 *  (the thing the owner would have opened it to look at), and the two rules that make the lane worth
 *  using — ask the owner rather than guess, and hand back rather than wave through. The full reviewer
 *  doctrine lives in REVIEWER_PROMPT; this is the per-task hand-off. */
function reviewerKickoff(thread: Thread, plan: PlanOutput | undefined, unsurfacedArtifacts: string[], fixRounds: number): string {
  const parts: string[] = [
    `# Review request for task: ${thread.title}`,
    "",
    `${config.ownerName} isn't reviewing this one by hand — you are making the accept-or-hand-back call in their place.`,
    "",
    "## The brief this task was given",
    thread.brief,
    "",
    "## Why it parked for review",
    thread.error?.trim() || "(no reason recorded — treat it as a plain hand-off and judge the work on its merits)",
  ];
  if (plan) {
    const files = [...new Set((plan.steps ?? []).flatMap((s) => s.files ?? []))];
    const hint: string[] = [];
    if (plan.summary) hint.push(`Planner's intent: ${plan.summary}`);
    if (files.length) hint.push(`Files the plan expected to touch: ${files.join(", ")}`);
    if (hint.length) parts.push("", "## Scope hint (verify against the ACTUAL git diff, not just this)", ...hint);
  }
  parts.push(
    "",
    "Now review it properly: read the real diff and the changed files, run this project's build/typecheck/tests yourself, browser-test any UI, and `read_findings` for what the planner/implementor/QA already reported (including anything they flagged as blocking). Do not edit, fix, or commit anything — you decide, you don't implement.",
    "",
    `Call \`ask_user\` for anything that genuinely needs ${config.ownerName} — a product decision, "is this what you meant", whether a known trade-off is acceptable. One bundled, short, preferably multiple-choice ask; that is the whole reason this review came to you instead of them. If no answer comes, hand the task back rather than accepting on a guess.`,
    "",
    // What a hand-back actually DOES depends on the operator's fix-round budget, and the difference
    // changes how the reviewer should weigh handing back against asking the owner — so it is stated per
    // run rather than baked into the cache-stable system prompt, which would be a lie at a budget of 0.
    fixRounds > 0
      ? `Then return your structured verdict. \`accept: true\` marks this task DONE — only if you would sign it off yourself. Otherwise \`accept: false\` with concrete, actionable \`issues\`, and **you are not the last stop**: the implementor is relaunched with that list, fixes it, and you re-check its work and decide again (up to ${fixRounds} ${fixRounds === 1 ? "round" : "rounds"}). So never reason "I can't fix this myself, therefore ${config.ownerName} has to" — if a competent implementor could resolve it, hand it back and say exactly what to do. An \`accept: false\` with no \`issues\` buys no fix round; it just lands on their desk.`
      : "Then return your structured verdict. `accept: true` marks this task DONE — only if you would sign it off yourself. Otherwise `accept: false` with concrete `issues`, and it goes back on their desk untouched — no fix round follows, so anything you don't name here is something they have to rediscover themselves.",
  );
  if (unsurfacedArtifacts.length) {
    parts.push(
      "",
      "## Possibly-unsurfaced deliverables",
      "The harness flagged these files as written by this task but never surfaced as deliverable findings (so the owner has no card to open them from). If any is a genuine owner-facing artifact — a report, export, diagram, generated asset — that's a reason to hand the task back naming it; if they're just source/support files, say so and move on:",
      ...unsurfacedArtifacts.map((p) => `- ${p}`),
    );
  }
  return parts.join("\n");
}

/** The RESUMED form for an auto-reviewer the turn ceiling cut off before it decided. Its session already
 * holds the brief, the park reason and everything it read, so all it needs is to know it wasn't finished. */
function reviewerContinueKickoff(): string {
  return [
    "You stopped at a per-session turn limit, not because your review was finished — nothing has touched the repo since you stopped.",
    "Continue exactly where you left off: finish the checks you still had outstanding, then return your structured verdict.",
    "Work efficiently; you have a fresh turn budget but not an unlimited one, so prioritise what decides accept-or-hand-back.",
    `Remember: \`accept: true\` marks the task DONE. If you can't finish verifying it, hand it back with what you did and didn't check rather than accepting on a guess.`,
  ].join("\n");
}

/**
 * What a live implementor is told when an agent on ANOTHER machine posts into its repo's room.
 *
 * The wording carries the one thing that makes a remote teammate different from a local one, and it is
 * the thing an agent would otherwise get wrong: they are not in this working tree, so `git status` will
 * never show their edits and claiming a file locally protects nothing. The collision happens at the
 * remote — they push what this agent is about to pull. `cli` picks the plain-ASCII, text-bridge phrasing
 * for the Codex/Grok backends, which have no office MCP tools.
 */
function remoteChatPush(msg: RelayChat, senderName: string, cli: boolean): string {
  const head = `[Online office - ${senderName} (${msg.role}), working ${msg.repoLabel ?? "this repo"} on another machine]: ${msg.body}`;
  const reply = cli
    ? 'reply with a standalone `OFFICE[team]: ...` line addressed to them'
    : 'reply with chat_post(scope:"team") — it reaches them';
  return (
    `${cli ? head : `🌐 ${head}`}\n` +
    `(A DIFFERENT machine working the same repository — not a teammate in your checkout, so their edits will never ` +
    `show in your \`git status\`. You meet at the remote: they push what you'll pull. If this touches your work, ${reply}, ` +
    `and prefer non-overlapping files.)`
  );
}

/** The same warning, for the moment a remote agent first appears in a repo an implementor is already
 *  working — the cross-machine counterpart of `pushOfficeActivation`. */
function remoteJoinPush(repoLabel: string, who: string, count: number, cli: boolean): string {
  const head = `[Online office - ${count > 1 ? "agents" : "an agent"} on another machine joined ${repoLabel}] ${who}.`;
  const say = cli ? "a standalone `OFFICE[team]: ...` line" : 'chat_post(scope:"team")';
  return (
    `${cli ? head : `🌐 ${head}`}\n` +
    `They work a different checkout of the SAME repository, so you meet at the remote, not in the working tree: pull before ` +
    `you push, keep your commits narrow, and say what you're taking with ${say} — it reaches them too.`
  );
}

/** What the implementor is relaunched with when the auto-reviewer hands a task back. Deliberately shaped
 * like the QA fix message — the same "here's the list, fix all of it, they re-check" contract the
 * implementor already knows — but names the reviewer as standing in for the owner, because that is what
 * makes an item like "your report isn't where the owner can open it" worth doing rather than arguing with. */
function reviewFixMessage(out: ReviewerOutput, reviewerName: string): string {
  return [
    `${reviewerName} (the auto-reviewer standing in for ${config.ownerName}'s own final review of this task) went through your finished work and held it back over the issues below.`,
    "",
    `Their verdict: ${out.summary}`,
    "",
    formatReviewIssues(out),
    "",
    "Fix ALL of these properly — no stubs, no half-measures — then commit per this repo's doctrine. If an item is genuinely wrong or impossible, say so explicitly in your final message with the reason; don't silently skip it. The same reviewer re-checks your work straight after and decides whether the task is done.",
  ].join("\n");
}

/** The RESUMED form for a reviewer re-checking after the implementor fixed what it asked for. Its session
 * still holds the brief, the diff it read and its own issue list, so all it needs is the fact that the tree
 * has changed underneath it — and a reminder that the verdict is still its call, not a rubber stamp. */
function reviewerRecheckKickoff(out: ReviewerOutput): string {
  return [
    `The implementor has been through the issues you raised and reports it addressed them. The working tree has CHANGED since you read it — re-read the files and re-run the checks that matter; nothing you saw before can be assumed to still hold.`,
    "",
    "The issues you handed it back for were:",
    formatReviewIssues(out),
    "",
    "Verify each one is genuinely resolved (and that the fixes broke nothing else), then return your structured verdict. `accept: true` marks the task DONE — only if you would sign it off yourself now. If something is still outstanding, hand it back with what remains; do not accept a partial fix to close the loop.",
  ].join("\n");
}

/** The reviewer's issue list, rendered for the finding's detail. Empty string when it raised none (an
 *  acceptance usually does), so the caller can drop the field entirely. */
function formatReviewIssues(out: ReviewerOutput): string {
  return (out.issues ?? []).map((i) => `- [${i.severity ?? "issue"}] ${i.description}${i.location ? ` (${i.location})` : ""}`).join("\n");
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
export function cliRoleKickoff(
  cfg: AgentRunConfig,
  content: string | unknown[],
  role: StructuredRole,
  provider: "Codex" | "Grok",
): string | unknown[] {
  const system =
    typeof cfg.systemPrompt === "string"
      ? cfg.systemPrompt
      : cfg.systemPrompt && typeof cfg.systemPrompt === "object"
        ? cfg.systemPrompt.append ?? ""
        : "";
  const schema = cfg.outputFormat?.schema;
  // The SDK enforces ordinary QA's read-only tool policy, but CLI fallbacks receive their role policy
  // as text. Do not append the generic read-only rule to QA-fixes: it comes *after* QA_FIX_PROMPT and
  // was causing Codex/Grok to obey the contradiction and leave defects for the implementor.
  const qaCanEdit =
    role === "qa" &&
    !cfg.disallowedTools?.includes("Write") &&
    !cfg.disallowedTools?.includes("Edit") &&
    !cfg.disallowedTools?.includes("NotebookEdit");
  const safety =
    role === "qa"
      ? qaCanEdit
        ? "You are an editing QA reviewer: inspect, fix every in-scope issue you find, verify the fixes, and follow the commit/push policy in your role instructions."
        : "You are a reviewer: inspect and run checks, but do not edit the implementation."
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
      : role === "reviewer"
        ? "The orchestrator-specific bus/office MCP tools are unavailable on this fallback. Complete the review directly; do not invent tool calls. If accepting depends on an owner decision you cannot ask for here, return accept:false with that decision as a concrete issue; never accept on a guess."
        : role === "reader" && provider === "Codex"
          ? "The post_finding MCP tool is unavailable on this fallback. Investigate read-only, put the COMPLETE owner-facing answer (including concrete file/commit references) in the final schema object's `answer` field, and set answered/escalated normally. The orchestrator will record that answer as the task finding. Do not invent tool calls."
        : "The orchestrator-specific bus/office MCP tools are unavailable on this fallback. Complete the core role directly; do not invent tool calls.";
  const cliOperatorNote = [
    "The CLI can still put one action for the owner on the shared Notes list: if you leave them a branch/PR to review, merge, or approve, emit one standalone line in the exact form `OPERATOR_NOTE: short action | https://...`.",
    `Keep the action text to ${NOTE_MAX_CHARS} characters, use a real http(s) link, and do not use this bridge for status updates or summaries.`,
    schema ? "Put that line immediately BEFORE your final schema JSON; the runner strips and posts it." : "Put it at the end of your reply; the runner strips and posts it.",
  ].join(" ");
  const cliDeliverable = [
    role === "qa"
      ? "A CLI deliverable bridge exists only for an owner-facing file THIS QA run itself produced; never use it to hide an implementor's missing deliverable."
      : "If this role itself produces an owner-facing file, the CLI can still add its real View/Download card.",
    "Emit one standalone line per file in the exact form `DELIVERABLE: Short label | C:/absolute/path/to/file.ext`; use an absolute path inside the task workspace and do not surface ordinary source/config edits.",
    schema ? "Put any deliverable line immediately BEFORE your final schema JSON; the runner strips and posts it." : "Put it at the end of your reply; the runner strips and posts it.",
  ].join(" ");
  const prelude = [
    `[Temporary provider fallback: run the ${role} role on ${provider}.]`,
    system,
    safety,
    noMcp,
    cliDeliverable,
    cliOperatorNote,
    schemaBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
  return prependUserContent(content, prelude);
}

/** Whether the runner itself saw a usage cap during this run — the flag the failover paths key on. The
 *  two backends' signals are deliberately different (`rateLimited` drives Claude-account failover, a CLI
 *  backend sets `capped` instead to avoid it), and either one means "a quota, not a crash". Narrowed by
 *  `instanceof` rather than a structural cast, so renaming `capped` fails the build instead of silently
 *  reporting every Grok/Codex cap as none — which is the exact blindness this flag exists to expose. */
export function capFlaggedBy(agent: AgentRunLike): boolean {
  const cliCapped = (agent instanceof CodexAgentRun || agent instanceof GrokAgentRun) && agent.capped;
  return agent.rateLimited || cliCapped;
}

/** Which backend produced a run, read back off its persisted account label ("codex:…" ⇒ Codex, "grok:…" ⇒
 *  Grok, "zai:…" ⇒ z.ai, a Claude sub's own label ⇒ Claude). */
function providerOfRunAccount(account: string | null | undefined): ImplementorProvider {
  if (account?.startsWith("codex:")) return "codex";
  if (account?.startsWith("grok:")) return "grok";
  if (account?.startsWith("zai:")) return "zai";
  return "claude";
}

/** Human label for an implementor backend, for the failover findings/notices. */
/** Full durable handoff used only when a CLI resume wedges and its runner self-heals to a fresh
 * session. Native resumes carry their own context; this fallback keeps every substantive text block
 * and relies on the working tree for the edits themselves. */
function coworkFreshKickoff(history: CoworkMessage[], prompt: string): string {
  const transcript = history
    .filter((message) => message.kind === "text" || message.kind === "system")
    .map((message) => `${message.role === "user" ? "OWNER" : message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  return [
    COWORKER_PROMPT,
    transcript ? `DURABLE PRIOR CONVERSATION:\n${transcript}` : undefined,
    `CURRENT OWNER REQUEST:\n${prompt}`,
  ].filter(Boolean).join("\n\n");
}

function providerLabel(p: ImplementorProvider): string {
  return p === "codex" ? "Codex" : p === "grok" ? "Grok" : p === "zai" ? "z.ai" : "Claude";
}

function providerCandidateFromClaude(c: AccountDispatchPreview): ProviderCandidate {
  return {
    provider: "claude",
    hasHeadroom: c.hasHeadroom,
    fiveHour: c.fiveHour,
    fiveHourReset: c.fiveHourReset,
    sevenDay: c.sevenDay,
    sevenDayReset: c.sevenDayReset,
    weeklySafetyPct: c.weeklySafetyPct,
    capacityLabel: `Claude ${c.account.label}`,
    capacityWindows: c.capacityWindows,
  };
}

function candidateCapacityWindows(candidate: ProviderCandidate): CapacityWindow[] {
  return candidate.capacityWindows ?? standardCapacityWindows(
    candidate.fiveHour,
    candidate.fiveHourReset,
    candidate.sevenDay,
    candidate.sevenDayReset,
  );
}

/** Add a live rejection as a real gating window. Dashboard meters can still show plenty of room after
 * a provider returns a session-specific cap; keeping the latch in the same window set makes selection,
 * explanations and reset simulation agree. */
function withCapLatch(
  windows: CapacityWindow[],
  label: string,
  active: boolean,
  resetAt: number | null | undefined,
): CapacityWindow[] {
  return active ? [...windows, { label, usedPct: 100, resetAt: resetAt ?? null }] : windows;
}

function withStartupHealthCooldown(windows: CapacityWindow[], resetAt: number | undefined): CapacityWindow[] {
  return resetAt == null
    ? windows
    : [...windows, { label: STARTUP_HEALTH_COOLDOWN_LABEL, usedPct: 100, resetAt }];
}

function describeProviderCapacity(candidate: ProviderCandidate, demand: CapacityDemand, now = Date.now()): string {
  return describeRoutingCapacity(
    {
      label: candidate.capacityLabel ?? providerLabel(candidate.provider),
      windows: candidateCapacityWindows(candidate),
    },
    demand,
    now,
  );
}

function modelCapacityNote(
  provider: ImplementorProvider,
  model: string,
  candidate: ProviderCandidate,
  demand: CapacityDemand,
): string {
  const ordinary = describeProviderCapacity(candidate, demand);
  if (provider !== "claude" || !fallbackModelFor(model)) return ordinary;
  return `${model} uses a separately gated model allowance whose remaining percentage is not exposed; a live cap falls back in-session. Normal-account fallback: ${ordinary}`;
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

function formatTokenCount(n: number | null | undefined): string {
  if (n == null) return "unknown";
  return new Intl.NumberFormat("en", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
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
