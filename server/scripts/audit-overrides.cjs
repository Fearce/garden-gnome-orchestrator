#!/usr/bin/env node
// Gate: every `overrides` entry in package.json still binds something.
//
// An override is invisible config: npm never reports one that stopped matching, and a
// dead entry is byte-identical to a working one. That is how the 2026-08-02 security
// pin rotted — `"minimatch@9.0.9": { "brace-expansion": "2.1.3" }` would have silently
// become a no-op the moment minimatch bumped off 9.0.9, and `audit:deps` only goes red
// later, once a NEW advisory happens to land on the package that quietly came unpinned.
//
// So this checks the resting state rather than the change:
//   dead      — the selector matches nothing installed. The entry does nothing. FAILS.
//   brittle   — the selector pins an exact version, so it is one upstream bump from dead.
//               Key it on the major line with a range value instead. Warns.
//
// Deliberately dependency-free: the only semver in this tree is an undeclared transitive
// of better-sqlite3, and a gate that crashes when an unrelated dependency shifts is a
// false red. Anything outside the small grammar below is reported UNEVALUATED, never failed.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** Split "pkg@range" / "@scope/pkg@range" / "pkg" into its name and range parts. */
function parseSelector(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, range: "" };
  return { name: key.slice(0, at), range: key.slice(at + 1) };
}

/** major.minor.patch, ignoring any prerelease/build suffix. null if unparseable. */
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Numeric compare of two parsed versions. */
function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Does `version` satisfy `range`? Supports only the forms overrides actually use:
 * "" / "*" / "x" (any), exact, ^, ~, and a bare partial like "2" or "2.1".
 * Returns null for anything else, meaning "cannot evaluate" — never a failure.
 */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return null;

  const raw = String(range).trim();
  if (raw === "" || raw === "*" || raw === "x") return true;

  const op = raw[0] === "^" || raw[0] === "~" ? raw[0] : "";
  const rest = op ? raw.slice(1).trim() : raw;
  if (!/^\d+(\.\d+){0,2}$/.test(rest)) return null;

  const parts = rest.split(".").map(Number);
  const [major, minor, patch] = parts;
  const lower = { major, minor: minor ?? 0, patch: patch ?? 0 };
  if (compare(v, lower) < 0) return false;

  // A partial like "2" or "2.1" bounds by its least-significant given component,
  // which is also exactly what ^ means for a full version (and ~ for major.minor).
  const caretPartial = op === "^" || parts.length < 3;
  if (caretPartial && parts.length === 1) return v.major === major;
  if (op === "~" || (caretPartial && parts.length === 2)) {
    if (op === "^" && parts.length === 2 && major === 0) return v.major === 0 && v.minor === minor;
    return v.major === lower.major && v.minor === lower.minor;
  }
  if (op === "^") {
    if (major > 0) return v.major === major;
    if (minor > 0) return v.major === 0 && v.minor === minor;
    return compare(v, lower) === 0;
  }
  return compare(v, lower) === 0;
}

/** Walk an `npm ls --json` tree into name -> Set(versions) of everything installed. */
function collectInstalled(tree) {
  const found = new Map();
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (dep && typeof dep === "object" && typeof dep.version === "string") {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(dep.version);
      }
      walk(dep);
    }
  };
  walk(tree);
  return found;
}

/**
 * Every selector nested under an override VALUE, at ANY depth, as {key, path} pairs.
 *
 * npm lets an override name a whole dependency PATH — the 2026-08-09 nanoid pin is
 * `@sentropic/graphify > ollama-ai-provider > nanoid`, three levels deep. Walking only the
 * first level left the package the pin actually names unchecked, so the entry could rot
 * completely while this gate still reported every selector binding: the exact
 * indistinguishable-from-working failure it exists to catch.
 */
function descendantsOf(value, trail = []) {
  const out = [];
  if (!value || typeof value !== "object") return out;
  for (const [child, childValue] of Object.entries(value)) {
    if (child === ".") continue;
    const path = [...trail, child];
    out.push({ key: child, path });
    out.push(...descendantsOf(childValue, path));
  }
  return out;
}

/** Every selector an overrides block declares, flattened to {key, nested} pairs. */
function selectorsOf(overrides) {
  const out = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    out.push({ key, nested: false });
    for (const { key: child, path } of descendantsOf(value)) {
      out.push({ key: child, nested: true, parent: key, path: [key, ...path] });
    }
  }
  return out;
}

/**
 * Classify every override against what is actually installed.
 *
 * The parent selector carries the hard verdict: "is a minimatch@9.0.9 installed" is a
 * question about names and versions, which npm's tree answers exactly. A NESTED child
 * gets a deliberately weaker rule — npm hoists and dedupes, so a child that legitimately
 * binds can be absent from its parent's node in the JSON, and failing on that shape would
 * produce the false red this gate exists to avoid. A child is therefore only called dead
 * when it is provably absent from the whole tree, which dedupe cannot fake.
 */
