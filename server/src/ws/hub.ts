import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { Director } from "../orchestrator/director.js";
import type { ThreadActionResult } from "../orchestrator/api.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { RepoActionDTO, RepoConsole } from "../orchestrator/repoConsole.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { ThreadManager } from "../orchestrator/threadManager.js";
import type { OnlineOffice } from "../office/onlineOffice.js";
import type { CoworkManager } from "../orchestrator/cowork.js";
import { readCodexUsage } from "../agents/codexUsage.js";
import { readGrokUsage } from "../agents/grokUsage.js";
import { readZaiUsage } from "../agents/zaiUsage.js";
import { formatStructuredRoleFeed } from "../agents/structuredText.js";
import { clientCommandSchema, type ClientCommand, type ServerEvent } from "./protocol.js";
import { isAuthed } from "../auth.js";
import { CHAT_PAGE_SIZE } from "../types.js";
import type { Message } from "../types.js";

/** Owner-facing rewrite for CLI structured-role walls (Grok multi-turn QA especially). Idempotent
 *  on already-humanized prose so new runs and pre-fix raw messages share one display path. */
function humanizeFeedMessages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.kind !== "text" || !m.content) return m;
    const content = formatStructuredRoleFeed(m.content);
    return content === m.content ? m : { ...m, content };
  });
}

export interface WsContext {
  db: Db;
  hub: EventHub;
  manager: ThreadManager;
  director: Director;
  accounts: AccountManager;
  scheduler: Scheduler;
  notes: OperatorNotes;
  repos: RepoConsole;
  onlineOffice: OnlineOffice;
  cowork: CoworkManager;
}

const STREAMING_EVENTS = new Set(["agent.delta", "agent.thinking", "director.delta", "cowork.delta", "cowork.thinking"]);

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  // Shed high-frequency streaming deltas if the client is backed up; committed
  // text/state events still get through so the UI converges.
  if (socket.bufferedAmount > 2_000_000 && STREAMING_EVENTS.has(event.type)) return;
  socket.send(JSON.stringify(event));
}

function sendThreadAction(socket: WebSocket, threadId: string, action: string, result: ThreadActionResult, clientId?: string): void {
  send(socket, { type: "thread.action", threadId, action, clientId, ok: result.ok, state: result.state, error: result.error, message: result.message, result });
}

