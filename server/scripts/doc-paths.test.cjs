#!/usr/bin/env node
"use strict";
/*
 * Gate for `doc-paths.cjs` (`npm run test:doc-paths`).
 *
 * The checker's whole value is catching a pointer that stopped resolving, so the first half of this
 * gate is the revert-check discipline `threadmanager-itest.md` insists on: build a fixture repo whose
 * docs contain each defect and require the checker to REPORT it. A checker trusted only because it is
 * quiet on a clean tree is a decoration, and this one would be the third generation of decoration on
 * exactly this problem.
 *
 * The second half runs it against the real repo, which is what keeps CLAUDE.md and .claude/rules
 * honest on every nightly sweep.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scan, isPlaceholder } = require("./doc-paths.cjs");

let passed = 0;
const failures = [];
function check(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

/** A throwaway repo shaped like this one: package roots, a rules dir, and one real source file. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-paths-"));
  fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "src", "orchestrator"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "src", "orchestrator", "cowork.ts"), "// real\n");
  fs.writeFileSync(path.join(root, "server", "scripts", "real-probe.cjs"), "// real\n");
  fs.writeFileSync(path.join(root, "web", "src", "lib", "format.ts"), "// real\n");
  fs.writeFileSync(
    path.join(root, "server", "package.json"),
    JSON.stringify({ scripts: { "test:real": "node scripts/real-probe.cjs" } }, null, 2),
  );
  return root;
}

function writeDoc(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

const root = fixture();
try {
  console.log("doc-paths: it detects what it exists to detect");

  writeDoc(root, "CLAUDE.md", [
    "The lane lives in `orchestrator/cowork.ts` and the helper in `lib/format.ts`.",
    "Run `npm run test:real --prefix server` to check it.",
    "",
    "The recipe is in `orchestrator/ghostModule.ts`, or run `npm run test:ghost --prefix server`.",
  ].join("\n"));

  const found = scan({ root, docs: ["CLAUDE.md"] });
  check(
    "a cited file that does not exist is reported",
    found.missingPaths.some((m) => m.cited === "orchestrator/ghostModule.ts"),
  );
  check(
    "a cited npm script that does not exist is reported",
    found.missingScripts.some((m) => m.script === "test:ghost"),
  );
  check(
    "package-relative shorthand still resolves, so the house style is not flagged",
    !found.missingPaths.some((m) => m.cited === "orchestrator/cowork.ts" || m.cited === "lib/format.ts"),
  );
  check(
    "a live npm script is not flagged",
    !found.missingScripts.some((m) => m.script === "test:real"),
  );
  check("the report names the doc and its line", found.missingPaths.every((m) => m.doc === "CLAUDE.md" && m.line > 0));
  check(
    "a dead pointer cited twice is reported once",
    (() => {
      writeDoc(root, "twice.md", "`orchestrator/ghostModule.ts` and again `orchestrator/ghostModule.ts`.");
      return scan({ root, docs: ["twice.md"] }).missingPaths.length === 1;
    })(),
  );

  console.log("\ndoc-paths: what it deliberately lets through");
  check("a command line in backticks is not a citation", isPlaceholder("node dist/index.js"));
  check("an env assignment is not a citation", isPlaceholder("GGO_LAB_ENTRY=.cowork-lab-dist/index.js"));
  check("a placeholder path is not a citation", isPlaceholder("docs/<name>.md"));
  check("runtime state under data/ is not a citation", isPlaceholder("server/data/gates-last.log"));
  check(
    "a home path is counted as unchecked rather than failed",
    (() => {
      writeDoc(root, "home.md", "It lives at `~/Claude/tools/safe-commit.sh` on the owner's machine.");
      const result = scan({ root, docs: ["home.md"] });
      return result.unchecked === 1 && result.missingPaths.length === 0;
    })(),
  );
  check(
    "a doc-relative parent path resolves against the doc's own directory",
    (() => {
      writeDoc(root, "docs/inner.md", "See `../CLAUDE.md`.");
      return scan({ root, docs: ["docs/inner.md"] }).missingPaths.length === 0;
    })(),
  );

  console.log("\ndoc-paths: the real repository");
  const live = scan();
  for (const miss of live.missingPaths) console.log(`     ${miss.doc}:${miss.line} -> ${miss.cited}`);
  for (const miss of live.missingScripts) console.log(`     ${miss.doc}:${miss.line} -> npm run ${miss.script}`);
  check(
    `every cited repo path resolves (${live.checkedPaths} checked across ${live.docs} docs)`,
    live.missingPaths.length === 0,
  );
  check(
    `every cited npm script exists (${live.checkedScripts} checked)`,
    live.missingScripts.length === 0,
  );
  check("the scan actually found citations to check", live.checkedPaths > 50 && live.checkedScripts > 20);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
