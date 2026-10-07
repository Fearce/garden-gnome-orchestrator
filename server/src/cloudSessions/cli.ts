import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export interface CloudCliResult {
  sessionId: string | null;
  result: string | null;
  ok: boolean;
  error: string | null;
}
export interface CloudCliInput {
  cwd: string;
  token: string;
  prompt: string;
  model: string;
  effort?: string | null;
  signal: AbortSignal;
  onSession(id: string): void;
}
export const CLOUD_SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;

/** Use the SDK's versioned native CLI, with no shell and no credentials in argv. The CLI waits for
 * the cloud worker and emits its actual result. Killing this observer does NOT cancel the cloud VM. */
export async function runCloudCli(input: CloudCliInput): Promise<CloudCliResult> {
  const require = createRequire(import.meta.url);
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binary = require.resolve(`${packageName}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
  const env: NodeJS.ProcessEnv = {};
  // Keep startup independent of local API providers, MCP servers, hook configuration and secrets.
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = input.token;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return new Promise(resolve => {
    let stdout = "", stderr = "", sessionId: string | null = null, overflow = false;
    const child = spawn(binary, ["-p", "--cloud", "--output-format", "json", "--model", input.model,
      ...(input.effort ? ["--effort", input.effort] : []), "--permission-mode", "bypassPermissions", "--setting-sources", ""], {
      cwd: input.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = () => { child.kill(); };
    const timeout = setTimeout(stop, 30 * 60_000);
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    child.stdout.on("data", data => {
      stdout += String(data);
      if (stdout.length > 1_000_000) { overflow = true; stdout = ""; stop(); }
    });
    child.stderr.on("data", data => {
      stderr = (stderr + String(data)).slice(-32_000);
      const id = /Cloud session: ((?:session|cse)_[A-Za-z0-9_-]+)/.exec(stderr)?.[1];
      if (id && id !== sessionId) { sessionId = id; input.onSession(id); }
    });
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", stop);
      // Never echo raw stderr: provider errors can contain auth or private configuration.
      let value: Record<string, unknown> | null = null;
      try { value = JSON.parse(stdout) as Record<string, unknown>; } catch { /* ambiguous */ }
      const id = value?.session_id;
      if (typeof id === "string" && CLOUD_SESSION_ID.test(id)) {
        sessionId = id; input.onSession(id);
      }
      const result = typeof value?.result === "string" ? value.result.slice(0, 60_000) : null;
      const ok = code === 0 && value?.type === "result" && value?.subtype === "success"
        && value?.is_error === false && !!sessionId && !!result?.trim() && !overflow && !input.signal.aborted;
      resolve({ sessionId, result: ok ? result : null, ok,
        error: ok ? null : "No verified cloud result. The session may still be running; open Claude before retrying." });
    };
    child.on("error", () => finish(null));
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
  });
}
