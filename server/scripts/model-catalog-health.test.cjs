#!/usr/bin/env node
const assert = require("node:assert/strict");
const { catalogIssues, codexRows, grokCatalogFromLog, report, stringList, visibleCodexRows, visibleGrokModels } = require("./probe-model-catalog.cjs");

assert.deepEqual(stringList('["a","a"," ","b"]'), ["a", "b"], "cached lists are trimmed and deduplicated");
assert.deepEqual(stringList("broken"), [], "a corrupt cached list fails closed as empty");

const cliRows = visibleCodexRows({
  models: [
    { slug: "gpt-sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
    { slug: "service-only", visibility: "hide", supported_reasoning_levels: [{ effort: "max" }] },
  ],
});
assert.deepEqual(cliRows, [{ id: "gpt-sol", efforts: ["low", "ultra"] }], "hidden Codex service models never enter the probe surface");
assert.deepEqual(codexRows('[{"id":"gpt-sol","efforts":["low","low","ultra"]}]'), cliRows, "persisted Codex rows normalize like CLI rows");
assert.deepEqual(
  visibleGrokModels({ models: { "grok-live": {}, "grok-hidden": { info: { hidden: true } } } }),
  ["grok-live"],
  "hidden Grok models never enter the probe surface",
);

const healthy = {
  autoSelect: true,
  codexEnabled: true,
  grokEnabled: true,
  zaiEnabled: true,
  codexCap: "ultra",
  grokCap: "xhigh",
  zaiCap: "max",
  claudeModels: ["claude-opus"],
  codexRows: cliRows,
  grokModels: ["grok-live"],
  zaiModels: ["glm-live"],
  localCodexRows: cliRows,
  localGrokModels: ["grok-live"],
};
assert.deepEqual(catalogIssues(healthy), [], "matching non-empty authoritative catalogs are healthy");

const drift = catalogIssues({
  ...healthy,
  codexRows: [{ id: "gpt-sol", efforts: ["low", "max"] }, { id: "removed", efforts: ["low"] }],
  localCodexRows: [{ id: "gpt-sol", efforts: ["low", "ultra"] }, { id: "new", efforts: ["low", "turbo"] }],
  grokModels: ["old-grok"],
});
assert.ok(drift.some((line) => line.includes("gpt-sol efforts")), "an effort-tier change is reported");
assert.ok(drift.some((line) => line.includes("new") && line.includes("missing")), "a new visible Codex model is reported");
assert.ok(drift.some((line) => line.includes("removed") && line.includes("no longer visible")), "a removed Codex model is reported");
assert.ok(drift.some((line) => line.includes("turbo") && line.includes("unknown")), "an unknown effort is reported instead of silently dropped");
assert.ok(drift.some((line) => line.includes("Grok cache drift")), "Grok cache drift is reported too");

// --- Grok with NO models_cache.json -----------------------------------------------------------
// The CLI deletes that file on every self-update and only rewrites it when a session next persists
// the catalog, so a routine `grok update` used to assert drift the probe had no evidence of, every
// night, until a TUI happened to run. The log keeps stating the catalog's SIZE across that gap.
const noCache = { ...healthy, localGrokModels: [] };
assert.deepEqual(
  catalogIssues({ ...noCache, grokLogCatalog: { modelCount: 1, currentModelId: "grok-live", at: Date.now() } }),
  [],
  "a CLI log agreeing on the count and the selected id is evidence enough to stay quiet",
);
const countDrift = catalogIssues({ ...noCache, grokLogCatalog: { modelCount: 3, currentModelId: "grok-live", at: Date.now() } });
assert.ok(
  countDrift.some((line) => line.includes("reports 3 visible model(s)") && line.includes("server offers 1")),
  `a roster that grew is caught WITHOUT the cache file — the state the old check hid entirely: ${countDrift.join(" | ")}`,
);
assert.ok(
  catalogIssues({ ...noCache, grokLogCatalog: { modelCount: 1, currentModelId: "grok-next", at: Date.now() } }).some((line) =>
    line.includes("selected model grok-next"),
  ),
  "a same-sized roster whose selected model the server does not know is still drift",
);
assert.ok(
  catalogIssues({ ...noCache, grokLogCatalog: null }).some((line) => line.includes("currency is not proved")),
  "no cache and no log statement is UNKNOWN, and unknown is never green",
);

const disabled = { ...healthy, codexEnabled: false, grokEnabled: false, zaiEnabled: false, codexRows: [], grokModels: [], zaiModels: [] };
assert.deepEqual(catalogIssues(disabled), [], "disabled optional providers do not require caches");
assert.ok(catalogIssues({ ...disabled, claudeModels: [] }).some((line) => line.startsWith("Claude")), "the primary Claude roster is always required");

// The log reader itself: newest statement wins, an undated or countless line is not a statement.
{
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-catalog-log-"));
  const file = path.join(dir, "unified.jsonl");
  try {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: "2026-09-12T01:00:00.000Z", msg: "model catalog: fetch succeeded", ctx: { model_count: 4 } }),
        JSON.stringify({ ts: "2026-09-12T01:26:57.215Z", msg: "model catalog: notifying clients", ctx: { model_count: 1, current_model_id: "grok-4.6" } }),
        JSON.stringify({ ts: "2026-09-12T01:10:00.000Z", msg: "model catalog: notifying clients", ctx: { model_count: 9 } }),
        JSON.stringify({ msg: "model catalog: notifying clients", ctx: { model_count: 99 } }),
        "not json at all",
        JSON.stringify({ ts: "2026-09-12T02:00:00.000Z", msg: "billing: fetched credits config", ctx: { model_count: 77 } }),
      ].join("\n"),
      "utf8",
    );
    assert.deepEqual(
      grokCatalogFromLog(file),
      { modelCount: 1, currentModelId: "grok-4.6", at: Date.parse("2026-09-12T01:26:57.215Z") },
      "the newest dated catalog statement wins; an undated line, a non-catalog line and garbage are all ignored",
    );
    assert.equal(grokCatalogFromLog(path.join(dir, "absent.jsonl")), null, "a missing log is no statement, never a fabricated one");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rendered = report(healthy, { claude: () => ["low", "max"], grok: () => ["low", "xhigh"], zai: () => ["low", "high", "max"] });
assert.match(rendered.text, /Auto-select ON/);
assert.match(rendered.text, /gpt-sol  \[low, ultra\]/, "the exact Codex effort matrix is owner-visible");
assert.match(rendered.text, /glm-live  \[low, high, max\]/, "the exact z.ai effort matrix is owner-visible");
assert.match(rendered.text, /every enabled provider has an authoritative roster/);

console.log("modelCatalogHealth: all assertions passed");
