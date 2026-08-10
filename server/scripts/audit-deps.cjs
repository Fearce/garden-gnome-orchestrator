#!/usr/bin/env node
// Production dependency audit for the nightly quality sweep.
//
// `npm audit` exits 1 whenever *any* advisory exists, which hides the distinction
// between an actionable high/critical finding and an accepted upstream low/moderate
// notice. This command makes that policy explicit: high or critical findings fail;
// lower-severity findings remain visible for follow-up without failing a healthy run.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  satisfies,
  reportOverrides,
  declaredOverrides,
  collectInstalled,
  degradedReason,
} = require("./audit-overrides.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function summarizeAudit(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object") throw new Error("npm audit returned no vulnerability summary");

  const normalized = {};
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    const value = Number(counts[severity] ?? 0);
    if (!Number.isInteger(value) || value < 0) throw new Error(`npm audit returned an invalid ${severity} count`);
    normalized[severity] = value;
  }
  return normalized;
}

function blockingAdvisories(report) {
  return Object.values(report.vulnerabilities ?? {})
    .filter((advisory) => advisory.severity === "high" || advisory.severity === "critical")
    .map((advisory) => ({ name: advisory.name, severity: advisory.severity, direct: advisory.isDirect }))
    .sort((a, b) => a.severity.localeCompare(b.severity) || a.name.localeCompare(b.name));
}

/**
 * The first version outside an advisory's vulnerable range, i.e. what to upgrade to.
 * GHSA ranges are upper-bounded by the first patched release ("<2.1.4"), which is the
 * number a remediation needs and the one npm's own summary never prints.
 */
function firstFixed(range) {
  const m = /<\s*(\d+\.\d+\.\d+)/.exec(String(range ?? ""));
  return m ? m[1] : null;
}

/** Every installed package that declares `name` as a dependency, with its declared range. */
function dependantsOf(tree, name, nodes = []) {
  const out = new Map();
  const visit = (node, nodeName) => {
    if (!node || typeof node !== "object") return;
    for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
      if (childName === name && nodeName) {
        out.set(`${nodeName}@${node.version}`, { parent: nodeName, version: node.version });
      }
      visit(child, childName);
    }
  };
  visit(tree, null);
  return [...out.values()].map((p) => ({ ...p, range: declaredRange(p.parent, p.version, name, nodes) }));
}

/**
 * What `parent` asks for of `name`. Hoisting means `node_modules/<parent>` is not
 * necessarily the copy the tree meant — here `node_modules/minimatch` is the 10.x that
 * wants brace-expansion ^5, while the parent in question is the 9.x nested under rimraf
 * that wants ^2. Reading the wrong copy yields a confidently wrong remediation, so every
 * candidate is version-checked and a mismatch reports null rather than guessing.
 */
function declaredRange(parent, version, name, nodes) {
  // A node path already ends in the `node_modules` dir holding the package, so dropping
  // the package name yields the directory a sibling parent copy would live in.
  const prefixes = ["node_modules", ...nodes.map((n) => n.replace(/\/[^/]+$/, ""))];
  for (const prefix of [...new Set(prefixes)]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, prefix, parent, "package.json"), "utf8"));
      if (pkg.version !== version) continue;
      return pkg.dependencies?.[name] ?? pkg.optionalDependencies?.[name] ?? pkg.peerDependencies?.[name] ?? null;
    } catch {
      /* candidate not present here — try the next */
    }
  }
  return null;
}

const REGISTRY_TIMEOUT_MS = 20_000;

