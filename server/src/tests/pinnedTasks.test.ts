process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { WebSocket } from "ws";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";
import type { WsContext } from "../ws/hub.js";
import type { ServerEvent } from "../ws/protocol.js";

const { Db } = await import("../db/db.js");
const { SCHEMA } = await import("../db/schema.js");
const { clientCommandSchema } = await import("../ws/protocol.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { handleCommand } = await import("../ws/hub.js");

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string | undefined { return undefined; }
}

/** The manager and the WebSocket route: what a click on the pin actually reaches. */
async function checkManagerAndRoute(dir: string): Promise<void> {
  const db = new Db(join(dir, "manager.sqlite"));
  const hub = new EventHub();
  const mgr = new ThreadManager(db, hub, new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  const upserts: Thread[] = [];
  hub.subscribe((event) => {
    if (event.type === "thread.upsert") upserts.push(event.thread);
  });
  const replies: ServerEvent[] = [];
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (raw: string) => replies.push(JSON.parse(raw) as ServerEvent) } as unknown as WebSocket;
  const ctx = { manager: mgr, hub, db } as unknown as WsContext;
  try {
    const lead = db.createThread({ title: "Lead", workspace: dir, rawPrompt: "lead" });
    const child = db.createThread({ title: "Helper", workspace: dir, rawPrompt: "helper", parentId: lead.id });

    await handleCommand(ctx, socket, { type: "thread.pin", threadId: lead.id, pinned: true });
    assert.ok(db.getThread(lead.id)?.pinnedAt, "thread.pin pins the task");
    assert.ok(upserts.at(-1)?.id === lead.id && upserts.at(-1)?.pinnedAt, "and broadcasts the pinned card to every console");
    const reply = replies.at(-1);
    assert.ok(reply?.type === "thread.action" && reply.action === "pin" && reply.ok, "the clicking console gets an ok thread.action");

    const stamp = db.getThread(lead.id)!.pinnedAt;
    const before = upserts.length;
    assert.equal(mgr.setThreadPinned(lead.id, true).ok, true);
    assert.equal(db.getThread(lead.id)?.pinnedAt, stamp, "re-pinning keeps the original stamp");
    assert.equal(upserts.length, before + 1, "but re-sends the card, since the click came from a stale board");

    const refused = mgr.setThreadPinned(child.id, true);
    assert.equal(refused.ok, false, "a task inside a lead can't be pinned");
    assert.equal(db.getThread(child.id)?.pinnedAt, null);
    assert.equal(mgr.setThreadPinned("no-such-task", true).ok, false);

    // A queued timed task pinned after the pipeline read it: starting its window must not unpin it on screen.
    const timed = db.createThread({ title: "Timed", workspace: dir, rawPrompt: "timed", durationMs: 60_000 });
    const staleCopy = db.getThread(timed.id)!;
    mgr.setThreadPinned(timed.id, true);
    (mgr as any).activateTimedWindow(staleCopy); // eslint-disable-line @typescript-eslint/no-explicit-any
    const started = upserts.at(-1)!;
    assert.ok(started.id === timed.id && started.deadlineAt != null, "the window start is broadcast");
    assert.ok(started.pinnedAt, "with the pin the owner set after the pipeline read the task");

    await handleCommand(ctx, socket, { type: "thread.pin", threadId: lead.id, pinned: false });
    assert.equal(db.getThread(lead.id)?.pinnedAt, null, "thread.pin with pinned:false unpins");
    assert.equal(upserts.at(-1)?.pinnedAt, null);
  } finally {
    const i = mgr as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const key of ["capSupervisor", "tokenResumeTimer", "capResumeWake"]) if (i[key]) clearTimeout(i[key]);
    db.raw.close();
  }
}

const dir = mkdtempSync(join(tmpdir(), "gg-pinned-"));
const path = join(dir, "orchestrator.sqlite");

try {
  let db = new Db(path);
  const thread = db.createThread({ title: "Keep me at the front", workspace: dir, rawPrompt: "A task" });
  assert.equal(db.getThread(thread.id)?.pinnedAt, null, "a new task starts unpinned");
  const before = db.getThread(thread.id)!.updatedAt;

  const pinned = db.setThreadPinned(thread.id, true);
  assert.ok(pinned?.pinnedAt, "pinning stamps pinnedAt");
  assert.equal(pinned.updatedAt, before, "pinning is not activity — updatedAt, which the card's age and the Last updated sort read, is unchanged");
  assert.ok(db.listThreadSummaries().find((t) => t.id === thread.id)?.pinnedAt, "the board snapshot carries the pin");
  assert.ok(db.listThreads().find((t) => t.id === thread.id)?.pinnedAt, "the full listing carries the pin");

  // A closed pinned task keeps its pin, so Restore brings it back to the front.
  db.closeThread(thread.id);
  assert.ok(db.restoreThread(thread.id)?.pinnedAt, "close + restore keeps the pin");
  db.raw.close();

  db = new Db(path);
  assert.ok(db.getThread(thread.id)?.pinnedAt, "the pin survives a restart");
  assert.equal(db.setThreadPinned(thread.id, false)?.pinnedAt, null, "unpinning clears it");
  assert.equal(db.listThreadSummaries().find((t) => t.id === thread.id)?.pinnedAt, null, "the snapshot sees the unpin");
  assert.equal(db.setThreadPinned("no-such-task", true), null);
  db.raw.close();

  const legacyPath = join(dir, "legacy.sqlite");
  const legacy = new Database(legacyPath);
  const legacySchema = SCHEMA.replace(/  -- When the owner pinned[^\n]*\n[^\n]*\n  pinned_at +INTEGER,\n/, "");
  assert.notEqual(legacySchema, SCHEMA, "the legacy fixture really drops pinned_at");
  legacy.exec(legacySchema);
  legacy.prepare(
    "INSERT INTO threads(id, title, state, workspace, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)",
  ).run("legacy-task", "Finished long ago", dir, Date.now(), Date.now());
  legacy.close();

  const upgraded = new Db(legacyPath);
  assert.equal(upgraded.getThread("legacy-task")?.pinnedAt, null, "an upgraded database reads existing tasks as unpinned");
  assert.ok(upgraded.setThreadPinned("legacy-task", true)?.pinnedAt, "and can pin them");
  upgraded.raw.close();

  assert.ok(clientCommandSchema.safeParse({ type: "thread.pin", threadId: thread.id, pinned: true }).success);
  assert.equal(clientCommandSchema.safeParse({ type: "thread.pin", threadId: thread.id }).success, false, "pinned is required");

  await checkManagerAndRoute(dir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("pinnedTasks: pins persist, ride the board snapshot, survive close/restore and restarts, never bump updatedAt, and reach every console from thread.pin");
