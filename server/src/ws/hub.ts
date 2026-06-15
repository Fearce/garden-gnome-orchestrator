import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { Director } from "../orchestrator/director.js";
import type { ThreadManager } from "../orchestrator/threadManager.js";
import { clientCommandSchema, type ClientCommand, type ServerEvent } from "./protocol.js";

export interface WsContext {
  db: Db;
  hub: EventHub;
  manager: ThreadManager;
  director: Director;
  accounts: AccountManager;
}

const STREAMING_EVENTS = new Set(["agent.delta", "agent.thinking", "director.delta"]);

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  // Shed high-frequency streaming deltas if the client is backed up; committed
  // text/state events still get through so the UI converges.
  if (socket.bufferedAmount > 2_000_000 && STREAMING_EVENTS.has(event.type)) return;
  socket.send(JSON.stringify(event));
}

function buildHello(ctx: WsContext): ServerEvent {
  return {
    type: "hello",
    threads: ctx.db.listThreads(),
    runs: ctx.db.listAllRuns(),
    findings: ctx.db.listFindings(),
    questions: ctx.db.listOpenQuestions(),
    director: ctx.db.listDirectorMessages(),
    accounts: ctx.accounts.dto(),
  };
}

export function registerWs(fastify: FastifyInstance, ctx: WsContext): void {
  fastify.get("/ws", { websocket: true }, (socket) => {
    send(socket, buildHello(ctx));
    const unsubscribe = ctx.hub.subscribe((event) => send(socket, event));

    socket.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const result = clientCommandSchema.safeParse(parsed);
      if (!result.success) {
        ctx.hub.log("warn", `Ignored malformed command: ${result.error.message}`);
        return;
      }
      void handleCommand(ctx, socket, result.data);
    });

    socket.on("close", () => unsubscribe());
    socket.on("error", () => unsubscribe());
  });
}

async function handleCommand(ctx: WsContext, socket: WebSocket, cmd: ClientCommand): Promise<void> {
  switch (cmd.type) {
    case "prompt.new":
      ctx.director.handleUserMessage(cmd.text, cmd.workspace, cmd.images);
      break;
    case "question.answer":
      ctx.manager.resolveQuestion(cmd.questionId, cmd.answer);
      break;
    case "thread.inject":
      await ctx.manager.injectThread(cmd.threadId, cmd.message, cmd.mode, cmd.images);
      break;
    case "thread.interrupt":
      await ctx.manager.interruptThread(cmd.threadId);
      break;
    case "thread.resume":
      await ctx.manager.resumeThread(cmd.threadId, cmd.message);
      break;
    case "thread.cancel":
      await ctx.manager.cancelThread(cmd.threadId);
      break;
    case "thread.history": {
      const thread = ctx.db.getThread(cmd.threadId);
      send(socket, {
        type: "thread.history",
        threadId: cmd.threadId,
        messages: ctx.db.listMessages(cmd.threadId),
        findings: ctx.db.listFindings(cmd.threadId),
        brief: thread?.brief ?? "",
      });
      break;
    }
    case "snapshot.request":
      send(socket, buildHello(ctx));
      break;
    default:
      break;
  }
}
