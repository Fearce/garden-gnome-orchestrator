#!/usr/bin/env node
// Read-only nightly probe for the executables and SDK versions GGO actually launches.
//
// Model membership/effort coverage belongs to probe:model-catalog. This script answers the
// other half of "are providers current?": is each enabled provider runtime at the latest stable
// version advertised by its own release channel?

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Database = require("better-sqlite3");
const { inspectRestartCoordinator } = require("./restart-coordinator-health.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const FETCH_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

function semverParts(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function parseVersion(value) {
  const match = String(value ?? "").match(/(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/);
  return match?.[1] ?? null;
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i += 1) {
    if (left[i] == null) return -1;
    if (right[i] == null) return 1;
    if (left[i] === right[i]) continue;
    const leftNumber = /^\d+$/.test(left[i]) ? Number(left[i]) : null;
    const rightNumber = /^\d+$/.test(right[i]) ? Number(right[i]) : null;
    if (leftNumber != null && rightNumber != null) return Math.sign(leftNumber - rightNumber);
    if (leftNumber != null) return -1;
    if (rightNumber != null) return 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = semverParts(leftValue);
  const right = semverParts(rightValue);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function compactError(value) {
  return String(value ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 240);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? SERVER_DIR,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    shell: process.platform === "win32" && options.shell !== false,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    windowsHide: true,
    env: options.env ?? process.env,
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  if (result.error) return { ok: false, output: stdout, error: compactError(result.error.message) };
  if (result.status !== 0) {
    return { ok: false, output: stdout, error: compactError(stderr || stdout || `exit ${result.status}`) };
  }
  return { ok: true, output: stdout, error: null };
}

function withoutNpmLifecycleEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toLowerCase().startsWith("npm_")));
}

async function fetchPackageLatest(packageName, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "this Node runtime has no fetch implementation" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return { ok: false, error: `npm registry returned HTTP ${response.status}` };
    const body = await response.json();
    const version = parseVersion(body?.version);
    if (!version) return { ok: false, error: "npm registry response has no valid stable version" };
    return { ok: true, body: { ...body, version }, error: null };
  } catch (error) {
    return { ok: false, error: compactError(error instanceof Error ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveRuntime(baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 5_000) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "this Node runtime has no fetch implementation" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/api/health`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `health endpoint returned HTTP ${response.status}` };
    const body = await response.json();
    const claudeAgentSdk = parseVersion(body?.providerRuntime?.claudeAgentSdk);
    const claudeCode = parseVersion(body?.providerRuntime?.claudeCode);
    if (!claudeAgentSdk || !claudeCode) {
      return { ok: false, error: "live health endpoint has no valid providerRuntime versions (server restart pending or endpoint too old)" };
    }
    return { ok: true, body: { claudeAgentSdk, claudeCode }, error: null };
  } catch (error) {
    return { ok: false, error: compactError(error instanceof Error ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRestartStatus(baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 5_000) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "this Node runtime has no fetch implementation" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/api/deploy/status`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `restart coordinator endpoint returned HTTP ${response.status}` };
    return { ok: true, body: await response.json(), error: null };
  } catch (error) {
    return { ok: false, error: compactError(error instanceof Error ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove that the current dist is the exact build the restart coordinator owns.
 *
 * A merely pending restart is not enough: it may belong to an older build, be dirty, or have
 * repeatedly failed to fire. Keep this predicate pure and fail closed so the gate cannot turn an
 * old live runtime green on a hopeful inference.
 */
function assessStagedRuntime(distBuild, restartResult) {
  if (!restartResult?.ok) {
    return {
      verified: false,
      detail: `restart coordinator status unavailable: ${compactError(restartResult?.error)}`,
    };
  }

  const status = restartResult.body;
  const inspection = inspectRestartCoordinator(status);
  if (!inspection.valid) return { verified: false, detail: inspection.message };
  if (!status.pending) return { verified: false, detail: "no coordinated restart is pending" };
  if (status.pending.failures > 0) {
    return {
      verified: false,
      detail: `restart coordinator has ${status.pending.failures} refused attempt${status.pending.failures === 1 ? "" : "s"}`,
    };
  }
  if (!status.draining) return { verified: false, detail: "pending restart is not holding the coordinated drain" };

  const stampAt = distBuild?.at;
  const commit = typeof distBuild?.commit === "string" ? distBuild.commit.trim() : "";
  if (!Number.isFinite(stampAt) || stampAt <= 0 || !commit || distBuild?.dirty !== false) {
    return { verified: false, detail: "server/dist has no clean, identifiable build stamp" };
  }

  const matchingRequester = status.pending.requesters.some((requester) =>
    requester?.commit === commit
      && Number.isFinite(requester?.stampedAt)
      && requester.stampedAt === stampAt
      && Number.isFinite(requester?.at)
      && requester.at >= stampAt
      && requester.at <= status.now,
  );
  if (!matchingRequester) {
    return {
      verified: false,
      detail: `pending restart does not name dist build ${commit.slice(0, 8)} stamped ${stampAt}`,
    };
  }

  return {
    verified: true,
    detail: `dist build ${commit.slice(0, 8)} is queued (${status.pendingLabel})`,
  };
}

function parseGrokUpdate(raw) {
  const lines = String(raw ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  let body = null;
  for (const line of lines) {
    try {
      body = JSON.parse(line);
      break;
    } catch {
      // The CLI may put a human preamble before its final JSON row; only the JSON row is the contract.
    }
  }
  if (!body || typeof body !== "object") return { ok: false, error: "Grok update check returned no JSON result" };
  if (body.error) return { ok: false, error: compactError(body.error), body };
  const currentVersion = parseVersion(body.currentVersion);
  const latestVersion = parseVersion(body.latestVersion);
  if (!currentVersion || !latestVersion) return { ok: false, error: "Grok update result has no valid current/latest version", body };
  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: body.updateAvailable === true,
    channel: typeof body.channel === "string" && body.channel.trim() ? body.channel.trim() : "unknown",
    body,
  };
}

function evaluateVersion(component) {
  const installedVersion = parseVersion(component.installedVersion);
  const latestVersion = parseVersion(component.latestVersion);
  const enabled = component.enabled !== false;
  let status = "current";
  let issue = null;

  if (!installedVersion) {
    status = enabled ? "missing" : "disabled";
    if (enabled) issue = `${component.label} is enabled but its version could not be read${component.localError ? `: ${compactError(component.localError)}` : ""}`;
  } else if (!latestVersion) {
    status = "unknown";
    if (enabled) issue = `${component.label} latest stable version is unknown${component.latestError ? `: ${compactError(component.latestError)}` : ""}`;
  } else {
    const comparison = compareVersions(installedVersion, latestVersion);
    if (comparison == null) {
      status = "unknown";
      if (enabled) issue = `${component.label} returned versions that cannot be compared (${installedVersion} vs ${latestVersion})`;
    } else if (comparison < 0 || component.updateAvailable === true) {
      const stagedVersion = parseVersion(component.staged?.version);
      const stagedComparison = stagedVersion ? compareVersions(stagedVersion, latestVersion) : null;
      if (component.staged?.verified === true && stagedComparison != null && stagedComparison >= 0) {
        status = "staged";
      } else {
        status = "outdated";
        if (enabled) {
          issue = `${component.label} ${installedVersion} is behind stable ${latestVersion}; run ${component.updateCommand}`;
          if (component.staged?.detail) issue += `; staged replacement not verified: ${compactError(component.staged.detail)}`;
        }
      }
    } else if (comparison > 0) {
      status = "ahead";
    } else if (!enabled) {
      status = "disabled";
    }
  }

  return { ...component, enabled, installedVersion, latestVersion, status, issue };
}

function report(components) {
  const evaluated = components.map(evaluateVersion);
  const issues = evaluated.flatMap((component) => component.issue ? [component.issue] : []);
  const tags = { current: "OK", ahead: "AHEAD", staged: "STAGED", outdated: "OUTDATED", missing: "MISSING", unknown: "UNKNOWN", disabled: "OFF" };
  const lines = [
    "",
    "=== provider toolchain currency ===",
    "  Stable release sources: npm dist-tag for Claude/Codex; Grok CLI's own stable-channel update check.",
  ];
  for (const component of evaluated) {
    const versions = component.installedVersion
      ? `${component.installedVersion}${component.latestVersion ? ` (latest ${component.latestVersion})` : " (latest unknown)"}`
      : component.enabled ? "version unreadable" : "not installed";
    const stagedDetail = component.status === "staged" ? component.staged?.detail : null;
    const suffix = [component.enabled ? null : "provider disabled", component.detail, stagedDetail].filter(Boolean).join("; ");
    lines.push(`  [${tags[component.status]}] ${component.label} ${versions}${suffix ? ` - ${suffix}` : ""}`);
  }
  lines.push("  z.ai uses the Claude Agent SDK/runtime listed above; it has no separate local CLI.", "", "=== toolchain verdict ===");
  if (issues.length) for (const issue of issues) lines.push(`  [FAIL] ${issue}`);
  else if (evaluated.some((component) => component.status === "staged")) {
    lines.push("  [OK] every enabled provider runtime is current or has a current replacement durably staged for coordinated restart");
  } else lines.push("  [OK] every enabled provider runtime is at the latest stable release");
  lines.push("");
  return { text: lines.join("\n"), issues, components: evaluated };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function enabledProviders(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 4000");
  try {
    const rows = db.prepare("SELECT key, value FROM kv WHERE key IN ('setting_codex_enabled', 'setting_grok_enabled')").all();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      codex: values.get("setting_codex_enabled") === "1",
      grok: values.get("setting_grok_enabled") === "1",
    };
  } finally {
    db.close();
  }
}

async function main() {
  require("dotenv").config({ path: path.join(SERVER_DIR, ".env"), quiet: true });
  const configFile = path.join(SERVER_DIR, "dist", "config.js");
  if (!fs.existsSync(configFile)) throw new Error("server/dist/config.js is missing - build before probing the runtime toolchain");
  const { config } = await import(pathToFileURL(configFile).href);
  const enabled = enabledProviders(process.env.ORCH_DB || config.dbPath);

  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk", { paths: [SERVER_DIR] });
  const sdkManifest = readJson(path.join(path.dirname(sdkEntry), "package.json"));
  const sdkInstalled = parseVersion(sdkManifest?.version);
  const claudeRuntimeInstalled = parseVersion(sdkManifest?.claudeCodeVersion);

  const codexExists = fs.existsSync(config.codex.binJs);
  const codexResult = codexExists
    ? runCommand(process.execPath, [config.codex.binJs, "--version"], { shell: false })
    : { ok: false, output: "", error: `not found at ${config.codex.binJs}` };
  const grokExists = fs.existsSync(config.grok.bin);
  const grokResult = grokExists
    // `npm run` publishes npm_* variables. Grok mistakes their presence for an npm-based Grok
    // install and returns `{ installer: "npm", error: "program not found" }`, even though this
    // configured native binary is healthy. The production runner is path-based too, so do not let
    // the sweep wrapper rewrite the executable's own installer detection.
    ? runCommand(config.grok.bin, ["update", "--check", "--json"], { shell: false, env: withoutNpmLifecycleEnv() })
    : { ok: false, output: "", error: `not found at ${config.grok.bin}` };
  const grokUpdate = parseGrokUpdate(grokResult.output);

  const baseUrl = process.env.ORCH_URL || `http://127.0.0.1:${config.port}`;
  const [sdkLatest, codexLatest, liveRuntime, restartStatus] = await Promise.all([
    fetchPackageLatest("@anthropic-ai/claude-agent-sdk"),
    enabled.codex || codexExists ? fetchPackageLatest("@openai/codex") : Promise.resolve({ ok: false, error: "provider disabled and CLI absent" }),
    fetchLiveRuntime(baseUrl),
    fetchRestartStatus(baseUrl),
  ]);
  const stagedRuntime = assessStagedRuntime(readJson(path.join(SERVER_DIR, "dist", ".build-info.json")), restartStatus);
  const components = [
    {
      label: "Claude Agent SDK",
      installedVersion: sdkInstalled,
      latestVersion: sdkLatest.body?.version,
      localError: !sdkManifest
        ? `unreadable package manifest beside ${sdkEntry}`
        : !sdkInstalled ? "installed SDK manifest has no valid version" : null,
      latestError: sdkLatest.error,
      updateCommand: "npm install @anthropic-ai/claude-agent-sdk@latest --prefix server",
      detail: "installed on disk",
    },
    {
      label: "Claude Code runtime",
      installedVersion: claudeRuntimeInstalled,
      latestVersion: sdkLatest.body?.claudeCodeVersion,
      localError: sdkManifest && !claudeRuntimeInstalled ? "installed SDK manifest has no claudeCodeVersion" : null,
      latestError: sdkLatest.ok && !sdkLatest.body?.claudeCodeVersion ? "latest SDK manifest has no claudeCodeVersion" : sdkLatest.error,
      updateCommand: "npm install @anthropic-ai/claude-agent-sdk@latest --prefix server",
      detail: "installed on disk; bundled by the Agent SDK",
    },
    {
      label: "Live Claude Agent SDK",
      installedVersion: liveRuntime.body?.claudeAgentSdk,
      latestVersion: sdkLatest.body?.version,
      localError: liveRuntime.error,
      latestError: sdkLatest.error,
      updateCommand: "npm run deploy --prefix server",
      detail: "loaded by the running GGO process",
      staged: { ...stagedRuntime, version: sdkInstalled },
    },
    {
      label: "Live Claude Code runtime",
      installedVersion: liveRuntime.body?.claudeCode,
      latestVersion: sdkLatest.body?.claudeCodeVersion,
      localError: liveRuntime.error,
      latestError: sdkLatest.ok && !sdkLatest.body?.claudeCodeVersion ? "latest SDK manifest has no claudeCodeVersion" : sdkLatest.error,
      updateCommand: "npm run deploy --prefix server",
      detail: "loaded by the running GGO process",
      staged: { ...stagedRuntime, version: claudeRuntimeInstalled },
    },
    {
      label: "Codex CLI",
      enabled: enabled.codex,
      installedVersion: codexResult.ok ? parseVersion(codexResult.output) : null,
      latestVersion: codexLatest.body?.version,
      localError: codexResult.error,
      latestError: codexLatest.error,
      updateCommand: "npm install -g @openai/codex@latest",
      detail: config.codex.binJs,
    },
    {
      label: "Grok CLI",
      enabled: enabled.grok,
      installedVersion: grokResult.ok && grokUpdate.ok ? grokUpdate.currentVersion : null,
      latestVersion: grokResult.ok && grokUpdate.ok ? grokUpdate.latestVersion : null,
      localError: grokResult.error || grokUpdate.error,
      latestError: grokUpdate.error,
      updateAvailable: grokUpdate.updateAvailable,
      updateCommand: "grok update",
      detail: grokUpdate.channel ? `${grokUpdate.channel} channel` : config.grok.bin,
    },
  ];
  const result = report(components);
  console.log(result.text);
  return result.issues.length ? 1 : 0;
}

module.exports = {
  assessStagedRuntime,
  compareVersions,
  evaluateVersion,
  fetchPackageLatest,
  fetchLiveRuntime,
  fetchRestartStatus,
  parseGrokUpdate,
  parseVersion,
  report,
  withoutNpmLifecycleEnv,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`provider toolchain probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
