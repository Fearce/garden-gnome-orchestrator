#!/usr/bin/env node
"use strict";
/*
 * Do the docs still point at things that exist? (`npm run probe:doc-paths`, gate `test:doc-paths`)
 *
 * WHY THIS EXISTS
 * ---------------
 * `.claude/rules/nightly-quality-sweep.md` carried a "Related" entry that had been wrong FOUR TIMES,
 * each time by naming a helper script or memory file that is not where it says. It even opens by
 * admitting it ("this entry has now been wrong three times... `ls` before you trust any path here,
 * including this version"), and the version carrying that warning was itself wrong in both
 * directions. Prose cannot fix prose: the fourth agent to read it hand-rolled a hunk splitter that
 * already existed, because the doc said it did not.
 *
 * This repo's answer to a claim that rots is always the same one: make it a gate. `test:mirror-drift`
 * enforces every "mirrored byte-for-byte in <file>" comment; `test:gate-registration` enforces that a
 * test script is really in the suite. This enforces that a path or `npm run` script a doc cites is
 * real.
 *
 * WHAT IT DOES NOT CHECK, AND WHY
 * -------------------------------
 * Only REPO-RELATIVE paths and this repo's own npm scripts, because only those are the same on every
 * machine. A `~/Claude/tools/x.sh` is real on the owner's box and absent on another contributor's, so
 * a gate that asserted either way would be wrong half the time, which is exactly how the entry above
 * got wrong twice in opposite directions. Home-absolute paths are counted and reported as UNCHECKED,
 * never failed; a doc citing one should say which machine it means.
 *
 * It proves a path RESOLVES. It cannot prove the file still says what the doc claims: that is a
 * `file:line` citation checker's job, and a human's for the rest.
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The docs an agent is told to trust: the repo brief, the rulebook, and the architecture notes. */
function docFiles(root = REPO_ROOT) {
  const out = [];
  const add = (rel) => {
    if (fs.existsSync(path.join(root, rel))) out.push(rel);
  };
  add("CLAUDE.md");
  add("AGENTS.md");
  for (const dir of [".claude/rules", "docs"]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith(".md")) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

const BACKSLASH = String.fromCharCode(92);

/** A citation only counts when it names a FILE: something with a separator and a known extension.
 *  Prose full of dots ("e.g. foo.bar") and bare directory names would otherwise flood the report. */
const FILE_EXT = /\.(md|ts|tsx|cjs|mjs|js|jsx|json|css|html|sh|ps1|py|sqlite|log|txt|yml|yaml|env|sql|svg|png)$/i;

/** These docs cite a file the way the person editing it thinks of it, which is relative to its own
 *  package rather than the repo root: `orchestrator/cowork.ts`, `lib/format.ts`, `scripts/run-gates.cjs`.
 *  That shorthand is the house style in every rule file, so resolving it is the checker's job, not
 *  something to "fix" across a hundred doc lines. A citation is live if it resolves under ANY of these
 *  roots, or under the citing doc's own directory (which is what makes `../FOO.md` work). */
const SEARCH_ROOTS = [".", "server", "server/src", "web", "web/src", "relay", "relay/src"];

/** Paths that are deliberately illustrative rather than real, kept here WITH their reason so the next
 *  reader can tell an exemption from an oversight. Keep this list short: an entry that is really rot
 *  belongs in the doc's own fix, not in here. */
const ILLUSTRATIVE = new Map([
  ["src/api/routes.ts", "task-modes.md's worked example of two colliding ownership paths"],
  ["agents/xUsage.ts", "add-an-implementor-backend.md's template, where x IS the new backend's name"],
  ["extension/package.json", "ide-workspace.md: a path INSIDE an imported .vsix archive, not in this repo"],
  ["docs/providers.md", "pi-harness-evaluation.md quoting the Pi project's own documentation"],
  [".claude/settings.json", "pi-harness-evaluation.md: the operator's machine-level settings file"],
]);

/** Anything standing in for a value the reader supplies is not a path to check. */
function isPlaceholder(text) {
  if (/\s/.test(text)) return true;            // a command line, not a citation ("node dist/index.js")
  if (/=/.test(text)) return true;             // an env assignment ("GGO_LAB_ENTRY=.../index.js")
  if (/[<>*?|"]/.test(text)) return true;
  if (/\{|\}/.test(text)) return true;
  if (/\.\.\.|…/.test(text)) return true;
  if (/^https?:|^git@|^ssh:/.test(text)) return true;
  if (/(^|[\\/])(path|dir|folder)[\\/]to([\\/]|$)/i.test(text)) return true;
  // Runtime state (`server/data/*`): real paths that exist only once something has run, so their
  // absence in a fresh checkout says nothing about the doc.
  if (/(^|[\\/])data[\\/]/.test(text)) return true;
  if (ILLUSTRATIVE.has(text)) return true;
  return false;
}

function isHomeOrAbsolute(text) {
  if (text.startsWith("~")) return true;
  if (text.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(text)) return true;
  if (text.startsWith(BACKSLASH)) return true;
  return false;
}

/** Backticked spans are where this repo puts every path it means literally. */
function* backticked(text) {
  for (const match of text.matchAll(/`([^`\n]+)`/g)) yield match[1].trim();
}

function lineOf(text, index) {
  return text.slice(0, Math.max(0, index)).split("\n").length;
}

/** Every `npm run <script>` a doc tells the reader to run, with the package it would run in. */
function* npmScripts(text) {
  const re = /npm run ([a-z0-9:_-]+)((?: --)?\s+--prefix\s+([a-z]+))?/gi;
  for (const match of text.matchAll(re)) {
    yield { script: match[1], pkg: match[3] || null, line: lineOf(text, match.index) };
  }
}

function readScripts(root, pkgDir) {
  const file = path.join(root, pkgDir || ".", "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).scripts || {};
  } catch {
    return null;
  }
}

/** `npm run x` with no --prefix runs from wherever the doc's reader is standing, and these docs use
 *  both the root and `server/`. Accept the script if ANY workspace defines it; a script that exists
 *  nowhere is the dead pointer we are after. */
function npmScriptExists(script, pkg, root = REPO_ROOT) {
  const dirs = pkg ? [pkg] : [".", "server", "web", "relay"];
  return dirs.some((dir) => {
    const scripts = readScripts(root, dir);
    return !!scripts && Object.prototype.hasOwnProperty.call(scripts, script);
  });
}

/** Live if it resolves under the citing doc's own directory or any package root. */
function resolves(root, rel, doc) {
  const roots = [path.dirname(path.join(root, doc)), ...SEARCH_ROOTS.map((r) => path.join(root, r))];
  return roots.some((base) => fs.existsSync(path.resolve(base, rel)));
}

function scan({ root = REPO_ROOT, docs = null } = {}) {
  const missingPaths = [];
  const missingScripts = [];
  let checkedPaths = 0;
  let checkedScripts = 0;
  let unchecked = 0;
  // One report line per dead pointer, not per mention: a path cited three times in one doc is one
  // thing to fix, and three identical lines only make a real second defect easier to miss.
  const reported = new Set();
  const files = docs ?? docFiles(root);

  for (const doc of files) {
    const text = fs.readFileSync(path.join(root, doc), "utf8");

    for (const raw of backticked(text)) {
      if (!raw || isPlaceholder(raw)) continue;
      if (!/[\\/]/.test(raw) || !FILE_EXT.test(raw)) continue;
      if (isHomeOrAbsolute(raw)) {
        unchecked += 1;
        continue;
      }
      const rel = raw.split(BACKSLASH).join("/");
      checkedPaths += 1;
      if (!resolves(root, rel, doc) && !reported.has(`${doc}|${raw}`)) {
        reported.add(`${doc}|${raw}`);
        missingPaths.push({ doc, cited: raw, line: lineOf(text, text.indexOf("`" + raw + "`")) });
      }
    }

    for (const { script, pkg, line } of npmScripts(text)) {
      checkedScripts += 1;
      if (npmScriptExists(script, pkg, root)) continue;
      if (reported.has(`${doc}|npm:${script}`)) continue;
      reported.add(`${doc}|npm:${script}`);
      missingScripts.push({ doc, script, pkg, line });
    }
  }

  return { missingPaths, missingScripts, checkedPaths, checkedScripts, unchecked, docs: files.length };
}

function main() {
  const result = scan();
  const { missingPaths, missingScripts } = result;

  console.log(
    `doc-paths: ${result.checkedPaths} repo path(s) and ${result.checkedScripts} npm script(s) cited across ${result.docs} doc(s)` +
    `; ${result.unchecked} home/absolute path(s) not checked (machine-specific by nature)`,
  );

  for (const miss of missingPaths) {
    console.log(`  MISSING FILE    ${miss.doc}:${miss.line}  ->  ${miss.cited}`);
  }
  for (const miss of missingScripts) {
    console.log(`  MISSING SCRIPT  ${miss.doc}:${miss.line}  ->  npm run ${miss.script}${miss.pkg ? ` --prefix ${miss.pkg}` : ""}`);
  }

  if (!missingPaths.length && !missingScripts.length) {
    console.log("  ok  every cited repo path and npm script resolves");
    return 0;
  }
  console.error(
    `\ndoc-paths FAILED: ${missingPaths.length} dead path(s), ${missingScripts.length} dead script(s).` +
    "\nFix the doc (or restore the file). A pointer that does not resolve sends the next agent to rebuild what already exists.",
  );
  return 1;
}

module.exports = { scan, docFiles, isPlaceholder, npmScriptExists, ILLUSTRATIVE, SEARCH_ROOTS };

if (require.main === module) process.exit(main());
