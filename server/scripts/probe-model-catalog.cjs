#!/usr/bin/env node
// Read-only nightly probe for the model surface Auto-select can draw from.
//
// Provider headroom belongs to probe:accounts. This script answers the orthogonal question that used
// to require hand-reading four caches: which model ids and effort tiers are catalogued, and has the
// server-persisted CLI catalog drifted from the CLI's current visible catalog?

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Database = require("better-sqlite3");

const SERVER_DIR = path.resolve(__dirname, "..");
const DB_PATH = process.env.ORCH_DB || path.join(SERVER_DIR, "data", "orchestrator.sqlite");
const KNOWN_CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function json(raw, fallback) {
  try {
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function stringList(raw) {
  const value = typeof raw === "string" ? json(raw, []) : raw;
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))] : [];
}

function codexRows(raw) {
  const value = typeof raw === "string" ? json(raw, []) : raw;
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const rows = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const efforts = Array.isArray(entry.efforts)
      ? [...new Set(entry.efforts.filter((effort) => typeof effort === "string" && effort.trim()).map((effort) => effort.trim()))]
      : [];
    seen.add(id);
    rows.push({ id, efforts });
  }
  return rows;
}

function visibleCodexRows(body) {
  if (!body || !Array.isArray(body.models)) return [];
  return codexRows(
    body.models
      .filter((model) => model && model.visibility !== "hide")
      .map((model) => ({
        id: model.slug,
        efforts: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map((level) => level?.effort)
          : [],
      })),
  );
}

function visibleGrokModels(body) {
  if (!body?.models || typeof body.models !== "object" || Array.isArray(body.models)) return [];
  return Object.entries(body.models)
    .filter(([, model]) => !model?.info?.hidden)
    .map(([id]) => id.trim())
    .filter(Boolean);
}

