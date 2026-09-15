#!/usr/bin/env node
// Restore owner-facing file cards from a Retry archive. This is deliberately a local, explicit repair
// tool: it never trusts the archive's agent-supplied paths until they pass the same realpath containment,
// files-only, and size limits enforced by GET /api/deliverable/:id.
//
//   node scripts/restore-archived-deliverables.cjs <task-id> --archive data/archives/task.md
//
// It is safe to rerun. Existing files are retained even when a later retry used a different label or
// path spelling, and only missing artifacts are inserted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const SERVER_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.join(SERVER_DIR, "data", "orchestrator.sqlite");
const MAX_DELIVERABLE_BYTES = 25 * 1024 * 1024;
const USAGE = "usage: node scripts/restore-archived-deliverables.cjs <task-id> --archive <archive.md>";

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  let taskId = null;
  let archive = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--archive") {
      archive = argv[++i] ?? null;
      if (!archive) throw new Error("--archive requires a file");
    } else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else if (!taskId) taskId = arg;
    else throw new Error("only one task id is accepted");
  }
  if (!taskId || !archive) throw new Error("a task id and --archive are required");
  return { taskId, archive };
}

/** Parse only the structured Deliverables block produced by archive-thread.cjs. The archive can contain
 * arbitrary agent prose, so no content outside this block is ever interpreted as a file card. */
function parseDeliverables(markdown, taskId) {
  const taskMarker = `- **id**: \`${taskId}\``;
  const taskStart = markdown.indexOf(taskMarker);
  if (taskStart < 0) throw new Error(`archive does not contain task ${taskId}`);
  const deliverablesStart = markdown.indexOf("### Deliverables (", taskStart);
  if (deliverablesStart < 0) throw new Error("archive has no Deliverables section for this task");
  const nextSection = markdown.indexOf("\n### ", deliverablesStart + 1);
  const block = markdown.slice(deliverablesStart, nextSection < 0 ? undefined : nextSection);
  const result = [];
  for (const line of block.split(/\r?\n/)) {
    // archive-thread.cjs emits: - **label** : `path` (2026-... UTC)
    const match = line.match(/^- \*\*(.+?)\*\* : `([^`]+)`(?: -- \*\*MISSING on disk\*\*)? \(([^)]*)\)$/);
    if (!match) continue;
    const createdAt = Date.parse(match[3]);
    if (!Number.isFinite(createdAt)) throw new Error(`invalid deliverable timestamp for "${match[1]}"`);
    result.push({ label: match[1], artifactPath: match[2], createdAt });
  }
  if (!result.length) throw new Error("archive contains no parseable deliverables for this task");
  return result;
}

function confinedFile(workspace, artifactPath) {
  const candidate = path.isAbsolute(artifactPath) ? artifactPath : path.join(workspace, artifactPath);
  let realWorkspace;
  let realFile;
  try {
    realWorkspace = fs.realpathSync(workspace);
    realFile = fs.realpathSync(candidate);
  } catch {
    throw new Error(`file not found: ${artifactPath}`);
  }
  const rel = path.relative(realWorkspace, realFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes task workspace: ${artifactPath}`);
  const stat = fs.statSync(realFile);
  if (!stat.isFile()) throw new Error(`not a file: ${artifactPath}`);
  if (stat.size > MAX_DELIVERABLE_BYTES) throw new Error(`file exceeds 25 MB limit: ${artifactPath}`);
  return realFile;
}

function restore(db, { taskId, archive }, log = console.log) {
  const thread = db.prepare("SELECT id, workspace FROM threads WHERE id=?").get(taskId);
  if (!thread) throw new Error(`no task found with id ${taskId}`);
  const markdown = fs.readFileSync(path.resolve(archive), "utf8");
  const archived = parseDeliverables(markdown, taskId);
  // Validate every archive claim before writing one row. A partial repair implies a complete set when
  // it is not, and can conceal a missing or escaped artifact.
  const validated = archived.map((entry) => ({ ...entry, realPath: confinedFile(thread.workspace, entry.artifactPath) }));
  const existing = db.prepare("SELECT path FROM findings WHERE thread_id=? AND kind='deliverable' AND path IS NOT NULL").all(taskId);
  // One artifact is one card for restoration purposes. Retries often relabel the same screenshot and
  // Windows paths may switch slash/case spelling; compare canonical paths rather than (label, raw path)
  // so repairing an archive beside a newer partial recapture does not create duplicate cards.
  const pathKey = (realPath) => (process.platform === "win32" ? realPath.toLowerCase() : realPath);
  const identity = new Set();
  for (const row of existing) {
    try {
      identity.add(pathKey(confinedFile(thread.workspace, row.path)));
    } catch {
      // A dead or unsafe existing card must not suppress restoration of a valid archived artifact.
    }
  }
  const insert = db.prepare(
    "INSERT INTO findings(id,thread_id,from_run_id,from_role,kind,summary,detail,path,label,severity,routed,created_at) VALUES (@id,@threadId,NULL,'implementor','deliverable',@summary,@detail,@path,@label,'info',0,@createdAt)",
  );
  let restored = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const entry of validated) {
      // Retain the archived spelling of a valid path. Copy-path must reproduce what the original agent
      // surfaced; the API repeats realpath containment when it serves it.
      const key = pathKey(entry.realPath);
      if (identity.has(key)) {
        skipped++;
        continue;
      }
      insert.run({
        id: crypto.randomUUID(),
        threadId: taskId,
        summary: entry.label,
        detail: "Restored from the task Retry archive after the original deliverable finding was removed.",
        path: entry.artifactPath,
        label: entry.label,
        createdAt: entry.createdAt,
      });
      identity.add(key);
      restored++;
    }
  })();
  log(`${taskId.slice(0, 8)}: restored ${restored} deliverable card(s), ${skipped} already present.`);
  return { restored, skipped, deliverables: validated };
}

function main(argv = process.argv.slice(2), { dbPath = DB_PATH, log = console.log, warn = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return 0;
    }
  } catch (error) {
    warn(`error: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (!fs.existsSync(dbPath)) {
    warn(`error: no database at ${dbPath}`);
    return 1;
  }
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    restore(db, args, log);
    return 0;
  } catch (error) {
    warn(`error: ${error.message}`);
    return 1;
  } finally {
    db.close();
  }
}

module.exports = { MAX_DELIVERABLE_BYTES, USAGE, confinedFile, main, parseArgs, parseDeliverables, restore };

if (require.main === module) process.exit(main());
