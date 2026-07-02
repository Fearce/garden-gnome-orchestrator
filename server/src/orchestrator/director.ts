import { AgentRun, type UserContent } from "../agents/runner.js";
import { directorConfig } from "../agents/roles.js";
import { createDirectorServer } from "../bus/directorServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import { contentWithImages, toImageBlock } from "../attachments.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { AgentEvent, ImageAttachment } from "../types.js";
import type { ThreadManager } from "./threadManager.js";
import type { Account } from "../accounts/account.js";
import { untilReset } from "../accounts/accountManager.js";
import { config } from "../config.js";
import { existsSync } from "node:fs";

const MAX_DIRECTOR_FAILOVERS = 2;

/**
 * The single long-lived Sonnet session the owner chats with. Streaming-input mode
 * keeps the conversation alive across many messages; if the process ever ends
 * we restart and resume from the captured session id so context is preserved.
 */
export class Director {
  private run: AgentRun | undefined;
  private sessionId: string | undefined;
  private accountId: string | undefined;
  private accountLabel: string | undefined;
  private busy = false;
  /** Images from the current user turn — carried past the text-only dispatch tool to the pipeline. */
  private pendingImages: ImageAttachment[] = [];
  /** The in-flight turn's content — kept so a usage-cap failover can re-send it. */
  private pending: UserContent | undefined;
  private failovers = 0;

  constructor(
    private readonly api: ThreadManager,
    private readonly db: Db,
    private readonly hub: EventHub,
  ) {}

  handleUserMessage(text: string, workspace?: string, images?: ImageAttachment[]): void {
    const refs = (images ?? []).map((img) =>
      this.db.addAttachment({ name: img.name, mediaType: img.mediaType, data: img.dataBase64 }),
    );
    const msg = this.db.addDirectorMessage({ role: "user", kind: "text", content: text, attachments: refs });
    this.hub.publish({ type: "director.message", message: msg });

    this.pendingImages = images ?? [];
    // A path the owner typed in the path field is AUTHORITATIVE — it's the exact dispatch workspace, not
    // a hint to re-resolve. Tell the director to use it verbatim and skip find_workspace entirely.
    const base = workspace
      ? `${text}\n\n[TARGET WORKSPACE — ${config.ownerName} set this explicitly. Use this EXACT absolute path as the dispatch workspace; do NOT call find_workspace and do NOT substitute another path: ${workspace}]`
      : text;
    const content = contentWithImages(base, this.pendingImages.map(toImageBlock));
    this.pending = content;
    this.failovers = 0;

    const live = this.run && !this.run.finished;
    const accountCapped = this.accountId ? this.api.accounts.isRateLimited(this.accountId) : false;
    if (live && accountCapped) {
      // The long-lived session is stuck on a now-capped account — move it to one with
      // headroom (resume keeps the conversation) BEFORE sending, so the owner never sees the
      // SDK's "session limit" message while the other subscription is wide open.
      const next = this.api.accounts.selectFailover(this.accountId!);
      this.hub.log("info", `Director's ${this.accountLabel ?? this.accountId} is at its limit — switching to ${next?.label ?? "the other account"}.`);
      void this.run!.stop();
      this.start(content, next ?? undefined);
    } else if (live) {
      this.run!.send(content);
    } else {
      this.start(content); // a fresh run's select() already skips capped accounts
    }
    this.setBusy(true);
  }

  /**
   * Skip-director mode: dispatch the owner's message straight into the pipeline without the Sonnet
   * director enriching/clarifying. The message becomes the brief verbatim and enters the pipeline at
   * its first active stage (planner if enabled, else the implementor — runPipeline routes by settings,
   * so this is never hardcoded to one agent). A workspace is required: there's no director to resolve
   * one. The user message + a confirmation are echoed into the director chat so the transcript shows
   * what was sent; the long-lived Sonnet session is left completely untouched.
   */
  async dispatchDirect(text: string, workspace?: string, images?: ImageAttachment[]): Promise<void> {
    const refs = (images ?? []).map((img) =>
      this.db.addAttachment({ name: img.name, mediaType: img.mediaType, data: img.dataBase64 }),
    );
    const userMsg = this.db.addDirectorMessage({ role: "user", kind: "text", content: text, attachments: refs });
    this.hub.publish({ type: "director.message", message: userMsg });

    const ws = workspace?.trim();
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
    const id = await this.api.dispatch({ title, workspace: ws, brief: text, images });
    this.postDirectorNote(`Skipped the director — dispatched "${title}" straight to the pipeline (task ${id.slice(0, 8)}).`);
  }

  private postDirectorNote(content: string): void {
    const m = this.db.addDirectorMessage({ role: "director", kind: "text", content });
    this.hub.publish({ type: "director.message", message: m });
  }

  private start(firstContent: UserContent, account?: Account): void {
    const director = createDirectorServer(this.api, () => this.pendingImages);
    const memory = createMemoryServer(this.api.memory);
    const cfg = directorConfig({ director, memory }, this.api.directorName());
    const acct = account ?? this.api.accounts.select().account;
    this.accountId = acct.id;
    this.accountLabel = acct.label;
    cfg.model = this.api.modelFor(acct.id, "director");
    cfg.oauthToken = acct.token || undefined;
    if (this.sessionId) cfg.resume = this.sessionId;
    const run = new AgentRun(cfg);
    this.run = run;
    this.wire(run, acct);
    run.start(firstContent);
  }

