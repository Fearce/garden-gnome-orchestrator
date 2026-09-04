/**
 * Gate: the README's mechanically-checkable claims still describe master.
 *
 * The repo went public on 2026-07-22, so README.md is the first thing a stranger reads, and it was the
 * only document nothing in the tree was checking. A manual audit on 2026-08-27 found it wrong about
 * master in EIGHT ways, every one of which had been TRUE once and then rotted in place, silently, for
 * months:
 *
 *   1. it named "Claude Opus 4.8" as the implementor. The real default is `claude-opus-5`, and every
 *      other role's model was stale too (the single most misleading line in the file);
 *   2. `npm run install:all` was described as server/ + web/. It installs relay/ as well;
 *   3. it advertised 8 free AI providers; the registry ships 9;
 *   4. deliverables were described as a right-hand panel; they are a chip strip in the thread detail;
 *   5. relay/ was missing from the repo layout entirely;
 *   6. no Node version was stated at all;
 *   7. it advertised voice mode, whose gateway lives in a different repo;
 *   8. the quickstart omitted the root `npm install` that `concurrently` needs on every OS.
 *
 * A README rots because nothing reads it back. This gate reads it back. It is FREE: no agent, no
 * subprocess, no network, no browser, and it fails naming the exact drift and the fix rather than
 * "README differs".
 *
 * WHAT IT PINS, AND WHAT IT DELIBERATELY DOES NOT. Only claims a machine can verify against the real
 * source: link targets, the role/model table, the npm scripts, the ports, the env var names. Prose
 * accuracy ("9 free providers", "deliverables are a chip strip", how the pipeline is described) is
 * still a HUMAN's job, and this file makes no attempt at it. A gate that guesses at prose cries wolf
 * and gets deleted, which would cost more than it ever caught.
 *
 * Two items from the eight above were considered and left out for exactly that reason, recorded here so
 * nobody re-adds them as flaky:
 *   - the provider COUNT (#3). The README states it in a sentence, not a list, and the registry's own
 *     count depends on which adapters are compiled in. A regex over either side is a guess.
 *   - the Node version (#6). Nothing in the repo declares one (no `engines`, no `.nvmrc`), so there is
 *     no second source to compare against. Declare `engines` first, then this can be pinned.
 *
 * Scenarios:
 *   A. LINKS   every relative link/image target exists on disk.
 *   B. MODELS  the role/model table matches `config.models` exactly, in both directions.
 *   C. SCRIPTS every `npm run <script>` the README shows exists in the ROOT package.json, and
 *              `install:all` still covers all three of server/, web/ and relay/.
 *   D. PORTS   the ports the README states are config.ts's declared defaults.
 *   E. ENV     every VARIABLE named in the configuration table exists in config.ts or .env.example.
 *
 * Run:  npm run test:readme-claims   (from server/)   or:  npx tsx src/tests/readmeClaims.test.ts
 * Exits non-zero if any assertion fails. Reads only; touches nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const README_PATH = join(ROOT, "README.md");
const CONFIG_PATH = join(ROOT, "server", "src", "config.ts");
const ENV_EXAMPLE_PATH = join(ROOT, "server", ".env.example");

const readme = readFileSync(README_PATH, "utf8");
const configSrc = readFileSync(CONFIG_PATH, "utf8");
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` : ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` : ${detail}` : ""}`);
  }
}

/** The lines of the markdown table that follows `heading`, up to the first blank line after it. */
function tableAfter(heading: RegExp): string[] {
  const start = readme.search(heading);
  if (start < 0) return [];
  const rows: string[] = [];
  let seen = false;
  for (const line of readme.slice(start).split("\n")) {
    if (line.trimStart().startsWith("|")) {
      seen = true;
      rows.push(line.trim());
    } else if (seen && line.trim() === "") break;
  }
  return rows;
}

