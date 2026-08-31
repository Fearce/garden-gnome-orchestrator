import type { AgentRunLike, ResultEvent, UserContent } from "../agents/runner.js";
import { directorConfig } from "../agents/roles.js";
import { createDirectorServer } from "../bus/directorServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { contentWithImages, toImageBlock } from "../attachments.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { AgentEvent, DirectorMessage, DirectorStatus, ImageAttachment } from "../types.js";
import type { DirectorTarget, ThreadManager } from "./threadManager.js";
import type { OperatorNotes } from "./notes.js";
import type { Scheduler } from "./scheduler.js";
import type { Account } from "../accounts/account.js";
import { config, fallbackModelFor } from "../config.js";
import { normalizeDuration } from "./timedTasks.js";
import { clampAgentCount } from "./shotgun.js";
import { existsSync } from "node:fs";
import { DIRECTOR_CLI_PROTOCOL, DIRECTOR_CLI_SCHEMA, executeDirectorCliAction, type DirectorCliAction } from "./directorCliBridge.js";
import { withCommunicationTurnPolicy } from "../agents/communicationPolicy.js";

const MAX_DIRECTOR_FAILOVERS = 6;
const MAX_CLI_ACTIONS = 20;
const DIRECTOR_TARGET_KV = "director_target_key";
const DIRECTOR_TARGET_AUTO_KV = "director_target_auto";

/**
 * The single long-lived director the owner chats with. Claude/z.ai use native MCP tools; Codex/Grok
 * use a constrained server-command bridge. The selected target is sticky until it caps.
 */
export class Director {
  private run: AgentRunLike | undefined;
  private target: DirectorTarget | undefined;
  private readonly sessions = new Map<string, string>();
  private activeSessionKey: string | undefined;
  private targetWasAuto = false;
  private busy = false;
  /** Images from the current user turn — carried past the text-only dispatch tool to the pipeline. */
  private pendingImages: ImageAttachment[] = [];
  /** The in-flight turn's content — kept so a usage-cap failover can re-send it. */
  private pending: UserContent | undefined;
  private failovers = 0;
  /** A cap classification (usage ping) is in flight — blocks a duplicate classify/double-start when
   *  both the result handler and onEnd report the same capped run. */
  private classifying = false;
  /** Director-message ids added during the current user turn (the prompt + the director's replies).
   *  When a dispatch fires mid-turn, these get linked to the new task so a search hit can jump to it. */
  private currentTurnMsgIds: string[] = [];
  /** The task dispatched so far in the current turn, if any. Director replies written AFTER a dispatch
   *  (e.g. the "dispatched X" confirmation) belong to that task, so they're linked to it as they stream —
   *  a plain timeline heuristic would otherwise misfile a post-dispatch note under the NEXT task. */
  private turnDispatchId: string | undefined;
  private cliActions = 0;
  private cliCorrections = 0;
  /** A CLI command may already have changed orchestrator state before its confirmation turn fails.
   *  Preserve the successful result so a malformed/crashed follow-up can never tell the owner the
   *  whole turn failed (and invite a duplicate dispatch). */
  private cliCommittedResult: string | undefined;
  private startGeneration = 0;
  /** CLI processes end immediately after emitting their structured result. Bridge execution can await
   *  server work, so onEnd must not settle the turn while handleCliResult still owns that result. */
  private readonly cliHandling = new WeakSet<AgentRunLike>();

  constructor(
    private readonly api: ThreadManager,
    private readonly db: Db,
    private readonly hub: EventHub,
    private readonly scheduler: Scheduler,
    private readonly notes: OperatorNotes,
  ) {
    const key = db.kvGet(DIRECTOR_TARGET_KV);
    this.targetWasAuto = db.kvGet(DIRECTOR_TARGET_AUTO_KV) === "1";
    if (key) {
      const saved = api.directorTargets(this.targetWasAuto).find((t) => t.key === key);
      if (saved && api.directorTargetReady(saved)) this.target = saved;
    }
  }

