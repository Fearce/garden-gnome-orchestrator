/**
 * Gate — the runner's own cap verdict is PERSISTED per run, and the sweep can see where its regexes
 * disagree with it (`agent_runs.cap_flagged`).
 *
 * Background: every cap classifier in `scripts/probe-run-errors.cjs` is a hand-copied mirror of the ones
 * in `agents/runner.ts`, and on 2026-08-05 BOTH were ignorant of z.ai's wording at once — a spent backend
 * kept counting as a failover rung, a QA round burned, and the sweep filed it as a crash. Proving which
 * of the two had failed meant reading absent findings and kv latches that self-expire. The flag records
 * what the runner concluded (`rateLimited`, or a CLI backend's `capped`), so the disagreement is a
 * one-line read and the sweep reports it by itself.
 *
 * WHAT IS REAL: a real on-disk SQLite Db (throwaway temp dir) and the probe's real classifier. No agents,
 * no network, no quota.
 *
 * Scenarios:
 *   A. ROUND-TRIP — true/false/never-written survive the write and come back as true/false/null
 *                   (better-sqlite3 refuses to bind a boolean, so the 0/1 coercion is load-bearing).
 *   B. MIGRATION  — a DB created before the column gains it on open, with existing rows reading null.
 *   C. WIRING     — both places threadManager stamps a run terminal actually write the flag. Without
 *                   this the column stays null forever and every check below is vacuous in production.
 *   D. DRIFT      — the disagreement report: a cap the RUNNER missed (the dangerous direction), a cap the
 *                   PROBE missed (noisy but safe), agreement, and null rows abstaining.
 *
 * Run:  npm run test:cap-flag   (from server/)   — or:  npx tsx src/tests/capFlag.test.ts
 */

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const { Db } = await import("../db/db.js");
const require = createRequire(import.meta.url);
const { classifierDisagreements } = require("../../scripts/probe-run-errors.cjs");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "gg-capflag-"));
const dbPath = join(dir, "orchestrator.sqlite");

// ---- A. round-trip ---------------------------------------------------------------------------------
console.log("\nA. round-trip");
{
  const db = new Db(dbPath);
  const thread = db.createThread({ title: "t", workspace: dir, rawPrompt: "p" });
  const mk = () => db.createRun({ threadId: thread.id, role: "qa", model: "glm-5.2" });

  const capped = mk();
  db.updateRun(capped.id, { state: "error", capFlagged: true, endedAt: Date.now() });
  check("a run the runner capped reads back true", db.getRun(capped.id)?.capFlagged === true);

  const crashed = mk();
  db.updateRun(crashed.id, { state: "error", capFlagged: false, endedAt: Date.now() });
  check("a run it did NOT cap reads back false, not null", db.getRun(crashed.id)?.capFlagged === false);

  const untouched = mk();
  check("a fresh run has no verdict yet (null)", db.getRun(untouched.id)?.capFlagged == null);
  check("createRun's returned record agrees with a re-read", untouched.capFlagged === null);

  // The flag must not disturb the fields a run is actually diagnosed by.
  db.updateRun(capped.id, { error: "API Error: Request rejected (429)" });
  const reread = db.getRun(capped.id);
  check("updating another field leaves the flag alone", reread?.capFlagged === true);
  check("the error text round-trips beside it", reread?.error === "API Error: Request rejected (429)");
  db.raw.close();
}

