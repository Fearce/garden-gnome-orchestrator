/**
 * Integration test — a dispatch shows its card at once and does not queue behind the board's git reads.
 *
 * 2026-09-27: "every time I write something, try to create a task, inject something, I have to wait
 * multiple minutes." The owner's message was stored instantly; the "dispatched" confirmation came 52, 63,
 * 73 and 272 seconds later. `dispatch` awaited a `git rev-parse HEAD` for the task's baseline BEFORE it
 * published the card, and that one read waited at the back of the two-worker git pool behind a few hundred
 * Changes-chip reads from the board.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `ThreadManager.dispatch`, the real `Db`/`EventHub`, the real git pool, and a throwaway git repo.
 *  - STUBBED: only `startPipeline`, the agent-spawning leaf, which records the ids it was handed.
 *
 * Run:  npm run test:dispatch-latency   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
// Under suite load one git spawn here can stall past the 15s default (2 in 10 reproduced 2026-09-28), and
// a timed-out baseline read is null by design. This gate is about queue order, not that timeout.
process.env.GIT_READ_TIMEOUT_MS = "60000";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { runChild, stopChildRunner, childRunnerState } = await import("../childRunner.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
}

function makeRepo(root: string): string {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--quiet", repo], { windowsHide: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" }).trim();
  git("config", "user.name", "Dispatch Test");
  git("config", "user.email", "dispatch-test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "base");
  return repo;
}

const root = mkdtempSync(join(tmpdir(), "dispatch-latency-"));
const db = new Db(join(root, "orchestrator.sqlite"));
const hub = new EventHub();
const mgr = new ThreadManager(db, hub, new FileMemoryService(join(root, "memory")), new StubAccounts() as unknown as AccountManager);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = mgr as any;
const started: string[] = [];
internals.startPipeline = (id: string): void => {
  started.push(id);
};

try {
  const repo = makeRepo(root);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

  console.log("\nA. the card is published before the baseline git read, and the task still starts");
  {
    let baselineAtPublish: string | null | undefined;
    const unsubscribe = hub.subscribe((ev) => {
      if (ev.type === "thread.upsert" && ev.thread.title === "publish-first" && baselineAtPublish === undefined) {
        baselineAtPublish = db.getThread(ev.thread.id)?.baselineHead ?? null;
      }
    });
    const id = await mgr.dispatch({ title: "publish-first", workspace: repo, brief: "b" });
    unsubscribe();
    check("thread.upsert fired before the baseline was stamped", baselineAtPublish === null, String(baselineAtPublish));
    check("the baseline is still stamped once the read returns", db.getThread(id)?.baselineHead === head, String(db.getThread(id)?.baselineHead));
    check("the task was handed to the pipeline", started.includes(id));
  }

  console.log("\nB. a task cancelled while its baseline was read is not revived");
  {
    const unsubscribe = hub.subscribe((ev) => {
      // cancelThread's effect on the row, applied synchronously so the window is hit deterministically.
      if (ev.type === "thread.upsert" && ev.thread.title === "cancel-in-window" && ev.thread.state === "intake") {
        internals.setState(ev.thread.id, "cancelled");
      }
    });
    const id = await mgr.dispatch({ title: "cancel-in-window", workspace: repo, brief: "b" });
    unsubscribe();
    check("the cancelled task never reached the pipeline", !started.includes(id));
    check("it stays cancelled", db.getThread(id)?.state === "cancelled", db.getThread(id)?.state);
  }

  console.log("\nC. a dispatch does not wait for ordinary git reads that fill the pool");
  {
    const order: string[] = [];
    // Each blocker holds its worker until the test drops the release file (or 30s pass), so the pool stays
    // full for as long as dispatch takes — however slow the box — and only the urgent reserve can serve it.
    const release = join(root, "release-blockers");
    const hold = "const fs=require('fs');const t=Date.now();setInterval(()=>{if(fs.existsSync(process.argv[1])||Date.now()-t>30000)process.exit(0)},50)";
    const blockers = Array.from({ length: 6 }, (_, i) =>
      runChild(process.execPath, ["-e", hold, release], { timeoutMs: 60_000 }).then(() => order.push(`blocker${i}`)),
    );
    await new Promise((r) => setTimeout(r, 100));
    const queued = childRunnerState().queued;
    const dispatchStart = Date.now();
    const id = await mgr.dispatch({ title: "busy-pool", workspace: repo, brief: "b" });
    const dispatchMs = Date.now() - dispatchStart;
    order.push("dispatch");
    writeFileSync(release, "");
    await Promise.all(blockers);
    check("some ordinary reads really were queued behind a full pool", queued > 0, `queued=${queued}`);
    check("dispatch returned while every ordinary read still held or waited for a worker", order[0] === "dispatch", order.join(", "));
    check(
      "and it still stamped the baseline",
      db.getThread(id)?.baselineHead === head,
      `${db.getThread(id)?.baselineHead} after a ${dispatchMs}ms dispatch`,
    );
  }
} finally {
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  await new Promise((r) => setTimeout(r, 200));
  db.raw.close();
  await stopChildRunner();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exitCode = 1;
}
