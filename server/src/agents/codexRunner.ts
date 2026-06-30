import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { AgentEvent, RateLimitInfo } from "../types.js";
import type { AgentRunLike, ResultEvent, SendOpts, UserContent } from "./runner.js";

export interface CodexRunConfig {
  /** The Codex model to run, e.g. `codex-mini-latest`. */
  model: string;
  cwd: string;
  /** The OpenAI API key — injected as OPENAI_API_KEY into the isolated CODEX_HOME so it, not any
   *  personal ChatGPT login in the user's ~/.codex, drives auth. */
  apiKey: string;
  /** A prior Codex thread id to `codex exec resume` instead of starting fresh. */
  resume?: string;
  /** Full fresh-start kickoff (doctrine + task) used to self-heal a wedged `exec resume`: if a resume
   *  turn produces ZERO events (the CLI can hang at 0% CPU replaying an interrupted gpt-5 session), the
   *  runner retries ONCE as a fresh `exec` with this prompt — the prior apply_patch edits already live
   *  in the working tree, so the fresh session re-reads them and continues. Omit to disable self-heal. */
  freshFallback?: string;
}

/** Pull the plain text out of a UserContent (string or content-block array). The Codex CLI takes a
 *  single text prompt on argv, so pasted-image blocks (Claude-only) are dropped — Codex implementors
 *  run text-only, a documented degradation vs. the Claude backend. */
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

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  query?: string;
  message?: string;
  server?: string;
  tool?: string;
  items?: unknown;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string };
  usage?: Record<string, number>;
  message?: string;
}

const RATE_LIMIT_RE = /(rate.?limit|429|too many requests|quota (?:exceeded|reached)|insufficient_quota)/i;

export interface CodexTestResult {
  ok: boolean;
  message: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: unknown;
  OPENAI_API_KEY?: string;
}

function readAuthJson(file: string): CodexAuthFile | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CodexAuthFile;
  } catch {
    return undefined;
  }
}

/** The operator's personal `codex login` auth.json IF it's a usable ChatGPT-subscription login
 *  (auth_mode "chatgpt" with tokens) — the preferred Codex auth, which bills against the ChatGPT plan
 *  and needs no usage-based API key. Returns the file path to seed the isolated CODEX_HOME from, or
 *  undefined when there's no ChatGPT login to use (an API-key login or no login at all). */
export function chatgptLoginSource(): string | undefined {
  const src = join(config.codex.sourceAuthHome, "auth.json");
  const a = readAuthJson(src);
  return a?.auth_mode === "chatgpt" && a?.tokens ? src : undefined;
}

/** A usable login already inside the isolated CODEX_HOME — either one the orchestrator seeded earlier
 *  (and the CLI has since been refreshing in place) or one the operator wrote by running `codex login`
 *  directly against CODEX_HOME. Keeps Codex working even if the operator's ~/.codex source later vanishes. */
function isolatedAuthMode(): "chatgpt" | "apikey" | undefined {
  const a = readAuthJson(join(config.codex.home, "auth.json"));
  if (!a) return undefined;
  if (a.auth_mode === "chatgpt" && a.tokens) return "chatgpt";
  if (a.OPENAI_API_KEY) return "apikey";
  return undefined;
}

/** Whether Codex is authenticated via a ChatGPT plan (operator source OR an already-seeded isolated
 *  home). Surfaced to the UI so the operator sees "no API key needed". */
export function chatgptLoginAvailable(): boolean {
  return !!chatgptLoginSource() || isolatedAuthMode() === "chatgpt";
}

/** Whether the Codex backend has ANY usable auth right now — a ChatGPT login (source or seeded isolated)
 *  or a configured API key. The dispatch gate uses this to decide whether Codex can implement. */
export function codexAuthAvailable(hasApiKey: boolean): boolean {
  return chatgptLoginAvailable() || !!isolatedAuthMode() || hasApiKey;
}

/**
 * Validate an OpenAI API key cheaply by listing models — far faster than a `codex exec` probe, whose
 * 401 path retries ~10× before giving up. Returns a friendly verdict for the "Test connection" button.
 */
