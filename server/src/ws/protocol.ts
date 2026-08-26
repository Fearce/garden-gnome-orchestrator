import { z } from "zod";
import { CODEX_EFFORTS } from "../types.js";
import type { CodexUsageDTO } from "../agents/codexUsage.js";
import type { GrokUsageDTO } from "../agents/grokUsage.js";
import type { ZaiUsageDTO } from "../agents/zaiUsage.js";
import type { GitFileDiff, GitStatus, GitSummary } from "../gitService.js";
import type { RepoCommitDetail } from "../git/repoOps.js";
import type { RepoActionDTO, RepoRef, RepoStateDTO } from "../orchestrator/repoConsole.js";
import type { OnlineOfficeDTO } from "../office/onlineOffice.js";
import type {
  AgentRun,
  ChatMessage,
  ChatRoomSummary,
  DirectorMessage,
  Finding,
  Message,
  ModelStat,
  OperatorNote,
  OrchestratorSettings,
  Question,
  Role,
  ScheduledTask,
  TaskSearchHit,
  Thread,
} from "../types.js";

// ---- Server -> Client events (outbound; not validated) ----

export interface AccountDTO {
  id: string;
  label: string;
  fiveHour: number | null; // utilization 0-100
  sevenDay: number | null; // utilization 0-100
  fiveHourReset?: number | null; // epoch ms the 5h window rolls over
  sevenDayReset?: number | null; // epoch ms the weekly window rolls over
  stale?: boolean; // usage is from a snapshot/old cache, not a live read
  rateLimited: boolean;
  resetsAt?: number | null;
  active: boolean; // last/preferred account for dispatch
  enabled: boolean; // operator toggle — a disabled account is held out of dispatch/failover
  weeklySafetyPct: number; // 1-100 soft weekly-utilization ceiling; at/above it new tasks route to another sub (100 = off)
  holdUntil?: number | null; // 5h window idle (stagger hold-off) — the next window starts at this epoch ms
  // Model-scoped pool caps (Fable's separately-gated allowance): dispatch resolves `fallback` in place
  // of `model` on this sub until `resetsAt`. The account's normal windows are unaffected.
  modelLimits?: { model: string; fallback: string; resetsAt: number }[];
  updatedAt: number;
  error?: string | null;
}

export type { CodexUsageDTO } from "../agents/codexUsage.js";
export type { GrokUsageDTO } from "../agents/grokUsage.js";
export type { ZaiUsageDTO } from "../agents/zaiUsage.js";

