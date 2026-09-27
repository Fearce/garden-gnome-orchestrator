/** Gate for the composer's recent-repo chips. The server owns the list: a dispatch that carries a path
 *  remembers it, the + button's `recentRepos.remember` adds one, `recentRepos.forget` drops one, and a
 *  cached `hello` can no longer roll a fresh list back. No provider calls. */
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { DispatchInput } from "../orchestrator/api.js";
import type { ServerEvent } from "../ws/protocol.js";
import type { WsContext } from "../ws/hub.js";

const { clientCommandSchema } = await import("../ws/protocol.js");
const { handleCommand, withLiveSettings } = await import("../ws/hub.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager, normalizeRecentRepo } = await import("../orchestrator/threadManager.js");
const { Director } = await import("../orchestrator/director.js");

// ---- path spelling ----
assert.equal(normalizeRecentRepo("  C:\\work\\app\\  "), "C:\\work\\app", "trailing separators and whitespace go");
assert.equal(normalizeRecentRepo("/srv/app//"), "/srv/app");
assert.equal(normalizeRecentRepo("C:\\"), "C:\\", "a drive root keeps its separator");
assert.equal(normalizeRecentRepo("/"), "/", "the POSIX root keeps its separator");

// ---- the WebSocket boundary ----
assert.deepEqual(clientCommandSchema.parse({ type: "recentRepos.remember", path: " C:\\a " }), { type: "recentRepos.remember", path: "C:\\a" });
assert.deepEqual(clientCommandSchema.parse({ type: "recentRepos.forget", path: "C:\\a" }), { type: "recentRepos.forget", path: "C:\\a" });
assert.throws(() => clientCommandSchema.parse({ type: "recentRepos.remember", path: "   " }), "a blank path is refused");
assert.throws(() => clientCommandSchema.parse({ type: "recentRepos.remember", path: "x".repeat(601) }), "an oversized path is refused");

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

const dir = mkdtempSync(join(tmpdir(), "recent-repos-"));
const repo = (name: string) => {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
};
const [alpha, beta, gamma] = [repo("alpha"), repo("beta"), repo("gamma")];
const missing = join(dir, "not-there");
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService(join(dir, "memory"));
const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
const broadcasts: string[][] = [];
hub.subscribe((event) => {
  if (event.type === "settings") broadcasts.push(event.settings.recentRepos);
});

try {
  // ---- ThreadManager: the server edits the stored list itself ----
  assert.deepEqual(mgr.settings().recentRepos, [], "a fresh install remembers nothing");
  mgr.rememberRecentRepo(alpha);
  mgr.rememberRecentRepo(beta);
  assert.deepEqual(mgr.settings().recentRepos, [beta, alpha], "most recent first");
  mgr.rememberRecentRepo(`${alpha}\\`);
  assert.deepEqual(mgr.settings().recentRepos, [alpha, beta], "a re-used repo moves to the front once, whatever its trailing separator");
  assert.deepEqual(broadcasts.at(-1), [alpha, beta], "every edit is broadcast so each console converges");
  mgr.forgetRecentRepo(beta);
  assert.deepEqual(mgr.settings().recentRepos, [alpha], "forget drops one repo");
  mgr.setSettings({ maxRecentRepos: 2 });
  for (const p of [beta, gamma]) mgr.rememberRecentRepo(p);
  assert.deepEqual(mgr.settings().recentRepos, [gamma, beta], "capped at maxRecentRepos");
  mgr.setSettings({ maxRecentRepos: 5, recentRepos: [alpha, `${alpha}/`, " ", beta] });
  assert.deepEqual(mgr.settings().recentRepos, [alpha, beta], "a pre-fix console's whole-list write is still cleaned");

  // ---- Director: an owner dispatch with a path remembers it, server-side ----
  mgr.setSettings({ recentRepos: [alpha], skipDirectorRetitle: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).dispatch = async (_input: DispatchInput) => "task-1";
  const director = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);
  await director.dispatchDirect("skip-director task", gamma, undefined, "msg-direct");
  assert.deepEqual(mgr.settings().recentRepos, [gamma, alpha], "a skip-director dispatch adds its repo without any client write");
  await director.dispatchVanilla("vanilla task", beta, undefined, undefined, undefined, "msg-vanilla");
  assert.deepEqual(mgr.settings().recentRepos, [beta, gamma, alpha], "so does a default-mode dispatch");
  await director.dispatchDirect("bad path", missing, undefined, "msg-missing");
  assert.deepEqual(mgr.settings().recentRepos, [beta, gamma, alpha], "a path that does not exist is not remembered");

  // ---- the hub: the + button's command ----
  const sent: ServerEvent[] = [];
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (raw: string) => sent.push(JSON.parse(raw) as ServerEvent) } as unknown as WebSocket;
  const ctx = { manager: mgr, hub, db } as unknown as WsContext;
  await handleCommand(ctx, socket, { type: "recentRepos.remember", path: alpha });
  assert.deepEqual(mgr.settings().recentRepos, [alpha, beta, gamma], "remember adds a repo without dispatching");
  await handleCommand(ctx, socket, { type: "recentRepos.remember", path: missing });
  assert.deepEqual(mgr.settings().recentRepos, [alpha, beta, gamma], "a missing folder is refused");
  assert.ok(sent.some((e) => e.type === "settings" && !e.settings.recentRepos.includes(missing)), "the asking console gets the real list back");
  assert.ok(sent.some((e) => e.type === "notice" && e.message.includes(missing)), "and is told why");
  await handleCommand(ctx, socket, { type: "recentRepos.forget", path: beta });
  assert.deepEqual(mgr.settings().recentRepos, [alpha, gamma], "forget through the hub");

  // ---- a cached hello cannot roll the list back ----
  const stale = { type: "hello", settings: { ...mgr.settings(), recentRepos: [gamma] } } as unknown as ServerEvent;
  const served = withLiveSettings(() => stale, () => mgr.settings())();
  assert.ok(served.type === "hello" && served.settings?.recentRepos.join() === [alpha, gamma].join(), "hello carries the live settings");
  const other = { type: "pong", at: 1 } as ServerEvent;
  assert.equal(withLiveSettings(() => other, () => mgr.settings())(), other, "other events pass through untouched");

  console.log("PASS: recent repos");
} finally {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const i = mgr as any;
  for (const key of ["capSupervisor", "tokenResumeTimer", "capResumeWake"]) if (i[key]) clearTimeout(i[key]);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
