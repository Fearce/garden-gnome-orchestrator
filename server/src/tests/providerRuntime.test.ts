import assert from "node:assert/strict";
import { providerRuntimeFromManifest, providerRuntimeVersions } from "../providerRuntime.js";

assert.deepEqual(
  providerRuntimeFromManifest({ version: "0.3.266", claudeCodeVersion: "2.1.266" }),
  { claudeAgentSdk: "0.3.266", claudeCode: "2.1.266" },
);
assert.deepEqual(
  providerRuntimeFromManifest({ version: "latest", claudeCodeVersion: 123 }),
  { claudeAgentSdk: null, claudeCode: null },
  "malformed package metadata must stay explicitly unknown",
);
assert.deepEqual(providerRuntimeFromManifest(null), { claudeAgentSdk: null, claudeCode: null });

const loaded = providerRuntimeVersions();
assert.match(loaded.claudeAgentSdk ?? "", /^\d+\.\d+\.\d+/, "the installed Agent SDK version must be discoverable at process load");
assert.match(loaded.claudeCode ?? "", /^\d+\.\d+\.\d+/, "the SDK's bundled Claude Code version must be discoverable at process load");
assert.notStrictEqual(providerRuntimeVersions(), providerRuntimeVersions(), "callers receive a copy, not the mutable process snapshot");

console.log(`providerRuntime: Agent SDK ${loaded.claudeAgentSdk}, Claude Code ${loaded.claudeCode}`);
