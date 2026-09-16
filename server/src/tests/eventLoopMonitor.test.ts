/**
 * Gate: the event-loop measurement, and the restart it is allowed to refuse.
 *
 * Why this exists (2026-09-16): the owner reported GGO "restarting all the time" with no task of its own
 * running. It was not crashing — crash.log held no fault since 09-11. script-hub's keepAlive probes
 * /api/health, and two timed-out probes make it ask this server's restart coordinator to recover the
 * process, which tree-kills the agents mid-run. The probes timed out because this process's event loop
 * stalls for seconds at a time (measured from outside: 800 probes in five minutes, 19 over a second,
 * worst 30s) against a health route that is a cached object literal.
 *
 * Two halves are pinned here, and they fail in opposite directions:
 *   - the MONITOR must actually see a stall and name what was in flight, or the next agent reverse-
 *     engineers this from script-hub's log again;
 *   - the REFUSAL must hold for a process that is merely slow and give way for one that is genuinely
 *     wedged, or it becomes either a restart loop again or an unrecoverable server.
 *
 * Run: npm run test:event-loop   (free, no agent, no quota)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartAttempt } from "../selfRestart.js";

const {
  eventLoopHealth,
  eventLoopIsResponsive,
  recordBlockForTest,
  resetEventLoopMonitor,
  startEventLoopMonitor,
  trackBlocking,
  trackBlockingSync,
} = await import("../eventLoopMonitor.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { RestartCoordinator, isHealthRecoveryRequest } = await import("../orchestrator/restartCoordinator.js");

let failures = 0;
function check(name: string, condition: unknown, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HUB_LABEL = "script-hub health recovery: claude-orchestrator";
const PENDING_KEY = "restart_coordinator_pending";
const dir = mkdtempSync(join(tmpdir(), "event-loop-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("\nmonitor: a stall is seen, and it names its suspect");
  resetEventLoopMonitor();
  check("a quiet loop reports no blocks and stays responsive", eventLoopHealth().blocks === 0 && eventLoopIsResponsive());

  recordBlockForTest(4_000);
  const afterOne = eventLoopHealth();
  check("a recorded stall is counted", afterOne.blocks === 1, `blocks=${afterOne.blocks}`);
  check("its worst lag is reported in ms", afterOne.worstLagMs === 4_000, String(afterOne.worstLagMs));
  check(
    "a stall with nothing declared in flight blames nobody rather than guessing",
    afterOne.worstBlame === null,
    String(afterOne.worstBlame),
  );

  resetEventLoopMonitor();
  trackBlockingSync("codex usage ping (spawn app-server)", () => {
    // The stall is detected only AFTER the blocking call returns, so attribution has to look at the
    // interval the loop was frozen for, not at what is in flight at the moment of detection.
    recordBlockForTest(3_000);
  });
  const blamed = eventLoopHealth();
  check(
    "a stall overlapping a tracked operation names it",
    blamed.worstBlame?.includes("codex usage ping") === true,
    String(blamed.worstBlame),
  );

  resetEventLoopMonitor();
  trackBlockingSync("grok usage scrape (spawn winpty + grok)", () => undefined);
  await sleep(5);
  recordBlockForTest(10);
  recordBlockForTest(2_000);
  check(
    "an operation that finished just before the stall is still a suspect",
    eventLoopHealth().worstBlame?.includes("grok usage scrape") === true,
    String(eventLoopHealth().worstBlame),
  );

  console.log("\nmonitor: observation never changes what it observes");
  resetEventLoopMonitor();
  check("trackBlockingSync returns the call's own value", trackBlockingSync("x", () => 42) === 42);
  check("trackBlocking resolves the call's own value", (await trackBlocking("x", async () => "v")) === "v");
  let threw = false;
  try {
    await trackBlocking("x", async () => {
      throw new Error("boom");
    });
  } catch (e) {
    threw = (e as Error).message === "boom";
  }
  check("trackBlocking rethrows rather than swallowing a failure", threw);
  let syncThrew = false;
  try {
    trackBlockingSync("x", () => {
      throw new Error("bang");
    });
  } catch (e) {
    syncThrew = (e as Error).message === "bang";
  }
  check("trackBlockingSync rethrows too", syncThrew);

  console.log("\nmonitor: responsive vs genuinely wedged");
  resetEventLoopMonitor();
  const window = eventLoopHealth().windowMs;
  recordBlockForTest(window * 0.3);
  check("a loop stalling for a third of the window is degraded but still serving", eventLoopIsResponsive());
  recordBlockForTest(window * 0.3);
  check(
    "a loop blocked for most of the window is not serving, and recovery is warranted",
    !eventLoopIsResponsive(),
    JSON.stringify(eventLoopHealth()),
  );

  console.log("\nmonitor: the sampler runs and stops");
  resetEventLoopMonitor();
  const stop = startEventLoopMonitor(10, 60_000);
  const blockingStart = Date.now();
  while (Date.now() - blockingStart < 1_200) {
    // Deliberately hog the thread: this is the condition the whole feature exists to detect, so the gate
    // reproduces it rather than trusting the injected test seam alone.
  }
  await sleep(40);
  const sampled = eventLoopHealth();
  stop();
  check("a real blocked thread is detected by the sampler", sampled.blocks >= 1, JSON.stringify(sampled));
  check("and its measured lag is on the order of the block", sampled.worstLagMs >= 900, String(sampled.worstLagMs));

  console.log("\nlabel: which requests claim this process is broken");
  check("the exact label script-hub sends is recognised", isHealthRecoveryRequest(HUB_LABEL));
  check("matching ignores case and padding", isHealthRecoveryRequest("  Script-Hub Health Recovery: x  "));
  check("a deploy is not a health recovery", !isHealthRecoveryRequest("deploy abc1234"));
  check("an owner update is not a health recovery", !isHealthRecoveryRequest("owner update"));
  check("a missing label is not a health recovery", !isHealthRecoveryRequest(null));

  console.log("\ncoordinator: a health recovery of a serving process is refused");
  {
    const db = new Db(join(dir, "refuse.sqlite"));
    const hub = new EventHub();
    let restarts = 0;
    const coordinator = new RestartCoordinator({
      db,
      hub,
      activeWork: () => 0, // idle: it COULD restart, which is exactly what makes the refusal meaningful
      settleMs: 0,
      loopResponsive: () => true,
      restart: async (): Promise<RestartAttempt> => {
        restarts++;
        return { route: "hub", ok: true, detail: "stub" };
      },
    });
    const result = coordinator.request({ label: HUB_LABEL });
    check("the outcome is a refusal", result.outcome === "refused", result.outcome);
    check(
      "which script-hub reads as NOT accepted (it counts only restarting/deferred)",
      result.outcome !== "restarting" && result.outcome !== "deferred",
    );
    check("nothing is staged", result.staged === 0, String(result.staged));
    check("the durable pending row stays empty", !db.kvGet(PENDING_KEY), String(db.kvGet(PENDING_KEY)));
    await sleep(30);
    check("no restart is fired", restarts === 0, String(restarts));
    check(
      "the reason carries the measurement, so the refusal is auditable rather than a bare no",
      /event loop was blocked/.test(result.reason) && /kill live agent runs/.test(result.reason),
      result.reason,
    );

    // keepAlive neither backs off nor arms its cooldown on a refusal, so it re-asks every sweep.
    let refusalLogs = 0;
    const unsubscribe = hub.subscribe((e) => {
      if (e.type === "log" && /refused a health recovery/.test((e as { message: string }).message)) refusalLogs++;
    });
    const repeats = [1, 2, 3, 4].map(() => coordinator.request({ label: HUB_LABEL }));
    unsubscribe();
    check("every repeat is refused — the throttle is on the log, never on the answer", repeats.every((r) => r.outcome === "refused"));
    check("but a stally hour does not fill the console with the same line", refusalLogs === 0, String(refusalLogs));
    await sleep(20);
    check("and still nothing is staged or fired", restarts === 0 && !db.kvGet(PENDING_KEY));
    db.raw.close();
  }

  console.log("\ncoordinator: a genuinely wedged process may still be recovered");
  {
    const db = new Db(join(dir, "wedged.sqlite"));
    const hub = new EventHub();
    let restarts = 0;
    const coordinator = new RestartCoordinator({
      db,
      hub,
      activeWork: () => 0,
      settleMs: 0,
      loopResponsive: () => false,
      restart: async (): Promise<RestartAttempt> => {
        restarts++;
        return { route: "hub", ok: true, detail: "stub" };
      },
    });
    const result = coordinator.request({ label: HUB_LABEL });
    check("the request is not refused", result.outcome !== "refused", result.outcome);
    await sleep(60);
    check("and the recovery restart actually fires", restarts === 1, String(restarts));
    db.raw.close();
  }

  console.log("\ncoordinator: ordinary deploys are untouched");
  {
    const db = new Db(join(dir, "deploy.sqlite"));
    const hub = new EventHub();
    const coordinator = new RestartCoordinator({
      db,
      hub,
      activeWork: () => 2, // busy, so a real deploy must stage and wait rather than restart
      settleMs: 0,
      loopResponsive: () => true,
      restart: async (): Promise<RestartAttempt> => ({ route: "hub", ok: true, detail: "stub" }),
    });
    const result = coordinator.request({ label: "deploy abc1234", commit: "abc1234", stampedAt: Date.now() });
    check("a deploy still defers behind active work", result.outcome === "deferred", result.outcome);
    check("and is staged durably", !!db.kvGet(PENDING_KEY));
    db.raw.close();
  }

  console.log("\ncoordinator: a health recovery staged by an older build never fires");
  {
    const db = new Db(join(dir, "stale.sqlite"));
    const hub = new EventHub();
    // Exactly the row found live on 2026-09-16: staged at 09:12, still waiting to kill the server hours
    // and two boots later.
    db.kvSet(
      PENDING_KEY,
      JSON.stringify({
        createdAt: 1789549956961,
        requesters: [{ at: 1789549956961, label: HUB_LABEL, commit: null, stampedAt: null }],
        failures: 0,
        retryAt: null,
      }),
    );
    let restarts = 0;
    const coordinator = new RestartCoordinator({
      db,
      hub,
      activeWork: () => 0,
      settleMs: 0,
      loopResponsive: () => true,
      restart: async (): Promise<RestartAttempt> => {
        restarts++;
        return { route: "hub", ok: true, detail: "stub" };
      },
    });
    coordinator.start();
    await sleep(60);
    check("the stale recovery is dropped, not fired", restarts === 0, String(restarts));
    check("and the durable row is cleared so it cannot fire later either", !db.kvGet(PENDING_KEY), String(db.kvGet(PENDING_KEY)));
    db.raw.close();
  }

  console.log("\ncoordinator: a real staged build beside a stale recovery survives");
  {
    const db = new Db(join(dir, "mixed.sqlite"));
    const hub = new EventHub();
    db.kvSet(
      PENDING_KEY,
      JSON.stringify({
        createdAt: 1789549956961,
        requesters: [
          { at: 1789549956961, label: HUB_LABEL, commit: null, stampedAt: null },
          { at: 1789549999999, label: "deploy abc1234", commit: "abc1234", stampedAt: null },
        ],
        failures: 0,
        retryAt: null,
      }),
    );
    const coordinator = new RestartCoordinator({
      db,
      hub,
      activeWork: () => 3,
      settleMs: 0,
      loopResponsive: () => true,
      restart: async (): Promise<RestartAttempt> => ({ route: "hub", ok: true, detail: "stub" }),
    });
    coordinator.start();
    const status = coordinator.status();
    check("the staged build is kept", status.pending?.requesters.length === 1, JSON.stringify(status.pending));
    check("and it is the deploy, not the recovery", status.pending?.requesters[0]?.commit === "abc1234");
    check("the durable row still holds it", (db.kvGet(PENDING_KEY) ?? "").includes("abc1234"));
    check("and the recovery requester is gone from it", !(db.kvGet(PENDING_KEY) ?? "").includes("health recovery"));
    db.raw.close();
  }

  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"}: ${failures} failed`);
}

try {
  await main();
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the sqlite file briefly; the temp dir is disposable either way.
  }
}
process.exit(failures === 0 ? 0 : 1);