function rowMap(rows) {
  return new Map(rows.map((row) => [row.id, row.efforts]));
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function catalogIssues(snapshot) {
  const issues = [];
  const need = (label, enabled, models) => {
    if (enabled && !models.length) issues.push(`${label} is enabled but its authoritative model cache is empty`);
  };

  // Claude is the always-on primary backend. Optional backends only need a live cache when enabled.
  need("Claude", true, snapshot.claudeModels);
  need("Codex", snapshot.codexEnabled, snapshot.codexRows);
  need("Grok", snapshot.grokEnabled, snapshot.grokModels);
  need("z.ai", snapshot.zaiEnabled, snapshot.zaiModels);

  if (snapshot.codexEnabled) {
    if (!snapshot.localCodexRows.length) {
      issues.push("Codex is enabled but models_cache.json is missing, corrupt, or has no visible models");
    } else {
      const cached = rowMap(snapshot.codexRows);
      const local = rowMap(snapshot.localCodexRows);
      for (const [id, efforts] of local) {
        if (!cached.has(id)) issues.push(`Codex cache drift: visible CLI model ${id} is missing from the server cache`);
        else if (!sameValues(efforts, cached.get(id))) issues.push(`Codex cache drift: ${id} efforts are CLI=[${efforts}] server=[${cached.get(id)}]`);
        if (!efforts.length) issues.push(`Codex model ${id} advertises no effort levels`);
        const unknown = efforts.filter((effort) => !KNOWN_CODEX_EFFORTS.includes(effort));
        if (unknown.length) issues.push(`Codex model ${id} advertises unknown effort level(s): ${unknown.join(", ")}`);
      }
      for (const id of cached.keys()) {
        if (!local.has(id)) issues.push(`Codex cache drift: server still exposes ${id}, which is no longer visible in the CLI catalog`);
      }
    }
  }

  if (snapshot.grokEnabled) {
    if (!snapshot.localGrokModels.length) {
      issues.push("Grok is enabled but models_cache.json is missing, corrupt, or has no visible models");
    } else {
      for (const id of snapshot.localGrokModels) {
        if (!snapshot.grokModels.includes(id)) issues.push(`Grok cache drift: visible CLI model ${id} is missing from the server cache`);
      }
      for (const id of snapshot.grokModels) {
        if (!snapshot.localGrokModels.includes(id)) issues.push(`Grok cache drift: server still exposes ${id}, which is no longer visible in the CLI catalog`);
      }
    }
  }
  return issues;
}

function providerLines(label, enabled, models, effortsFor, cap) {
  const lines = [`\n${label} — ${enabled ? "enabled" : "disabled"} · ${models.length} model(s)${cap ? ` · cap ${cap}` : ""}`];
  if (!models.length) lines.push("  (no authoritative cached models)");
  for (const model of models) lines.push(`  ${model}  [${effortsFor(model).join(", ") || "no efforts"}]`);
  return lines;
}

function report(snapshot, effortHelpers) {
  const lines = [
    "\n=== model catalog — Auto-select surface ===",
    `  Auto-select ${snapshot.autoSelect ? "ON" : "off"}. Catalog membership is independent of live headroom; probe:accounts owns readiness.`,
  ];
  lines.push(...providerLines("Claude", true, snapshot.claudeModels, effortHelpers.claude, "per-account"));
  lines.push(...providerLines("Codex", snapshot.codexEnabled, snapshot.codexRows.map((row) => row.id), (id) => rowMap(snapshot.codexRows).get(id) ?? [], snapshot.codexCap));
  lines.push(...providerLines("Grok", snapshot.grokEnabled, snapshot.grokModels, effortHelpers.grok, snapshot.grokCap));
  lines.push(...providerLines("z.ai", snapshot.zaiEnabled, snapshot.zaiModels, () => effortHelpers.zai, snapshot.zaiCap));
  const issues = catalogIssues(snapshot);
  lines.push("", "=== catalog sync ===");
  if (issues.length) for (const issue of issues) lines.push(`  ✗ ${issue}`);
  else lines.push("  ✓ every enabled provider has an authoritative roster; CLI and server caches agree");
  lines.push("");
  return { text: lines.join("\n"), issues };
}

function readJsonFile(file) {
  try {
    return json(fs.readFileSync(file, "utf8"), null);
  } catch {
    return null;
  }
}

function kvReader(db) {
  const stmt = db.prepare("SELECT value FROM kv WHERE key = ?");
  return (key) => stmt.get(key)?.value ?? null;
}

async function main() {
  require("dotenv").config({ path: path.join(SERVER_DIR, ".env"), quiet: true });
  const typesFile = path.join(SERVER_DIR, "dist", "types.js");
  if (!fs.existsSync(typesFile)) throw new Error("server/dist/types.js is missing — build before probing the live catalog");
  const types = await import(pathToFileURL(typesFile).href);
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 4000");
  try {
    const kv = kvReader(db);
    const codexHome = process.env.CODEX_HOME_DIR || path.join(SERVER_DIR, "data", "codex-home");
    const grokHome = process.env.GROK_HOME_DIR || path.join(os.homedir(), ".grok");
    const snapshot = {
      autoSelect: kv("setting_auto_model_selection") === "1",
      codexEnabled: kv("setting_codex_enabled") === "1",
      grokEnabled: kv("setting_grok_enabled") === "1",
      zaiEnabled: kv("setting_zai_enabled") === "1",
      codexCap: kv("setting_codex_effort") || "highest",
      grokCap: kv("setting_grok_effort") || "highest",
      zaiCap: kv("setting_zai_effort") || "high",
      claudeModels: stringList(kv("cache_claude_models")),
      codexRows: codexRows(kv("cache_codex_cli_models")),
      grokModels: stringList(kv("cache_grok_models")),
      zaiModels: stringList(kv("cache_zai_models")),
      localCodexRows: visibleCodexRows(readJsonFile(path.join(codexHome, "models_cache.json"))),
      localGrokModels: visibleGrokModels(readJsonFile(path.join(grokHome, "models_cache.json"))),
    };
    const result = report(snapshot, {
      claude: (model) => [...types.claudeEffortsForModel(model)],
      grok: (model) => [...types.grokEffortsForModel(model)],
      zai: [...types.ZAI_EFFORTS],
    });
    console.log(result.text);
    return result.issues.length ? 1 : 0;
  } finally {
    db.close();
  }
}

module.exports = { catalogIssues, codexRows, report, stringList, visibleCodexRows, visibleGrokModels };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`model catalog probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
