#!/usr/bin/env node
// Answer the operator question behind a missing/slow Supervisor-chat message from the durable record.
// Read-only. Safe while production is running (SQLite WAL + busy_timeout).
//
//   npm run probe:supervisor-chat --prefix server
//   npm run probe:supervisor-chat --prefix server -- <turn-id|task-id|task-title|message-text>
//   npm run probe:supervisor-chat --prefix server -- <query> --limit 40 --json
//
// A matching row proves the server persisted a receipt before Supervisor work began. Its status and
// action_results then distinguish pending, answered, needs-input, and failed execution. No matching row
// means this database has no durable receipt for the supplied id/text/task; an absent table means the
// Supervisor-chat backend has not booted against this database at all.

const path = require("node:path");
const Database = require("better-sqlite3");
const { localStamp } = require("./task-timeline.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(SERVER_DIR, "data", "orchestrator.sqlite");
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 200;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "needs_input"]);
const EXPECTED_COLUMNS = [
  "id",
  "content",
  "targets",
  "status",
  "response",
  "action_results",
  "used_agent",
  "cost_usd",
  "total_tokens",
  "model",
  "provider",
  "created_at",
  "updated_at",
];

function usage(stream = process.stdout) {
  stream.write(
    [
      "usage: node scripts/probe-supervisor-chat.cjs [query] [--limit 1..200] [--json] [--db path]",
      "",
      "query matches a turn id, task id/title, owner message, Supervisor reply, or action result.",
      "With no query, the most recent 12 durable turns are shown.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    dbPath: process.env.ORCH_DB ? path.resolve(process.env.ORCH_DB) : DEFAULT_DB,
    json: false,
    limit: DEFAULT_LIMIT,
    query: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[++i];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      options.limit = value;
      continue;
    }
    if (arg === "--db") {
      const raw = argv[++i];
      if (!raw) throw new Error("--db requires a path");
      options.dbPath = path.resolve(raw);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    if (options.query !== null) throw new Error("pass one query string (quote a multi-word title or message)");
    const query = arg.trim();
    if (!query) throw new Error("query cannot be empty");
    options.query = query;
  }
  return options;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableColumns(db, name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name));
}

