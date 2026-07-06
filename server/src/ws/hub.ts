import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { Director } from "../orchestrator/director.js";
import type { ThreadManager } from "../orchestrator/threadManager.js";
import { readCodexUsage } from "../agents/codexUsage.js";
import { clientCommandSchema, type ClientCommand, type ServerEvent } from "./protocol.js";
import { isAuthed } from "../auth.js";
import { CHAT_PAGE_SIZE } from "../types.js";

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

// Bound the connect/snapshot frame so it can't grow without limit as months of history pile up.
// Generous caps (newest-first): invisible for any realistic current state, but a hard ceiling on the
// per-reconnect cost. Per-thread history is fetched lazily via thread.history, so this only trims the
// long tail of cross-thread runs/findings and old director chat.
const SNAPSHOT_RUNS = 2000;
const SNAPSHOT_FINDINGS = 1000;
const SNAPSHOT_DIRECTOR_MSGS = 600;
const SNAPSHOT_CHAT = 500;

function buildHello(ctx: WsContext): ServerEvent {
  return {
    type: "hello",
    threads: ctx.db.listThreads(),
    runs: ctx.db.listAllRuns(SNAPSHOT_RUNS),
    findings: ctx.db.listFindings(undefined, SNAPSHOT_FINDINGS),
    questions: ctx.db.listOpenQuestions(),
    director: ctx.db.listDirectorMessages(SNAPSHOT_DIRECTOR_MSGS),
    accounts: ctx.accounts.dto(),
    codexUsage: readCodexUsage(),
    approvalMode: ctx.manager.approvalMode(),
    settings: ctx.manager.settings(),
    // The office: a recent slice of chat for the live feed, plus the project-room roll-up (full
    // history is cheap and bounded) that drives which tasks show a "Chatroom" button.
    chat: ctx.db.listRecentChat(SNAPSHOT_CHAT),
    chatRooms: ctx.db.listProjectRooms(),
    nameOverrides: ctx.manager.officeNameOverrides(),
  };
}

export function registerWs(fastify: FastifyInstance, ctx: WsContext): void {
  fastify.get("/ws", { websocket: true }, (socket, request) => {
    if (!isAuthed(request.headers.cookie)) {
      try {
        socket.close(4401, "unauthorized");
      } catch {
        /* already closed */
      }
      return;
    }
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
    case "prompt.direct":
      await ctx.director.dispatchDirect(cmd.text, cmd.workspace, cmd.images);
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
    case "thread.retry":
      await ctx.manager.retryThread(cmd.threadId);
      break;
    case "thread.rename":
      ctx.manager.renameThread(cmd.threadId, cmd.title);
      break;
    case "thread.markDone":
      await ctx.manager.markDone(cmd.threadId);
      break;
    case "thread.close":
      await ctx.manager.closeThread(cmd.threadId);
      break;
    case "thread.restore":
      ctx.manager.restoreThread(cmd.threadId);
      break;
    case "thread.dismiss":
      ctx.manager.dismissThread(cmd.threadId);
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
    case "thread.approve":
      ctx.manager.approvePlan(cmd.threadId, cmd.approved, cmd.feedback);
      break;
    case "approval.set":
      ctx.manager.setApprovalMode(cmd.on);
      break;
    case "settings.set":
      ctx.manager.setSettings(cmd.settings);
      break;
    case "codex.test": {
      const result = await ctx.manager.testCodexConnection(cmd.apiKey);
      send(socket, { type: "codex.test.result", ok: result.ok, message: result.message });
      break;
    }
    case "account.set":
      ctx.manager.setAccountEnabled(cmd.id, cmd.enabled);
      break;
    case "thread.changes": {
      const changes = await ctx.manager.getChanges(cmd.threadId);
      send(socket, { type: "thread.changes", threadId: cmd.threadId, diff: changes.diff, log: changes.log });
      break;
    }
    case "director.search":
      send(socket, { type: "director.results", query: cmd.query, messages: ctx.db.searchDirectorMessages(cmd.query) });
      break;
    case "chat.history": {
      const page = ctx.db.listRoomMessagePage(cmd.room, CHAT_PAGE_SIZE, cmd.before);
      send(socket, { type: "chat.history", room: cmd.room, messages: page.messages, hasMore: page.hasMore });
      break;
    }
    case "chat.post":
      ctx.manager.directorChatPost(cmd.room, cmd.body);
      break;
    case "snapshot.request":
      send(socket, buildHello(ctx));
      break;
    default:
      break;
  }
}
