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
import { Scheduler, type ReminderChannel } from "../orchestrator/scheduler.js";
import { nextRun } from "../orchestrator/cron.js";
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

// The owner's Discord DM, faked: records every reminder and can be told to refuse the next sends.
const reminded: { title: string; text: string }[] = [];
const fallbacks: { title: string; text: string; why: string }[] = [];
let refuseReminders = 0;
const reminders: ReminderChannel = {
  ready: () => true,
  send: async (title, text) => {
    reminded.push({ title, text });
    if (refuseReminders > 0) {
      refuseReminders--;
      return { ok: false, message: "Discord refused the message (500)." };
    }
    return { ok: true };
  },
  fallback: (title, text, why) => fallbacks.push({ title, text, why }),
};

const scheduler = new Scheduler(db, hub, dispatch, reminders);

async function main(): Promise<void> {
  console.log("scheduler: create");
  // Use the current workspace (the repo) as an existing path so runNow's existsSync guard passes.
  const ws = process.cwd();
  const created = scheduler.create({ title: "Nightly audit", workspace: ws, prompt: "audit deps", cron: "0 3 * * *", effort: "high", model: "gpt-5.6-luna", provider: "codex" });
  check("create ok", created.ok && !!created.schedule);
  check("create computes a future nextRunAt", (created.schedule?.nextRunAt ?? 0) > Date.now());
  check("create broadcasts the list", !!lastBroadcast && (lastBroadcast as { schedules: unknown[] }).schedules.length === 1);
  check("create retains the strict model pin", created.schedule?.model === "gpt-5.6-luna");
  check("create retains the pinned backend", created.schedule?.provider === "codex");
  const id = created.schedule!.id;

  console.log("scheduler: the pin is a pair");
  // A provider alone pins nothing a fire could act on, so it must never reach the row: stored, it would
  // read on the card as a pin that is silently doing nothing.
  const lone = scheduler.create({ title: "Lone provider", workspace: ws, prompt: "p", cron: "0 4 * * *", provider: "grok" });
  check("a provider with no model is dropped, not stored", lone.ok && lone.schedule?.provider == null && lone.schedule?.model == null);
  scheduler.remove(lone.schedule!.id);
  check("a reload reads the pin back as the same pair", db.getScheduledTask(id)?.provider === "codex" && db.getScheduledTask(id)?.model === "gpt-5.6-luna");

  console.log("scheduler: validation");
  check("rejects bad cron", !scheduler.create({ title: "x", workspace: ws, prompt: "p", cron: "not cron" }).ok);
  check("rejects empty title", !scheduler.create({ title: "  ", workspace: ws, prompt: "p", cron: "* * * * *" }).ok);
  check("rejects empty prompt", !scheduler.create({ title: "t", workspace: ws, prompt: "", cron: "* * * * *" }).ok);
  check("list still has exactly 1 after rejects", scheduler.list().length === 1);

  console.log("scheduler: update");
  const upd = scheduler.update(id, { cron: "*/15 * * * *", prompt: "audit deps v2" });
  check("update ok", upd.ok);
  check("update changed the prompt", db.getScheduledTask(id)!.prompt === "audit deps v2");
  // Assert the stored nextRunAt is what the NEW expression predicts, rather than merely that it
  // DIFFERS from the old one. The differs-form was a 15-minute-a-day time bomb: run it between
  // 02:45 and 03:00 and both "0 3 * * *" and "*/15 * * * *" resolve to 03:00, so a perfectly
  // correct re-anchor left the value unchanged and the check failed — on every branch, master
  // included. Comparing against nextRun() is also the stronger assertion: it proves the schedule
  // was re-anchored to the new expression, not just that some number moved.
  const afterNext = db.getScheduledTask(id)!.nextRunAt;
  check("cron change re-anchors nextRunAt to the new expression", afterNext != null && afterNext === nextRun("*/15 * * * *", afterNext - 1));
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
  check("dispatch got the strict model pin", last.requestedModel === "gpt-5.6-luna");
  check("dispatch got the pinned backend, so the pair stays exact", last.requestedProvider === "codex");
  check("runNow records lastRunAt + lastThreadId", db.getScheduledTask(id)!.lastRunAt != null && db.getScheduledTask(id)!.lastThreadId != null);

  console.log("scheduler: one fire at a time");
  // 2026-09-23: a five-minute shutdown check stacked up to nine concurrent implementor+QA tasks in one
  // repo because each fire ignored whether the previous one was still working. Drive the real tick with
  // a predecessor in every state and check which ones let the next fire through.
  const tick = () => (scheduler as unknown as { tick(): void }).tick();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const guardId = scheduler.create({ title: "Guarded", workspace: ws, prompt: "check", cron: "*/5 * * * *" }).schedule!.id;
  const prev = db.createThread({ title: "Guarded", workspace: ws, brief: "check", rawPrompt: "check" });
  db.updateScheduledTask(guardId, { lastThreadId: prev.id });
  const fireDue = async (): Promise<boolean> => {
    db.updateScheduledTask(guardId, { nextRunAt: Date.now() - 1000 });
    const n = dispatched.length;
    tick();
    await settle();
    const fired = dispatched.length > n;
    // Point the schedule back at the seeded predecessor so every case measures the same thing.
    db.updateScheduledTask(guardId, { lastThreadId: prev.id });
    return fired;
  };
  for (const state of ["queued", "implementing", "qa", "awaiting_user", "paused", "reviewing"] as const) {
    db.updateThread(prev.id, { state });
    check(`a fire is skipped while the previous run is ${state}`, !(await fireDue()));
    check(`a skipped fire still advances the cadence (${state})`, (db.getScheduledTask(guardId)!.nextRunAt ?? 0) > Date.now());
  }
  for (const state of ["done", "review", "failed", "cancelled", "closed"] as const) {
    db.updateThread(prev.id, { state });
    check(`a fire proceeds once the previous run is ${state}`, await fireDue());
  }
  db.updateScheduledTask(guardId, { lastThreadId: "purged-thread" });
  db.updateScheduledTask(guardId, { nextRunAt: Date.now() - 1000 });
  const beforePurged = dispatched.length;
  tick();
  await settle();
  check("a purged predecessor never blocks the schedule", dispatched.length === beforePurged + 1);

  db.updateThread(prev.id, { state: "implementing" });
  db.updateScheduledTask(guardId, { lastThreadId: prev.id });
  const refused = await scheduler.runNow(guardId);
  check("Run now refuses while the previous run is still working", !refused.ok && /implementing/.test(refused.error ?? ""));

  // Two due ticks inside one slow dispatch: the second must see the first in flight, since lastThreadId
  // is only written once dispatch resolves.
  db.updateThread(prev.id, { state: "done" });
  let release: () => void = () => {};
  const slow = new Scheduler(db, hub, async (input) => {
    dispatched.push(input);
    await new Promise<void>((r) => (release = r));
    return prev.id;
  }, reminders);
  const n0 = dispatched.length;
  db.updateScheduledTask(guardId, { nextRunAt: Date.now() - 1000 });
  (slow as unknown as { tick(): void }).tick();
  db.updateScheduledTask(guardId, { nextRunAt: Date.now() - 1000 });
  (slow as unknown as { tick(): void }).tick();
  check("a fire whose dispatch is still in flight blocks the next", dispatched.length === n0 + 1);
  release();
  await settle();
  scheduler.remove(guardId);

  console.log("scheduler: effort clear");
  scheduler.update(id, { effort: null });
  check("effort cleared to null", db.getScheduledTask(id)!.effort == null);

  console.log("scheduler: model clear");
  // Re-pointing the model must not leave the previous backend attached: an older client (or the Director
  // bridge) can send `model` alone, and inheriting the old provider would pin a pair nobody chose.
  scheduler.update(id, { model: "claude-opus-5-5" });
  check("changing the model alone drops the stale backend", db.getScheduledTask(id)!.provider == null && db.getScheduledTask(id)!.model === "claude-opus-5-5");
  scheduler.update(id, { model: "claude-opus-5-5", provider: "claude" });
  check("re-sending the pair restores an exact pin", db.getScheduledTask(id)!.provider === "claude");
  scheduler.update(id, { model: null });
  check("model pin cleared to null", db.getScheduledTask(id)!.model == null);
  check("clearing the model clears its backend too", db.getScheduledTask(id)!.provider == null);

  console.log("scheduler: start() re-anchors from now (no backlog)");
  // Simulate a schedule left with a stale past nextRunAt (as if the server was down): start() should move
  // it forward, never leave it in the past (which would fire immediately on the first tick).
  db.updateScheduledTask(id, { nextRunAt: Date.now() - 3_600_000 });
  scheduler.start();
  check("start moved a stale nextRunAt into the future", (db.getScheduledTask(id)!.nextRunAt ?? 0) > Date.now());

  console.log("scheduler: run once");
  // A one-off reminder ("3 November at 12:00") written as cron would otherwise fire again every year.
  const once = scheduler.create({ title: "One-off", workspace: ws, prompt: "remind", cron: "0 12 3 11 *", runOnce: true });
  check("create keeps runOnce", once.ok && once.schedule?.runOnce === true);
  check("a reload reads runOnce back", db.getScheduledTask(once.schedule!.id)?.runOnce === true);
  check("a recurring schedule defaults to runOnce=false", db.getScheduledTask(id)?.runOnce === false);
  const onceId = once.schedule!.id;
  const beforeManual = dispatched.length;
  await scheduler.runNow(onceId);
  await settle();
  check("Run now on a run-once schedule leaves it armed", dispatched.length === beforeManual + 1 && db.getScheduledTask(onceId)!.enabled === true);
  // The manual run's thread id is a fake with no row, so it never counts as a busy predecessor.
  const manualThread = db.getScheduledTask(onceId)!.lastThreadId;
  db.updateScheduledTask(onceId, { nextRunAt: Date.now() - 1000 });
  const beforeOnce = dispatched.length;
  tick();
  await settle();
  check("a due run-once schedule fires", dispatched.length === beforeOnce + 1);
  check("after firing it disables itself", db.getScheduledTask(onceId)!.enabled === false);
  check("after firing it has no next run", db.getScheduledTask(onceId)!.nextRunAt == null);
  check("the fire is recorded", db.getScheduledTask(onceId)!.lastThreadId !== manualThread);
  tick();
  await settle();
  check("a disabled run-once schedule never fires again", dispatched.length === beforeOnce + 1);
  scheduler.start();
  check("start() keeps a fired run-once schedule off", db.getScheduledTask(onceId)!.nextRunAt == null);
  scheduler.update(onceId, { enabled: true });
  check("re-enabling re-arms it at the next cron slot", (db.getScheduledTask(onceId)!.nextRunAt ?? 0) > Date.now());
  const armedNext = db.getScheduledTask(onceId)!.nextRunAt;
  scheduler.update(onceId, { runOnce: true });
  check("toggling runOnce alone keeps the armed slot", db.getScheduledTask(onceId)!.nextRunAt === armedNext);
  scheduler.update(onceId, { runOnce: false });
  check("runOnce can be switched off", db.getScheduledTask(onceId)!.runOnce === false);
  scheduler.remove(onceId);

  console.log("scheduler: run once is never pushed a year out");
  // A date cron has no year, so "roll to the next match" means next year: exactly the repeat run-once
  // exists to prevent. A slot missed while GGO was down (deploys restart it) must still fire, late.
  const missed = scheduler.create({ title: "Missed", workspace: ws, prompt: "remind", cron: "0 12 3 11 *", runOnce: true }).schedule!.id;
  db.updateScheduledTask(missed, { nextRunAt: Date.now() - 60_000 });
  scheduler.start();
  check("start() keeps a missed run-once slot due instead of rolling a year", (db.getScheduledTask(missed)!.nextRunAt ?? Infinity) <= Date.now());
  const beforeMissed = dispatched.length;
  tick();
  await settle();
  check("the missed run-once fires late on the next tick", dispatched.length === beforeMissed + 1 && db.getScheduledTask(missed)!.enabled === false);
  scheduler.remove(missed);

  // A busy predecessor (e.g. a Run now test still working) must delay the fire, not move it a year.
  const waits = scheduler.create({ title: "Waits", workspace: ws, prompt: "remind", cron: "0 12 3 11 *", runOnce: true }).schedule!.id;
  db.updateThread(prev.id, { state: "implementing" });
  db.updateScheduledTask(waits, { lastThreadId: prev.id, nextRunAt: Date.now() - 1000 });
  const beforeBusy = dispatched.length;
  tick();
  await settle();
  check("a busy predecessor holds a run-once fire", dispatched.length === beforeBusy);
  check("a held run-once stays due, not a year out", (db.getScheduledTask(waits)!.nextRunAt ?? Infinity) <= Date.now() && db.getScheduledTask(waits)!.enabled === true);
  db.updateThread(prev.id, { state: "done" });
  tick();
  await settle();
  check("it fires once the predecessor finishes", dispatched.length === beforeBusy + 1 && db.getScheduledTask(waits)!.enabled === false);
  scheduler.remove(waits);

  // A failed dispatch must not use up the only fire the schedule has.
  let failNext = true;
  const flaky = new Scheduler(db, hub, async (input) => {
    if (failNext) throw new Error("provider down");
    dispatched.push(input);
    return `thread-${nextThreadId++}`;
  }, reminders);
  const retried = flaky.create({ title: "Retried", workspace: ws, prompt: "remind", cron: "0 12 3 11 *", runOnce: true }).schedule!.id;
  db.updateScheduledTask(retried, { nextRunAt: Date.now() - 1000 });
  (flaky as unknown as { tick(): void }).tick();
  await settle();
  const afterFail = db.getScheduledTask(retried)!;
  check("a failed run-once dispatch re-arms it", afterFail.enabled === true && afterFail.nextRunAt != null && afterFail.nextRunAt - Date.now() < 15 * 60_000);
  check("a failed run-once dispatch records no run", afterFail.lastRunAt == null);
  failNext = false;
  db.updateScheduledTask(retried, { nextRunAt: Date.now() - 1000 });
  const beforeRetry = dispatched.length;
  (flaky as unknown as { tick(): void }).tick();
  await settle();
  check("the retry fires and then disables it", dispatched.length === beforeRetry + 1 && db.getScheduledTask(retried)!.enabled === false);
  failNext = true;
  const exhausted = flaky.create({ title: "Exhausted", workspace: ws, prompt: "remind", cron: "0 12 3 11 *", runOnce: true }).schedule!.id;
  for (let i = 0; i < 5; i++) {
    db.updateScheduledTask(exhausted, { nextRunAt: Date.now() - 1000 });
    (flaky as unknown as { tick(): void }).tick();
    await settle();
  }
  check("retries are capped, then it stays off", db.getScheduledTask(exhausted)!.enabled === false);
  flaky.remove(retried);
  flaky.remove(exhausted);

  console.log("scheduler: reminders reach the owner's DMs");
  // 2026-10-01: every "Reminder: …" schedule fired a full implementor+QA task, and the phone only ever got
  // the generic "Done — <title>" notice, never the reminder itself (and nothing at all unless the task
  // ended Done). A reminder is now a message the scheduler sends itself, at the moment it fires.
  check("a schedule needs a prompt or a reminder", !scheduler.create({ title: "Empty", workspace: ws, prompt: "", cron: "0 9 * * *" }).ok);
  const remindOnly = scheduler.create({ title: "Vota reset", workspace: "", prompt: "", reminder: "  Use your Vota reset before Oct 22.  ", cron: "0 9 15 10 *", runOnce: true });
  check("a reminder needs no prompt and no repo", remindOnly.ok && remindOnly.schedule?.prompt === "" && remindOnly.schedule?.workspace === "");
  check("the reminder text is stored trimmed", remindOnly.schedule?.reminder === "Use your Vota reset before Oct 22.");
  check("a reload reads the reminder back", db.getScheduledTask(remindOnly.schedule!.id)?.reminder === "Use your Vota reset before Oct 22.");
  check("a prompt still needs a repo", !scheduler.create({ title: "No repo", workspace: "", prompt: "audit", cron: "0 9 * * *" }).ok);
  check("an ordinary schedule has no reminder", db.getScheduledTask(id)?.reminder == null);
  const remindId = remindOnly.schedule!.id;
  db.updateScheduledTask(remindId, { nextRunAt: Date.now() - 1000 });
  const beforeRemind = dispatched.length;
  reminded.length = 0;
  tick();
  await settle();
  check("a due reminder is sent to the owner", reminded.length === 1 && reminded[0]!.text === "Use your Vota reset before Oct 22." && reminded[0]!.title === "Vota reset");
  check("a reminder-only fire starts no agent", dispatched.length === beforeRemind);
  check("a fired run-once reminder switches itself off", db.getScheduledTask(remindId)!.enabled === false && db.getScheduledTask(remindId)!.nextRunAt == null);
  check("the fire is recorded as its last run", db.getScheduledTask(remindId)!.lastRunAt != null);
  tick();
  await settle();
  check("it is sent exactly once", reminded.length === 1);
  reminded.length = 0;
  await scheduler.runNow(remindId);
  await settle();
  check("Run now sends the reminder too", reminded.length === 1 && dispatched.length === beforeRemind);

  // A reminder beside a prompt sends the DM AND starts the work, e.g. "the VAT return is due; start on it".
  const both = scheduler.create({ title: "VAT return", workspace: ws, prompt: "prepare the VAT return", reminder: "The Q3 VAT return is due 1 December.", cron: "0 12 3 11 *", runOnce: true }).schedule!.id;
  db.updateScheduledTask(both, { nextRunAt: Date.now() - 1000 });
  reminded.length = 0;
  const beforeBoth = dispatched.length;
  tick();
  await settle();
  check("a reminder with a prompt sends the DM", reminded.length === 1 && reminded[0]!.text.includes("Q3 VAT"));
  check("…and dispatches the task", dispatched.length === beforeBoth + 1 && dispatched.at(-1)!.brief === "prepare the VAT return");
  scheduler.remove(both);

  // A recurring fire whose predecessor still works skips the TASK, never the reminder: the reminder is
  // about the clock, and holding it back until some agent finishes would deliver it late or never.
  const nag = scheduler.create({ title: "Stand up", workspace: ws, prompt: "check posture", reminder: "Stand up and stretch.", cron: "0 * * * *" }).schedule!.id;
  db.updateThread(prev.id, { state: "implementing" });
  db.updateScheduledTask(nag, { lastThreadId: prev.id, nextRunAt: Date.now() - 1000 });
  reminded.length = 0;
  const beforeNag = dispatched.length;
  tick();
  await settle();
  check("a busy predecessor skips the task", dispatched.length === beforeNag);
  check("…but the reminder still goes out on time", reminded.length === 1 && reminded[0]!.text === "Stand up and stretch.");
  db.updateThread(prev.id, { state: "done" });
  scheduler.update(nag, { reminder: null });
  check("clearing the reminder keeps the schedule's prompt", db.getScheduledTask(nag)!.reminder == null && db.getScheduledTask(nag)!.prompt === "check posture");
  check("a schedule cannot be emptied of both", !scheduler.update(remindId, { reminder: null }).ok && db.getScheduledTask(remindId)!.reminder != null);
  scheduler.remove(nag);

  // A DM that does not get through must still reach the owner: the note list is durable across the
  // restarts a deploy causes, and the DM keeps being retried.
  const retrying = new Scheduler(db, hub, dispatch, reminders, [10, 10]);
  const lost = retrying.create({ title: "Credits", workspace: "", prompt: "", reminder: "Use the cloud credits.", cron: "0 9 29 10 *", runOnce: true }).schedule!.id;
  db.updateScheduledTask(lost, { nextRunAt: Date.now() - 1000 });
  reminded.length = 0;
  fallbacks.length = 0;
  refuseReminders = 1;
  (retrying as unknown as { tick(): void }).tick();
  await settle();
  await settle();
  check("a refused reminder lands on the note list", fallbacks.length === 1 && fallbacks[0]!.text === "Use the cloud credits." && fallbacks[0]!.why.includes("500"));
  check("…and the DM is retried until it goes through", reminded.length === 2);
  refuseReminders = 5;
  reminded.length = 0;
  fallbacks.length = 0;
  await retrying.runNow(lost);
  for (let i = 0; i < 5; i++) await settle();
  check(`retries are bounded (${reminded.length} attempts)`, reminded.length === 3);
  check("…and the note is posted once, not per attempt", fallbacks.length === 1);
  refuseReminders = 0;
  retrying.remove(lost);
  scheduler.remove(remindId);

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
