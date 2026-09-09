import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface ProviderRuntimeVersions {
  claudeAgentSdk: string | null;
  claudeCode: string | null;
}

function version(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim()) ? value.trim() : null;
}

export function providerRuntimeFromManifest(manifest: unknown): ProviderRuntimeVersions {
  const row = manifest && typeof manifest === "object" ? manifest as Record<string, unknown> : {};
  return {
    claudeAgentSdk: version(row.version),
    claudeCode: version(row.claudeCodeVersion),
  };
}

function readLoadedRuntime(): ProviderRuntimeVersions {
  try {
    const localRequire = createRequire(import.meta.url);
    const sdkEntry = localRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as unknown;
    return providerRuntimeFromManifest(manifest);
  } catch {
    // Health must remain callable when dependency metadata is damaged. Nulls are deliberate:
    // the nightly probe treats an unreadable loaded runtime as UNKNOWN/failed, never current.
    return { claudeAgentSdk: null, claudeCode: null };
  }
}

// Read once at module load. Re-reading the manifest after `npm install` would make an old process
// claim it loaded the new SDK; this snapshot identifies what this process actually started with.
const loadedRuntime = Object.freeze(readLoadedRuntime());

export function providerRuntimeVersions(): ProviderRuntimeVersions {
  return { ...loadedRuntime };
}
