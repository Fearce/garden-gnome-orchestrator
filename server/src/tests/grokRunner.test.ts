// Regression for concurrent Grok takeovers sharing one server process. No Grok login/CLI/network needed.
// Run: npx tsx src/tests/grokRunner.test.ts

import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { stageGrokPrompt } from "../agents/grokRunner.js";

const prompts = Array.from({ length: 32 }, (_, i) => `task-specific-prompt-${i}`);
const paths = await Promise.all(prompts.map(stageGrokPrompt));

try {
  assert.ok(paths.every((path): path is string => typeof path === "string"));
  assert.equal(new Set(paths).size, prompts.length, "each concurrent Grok run must own a unique prompt file");
  const staged = await Promise.all(paths.map((path) => readFile(path!, "utf8")));
  assert.deepEqual(staged, prompts, "concurrent staging must not cross-contaminate task prompts");
} finally {
  await Promise.all(paths.map((path) => path ? unlink(path).catch(() => {}) : Promise.resolve()));
}

console.log("All Grok runner concurrency checks passed.");
