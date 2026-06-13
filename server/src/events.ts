import { EventEmitter } from "node:events";
import type { ServerEvent } from "./ws/protocol.js";

/**
 * The spine that decouples producers (thread manager, agent runs, MCP tools)
 * from consumers (the WebSocket hub). Everything publishes ServerEvents here;
 * the WS layer forwards them to connected browsers.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(cb: (event: ServerEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  log(level: "info" | "warn" | "error", message: string): void {
    this.publish({ type: "log", level, message });
    const tag = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${message}`);
  }
}
