/**
 * Gate — WAL checkpoints run on a worker thread, never inside a commit on the event loop, and SQLite's
 * own auto-checkpoint comes back whenever that worker is not running.
 *
 * Run: npm run test:wal-checkpointer (from server/)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { WalCheckpointer } from "../db/walCheckpointer.js";

const dir = mkdtempSync(join(tmpdir(), "gg-wal-checkpointer-"));
const path = join(dir, "orchestrator.sqlite");
const db = new Db(path);
const autoCheckpoint = (): unknown => db.raw.pragma("wal_autocheckpoint", { simple: true });
const started: WalCheckpointer[] = [];

async function waitFor(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  assert.equal(autoCheckpoint(), 1000, "a plain Db keeps SQLite's auto-checkpoint");

  const faults: string[] = [];
  const checkpointer = new WalCheckpointer(db.raw, path, { intervalMs: 50, onFault: (label) => faults.push(label) });
  started.push(checkpointer);
  checkpointer.start();
  await waitFor("the worker to take over checkpointing", () => autoCheckpoint() === 0);

  // 2026-10-04: with auto-checkpoint on, 42 of 8,000 single-row inserts took 5-494ms on this box; off, none
  // took 5ms. Only a checkpoint moves pages into the main file, and this connection no longer runs one.
  const thread = db.createThread({ title: "Writes", workspace: dir, rawPrompt: "w", brief: "w" });
  const before = statSync(path).size;
  for (let i = 0; i < 1500; i++) db.addMessage({ threadId: thread.id, role: "implementor", kind: "result", content: "x".repeat(2000) });
  await waitFor("the worker to checkpoint the new pages", () => statSync(path).size > before + 2_000_000);
  assert.equal(autoCheckpoint(), 0, "the event loop still never checkpoints");

  await checkpointer.stop();
  assert.equal(autoCheckpoint(), 1000, "stopping the worker hands checkpoints back to SQLite");
  assert.equal(faults.length, 0, `a clean run reports no fault: ${faults.join("; ")}`);

  // A worker that cannot run never leaves the WAL without a checkpointer, and is retried.
  const broken = new WalCheckpointer(db.raw, join(dir, "missing.sqlite"), {
    intervalMs: 50,
    restartDelayMs: 50,
    onFault: (label) => faults.push(label),
  });
  started.push(broken);
  broken.start();
  await waitFor("a retry after the first failure", () => faults.length >= 2);
  assert.equal(autoCheckpoint(), 1000, "auto-checkpoint stays on while the worker keeps failing");
  await broken.stop();
  const settled = faults.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(faults.length, settled, "a stopped checkpointer is not restarted");

  console.log("WAL checkpointer OK — checkpoints run off the event loop, and SQLite's own come back whenever the worker is down.");
} finally {
  await Promise.all(started.map((checkpointer) => checkpointer.stop()));
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
