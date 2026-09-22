#!/usr/bin/env node
// A model retirement is cross-cutting: defaults, routing text, docs, fixtures, and probes all carry
// ids. Keep the former Claude flagship from silently returning through any of those surfaces.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const TEXT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".md", ".ts", ".tsx"]);
const retiredId = ["claude", "opus", "5"].join("-");
const retiredDisplayName = ["Opus", "5"].join(" ");
const retiredPatterns = [
  new RegExp(`\\b${retiredId}(?![-.0-9])`, "i"),
  new RegExp(`\\b${retiredDisplayName}(?![.0-9])`),
];

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()))
  // Fixtures may name the predecessor explicitly to prove it is rejected. This audit protects the
  // runtime and owner-facing surfaces where such a reference could become a real selection.
  .filter((file) => !/\.(?:test|itest)\.[^.]+$/i.test(file));

const matches = [];
for (const file of tracked) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const pattern of retiredPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    matches.push(`${file}:${line}: ${match[0]}`);
  }
}

assert.deepEqual(
  matches,
  [],
  `Retired Claude flagship references found. Use ${["claude", "opus", "5", "5"].join("-")} / ${["Opus", "5.5"].join(" ")} instead:\n${matches.join("\n")}`,
);

console.log(`Retired-model audit passed — ${tracked.length} tracked text file(s) contain no retired flagship references.`);
