#!/usr/bin/env node
// Runs every FREE test gate (pure unit + stubbed integration) in one shot and
// exits non-zero if any fails. Deliberately excludes reader/structured/effort:
// those .itest gates spawn real `claude` subprocesses and burn account quota, so
// they are not safe for an unattended nightly sweep. Keep this list in sync with
// package.json test scripts when adding a new FREE gate.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");

const GATES = [
  "test:cron",
  "test:weekly-safety",
  "test:spread-usage",
  "test:ext-wake",
  "test:grok-runner",
  "test:grok-reasoning",
  "test:schedule-detect",
  "test:scheduler",
  "test:api-errors",
  "test:office-bridge",
  "test:zai-usage",
  "test:token-freeze",
  "test:qa-budget",
];

// npm is a .cmd on Windows; Node blocks spawning .cmd/.bat without a shell, so
// run through the shell there. On POSIX a plain `npm` invocation is enough.
const win = process.platform === "win32";

function runGate(gate) {
  const started = Date.now();
  const res = spawnSync("npm", ["run", gate], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: win,
  });
  const ms = Date.now() - started;
  const output = `${res.stdout || ""}${res.stderr || ""}${res.error ? String(res.error) : ""}`;
  return { gate, ok: res.status === 0, ms, output };
}

function tail(text, n) {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

function main() {
  console.log(`\n=== running ${GATES.length} free test gates ===\n`);
  const results = [];
  for (const gate of GATES) {
    process.stdout.write(`  … ${gate} `);
    const r = runGate(gate);
    results.push(r);
    console.log(`${r.ok ? "✓" : "✗"} (${(r.ms / 1000).toFixed(1)}s)`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== summary ===");
  console.log(`  ${results.length - failed.length}/${results.length} gates passed`);
  for (const r of failed) {
    console.log(`\n  ✗ ${r.gate} — last output:`);
    console.log(
      tail(r.output, 12)
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
  process.exit(failed.length ? 1 : 0);
}

main();
