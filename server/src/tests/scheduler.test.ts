// Deterministic integration test for the Scheduler (recurring dispatches). No live accounts, no network,
// no real agents — a temp DB + a fake dispatch that records its inputs. Run: `npm run test:scheduler`.
//
// Verifies the CRUD + broadcast + next-run bookkeeping the Scheduled Tasks UI and director tools rely on.
// (The cron math itself is covered by cron.test.ts; here we check the scheduler wires it correctly.)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { Scheduler } from "../orchestrator/scheduler.js";
import type { DispatchInput } from "../orchestrator/api.js";
import type { ServerEvent } from "../ws/protocol.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "sched-test-"));
const db = new Db(join(dir, "t.sqlite"));
const hub = new EventHub();
const dispatched: DispatchInput[] = [];
let nextThreadId = 1;
const dispatch = async (input: DispatchInput): Promise<string> => {
  dispatched.push(input);
  return `thread-${nextThreadId++}`;
};

// Capture the last `schedules` broadcast so we can assert the UI would see the change.
let lastBroadcast: ServerEvent | null = null;
hub.subscribe((e) => {
  if (e.type === "schedules") lastBroadcast = e;
});

const scheduler = new Scheduler(db, hub, dispatch);

async function main(): Promise<void> {
  console.log("scheduler: create");
  // Use the current workspace (the repo) as an existing path so runNow's existsSync guard passes.
  const ws = process.cwd();
  const created = scheduler.create({ title: "Nightly audit", workspace: ws, prompt: "audit deps", cron: "0 3 * * *", effort: "high" });
  check("create ok", created.ok && !!created.schedule);
  check("create computes a future nextRunAt", (created.schedule?.nextRunAt ?? 0) > Date.now());
  check("create broadcasts the list", !!lastBroadcast && (lastBroadcast as { schedules: unknown[] }).schedules.length === 1);
  const id = created.schedule!.id;

  console.log("scheduler: validation");
  check("rejects bad cron", !scheduler.create({ title: "x", workspace: ws, prompt: "p", cron: "not cron" }).ok);
  check("rejects empty title", !scheduler.create({ title: "  ", workspace: ws, prompt: "p", cron: "* * * * *" }).ok);
  check("rejects empty prompt", !scheduler.create({ title: "t", workspace: ws, prompt: "", cron: "* * * * *" }).ok);
  check("list still has exactly 1 after rejects", scheduler.list().length === 1);

  console.log("scheduler: update");
  const beforeNext = db.getScheduledTask(id)!.nextRunAt;
  const upd = scheduler.update(id, { cron: "*/15 * * * *", prompt: "audit deps v2" });
  check("update ok", upd.ok);
  check("update changed the prompt", db.getScheduledTask(id)!.prompt === "audit deps v2");
  check("cron change re-anchors nextRunAt", db.getScheduledTask(id)!.nextRunAt !== beforeNext);
  check("update rejects bad cron (keeps old)", !scheduler.update(id, { cron: "99 * * * *" }).ok && db.getScheduledTask(id)!.cron === "*/15 * * * *");

  console.log("scheduler: enable/disable");
  scheduler.update(id, { enabled: false });
  check("disabled clears nextRunAt", db.getScheduledTask(id)!.nextRunAt == null);
  check("disabled schedule is not enabled", db.getScheduledTask(id)!.enabled === false);
  scheduler.update(id, { enabled: true });
  check("re-enabled recomputes nextRunAt", (db.getScheduledTask(id)!.nextRunAt ?? 0) > Date.now());

  console.log("scheduler: runNow fires the pipeline");
  const before = dispatched.length;
  const nextBeforeRun = db.getScheduledTask(id)!.nextRunAt;
  await scheduler.runNow(id);
  check("runNow dispatched once", dispatched.length === before + 1);
  check("runNow does NOT disturb the cron cadence", db.getScheduledTask(id)!.nextRunAt === nextBeforeRun);
  const last = dispatched[dispatched.length - 1]!;
  check("dispatch got the prompt as the brief", last.brief === "audit deps v2");
  check("dispatch got the title", last.title === "Nightly audit");
  check("dispatch got the effort override", last.effort === "high");
  check("runNow records lastRunAt + lastThreadId", db.getScheduledTask(id)!.lastRunAt != null && db.getScheduledTask(id)!.lastThreadId != null);

  console.log("scheduler: effort clear");
  scheduler.update(id, { effort: null });
  check("effort cleared to null", db.getScheduledTask(id)!.effort == null);

  console.log("scheduler: start() re-anchors from now (no backlog)");
  // Simulate a schedule left with a stale past nextRunAt (as if the server was down): start() should move
  // it forward, never leave it in the past (which would fire immediately on the first tick).
  db.updateScheduledTask(id, { nextRunAt: Date.now() - 3_600_000 });
  scheduler.start();
  check("start moved a stale nextRunAt into the future", (db.getScheduledTask(id)!.nextRunAt ?? 0) > Date.now());

  console.log("scheduler: delete");
  check("delete ok", scheduler.remove(id).ok);
  check("list empty after delete", scheduler.list().length === 0);
  check("delete of missing id fails", !scheduler.remove(id).ok);

  if (failures) {
    console.error(`\n${failures} scheduler check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll scheduler checks passed.");
  process.exit(0);
}

main().finally(() => {
  try {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
});