/** Cells of a `| a | b |` row. Header and separator rows are filtered by the caller. */
function cells(row: string): string[] {
  return row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// ---- A. every relative link and image target exists ------------------------------------------------
// Catches a moved screenshot or a renamed doc, the rot that turns the public front page into broken
// image icons. http(s)/mailto targets and bare anchors are somebody else's problem and are skipped.
console.log("\nA. links: every relative link/image in README.md resolves on disk");
{
  const targets = new Map<string, string>(); // resolved path -> the raw target, for the failure message
  for (const m of readme.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = m[1];
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const rel = raw.split("#")[0];
    if (!rel) continue;
    targets.set(rel, raw);
  }
  check("the README still carries relative links to check", targets.size > 0, `found ${targets.size}`);
  for (const [rel, raw] of targets) {
    check(
      `${raw} exists`,
      existsSync(join(ROOT, rel)),
      `README.md links to \`${raw}\`, which is not at ${join(ROOT, rel)}. Move the file back, or update the ` +
        "link. A public README with a broken image is the first thing a stranger sees.",
    );
  }
}

// ---- B. the role/model table matches config.models exactly -----------------------------------------
// The defect this whole file exists for: the table said "Claude Opus 4.8" long after the default became
// `claude-opus-5`. Both directions are asserted, so a stale id fails AND so does a role added to
// config.models that nobody documented.
console.log("\nB. models: the role table matches config.models");
{
  const rows = tableAfter(/\| Role \| Model \|/);
  /** "Reader (read lane)" -> "reader". The parenthetical is documentation; the first word is the key. */
  const roleKey = (label: string): string => label.replace(/\(.*\)/, "").trim().toLowerCase();
  const documented = new Map<string, string>();
  for (const row of rows) {
    const [role, model] = cells(row);
    if (!role || !model || /^-+$/.test(role) || role === "Role") continue;
    const id = model.match(/`([^`]+)`/)?.[1];
    if (!id) continue;
    documented.set(roleKey(role), id);
  }

  const actual = config.models as Record<string, string>;
  check(
    "the role/model table was found and parsed",
    documented.size > 0,
    `parsed ${documented.size} rows from ${rows.length} table lines. If the table moved or its header changed, ` +
      "this check is now blind: re-point `tableAfter(/\\| Role \\| Model \\|/)` at the new heading.",
  );

  for (const [role, expected] of Object.entries(actual)) {
    const found = documented.get(role);
    check(
      `${role} -> ${expected}`,
      found === expected,
      found === undefined
        ? `config.models.${role} is \`${expected}\`, but README.md's role table has no row for "${role}". Add ` +
          "one: an undocumented role reads as a role that does not exist."
        : `README.md says ${role} runs \`${found}\`, but config.models.${role} is \`${expected}\`. Update the ` +
          "README table (server/src/config.ts is the source of truth).",
    );
  }
  for (const role of documented.keys()) {
    check(
      `${role} is a real role`,
      role in actual,
      `README.md's role table documents "${role}", which is not a key of config.models ` +
        `(${Object.keys(actual).join(", ")}). The role was renamed or removed: fix the table.`,
    );
  }
}

// ---- C. every npm script the README tells you to run exists ----------------------------------------
// The README's commands are ROOT-level, so they resolve against the root package.json. Bare `npm install`,
// `npm install-scripts` and `npm rebuild` (the Linux / npm 12 details block) are npm BUILTINS, not
// scripts. Checking those against `scripts` would fail on a correct README, so they are not checked.
console.log("\nC. scripts: every `npm run ...` in the README exists in the root package.json");
{
  const scripts = rootPkg.scripts ?? {};
  const named = new Set<string>();
  for (const m of readme.matchAll(/\bnpm run ([A-Za-z0-9:_.-]+)/g)) if (m[1]) named.add(m[1]);
  // `npm start` / `npm test` are lifecycle shorthands for a script of the same name, so same check.
  for (const m of readme.matchAll(/\bnpm (start|test)\b/g)) if (m[1]) named.add(m[1]);

  check("the README still shows npm commands to check", named.size > 0, `found ${named.size}`);
  for (const name of named) {
    check(
      `npm run ${name}`,
      name in scripts,
      `README.md tells a reader to run \`npm run ${name}\`, but the root package.json has no such script ` +
        `(it has: ${Object.keys(scripts).join(", ")}). Rename it in the README, or restore the script.`,
    );
  }

  // #2 of the eight: `install:all` grew relay/ and the README kept saying "server/ and web/". Pin the
  // COMMAND, which is the half a machine can see; the README's own gloss stays a human's job.
  const installAll = scripts["install:all"] ?? "";
  for (const dir of ["server", "web", "relay"]) {
    check(
      `install:all installs ${dir}/`,
      installAll.includes(`--prefix ${dir}`),
      `root package.json's install:all is \`${installAll}\`, which no longer installs ${dir}/. If that is ` +
        "deliberate, the README quickstart comment naming the three directories needs the same edit.",
    );
  }
}