function compact(value, max = 500) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function numeric(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseStoredArray(raw, label, warnings) {
  try {
    const value = JSON.parse(raw == null ? "[]" : String(raw));
    if (!Array.isArray(value)) {
      warnings.push(`${label} is valid JSON but is not an array`);
      return null;
    }
    return value;
  } catch (error) {
    warnings.push(`${label} is invalid JSON: ${error.message}`);
    return null;
  }
}

function matchingThreadIds(db, query) {
  if (!tableExists(db, "threads")) return [];
  const columns = tableColumns(db, "threads");
  if (!columns.has("id") || !columns.has("title")) return [];
  return db
    .prepare(
      `SELECT id FROM threads
       WHERE instr(lower(id), lower(?)) > 0 OR instr(lower(COALESCE(title, '')), lower(?)) > 0
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all(query, query)
    .map((row) => String(row.id));
}

function findRows(db, query, limit) {
  const params = { limit };
  let where = "";
  if (query) {
    params.query = query;
    const conditions = [
      "instr(lower(id), lower(@query)) > 0",
      "instr(lower(content), lower(@query)) > 0",
      "instr(lower(COALESCE(response, '')), lower(@query)) > 0",
      "instr(lower(targets), lower(@query)) > 0",
      "instr(lower(action_results), lower(@query)) > 0",
    ];
    matchingThreadIds(db, query).forEach((threadId, index) => {
      const key = `thread${index}`;
      params[key] = threadId;
      conditions.push(`instr(targets, @${key}) > 0`, `instr(action_results, @${key}) > 0`);
    });
    where = `WHERE ${conditions.join(" OR ")}`;
  }
  return db
    .prepare(
      `SELECT ${EXPECTED_COLUMNS.join(", ")}
       FROM supervisor_chat_turns
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit`,
    )
    .all(params);
}

function createThreadLookup(db) {
  if (!tableExists(db, "threads")) return { available: false, get: () => null };
  const columns = tableColumns(db, "threads");
  const needed = ["id", "title", "state", "error", "updated_at"];
  if (needed.some((column) => !columns.has(column))) return { available: false, get: () => null };
  const read = db.prepare("SELECT id, title, state, error, updated_at FROM threads WHERE id = ?");
  const cache = new Map();
  return {
    available: true,
    get(id) {
      if (!cache.has(id)) cache.set(id, read.get(id) ?? null);
      return cache.get(id);
    },
  };
}

function actionSummary(actions) {
  if (!Array.isArray(actions)) return { total: null, succeeded: null, failed: null };
  return {
    total: actions.length,
    succeeded: actions.filter((action) => action && action.ok === true).length,
    failed: actions.filter((action) => !action || action.ok !== true).length,
  };
}

function readTurn(row, threadLookup, now = Date.now()) {
  const warnings = [];
  const targets = parseStoredArray(row.targets, "targets", warnings);
  const actions = parseStoredArray(row.action_results, "action_results", warnings);
  const status = String(row.status ?? "");
  const terminal = TERMINAL_STATUSES.has(status);
  if (status !== "pending" && !terminal) warnings.push(`unknown status ${JSON.stringify(status)}`);

  const createdAt = numeric(row.created_at);
  const updatedAt = numeric(row.updated_at);
  if (createdAt == null) warnings.push("created_at is not a finite timestamp");
  if (updatedAt == null) warnings.push("updated_at is not a finite timestamp");
  if (createdAt != null && updatedAt != null && updatedAt < createdAt) warnings.push("updated_at predates created_at");

  const ids = new Set();
  for (const target of targets ?? []) if (target && typeof target.threadId === "string") ids.add(target.threadId);
  for (const action of actions ?? []) if (action && typeof action.threadId === "string") ids.add(action.threadId);
  const currentTasks = [...ids].map((threadId) => {
    const current = threadLookup.get(threadId);
    return current
      ? {
          threadId,
          exists: true,
          title: current.title == null ? null : String(current.title),
          state: current.state == null ? null : String(current.state),
          error: compact(current.error, 800),
          updatedAt: numeric(current.updated_at),
        }
      : { threadId, exists: false, title: null, state: null, error: null, updatedAt: null };
  });
  if (ids.size && !threadLookup.available) warnings.push("current task table is unavailable; only send-time snapshots are shown");

  const actionsCount = actionSummary(actions);
  if (status === "succeeded" && actionsCount.failed) warnings.push("turn says succeeded but at least one recorded action is not successful");
  if (status === "failed" && actionsCount.total === 0 && !compact(row.response)) warnings.push("failed turn has neither a response nor an action result");

  return {
    id: String(row.id),
    content: String(row.content ?? ""),
    targets,
    status,
    response: row.response == null ? null : String(row.response),
    actionResults: actions,
    actionSummary: actionsCount,
    usedAgent: !!row.used_agent,
    costUsd: numeric(row.cost_usd),
    totalTokens: numeric(row.total_tokens),
    model: row.model == null ? null : String(row.model),
    provider: row.provider == null ? null : String(row.provider),
    createdAt,
    updatedAt,
    receipt: {
      persisted: true,
      terminal,
      state:
        status === "pending"
          ? "persisted_pending"
          : terminal
            ? `persisted_${status}`
            : "persisted_unknown",
      elapsedMs: terminal && createdAt != null && updatedAt != null ? Math.max(0, updatedAt - createdAt) : null,
      pendingAgeMs: status === "pending" && createdAt != null ? Math.max(0, now - createdAt) : null,
      lastUpdateAgeMs: updatedAt != null ? Math.max(0, now - updatedAt) : null,
    },
    currentTasks,
    warnings,
  };
}

function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function statusLabel(status) {
  return status === "needs_input" ? "NEEDS INPUT" : status.toUpperCase() || "UNKNOWN";
}

function taskCurrent(turn, threadId) {
  return turn.currentTasks.find((task) => task.threadId === threadId);
}

function renderTurn(turn, timeZone) {
  console.log(`\n[${statusLabel(turn.status)}] ${turn.id}`);
  console.log(`saved: ${localStamp(turn.createdAt, timeZone) ?? "unknown"}`);
  console.log(`owner: ${compact(turn.content, 800) || "(empty)"}`);

  if (turn.targets === null) {
    console.log("targets at send: INVALID JSON (see warnings)");
  } else if (!turn.targets.length) {
    console.log("targets at send: board-wide / no explicit task");
  } else {
    console.log("targets at send:");
    for (const target of turn.targets) {
      const id = typeof target?.threadId === "string" ? target.threadId : "(missing id)";
      const title = compact(target?.title, 160) || "(missing title)";
      const state = target?.state == null ? "unknown" : String(target.state);
      const current = taskCurrent(turn, id);
      const currentText = current?.exists ? `current ${current.state ?? "unknown"}` : current ? "now deleted" : "current state unavailable";
      console.log(`  - ${title} [${id}] | sent while ${state}; ${currentText}`);
    }
  }

  if (turn.status === "pending") {
    console.log(
      `receipt: durable row exists; no terminal Supervisor receipt yet (pending ${duration(turn.receipt.pendingAgeMs)}, last DB update ${duration(turn.receipt.lastUpdateAgeMs)} ago)`,
    );
  } else {
    console.log(`receipt: durable row exists; Supervisor settled ${turn.status} after ${duration(turn.receipt.elapsedMs)}`);
  }
  if (turn.response) console.log(`supervisor: ${compact(turn.response, 1_200)}`);

  if (turn.actionResults === null) {
    console.log("actions: INVALID JSON (see warnings)");
  } else if (!turn.actionResults.length) {
    console.log("actions: none recorded");
  } else {
    console.log("actions:");
    for (const action of turn.actionResults) {
      const ok = action?.ok === true;
      const id = typeof action?.threadId === "string" ? action.threadId : "(missing id)";
      const title = compact(action?.threadTitle, 140) || taskCurrent(turn, id)?.title || "(unknown task)";
      const state = action?.state == null ? "no recorded state" : `recorded ${action.state}`;
      console.log(`  [${ok ? "OK" : "FAILED"}] ${action?.action ?? "unknown action"} | ${title} [${id}] | ${state}`);
      if (action?.message) console.log(`    ${compact(action.message, 900)}`);
    }
    console.log(
      `execution: ${turn.actionSummary.succeeded}/${turn.actionSummary.total} action(s) succeeded, ${turn.actionSummary.failed} failed`,
    );
  }

  if (turn.usedAgent) {
    const identity = [turn.provider, turn.model].filter(Boolean).join(" / ") || "provider/model not recorded";
    const usage = [turn.totalTokens == null ? null : `${turn.totalTokens} tokens`, turn.costUsd == null ? null : `$${turn.costUsd.toFixed(4)}`]
      .filter(Boolean)
      .join(", ");
    console.log(`decision: agent (${identity}${usage ? `; ${usage}` : ""})`);
  } else {
    console.log("decision: deterministic Supervisor control (no model call recorded)");
  }
  for (const warning of turn.warnings) console.log(`warning: ${warning}`);
}

function humanVerdict(turns) {
  const counts = new Map();
  for (const turn of turns) counts.set(turn.status, (counts.get(turn.status) ?? 0) + 1);
  const parts = [...counts.entries()].map(([status, count]) => `${count} ${status}`);
  console.log("\n=== verdict ===");
  console.log(`${turns.length} durable Supervisor-chat turn(s) matched: ${parts.join(", ")}.`);
  if (counts.get("pending")) console.log("Pending means the server received and saved the message, but no terminal reply is recorded yet.");
  if (counts.get("failed")) console.log("Failed means the message was received; read its reply and action rows before resending to avoid a duplicate action.");
  if (counts.get("needs_input")) console.log("Needs-input means the Supervisor received it and deliberately stopped for an owner decision.");
}

function emitProblem(options, state, message, code) {
  if (options.json) {
    console.log(JSON.stringify({ ok: false, state, database: options.dbPath, query: options.query, message }, null, 2));
  } else {
    console.error(`[${state.toUpperCase().replace(/_/g, " ")}] ${message}`);
  }
  return code;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    usage(process.stderr);
    return 2;
  }
  if (options.help) {
    usage();
    return 0;
  }

  let db;
  try {
    db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.pragma("query_only = ON");
  } catch (error) {
    return emitProblem(options, "database_unavailable", `Cannot open ${options.dbPath} read-only: ${error.message}`, 2);
  }

  try {
    if (!tableExists(db, "supervisor_chat_turns")) {
      return emitProblem(
        options,
        "schema_missing",
        "supervisor_chat_turns is absent. This database has not been opened by a build containing the Supervisor-chat backend, so no durable chat receipt can exist here.",
        2,
      );
    }
    const columns = tableColumns(db, "supervisor_chat_turns");
    const missing = EXPECTED_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length) {
      return emitProblem(options, "schema_incompatible", `supervisor_chat_turns is missing column(s): ${missing.join(", ")}`, 2);
    }

    const rows = findRows(db, options.query, options.limit);
    if (!rows.length) {
      const message = options.query
        ? `No durable Supervisor-chat turn matches ${JSON.stringify(options.query)} in ${options.dbPath}. No server receipt for that id/text/task is persisted here.`
        : `No Supervisor-chat turns are recorded in ${options.dbPath}.`;
      if (options.json) {
        console.log(
          JSON.stringify(
            { ok: !options.query, state: options.query ? "not_found" : "empty", database: options.dbPath, query: options.query, limit: options.limit, matched: 0, turns: [], message },
            null,
            2,
          ),
        );
      } else {
        console.log(`[${options.query ? "NOT FOUND" : "EMPTY"}] ${message}`);
      }
      return options.query ? 1 : 0;
    }

    const now = Date.now();
    const lookup = createThreadLookup(db);
    const turns = rows.map((row) => readTurn(row, lookup, now));
    if (options.json) {
      console.log(
        JSON.stringify(
          { ok: true, state: "matched", database: options.dbPath, query: options.query, limit: options.limit, matched: turns.length, generatedAt: now, turns },
          null,
          2,
        ),
      );
      return 0;
    }

    const timeZone = process.env.ORCH_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log("=== Supervisor chat delivery ===");
    console.log(`database: ${options.dbPath}`);
    console.log(`query: ${options.query == null ? `(recent ${options.limit})` : JSON.stringify(options.query)}`);
    for (const turn of turns) renderTurn(turn, timeZone);
    humanVerdict(turns);
    return 0;
  } catch (error) {
    return emitProblem(options, "probe_failed", `Could not inspect Supervisor chat: ${error.message}`, 2);
  } finally {
    db.close();
  }
}

module.exports = { actionSummary, duration, parseArgs, readTurn };

if (require.main === module) process.exitCode = main();