function auditOverrides(overrides, installed) {
  const dead = [];
  const brittle = [];
  const unevaluated = [];

  for (const [key, value] of Object.entries(overrides ?? {})) {
    const { name, range } = parseSelector(key);
    const versions = installed.get(name);
    const children = descendantsOf(value);
    const alsoKills = children.length
      ? ` (and its nested ${children.map((c) => c.path.join(" > ")).join(", ")})`
      : "";

    if (!versions || versions.size === 0) {
      dead.push({ label: key, name, reason: `no "${name}" is installed in the production tree${alsoKills}` });
      continue;
    }

    const verdicts = [...versions].map((v) => satisfies(v, range));
    if (verdicts.some((ok) => ok === null)) {
      unevaluated.push({ label: key, range, reason: `range "${range}" is outside this checker's grammar` });
      continue;
    }
    if (!verdicts.some(Boolean)) {
      const have = [...versions].sort().join(", ");
      dead.push({
        label: key,
        name,
        reason: `no installed "${name}" matches "${range}" (installed: ${have})${alsoKills}`,
      });
      continue;
    }
    // Only a version-bearing SELECTOR is brittle. A bare name key whose VALUE is an
    // exact version (a deliberate compat pin) binds regardless of what upstream does.
    if (/^\d+\.\d+\.\d+/.test(range)) {
      brittle.push({ label: key, name, range });
    }

    for (const child of children) {
      const childName = parseSelector(child.key).name;
      if (!installed.has(childName)) {
        dead.push({
          label: `${key} > ${child.path.join(" > ")}`,
          name: childName,
          reason: `no "${childName}" is installed anywhere in the production tree`,
        });
      }
    }
  }

  return { dead, brittle, unevaluated };
}

function productionTree() {
  const res = spawnSync(NPM, ["ls", "--omit=dev", "--all", "--json"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  // `npm ls` exits non-zero on peer/extraneous complaints while still emitting a valid
  // tree, so parse the payload and judge on that rather than on the status code.
  try {
    return JSON.parse(res.stdout);
  } catch {
    const detail = String(res.stderr || res.stdout || "no output").trim();
    throw new Error(`npm ls did not return JSON: ${detail.slice(0, 500)}`);
  }
}

function declaredOverrides() {
  return JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")).overrides ?? {};
}

/**
 * Why this tree cannot support a hard verdict, or null when it can.
 *
 * "Selector matches nothing installed" and "npm could not tell us what is installed" look
 * identical downstream, and this checkout is shared — a concurrent or interrupted
 * `npm install` leaves node_modules partial (see CLAUDE.md), which would otherwise report
 * every override dead and fail the sweep on a healthy package.json. A sound tree reports
 * no problems at all, so this valve stays shut in normal operation.
 */
function degradedReason(tree) {
  const deps = Object.values(tree?.dependencies ?? {});
  if (!deps.some((d) => d && typeof d === "object" && d.version)) {
    return "npm ls resolved no dependencies — node_modules looks absent or partial";
  }
  if (Array.isArray(tree?.problems) && tree.problems.length) {
    return `npm ls reported ${tree.problems.length} tree problem(s) — repair the install first`;
  }
  return null;
}

/** Print the override verdict. Returns false only when something is provably dead. */
function reportOverrides(overrides, installed, degraded = null) {
  console.log("\n=== dependency override audit ===");
  const count = selectorsOf(overrides).length;
  if (!count) {
    console.log("  [ok] no overrides declared");
    return true;
  }

  const { dead, brittle, unevaluated } = auditOverrides(overrides, installed);

  for (const u of unevaluated) console.log(`  [info] ${u.label} — not checked: ${u.reason}`);
  for (const b of brittle) {
    console.log(`  [warn] ${b.label} pins the exact version ${b.range} — one upstream bump from doing nothing.`);
    console.log(`         Key it on the major line with a range value, e.g. "${b.name}@^${b.range.split(".")[0]}".`);
  }

  if (!dead.length) {
    console.log(`  [ok] all ${count} override selector(s) still bind an installed package`);
    return true;
  }

  const verb = degraded ? "[warn]" : "[fail]";
  console.log(`  ${verb} override selector(s) that match nothing — silently doing nothing:`);
  for (const d of dead) console.log(`      ${d.label}: ${d.reason}`);
  if (degraded) {
    console.log(`  Not failing on this: ${degraded}. Re-run once the tree is sound.`);
    return true;
  }
  console.log("  Re-key them against the current tree or delete them; a dead pin reads as protection.");
  return false;
}

function main() {
  const tree = productionTree();
  process.exit(reportOverrides(declaredOverrides(), collectInstalled(tree), degradedReason(tree)) ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  parseSelector,
  parseVersion,
  satisfies,
  collectInstalled,
  descendantsOf,
  selectorsOf,
  auditOverrides,
  reportOverrides,
  declaredOverrides,
  degradedReason,
};
