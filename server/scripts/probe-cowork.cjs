#!/usr/bin/env node
// Read-only audit of the Co-work lane: session state, the turn trail, live-steering delivery, attachment
// references, and the durable invariants no task-side probe can see (Co-work owns no thread/agent_runs row).
// Exit 0 = no invariant violations, 1 = actionable inconsistency, 2 = usage/schema error.

const path = require("node:path");
const Database = require("better-sqlite3");
const { coworkBoardIssues, coworkReading, coworkSchemaIssue, selectCoworkRows } = require("./cowork-health.cjs");

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--json") || positional.length > 1) {
  console.error("usage: node scripts/probe-cowork.cjs [<session-id-prefix|name-substring>] [--json]");
  process.exit(2);
}
const query = positional[0] ?? null;
const dbPath = process.env.ORCH_DB
  ? path.resolve(process.env.ORCH_DB)
  : path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

let db;
try {
  db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
} catch (error) {
  console.error(`Cannot open orchestrator DB read-only at ${dbPath}: ${error.message}`);
  process.exit(2);
}

const schemaIssue = coworkSchemaIssue(db);
if (schemaIssue) {
  db.close();
  console.error(`The required Co-work schema is unavailable in ${dbPath}: ${schemaIssue}.`);
  process.exit(2);
}

const readings = selectCoworkRows(db, query).map(coworkReading);
const boardIssues = coworkBoardIssues(db, readings);
db.close();

const counts = {};
for (const reading of readings) counts[reading.disposition] = (counts[reading.disposition] ?? 0) + 1;
const attention = readings.filter((reading) => reading.attention);

function short(value, max = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stamp(ms) {
  if (ms == null) return "-";
  const at = new Date(Number(ms));
  return `${at.toLocaleString()} (${at.toISOString()})`;
}

function ago(ms) {
  if (ms == null) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function money(value) {
  return `$${(value ?? 0).toFixed(2)}`;
}

function target(entry) {
  if (!entry.provider && !entry.model) return "unrouted";
  return `${entry.provider ?? "?"}/${entry.model ?? "?"}${entry.effort ? ` @${entry.effort}` : ""}${entry.account ? ` [${entry.account}]` : ""}`;
}

function steeringMode(mode) {
  return mode === "append" ? "inject" : mode === "interrupt" ? "interrupt+inject" : mode;
}

function steeringDelivery(delivery) {
  return delivery === "pending" ? "unconfirmed" : delivery;
}

function publicEntry(reading) {
  const { session } = reading;
  return {
    id: session.id,
    name: session.name,
    workspace: session.workspace,
    state: session.state,
    disposition: reading.disposition,
    attention: reading.attention,
    issues: reading.issues,
    notes: reading.notes,
    requested: session.requestedProvider ? { provider: session.requestedProvider, model: session.requestedModel } : null,
    resolved: { provider: session.provider, model: session.model, effort: session.effort, account: session.account },
    agentSessionId: session.agentSessionId,
    activeTurnId: session.activeTurnId,
    error: session.error,
    turns: session.turns.length,
    costUsd: reading.costUsd,
    messages: session.messages,
    attachments: session.attachments,
    steering: session.steering,
    updatedAt: session.updatedAt,
    trail: session.turns.map((turn) => ({
      id: turn.id,
      state: turn.state,
      provider: turn.provider,
      model: turn.model,
      account: turn.account,
      agentSessionId: turn.agentSessionId,
      costUsd: turn.costUsd,
      numTurns: turn.numTurns,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      error: turn.error,
    })),
  };
}

const payload = {
  verdict: attention.length || boardIssues.length ? "ATTENTION" : "PASS",
  dbPath,
  checked: readings.length,
  attention: attention.length,
  boardIssues,
  counts,
  entries: readings.map(publicEntry),
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(
    `${payload.verdict} - checked ${payload.checked} Co-work session(s); ` +
      `${payload.attention} with invariant violation(s); ${boardIssues.length} board-level issue(s).`,
  );
  const countLine = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join("; ");
  if (countLine) console.log(`  ${countLine}`);
  if (!readings.length) console.log(query ? `  No Co-work session matched "${query}".` : "  No Co-work sessions exist yet.");
  for (const issue of boardIssues) console.log(`  BOARD ISSUE: ${issue}`);

  for (const reading of readings) {
    const { session } = reading;
    console.log(`\n[${reading.disposition.toUpperCase()}] ${session.id.slice(0, 8)} - ${short(session.name, 90)}`);
    console.log(`  workspace: ${session.workspace}`);
    console.log(
      `  state=${session.state}; turns=${session.turns.length}; cost=${money(reading.costUsd)}; ` +
        `owner msgs=${session.messages.owner}; replies=${session.messages.replies}; last activity ${ago(session.messages.lastAt ?? session.updatedAt)}`,
    );
    console.log(
      `  target: ${target(session)}; resume linkage: ${session.agentSessionId ? `${session.agentSessionId.slice(0, 12)}… (next turn continues it)` : "none (next turn starts fresh)"}`,
    );
    if (
      session.attachments.refs ||
      session.attachments.malformed.length ||
      session.attachments.missing.length ||
      session.attachments.metadataMismatches.length
    ) {
      console.log(
        `  attachments: messages=${session.attachments.messageRows}; refs=${session.attachments.refs}; ` +
          `unique=${session.attachments.unique}; stored=${session.attachments.stored}; ` +
          `missing=${session.attachments.missing.length}; invalid=${session.attachments.malformed.length}; ` +
          `metadata drift=${session.attachments.metadataMismatches.length}`,
      );
    }
    if (session.error) console.log(`  session error: ${short(session.error)}`);
    if (session.steering.total) {
      const modes = session.steering.byMode;
      const deliveries = session.steering.byDelivery;
      console.log(
        `  steering: queue=${modes.queue}; inject=${modes.append}; interrupt+inject=${modes.interrupt}; ` +
          `delivered=${deliveries.delivered}; failed=${deliveries.failed}; unconfirmed=${deliveries.pending}`,
      );
      for (const message of session.steering.messages.slice(-5)) {
        console.log(
          `    ↳ ${message.id.slice(0, 8)} ${steeringMode(message.mode)} ${steeringDelivery(message.delivery)} ` +
            `${ago(message.createdAt)}: ${short(message.content, 140)}`,
        );
        if (message.error) console.log(`        delivery error: ${short(message.error)}`);
      }
      if (session.steering.messages.length > 5) {
        console.log(`    ↳ (${session.steering.messages.length - 5} earlier steering message(s) not shown)`);
      }
    }
    for (const turn of session.turns.slice(-5)) {
      const span = turn.endedAt ? `${Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000))}s` : "running";
      console.log(
        `  · ${turn.id.slice(0, 8)} ${turn.state.padEnd(11)} ${span.padStart(7)} ${money(turn.costUsd)} ` +
          `${turn.numTurns == null ? "" : `${turn.numTurns} agent turns `}${target(turn)}`,
      );
      if (turn.error) console.log(`      error: ${short(turn.error)}`);
    }
    if (session.turns.length > 5) console.log(`  · (${session.turns.length - 5} earlier turn(s) not shown)`);
    if (query) console.log(`  started ${stamp(session.createdAt)}; updated ${stamp(session.updatedAt)}`);
    for (const note of reading.notes) console.log(`  note: ${note}`);
    for (const issue of reading.issues) console.log(`  ISSUE: ${issue}`);
  }
}

if (attention.length || boardIssues.length) process.exitCode = 1;
