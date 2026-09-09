import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Db } from "../db/db.js";
import { acquireInstanceGuard } from "../instanceGuard.js";
import { recoveryHistoryBlock } from "../orchestrator/recoveryHistory.js";
import { testInvocationUsesDefaultData } from "../runtimeIsolation.js";
import {
  injectThreadWithReceipt,
  threadInjectionPayloadHash,
  type ThreadInjectionCommand,
} from "../ws/threadInjectionReceipt.js";

const lockProbePath = process.env.GGO_INSTANCE_LOCK_PROBE;
if (lockProbePath) {
  const unexpectedOwner = acquireInstanceGuard(lockProbePath);
  unexpectedOwner?.release();
  let unsafeRuntimeData = false;
  if (process.env.GGO_CRASH_LOG_PROBE) {
    const { config } = await import("../config.js");
    const { logCrash } = await import("../crashLog.js");
    unsafeRuntimeData = resolve(config.dataDir) === resolve(import.meta.dirname, "..", "..", "data");
    logCrash("testIsolation.probe", process.env.GGO_CRASH_LOG_PROBE);
  }
  process.exit(unexpectedOwner ? 2 : unsafeRuntimeData ? 3 : 0);
}

const dir = mkdtempSync(join(tmpdir(), "ggo-incident-recovery-"));

try {
  const lockPath = join(dir, "orchestrator.sqlite.owner.sqlite");
  const firstOwner = acquireInstanceGuard(lockPath);
  assert.ok(firstOwner, "the first process owns an unused data directory");
  assert.equal(acquireInstanceGuard(lockPath), null, "a duplicate process is denied before recovery");
  const crashMarker = `must-not-reach-production-${randomUUID()}`;
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, GGO_INSTANCE_LOCK_PROBE: lockPath, GGO_CRASH_LOG_PROBE: crashMarker },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(
    child.status,
    0,
    `a competing process must lose the owner lock before recovery (status=${child.status}; stderr=${child.stderr})`,
  );
  const productionCrashLog = join(import.meta.dirname, "..", "..", "data", "crash.log");
  assert.doesNotMatch(
    existsSync(productionCrashLog) ? readFileSync(productionCrashLog, "utf8") : "",
    new RegExp(crashMarker),
    "an un-isolated test child cannot append a forged production crash record",
  );
  firstOwner.release();
  const replacementOwner = acquireInstanceGuard(lockPath);
  assert.ok(replacementOwner, "the OS-backed lock is immediately reusable after a clean release");
  replacementOwner.release();
  assert.equal(
    testInvocationUsesDefaultData({ npm_lifecycle_event: "test:incident-recovery" }, ["node", "src/index.ts"]),
    true,
    "a test entrypoint cannot claim production recovery without an isolated data directory",
  );
  assert.equal(
    testInvocationUsesDefaultData({ npm_lifecycle_event: "test:incident-recovery", DATA_DIR: dir }, ["node", "src/index.ts"]),
    false,
    "a test entrypoint may boot against its explicit throwaway data directory",
  );
  assert.equal(
    testInvocationUsesDefaultData({}, ["node", join("repo", "server", "src", "tests", "usage.test.ts")]),
    true,
    "a directly invoked test file is isolated even outside an npm lifecycle",
  );
  assert.equal(
    testInvocationUsesDefaultData({}, ["node", join("repo", "web", "scripts", "navigation.test.tsx")]),
    true,
    "a directly invoked TSX UI test is isolated too",
  );
  assert.equal(
    testInvocationUsesDefaultData({}, ["node", join("repo", "server", "src", "index.ts")]),
    false,
    "an ordinary direct server launch still uses its configured production data",
  );

  const receiptDbPath = join(dir, "receipts.sqlite");
  let db = new Db(receiptDbPath);
  const thread = db.createThread({ title: "receipt test", workspace: dir, rawPrompt: "test" });
  const command: ThreadInjectionCommand = {
    threadId: thread.id,
    message: "preserve this exact owner instruction",
    mode: "append",
    clientId: "398c3fe4-2fa3-49a7-a74a-e73bf0c8595f",
  };
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const target = {
    injectThread: async () => {
      calls += 1;
      await gate;
      return { ok: true as const, state: "implementing" as const, message: "delivered" };
    },
  };

  const initial = injectThreadWithReceipt(db, target, command);
  const concurrentReplay = injectThreadWithReceipt(db, target, command);
  release();
  assert.deepEqual(await concurrentReplay, await initial, "concurrent replay shares the original result");
  assert.equal(calls, 1, "one correlation id cannot execute twice in one process");
  assert.equal(db.ownerCommandReceipt(command.clientId!)?.status, "completed", "the terminal receipt is durable");
  assert.deepEqual(await injectThreadWithReceipt(db, target, command), await initial, "later replay returns the saved result");
  assert.equal(calls, 1, "completed replay does not inject again");

  const restartCommand = {
    ...command,
    message: "accepted immediately before restart",
    clientId: "82a1048c-6071-4803-9639-f238483db666",
  };
  const hash = threadInjectionPayloadHash(restartCommand);
  db.claimOwnerCommandReceipt({
    clientId: restartCommand.clientId,
    command: "thread.inject",
    threadId: thread.id,
    payloadHash: hash,
  });
  db.acceptOwnerCommandReceipt(restartCommand.clientId);
  db.raw.close();
  db = new Db(receiptDbPath);
  assert.deepEqual(
    await injectThreadWithReceipt(db, target, command),
    await initial,
    "a completed receipt returns its exact saved result after a database reopen",
  );
  const recovered = await injectThreadWithReceipt(db, target, restartCommand);
  assert.equal(recovered.ok, true, "an accepted instruction survives a database reopen and lost socket receipt");
  assert.match(recovered.message ?? "", /durably accepted/, "the recovered receipt explains its authority");
  assert.equal(calls, 1, "post-restart receipt reconciliation does not steer the task twice");

  const collision = await injectThreadWithReceipt(db, target, { ...command, message: "different payload" });
  assert.equal(collision.ok, false, "a reused delivery id cannot acknowledge different content");
  assert.match(collision.error ?? "", /different task instruction/);

  const missingTask = await injectThreadWithReceipt(db, target, {
    ...command,
    threadId: "missing-task",
    clientId: "a83381d4-a98e-469d-a86a-c5ae222c92de",
  });
  assert.deepEqual(missingTask, { ok: false, error: "No such task." }, "a stale task id is rejected without a receipt FK error");
  assert.equal(calls, 1, "a stale task command never reaches the injection target");

  const history = recoveryHistoryBlock([
    { id: "1", threadId: thread.id, role: "director", kind: "system", content: "owner directive", createdAt: 1 },
    { id: "2", threadId: thread.id, role: "implementor", kind: "text", content: "completed edit evidence", createdAt: 2 },
    { id: "3", threadId: thread.id, role: "implementor", kind: "result", content: "noisy tool bytes", createdAt: 3 },
  ]);
  assert.match(history, /owner directive/);
  assert.match(history, /completed edit evidence/);
  assert.doesNotMatch(history, /noisy tool bytes/);
  assert.match(history, /do not redo completed work/i);
  db.raw.close();

  console.log("Incident recovery checks passed: single owner, durable receipts, and bounded fresh-session history.");
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