// ---- B. migration onto an existing DB --------------------------------------------------------------
console.log("\nB. migration");
{
  const legacyPath = join(dir, "legacy.sqlite");
  const raw = new Database(legacyPath);
  raw.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, state TEXT, workspace TEXT, brief TEXT,
      raw_prompt TEXT, error TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      model TEXT NOT NULL, state TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
    INSERT INTO agent_runs(id, thread_id, role, model, state, started_at) VALUES('r1','t1','qa','glm-5.2','error',1);
  `);
  raw.close();

  const db = new Db(legacyPath); // the constructor IS the migration
  const cols = db.raw.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
  check("the column is added to a pre-existing table", cols.some((c) => c.name === "cap_flagged"));
  check("a row written before the flag reads null, not false", db.getRun("r1")?.capFlagged == null);
  db.raw.close();
}

// ---- C. production wiring --------------------------------------------------------------------------
// Both terminal-stamp paths must write it: runRole's explicit finishRun, and the implementor's onEnd
// finalizeRun. A miss leaves the column null forever, which every check above would still pass. (The
// OTHER terminal stamps — markInterrupted, markSilentRun — deliberately don't: there is no agent verdict
// to record when a bounce or an empty run closes a row, which is why null can't mean "saw no cap".)
console.log("\nC. wiring");
{
  const src = readFileSync(resolve(import.meta.dirname, "..", "orchestrator", "threadManager.ts"), "utf8");
  for (const fn of ["finishRun", "finalizeRun"]) {
    const body = src.split(`private ${fn}(`)[1]?.split("\n  }")[0] ?? "";
    check(`${fn} persists the runner's cap verdict`, /capFlagged:\s*capFlaggedBy\(agent\)/.test(body));
  }

  const { capFlaggedBy } = await import("../orchestrator/threadManager.js");
  const { CodexAgentRun } = await import("../agents/codexRunner.js");
  const cli = Object.create(CodexAgentRun.prototype) as { rateLimited: boolean; capped: boolean };
  cli.rateLimited = false; // a CLI backend deliberately never sets this — `capped` is its whole signal
  cli.capped = true;
  check("a CLI backend's `capped` counts as a cap", capFlaggedBy(cli as never) === true);
  cli.capped = false;
  check("…and an uncapped CLI run does not", capFlaggedBy(cli as never) === false);
  check("an AgentRun's `rateLimited` counts", capFlaggedBy({ rateLimited: true } as never) === true);
  check("a plain failure is not a cap", capFlaggedBy({ rateLimited: false } as never) === false);
}

// ---- D. drift report -------------------------------------------------------------------------------
console.log("\nD. drift");
{
  const run = (over: Record<string, unknown>) => ({ role: "qa", model: "glm-5.2", error: "", ...over });
  const { unrecognizedByRunner, unrecognizedByProbe } = classifierDisagreements([
    // The dangerous direction: this file called it a cap, the runner never flagged one — so nothing
    // failed over, whatever the sweep's verdict line says. This is the shape an 08-05-class row takes
    // once CAP_RE learns a wording the runner hasn't; while BOTH were blind it read `real` instead, and
    // that case is still a human reading cap_flagged on a `real` row.
    { run: run({ id: "a", cap_flagged: 0 }), key: "cap" },
    // The safe direction: the runner handled a cap the sweep is about to call a real failure. EVERY class
    // that alarms a human counts, not just `real` — a cap arriving as a rate_limit_event leaves no cap
    // wording in the error text, so it can surface under any of them (`structured` here).
    { run: run({ id: "b", cap_flagged: 1 }), key: "real" },
    { run: run({ id: "b2", cap_flagged: 1 }), key: "structured" },
    // Agreement, both ways.
    { run: run({ id: "c", cap_flagged: 1 }), key: "cap" },
    { run: run({ id: "d", cap_flagged: 0 }), key: "real" },
    // A cap flagged mid-run that later ended at the turn ceiling is NOT a disagreement — the run's final
    // reason is the cutoff, and reporting it would put a benign row in front of a human every sweep.
    { run: run({ id: "e", cap_flagged: 1 }), key: "cutoff" },
    // Rows written before the flag existed must abstain, not be read as "the runner saw no cap".
    { run: run({ id: "f", cap_flagged: null }), key: "cap" },
    { run: run({ id: "g", cap_flagged: undefined }), key: "cap" },
  ]);
  check("a cap the runner never saw is reported", unrecognizedByRunner.map((r: { id: string }) => r.id).join() === "a");
  check(
    "a cap the probe can't name is reported separately, in every human-alarming class",
    unrecognizedByProbe.map((r: { id: string }) => r.id).join() === "b,b2",
  );
  const runnerIds = unrecognizedByRunner.map((r: { id: string }) => r.id);
  check("agreement is silent", !runnerIds.includes("c") && !runnerIds.includes("d"));
  check("a cap flagged mid-run that ended at the turn ceiling is silent", unrecognizedByProbe.length === 2);
  check("pre-flag rows abstain", !unrecognizedByRunner.some((r: { id: string }) => r.id === "f" || r.id === "g"));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "✗" : "✓"} capFlag: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
