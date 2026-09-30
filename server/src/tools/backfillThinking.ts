// Recover the Claude narration persisted before runners committed `thinking` durably.
//
// Opus 5.5 narrates progress inside thinking blocks, which the Claude runner once streamed only as a
// live draft, so none of it reached `messages` and every task's feed lost it on reload. The SDK kept
// each block in its session transcript (~/.claude/projects/<slug>/<sessionId>.jsonl); this reads those
// back and inserts each non-empty block as the `thinking` row the runner now writes, attributed to the
// run that was live in that session when the block was written.
//
// Idempotent: a row's id derives from the transcript line's uuid (INSERT OR IGNORE), and a block whose
// text the run already has is skipped, so a re-run or a run that already persisted it adds nothing.
//
// Run: npm run backfill:thinking --prefix server             (dry run: counts only)
//      npm run backfill:thinking --prefix server -- --apply  (writes)
//      DB=<path> to target another database (a VACUUM INTO rehearsal copy).

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

/** A transcript line may lag its run's recorded start/end by a few seconds either way. */
const ATTRIBUTION_GRACE_MS = 30_000;
const CLI_BRIDGED_ACCOUNT = /^(codex|grok|free|jev):/;

export interface SessionRun {
  id: string;
  threadId: string;
  role: string;
  startedAt: number;
  endedAt: number | null;
}

export interface TranscriptThinking {
  uuid: string;
  at: number;
  text: string;
}

/** The non-empty thinking blocks one transcript line carries (signature-only blocks carry no text). */
export function thinkingFromLine(line: string): TranscriptThinking[] {
  if (!line.includes('"thinking"')) return [];
  let entry: { type?: string; uuid?: string; timestamp?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const at = Date.parse(entry.timestamp ?? "");
  if (entry.type !== "assistant" || !entry.uuid || !Number.isFinite(at) || !Array.isArray(entry.message?.content)) return [];
  return entry.message.content.flatMap((block: { type?: string; thinking?: unknown }, i: number) =>
    block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()
      ? [{ uuid: i === 0 ? entry.uuid! : `${entry.uuid}:${i}`, at, text: block.thinking }]
      : [],
  );
}

/** The run that was live in the session at `at`: the latest one started by then whose window covers it. */
export function runAt(runs: readonly SessionRun[], at: number, now = Date.now()): SessionRun | undefined {
  let best: SessionRun | undefined;
  for (const run of runs) {
    const end = (run.endedAt ?? now) + ATTRIBUTION_GRACE_MS;
    if (run.startedAt - ATTRIBUTION_GRACE_MS <= at && at <= end && (!best || run.startedAt > best.startedAt)) best = run;
  }
  return best;
}

export const backfillMessageId = (uuid: string): string =>
  "bf-thinking-" + createHash("sha1").update(uuid).digest("hex").slice(0, 24);

function transcriptIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(root)) return index;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      if (file.endsWith(".jsonl")) index.set(file.slice(0, -".jsonl".length), join(root, dir.name, file));
    }
  }
  return index;
}

function sessionRuns(db: Database.Database): Map<string, SessionRun[]> {
  const rows = db
    .prepare(
      `SELECT r.id, r.thread_id AS threadId, r.role, r.account, r.session_id AS sessionId,
              r.started_at AS startedAt, r.ended_at AS endedAt
         FROM agent_runs r JOIN threads t ON t.id = r.thread_id
        WHERE r.session_id IS NOT NULL AND r.role <> 'director'`,
    )
    .all() as Array<SessionRun & { account: string | null; sessionId: string }>;
  const bySession = new Map<string, SessionRun[]>();
  for (const { account, sessionId, ...run } of rows) {
    if (CLI_BRIDGED_ACCOUNT.test(account ?? "")) continue;
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), run]);
  }
  return bySession;
}

async function readThinking(path: string): Promise<TranscriptThinking[]> {
  const found: TranscriptThinking[] = [];
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) found.push(...thinkingFromLine(line));
  return found;
}

export interface BackfillSummary {
  sessions: number;
  blocks: number;
  unattributed: number;
  alreadyPresent: number;
  inserted: number;
  threads: number;
}

export async function backfillThinking(db: Database.Database, transcriptsRoot: string, apply: boolean): Promise<BackfillSummary> {
  const index = transcriptIndex(transcriptsRoot);
  const summary: BackfillSummary = { sessions: 0, blocks: 0, unattributed: 0, alreadyPresent: 0, inserted: 0, threads: 0 };
  const touchedThreads = new Set<string>();
  const existing = db.prepare("SELECT 1 FROM messages WHERE (run_id = ? AND kind = 'thinking' AND content = ?) OR id = ? LIMIT 1");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO messages(id, thread_id, run_id, role, kind, content, attachments, created_at)
     VALUES(?, ?, ?, ?, 'thinking', ?, '[]', ?)`,
  );
  for (const [sessionId, runs] of sessionRuns(db)) {
    const path = index.get(sessionId);
    if (!path) continue;
    summary.sessions++;
    const rows: Array<[string, string, string, string, string, number]> = [];
    for (const block of await readThinking(path)) {
      summary.blocks++;
      const run = runAt(runs, block.at);
      if (!run) {
        summary.unattributed++;
        continue;
      }
      const id = backfillMessageId(block.uuid);
      if (existing.get(run.id, block.text, id)) {
        summary.alreadyPresent++;
        continue;
      }
      rows.push([id, run.threadId, run.id, run.role, block.text, block.at]);
      touchedThreads.add(run.threadId);
    }
    if (apply && rows.length) db.transaction(() => rows.forEach((r) => insert.run(...r)))();
    summary.inserted += rows.length;
  }
  summary.threads = touchedThreads.size;
  return summary;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dbPath = process.env.DB ?? join(process.cwd(), "data", "orchestrator.sqlite");
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 15000");
  const summary = await backfillThinking(db, join(homedir(), ".claude", "projects"), apply);
  db.close();
  console.log(`${apply ? "Applied" : "Dry run (pass --apply to write)"} against ${dbPath}`);
  console.log(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