  status(): DirectorStatus | null {
    return this.target
      ? { provider: this.target.provider, model: this.target.model, accountLabel: this.target.accountLabel }
      : null;
  }

  handleUserMessage(text: string, workspace?: string, images?: ImageAttachment[], source?: "voice", messageId?: string): void {
    const refs = (images ?? []).map((img) =>
      this.db.addAttachment({ name: img.name, mediaType: img.mediaType, data: img.dataBase64 }),
    );
    const msg = this.db.addDirectorMessage({ id: messageId, role: "user", kind: "text", content: text, attachments: refs });
    this.hub.publish({ type: "director.message", message: msg });
    // A new user turn opens a fresh segment; a dispatch during it links back to this prompt (+ the
    // director's replies, appended as they stream) so the task is reachable from a search hit.
    this.currentTurnMsgIds = [msg.id];
    this.turnDispatchId = undefined;

    this.pendingImages = images ?? [];
    // A path the owner typed in the path field is AUTHORITATIVE — it's the exact dispatch workspace, not
    // a hint to re-resolve. Tell the director to use it verbatim and skip find_workspace entirely.
    const base = workspace
      ? `${text}\n\n[TARGET WORKSPACE — ${config.ownerName} set this explicitly. Use this EXACT absolute path as the dispatch workspace; do NOT call find_workspace and do NOT substitute another path: ${workspace}]`
      : text;
    const content = contentWithImages(source === "voice" ? `${base}\n\n${voiceNote()}` : base, this.pendingImages.map(toImageBlock));
    this.pending = content;
    this.failovers = 0;
    this.cliActions = 0;
    this.cliCorrections = 0;
    this.cliCommittedResult = undefined;

    // A batch CLI marks itself finished immediately before emitting its end callback. A new owner
    // message can land in that tiny window: it must take ownership away from the finished run BEFORE
    // start() awaits target selection, otherwise the stale end callback still sees itself as current
    // and settleTurn() clears the brand-new pending prompt. The durable user bubble then has no reply
    // or dispatch — the director appears to have ignored it.
    const previousRun = this.run;
    const live = previousRun && !previousRun.finished;
    const auto = this.api.settings().autoModelSelection;
    const mustReselect = !this.target || !this.api.directorTargetReady(this.target) || auto !== this.targetWasAuto;
    if (live && mustReselect) {
      const old = this.run!;
      this.run = undefined; // neutralize the old onEnd before stop() emits it
      this.hub.log("info", "Director target changed or lost headroom — selecting another enabled provider/model.");
      void old.stop();
      void this.start(content);
    } else if (live) {
      this.run!.send(withCommunicationTurnPolicy(content, this.api.settings().conciseAgentCommunication));
    } else {
      // Neutralize a finished run's not-yet-delivered onEnd callback before starting the next turn.
      // The callback's `this.run !== run` ownership guard will now leave the new pending prompt alone.
      if (this.run === previousRun) this.run = undefined;
      void this.start(content);
    }
    this.setBusy(true);
  }

