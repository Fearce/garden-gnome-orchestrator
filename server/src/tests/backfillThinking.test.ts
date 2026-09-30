// Gate for the one-shot narration backfill (`npm run backfill:thinking`). It writes into the live
// messages table, so the properties that matter are the ones a bad run could not undo: each block lands
// on the run that was live in its session when it was written, CLI-bridged and signature-only sessions
// are left alone, a dry run writes nothing, and a second apply adds nothing.
// Run: npx tsx src/tests/backfillThinking.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { backfillMessageId, backfillThinking, runAt, thinkingFromLine } from "../tools/backfillThinking.js";

const dir = mkdtempSync(join(tmpdir(), "gg-backfill-thinking-"));
try {
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const thread = db.createThread({ title: "Deploy gnomerang.com", workspace: dir, rawPrompt: "p" });
  const t0 = Date.parse("2026-09-30T10:00:00Z");
  const seedRun = (role: "implementor" | "qa", account: string, session: string, startedAt: number, endedAt: number | null) => {
    const run = db.createRun({ threadId: thread.id, role, model: "claude-opus-5-5", account });
    db.raw.prepare("UPDATE agent_runs SET session_id = ?, started_at = ?, ended_at = ? WHERE id = ?").run(session, startedAt, endedAt, run.id);
    return run.id;
  };
  const first = seedRun("implementor", "personal", "sess-a", t0, t0 + 60_000);
  const resumed = seedRun("implementor", "personal", "sess-a", t0 + 120_000, t0 + 300_000);
  const qa = seedRun("qa", "vota", "sess-q", t0 + 400_000, null);
  seedRun("implementor", "codex:gpt-6-sol", "sess-codex", t0, null);

  const line = (uuid: string, at: number, content: unknown[]) =>
    JSON.stringify({ type: "assistant", uuid, timestamp: new Date(at).toISOString(), message: { role: "assistant", content } });
  const thinking = (text: string) => ({ type: "thinking", thinking: text, signature: "sig" });
  const root = join(dir, "projects");
  mkdirSync(join(root, "C--work"), { recursive: true });
  writeFileSync(
    join(root, "C--work", "sess-a.jsonl"),
    [
      line("u1", t0 + 10_000, [thinking("I found two manual deploy scripts; checking which host serves gnomerang.com.")]),
      line("u2", t0 + 20_000, [thinking("")]),
      line("u3", t0 + 20_500, [{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
      JSON.stringify({ type: "user", uuid: "u4", timestamp: new Date(t0).toISOString(), message: { content: [{ type: "tool_result", content: "thinking" }] } }),
      line("u5", t0 + 150_000, [thinking("The A record points at the Hetzner box.")]),
      line("u6", t0 + 900_000, [thinking("Written long after both runs ended.")]),
      "not json",
    ].join("\n"),
  );
  writeFileSync(join(root, "C--work", "sess-q.jsonl"), line("q1", t0 + 410_000, [thinking("QA: re-running the deploy check.")]));
  writeFileSync(join(root, "C--work", "sess-codex.jsonl"), line("c1", t0 + 10_000, [thinking("Not a Claude transcript to trust.")]));

  // --- the pure pieces ---
  assert.deepEqual(thinkingFromLine(line("x", t0, [thinking("  \n")])), [], "blank reasoning is not narration");
  assert.equal(thinkingFromLine(line("x", t0, [thinking("a"), thinking("b")]))[1]?.uuid, "x:1", "a second block in one line gets its own id");
  const runs = [
    { id: "old", threadId: "t", role: "implementor", startedAt: 0, endedAt: 100_000 },
    { id: "new", threadId: "t", role: "implementor", startedAt: 90_000, endedAt: null },
  ];
  assert.equal(runAt(runs, 95_000)?.id, "new", "an overlap goes to the run started most recently");
  assert.equal(runAt(runs, 50_000)?.id, "old");

  // --- a dry run counts and writes nothing ---
  const dry = await backfillThinking(db.raw, root, false);
  assert.deepEqual(
    { blocks: dry.blocks, unattributed: dry.unattributed, inserted: dry.inserted, threads: dry.threads },
    { blocks: 4, unattributed: 1, inserted: 3, threads: 1 },
    "three attributable Claude blocks; the Codex session and the late block are skipped",
  );
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'thinking'").get() as { n: number }).n, 0, "a dry run writes nothing");

  // --- apply attributes each block to the run live when it was written ---
  await backfillThinking(db.raw, root, true);
  const rows = db.raw.prepare("SELECT id, run_id AS runId, role, content, created_at AS at FROM messages WHERE kind = 'thinking' ORDER BY created_at").all() as Array<{
    id: string;
    runId: string;
    role: string;
    content: string;
    at: number;
  }>;
  assert.deepEqual(
    rows.map((r) => [r.runId, r.role, r.at]),
    [
      [first, "implementor", t0 + 10_000],
      [resumed, "implementor", t0 + 150_000],
      [qa, "qa", t0 + 410_000],
    ],
  );
  assert.equal(rows[0]!.id, backfillMessageId("u1"));

  // --- idempotent: a second apply, and a block the live runner already persisted, add nothing ---
  db.addMessage({ threadId: thread.id, runId: qa, role: "qa", kind: "thinking", content: "QA: persisted live after the fix." });
  writeFileSync(join(root, "C--work", "sess-q.jsonl"), [line("q1", t0 + 410_000, [thinking("QA: re-running the deploy check.")]), line("q2", t0 + 420_000, [thinking("QA: persisted live after the fix.")])].join("\n"));
  const again = await backfillThinking(db.raw, root, true);
  assert.equal(again.inserted, 0, "nothing is inserted twice");
  assert.equal(again.alreadyPresent, 4);
  db.raw.close();
  console.log("All narration-backfill checks passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
