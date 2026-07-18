import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GIT_SERVER } from "../agents/toolNames.js";
import { GIT_READ_SUBCOMMANDS, runReadonlyGit } from "../git/readonlyGit.js";

/**
 * The read-only git surface for the reader lane. It exposes ONE tool — git_read — that runs an
 * allowlisted git subcommand (log/show/status/diff) in the task's repo through the hardened, no-shell
 * `runGit` path. This is how the reader answers git-history questions without being handed Bash: the
 * allowlist + arg-denylist in gitService.validateGitRead are the enforcement, so a "read" can never
 * become a write (commit/push/checkout/reset are rejected) or a shell-out. Bound to one workspace,
 * mirroring how the bus/office servers are bound per (thread, role).
 */
export function createGitReadServer(workspace: string): McpServerConfig {
  const gitRead = tool(
    "git_read",
    `Run a READ-ONLY git command in this task's repo and get its text output. Allowed subcommands ONLY: ${GIT_READ_SUBCOMMANDS.join(
      ", ",
    )} — inspect history/state, never modify. Any write or network subcommand (commit, push, checkout, reset, fetch, …) is rejected; if you need one, escalate to the full pipeline instead of working around it. Examples: {subcommand:"log", args:["-15","--oneline"]}, {subcommand:"show", args:["HEAD:src/config.ts"]}, {subcommand:"diff", args:["HEAD~3","--stat"]}, {subcommand:"status", args:["--porcelain"]}.`,
    {
      subcommand: z
        .enum(GIT_READ_SUBCOMMANDS as unknown as [string, ...string[]])
        .describe(`The git subcommand — one of: ${GIT_READ_SUBCOMMANDS.join(", ")}.`),
      args: z
        .array(z.string())
        .optional()
        .describe("Arguments passed after the subcommand (no shell, no redirection). Omit for the bare command."),
    },
    async (a) => {
      const r = await runReadonlyGit(workspace, a.subcommand, a.args ?? []);
      if (!r.ok) return { content: [{ type: "text", text: r.error ?? "git failed" }], isError: true };
      return { content: [{ type: "text", text: r.output || "(no output)" }] };
    },
  );

  return createSdkMcpServer({ name: GIT_SERVER, version: "0.1.0", tools: [gitRead] });
}