export async function testOpenAiKey(key: string | undefined): Promise<CodexTestResult> {
  const trimmed = key?.trim();
  if (!trimmed) return { ok: false, message: "No API key set — enter one and save first." };
  if (!/^sk-/.test(trimmed)) return { ok: false, message: "Key doesn't look like an OpenAI key (should start with sk-)." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${trimmed}` },
      signal: controller.signal,
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
      const count = Array.isArray(body?.data) ? body!.data!.length : 0;
      return { ok: true, message: `Connected — key is valid${count ? ` (${count} models available)` : ""}.` };
    }
    if (res.status === 401) return { ok: false, message: "Invalid API key (401 Unauthorized)." };
    if (res.status === 429) return { ok: false, message: "Key is valid but rate-limited / out of quota (429)." };
    return { ok: false, message: `OpenAI returned HTTP ${res.status}.` };
  } catch (err) {
    const e = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Couldn't reach the OpenAI API: ${e}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One running OpenAI Codex implementor. Mirrors AgentRun's public surface (AgentRunLike) so the
 * thread manager drives it identically, but the engine is the `codex exec` CLI rather than the
 * Claude Agent SDK. The CLI is batch-oriented: each `codex exec [resume <id>]` invocation runs ONE
 * turn to completion and exits, so multi-turn continuity (QA fix-rounds, manual resume) is achieved
 * by resuming the captured Codex thread id in a fresh invocation — exactly the resume path the
 * orchestrator already uses for Claude. A follow-up `send()` that arrives while a turn is live is
 * buffered and replayed as a resume turn once the current one ends (unless the run was stopped).
 */
export class CodexAgentRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined;
  finished = false;
  lastResult: ResultEvent | undefined;
  // Codex auth is a single API key with no multi-account headroom signal, so we never flag a cap:
  // a 429 settles the task to review instead of mis-firing the Claude-account failover path.
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;

  private child: ChildProcess | undefined;
  private turnActive = false;
  private stopped = false;
  // Set by interrupt() so onTurnClose treats the killed turn as an intentional pause (no synthetic
  // failure result) rather than a crash — the inject-interrupt path then chains the buffered steering.
  private interrupting = false;
  private stdoutBuf = "";
  private lastErrorMsg: string | undefined;
  private sawTerminal = false; // turn.completed / turn.failed seen for the current turn
  private readonly pendingSends: string[] = [];
  // No-output watchdog: a wedged `codex exec [resume]` hangs at 0% CPU emitting nothing and never
  // exits, so onTurnClose never fires and the task hangs forever. armWatchdog() (re)arms a deadline
  // on spawn and on every parsed event; firing it kills the child so onTurnClose synthesizes a failure
  // (or self-heals a wedged resume). sawFirstEvent switches the deadline from the tight startup bound
  // to the generous mid-stream bound; isResumeTurn + resumeHealed gate the one-shot fresh-start retry.
  private turnWatchdog: NodeJS.Timeout | undefined;
  private sawFirstEvent = false;
  private isResumeTurn = false;
  // True once a wedged `exec resume` self-healed to a fresh start. Read by the thread manager after the
  // run ends so it can stop attempting resume for this thread (resume keeps wedging → skip the 60s
  // watchdog + self-heal spam every turn and go straight to fresh).
  resumeHealed = false;

  constructor(private readonly cfg: CodexRunConfig) {
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

  /** Queue a follow-up. The CLI can't accept mid-turn input, so a send during a live turn is buffered
   *  and delivered as a resume turn when this one ends; a send after the turn ended starts one now. */
  send(content: UserContent, _opts?: SendOpts): void {
    if (this.stopped) return;
    const text = toText(content);
    if (!text.trim()) return;
    if (this.turnActive) {
      this.pendingSends.push(text);
      return;
    }
    void this.runTurn(text, this.sessionId);
  }

  async interrupt(): Promise<void> {
    // No mid-turn steering for a batch CLI — the closest analogue is killing the in-flight turn. Flag
    // it so onTurnClose doesn't surface a spurious failure: a follow-up send() (the inject-interrupt
    // path) is replayed as a resume turn; a bare interrupt (the Pause control) leaves the run alive,
    // mirroring Claude, until a later send() resumes it or stop() tears it down.
    this.interrupting = true;
    this.killChild();
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

  /** Seed the `auth.json` the Codex CLI authenticates from into the isolated CODEX_HOME and return the
   *  resolved auth mode — the single source of truth runTurn drives the env off, so the file and the env
   *  can never disagree. PREFERS the operator's ChatGPT-plan login (no API billing needed): copy
   *  ~/.codex/auth.json in, but only when it's newer (or the dest is missing) — so a fresh re-login
   *  propagates while a token codex refreshed in-place isn't clobbered by a staler source. Falls back to
   *  writing an apikey auth.json from the configured key, else keeps whatever login the home already holds. */
  private async writeAuth(): Promise<"chatgpt" | "apikey" | "none"> {
    const dest = join(config.codex.home, "auth.json");
    const chatgpt = chatgptLoginSource();
    if (chatgpt) {
      if (!existsSync(dest) || statSync(chatgpt).mtimeMs > statSync(dest).mtimeMs) await copyFile(chatgpt, dest);
      return "chatgpt";
    }
    // No operator source. A configured API key always (re)writes the apikey auth.json — so a key
    // rotated in the UI takes effect immediately, overriding any stale key already in the home.
    const key = this.cfg.apiKey?.trim();
    if (key) {
      await writeFile(dest, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }), "utf8");
      return "apikey";
    }
    // No source and no key: keep whatever usable login the home already holds (a direct `codex login`
    // against CODEX_HOME, or a previously-seeded ChatGPT token the CLI keeps refreshing).
    return isolatedAuthMode() ?? "none";
  }

  /** Spawn one `codex exec` (or `codex exec resume <id>`) turn and stream its JSONL events. */
  private async runTurn(prompt: string, resumeId?: string): Promise<void> {
    if (this.stopped) return;
    if (!existsSync(config.codex.binJs)) {
      this.finishTurn({ subtype: "error", isError: true, result: `Codex CLI not found at ${config.codex.binJs}. Install it with \`npm i -g @openai/codex\` or set CODEX_BIN_JS.` });
      return;
    }
    // Auth: the modern Codex CLI (>=0.14x) does NOT read OPENAI_API_KEY from the env for its
    // /v1/responses transport — it authenticates only from `<CODEX_HOME>/auth.json`. Without it every
    // turn 401s instantly ("Missing bearer …") and the implementor looks skipped. So writeAuth seeds
    // that file into the dedicated CODEX_HOME (isolated from the operator's personal ~/.codex), PREFERRING
    // a ChatGPT-plan login and falling back to the API key, and returns the resolved mode. CODEX_HOME
    // must exist before spawn or codex errors + exits 1.
    await mkdir(config.codex.home, { recursive: true }).catch(() => {});
    const authMode = await this.writeAuth().catch(() => "none" as const);
    const args = ["exec"];
    if (resumeId) args.push("resume", resumeId);
    args.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox");
    // `--color` and `-C/--cd` are global flags on the fresh `codex exec` subcommand but are NOT
    // accepted by `codex exec resume` (the CLI rejects them with "unexpected argument '--color'",
    // killing every resume turn in ~2s and stranding the task on its first fresh turn). The spawn()
    // below already sets the child's cwd, so omitting `-C` on resume is harmless; `--json` keeps the
    // output as clean JSONL regardless of the color flag.
    if (!resumeId) args.push("--color", "never", "-C", this.cfg.cwd);
    args.push(
      "-m",
      this.cfg.model,
      // The prompt goes via STDIN ("-"), not argv: a real implementor kickoff (doctrine + plan +
      // research) is tens of KB and passing it as a command-line arg overflows the OS limit (Windows
      // ~32KB), which made the spawn die in ~150ms with "Argument list too long" — the turn looked
      // instantly skipped. codex reads instructions from stdin when the prompt arg is `-`.
      "-",
    );
    this.sawTerminal = false;
    this.sawFirstEvent = false;
    this.isResumeTurn = !!resumeId;
    this.lastErrorMsg = undefined;
    this.stdoutBuf = "";
    this.turnActive = true;
    // CODEX_HOME points the CLI at the isolated home whose auth.json writeAuth just seeded. Carry
    // OPENAI_API_KEY ONLY in apikey mode — under a ChatGPT login an inherited key could nudge the CLI
    // toward the API path it documents as incompatible with a ChatGPT account, so strip it. Driving this
    // off writeAuth's returned mode (not a re-read) keeps the env and the auth.json from ever diverging.
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: config.codex.home };
    const key = this.cfg.apiKey?.trim();
    if (authMode === "apikey" && key) env.OPENAI_API_KEY = key;
    else delete env.OPENAI_API_KEY;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [config.codex.binJs, ...args], { cwd: this.cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.turnActive = false;
      this.finishTurn({ subtype: "error", isError: true, result: `Failed to spawn Codex CLI: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // Feed the prompt over stdin (the `-` arg above) and close it so codex starts the turn. Guard the
    // write — if the child died instantly, writing to a closed pipe would throw an unhandled EPIPE.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(prompt);
    } catch {
      /* child already gone; onTurnClose will synthesize the failure */
    }
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    // Codex emits transport retry noise + structured errors on stderr; keep the latest substantive line
    // as a fallback failure reason if the turn dies without a turn.failed event.
    child.stderr?.on("data", (chunk: string) => {
      const line = String(chunk).trim();
      if (line && !/^\d{4}-\d\d-\d\dT/.test(line)) this.lastErrorMsg = line.slice(0, 500);
    });
    child.on("error", (err) => {
      this.lastErrorMsg = err.message;
    });
    child.on("close", (code) => this.onTurnClose(code));
    this.armWatchdog();
  }

  /** (Re)arm the no-output watchdog for the live turn. Called on spawn and after every parsed event —
   *  each event pushes the deadline out, so it only fires during genuine silence. The deadline is the
   *  tight startup bound until the first event lands, then the generous mid-stream bound. */
  private armWatchdog(): void {
    this.clearWatchdog();
    if (!this.turnActive) return;
    const ms = this.sawFirstEvent ? config.codex.inactivityMs : config.codex.firstEventMs;
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

  /** The live turn produced no output within its deadline — it's wedged. Record a reason and kill the
   *  child; onTurnClose then synthesizes the failure (or self-heals a wedged resume via freshFallback). */
  private onWatchdogTimeout(ms: number): void {
    if (!this.turnActive) return;
    const secs = Math.round(ms / 1000);
    this.lastErrorMsg = this.sawFirstEvent
      ? `Codex emitted no output for ${secs}s — the turn appears wedged; killed by the inactivity watchdog.`
      : `Codex produced no events within ${secs}s of starting — a wedged \`exec resume\` (the CLI hangs at 0% CPU replaying an interrupted session); killed by the startup watchdog.`;
    this.killChild();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
      } catch {
        continue; // not a JSON event line (stray log) — ignore
      }
      this.sawFirstEvent = true;
      this.armWatchdog(); // each event pushes the no-output deadline out
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: CodexEvent): void {
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id) {
          this.sessionId = ev.thread_id;
          this.emit({ type: "init", sessionId: ev.thread_id });
        }
        break;
      case "turn.completed":
        this.sawTerminal = true;
        this.finishTurn({ subtype: "success", isError: false, numTurns: 1 });
        break;
      case "turn.failed": {
        this.sawTerminal = true;
        const msg = ev.error?.message ?? this.lastErrorMsg ?? "Codex turn failed.";
        if (RATE_LIMIT_RE.test(msg)) this.rateLimitInfo = { status: "rejected" };
        this.finishTurn({ subtype: "error", isError: true, result: msg });
        break;
      }
      case "error":
        // Transient transport errors ("Reconnecting…") — not fatal on their own; remember the text so a
        // turn that dies without turn.failed still surfaces a reason.
        if (ev.message) this.lastErrorMsg = ev.message.slice(0, 500);
        break;
      case "item.started":
        this.handleItem(ev.item, "started");
        break;
      case "item.completed":
        this.handleItem(ev.item, "completed");
        break;
      default:
        break;
    }
  }

  private handleItem(item: CodexItem | undefined, phase: "started" | "completed"): void {
    if (!item) return;
    const id = item.id ?? "item";
    switch (item.type) {
      case "agent_message":
        if (phase === "completed" && item.text) this.emit({ type: "text", text: item.text });
        break;
      case "reasoning":
        if (phase === "completed" && item.text) this.emit({ type: "thinking_delta", text: item.text });
        break;
      case "command_execution":
        if (phase === "started") this.emit({ type: "tool_use", id, name: "shell", input: { command: item.command } });
        else this.emit({ type: "tool_result", id, content: item.aggregated_output ?? "", isError: (item.exit_code ?? 0) !== 0 });
        break;
      case "file_change":
        if (phase === "completed") this.emit({ type: "tool_use", id, name: "apply_patch", input: { changes: item.changes ?? [] } });
        break;
      case "web_search":
        if (phase === "completed") this.emit({ type: "tool_use", id, name: "web_search", input: { query: item.query } });
        break;
      case "mcp_tool_call":
        if (phase === "started") this.emit({ type: "tool_use", id, name: [item.server, item.tool].filter(Boolean).join(".") || "mcp_tool", input: item });
        else this.emit({ type: "tool_result", id, content: item.aggregated_output ?? item.status ?? "", isError: item.status === "failed" });
        break;
      case "todo_list":
        if (phase === "completed") this.emit({ type: "tool_use", id, name: "todo", input: { items: item.items } });
        break;
      // `error` items are warnings (e.g. fallback model metadata) — the turn's real outcome is
      // turn.completed / turn.failed, so they're not surfaced as fatal error events here.
      default:
        break;
    }
  }

  /** Emit the per-turn result event (mirrors AgentRun's `result` SDK message) and cache it. */
  private finishTurn(partial: { subtype: string; isError: boolean; result?: string; numTurns?: number }): void {
    this.clearWatchdog();
    const evt: ResultEvent = { type: "result", subtype: partial.subtype, isError: partial.isError, result: partial.result, numTurns: partial.numTurns };
    this.lastResult = evt;
    this.emit(evt);
  }

  private onTurnClose(code: number | null): void {
    this.turnActive = false;
    this.child = undefined;
    this.clearWatchdog();
    const wasInterrupt = this.interrupting;
    this.interrupting = false;
    if (this.stopped) {
      if (!this.finished) {
        this.finished = true;
        this.emitter.emit("end");
      }
      return;
    }
    // A follow-up arrived (mid-turn inject, or an inject-interrupt) — continue the Codex session in a
    // fresh resume turn rather than ending, so the steering isn't dropped. If the turn died before a
    // session id was captured, start fresh (no resume) so the steering still lands.
    if (this.pendingSends.length) {
      const next = this.pendingSends.splice(0, this.pendingSends.length).join("\n\n");
      this.lastResult = undefined; // the chained turn produces the next result()
      void this.runTurn(next, this.sessionId);
      return;
    }
    // A bare interrupt (the Pause control) with no follow-up: stay alive like a paused Claude run —
    // don't synthesize a failure or end. A later send() resumes the session; stop() tears it down.
    if (wasInterrupt) return;
    // Self-heal a wedged `exec resume`: the CLI can hang at 0% CPU (then get watchdog-killed) or exit
    // instantly replaying an interrupted gpt-5 session, producing ZERO events. If a resume turn died
    // before its first event and a freshFallback kickoff is available, retry ONCE as a fresh `exec`
    // (no resume) carrying the full doctrine + task. Prior apply_patch edits already live in the working
    // tree, so the fresh session re-reads them and continues — far better than stranding the task.
    if (this.isResumeTurn && !this.sawFirstEvent && !this.resumeHealed && this.cfg.freshFallback && !this.stopped) {
      this.resumeHealed = true;
      this.lastResult = undefined;
      this.lastErrorMsg = undefined;
      this.emit({ type: "text", text: "⚠️ Codex `exec resume` produced no output (wedged session) — restarting this turn as a fresh session; working-tree changes are preserved." });
      void this.runTurn(this.cfg.freshFallback, undefined);
      return;
    }
    // The process exited without a terminal turn event AND it wasn't an intentional interrupt —
    // synthesize a failure so a waiting result()/nextResult() resolves instead of hanging.
    if (!this.sawTerminal) {
      const msg = this.lastErrorMsg ?? `Codex CLI exited with code ${code ?? "unknown"} before finishing the turn.`;
      this.finishTurn({ subtype: "error", isError: true, result: msg });
    }
    if (!this.finished) {
      this.finished = true;
      this.emitter.emit("end");
    }
  }
}