/** What the newest published `parent` declares for `name`; null when the registry is unreachable. */
function registryLatest(parent, name) {
  const res = spawnSync(NPM, ["view", `${parent}@latest`, "--json"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: REGISTRY_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  try {
    const parsed = JSON.parse(res.stdout);
    const manifest = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    if (!manifest || typeof manifest.version !== "string") return null;
    const deps = manifest.dependencies ?? {};
    return {
      version: manifest.version,
      range: deps[name] ?? manifest.optionalDependencies?.[name] ?? manifest.peerDependencies?.[name] ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether upgrading the parent is even possible, asked of the registry rather than of the
 * reader. "Upgrade the parent" is only advice when a parent that accepts the fix was ever
 * published — officeparser has pinned pdfjs-dist to one exact version in every release
 * including its newest, so on 2026-08-07 that line sent the sweep hunting for an upgrade
 * that does not exist, when an override was the only route. Answer it here instead.
 */
function upstreamRoute(dep, name, fixes, lookupLatest) {
  const latest = lookupLatest(dep.parent, name);
  if (!latest) return [`  could not reach the registry to see whether a newer ${dep.parent} accepts it`];
  if (!latest.range) return [`  ${dep.parent}@${latest.version} dropped ${name} entirely — upgrading the parent clears it`];
  if (fixes.some((f) => satisfies(f, latest.range) === true)) {
    return [`  ${dep.parent}@${latest.version} wants ${latest.range} — upgrade the parent to it and this clears`];
  }
  return [
    `  even the newest ${dep.parent}@${latest.version} wants ${latest.range} — no parent upgrade exists,` +
      " so an override is the only route",
  ];
}

/**
 * The remediation table this command used to leave as manual legwork: where each
 * vulnerable package sits, what version clears it, and — the decision that actually
 * matters — whether every parent's declared range already accepts that version. If it
 * does, an `overrides` floor bump is safe; if not, the override fights semver, and the
 * follow-up line says whether a parent upgrade is actually available to take instead.
 */
function explain(advisory, tree, lookupLatest = registryLatest) {
  const lines = [];
  const paths = (advisory.nodes ?? []).map((n) => n.replace(/^node_modules\//, ""));
  if (paths.length) lines.push(`installed at: ${paths.join(", ")}`);

  const ranges = (Array.isArray(advisory.via) ? advisory.via : [])
    .filter((v) => typeof v === "object" && v.range)
    .map((v) => v.range);
  const fixes = [...new Set(ranges.map(firstFixed).filter(Boolean))].sort();
  if (fixes.length) lines.push(`clears at: ${fixes.map((f) => `>=${f}`).join(" / ")}`);

  for (const dep of dependantsOf(tree, advisory.name, advisory.nodes ?? [])) {
    if (!dep.range) {
      lines.push(`parent ${dep.parent}@${dep.version}: declared range not resolvable`);
      continue;
    }
    const inRange = fixes.filter((f) => satisfies(f, dep.range) === true);
    const verdict = !fixes.length
      ? "no fix version parsed from the advisory"
      : inRange.length
        ? `accepts ${inRange.join("/")} — a floor bump, safe to override`
        // The route is deliberately left to the follow-up line, which knows whether a parent
        // upgrade was ever published; naming one here would sometimes contradict it.
        : `does NOT accept ${fixes.join("/")} — an override here fights semver`;
    lines.push(`parent ${dep.parent}@${dep.version} wants ${dep.range} → ${verdict}`);
    // Only the semver-fighting branch needs the registry — the floor-bump case is already actionable.
    if (fixes.length && !inRange.length) lines.push(...upstreamRoute(dep, advisory.name, fixes, lookupLatest));
  }
  return lines;
}

function productionTree() {
  const res = spawnSync(NPM, ["ls", "--omit=dev", "--all", "--json"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return {};
  }
}

function auditReport() {
  const result = spawnSync(NPM, ["audit", "--omit=dev", "--json"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;

  try {
    return JSON.parse(result.stdout);
  } catch {
    const detail = String(result.stderr || result.stdout || "no output").trim();
    throw new Error(`npm audit did not return JSON: ${detail.slice(0, 500)}`);
  }
}

function main() {
  console.log("\n=== production dependency audit ===");
  const report = auditReport();
  const counts = summarizeAudit(report);
  const blocking = blockingAdvisories(report);
  const tree = productionTree();

  console.log(
    `  vulnerabilities: critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low}`,
  );
  if (blocking.length) {
    console.log("  [fail] high/critical findings:");
    for (const advisory of blocking) {
      console.log(`      ${advisory.severity}: ${advisory.name}${advisory.direct ? " (direct)" : " (transitive)"}`);
      for (const line of explain(report.vulnerabilities[advisory.name] ?? {}, tree)) {
        console.log(`        ${line}`);
      }
    }
  } else {
    console.log("  [ok] no high or critical production dependency vulnerabilities");
  }

  // Rides this command rather than needing its own trigger: an override that stopped
  // binding is the same class of problem, and this is what the nightly sweep already runs.
  const overridesOk = reportOverrides(declaredOverrides(), collectInstalled(tree), degradedReason(tree));
  process.exit(blocking.length || !overridesOk ? 1 : 0);
}

if (require.main === module) main();

module.exports = { summarizeAudit, blockingAdvisories, firstFixed, explain, dependantsOf, upstreamRoute };