  /**
   * Skip-director mode: dispatch the owner's message straight into the pipeline without the
   * provider-neutral director enriching/clarifying. The message becomes the brief verbatim and enters the pipeline at
   * its first active stage (planner if enabled, else the implementor — runPipeline routes by settings,
   * so this is never hardcoded to one agent). A workspace is required: there's no director to resolve
   * one. The user message + a confirmation are echoed into the director chat so the transcript shows
   * what was sent; the long-lived director session is left completely untouched.
   */
  async dispatchDirect(text: string, workspace?: string, images?: ImageAttachment[], messageId?: string): Promise<void> {
    // Skip-director is an EXPLICIT owner choice, so honor it unconditionally: even a scheduling-shaped
    // message goes straight to the pipeline. (We used to reroute anything that looked like a schedule
    // request to the director — which owns the scheduling tools — but silently overriding the toggle
    // surprised the owner, who set it on purpose. Instead we dispatch as asked and, when the message
    // genuinely reads like a "set up / change a schedule" request, drop a non-blocking note pointing at
    // the director route — informing without ever hijacking the toggle.)
    const refs = (images ?? []).map((img) =>
      this.db.addAttachment({ name: img.name, mediaType: img.mediaType, data: img.dataBase64 }),
    );
    const userMsg = this.db.addDirectorMessage({ id: messageId, role: "user", kind: "text", content: text, attachments: refs });
    this.hub.publish({ type: "director.message", message: userMsg });

    const ws = workspace?.trim();
    // Skip-director dispatches straight below (no director tool call), so link this prompt to the task
    // it produces right after api.dispatch returns the id.
    if (!ws) {
      this.postDirectorNote(
        `Skip-director is on, so I send your message straight to the pipeline — but I need the repo path for that (there's no director to find it). Set the workspace path in the composer, then send again.`,
      );
      return;
    }
    if (!existsSync(ws)) {
      this.postDirectorNote(
        `Can't dispatch directly: "${ws}" doesn't exist on disk. Fix the workspace path and send again.`,
      );
      return;
    }

    const title = directTitle(text);
    // The composer's effort pick rides along: with no planner-adjacent director in the loop, the owner
    // chooses how hard the implementor works. "auto" keeps the planner (or the high default) in charge.
    const effort = this.api.settings().skipDirectorEffort;
    const id = await this.api.dispatch({
      title,
      workspace: ws,
      brief: text,
      images,
      effort: effort === "auto" ? undefined : effort,
      ...this.taskModeDefaults(),
    });
    const note = this.postDirectorNote(`Skipped the director — dispatched "${title}" straight to the pipeline (task ${id.slice(0, 8)}).`);
    // Link BOTH the prompt (precedes the task) and the confirmation note (follows it) — the note would
    // otherwise be misfiled under the next task by the history backfill's timeline heuristic.
    this.db.linkDirectorMessagesToThread([userMsg.id, note.id], id);
    // Only orchestrator schedules (cron entries) can be created/changed by the director's tools — an
    // implementor can't. When the message explicitly asks to schedule a task, say so without overriding
    // the toggle: it was still dispatched as asked; turning Skip Director off is how to reach the scheduler.
    if (looksLikeScheduleRequest(text)) {
      this.postDirectorNote(
        `Heads up: you mentioned a scheduled task, but Skip Director is on so I dispatched this straight to the pipeline as asked. If you meant to set up or change a recurring schedule (which I handle directly, not an implementor), turn Skip Director off and resend.`,
      );
    }
    // Without the director there's no one to name the task, so the lane would show only the raw first
    // line. Mint a proper title with a cheap Haiku call after dispatch (best-effort, never blocks the
    // pipeline) — unless the owner turned it off to save those tokens.
    if (this.api.settings().skipDirectorRetitle) void this.api.retitleFromBrief(id, text);
  }

  /** The composer's task-mode picks, normalized for dispatch: a wall-clock work window and/or a
   *  collaborator count. Both are off by default (0 minutes / 1 agent), which is an ordinary task. */
  private taskModeDefaults(): { durationMs: number | null; agentCount: number | null } {
    const s = this.api.settings();
    return {
      durationMs: s.taskDurationMinutes > 0 ? normalizeDuration(s.taskDurationMinutes) : null,
      agentCount: s.taskAgentCount > 1 ? clampAgentCount(s.taskAgentCount) : null,
    };
  }

