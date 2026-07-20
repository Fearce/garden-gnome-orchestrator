import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import type { AgentEvent, ChatScope, GrokEffort, RateLimitInfo } from "../types.js";
import { withAgentToolPath } from "./env.js";
import { endsWithOpenOfficeMarker, extractOfficeChat } from "./officeBridge.js";
import {
  formatStructuredRoleFeed,
  parseStructuredText,
  takeStructuredProgressLines,
  validateAgainstSchema,
  type JsonSchemaLike,
} from "./structuredText.js";
import { transientApiErrorInfo, type AgentRunLike, type ResultEvent, type SendOpts, type UserContent } from "./runner.js";

export interface GrokRunConfig {
  /** The Grok model to run, e.g. `grok-4.5`. */
  model: string;
  /** Grok CLI reasoning effort, passed as --reasoning-effort. */
  effort: GrokEffort;
  cwd: string;
  /** A prior Grok session id to `-r/--resume` instead of starting fresh. */
  resume?: string;
  /** Full fresh-start kickoff used to self-heal a wedged `--resume`: if a resume turn produces ZERO
   *  events, the runner retries ONCE as a fresh turn with this prompt — the prior working-tree edits
   *  already live on disk, so the fresh session re-reads them and continues. Omit to disable self-heal. */
  freshFallback?: string;
  /** When set, the turn is constrained to JSON matching this schema (`--json-schema`). The Grok CLI
   *  puts the validated object on the `end` event as `structuredOutput`; we also fall back to parsing
   *  the streamed text so a multi-turn role (planner/QA) still yields a pipeline-usable result. */
  outputSchema?: JsonSchemaLike;
  /** Grok has no office MCP tools. A standalone `OFFICE[team|office]: ...` line in its assistant message
   *  is intercepted here and posted through the orchestrator's real office chat backend. */
  onOfficeChat?: (scope: ChatScope, body: string) => void;
}

/** Pull the plain text out of a UserContent (string or content-block array). Grok headless takes only a
 *  text prompt (via --prompt-file), so image blocks are dropped — see the images note on runTurn. */
