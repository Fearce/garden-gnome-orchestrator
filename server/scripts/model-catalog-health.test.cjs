#!/usr/bin/env node
const assert = require("node:assert/strict");
const { catalogIssues, codexRows, report, stringList, visibleCodexRows, visibleGrokModels } = require("./probe-model-catalog.cjs");

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
  zaiCap: "high",
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

const disabled = { ...healthy, codexEnabled: false, grokEnabled: false, zaiEnabled: false, codexRows: [], grokModels: [], zaiModels: [] };
assert.deepEqual(catalogIssues(disabled), [], "disabled optional providers do not require caches");
assert.ok(catalogIssues({ ...disabled, claudeModels: [] }).some((line) => line.startsWith("Claude")), "the primary Claude roster is always required");

const rendered = report(healthy, { claude: () => ["low", "max"], grok: () => ["low", "xhigh"], zai: ["low", "medium", "high"] });
assert.match(rendered.text, /Auto-select ON/);
assert.match(rendered.text, /gpt-sol  \[low, ultra\]/, "the exact Codex effort matrix is owner-visible");
assert.match(rendered.text, /every enabled provider has an authoritative roster/);

console.log("modelCatalogHealth: all assertions passed");