// ---- D. the ports the README states are config.ts's declared defaults ------------------------------
// Read the DEFAULT out of the source (`process.env.PORT ?? 4317`) rather than off `config.port`: config.ts
// auto-loads server/.env, so a machine that overrides PORT locally would otherwise red a correct README.
console.log("\nD. ports: the README's ports are config.ts's defaults");
{
  const defaultOf = (env: string): string | undefined =>
    configSrc.match(new RegExp(`process\\.env\\.${env}\\s*\\?\\?\\s*([0-9_]+)`))?.[1]?.replace(/_/g, "");

  for (const [env, label] of [["PORT", "HTTP"], ["HTTPS_PORT", "HTTPS"]] as const) {
    const value = defaultOf(env);
    check(
      `config.ts declares a default ${env}`,
      value !== undefined,
      `no \`process.env.${env} ?? <number>\` in server/src/config.ts. The default moved, so this check can no ` +
        "longer see it: point it at wherever the default now lives.",
    );
    if (value === undefined) continue;
    check(
      `README states the ${label} port ${value}`,
      readme.includes(value),
      `server/src/config.ts defaults ${env} to ${value}, and README.md never mentions ${value}. A reader who ` +
        "follows the quickstart opens the wrong URL.",
    );
  }

  // Belt and braces: with nothing overriding them locally, the live config must agree with those literals.
  if (!process.env.PORT) {
    check(`config.port (${config.port}) is that default`, String(config.port) === defaultOf("PORT"));
  }
  if (!process.env.HTTPS_PORT) {
    check(`config.httpsPort (${config.httpsPort}) is that default`, String(config.httpsPort) === defaultOf("HTTPS_PORT"));
  }
}

// ---- E. every env var the configuration table names is real ----------------------------------------
// A renamed setting leaves the README advertising a variable the server never reads. It is silently
// ignored, so the reader concludes the feature is broken. Matched by NAME against config.ts plus
// .env.example. The placeholder forms (`ACCOUNT_<n>_TOKEN`) are matched on their literal stems, because
// config.ts builds those names by string concatenation in a loop and the full literal appears nowhere.
console.log("\nE. env: every variable in the configuration table exists in config.ts or .env.example");
{
  const haystack = configSrc + "\n" + (existsSync(ENV_EXAMPLE_PATH) ? readFileSync(ENV_EXAMPLE_PATH, "utf8") : "");
  const rows = tableAfter(/\| Variable \| What it does \|/);
  const names = new Set<string>();
  for (const row of rows) {
    const [variable] = cells(row);
    if (!variable || /^-+$/.test(variable) || variable === "Variable") continue;
    for (const m of variable.matchAll(/`([^`]+)`/g)) {
      const token = (m[1] ?? "").trim();
      // Names only: `4317`, `server/data` and `claude setup-token` also sit in backticks in this table.
      if (/^[A-Z_][A-Z0-9_]*(?:<n>[A-Z0-9_]*)*$/.test(token)) names.add(token);
    }
  }
  check(
    "the configuration table was found and parsed",
    names.size > 0,
    `parsed ${names.size} variables from ${rows.length} table lines. If the table moved, re-point ` +
      "`tableAfter(/\\| Variable \\| What it does \\|/)`.",
  );

  for (const name of names) {
    // `ACCOUNT_<n>_TOKEN` -> every literal stem around the placeholder must appear somewhere.
    const stems = name.split(/<[^>]+>/).filter(Boolean);
    const missing = stems.filter((s) => !haystack.includes(s));
    check(
      name,
      missing.length === 0,
      `README.md's configuration table documents \`${name}\`, but ${missing.map((s) => `"${s}"`).join(" and ")} ` +
        "appears in neither server/src/config.ts nor server/.env.example. The setting was renamed or dropped, " +
        "and a variable the server never reads is silently ignored, so the reader thinks the feature is broken.",
    );
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} : ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
