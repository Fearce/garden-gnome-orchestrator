#!/usr/bin/env node
// Production dependency audit for the nightly quality sweep.
//
// `npm audit` exits 1 whenever *any* advisory exists, which hides the distinction
// between an actionable high/critical finding and an accepted upstream low/moderate
// notice. This command makes that policy explicit: high or critical findings fail;
// lower-severity findings remain visible for follow-up without failing a healthy run.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

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

  console.log(
    `  vulnerabilities: critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low}`,
  );
  if (!blocking.length) {
    console.log("  [ok] no high or critical production dependency vulnerabilities");
    process.exit(0);
  }

  console.log("  [fail] high/critical findings:");
  for (const advisory of blocking) {
    console.log(`      ${advisory.severity}: ${advisory.name}${advisory.direct ? " (direct)" : " (transitive)"}`);
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = { summarizeAudit, blockingAdvisories };
