#!/usr/bin/env node
const assert = require("node:assert/strict");
const {
  assessStagedRuntime,
  compareVersions,
  evaluateVersion,
  fetchLiveRuntime,
  fetchPackageLatest,
  fetchRestartStatus,
  parseGrokUpdate,
  parseVersion,
  report,
  withoutNpmLifecycleEnv,
} = require("./probe-provider-toolchain.cjs");

assert.equal(parseVersion("codex-cli 0.153.4"), "0.153.4");
assert.equal(parseVersion("grok 1.0.24 (abc) [stable]"), "1.0.24");
assert.equal(parseVersion("not a version"), null, "unfamiliar output must fail closed");
assert.equal(compareVersions("0.3.265", "0.3.266"), -1);
assert.equal(compareVersions("2.1.266", "2.1.266"), 0);
assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1, "a stable release sorts after its prerelease");
assert.equal(compareVersions("rolling", "1.0.0"), null, "unknown version schemes are not guessed");
assert.deepEqual(
  withoutNpmLifecycleEnv({ PATH: "x", npm_execpath: "npm", NPM_CONFIG_PREFIX: "y", APPDATA: "z" }),
  { PATH: "x", APPDATA: "z" },
  "an npm-run wrapper must not make Grok misclassify its native installer",
);

const grok = parseGrokUpdate('{"currentVersion":"1.0.24","latestVersion":"1.0.25","updateAvailable":true,"channel":"stable","error":null}');
assert.equal(grok.ok, true);
assert.equal(grok.currentVersion, "1.0.24");
assert.equal(grok.latestVersion, "1.0.25");
assert.equal(grok.updateAvailable, true);
assert.equal(parseGrokUpdate('notice\n{"error":"offline"}').ok, false, "a JSON error row cannot render current");
assert.equal(parseGrokUpdate("network timeout").ok, false, "human-only output cannot render current");

const base = {
  label: "Codex CLI",
  enabled: true,
  installedVersion: "0.153.4",
  latestVersion: "0.153.4",
  updateCommand: "npm install -g @openai/codex@latest",
};
assert.equal(evaluateVersion(base).status, "current");
assert.equal(evaluateVersion({ ...base, latestVersion: "0.154.0" }).status, "outdated");
assert.match(evaluateVersion({ ...base, latestVersion: "0.154.0" }).issue, /npm install -g/);
const staged = {
  ...base,
  installedVersion: "0.153.4",
  latestVersion: "0.154.0",
  staged: { verified: true, version: "0.154.0", detail: "dist build abc12345 is queued" },
};
assert.equal(evaluateVersion(staged).status, "staged", "a proved current replacement is distinct from the old live runtime");
assert.equal(evaluateVersion(staged).issue, null, "a durably staged replacement satisfies the currency gate");
assert.equal(
  evaluateVersion({ ...staged, staged: { ...staged.staged, version: "0.153.9" } }).status,
  "outdated",
  "a queued replacement that is itself old must stay red",
);
assert.equal(
  evaluateVersion({ ...staged, installedVersion: null }).status,
  "missing",
  "staging evidence must not hide an unreadable live runtime",
);
assert.equal(evaluateVersion({ ...base, installedVersion: "0.154.1" }).status, "ahead");
assert.equal(evaluateVersion({ ...base, installedVersion: null }).status, "missing");
assert.equal(evaluateVersion({ ...base, latestVersion: null, latestError: "offline" }).status, "unknown");
assert.match(evaluateVersion({ ...base, latestVersion: null, latestError: "offline" }).issue, /offline/);
assert.deepEqual(
  evaluateVersion({ ...base, enabled: false, installedVersion: null, latestVersion: null }),
  {
    ...base,
    enabled: false,
    installedVersion: null,
    latestVersion: null,
    status: "disabled",
    issue: null,
  },
  "a deliberately disabled and absent optional provider does not fail the sweep",
);

const healthy = report([
  { label: "Claude Agent SDK", installedVersion: "0.3.266", latestVersion: "0.3.266", updateCommand: "npm install sdk" },
  { ...base },
  { label: "Grok CLI", enabled: false, installedVersion: null, latestVersion: null, updateCommand: "grok update" },
]);
assert.deepEqual(healthy.issues, []);
assert.match(healthy.text, /every enabled provider runtime is at the latest stable release/);
assert.match(healthy.text, /\[OFF\] Grok CLI not installed - provider disabled/);
assert.match(healthy.text, /z\.ai uses the Claude Agent SDK/);

const red = report([{ ...base, installedVersion: "0.152.0" }]);
assert.equal(red.issues.length, 1);
assert.match(red.text, /\[OUTDATED\]/);
assert.match(red.text, /\[FAIL\].*behind stable/);

