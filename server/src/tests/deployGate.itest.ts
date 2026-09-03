// Deterministic test for the deploy gate — how often an AGENT may bounce this server.
// Temp DB + a real EventHub, the restart itself stubbed. No agents, no hub, no quota.
// Run: `npm run test:deploy-gate`.
//
// The gate exists because the owner asked for it in those words: several tasks each finishing their own
// patch were restarting the console every few minutes while he worked. So the properties held here ARE
// the contract, not implementation detail:
//   - while the board is busy, agent restarts collapse to one per window;
//   - a deploy is never REFUSED, only deferred, and the gate fires the held bounce itself;
//   - the hold is durable, because the thing it waits for (a restart) destroys any in-memory timer;
//   - it drains early when the board quiets, and never strands a build after a refused fire.
// Windows are milliseconds here; in production they are an hour.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import {
  ACTIVE_TASK_STATES,
  DeployGate,
  decideDeploy,
  isLoopbackAddress,
  type DeployGateDeps,
  type PendingRestart,
} from "../orchestrator/deployGate.js";
import { hubRestartWasANoop, type RestartAttempt } from "../selfRestart.js";
import type { ThreadState } from "../types.js";
import type { ServerEvent } from "../ws/protocol.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
const db = new Db(join(dir, "t.sqlite"));
const hub = new EventHub();

const notices: Array<{ title: string; message: string }> = [];
hub.subscribe((e: ServerEvent) => {
  if (e.type === "notice") notices.push({ title: e.title, message: e.message });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PENDING_KEY = "deploy_gate_pending";
const LAST_RESTART_KEY = "deploy_gate_last_restart_at";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (what()) return true;
    await sleep(25);
  }
  return what();
}

/** A gate whose bounce is observable instead of fatal. Every knob a scenario needs is explicit, so no
 *  test depends on a default that a later tuning change could move. */
function gateWith(over: Partial<DeployGateDeps> & { ok?: boolean } = {}): {
  gate: DeployGate;
  restarts: () => number;
} {
  let restarts = 0;
  const gate = new DeployGate({
    db,
    hub,
    activeTasks: () => db.countThreadsInStates(ACTIVE_TASK_STATES),
    window: { minIntervalMs: HOUR, minActiveTasks: 2 },
    pollMs: 1_000,
    settleMs: 0,
    bootGraceMs: 0,
    bootedAt: Date.now() - HOUR,
    restart: async (): Promise<RestartAttempt> => {
      restarts++;
      return over.ok === false
        ? { route: "hub", ok: false, detail: "the script-hub reported a restart that killed nothing" }
        : { route: "hub", ok: true, detail: "accepted" };
    },
    ...over,
  });
  return { gate, restarts: () => restarts };
}

function seedThread(state: ThreadState): string {
  const t = db.createThread({ title: `task ${state}`, workspace: join(dir, "workspace"), rawPrompt: "p" });
  db.updateThread(t.id, { state });
  return t.id;
}

function clearBoard(): void {
  for (const t of db.listThreads()) db.updateThread(t.id, { state: "done" });
}

function pendingRow(): PendingRestart | null {
  const raw = db.kvGet(PENDING_KEY);
  return raw ? (JSON.parse(raw) as PendingRestart) : null;
}