  /**
   * Owner-invoked stop for a stuck turn. The director is "thinking" (busy) but spinning — looping
   * without streaming a reply or dispatching a task — so kill the live run, discard the in-flight
   * turn so a trailing failover/classify can't revive it, and settle back to idle. The long-lived
   * session id is kept, so the NEXT message resumes the conversation with full context; only this
   * one turn is abandoned. A no-op when idle (nothing to stop).
   */
  cancelTurn(): void {
    if (!this.busy) return;
    this.startGeneration++; // invalidate an in-flight smart selection before it can spawn a replacement
    const run = this.run;
    // Drop the run reference FIRST: stop() triggers this run's onEnd, and clearing it here makes
    // that handler see itself superseded (this.run !== run) and skip reactiveFailover — we settle
    // the turn deterministically below instead of letting the failover path re-send it.
    this.run = undefined;
    // Discard the in-flight turn so an in-flight classifyThenFailover bails (it guards on
    // `pending === undefined`) and no re-send can resurrect the loop.
    this.pending = undefined;
    this.pendingImages = [];
    this.failovers = 0;
    if (run) void run.stop();
    this.hub.log("info", "Director turn stopped by the owner.");
    // Posting a director message also clears any half-streamed draft on the clients (the draft is
    // reset when a role:"director" message lands), so the "thinking…" bubble resolves cleanly.
    this.postDirectorNote("Stopped that turn. Send a new message whenever you're ready.");
    this.setBusy(false);
  }

  private postDirectorNote(content: string): DirectorMessage {
    const m = this.db.addDirectorMessage({ role: "director", kind: "text", content });
    this.hub.publish({ type: "director.message", message: m });
    return m;
  }

  private async start(firstContent: UserContent, target?: DirectorTarget): Promise<void> {
    const generation = ++this.startGeneration;
    const chosen = target ?? await this.chooseTarget();
    if (generation !== this.startGeneration || this.pending === undefined) return;
    if (!chosen) {
      this.postDirectorNote(this.allCappedMessage());
      this.settleTurn();
      return;
    }
    const director = createDirectorServer(this.api, () => this.pendingImages, (threadId) => {
      this.db.linkDirectorMessagesToThread(this.currentTurnMsgIds, threadId);
      this.turnDispatchId = threadId; // later replies this turn (the "dispatched X" note) belong here too
    }, this.scheduler, this.notes, () => this.taskModeDefaults());
    const memory = createMemoryServer(this.api.memory);
    const conciseCommunication = this.api.settings().conciseAgentCommunication;
    const cfg = directorConfig(
      { director, memory },
      this.api.directorName(),
      { conciseCommunication },
    );
    const sessionKey = this.sessionKey(chosen);
    const resume = this.activeSessionKey === sessionKey ? this.sessions.get(sessionKey) : undefined;
    const isCli = chosen.provider === "codex" || chosen.provider === "grok";
    const run = this.api.createDirectorAgent(chosen, cfg, { resume, ...(isCli ? { cliSchema: DIRECTOR_CLI_SCHEMA } : {}) });
    this.target = chosen;
    this.activeSessionKey = sessionKey;
    this.db.kvSet(DIRECTOR_TARGET_KV, chosen.key);
    this.db.kvSet(DIRECTOR_TARGET_AUTO_KV, this.targetWasAuto ? "1" : "0");
    this.run = run;
    this.publishStatus();
    this.wire(run, chosen);
    const instructed = withCommunicationTurnPolicy(firstContent, conciseCommunication);
    const content = resume ? instructed : this.bootstrapContent(instructed, cfg.systemPrompt, isCli);
    run.start(content);
  }

  private async chooseTarget(excludeKeys: ReadonlySet<string> = new Set()): Promise<DirectorTarget | undefined> {
    const auto = this.api.settings().autoModelSelection;
    const available = this.api.directorTargets(auto).filter((t) => !excludeKeys.has(t.key));
    const sticky = this.target && auto === this.targetWasAuto && !excludeKeys.has(this.target.key) && this.api.directorTargetReady(this.target)
      ? available.find((t) => t.key === this.target!.key)
      : undefined;
    if (sticky) return sticky;
    let target: DirectorTarget | undefined;
    if (auto) target = await this.api.autoSelectDirectorTarget(excludeKeys);
    else target = this.api.preferredDirectorTarget(available);
    this.targetWasAuto = auto;
    return target;
  }

  private sessionKey(target: DirectorTarget): string {
    // Claude local sessions are portable between Claude subscription tokens; every other provider owns
    // a separate session namespace and must bootstrap from persisted conversation on a cross-provider move.
    return target.provider === "claude" ? "claude" : target.provider;
  }