const stagedReport = report([staged]);
assert.deepEqual(stagedReport.issues, []);
assert.match(stagedReport.text, /\[STAGED\] Codex CLI 0\.153\.4 \(latest 0\.154\.0\)/);
assert.match(stagedReport.text, /current replacement durably staged/);

const distBuild = { at: 1_234_567, commit: "abcdef1234567890", dirty: false };
const coordinator = (overrides = {}) => ({
  ok: true,
  body: {
    now: 1_235_000,
    activeWork: 1,
    decision: { allow: false, retryAt: null, reason: "1 active work item remains" },
    pending: {
      createdAt: 1_234_000,
      requesters: [{ at: 1_234_600, commit: distBuild.commit, stampedAt: distBuild.at, label: null }],
      failures: 0,
      retryAt: null,
    },
    pendingLabel: "waiting for 1 active work item to finish",
    draining: true,
    ...overrides,
  },
  error: null,
});
assert.equal(assessStagedRuntime(distBuild, coordinator()).verified, true, "the exact clean dist build may ride a healthy drain");
assert.equal(
  assessStagedRuntime(distBuild, coordinator({
    pending: { ...coordinator().body.pending, requesters: [{ at: 1_234_600, commit: "other", stampedAt: distBuild.at, label: null }] },
  })).verified,
  false,
  "a restart requested for another build must not excuse this runtime",
);
assert.equal(
  assessStagedRuntime(distBuild, coordinator({
    pending: { ...coordinator().body.pending, requesters: [{ at: 1_234_600, commit: distBuild.commit, stampedAt: 9, label: null }] },
  })).verified,
  false,
  "a matching commit with the wrong build stamp must not excuse this runtime",
);
assert.equal(
  assessStagedRuntime(distBuild, coordinator({
    pending: { ...coordinator().body.pending, requesters: [{ commit: distBuild.commit, stampedAt: distBuild.at, label: null }] },
  })).verified,
  false,
  "a malformed requester without its request time must fail closed",
);
assert.equal(
  assessStagedRuntime(distBuild, coordinator({ pending: { ...coordinator().body.pending, failures: 1 } })).verified,
  false,
  "a restart mechanism that already refused to fire is not a proved deployment",
);
assert.equal(
  assessStagedRuntime({ ...distBuild, dirty: true }, coordinator()).verified,
  false,
  "a dirty dist stamp must fail closed",
);
assert.equal(
  assessStagedRuntime({ ...distBuild, at: null }, coordinator()).verified,
  false,
  "a missing dist timestamp must not coerce to a valid stamp",
);
assert.equal(
  assessStagedRuntime(distBuild, { ok: false, error: "offline" }).verified,
  false,
  "unavailable coordinator evidence must fail closed",
);

async function asyncChecks() {
  let registryUrl = "";
  const registry = await fetchPackageLatest("@scope/tool", async (url, init) => {
    registryUrl = url;
    assert.ok(init.signal, "registry checks need a finite abort signal");
    return { ok: true, status: 200, json: async () => ({ version: "1.2.3" }) };
  });
  assert.equal(registry.ok, true);
  assert.equal(registry.body.version, "1.2.3");
  assert.match(registryUrl, /%40scope%2Ftool\/latest$/, "scoped package names must be URL encoded");

  const live = await fetchLiveRuntime("http://127.0.0.1:4317/", async (url, init) => {
    assert.equal(url, "http://127.0.0.1:4317/api/health");
    assert.ok(init.signal, "live checks need a finite abort signal");
    return {
      ok: true,
      status: 200,
      json: async () => ({ providerRuntime: { claudeAgentSdk: "0.3.266", claudeCode: "2.1.266" } }),
    };
  });
  assert.deepEqual(live.body, { claudeAgentSdk: "0.3.266", claudeCode: "2.1.266" });
  const oldServer = await fetchLiveRuntime("http://x", async () => ({ ok: true, status: 200, json: async () => ({ build: {} }) }));
  assert.equal(oldServer.ok, false, "a server that cannot identify its loaded runtime must not render green");

  const restart = await fetchRestartStatus("http://127.0.0.1:4317/", async (url, init) => {
    assert.equal(url, "http://127.0.0.1:4317/api/deploy/status");
    assert.ok(init.signal, "restart checks need a finite abort signal");
    return { ok: true, status: 200, json: async () => coordinator().body };
  });
  assert.equal(restart.ok, true);
  assert.equal(restart.body.pending.requesters[0].commit, distBuild.commit);

  console.log("providerToolchain: all assertions passed");
}

asyncChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
