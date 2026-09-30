import assert from "node:assert/strict";
import {
  DEFAULT_SORT,
  categoryLabel,
  filterRows,
  formatRelease,
  formatScore,
  liveBenchColumns,
  nextSort,
  rankRows,
  sortRows,
  type LiveBenchRowDTO,
  type SortState,
} from "../src/lib/liveBench.js";

const row = (model: string, overall: number, categories: Record<string, number>, organization?: string, usableAs: string[] = []): LiveBenchRowDTO => ({
  model,
  overall,
  categories,
  organization,
  usableAs,
});

const rows = rankRows([
  row("gpt-6.1-sol-max", 80.4, { Reasoning: 91.2, Coding: 88, IF: 70 }, "OpenAI", ["codex:gpt-6.1-sol"]),
  row("claude-opus-5-5-xhigh-effort", 82.1, { Reasoning: 90, Coding: 9.5, IF: 71 }, "Anthropic", ["claude:claude-opus-5-5"]),
  row("deepseek-v4-pro", 74, { Reasoning: 80, IF: 60 }),
  row("glm-5.3", 80.4, { Reasoning: 70, Coding: 100, IF: 65 }, "Z.AI"),
  row("Zeta-model-10", 60, { Reasoning: 50, Coding: 40, IF: 30 }, "anthropic"),
]);
const columns = liveBenchColumns(["Reasoning", "Coding", "IF"]);
const models = (sort: SortState, input = rows) => sortRows(input, columns, sort).map((r) => r.model);
const column = (key: string) => columns.find((c) => c.key === key)!;

assert.deepEqual(
  columns.map((c) => c.label),
  ["Rank", "Model", "Organization", "Global Average", "Reasoning", "Coding", "Instruction Following"],
  "columns come from the snapshot's categories, after rank/model/organization/global average",
);
assert.equal(categoryLabel("Agentic Coding"), "Agentic Coding", "an unknown category keeps its own readable name");
assert.equal(liveBenchColumns(["Reasoning", "Brand New"]).at(-1)?.label, "Brand New", "a category the console never heard of still gets a column");

assert.deepEqual(
  rows.map((r) => [r.model, r.rank]),
  [["gpt-6.1-sol-max", 2], ["claude-opus-5-5-xhigh-effort", 1], ["deepseek-v4-pro", 4], ["glm-5.3", 2], ["Zeta-model-10", 5]],
  "rank is competition rank by global average — ties share a rank and the next one skips",
);

assert.deepEqual(DEFAULT_SORT, { key: "overall", direction: "desc" }, "the table opens on global average, highest first");
assert.deepEqual(
  models(DEFAULT_SORT),
  ["claude-opus-5-5-xhigh-effort", "glm-5.3", "gpt-6.1-sol-max", "deepseek-v4-pro", "Zeta-model-10"],
  "numbers sort numerically, ties fall back to model name",
);
assert.deepEqual(
  models({ key: "overall", direction: "asc" }),
  ["Zeta-model-10", "deepseek-v4-pro", "glm-5.3", "gpt-6.1-sol-max", "claude-opus-5-5-xhigh-effort"],
  "the reverse direction is the exact reverse for distinct values",
);
assert.deepEqual(
  models({ key: "category:Coding", direction: "desc" }),
  ["glm-5.3", "gpt-6.1-sol-max", "Zeta-model-10", "claude-opus-5-5-xhigh-effort", "deepseek-v4-pro"],
  "9.5 sorts below 40 — numeric, not lexical — and the model with no Coding score is last",
);
assert.equal(
  models({ key: "category:Coding", direction: "asc" }).at(-1),
  "deepseek-v4-pro",
  "a missing score stays last when the direction flips",
);
assert.deepEqual(
  models({ key: "organization", direction: "asc" }),
  ["claude-opus-5-5-xhigh-effort", "Zeta-model-10", "gpt-6.1-sol-max", "glm-5.3", "deepseek-v4-pro"],
  "text sorts alphabetically, case-insensitively, with the unknown organization last",
);
assert.deepEqual(
  models({ key: "organization", direction: "desc" }),
  ["glm-5.3", "gpt-6.1-sol-max", "claude-opus-5-5-xhigh-effort", "Zeta-model-10", "deepseek-v4-pro"],
  "reversed text order still puts the missing organization last",
);
assert.deepEqual(
  models({ key: "model", direction: "asc" }, rankRows([row("model-10", 1, {}), row("model-9", 1, {}), row("Model-2", 1, {})])),
  ["Model-2", "model-9", "model-10"],
  "model names compare with numeric awareness, so 9 comes before 10",
);
assert.deepEqual(models({ key: "rank", direction: "asc" }).slice(0, 3), ["claude-opus-5-5-xhigh-effort", "glm-5.3", "gpt-6.1-sol-max"], "rank sorts best first");
assert.equal(models({ key: "no-such-column", direction: "desc" })[0], "claude-opus-5-5-xhigh-effort", "an unknown sort key falls back to global average");

assert.deepEqual(nextSort(DEFAULT_SORT, column("overall")), { key: "overall", direction: "asc" }, "clicking the sorted column reverses it");
assert.deepEqual(nextSort({ key: "overall", direction: "asc" }, column("overall")), { key: "overall", direction: "desc" }, "and clicking again reverses it back");
assert.deepEqual(nextSort(DEFAULT_SORT, column("model")), { key: "model", direction: "asc" }, "a text column starts A to Z");
assert.deepEqual(nextSort(DEFAULT_SORT, column("category:IF")), { key: "category:IF", direction: "desc" }, "a score column starts highest first");
assert.deepEqual(nextSort(DEFAULT_SORT, column("rank")), { key: "rank", direction: "asc" }, "rank starts at #1");

assert.deepEqual(filterRows(rows, "  ANTHROPIC ", false).map((r) => r.model), ["claude-opus-5-5-xhigh-effort", "Zeta-model-10"], "filter matches organization, case-insensitively");
assert.deepEqual(filterRows(rows, "opus xhigh", false).map((r) => r.model), ["claude-opus-5-5-xhigh-effort"], "every filter term must match");
assert.deepEqual(filterRows(rows, "", true).map((r) => r.model), ["gpt-6.1-sol-max", "claude-opus-5-5-xhigh-effort"], "runnable-only keeps rows GGO can run");

assert.equal(formatScore(9.5), "9.5");
assert.equal(formatScore(80), "80.0", "scores keep one decimal so the column aligns");
assert.equal(formatScore(null), "—");
assert.equal(formatRelease("2026-06-25"), "25 Jun 2026", "a release date is a calendar date, not shifted by the viewer's timezone");

console.log("livebench rankings: sort, rank, filter and format checks passed");
