/**
 * Integration test — the read-only "reader" lane (Option C).
 *
 * The reader is a single cheap agent that answers a lookup and posts it as a finding, with NO QA behind
 * it. Its read-only guarantee is HARNESS-enforced, not prompt-enforced, so this test pins the two pieces
 * that actually enforce it:
 *
 *   A. TOOLSET      — `readerConfig` runs under bypassPermissions with a disallowedTools denylist that
 *                     HARD-blocks every write/shell/network tool (Write/Edit/NotebookEdit/Bash/PowerShell
 *                     …), and an allowedTools list that is read-only (Read/Grep/Glob + git_read + bus/
 *                     office). This mirrors the proven QA-role enforcement. A write tool leaking into the
 *                     allowlist, or dropping out of the denylist, is a real read-only escape — so we assert
 *                     both directions.
 *   B. GIT ALLOWLIST — `validateGitRead` accepts ONLY log/show/status/diff and rejects every write/network
 *                     subcommand (push/commit/checkout/reset/fetch/…) plus the file-writing / shell-out args
 *                     (--output/-o/--ext-diff). `runReadonlyGit` runs the allowed ones against a REAL repo
 *                     and refuses the disallowed ones without executing them.
 *
 * Run:  npm run test:reader   (from server/)   — or:  npx tsx src/tests/reader.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: builds a throwaway repo in a temp dir, removes it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const { readerConfig } = await import("../agents/roles.js");
const { validateGitRead, runReadonlyGit, GIT_READ_SUBCOMMANDS } = await import("../git/readonlyGit.js");
const { config } = await import("../config.js");

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
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

// A stand-in MCP server value — readerConfig only stores these on the config; nothing here dials them.
const fakeServer = { type: "sdk", name: "fake" } as unknown as McpServerConfig;

// ---- A. toolset enforcement ------------------------------------------------------------------------
async function testToolset(): Promise<void> {
  console.log("\nA. Reader toolset — read-only enforced at the harness level");
  const cfg = readerConfig("C:\\some\\workspace", { bus: fakeServer, office: fakeServer, git: fakeServer });
  const allowed = new Set(cfg.allowedTools ?? []);
  const disallowed = new Set(cfg.disallowedTools ?? []);

  // The block only holds under bypassPermissions because that's the mode where disallowedTools is a HARD
  // block (the QA-role precedent) — assert the mode, not just the lists.
  check("runs under bypassPermissions", cfg.permissionMode === "bypassPermissions", `got ${cfg.permissionMode}`);
  check("model is the configured reader model", cfg.model === config.models.reader, `got ${cfg.model}`);
  check("emits structured output (json_schema)", cfg.outputFormat?.type === "json_schema");

  // Every write / shell / network tool must be DENIED and must NOT appear in the allowlist.
  const mustDeny = ["Write", "Edit", "NotebookEdit", "MultiEdit", "Bash", "PowerShell", "KillShell", "BashOutput", "WebSearch", "WebFetch", "Task", "AskUserQuestion"];
  for (const t of mustDeny) {
    check(`denies ${t}`, disallowed.has(t), "missing from disallowedTools");
    check(`${t} not in allowlist`, !allowed.has(t));
  }

  // The read surface must be present.
  for (const t of ["Read", "Grep", "Glob"]) check(`allows ${t}`, allowed.has(t), "missing from allowedTools");
  check("allows git_read (mcp)", [...allowed].some((t) => t.endsWith("__git_read")), "git_read MCP tool missing");
  check("allows post_finding (mcp)", [...allowed].some((t) => t.endsWith("__post_finding")), "bus post_finding missing");
}

// ---- B. git allowlist ------------------------------------------------------------------------------
async function testGitAllowlist(): Promise<void> {
  console.log("\nB. git_read — allowlisted read-only subcommands only");

  // The allowed four are read-only regardless of args.
  for (const sub of GIT_READ_SUBCOMMANDS) check(`accepts git ${sub}`, validateGitRead(sub, []).ok);

  // Every write / network / config-injection subcommand is rejected.
  for (const sub of ["push", "commit", "checkout", "reset", "fetch", "pull", "clone", "rm", "add", "clean", "stash", "merge", "rebase", "tag", "config", "gc"]) {
    check(`rejects git ${sub}`, !validateGitRead(sub, []).ok);
  }

  // Even on an allowed subcommand, the file-writing / shell-out args are refused.
  check("rejects diff --output=f", !validateGitRead("diff", ["--output=/tmp/x"]).ok);
  check("rejects diff -o f", !validateGitRead("diff", ["-o", "/tmp/x"]).ok);
  check("rejects diff --ext-diff", !validateGitRead("diff", ["--ext-diff"]).ok);
  check("still accepts diff --stat", validateGitRead("diff", ["--stat"]).ok);

  // ---- runReadonlyGit against a REAL throwaway repo ----
  const tmp = mkdtempSync(join(tmpdir(), "reader-git-"));
  try {
    git(tmp, "init", "-q");
    git(tmp, "config", "user.name", "Reader Test");
    git(tmp, "config", "user.email", "reader-test@example.com");
    writeFileSync(join(tmp, "hello.txt"), "one\ntwo\n");
    git(tmp, "add", "hello.txt");
    git(tmp, "commit", "-q", "-m", "seed: hello");

    const log = await runReadonlyGit(tmp, "log", ["--oneline"]);
    check("runReadonlyGit log succeeds", log.ok && /seed: hello/.test(log.output), log.error ?? log.output);

    const status = await runReadonlyGit(tmp, "status", ["--porcelain"]);
    check("runReadonlyGit status succeeds (clean tree → empty)", status.ok && status.output === "");

    const show = await runReadonlyGit(tmp, "show", ["HEAD:hello.txt"]);
    check("runReadonlyGit show reads file at HEAD", show.ok && /one/.test(show.output), show.error ?? show.output);

    // A write subcommand is refused BEFORE running — it never touches the repo.
    const push = await runReadonlyGit(tmp, "push", ["origin", "master"]);
    check("runReadonlyGit refuses push (ok:false)", !push.ok && !!push.error);
    const commit = await runReadonlyGit(tmp, "commit", ["-m", "should never run", "--allow-empty"]);
    check("runReadonlyGit refuses commit (ok:false)", !commit.ok);
    // Prove the refused commit did NOT execute: still exactly one commit in the log.
    const count = git(tmp, "rev-list", "--count", "HEAD");
    check("refused commit did not execute (still 1 commit)", count === "1", `got ${count}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- run -------------------------------------------------------------------------------------------
console.log("Reader lane (Option C) — read-only enforcement test");
await testToolset();
await testGitAllowlist();

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
