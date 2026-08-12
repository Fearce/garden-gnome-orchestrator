#!/usr/bin/env node
// The canonical nightly sweep: runs every step of .claude/rules/nightly-quality-sweep.md
// and prints one verdict at the end.
//
//   npm run quality              all steps
//   npm run quality -- --list    what it would run
//   npm run quality -- 2 7       only steps 2 and 7 (re-checking a failure)
//
// It deliberately does NOT stop at the first failure. The point of a sweep is the whole
// picture: an `&&` chain that dies on step 2 hides whether the parks, the ladder and the
// DB are healthy, and the next run has to be driven by hand step by step to find out.
// Every step is read-only, so continuing past a failure is safe.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server");

// step = the numbered section in the rule; several sections take more than one command.
const STEPS = [
  { step: 1, name: "health", what: "server up, dist vs HEAD, parks/caps, crash log", script: "health", cwd: SERVER },
  { step: 2, name: "typecheck", what: "server + web", script: "typecheck", cwd: ROOT },
  { step: 2, name: "gates", what: "every FREE test gate (~9 min)", script: "test:gates", cwd: SERVER },
  { step: 3, name: "run-errors", what: "triage the non-done runs", script: "probe:run-errors", cwd: SERVER },
  { step: 4, name: "parks", what: "parked + abandoned tasks", script: "probe:parks", cwd: SERVER },
  { step: 5, name: "accounts", what: "backend headroom + failover ladder", script: "probe:accounts", cwd: SERVER },
  { step: 6, name: "console", what: "the console still mounts", script: "probe:console", cwd: ROOT },
  { step: 6, name: "chips", what: "account chips unclipped at 4 widths", script: "probe:chips", cwd: ROOT },
  { step: 7, name: "audit-deps", what: "prod dependency advisories + overrides", script: "audit:deps", cwd: SERVER },
  { step: 7, name: "audit-secrets", what: "secrets in tree or history", script: "audit:secrets", cwd: SERVER },
  { step: 8, name: "db-size", what: "what the DB is made of", script: "probe:db-size", cwd: SERVER },
];

// npm is a .cmd on Windows; Node refuses to spawn .cmd/.bat without a shell.
const win = process.platform === "win32";

function run(entry) {
  const started = Date.now();
  const res = spawnSync("npm", ["run", entry.script], { cwd: entry.cwd, stdio: "inherit", shell: win });
  return { ...entry, ok: res.status === 0, ms: Date.now() - started };
}

function selected(argv) {
  const wanted = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  if (!wanted.length) return STEPS;
  return STEPS.filter((s) => wanted.includes(s.step));
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function report(results) {
  const failed = results.filter((r) => !r.ok);
  console.log("\n\n=== sweep summary ===\n");
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} step ${r.step}  ${pad(r.name, 15)} ${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)} ${r.what}`);
  }
  console.log("");
  if (!failed.length) {
    console.log(`  ✓ all ${results.length} check(s) green.`);
    console.log("    Green is not the whole job: read the ladder depth, the park counts and the DB growth");
    console.log("    above — those are healthy-but-worth-watching, and no exit code carries them.");
    return 0;
  }
  console.log(`  ✗ ${failed.length} of ${results.length} check(s) failed: ${failed.map((f) => f.name).join(", ")}`);
  console.log(`    Re-run just those with: npm run quality -- ${[...new Set(failed.map((f) => f.step))].join(" ")}`);
  return 1;
}

function main() {
  const argv = process.argv.slice(2);
  const steps = selected(argv);

  if (argv.includes("--list")) {
    for (const s of steps) console.log(`  step ${s.step}  ${pad(s.name, 15)} npm run ${s.script}`);
    return 0;
  }

  console.log(`=== nightly quality sweep — ${steps.length} check(s) ===`);
  console.log("    every step runs even if an earlier one fails; the verdict is at the end.\n");

  const results = [];
  for (const s of steps) {
    console.log(`\n──────── step ${s.step}: ${s.name} — ${s.what} ────────`);
    results.push(run(s));
  }
  return report(results);
}

process.exit(main());
