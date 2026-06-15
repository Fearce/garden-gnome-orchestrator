// One-off reconciliation for two tasks left in a non-terminal limbo by the completion-lifecycle
// bug (see threadManager finalizeRun / markInterrupted). Run with the orchestrator either up or
// down — it writes directly to SQLite (WAL + busy_timeout), so it won't fight a live server; the
// next `hello` snapshot (reconnect / restart) re-reads these corrected rows.
//
//   node scripts/fix-stuck.cjs            # apply
//   node scripts/fix-stuck.cjs --dry-run  # show what would change
//
// Targets (matched by title prefix, so the opaque UUIDs aren't hard-coded):
//   "Debug: classification gaps…"  -> done   (QA passed; the redirect fix was finished + committed)
//   "Investigate: session…"        -> failed (already failed; only its orphan runs need closing)

const path = require("node:path");
const Database = require("better-sqlite3");

const DRY = process.argv.includes("--dry-run");
const dbPath = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const TARGETS = [
  { prefix: "Debug: classification", finalState: "done", clearError: true },
  { prefix: "Investigate: session", finalState: "failed", clearError: false },
];

const LIVE_RUN_STATES = new Set(["starting", "running", "idle"]);
const now = Date.now();

const apply = db.transaction(() => {
  for (const target of TARGETS) {
    const thread = db.prepare("SELECT * FROM threads WHERE title LIKE ?").get(target.prefix + "%");
    if (!thread) {
      console.log(`! no thread matching "${target.prefix}…" — skipped`);
      continue;
    }
    console.log(`\n• ${thread.title.slice(0, 60)}`);
    console.log(`    thread: ${thread.state} -> ${target.finalState}`);
    if (!DRY && thread.state !== target.finalState) {
      const error = target.clearError ? null : thread.error;
      db.prepare("UPDATE threads SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(
        target.finalState,
        error,
        thread.updated_at, // preserve last-activity time so the final duration stays honest
        thread.id,
      );
    }

    const runs = db.prepare("SELECT * FROM agent_runs WHERE thread_id = ?").all(thread.id);
    for (const r of runs) {
      if (!LIVE_RUN_STATES.has(r.state) || r.ended_at != null) continue;
      // A run that produced a result reached "idle"; one that never did is genuinely interrupted.
      const runState = r.state === "idle" ? "done" : "interrupted";
      const endedAt = thread.updated_at ?? now;
      console.log(`    run ${r.role.padEnd(11)} ${r.state} -> ${runState} (+endedAt)`);
      if (!DRY) {
        db.prepare("UPDATE agent_runs SET state = ?, ended_at = ? WHERE id = ?").run(runState, endedAt, r.id);
      }
    }
  }
});

apply();
db.close();
console.log(DRY ? "\n(dry run — nothing written)" : "\n✓ applied");