  private bootstrapContent(content: UserContent, systemPrompt: unknown, cli: boolean): UserContent {
    const previous = this.db.listDirectorMessages(40)
      .filter((m) => !this.currentTurnMsgIds.includes(m.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => `${m.role === "user" ? config.ownerName : this.api.directorName()}: ${m.content}`)
      .join("\n\n")
      .slice(-16_000);
    const system = typeof systemPrompt === "string" ? systemPrompt : "";
    const prefix = [
      cli ? system : "",
      cli ? DIRECTOR_CLI_PROTOCOL : "",
      previous ? `Conversation context from the previous provider/session:\n${previous}` : "",
      previous ? "Continue naturally with the new user message below. Do not mention the provider switch." : "",
    ].filter(Boolean).join("\n\n");
    if (!prefix) return content;
    if (typeof content === "string") return `${prefix}\n\n${content}`;
    return [{ type: "text", text: prefix }, ...content] as UserContent;
  }

  private setBusy(b: boolean): void {
    if (this.busy === b) return;
    this.busy = b;
    this.hub.publish({ type: "director.busy", busy: b });
  }

  private publishStatus(): void {
    this.hub.publish({ type: "director.status", status: this.status() });
  }

  private wire(run: AgentRunLike, target: DirectorTarget): void {
    const cli = target.provider === "codex" || target.provider === "grok";
    const off = run.onEvent((e: AgentEvent) => {
      if (this.run !== run) return; // superseded by a failover switch — don't touch the new run's state
      switch (e.type) {
        case "init":
          if (e.sessionId) this.sessions.set(this.sessionKey(target), e.sessionId);
          break;
        case "text_delta":
          if (!cli) this.hub.publish({ type: "director.delta", text: e.text });
          break;
        case "text": {
          if (!cli) this.postModelMessage(e.text);
          break;
        }
        case "tool_use":
          this.hub.publish({ type: "director.tool", name: e.name, input: e.input });
          break;
        case "result":
          if (this.api.directorRunCapped(target, run)) this.reactiveFailover(run, target);
          else if (cli) void this.handleCliResult(run, target, e);
          else this.settleTurn();
          break;
        case "rate_limit":
          if (target.provider === "claude") this.api.accounts.updateFromRateLimit(target.accountId, e.info);
          break;
        case "error":
          this.hub.log("error", `Director: ${e.message}`); // onEnd settles busy / fails over
          break;
        default:
          break;
      }
    });
    run.onEnd(() => {
      off(); // detach this run's listener so its trailing events can't mutate shared state
      if (this.run !== run) return; // a proactive switch (or a result-driven failover) replaced us
      // Codex/Grok are one-process-per-turn. Their result event and end event are adjacent, while a
      // bridge command (even a plain reply through an async function) resumes on a microtask. Leave the
      // dead runner owned by that handler; it will either post the reply or start a fresh resumed CLI turn.
      if (cli && this.cliHandling.has(run)) return;
      // onEnd only fires when the run truly ENDS — a thrown error / process death. The normal capped
      // turn is handled in the `result` handler above; this catches a run the cap (or a crash) killed
      // outright. reactiveFailover fails over on a cap, otherwise just settles the abandoned turn.
      this.reactiveFailover(run, target);
      if (this.run === run) this.run = undefined; // not switched away — this run is dead, drop it
    });
  }

  private postModelMessage(content: string): DirectorMessage {
    const m = this.db.addDirectorMessage({ role: "director", kind: "text", content });
    this.currentTurnMsgIds.push(m.id);
    if (this.turnDispatchId) this.db.linkDirectorMessagesToThread([m.id], this.turnDispatchId);
    this.hub.publish({ type: "director.message", message: m });
    return m;
  }

  private async handleCliResult(run: AgentRunLike, target: DirectorTarget, result: ResultEvent): Promise<void> {
    if (this.run !== run || this.pending === undefined) return;
    this.cliHandling.add(run);
    if (result.isError) {
      if (this.cliCommittedResult) {
        this.finishCommittedCliTurn(run);
        return;
      }
      void this.failoverAfterCliError(run, target, result.result);
      return;
    }
    const action = result.structuredOutput as DirectorCliAction | undefined;
    if (!action?.kind) {
      if (this.cliCommittedResult) {
        this.finishCommittedCliTurn(run);
        return;
      }
      if (++this.cliCorrections <= 2) {
        const detail = "lastStructuredError" in run && typeof run.lastStructuredError === "string"
          ? ` Parser detail: ${run.lastStructuredError}`
          : "";
        this.continueCli(run, target, `Your reply did not match the Director command schema.${detail} Return exactly one valid JSON command now.`);
        return;
      }
      this.cliHandling.delete(run);
      this.run = undefined;
      this.postDirectorNote(`${providerName(target)} could not produce a valid director command. I stopped this turn; resend and another available provider will be tried.`);
      this.settleTurn();
      return;
    }
    if (++this.cliActions > MAX_CLI_ACTIONS) {
      this.cliHandling.delete(run);
      this.run = undefined;
      this.postDirectorNote("I stopped that turn because the director command loop exceeded its safety limit. Resend with the key action you want.");
      this.settleTurn();
      return;
    }
    const outcome = await executeDirectorCliAction(action, this.api, this.scheduler, this.notes, this.pendingImages, () => this.taskModeDefaults());
    if (this.run !== run || this.pending === undefined) return;
    if (outcome.toolName) this.hub.publish({ type: "director.tool", name: outcome.toolName, input: outcome.toolInput });
    if (outcome.dispatchedId) {
      this.db.linkDirectorMessagesToThread(this.currentTurnMsgIds, outcome.dispatchedId);
      this.turnDispatchId = outcome.dispatchedId;
    }
    if (outcome.result && isCommittedCliAction(action.kind) && !outcome.result.startsWith("ERROR:")) {
      this.cliCommittedResult = outcome.result;
    }
    if (outcome.final) {
      this.cliHandling.delete(run);
      this.run = undefined;
      this.postModelMessage(outcome.final);
      this.settleTurn();
      return;
    }
    this.continueCli(run, target, `TOOL RESULT (${outcome.toolName ?? action.kind}):\n${outcome.result ?? "OK"}\n\nReturn the next Director JSON command.`);
  }

  /** Finish truthfully after a state-changing command succeeded but its optional prose confirmation
   *  failed. The server's own tool result is authoritative and already concise/user-facing. */
  private finishCommittedCliTurn(run: AgentRunLike): void {
    if (this.run !== run || !this.cliCommittedResult) return;
    const message = this.cliCommittedResult;
    this.cliHandling.delete(run);
    this.run = undefined;
    this.postModelMessage(message);
    this.settleTurn();
  }

  /** A real CLI/process failure before any side effect is safe to retry on a different provider. Do
   *  not mislabel it as malformed JSON, and do not wait for the owner to resend manually. */
  private async failoverAfterCliError(run: AgentRunLike, target: DirectorTarget, reason?: string): Promise<void> {
    if (this.run !== run || this.pending === undefined) return;
    const pending = this.pending;
    const next = this.failovers < MAX_DIRECTOR_FAILOVERS
      ? await this.chooseTarget(new Set([target.key]))
      : undefined;
    if (this.run !== run || this.pending === undefined) return;
    this.cliHandling.delete(run);
    this.run = undefined;
    await run.stop().catch(() => {});
    if (next) {
      this.failovers++;
      this.hub.log("warn", `Director CLI failed on ${providerName(target)} — switching to ${providerName(next)}. ${reason ?? ""}`.trim());
      await this.start(pending, next);
      return;
    }
    this.postDirectorNote(`${providerName(target)} could not complete the director turn${reason ? `: ${reason}` : "."}`);
    this.settleTurn();
  }

  /** A completed batch CLI cannot be reused in-place: start a new process resumed onto its session. */
  private continueCli(run: AgentRunLike, target: DirectorTarget, content: string): void {
    if (this.run !== run || this.pending === undefined) return;
    this.cliHandling.delete(run);
    this.run = undefined; // neutralize the old runner's adjacent onEnd callback
    void this.start(content, target);
  }

  /**
   * The turn ran out of usable allowance on `acct` and produced no real answer. When the director's
   * model has its OWN metered pool (Fable), first classify the cap with a fresh usage read — a pool
   * cap retries on the SAME account with the fallback model (classifyCap latches it, so modelFor
   * resolves the fallback). Otherwise move to a sub with headroom (resume the session so context
   * survives) and re-send the same message; if no sub has headroom, tell the owner when the soonest
   * one frees up instead of going silently idle. Safe to call from both the `result` handler (live
   * streaming turn) and onEnd (run died) — the `this.run !== run` guards in wire() neutralize the
   * superseded run's trailing events.
   */
  private reactiveFailover(run: AgentRunLike, target: DirectorTarget): void {
    if (this.classifying) return; // an in-flight classification owns this turn's revival — don't race it
    if (run.rateLimited && this.pending !== undefined && this.failovers < MAX_DIRECTOR_FAILOVERS) {
      if (target.provider === "claude" && fallbackModelFor(target.model)) {
        // classifyCap pings the account (async) — latch a flag so a result-handler call and an onEnd
        // call for the same dead run can't both classify and double-start the replacement.
        this.classifying = true;
        void this.classifyThenFailover(run, target).finally(() => (this.classifying = false));
        return;
      }
    }
    void this.providerFailoverOrSettle(run, target);
  }

  /** Async half of reactiveFailover for a fallback-capable model: a pool cap restarts the turn on the
   *  SAME account (modelFor now resolves the fallback); a real account cap falls through to the normal
   *  account switch. Re-checks that the turn wasn't superseded while the classify ping ran. */
  private async classifyThenFailover(run: AgentRunLike, target: DirectorTarget): Promise<void> {
    const kind = await this.api.accounts.classifyCap(target.accountId, target.model, run.rateLimitInfo).catch(() => "account" as const);
    // Superseded while we pinged (a new user turn started another run) → leave the new turn alone.
    // this.run === undefined means the capped run died without a replacement — still ours to revive.
    if (this.pending === undefined || (this.run !== run && this.run !== undefined)) return;
    if (kind === "model") {
      this.failovers++;
      const next = await this.chooseTarget(new Set([target.key]));
      this.hub.log("warn", `Director hit the ${target.model} model pool on ${target.accountLabel} — switching to ${next?.model ?? "another available model"}.`);
      this.run = undefined;
      await run.stop();
      if (next && this.pending) await this.start(this.pending, next);
      else this.finishUnavailable();
      return;
    }
    await this.providerFailoverOrSettle(run, target);
  }

  private async providerFailoverOrSettle(run: AgentRunLike, target: DirectorTarget): Promise<void> {
    const capped = this.api.directorRunCapped(target, run);
    if (!capped || this.pending === undefined) {
      this.settleTurn();
      return;
    }
    this.api.noteDirectorProviderCap(target);
    if (this.failovers < MAX_DIRECTOR_FAILOVERS) {
      const pending = this.pending;
      const next = await this.chooseTarget(new Set([target.key]));
      if (next && pending && (this.run === run || this.run === undefined)) {
        this.failovers++;
        this.hub.log("warn", `Director hit a usage limit on ${providerName(target)} — switching to ${providerName(next)} (${next.model}).`);
        this.run = undefined;
        await run.stop();
        await this.start(pending, next);
        return;
      }
    }
    this.finishUnavailable();
  }

  private finishUnavailable(): void {
    this.postDirectorNote(this.allCappedMessage());
    this.hub.log("warn", "Director: every enabled provider is capped or unavailable — no failover target.");
    this.target = undefined;
    this.db.kvSet(DIRECTOR_TARGET_KV, "");
    this.publishStatus();
    this.settleTurn();
  }

  private settleTurn(): void {
    this.pending = undefined;
    this.failovers = 0;
    this.pendingImages = [];
    this.cliActions = 0;
    this.cliCorrections = 0;
    this.cliCommittedResult = undefined;
    this.setBusy(false);
  }

  /** Message for when every sub is capped — phrased for the ACTUAL number of configured subscriptions
   *  (1, 2, or more; never a hardcoded "Both"), naming when the soonest one frees up if we know it. */
  private allCappedMessage(): string {
    return this.api.directorCapacityWaitMessage();
  }
}

const COMMITTED_CLI_ACTIONS = new Set([
  "dispatch",
  "dispatch_read",
  "inject",
  "interrupt_thread",
  "auto_review",
  "post_operator_note",
  "create_scheduled_task",
  "update_scheduled_task",
  "delete_scheduled_task",
]);

function isCommittedCliAction(kind: string): boolean {
  return COMMITTED_CLI_ACTIONS.has(kind);
}

function providerName(target: DirectorTarget): string {
  return target.provider === "claude" ? `${target.accountLabel} (Claude)`
    : target.provider === "codex" ? "Codex"
      : target.provider === "grok" ? "Grok"
        : "z.ai";
}

/** Appended to voice-originated prompts: the reply is read aloud by TTS mid-conversation, so the
 *  director must talk like a person and get a spoken go-ahead before dispatching. */
function voiceNote(): string {
  return `[VOICE — ${config.ownerName} spoke this aloud and your reply will be read out by TTS in a live back-and-forth conversation. Answer like you're talking: brief plain sentences, no markdown, no lists, no code, no file paths. Talk the idea through with them and get a spoken go-ahead before dispatching a task; a "yeah"/"sure"/"go ahead" means dispatch now without re-asking. Skip this only when they explicitly say to dispatch immediately.]`;
}

// Up to three words may sit between the two halves ("schedule a cleanup task").
const NEAR = "(?:\\s+\\S+){0,3}\\s+";
const TASK = "(?:tasks?|jobs?)\\b";
// The three shapes of an explicit ask. Each needs BOTH halves — a lone "schedule"/"cron" or a lone
// "task" is never enough: "schedule a task", "that scheduled task", "put this task on a schedule".
const A_SCHEDULED_TASK = new RegExp(`\\b(?:scheduled|cron)\\s+${TASK}`);
const SCHEDULE_A_TASK = new RegExp(`\\bschedule\\b${NEAR}${TASK}`);
const TASK_ON_A_SCHEDULE = new RegExp(`\\btasks?\\b${NEAR}schedule\\b`);
// "…the scheduled tasks panel/list/view" — a feature request ABOUT the scheduler surface, which says
// both words without asking for anything to be scheduled. This repo IS the orchestrator, so the owner
// writes those prompts often; treating them as schedule asks is the same nagging in a new costume.
const ABOUT_THE_SCHEDULER =
  /\b(?:scheduled|cron)\s+(?:tasks?|jobs?)\s+(?:panel|view|page|tab|list|table|column|row|card|modal|dialog|button|badge|header|section|screen|ui|form|editor|api|endpoint|route|schema|broadcast|component)\b/;

/** Whether a skip-director message is EXPLICITLY asking to set up or change a recurring scheduled task.
 *  The owner's rule is the bar: it is never a scheduled task unless they said "schedule" (or "cron") AND
 *  "task" (or "job") as one request. Cadence language on its own describes the WORK, not a cron entry —
 *  "run this daily", "until a new weekly reset appears", "add a Weekly token safety %" are ordinary tasks
 *  and used to trip the old frequency-word heuristic. A miss here costs only a reminder note; a false
 *  positive nags on every task that happens to mention a frequency, so this errs toward silence. */
export function looksLikeScheduleRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (ABOUT_THE_SCHEDULER.test(t)) return false;
  return A_SCHEDULED_TASK.test(t) || SCHEDULE_A_TASK.test(t) || TASK_ON_A_SCHEDULE.test(t);
}

/** A board-lane title from a raw skip-director message: first non-empty line, trimmed to a short label. */
function directTitle(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean) ?? text.trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57).trimEnd() + "…" : firstLine || "Direct task";
}
