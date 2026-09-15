#!/usr/bin/env node
// Explain the persisted provider-routing decision for one task without issuing usage pings.
// Read-only. Safe while production is up (WAL + busy_timeout).
//
//   node scripts/probe-routing.cjs <thread-id | title-substring>
//   npm run probe:routing --prefix server -- "Restore missing deliverables"
//
// This answers the narrow operational question that a full task timeline makes hard to see:
// which policy was active, which quota facts selected the provider, and whether Claude ran at all.

const path = require("node:path");
const Database = require("better-sqlite3");

const ROUTING_NOTE_RE = /^(Usage-aware routing |Low quota runway on )/;
const SETTINGS = [
  ["setting_spread_usage", "spread usage"],
  ["setting_codex_enabled", "Codex enabled"],
  ["setting_auto_model_selection", "automatic model selection"],
  ["setting_planner_enabled", "planner enabled"],
  ["setting_qa_enabled", "QA enabled"],
];

function usage() {
  console.error("usage: node scripts/probe-routing.cjs <thread-id | title-substring>");
}

function parseJson(raw, fallback = {}) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function providerFor(model, account) {
  const value = `${model || ""} ${account || ""}`.toLowerCase();
  if (value.includes("codex") || /^gpt-/.test(value)) return "Codex";
  if (value.includes("grok")) return "Grok";
  if (value.includes("glm") || value.includes("zai")) return "z.ai";
  if (value.includes("claude") || account === "logged-in") return "Claude";
  return "unknown";
}

function setting(value) {
  if (value == null) return "not persisted";
  if (value === "1") return "on";
  if (value === "0") return "off";
  return value;
}

function resolveThread(db, query) {
  return (
    db.prepare("SELECT * FROM threads WHERE id = ?").get(query) ||
    db.prepare("SELECT * FROM threads WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${query}%`) ||
    db.prepare("SELECT * FROM threads WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${query}%`)
  );
}

function readSettings(db) {
  const get = db.prepare("SELECT value FROM kv WHERE key = ?");
  const rows = SETTINGS.map(([key, label]) => ({ label, value: setting(get.get(key)?.value) }));
  const disabledClaudeAccounts = db
    .prepare("SELECT key FROM kv WHERE key LIKE 'account_enabled_%' AND value = '0' ORDER BY key")
    .all()
    .map((row) => row.key.replace(/^account_enabled_/, ""));
  rows.push({
    label: "persisted Claude subscription disable overrides",
    value: disabledClaudeAccounts.length ? disabledClaudeAccounts.join(", ") : "none",
  });
  return rows;
}

function renderRouteDecision(thread) {
  const stage = parseJson(thread.stage_outputs);
  const route = stage.routeDecision;
  if (!route) {
    console.log("  No task route decision is persisted.");
    return;
  }
  console.log(`  scope: ${route.scope ?? "not recorded"}`);
  console.log(`  planner: ${route.usePlanner === true ? "yes" : route.usePlanner === false ? "no" : "not recorded"}`);
  console.log(`  QA: ${route.useQa === true ? "yes" : route.useQa === false ? "no" : "not recorded"}`);
  if (route.modelPolicy) {
    console.log(`  model tier: ${route.modelPolicy.tier ?? "not recorded"}`);
    console.log(`  preferred model: ${route.modelPolicy.preferredModel ?? "not recorded"}`);
  }
  if (route.reason) console.log(`  route reason: ${route.reason}`);
  if (Array.isArray(route.signals) && route.signals.length) console.log(`  signals: ${route.signals.join(", ")}`);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0].trim()) {
    usage();
    return 2;
  }
  const dbPath = process.env.ORCH_DB
    ? path.resolve(process.env.ORCH_DB)
    : path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  try {
    const thread = resolveThread(db, argv[0]);
    if (!thread) {
      console.error(`No thread matches "${argv[0]}" (by id or title).`);
      return 1;
    }
    const notes = db
      .prepare("SELECT summary, detail, severity, created_at FROM findings WHERE thread_id = ? ORDER BY created_at ASC")
      .all(thread.id)
      .filter((finding) => ROUTING_NOTE_RE.test(finding.summary));
    const runs = db
      .prepare("SELECT role, model, account, state, started_at FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC")
      .all(thread.id);

    console.log(`\n=== routing evidence: ${thread.title} ===`);
    console.log(`thread: ${thread.id}`);
    console.log(`state: ${thread.state}`);

    console.log("\n=== persisted route ===");
    renderRouteDecision(thread);

    console.log("\n=== current routing settings ===");
    for (const row of readSettings(db)) console.log(`  ${row.label}: ${row.value}`);

    console.log("\n=== decision-time capacity evidence ===");
    if (!notes.length) {
      console.log("  No persisted capacity-routing finding exists for this task.");
    } else {
      for (const note of notes) {
        console.log(`  ${note.summary} (${note.severity})`);
        for (const line of String(note.detail || "").split(/\r?\n/)) console.log(`    ${line}`);
      }
    }

    console.log("\n=== provider run evidence ===");
    if (!runs.length) {
      console.log("  No agent runs are recorded.");
    } else {
      for (const run of runs) {
        console.log(`  ${providerFor(run.model, run.account)} | ${run.role} | ${run.model || "model unknown"} | ${run.state}`);
      }
      const claudeRuns = runs.filter((run) => providerFor(run.model, run.account) === "Claude");
      console.log(`  Claude run recorded: ${claudeRuns.length ? `yes (${claudeRuns.length})` : "no"}`);
    }

    console.log("\nNote: capacity evidence is the saved decision-time snapshot. This probe does not ping providers or alter quota state.");
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseJson, providerFor, resolveThread };