function sendCoworkAction(socket: WebSocket, action: string, result: ReturnType<CoworkManager["create"]>, clientId?: string): void {
  send(socket, {
    type: "cowork.action",
    sessionId: result.session?.id,
    action,
    clientId,
    ok: result.ok,
    error: result.error,
    result,
  });
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
    directorStatus: ctx.director.status(),
    accounts: ctx.accounts.dto(),
    codexUsage: readCodexUsage(),
    grokUsage: ctx.manager.settings().grokEnabled || readGrokUsage().signedIn ? readGrokUsage() : null,
    zaiUsage: ctx.manager.settings().zaiEnabled || readZaiUsage().configured ? readZaiUsage() : null,
    approvalMode: ctx.manager.approvalMode(),
    settings: ctx.manager.settings(),
    // The office: a recent slice of chat for the live feed, plus the project-room roll-up (full
    // history is cheap and bounded) that drives which tasks show a "Chatroom" button.
    chat: ctx.db.listRecentChat(SNAPSHOT_CHAT),
    chatRooms: ctx.db.listProjectRooms(),
    nameOverrides: ctx.manager.officeNameOverrides(),
    schedules: ctx.scheduler.list(),
    modelStats: ctx.db.modelStats(),
    notes: ctx.notes.list(),
    onlineOffice: ctx.onlineOffice.status(),
    supervisor: ctx.manager.supervisorSnapshot(),
    coworkSessions: ctx.cowork.sessions(),
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

export async function handleCommand(ctx: WsContext, socket: WebSocket, cmd: ClientCommand): Promise<void> {
  switch (cmd.type) {
    case "prompt.new":
      ctx.director.handleUserMessage(cmd.text, cmd.workspace, cmd.images, cmd.source, cmd.clientId);
      break;
    case "prompt.direct":
      await ctx.director.dispatchDirect(cmd.text, cmd.workspace, cmd.images, cmd.clientId);
      break;
    case "cowork.create":
      sendCoworkAction(socket, "create", ctx.cowork.create(cmd), cmd.clientId);
      break;
    case "cowork.send":
      sendCoworkAction(socket, "send", ctx.cowork.send(cmd.sessionId, cmd.text, cmd.clientId), cmd.clientId);
      break;
    case "cowork.steer":
      sendCoworkAction(socket, cmd.mode, ctx.cowork.steer(cmd.sessionId, cmd.text, cmd.mode, cmd.clientId), cmd.clientId);
      break;
    case "cowork.stop":
      sendCoworkAction(socket, "stop", await ctx.cowork.stop(cmd.sessionId));
      break;
    case "cowork.rename":
      sendCoworkAction(socket, "rename", ctx.cowork.rename(cmd.sessionId, cmd.name));
      break;
    case "cowork.delete":
      sendCoworkAction(socket, "delete", ctx.cowork.remove(cmd.sessionId));
      break;
    case "cowork.history": {
      const history = ctx.cowork.history(cmd.sessionId);
      send(socket, { type: "cowork.history", sessionId: cmd.sessionId, ...history });
      break;
    }
    case "question.answer":
      ctx.manager.resolveQuestion(cmd.questionId, cmd.answer);
      break;
    case "thread.inject":
      sendThreadAction(
        socket,
        cmd.threadId,
        "inject",
        await ctx.manager.injectThread(cmd.threadId, cmd.message, cmd.mode, cmd.images, { recipient: cmd.recipient }),
        cmd.clientId,
      );
      break;
    case "thread.interrupt":
      sendThreadAction(socket, cmd.threadId, "interrupt", await ctx.manager.interruptThread(cmd.threadId));
      break;
    case "thread.resume":
      sendThreadAction(socket, cmd.threadId, "resume", await ctx.manager.resumeThread(cmd.threadId, cmd.message, true));
      break;
    case "thread.deadline":
      sendThreadAction(socket, cmd.threadId, "deadline", await ctx.manager.setActiveDeadline(cmd.threadId, cmd.deadlineAt));
      break;
    case "thread.cancel":
      sendThreadAction(socket, cmd.threadId, "cancel", await ctx.manager.cancelThread(cmd.threadId));
      break;
    case "thread.retry":
      sendThreadAction(socket, cmd.threadId, "retry", await ctx.manager.retryThread(cmd.threadId));
      break;
    case "thread.rename":
      ctx.manager.renameThread(cmd.threadId, cmd.title);
      break;
    case "thread.markDone":
      sendThreadAction(socket, cmd.threadId, "markDone", await ctx.manager.markDone(cmd.threadId));
      break;
    case "thread.autoReview": {
      const result = await ctx.manager.autoReview(cmd.threadId);
      // Every rejection here is a state the operator can see but the button couldn't rule out at click
      // time (a task that just re-parked on a cap, a workspace that moved) — surface it instead of
      // leaving a click that visibly did nothing.
      if (!result.ok && result.error) ctx.hub.log("warn", result.error);
      sendThreadAction(socket, cmd.threadId, "autoReview", result);
      break;
    }
    case "thread.close":
      sendThreadAction(socket, cmd.threadId, "close", await ctx.manager.closeThread(cmd.threadId));
      break;
    case "thread.restore":
      sendThreadAction(socket, cmd.threadId, "restore", ctx.manager.restoreThread(cmd.threadId));
      break;
    case "thread.dismiss":
      ctx.manager.dismissThread(cmd.threadId);
      break;
    case "thread.history": {
      const thread = ctx.db.getThread(cmd.threadId);
      send(socket, {
        type: "thread.history",
        threadId: cmd.threadId,
        // Humanize raw Grok/Codex structured JSON walls at the display boundary so tasks that
        // finished before write-time formatting still open clean in the feed.
        messages: humanizeFeedMessages(ctx.db.listMessages(cmd.threadId)),
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
    case "discord.test": {
      const result = await ctx.manager.testDiscordNotification();
      send(socket, { type: "discord.test.result", ok: result.ok, message: result.message });
      break;
    }
    case "account.set":
      ctx.manager.setAccountEnabled(cmd.id, cmd.enabled);
      break;
    case "account.setSafety":
      ctx.manager.setAccountWeeklySafety(cmd.id, cmd.weeklySafetyPct);
      break;
    case "thread.changes": {
      const changes = await ctx.manager.getChanges(cmd.threadId);
      send(socket, { type: "thread.changes", threadId: cmd.threadId, diff: changes.diff, log: changes.log });
      break;
    }
    case "thread.git": {
      const status = await ctx.manager.getGitStatus(cmd.threadId);
      send(socket, { type: "thread.git", threadId: cmd.threadId, status });
      break;
    }
    case "thread.gitSummary": {
      const summary = await ctx.manager.getGitSummary(cmd.threadId);
      send(socket, { type: "thread.gitSummary", threadId: cmd.threadId, summary });
      break;
    }
    case "thread.gitDiff": {
      const diff = await ctx.manager.getFileDiff(cmd.threadId, cmd.path);
      send(socket, { type: "thread.gitDiff", threadId: cmd.threadId, path: cmd.path, diff });
      break;
    }
    case "repo.list":
      send(socket, {
        type: "repo.list",
        repos: await ctx.repos.list(cmd.rescan),
        preferred: cmd.forThread ? await ctx.repos.repoForThread(cmd.forThread) : null,
        forThread: cmd.forThread ?? null,
      });
      break;
    case "repo.state":
      send(socket, { type: "repo.state", path: cmd.path, state: await ctx.repos.state(cmd.path) });
      break;
    case "repo.diff":
      send(socket, {
        type: "repo.diff",
        path: cmd.path,
        file: cmd.file,
        commit: cmd.commit ?? null,
        diff: await ctx.repos.diff(cmd.path, cmd.file, cmd.commit),
      });
      break;
    case "repo.commit":
      send(socket, { type: "repo.commit", path: cmd.path, detail: await ctx.repos.commitDetail(cmd.path, cmd.hash) });
      break;
    case "repo.action": {
      // The console goes busy on send and un-busies on the result, so this command MUST answer exactly
      // once — an unexpected throw anywhere below would otherwise leave it spinning forever with no way
      // back. Everything fallible is inside the try, and the catch still answers.
      let result: RepoActionDTO;
      try {
        result = await ctx.repos.action(cmd.path, cmd.op, cmd.force);
        // Fresh state FIRST, outcome second. Re-reading the repo costs a dozen git spawns, so a result
        // sent ahead of it would flip the console out of its "running git…" state while the file list,
        // branch and counts still described the pre-action repo — a visible lie for as long as the
        // re-read takes. That ordering is what makes the pair atomic to the operator.
        send(socket, { type: "repo.state", path: cmd.path, state: await ctx.repos.state(cmd.path) });
      } catch (e) {
        result = { ok: false, blocked: false, message: `git ${cmd.op.action} failed: ${(e as Error).message}` };
      }
      send(socket, { type: "repo.result", path: cmd.path, action: cmd.op.action, result });
      break;
    }
    case "director.cancel":
      ctx.director.cancelTurn();
      break;
    case "director.search":
      send(socket, {
        type: "director.results",
        query: cmd.query,
        messages: ctx.db.searchDirectorMessages(cmd.query),
        tasks: ctx.db.searchTasks(cmd.query),
      });
      break;
    case "chat.history": {
      const page = ctx.db.listRoomMessagePage(cmd.room, CHAT_PAGE_SIZE, cmd.before);
      send(socket, { type: "chat.history", room: cmd.room, messages: page.messages, hasMore: page.hasMore });
      break;
    }
    case "chat.post":
      ctx.manager.directorChatPost(cmd.room, cmd.body, cmd.clientId);
      break;
    case "schedule.create":
      ctx.scheduler.create({ title: cmd.title, workspace: cmd.workspace, prompt: cmd.prompt, cron: cmd.cron, enabled: cmd.enabled, effort: cmd.effort ?? null });
      break;
    case "schedule.update":
      ctx.scheduler.update(cmd.id, cmd.patch);
      break;
    case "schedule.delete":
      ctx.scheduler.remove(cmd.id);
      break;
    case "schedule.run":
      await ctx.scheduler.runNow(cmd.id);
      break;
    case "office.join": {
      // The join code is used here and dropped — only the device token it buys is persisted. The
      // outcome goes back to the asking socket so the panel can un-busy its button and show why.
      const url = cmd.url.trim() || ctx.onlineOffice.status().url;
      const result = await ctx.onlineOffice.join({ url, code: cmd.code, instanceName: cmd.instanceName });
      send(socket, { type: "office.join.result", ok: result.ok, error: result.error ?? null });
      break;
    }
    case "office.leave":
      ctx.onlineOffice.leave();
      break;
    case "office.set":
      if (cmd.instanceName !== undefined) ctx.onlineOffice.setInstanceName(cmd.instanceName);
      if (cmd.enabled !== undefined) ctx.onlineOffice.setEnabled(cmd.enabled);
      break;
    case "note.create": {
      // The owner's own note — no task, no agent behind it (fromRole/fromName stay null).
      const result = ctx.notes.add({ body: cmd.body, url: cmd.url ?? null });
      if (!result.ok && result.error) ctx.hub.log("warn", result.error);
      break;
    }
    case "note.delete":
      ctx.notes.remove(cmd.id);
      break;
    case "note.clear":
      ctx.notes.clear();
      break;
    case "supervisor.message":
      ctx.manager.supervisorSendMessage(cmd.content, cmd.targetIds, cmd.clientId);
      break;
    case "supervisor.runNow":
      await ctx.manager.supervisorRunNow();
      break;
    case "snapshot.request":
      send(socket, buildHello(ctx));
      break;
    default:
      break;
  }
}