export type ServerEvent =
  | {
      type: "hello";
      threads: Thread[];
      runs: AgentRun[];
      findings: Finding[];
      questions: Question[];
      director: DirectorMessage[];
      accounts: AccountDTO[];
      codexUsage: CodexUsageDTO | null;
      grokUsage: GrokUsageDTO | null;
      zaiUsage: ZaiUsageDTO | null;
      approvalMode: boolean;
      settings: OrchestratorSettings;
      chat: ChatMessage[];
      chatRooms: ChatRoomSummary[];
      nameOverrides: Record<string, string>;
      schedules: ScheduledTask[];
      modelStats: ModelStat[];
      notes: OperatorNote[];
      onlineOffice: OnlineOfficeDTO;
    }
  | { type: "accounts"; accounts: AccountDTO[] }
  // Auto model selection's scoreboard — per-model averages over every graded auto-picked task.
  // Rebroadcast whenever a task is graded (it's small: one row per model ever picked).
  | { type: "model.stats"; stats: ModelStat[] }
  // The full scheduled-task list, rebroadcast on every create/update/delete/fire (it's small and bounded).
  | { type: "schedules"; schedules: ScheduledTask[] }
  // The owner's note list, rebroadcast whole on every post/delete (hard-capped, so it stays small).
  | { type: "notes"; notes: OperatorNote[] }
  | { type: "codex.usage"; usage: CodexUsageDTO | null }
  | { type: "grok.usage"; usage: GrokUsageDTO | null }
  | { type: "zai.usage"; usage: ZaiUsageDTO | null }
  | { type: "chat.message"; message: ChatMessage }
  // One page of a room's history (newest, or — when the request carried a `before` cursor — the page just
  // older than it). The client merges by id, so both cases fold in the same way; `hasMore` says whether
  // still-older messages remain to fetch as the user keeps scrolling up.
  | { type: "chat.history"; room: string; messages: ChatMessage[]; hasMore: boolean }
  | { type: "chat.name"; threadId: string; role: Role; name: string }
  // The Online Office's whole state (connection, this instance's identity, the remote roster),
  // rebroadcast on every change. Small and bounded — it never carries the device token.
  | { type: "office.online"; office: OnlineOfficeDTO }
  // The reply to one `office.join` attempt, sent to the socket that asked. The office's own broadcast
  // can't stand in for it: a second attempt with the same wrong code produces an identical DTO, so the
  // panel would have no way to tell "still trying" from "refused again" and its button would stick.
  | { type: "office.join.result"; ok: boolean; error: string | null }
  | { type: "plan.ready"; threadId: string; brief: string }
  | { type: "approval.mode"; on: boolean }
  | { type: "settings"; settings: OrchestratorSettings }
  | { type: "codex.test.result"; ok: boolean; message: string }
  | { type: "discord.test.result"; ok: boolean; message: string }
  | { type: "thread.changes"; threadId: string; diff: string; log: string }
  | { type: "thread.git"; threadId: string; status: GitStatus }
  | { type: "thread.gitSummary"; threadId: string; summary: GitSummary }
  | { type: "thread.gitDiff"; threadId: string; path: string; diff: GitFileDiff }
  // ---- the repo-level Git console (the in-app GitHub Desktop) ----
  // `preferred` is the repo of the task the console was opened from (`forThread`), already resolved
  // from its workspace — null when there was no task or it isn't in a checkout. `forThread` is echoed
  // back so the client can discard a slow earlier reply: the first list costs a disk scan, so an answer
  // to a previous open can easily arrive after the current one's request (see director.results).
  | { type: "repo.list"; repos: RepoRef[]; preferred: string | null; forThread: string | null }
  | { type: "repo.state"; path: string; state: RepoStateDTO }
  // `commit` echoes back which side the diff came from (a working-tree file vs. a file inside a commit),
  // so the console can key its cache without guessing which request a reply answers.
  | { type: "repo.diff"; path: string; file: string; commit: string | null; diff: GitFileDiff }
  | { type: "repo.commit"; path: string; detail: RepoCommitDetail }
  | { type: "repo.result"; path: string; action: string; result: RepoActionDTO }
  | { type: "thread.upsert"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  // A cancelled task was restarted from scratch: its prior runs/findings/feed were deleted server-side,
  // so the client prunes that stale slice (keeping the thread row) before the fresh pipeline streams in.
  | { type: "thread.reset"; threadId: string }
  | { type: "thread.message"; threadId: string; message: Message }
  | { type: "thread.history"; threadId: string; messages: Message[]; findings: Finding[]; brief: string }
  | { type: "run.upsert"; run: AgentRun }
  | { type: "agent.delta"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.text"; threadId: string; runId: string; role: Role; text: string; messageId: string }
  | { type: "agent.thinking"; threadId: string; runId: string; role: Role; text: string }
  // A completed reasoning segment persisted as a durable message (kind "thinking"). Mirrors the
  // delta→text pair: `agent.thinking` is the live stream, `agent.reasoning` is the committed block.
  | { type: "agent.reasoning"; threadId: string; runId: string; role: Role; text: string; messageId: string }
  | { type: "agent.tool"; threadId: string; runId: string; role: Role; name: string; input: unknown; id: string; messageId: string }
  | { type: "agent.tool_result"; threadId: string; runId: string; id: string; isError: boolean; preview: string; messageId: string }
  | { type: "finding"; finding: Finding }
  | { type: "question.ask"; question: Question }
  | { type: "question.resolved"; questionId: string; answer: string }
  | { type: "director.delta"; text: string }
  | { type: "director.message"; message: DirectorMessage }
  | { type: "director.tool"; name: string; input: unknown }
  | { type: "director.busy"; busy: boolean }
  // Reply to a director.search: everything matching `query`, newest-first — the director-conversation
  // hits in `messages`, and in `tasks` the tasks whose title, brief or conversation matches. Echoing
  // the query lets the client ignore a stale reply if the operator has since retyped.
  | { type: "director.results"; query: string; messages: DirectorMessage[]; tasks: TaskSearchHit[] }
  // A dedicated user-facing notification channel (unlike `log`, which the client drops). Used by the
  // token-safety auto-stop (warn) and the token-reset auto-resume (info); the client shows it as a
  // dismissible banner and fires a desktop notify.
  | { type: "notice"; level: "info" | "warn"; title: string; message: string }
  // Voice mode: a task-tailored spoken line for a just-completed task. Only published while voice
  // mode is on (gateway up AND wake/mic enabled); the gateway speaks it, the web console ignores it.
  | { type: "voice.announce"; threadId: string; text: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

// ---- Client -> Server commands (inbound; zod-validated) ----

const imageAttachmentSchema = z.object({
  name: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  dataBase64: z.string(),
});
const imagesField = z.array(imageAttachmentSchema).max(8).optional();

export const clientCommandSchema = z.discriminatedUnion("type", [
  // source:"voice" marks a spoken prompt (voice-gateway): the director gets a TTS-aware note
  // appended so it answers conversationally and confirms aloud before dispatching.
  z.object({ type: z.literal("prompt.new"), text: z.string().min(1), workspace: z.string().optional(), images: imagesField, source: z.literal("voice").optional() }),
  // Skip-director mode: bypass the Sonnet director and dispatch the message straight into the pipeline
  // (its first active stage — planner if enabled, else the implementor). workspace is required since
  // there's no director to resolve one.
  z.object({ type: z.literal("prompt.direct"), text: z.string().min(1), workspace: z.string().optional(), images: imagesField }),
  z.object({ type: z.literal("question.answer"), questionId: z.string(), answer: z.string() }),
  z.object({
    type: z.literal("thread.inject"),
    threadId: z.string(),
    message: z.string().min(1),
    mode: z.enum(["append", "interrupt", "queue"]).default("append"),
    images: imagesField,
  }),
  z.object({ type: z.literal("thread.interrupt"), threadId: z.string() }),
  z.object({ type: z.literal("thread.resume"), threadId: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal("thread.cancel"), threadId: z.string() }),
  // Restart a cancelled task from the very beginning — wipes the prior attempt and re-runs the whole
  // pipeline from the brief the director first dispatched (see ThreadManager.retryThread).
  z.object({ type: z.literal("thread.retry"), threadId: z.string() }),
  // Rename a task's board title. Trimmed + length-capped here so the operator-supplied string can't
  // bloat the lane; the server rejects an empty result and leaves the title unchanged.
  z.object({ type: z.literal("thread.rename"), threadId: z.string(), title: z.string().min(1).max(200) }),
  z.object({ type: z.literal("thread.markDone"), threadId: z.string() }),
  // Delegate the owner's own review of a parked task to one reviewer agent, which either accepts it as
  // done or hands it back with reasons (see ThreadManager.autoReview).
  z.object({ type: z.literal("thread.autoReview"), threadId: z.string() }),
  z.object({ type: z.literal("thread.close"), threadId: z.string() }),
  z.object({ type: z.literal("thread.restore"), threadId: z.string() }),
  z.object({ type: z.literal("thread.dismiss"), threadId: z.string() }),
  z.object({ type: z.literal("thread.history"), threadId: z.string() }),
  z.object({ type: z.literal("thread.approve"), threadId: z.string(), approved: z.boolean(), feedback: z.string().optional() }),
  z.object({ type: z.literal("approval.set"), on: z.boolean() }),
  z.object({
    type: z.literal("settings.set"),
    settings: z
      .object({
        plannerEnabled: z.boolean(),
        researcherEnabled: z.boolean(),
        qaEnabled: z.boolean(),
        differentProviderQa: z.boolean(),
        qaAppliesFixes: z.boolean(),
        autoPush: z.boolean(),
        directorName: z.string().max(40),
        maxQaRounds: z.number().int().min(1).max(12),
        maxReviewFixRounds: z.number().int().min(0).max(3),
        maxConcurrent: z.number().int().min(1).max(20),
        maxConcurrentPerRepo: z.number().int().min(0).max(20),
        selfImproveEnabled: z.boolean(),
        autoModelSelection: z.boolean(),
        tokenLimitEnabled: z.boolean(),
        tokenLimitPercent: z.number().int().min(50).max(99),
        autoResumeOnTokenReset: z.boolean(),
        autoResumeThresholdPercent: z.number().int().min(50).max(95),
        fastUsagePolling: z.boolean(),
        spreadUsage: z.boolean(),
        codexEnabled: z.boolean(),
        codexModel: z.string().min(1).max(64),
        // Use the domain constant so a new supported tier cannot be accepted by the runner but
        // accidentally rejected at this WebSocket boundary.
        codexEffort: z.enum(CODEX_EFFORTS),
        codexWeeklySafetyPct: z.number().int().min(1).max(100),
        grokEnabled: z.boolean(),
        grokModel: z.string().min(1).max(64),
        grokEffort: z.enum(["low", "medium", "high"]),
        grokWeeklySafetyPct: z.number().int().min(1).max(100),
        // Zhipu z.ai (GLM Coding Plan) backend.
        zaiEnabled: z.boolean(),
        zaiModel: z.string().min(1).max(64),
        zaiEffort: z.enum(["low", "medium", "high"]),
        zaiWeeklySafetyPct: z.number().int().min(1).max(100),
        // Write-only: the raw z.ai API key is accepted here and stored server-side, never echoed back.
        // An empty string clears it (falls back to ZAI_API_KEY). The broadcast carries only zaiKeyPresent/last4.
        zaiApiKey: z.string().max(300),
        // Write-only: the raw OpenAI key is accepted here and stored server-side, never echoed back.
        // An empty string clears it. The broadcast OrchestratorSettings carries only hasOpenaiKey/last4.
        openaiApiKey: z.string().max(300),
        // Phone notifications — a Discord message when a task finishes, needs you, or fails.
        discordNotify: z.boolean(),
        // Bounded for a pasted channel LINK, not just a bare id — the server lifts the id out of it.
        discordChannelId: z.string().max(200),
        // Write-only: the raw Discord bot token is accepted here and stored server-side, never echoed
        // back. An empty string clears it (falls back to DISCORD_BOT_TOKEN). The broadcast carries only
        // discordTokenPresent/last4.
        discordBotToken: z.string().max(200),
        // Composer state, persisted server-side so it survives across the HTTP/HTTPS surfaces.
        skipDirector: z.boolean(),
        showComposerPickers: z.boolean(),
        showAgentModel: z.boolean(),
        skipDirectorEffort: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]),
        skipDirectorRetitle: z.boolean(),
        maxRecentRepos: z.number().int().min(1).max(20),
        recentRepos: z.array(z.string().max(600)).max(50),
        // Per-(subscription × role) model picks: {subId → {role → modelId}}. Role keys are the five valid
        // roles, but the pick is PARTIAL (usually one role) — so the inner record must be z.partialRecord:
        // Zod v4's enum-keyed z.record is EXHAUSTIVE (demands all five keys), which would reject every
        // realistic single-role pick and silently drop the whole settings.set. partialRecord still rejects
        // unknown role keys at the boundary. The subscription-count cap mirrors the server-side sanitize
        // bound so a client can't bloat the single persisted kv blob; the server trims + length-caps too.
        modelOverrides: z
          .record(z.string().max(64), z.partialRecord(z.enum(["director", "planner", "researcher", "implementor", "qa"]), z.string().max(100)))
          .refine((m) => Object.keys(m).length <= 64, { message: "too many subscription entries" }),
        // Per-Claude-account MAX effort cap: {accountId → effort}. Same 64-entry bound as the model map;
        // the server sanitizes (drops unknown tiers + `max`, which means uncapped) before persisting.
        accountEffortCaps: z
          .record(z.string().max(64), z.enum(["low", "medium", "high", "xhigh", "max"]))
          .refine((m) => Object.keys(m).length <= 64, { message: "too many effort-cap entries" }),
      })
      .partial(),
  }),
  // Validate the stored (or just-typed) OpenAI key against the API; replies with codex.test.result.
  z.object({ type: z.literal("codex.test"), apiKey: z.string().max(300).optional() }),
  // Post a test message to the configured Discord channel; replies with discord.test.result.
  z.object({ type: z.literal("discord.test") }),
  // Toggle a Claude account in/out of the dispatch+failover rotation (per-account subscription switch).
  z.object({ type: z.literal("account.set"), id: z.string(), enabled: z.boolean() }),
  // Set a Claude account's soft weekly-safety ceiling (1-100; 100 = off): above it, new tasks route to another sub.
  z.object({ type: z.literal("account.setSafety"), id: z.string(), weeklySafetyPct: z.number().int().min(1).max(100) }),
  z.object({ type: z.literal("thread.changes"), threadId: z.string() }),
  z.object({ type: z.literal("thread.git"), threadId: z.string() }),
  z.object({ type: z.literal("thread.gitSummary"), threadId: z.string() }),
  z.object({ type: z.literal("thread.gitDiff"), threadId: z.string(), path: z.string().min(1).max(4096) }),
  // ---- the repo-level Git console ----
  // `path` is an operator-chosen repository (a picker entry or a browsed folder); the server resolves it
  // to a real repo root and rejects anything that isn't one. Branch names and file paths are re-validated
  // in git/repoOps.ts — this schema bounds them, it does not sanitize them.
  // `rescan` forces a fresh disk walk for repositories instead of reusing the memoized one.
  // `forThread` is the task open in the console, whose repo the reply names as `preferred` so the
  // picker can open on it.
  z.object({ type: z.literal("repo.list"), rescan: z.boolean().default(false), forThread: z.string().max(100).optional() }),
  z.object({ type: z.literal("repo.state"), path: z.string().min(1).max(600) }),
  z.object({
    type: z.literal("repo.diff"),
    path: z.string().min(1).max(600),
    file: z.string().min(1).max(4096),
    // Present = the file's diff INSIDE that commit (History tab); absent = its working-tree diff vs HEAD.
    commit: z.string().min(1).max(100).optional(),
  }),
  z.object({ type: z.literal("repo.commit"), path: z.string().min(1).max(600), hash: z.string().min(1).max(100) }),
  z.object({
    type: z.literal("repo.action"),
    path: z.string().min(1).max(600),
    // Re-run a tree-mutating action the live-agent gate refused. Only ever set by an explicit
    // "do it anyway" confirmation in the console.
    force: z.boolean().default(false),
    op: z.discriminatedUnion("action", [
      z.object({ action: z.literal("fetch"), prune: z.boolean().default(false) }),
      z.object({ action: z.literal("pull"), rebase: z.boolean().default(false) }),
      z.object({ action: z.literal("push"), setUpstream: z.boolean().default(false) }),
      z.object({
        action: z.literal("checkout"),
        branch: z.string().min(1).max(255),
        create: z.boolean().default(false),
        from: z.string().max(255).optional(),
      }),
      z.object({ action: z.literal("deleteBranch"), branch: z.string().min(1).max(255), force: z.boolean().default(false) }),
      z.object({
        action: z.literal("commit"),
        summary: z.string().min(1).max(500),
        description: z.string().max(10000).default(""),
        paths: z.array(z.string().min(1).max(4096)).min(1).max(2000),
      }),
      z.object({ action: z.literal("discard"), paths: z.array(z.string().min(1).max(4096)).min(1).max(2000) }),
    ]),
  }),
  // Stop the director's current turn when it's spinning (busy but neither replying nor dispatching).
  // Kills the live run, discards the in-flight turn, and settles the director back to idle; the
  // conversation session is preserved so the next message resumes with full context.
  z.object({ type: z.literal("director.cancel") }),
  // Search everything the console holds for a substring — the whole director conversation AND every
  // task's title, brief and conversation; replies with director.results. All of it needs a server
  // query: the snapshot ships only the recent director slice and no task conversations at all.
  z.object({ type: z.literal("director.search"), query: z.string().min(1).max(200) }),
  // Fetch one page of an office room's history (the expanded chatroom view / a task's button). Without
  // `before` it's the newest page; with a `before` cursor it's the page just older than it — the client
  // sends its oldest-loaded message as the cursor to lazily load more as the user scrolls up.
  z.object({
    type: z.literal("chat.history"),
    room: z.string().min(1).max(300),
    before: z.object({ createdAt: z.number(), id: z.string().min(1).max(100) }).optional(),
  }),
  // Post into a room AS THE DIRECTOR (the human): lands in the chat and is pushed to the live agents
  // in that room so they self-coordinate who acts on it. room "general" = the whole office.
  z.object({ type: z.literal("chat.post"), room: z.string().min(1).max(300), body: z.string().min(1).max(2000) }),
  // ---- Scheduled tasks (recurring dispatches) — create/edit/delete/run without the director ----
  z.object({
    type: z.literal("schedule.create"),
    title: z.string().min(1).max(200),
    workspace: z.string().min(1).max(600),
    prompt: z.string().min(1).max(20000),
    cron: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    // Matches the effort options offered by the UI + director tools (xhigh is a gated tier not surfaced
    // for schedules) so a schedule's effort is always re-selectable in the editor.
    effort: z.enum(["low", "medium", "high", "max"]).nullish(),
  }),
  z.object({
    type: z.literal("schedule.update"),
    id: z.string(),
    // A partial patch — only the supplied fields change. `effort: null` clears the override.
    patch: z.object({
      title: z.string().min(1).max(200).optional(),
      workspace: z.string().min(1).max(600).optional(),
      prompt: z.string().min(1).max(20000).optional(),
      cron: z.string().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).nullish(),
    }),
  }),
  z.object({ type: z.literal("schedule.delete"), id: z.string() }),
  z.object({ type: z.literal("schedule.run"), id: z.string() }),
  // ---- The owner's note list — agents post via the bus tool; these are the owner's own edits ----
  // `body` is bounded generously here and CLIPPED to NOTE_MAX_CHARS by the service, so a paste that
  // overshoots the composer's own limit is still recorded rather than silently dropped at this boundary.
  // ---- The Online Office (cross-machine coordination) ----
  // `code` is the one-time join code; it is exchanged for a device token server-side and never stored
  // or echoed back. An empty `url` reuses the one already saved (the Reconnect case).
  z.object({
    type: z.literal("office.join"),
    url: z.string().max(300),
    code: z.string().min(1).max(200),
    instanceName: z.string().max(40),
  }),
  z.object({ type: z.literal("office.leave") }),
  // Go quiet without giving up the device token, and rename this machine as others see it.
  z.object({ type: z.literal("office.set"), enabled: z.boolean().optional(), instanceName: z.string().max(40).optional() }),
  z.object({ type: z.literal("note.create"), body: z.string().min(1).max(2000), url: z.string().max(600).optional() }),
  z.object({ type: z.literal("note.delete"), id: z.string() }),
  z.object({ type: z.literal("note.clear") }),
  z.object({ type: z.literal("snapshot.request") }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