  private setBusy(b: boolean): void {
    if (this.busy === b) return;
    this.busy = b;
    this.hub.publish({ type: "director.busy", busy: b });
  }

  private wire(run: AgentRun, acct: Account): void {
    // `acct` is captured per-run: once a failover reassigns `this.account*`, a trailing
    // event from THIS (now-dead) run must still be charged to the account it ran on.
    const off = run.onEvent((e: AgentEvent) => {
      if (this.run !== run) return; // superseded by a failover switch — don't touch the new run's state
      switch (e.type) {
        case "init":
          this.sessionId = e.sessionId;
          break;
        case "text_delta":
          this.hub.publish({ type: "director.delta", text: e.text });
          break;
        case "text": {
          const m = this.db.addDirectorMessage({ role: "director", kind: "text", content: e.text });
          this.hub.publish({ type: "director.message", message: m });
          break;
        }
        case "tool_use":
          this.hub.publish({ type: "director.tool", name: e.name, input: e.input });
          break;
        case "result":
          if (run.rateLimited) {
            // The long-lived streaming session doesn't END on a capped turn — it just finishes the
            // turn with a result and waits for more input — so onEnd never fires to fail us over.
            // Drive the switch from here: move to a sub with headroom, resume, re-send the turn.
            this.reactiveFailover(run, acct);
          } else {
            this.pending = undefined;
            this.failovers = 0;
            this.pendingImages = []; // turn done — don't hold base64 between turns
            this.setBusy(false);
          }
          break;
        case "rate_limit":
          this.api.accounts.updateFromRateLimit(acct.id, e.info);
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
      // onEnd only fires when the run truly ENDS — a thrown error / process death. The normal capped
      // turn is handled in the `result` handler above; this catches a run the cap (or a crash) killed
      // outright. reactiveFailover fails over on a cap, otherwise just settles the abandoned turn.
      this.reactiveFailover(run, acct);
      if (this.run === run) this.run = undefined; // not switched away — this run is dead, drop it
    });
  }

  /**
   * The turn ran out of usable allowance on `acct` and produced no real answer. Move to a sub with
   * headroom (resume the session so context survives) and re-send the same message; if no sub has
   * headroom, tell the owner when the soonest one frees up instead of going silently idle. Safe to
   * call from both the `result` handler (live streaming turn) and onEnd (run died) — the
   * `this.run !== run` guards in wire() neutralize the superseded run's trailing events.
   */
  private reactiveFailover(run: AgentRun, acct: Account): void {
    if (run.rateLimited && this.pending !== undefined && this.failovers < MAX_DIRECTOR_FAILOVERS) {
      const next = this.api.accounts.selectFailover(acct.id);
      if (next && this.sessionId) {
        this.failovers++;
        this.hub.log("warn", `Director hit a usage limit on ${acct.label} — switching to ${next.label}, resuming.`);
        void run.stop(); // tear down the capped run; if it already ended this is a no-op
        this.start(this.pending, next); // keeps busy + pending set; the switch carries the turn
        return;
      }
    }
    if (run.rateLimited && this.pending !== undefined) {
      // Couldn't fail over — every subscription is capped. Say so instead of going silently idle.
      const m = this.db.addDirectorMessage({ role: "director", kind: "text", content: this.allCappedMessage() });
      this.hub.publish({ type: "director.message", message: m });
      this.hub.log("warn", "Director: all accounts rate-limited — no failover available.");
    }
    // Failover wasn't possible (or the turn simply ended) — settle it.
    this.pending = undefined;
    this.failovers = 0;
    this.pendingImages = [];
    this.setBusy(false);
  }

  /** Message for when every sub is capped — phrased for the ACTUAL number of configured subscriptions
   *  (1, 2, or more; never a hardcoded "Both"), naming when the soonest one frees up if we know it. */
  private allCappedMessage(): string {
    const resetAt = this.api.accounts.soonestResetAt();
    const when = resetAt != null ? untilReset(resetAt, Date.now()) : null;
    const n = this.api.accounts.count();
    const single = n <= 1;
    const subject = single
      ? "Your Claude subscription is at its usage limit"
      : n === 2
        ? "Both Claude subscriptions are at their usage limit"
        : `All ${n} Claude subscriptions are at their usage limit`;
    const freesWhen = single ? "It frees up" : "The first one frees up";
    const freesGeneric = single ? "It frees up when the 5-hour window resets" : "They free up when the 5-hour window resets";
    return when
      ? `${subject} right now, so I couldn't get to this. ${freesWhen} ${when} — resend then.`
      : `${subject} right now, so I couldn't get to this. ${freesGeneric} — resend then.`;
  }
}

/** A board-lane title from a raw skip-director message: first non-empty line, trimmed to a short label. */
function directTitle(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean) ?? text.trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57).trimEnd() + "…" : firstLine || "Direct task";
}
