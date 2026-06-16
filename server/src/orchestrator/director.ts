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

const MAX_DIRECTOR_FAILOVERS = 2;

/**
 * The single long-lived Sonnet session the user chats with. Streaming-input mode
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
    // A path the user typed in the path field is AUTHORITATIVE — it's the exact dispatch workspace, not
    // a hint to re-resolve. Tell the director to use it verbatim and skip find_workspace entirely.
    const base = workspace
      ? `${text}\n\n[TARGET WORKSPACE — the user set this explicitly. Use this EXACT absolute path as the dispatch workspace; do NOT call find_workspace and do NOT substitute another path: ${workspace}]`
      : text;
    const content = contentWithImages(base, this.pendingImages.map(toImageBlock));
    this.pending = content;
    this.failovers = 0;

    const live = this.run && !this.run.finished;
    const accountCapped = this.accountId ? this.api.accounts.isRateLimited(this.accountId) : false;
    if (live && accountCapped) {
      // The long-lived session is stuck on a now-capped account — move it to one with
      // headroom (resume keeps the conversation) BEFORE sending, so the user never sees the
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

  private start(firstContent: UserContent, account?: Account): void {
    const director = createDirectorServer(this.api, () => this.pendingImages);
    const memory = createMemoryServer(this.api.memory);
    const cfg = directorConfig({ director, memory });
    const acct = account ?? this.api.accounts.select().account;
    this.accountId = acct.id;
    this.accountLabel = acct.label;
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
          if (!run.rateLimited) {
            this.pending = undefined;
            this.failovers = 0;
            this.pendingImages = []; // turn done — don't hold base64 between turns
            this.setBusy(false);
          }
          // a rate-limited result keeps `pending` set; onEnd fails over below
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
      if (this.run !== run) return; // a proactive switch already replaced us — don't clobber it
      // Reactive failover: the turn died on a usage cap and never produced a real answer —
      // move to another account (resume the session), re-send the message, try again.
      if (run.rateLimited && this.pending !== undefined && this.failovers < MAX_DIRECTOR_FAILOVERS) {
        const next = this.api.accounts.selectFailover(acct.id);
        if (next && this.sessionId) {
          this.failovers++;
          this.hub.log("warn", `Director hit a usage limit on ${acct.label} — switching to ${next.label}, resuming.`);
          this.start(this.pending, next);
          return;
        }
      }
      if (run.rateLimited && this.pending !== undefined) {
        // Couldn't fail over — every subscription is capped. Say so instead of going silently idle.
        const m = this.db.addDirectorMessage({
          role: "director",
          kind: "text",
          content:
            "Both Claude subscriptions are at their usage limit right now, so I couldn't get to this. They free up when the 5-hour window resets — resend then.",
        });
        this.hub.publish({ type: "director.message", message: m });
        this.hub.log("warn", "Director: all accounts rate-limited — no failover available.");
      }
      this.run = undefined;
      this.pending = undefined;
      this.pendingImages = [];
      this.setBusy(false);
    });
  }
}
