#!/usr/bin/env node
// Gate: the deferred background services are actually started at boot.
//
// `index.ts` starts eleven optional services (usage pings, scheduler, model catalog, search
// backfill, the alt-backend usage monitors, …) from one deferred `startBackgroundServices()`
// so none of them can delay `listen()`. Nothing type-checks or greps differently when that
// single call site disappears — the server still boots, serves the console and dispatches
// tasks, so every existing check stays green while the console quietly goes blind.
//
// That shipped on 2026-08-26 (ca66983): the call was replaced by a comment as a debugging
// step, committed, deployed, and never restored. Both subscription usage meters read "–" for
// hours because `accounts.start()` never ran — AccountManager kept its constructor's pristine
// state, so it neither pinged nor restored the persisted snapshot the database still held.
//
// So this asserts two things a rename can't fake: the entry point is CALLED (as a statement,
// not a comment), and every service the console depends on is still in the list it runs.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX = path.resolve(__dirname, "..", "src", "index.ts");
const ENTRY = "startBackgroundServices";

// Services whose absence is invisible until a human notices a dead panel hours later.
// Each entry is the source fragment that starts it, and why its loss goes unnoticed.
const REQUIRED = [
  ["accounts.start()", "both Claude subscription usage meters read '–' (the 2026-08-26 outage)"],
  ["scheduler.start()", "scheduled tasks never fire"],
  ["onlineOffice.start()", "cross-machine office peers never connect"],
  ["manager.startModelCatalog()", "the Settings model dropdowns go empty"],
  ["freeProviders.start()", "the free-provider lab stops refreshing"],
  ["startUpdatePoll()", "the 'update available' badge never appears"],
  ["startSearchIndexBackfill(", "a fresh database never builds its trigram index, so search full-scans forever"],
  ["startCodexUsageMonitor(", "the Codex chip freezes at its last reading"],
  ["startGrokUsageMonitor(", "the Grok chip freezes at its last reading"],
  ["startZaiUsageMonitor(", "the z.ai chip freezes at its last reading"],
  ["startWebAutoBuild()", "web/dist stops rebuilding after a web-only change"],
];

const raw = fs.readFileSync(INDEX, "utf8");

// Drop block comments so a commented-out call can't satisfy the gate. Line comments need no
// stripping: every check below is anchored to the start of a line, which `// …` already fails.
// (Deliberately not a full tokenizer — this file has no `/*` inside a string literal.)
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "");

const declared = new RegExp(`(?:const|function)\\s+${ENTRY}\\b`).test(src);
assert.ok(declared, `${INDEX} no longer declares ${ENTRY} — update this gate along with the rename.`);

// A real call is a statement on its own line. `// startBackgroundServices();` cannot match it,
// which is precisely how the outage above was introduced.
const callSites = src.split("\n").filter((l) => new RegExp(`^\\s*(?:void\\s+)?${ENTRY}\\(\\s*\\)\\s*;?\\s*$`).test(l));
assert.ok(
  callSites.length > 0,
  `${ENTRY}() is declared in src/index.ts but never CALLED, so no background service starts at boot.\n` +
    `  The server still boots and dispatches, so nothing else goes red — the console just stops\n` +
    `  updating (usage meters, scheduler, model catalog, search index). Restore the call after listen().\n` +
    `  If you are disabling it to debug a slow boot: do that behind an env flag, never by deleting the call.`,
);

const block = src.match(/const starters:\s*Array<\(\)\s*=>\s*void>\s*=\s*\[([\s\S]*?)\n\s*\];/);
assert.ok(block, "src/index.ts no longer declares the `const starters: Array<() => void> = [...]` list.");
const starters = block[1];

const missing = REQUIRED.filter(([fragment]) => !starters.includes(fragment));
assert.deepEqual(
  missing.map(([fragment]) => fragment),
  [],
  `background service(s) dropped from the starters list — nothing else notices:\n` +
    missing.map(([fragment, why]) => `    ${fragment} → ${why}`).join("\n"),
);

console.log(
  `Background startup OK — ${ENTRY}() called at ${callSites.length} site(s), ` +
    `all ${REQUIRED.length} required service(s) in the starters list.`,
);