async function main(): Promise<void> {
  // ---- the policy, as a pure function ----

  console.log("decide: the window only closes while the owner is multitasking");
  {
    const base = { now: 1_000_000, lastRestartAt: 1_000_000 - MINUTE, minIntervalMs: HOUR, minActiveTasks: 2 };
    check("one task running bounces immediately", decideDeploy({ ...base, activeTasks: 1 }).allow);
    check("two running holds it", !decideDeploy({ ...base, activeTasks: 2 }).allow);
    check("a zero interval disables the gate entirely", decideDeploy({ ...base, activeTasks: 5, minIntervalMs: 0 }).allow);
    check(
      "a bounce older than the window is allowed again",
      decideDeploy({ ...base, activeTasks: 5, lastRestartAt: base.now - HOUR - 1 }).allow,
    );
    check(
      "exactly one window is enough — the boundary allows",
      decideDeploy({ ...base, activeTasks: 5, lastRestartAt: base.now - HOUR }).allow,
    );
  }

  console.log("decide: a held restart names when it may go, and can never be held longer than one window");
  {
    const now = 1_000_000;
    const held = decideDeploy({ now, lastRestartAt: now - 10 * MINUTE, activeTasks: 3, minIntervalMs: HOUR, minActiveTasks: 2 });
    check("readyAt is one window after the last bounce", !held.allow && held.readyAt === now - 10 * MINUTE + HOUR);
    check("the reason names the board and the wait", !held.allow && /3 tasks/.test(held.reason) && /10m ago/.test(held.reason));
    // A clock step or a hand-edited kv row must drain, not park deploys forever.
    const skewed = decideDeploy({ now, lastRestartAt: now + 5 * HOUR, activeTasks: 3, minIntervalMs: HOUR, minActiveTasks: 2 });
    check("a future last-restart is clamped to one window from now", !skewed.allow && skewed.readyAt === now + HOUR);
    check("...and says why", !skewed.allow && /clock skew/.test(skewed.reason));
  }

  // ---- the board the gate reads ----

  console.log("board: the active states are the ones an agent is live in");
  {
    clearBoard();
    const states: ThreadState[] = [
      "intake", "enriching", "queued", "awaiting_user", "planning", "researching", "awaiting_approval",
      "implementing", "qa", "paused", "review", "reviewing", "done", "failed", "cancelled", "closed",
    ];
    for (const s of states) seedThread(s);
    check(
      "every ACTIVE_TASK_STATE is counted and nothing else is",
      db.countThreadsInStates(ACTIVE_TASK_STATES) === ACTIVE_TASK_STATES.length,
    );
    check("a queued or parked task is not 'running'", !ACTIVE_TASK_STATES.includes("queued") && !ACTIVE_TASK_STATES.includes("review"));
  }

  // ---- the gate ----

  console.log("gate: a busy board gets at most one restart inside the window");
  {
    clearBoard();
    seedThread("implementing");
    seedThread("qa");
    db.kvSet(PENDING_KEY, "");
    db.kvSet(LAST_RESTART_KEY, "");
    const { gate, restarts } = gateWith();
    const first = gate.request({ label: "implementor · first patch", stampedAt: Date.now() });
    check("the open window admits the first patch", first.outcome === "restarting");
    check("the first patch spends exactly one restart", await waitFor(() => restarts() === 1));
    const second = gate.request({ label: "implementor · second patch", stampedAt: Date.now() });
    check("the next patch inside the hour is held", second.outcome === "deferred" && !!pendingRow());
    check("the second patch cannot spend another restart", restarts() === 1);
    gate.stop();
    db.kvSet(PENDING_KEY, "");
  }

  console.log("gate: a quiet board bounces immediately");
  {
    clearBoard();
    seedThread("implementing");
    const { gate, restarts } = gateWith();
    const res = gate.request({ label: "implementor · a small fix", commit: "abc1234", stampedAt: Date.now() });
    check("the caller is told it is restarting", res.outcome === "restarting");
    check("...naming the board it judged", res.activeTasks === 1);
    check("the restart actually fires", await waitFor(() => restarts() === 1));
    check("nothing is left pending", pendingRow() === null);
    gate.stop();
  }

  console.log("gate: a busy board holds the restart instead of refusing it");
  {
    clearBoard();
    seedThread("implementing");
    seedThread("qa");
    db.kvSet(PENDING_KEY, "");
    db.kvSet(LAST_RESTART_KEY, String(Date.now() - 10 * MINUTE));
    notices.length = 0;
    const { gate, restarts } = gateWith();
    const res = gate.request({ label: "implementor · task A", commit: "aaaaaaa", stampedAt: Date.now() });

    check("the deploy is deferred, never refused", res.outcome === "deferred");
    check("it is told when it goes live", res.readyAt !== null && res.waitMs > 45 * MINUTE);
    check("...preformatted, so the deploy script need not re-invent the wording", !!res.readyAtLabel && /^\d+m$|^\d+h/.test(res.waitLabel));
    check("nothing bounced", restarts() === 0);
    check("the hold is durable", pendingRow()?.requesters.length === 1);
    check("the owner is told why the console is not reloading", notices.length === 1 && /won't bounce again/.test(notices[0]?.message ?? ""));

    const second = gate.request({ label: "implementor · task B", commit: "bbbbbbb", stampedAt: Date.now() });
    check("a second deploy rides the same restart", second.outcome === "deferred" && second.staged === 2);
    check("...without pushing the wait further out", second.readyAt === res.readyAt);
    check("...and without a second banner", notices.length === 1);
    check("still nothing bounced", restarts() === 0);
    gate.stop();
  }

  console.log("gate: the hold survives the process that made it");
  {
    // The whole reason the record is in kv: what it is waiting for KILLS the timer holding it.
    const carried = pendingRow();
    check("the previous scenario left a hold behind", carried?.requesters.length === 2);
    const { gate, restarts } = gateWith({ bootedAt: Date.now() - HOUR });
    gate.start();
    check("a fresh gate re-arms it rather than losing it", pendingRow()?.requesters.length === 2);
    check("and does not bounce on sight", restarts() === 0);

    // The board quieting down opens the window EARLY — a bounce is cheap again, so waiting out the
    // rest of the hour would be pointless.
    clearBoard();
    seedThread("implementing");
    check("the held restart fires once the board is quiet", await waitFor(() => restarts() === 1, 4_000));
    check("the hold is consumed, not repeated", pendingRow() === null);
    gate.stop();
  }

  console.log("gate: a bounce that did not happen must not cost a whole silent window");
  {
    clearBoard();
    seedThread("implementing");
    seedThread("qa");
    db.kvSet(PENDING_KEY, "");
    const before = Date.now();
    db.kvSet(LAST_RESTART_KEY, String(before));
    const { gate, restarts } = gateWith({ ok: false, window: { minIntervalMs: 300, minActiveTasks: 2 } });
    gate.request({ label: "implementor · task C", commit: "ccccccc", stampedAt: Date.now() });
    check("held first", restarts() === 0 && !!pendingRow());
    check("then fired when the window opened", await waitFor(() => restarts() === 1, 4_000));
    check("the refused fire re-arms rather than dropping the build", await waitFor(() => (pendingRow()?.failures ?? 0) === 1, 2_000));
    check("...still holding the staged build", pendingRow()?.requesters[0]?.commit === "ccccccc");
    check("...and gives the window back, since nothing was interrupted", Number(db.kvGet(LAST_RESTART_KEY)) === before);
    check("the owner is not spammed on the first failure", !notices.some((n) => n.title === "Restart refused"));
    gate.stop();
  }

  console.log("gate: a build some other bounce already deployed is dropped, not re-fired");
  {
    // A crash-respawn, keepAlive or the owner's own update click deploys whatever dist holds — for free.
    // Firing the held restart afterwards would spend an interruption on code that is already running.
    clearBoard();
    seedThread("implementing");
    seedThread("qa");
    const stampedAt = Date.now() - 5 * MINUTE;
    db.kvSet(
      PENDING_KEY,
      JSON.stringify({
        readyAt: Date.now() + HOUR,
        createdAt: stampedAt,
        requesters: [{ at: stampedAt, label: "implementor · task D", commit: "ddddddd", stampedAt }],
        failures: 0,
      } satisfies PendingRestart),
    );
    const { gate, restarts } = gateWith({ liveBuild: () => ({ at: stampedAt }) });
    gate.start();
    check("the moot hold is cleared at boot", pendingRow() === null);
    check("and no restart is spent on it", restarts() === 0);
    gate.stop();

    // An OLDER live build proves nothing about the staged one, so that hold must stay.
    db.kvSet(
      PENDING_KEY,
      JSON.stringify({
        readyAt: Date.now() + HOUR,
        createdAt: stampedAt,
        requesters: [{ at: stampedAt, label: "implementor · task D", commit: "ddddddd", stampedAt }],
        failures: 0,
      } satisfies PendingRestart),
    );
    const older = gateWith({ liveBuild: () => ({ at: stampedAt - MINUTE }) });
    older.gate.start();
    check("a hold for a NEWER build than the live one is kept", pendingRow()?.requesters.length === 1);
    older.gate.stop();

    // An unstamped build is never assumed live — the optimistic mistake strands a build silently.
    const unstamped = gateWith({ liveBuild: () => ({ at: null }) });
    unstamped.gate.start();
    check("an unstamped live build cannot clear a hold", pendingRow()?.requesters.length === 1);
    unstamped.gate.stop();
    db.kvSet(PENDING_KEY, "");
  }

  console.log("gate: the board is not readable for the first seconds after a boot");
  {
    // A restart puts every interrupted task OUT of a running state until the auto-resume timer fires.
    // Firing into that window would read "quiet", bounce, and kill the resume it was waiting for.
    clearBoard();
    seedThread("implementing");
    db.kvSet(
      PENDING_KEY,
      JSON.stringify({
        readyAt: Date.now() - MINUTE,
        createdAt: Date.now() - HOUR,
        requesters: [{ at: Date.now() - HOUR, label: "implementor · task E", commit: "eeeeeee", stampedAt: null }],
        failures: 0,
      } satisfies PendingRestart),
    );
    const { gate, restarts } = gateWith({ bootedAt: Date.now(), bootGraceMs: 30_000 });
    gate.start();
    await sleep(1_200);
    check("an overdue restart still waits out the boot grace", restarts() === 0 && !!pendingRow());
    gate.stop();
    db.kvSet(PENDING_KEY, "");
  }

  console.log("gate: a board it cannot read is assumed busy");
  {
    // The bias is one-way on purpose: a wrong 'hold' costs a delay, a wrong 'bounce' costs the owner
    // the interruption this whole thing exists to prevent.
    db.kvSet(LAST_RESTART_KEY, String(Date.now()));
    const { gate, restarts } = gateWith({
      activeTasks: () => {
        throw new Error("the board blew up");
      },
    });
    const res = gate.request({ label: "implementor · task F", commit: "fffffff", stampedAt: Date.now() });
    check("an unreadable board holds the restart", res.outcome === "deferred" && restarts() === 0);
    gate.stop();
    db.kvSet(PENDING_KEY, "");
  }

  console.log("gate: a clock correction cannot slide a held restart forever");
  {
    clearBoard();
    seedThread("implementing");
    seedThread("qa");
    db.kvSet(PENDING_KEY, "");
    db.kvSet(LAST_RESTART_KEY, "");
    const { gate, restarts } = gateWith({
      // Simulates the wall clock stepping backwards after this process started.
      bootedAt: Date.now() + HOUR,
      window: { minIntervalMs: 300, minActiveTasks: 2 },
    });
    const held = gate.request({ label: "implementor · task after clock skew", stampedAt: Date.now() });
    check("the skewed timestamp still holds for one bounded window", held.outcome === "deferred" && held.waitMs <= 300);
    check("the stable skew anchor drains instead of recomputing now + window forever", await waitFor(() => restarts() === 1, 3_000));
    gate.stop();
  }

  console.log("gate: status is what the deploy script reads back");
  {
    clearBoard();
    seedThread("implementing");
    seedThread("qa");
    db.kvSet(LAST_RESTART_KEY, String(Date.now()));
    const { gate } = gateWith();
    const before = gate.status();
    check("with nothing held it reports the live verdict", before.pending === null && !before.decision.allow);
    check("...and the window it is enforcing", before.minIntervalMs === HOUR && before.minActiveTasks === 2);
    gate.request({ label: "implementor · task G", commit: "9999999", stampedAt: Date.now() });
    const after = gate.status();
    check("a held restart is visible with its schedule", !!after.pending && !!after.pendingLabel);
    check("...listing what rides it", after.pending?.requesters[0]?.commit === "9999999");
    gate.stop();
    db.kvSet(PENDING_KEY, "");
  }

  console.log("routes: the gate answers a local child process, never the LAN");
  {
    check("IPv4 loopback", isLoopbackAddress("127.0.0.1"));
    check("IPv6 loopback", isLoopbackAddress("::1"));
    check("the IPv4-mapped form fastify reports on a dual-stack listener", isLoopbackAddress("::ffff:127.0.0.1"));
    check("the rest of 127/8", isLoopbackAddress("127.0.1.5"));
    check("a LAN address is not local", !isLoopbackAddress("192.168.0.122"));
    check("...nor one that merely reads like it", !isLoopbackAddress("12.7.0.1") && !isLoopbackAddress("10.0.0.1"));
    check("an absent address is not local", !isLoopbackAddress(undefined) && !isLoopbackAddress(""));
  }

  console.log("restart helper: a hub refusal never masquerades as a successful bounce");
  {
    check("ok:false is refused", hubRestartWasANoop({ ok: false }));
    check("an empty kill list is refused", hubRestartWasANoop({ ok: true, stop: { killed: [] } }));
    check("a killed listener is accepted", !hubRestartWasANoop({ ok: true, stop: { killed: [4242] } }));
    check("an absent reply is not invented into a refusal", !hubRestartWasANoop(null));
  }
}

main()
  .then(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
    if (failures) {
      console.error(`\ndeploy gate: FAILED (${failures})`);
      process.exit(1);
    }
    console.log("\nAll deploy-gate checks passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