function toText(content: UserContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "type" in b && (b as { type: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
}

interface GrokEvent {
  type?: string;
  data?: string;
  stopReason?: string;
  sessionId?: string;
  message?: string;
  num_turns?: number;
  total_cost_usd?: number;
  /** Present on `end` when the turn was started with `--json-schema` — the CLI's already-validated object. */
  structuredOutput?: unknown;
}

// Matches SuperGrok's plan usage-cap wording and the generic 429/quota errors the CLI can surface. Grok
// exposes no rate-limit windows, so a rejected turn is the ONLY cap signal — err broad here. A flat-fee
// sub whose period usage is spent surfaces as HTTP 402 "Payment Required: Grok Build usage balance
// exhausted" — that's a cap (fails over to Claude/Codex + latches the cooldown), NOT a plain error that
// parks the task for human review, so 402/payment-required/balance-exhausted must match too.
const RATE_LIMIT_RE =
  /(rate.?limit|429|402|payment required|too many requests|quota (?:exceeded|reached)|insufficient|usage[ _]limit|reached your (?:usage|plan|limit)|limit reached|out of (?:capacity|credits)|(?:balance|credits?|quota) (?:exhausted|depleted)|capacity)/i;
/** Max in-session re-prompts when a structured role (planner/QA) finishes without a schema-valid object. */
const MAX_STRUCTURED_RETRIES = 2;

export interface GrokAuthInfo {
  signedIn: boolean;
  email: string | null;
  tier: number | null;
  expiresAt: number | null; // epoch ms the cached OAuth token expires (the CLI refreshes it in place)
}

interface GrokAuthEntry {
  email?: string;
  tier?: number;
  expires_at?: string;
  refresh_token?: string;
  key?: string;
  auth_mode?: string;
}

/** Read ~/.grok/auth.json for the signed-in identity the usage chip surfaces. The file is a map keyed by
 *  `<issuer>::<client_id>`; the newest entry with a token wins. Returns a signed-out shape (never throws)
 *  when the file is absent/corrupt, so a missing login degrades to "not signed in" rather than an error. */
export function readGrokAuth(): GrokAuthInfo {
  const out: GrokAuthInfo = { signedIn: false, email: null, tier: null, expiresAt: null };
  const file = join(config.grok.home, "auth.json");
  if (!existsSync(file)) return out;
  let parsed: Record<string, GrokAuthEntry>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, GrokAuthEntry>;
  } catch {
    return out;
  }
  const entries = Object.values(parsed).filter((e) => e && (e.refresh_token || e.key));
  if (!entries.length) return out;
  const entry = entries[entries.length - 1]!;
  const exp = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
  return {
    signedIn: true,
    email: entry.email ?? null,
    tier: typeof entry.tier === "number" ? entry.tier : null,
    expiresAt: Number.isFinite(exp) ? exp : null,
  };
}

/** Whether the Grok backend has usable auth right now — a `grok login` (auth.json) or an XAI_API_KEY in
 *  the environment (the CI auth path). The dispatch gate uses this to decide whether Grok can implement. */
export function grokAuthAvailable(): boolean {
  if (readGrokAuth().signedIn) return true;
  return !!process.env.XAI_API_KEY?.trim();
}

/** Stage one Grok prompt at a process-wide unique path. GrokAgentRun instances execute concurrently, so
 * an instance-local counter is not enough: every new run starts at turn 1 and would otherwise overwrite
 * every other run's `p<pid>-1.txt` before the CLI opens it. `wx` makes the uniqueness guarantee atomic
 * even in the vanishingly unlikely event of a UUID collision. Exported for the concurrency regression. */
export async function stageGrokPrompt(prompt: string): Promise<string | undefined> {
  const dir = join(tmpdir(), "gg-grok-prompts");
  await mkdir(dir, { recursive: true }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = join(dir, `p${process.pid}-${randomUUID()}.txt`);
    try {
      await writeFile(path, prompt, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
  }
  return undefined;
}

/**
 * One running xAI Grok implementor. Mirrors AgentRun's public surface (AgentRunLike) so the thread
 * manager drives it identically, but the engine is the batch-oriented `grok` CLI (SuperGrok subscription)
 * rather than the Claude Agent SDK. Each `grok --prompt-file <f> [-r <id>]` invocation runs ONE agentic
 * turn (which may itself take many internal model turns + tool calls) to completion and exits, so
 * multi-turn continuity (QA fix-rounds, manual resume) is achieved by resuming the captured Grok session
 * id in a fresh invocation — exactly the resume path the orchestrator already uses for Claude/Codex.
 *
 * The Grok CLI has no in-process MCP bus tools, so a Grok implementor runs without post_finding/ask_user
 * (a documented degradation shared with Codex); office coordination goes through a text bridge. Streaming
 * JSON surfaces reasoning + response text but not per-tool events, so the feed shows the agent's thinking
 * and messages rather than tool cards — the QA loop still reviews the real git diff.
 */
export class GrokAgentRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined;
  finished = false;
  lastResult: ResultEvent | undefined;
  // Grok auth is a single flat-fee subscription with no multi-account headroom signal, so we never flag a
  // cap on `rateLimited` (which drives the Claude-account failover). Instead `capped` flags that the
  // PROVIDER itself was rejected (usage cap hit), which the pipeline uses to fail the task over to another
  // backend.
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;
  capped = false;
  // True once a wedged `--resume` self-healed to a fresh start. Read by the thread manager after the run
  // ends so it can stop attempting resume for this thread (resume keeps producing nothing → go fresh).
  resumeHealed = false;

  private child: ChildProcess | undefined;
  private turnStarting = false;
  private turnActive = false;
  private stopped = false;
  private interrupting = false;
  private stdoutBuf = "";
  private lastErrorMsg: string | undefined;
  private sawTerminal = false; // an `end` (or error) event seen for the current turn
  private textBuf = ""; // accumulated `text` chunks for the current turn — emitted as one message on close
  /** True while the latest stream events are `text` chunks. A non-text event (thought/tool/…) ends the
   *  model-turn segment: we harvest OFFICE posts then and insert a newline so the next turn can't glue
   *  onto a claim body (the prod failure mode where "claiming foo" + "Implementing bar" became one post). */
  private streamInText = false;
  /** Accumulated `thought` chunks for the current reasoning burst. Grok's streaming-json emits no tool
   *  events, so reasoning is the only narrative of a long agentic run — we persist each burst as a durable
   *  `thinking` message (not just an ephemeral thinking_delta) so the transcript survives reload. */
  private thoughtBuf = "";
  /** True while the latest stream events are `thought` chunks; a `text`/tool/end event closes the burst. */
  private streamInThought = false;
  private maxTurnsHit = false;
  /** CLI-native structured output from the latest `end` event (preferred over re-parsing streamed text). */
  private endStructuredOutput: unknown | undefined;
  /** Last structured-parse failure message when a schema was requested but neither end nor text yielded a value. */
  lastStructuredError: string | undefined;
  /** How many times this run has already re-prompted for a schema-valid structured result. */
  private structuredRetries = 0;
  /** How many complete JSON objects from textBuf have already been surfaced as live progress deltas
   *  (structured roles only). Prevents re-emitting the same status tick on every chunk. */
  private structuredProgressEmitted = 0;
  private pendingTerminalResult: { subtype: string; isError: boolean; result?: string; numTurns?: number; costUsd?: number; structuredOutput?: unknown } | undefined;
  private readonly pendingSends: string[] = [];
  private promptFile: string | undefined;
  private turnWatchdog: NodeJS.Timeout | undefined;
  private sawFirstEvent = false;
  private isResumeTurn = false;
  /** True once we've emitted an `init` for this process (first stream event and/or final session id). */
  private emittedInit = false;

  constructor(private readonly cfg: GrokRunConfig) {
    this.emitter.setMaxListeners(50);
  }

  start(firstMessage: UserContent): this {
    void this.runTurn(toText(firstMessage), this.cfg.resume);
    return this;
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  onEnd(cb: () => void): void {
    if (this.finished) cb();
    else this.emitter.once("end", cb);
  }

  /** Queue a follow-up. The CLI can't accept mid-turn input, so ordinary sends wait for the current batch
   *  turn. `priority: "now"` is human steering: end the old batch as soon as its session id is known, then
   *  onTurnClose resumes that session with the buffered message. */
  send(content: UserContent, opts?: SendOpts): void {
    if (this.stopped) return;
    const text = toText(content);
    if (!text.trim()) return;
    if (this.turnStarting || this.turnActive) {
      this.pendingSends.push(text);
      if (opts?.priority === "now") this.requestInterrupt();
      return;
    }
    void this.runTurn(text, this.sessionId);
  }

  async interrupt(): Promise<void> {
    this.requestInterrupt();
  }

  // The CLI has no live model/permission switch; these exist only to satisfy AgentRunLike.
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  endInput(): void {}

  async stop(): Promise<void> {
    this.stopped = true;
    this.killChild();
    if (!this.finished) {
      this.finished = true;
      this.emitter.emit("end");
    }
  }

  result(): Promise<ResultEvent | undefined> {
    if (this.lastResult) return Promise.resolve(this.lastResult);
    return this.nextResult();
  }

  nextResult(): Promise<ResultEvent | undefined> {
    return new Promise((resolve) => {
      const onEnd = () => {
        off();
        resolve(this.lastResult);
      };
      const off = this.onEvent((e) => {
        if (e.type === "result") {
          this.emitter.off("end", onEnd);
          off();
          resolve(e);
        }
      });
      this.emitter.once("end", onEnd);
    });
  }

  private emit(e: AgentEvent): void {
    this.emitter.emit("event", e);
  }

  /** Mark the current batch for interruption. A fresh turn cannot safely be killed before its session id
   *  lands: without that id there is nothing to resume and the original task context would be lost. In
   *  that short startup window handleEvent completes the interrupt once the id arrives. */
  private requestInterrupt(): void {
    this.interrupting = true;
    if (this.turnActive && this.sessionId) this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** Spawn one `grok` turn (fresh, or `-r <id>` resume) and stream its JSONL events. The prompt goes via
   *  `--prompt-file` (a real implementor kickoff is tens of KB — passing it as an argv arg overflows the
   *  Windows ~32KB command-line limit, the same failure that bit the Codex backend). Pasted images can't
   *  be attached to a Grok headless turn, so they're dropped here; the kickoff text still describes them. */
  private async runTurn(prompt: string, resumeId?: string): Promise<void> {
    if (this.stopped) return;
    this.turnStarting = true;
    this.sawTerminal = false;
    this.sawFirstEvent = false;
    this.isResumeTurn = !!resumeId;
    this.lastErrorMsg = undefined;
    this.pendingTerminalResult = undefined;
    this.stdoutBuf = "";
    this.textBuf = "";
    this.streamInText = false;
    this.thoughtBuf = "";
    this.streamInThought = false;
    this.structuredProgressEmitted = 0;
    this.maxTurnsHit = false;
    this.endStructuredOutput = undefined;
    this.lastStructuredError = undefined;
    // Reset the cap flags per turn: a cap on one turn must not mislabel a later chained turn (a queued
    // pendingSends follow-up, or an interrupt-then-resume) on the same run object as capped.
    this.capped = false;
    this.rateLimitInfo = undefined;
    // A resumed invocation already has a durable session id even before the CLI repeats it — keep it so an
    // immediate priority-now message can safely interrupt the startup window.
    this.sessionId = resumeId;
    if (!existsSync(config.grok.bin)) {
      this.turnStarting = false;
      this.finishTurn({ subtype: "error", isError: true, result: `Grok CLI not found at ${config.grok.bin}. Install it from https://x.ai/cli or set GROK_BIN.` });
      return;
    }
    const promptFile = await this.writePrompt(prompt);
    if (!promptFile) {
      this.turnStarting = false;
      this.finishTurn({ subtype: "error", isError: true, result: "Failed to stage the Grok prompt file." });
      return;
    }
    const args: string[] = [];
    if (resumeId) args.push("-r", resumeId);
    args.push(
      "--prompt-file",
      promptFile,
      "--output-format",
      "streaming-json",
      "-m",
      this.cfg.model,
      "--reasoning-effort",
      this.cfg.effort,
      // --yolo: always-approve tool execution (file writes, shell) for unattended runs — the Grok
      // equivalent of Codex's approvals bypass. The sandbox is off by default, so full FS + network access
      // (needed for `git push`) is already granted; we deliberately pass no --sandbox profile.
      "--yolo",
      "--cwd",
      this.cfg.cwd,
      "--no-alt-screen",
      "--no-auto-update",
    );
    if (this.cfg.outputSchema) args.push("--json-schema", JSON.stringify(this.cfg.outputSchema));
    // GROK_HOME points the CLI at the home whose auth.json holds the `grok login` credentials;
    // GROK_DISABLE_AUTOUPDATER stops a mid-run self-update from stalling the turn.
    const env: NodeJS.ProcessEnv = withAgentToolPath({ ...process.env, GROK_HOME: config.grok.home, GROK_DISABLE_AUTOUPDATER: "1" });
    let child: ChildProcess;
    try {
      child = spawn(config.grok.bin, args, { cwd: this.cfg.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.turnStarting = false;
      this.turnActive = false;
      this.finishTurn({ subtype: "error", isError: true, result: `Failed to spawn Grok CLI: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    this.child = child;
    this.turnStarting = false;
    this.turnActive = true;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    // Grok logs update notices + errors to stderr; keep the latest substantive line as a fallback failure
    // reason if the turn dies without an `end`/`error` event. Skip pure timestamped log lines.
    child.stderr?.on("data", (chunk: string) => {
      const line = String(chunk).trim();
      if (line && !/^\d{4}-\d\d-\d\dT/.test(line) && !/^\x1b/.test(line)) this.lastErrorMsg = line.slice(0, 500);
    });
    child.on("error", (err) => {
      this.lastErrorMsg = err.message;
    });
    child.on("close", (code) => this.onTurnClose(code));
    // A priority-now send can land during async startup. A resume already has its session id and can stop
    // here; a fresh run waits for the sessionId in the `end`/handleEvent path so its task stays resumable.
    if (this.interrupting && this.sessionId) this.killChild();
    else this.armWatchdog();
  }

  /** Write this turn's prompt to a temp file and return its path (null on failure). */
  private async writePrompt(prompt: string): Promise<string | undefined> {
    void this.cleanupPrompt();
    const path = await stageGrokPrompt(prompt);
    this.promptFile = path;
    return path;
  }

  /** Delete the temp prompt file from the last turn (fire-and-forget; a missing file is fine). */
  private cleanupPrompt(): void {
    const p = this.promptFile;
    this.promptFile = undefined;
    if (p) void unlink(p).catch(() => {});
  }

  /** (Re)arm the no-output watchdog for the live turn — the tight startup bound until the first event
   *  lands, then the generous mid-stream bound. A wedged `grok` (notably a wedged `--resume`) can hang
   *  emitting nothing and never exit, so onTurnClose would never fire and the task would hang forever. */
  private armWatchdog(): void {
    this.clearWatchdog();
    if (!this.turnActive) return;
    const ms = this.sawFirstEvent ? config.grok.inactivityMs : config.grok.firstEventMs;
    if (!ms || ms <= 0) return; // watchdog disabled via config/env
    this.turnWatchdog = setTimeout(() => this.onWatchdogTimeout(ms), ms);
    this.turnWatchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.turnWatchdog) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = undefined;
    }
  }

  private onWatchdogTimeout(ms: number): void {
    if (!this.turnActive) return;
    const secs = Math.round(ms / 1000);
    this.lastErrorMsg = this.sawFirstEvent
      ? `Grok emitted no output for ${secs}s — the turn appears wedged; killed by the inactivity watchdog.`
      : `Grok produced no events within ${secs}s of starting — a wedged turn; killed by the startup watchdog.`;
    this.killChild();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let ev: GrokEvent;
      try {
        ev = JSON.parse(line) as GrokEvent;
      } catch {
        continue; // not a JSON event line (stray log) — ignore
      }
      this.sawFirstEvent = true;
      this.armWatchdog(); // each event pushes the no-output deadline out
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: GrokEvent): void {
    // Grok only puts sessionId on the final `end` event. Emit an early `init` on the first stream
    // event so the run leaves "starting" during multi-minute tool loops (QA often thinks for minutes
    // before any assistant text). A later init with the real id overwrites when `end` arrives.
    this.emitInitIfNeeded(ev.sessionId);
    switch (ev.type) {
      case "text":
        // Stream the chunk live into the feed AND accumulate it — the whole message is persisted as one
        // `text` block on close (office-bridge lines are stripped there before it reaches the transcript).
        // Structured roles (`--json-schema`) stream one machine JSON object per model turn; dumping those
        // raw into the feed is unreadable (Grok QA especially), so we buffer and surface human progress
        // lines instead, then flush a fully humanized transcript on close.
        if (ev.data) {
          // A text chunk ends the current reasoning burst — commit it as a durable `thinking` message.
          this.endThoughtSegment();
          this.streamInText = true;
          this.textBuf += ev.data;
          if (this.cfg.outputSchema) this.emitStructuredProgress();
          else this.emit({ type: "text_delta", text: ev.data });
        }
        break;
      case "thought":
        // A thought after assistant text ends that model-turn segment. Harvest OFFICE posts NOW so peers
        // see claims mid-run (not only when the whole CLI process exits), and separate segments with a
        // newline so a later turn can't glue onto the claim body.
        this.endTextSegment();
        if (ev.data) {
          this.streamInThought = true;
          this.thoughtBuf += ev.data;
          this.emit({ type: "thinking_delta", text: ev.data });
        }
        break;
      case "max_turns_reached":
        this.endTextSegment();
        this.endThoughtSegment();
        this.maxTurnsHit = true;
        break;
      case "error": {
        this.endTextSegment();
        this.endThoughtSegment();
        this.sawTerminal = true;
        const msg = ev.message ?? this.lastErrorMsg ?? "Grok turn failed.";
        if (RATE_LIMIT_RE.test(msg)) this.markCapped();
        else this.markTransientApiError(msg);
        this.pendingTerminalResult = { subtype: "error", isError: true, result: msg };
        break;
      }
      case "end": {
        this.endTextSegment();
        this.endThoughtSegment();
        this.sawTerminal = true;
        if (ev.sessionId) {
          const first = !this.sessionId;
          this.sessionId = ev.sessionId;
          // Always surface the durable id (first init may have been session-less).
          this.emit({ type: "init", sessionId: ev.sessionId });
          this.emittedInit = true;
          if (first && this.interrupting) this.killChild();
        }
        // Prefer the CLI's already-validated object. Multi-turn structured roles stream one JSON object
        // *per model turn* as `text`, so concatenating textBuf and JSON.parse fails; `end.structuredOutput`
        // is the final schema-matched verdict and is what makes planner/QA work on Grok.
        if (ev.structuredOutput !== undefined) this.endStructuredOutput = ev.structuredOutput;
        // A cap can also close a turn via `end` with a limit stopReason rather than an `error` event.
        const stop = ev.stopReason ?? "";
        if (RATE_LIMIT_RE.test(stop)) this.markCapped();
        // `MaxTurns` (or a max_turns_reached event) is an involuntary cutoff, NOT a finish — surface it as
        // error_max_turns so the pipeline silently warm-resumes it, exactly like the Claude turn ceiling.
        const cutoff = this.maxTurnsHit || /max.?turns/i.test(stop);
        if (cutoff) {
          this.pendingTerminalResult = { subtype: "error_max_turns", isError: true, result: "Grok stopped at its turn limit.", numTurns: ev.num_turns, costUsd: ev.total_cost_usd };
        } else if (this.capped) {
          this.pendingTerminalResult = { subtype: "error", isError: true, result: `Grok hit its usage limit (${stop || "rejected"}).`, numTurns: ev.num_turns, costUsd: ev.total_cost_usd };
        } else {
          this.pendingTerminalResult = { subtype: "success", isError: false, numTurns: ev.num_turns, costUsd: ev.total_cost_usd };
        }
        break;
      }
      default:
        // Unknown event types (future tool/status markers) also bound a text/reasoning segment.
        this.endTextSegment();
        this.endThoughtSegment();
        break;
    }
  }

  /** Commit the current reasoning burst as a durable `thinking` message. Reasoning is Grok's only
   *  visible narrative (its CLI emits no tool events), so persisting each burst — rather than dropping
   *  the ephemeral thinking_delta stream — is what keeps a long agentic run's transcript from being
   *  empty on reload. Called at every text/tool/end boundary and on turn close. */
  private endThoughtSegment(): void {
    if (!this.streamInThought) return;
    this.streamInThought = false;
    const text = this.thoughtBuf.trim();
    this.thoughtBuf = "";
    if (text) this.emit({ type: "thinking", text });
  }

  /** Close the current assistant-text segment: post any *complete* OFFICE bridge lines immediately,
   *  leave incomplete markers in the buffer (Grok interleaves thought/text mid-answer, so harvesting
   *  open-ended bodies here produced truncated team posts like "claimi"), and insert a newline only
   *  when no open marker remains — so a later turn can't glue onto a finished claim body. */
  private endTextSegment(): void {
    if (!this.streamInText) return;
    this.streamInText = false;
    this.harvestOfficePosts({ openEnded: false });
    // Don't append `\n` while an OFFICE marker is still open — that would falsely complete it on the
    // next harvest. Segment separation only applies once the claim body is done.
    if (this.textBuf && !this.textBuf.endsWith("\n") && !endsWithOpenOfficeMarker(this.textBuf)) {
      this.textBuf += "\n";
    }
  }

  /** Strip + post OFFICE[...] markers from textBuf in place. Safe to call repeatedly — already-posted
   *  markers are gone from the buffer, so a later flush won't double-post. Incomplete open markers are
   *  left in place when `openEnded` is false (mid-segment). */
  private harvestOfficePosts(opts?: { openEnded?: boolean }): void {
    if (!this.textBuf) return;
    const { visible, posts } = extractOfficeChat(this.textBuf, opts);
    for (const post of posts) {
      try {
        this.cfg.onOfficeChat?.(post.scope, post.body);
      } catch {
        /* best-effort side channel; never fail the turn because office chat failed */
      }
    }
    this.textBuf = visible;
  }

  /** Flag that this turn died to a usage cap. Drives the pipeline's provider failover to another backend —
   *  NOT the Claude-account failover (see the `capped`/`rateLimited` field comment). */
  private markCapped(): void {
    this.capped = true;
    this.rateLimitInfo = { status: "rejected" };
  }

  private markTransientApiError(value: unknown): void {
    const info = transientApiErrorInfo(value);
    if (!info || this.transientApiError) return;
    this.transientApiError = true;
    this.transientApiErrorMessage = info.message;
  }

  /** Promote the run out of "starting" on first stream event. sessionId is often still unknown until `end`. */
  private emitInitIfNeeded(sessionId?: string): void {
    if (sessionId) this.sessionId = sessionId;
    if (this.emittedInit) return;
    this.emittedInit = true;
    this.emit({ type: "init", sessionId: this.sessionId });
  }

  private finishTurn(partial: { subtype: string; isError: boolean; result?: string; numTurns?: number; costUsd?: number; structuredOutput?: unknown }): void {
    this.clearWatchdog();
    const evt: ResultEvent = {
      type: "result",
      subtype: partial.subtype,
      isError: partial.isError,
      result: partial.result,
      numTurns: partial.numTurns,
      costUsd: partial.costUsd,
      structuredOutput: partial.structuredOutput,
    };
    this.lastResult = evt;
    this.emit(evt);
  }

  /** Flush the turn's accumulated assistant text: strip + post any remaining OFFICE[...] bridge lines
   *  (segment harvest during the stream usually already did this), emit the rest as one persisted `text`
   *  block, and resolve structuredOutput for schema-constrained roles.
   *
   *  Open-ended bodies are only accepted on a clean CLI `end` — a mid-stream kill/interrupt would
   *  otherwise post truncated fragments (prod: Fen "claimi" after a server bounce). */
  private flushText(): unknown {
    // Commit any reasoning burst that was still open when the stream ended (e.g. a watchdog kill mid-thought
    // with no terminal event) so the last narration isn't lost.
    this.endThoughtSegment();
    this.streamInText = false;
    const openEnded = this.sawTerminal && !this.interrupting;
    this.harvestOfficePosts({ openEnded });
    const visible = this.textBuf;
    this.textBuf = "";
    this.structuredProgressEmitted = 0;
    // Parse structured output from the RAW buffer first (humanization must not break the pipeline).
    const structured = this.resolveStructuredOutput(visible);
    if (visible.trim()) {
      const display = this.cfg.outputSchema ? formatStructuredRoleFeed(visible) : visible;
      if (display.trim()) this.emit({ type: "text", text: display });
    }
    return structured;
  }

  /** Structured-role live progress: as complete JSON objects land in textBuf, emit short bullet lines
   *  (`- summary…`) instead of raw `{ "pass": … }` chunks the owner can't read on the board/draft. */
  private emitStructuredProgress(): void {
    const { nextIndex, lines } = takeStructuredProgressLines(this.textBuf, this.structuredProgressEmitted);
    this.structuredProgressEmitted = nextIndex;
    if (!lines.length) return;
    // Join with newlines so the draft accumulates a readable checklist rather than a single blob.
    this.emit({ type: "text_delta", text: lines.join("\n") + "\n" });
  }

  /** Prefer `end.structuredOutput` (CLI-validated under `--json-schema`). Fall back to the same text
   *  recovery Codex uses — last fenced/balanced object that shape-checks — because multi-turn Grok
   *  concatenates one JSON object per model turn into textBuf, so a naive JSON.parse of the whole
   *  buffer always fails even when the final verdict is valid. */
  private resolveStructuredOutput(visibleText: string): unknown {
    if (!this.cfg.outputSchema) return undefined;
    if (this.endStructuredOutput !== undefined) {
      const err = validateAgainstSchema(this.endStructuredOutput, this.cfg.outputSchema);
      if (!err) return this.endStructuredOutput;
      // Rare: CLI handed us something that doesn't match our schema (schema drift). Fall through to text.
      this.lastStructuredError = err;
    }
    const parsed = parseStructuredText(visibleText, this.cfg.outputSchema);
    if (parsed.value) {
      this.lastStructuredError = undefined;
      return parsed.value;
    }
    this.lastStructuredError = parsed.error ?? this.lastStructuredError;
    return undefined;
  }

  private onTurnClose(code: number | null): void {
    this.turnStarting = false;
    this.turnActive = false;
    this.child = undefined;
    this.clearWatchdog();
    this.cleanupPrompt();
    const wasInterrupt = this.interrupting;
    this.interrupting = false;
    // Emit the accumulated assistant text (and parse structured output) before resolving the result.
    const structured = this.flushText();
    if (this.pendingTerminalResult && structured !== undefined) this.pendingTerminalResult.structuredOutput = structured;
    if (this.stopped) {
      if (!this.finished) {
        this.finished = true;
        this.emitter.emit("end");
      }
      return;
    }
    // A follow-up arrived (mid-turn inject, or an inject-interrupt) — continue the Grok session in a fresh
    // resume turn rather than ending, so the steering isn't dropped.
    if (this.pendingSends.length) {
      const batch = this.pendingSends.splice(0, this.pendingSends.length);
      const next = batch.filter(Boolean).join("\n\n");
      this.lastResult = undefined; // the chained turn produces the next result()
      void this.runTurn(next, this.sessionId);
      return;
    }
    // A bare interrupt (the Pause control) with no follow-up: stay alive like a paused Claude run.
    if (wasInterrupt) return;
    // Self-heal a wedged `--resume`: if a resume turn died before its first event and a freshFallback
    // kickoff is available, retry ONCE as a fresh turn carrying the full doctrine + task. Prior edits are
    // already in the working tree, so the fresh session re-reads them and continues.
    if (this.isResumeTurn && !this.sawFirstEvent && !this.resumeHealed && this.cfg.freshFallback && !this.stopped) {
      this.resumeHealed = true;
      this.lastResult = undefined;
      this.lastErrorMsg = undefined;
      this.emit({ type: "text", text: "⚠️ Grok `--resume` produced no output (wedged session) — restarting this turn as a fresh session; working-tree changes are preserved." });
      void this.runTurn(this.cfg.freshFallback, undefined);
      return;
    }
    // Structured role (planner/QA) finished a successful turn but yielded no schema-valid object —
    // re-prompt in-session rather than handing the pipeline an empty structuredOutput (which parks as
    // "QA could not complete"). Cap retries so a stubborn model can't loop forever.
    if (this.shouldRetryStructured(structured)) {
      this.structuredRetries++;
      this.lastResult = undefined;
      this.pendingTerminalResult = undefined;
      this.emit({
        type: "text",
        text: `⚠️ Structured output missing or invalid — re-prompting for a schema-valid JSON result (attempt ${this.structuredRetries}/${MAX_STRUCTURED_RETRIES}).`,
      });
      void this.runTurn(this.structuredRetryPrompt(), this.sessionId);
      return;
    }
    // Retries exhausted (or no session to resume): a "success" without structuredOutput still can't
    // feed the pipeline — surface it as an error with the parse reason so runRole can failover/park
    // with a diagnosable message instead of a silent "QA could not complete".
    if (
      this.cfg.outputSchema &&
      structured === undefined &&
      this.pendingTerminalResult &&
      !this.pendingTerminalResult.isError
    ) {
      this.pendingTerminalResult = {
        ...this.pendingTerminalResult,
        subtype: "error",
        isError: true,
        result: `Grok finished without schema-valid structured output: ${this.lastStructuredError ?? "no JSON object matched the required schema."}`,
      };
    }
    // The process exited without a terminal event AND it wasn't an intentional interrupt — synthesize a
    // failure so a waiting result()/nextResult() resolves instead of hanging.
    if (!this.sawTerminal) {
      const msg = this.lastErrorMsg ?? `Grok CLI exited with code ${code ?? "unknown"} before finishing the turn.`;
      if (RATE_LIMIT_RE.test(msg)) this.markCapped();
      else this.markTransientApiError(msg);
      this.finishTurn({ subtype: "error", isError: true, result: msg });
    } else if (this.pendingTerminalResult) {
      this.finishTurn(this.pendingTerminalResult);
    }
    if (!this.finished) {
      this.finished = true;
      this.emitter.emit("end");
    }
  }

  private shouldRetryStructured(structured: unknown): boolean {
    if (!this.cfg.outputSchema || !this.sessionId) return false;
    if (structured !== undefined) return false;
    if (!this.pendingTerminalResult || this.pendingTerminalResult.isError) return false;
    return this.structuredRetries < MAX_STRUCTURED_RETRIES;
  }

  private structuredRetryPrompt(): string {
    const detail =
      this.lastStructuredError ??
      "No JSON object matching the required schema was found in your reply.";
    return [
      "Your previous reply could not be accepted as this role's structured result.",
      detail,
      "",
      "Respond with ONLY a single JSON object that matches the required schema — no prose before or after it,",
      "no intermediate status objects, no markdown fences if you can avoid them. Required fields must be present.",
    ].join("\n");
  }
}
