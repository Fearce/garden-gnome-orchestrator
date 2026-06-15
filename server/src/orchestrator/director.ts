import { AgentRun } from "../agents/runner.js";
import { directorConfig } from "../agents/roles.js";
import { createDirectorServer } from "../bus/directorServer.js";
import { createMemoryServer } from "../bus/memoryServer.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { AgentEvent } from "../types.js";
import type { ThreadManager } from "./threadManager.js";

/**
 * The single long-lived Sonnet session the user chats with. Streaming-input mode
 * keeps the conversation alive across many messages; if the process ever ends
 * we restart and resume from the captured session id so context is preserved.
 */
export class Director {
  private run: AgentRun | undefined;
  private sessionId: string | undefined;
  private accountId: string | undefined;
  private busy = false;

  constructor(
    private readonly api: ThreadManager,
    private readonly db: Db,
    private readonly hub: EventHub,
  ) {}

  handleUserMessage(text: string, workspaceHint?: string): void {
    const content = workspaceHint ? `${text}\n\n(the user's current repo context: ${workspaceHint})` : text;
    const msg = this.db.addDirectorMessage({ role: "user", kind: "text", content: text });
    this.hub.publish({ type: "director.message", message: msg });
    if (!this.run || this.run.finished) this.start(content);
    else this.run.send(content);
    this.setBusy(true);
  }

  private start(firstText: string): void {
    const director = createDirectorServer(this.api);
    const memory = createMemoryServer(this.api.memory);
    const cfg = directorConfig({ director, memory });
    const { account } = this.api.accounts.select();
    this.accountId = account.id;
    cfg.oauthToken = account.token || undefined;
    if (this.sessionId) cfg.resume = this.sessionId;
    const run = new AgentRun(cfg);
    this.run = run;
    this.wire(run);
    run.start(firstText);
  }

  private setBusy(b: boolean): void {
    if (this.busy === b) return;
    this.busy = b;
    this.hub.publish({ type: "director.busy", busy: b });
  }

  private wire(run: AgentRun): void {
    run.onEvent((e: AgentEvent) => {
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
          this.setBusy(false);
          break;
        case "rate_limit":
          if (this.accountId) this.api.accounts.updateFromRateLimit(this.accountId, e.info);
          break;
        case "error":
          this.hub.log("error", `Director: ${e.message}`);
          this.setBusy(false);
          break;
        default:
          break;
      }
    });
    run.onEnd(() => {
      this.setBusy(false);
      this.run = undefined;
    });
  }
}
