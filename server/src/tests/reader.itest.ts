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
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { ResetStagger } = await import("../accounts/resetStagger.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
type ResultEvent = import("../agents/runner.js").ResultEvent;

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

// ---- C. read-lane finalize disposition (auto-close on answer) --------------------------------------
// Exercises runReader's terminal logic directly via the extracted `finalizeReader(thread, res)` seam — no
// agent is spawned (the reader's real run is faked as a ResultEvent), so the three terminal paths run
// deterministically against a REAL Db + EventHub + ThreadManager (no HTTP/WS/director).
async function testFinalizeDisposition(): Promise<void> {
  console.log("\nC. Read-lane finalize — auto-close on a clean answer, park on escalate/error");

  const dataDir = mkdtempSync(join(tmpdir(), "reader-finalize-"));
  const db = new Db(join(dataDir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService();
  const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
    stagger: new ResetStagger(),
    persist: {
      load: (id: string) => { const v = db.kvGet(`account_usage_${id}`); try { return v ? JSON.parse(v) : null; } catch { return null; } },
      save: (id: string, u: unknown) => db.kvSet(`account_usage_${id}`, JSON.stringify(u)),
    },
  });
  const manager = new ThreadManager(db, hub, memory, accounts);

  const mkRead = (title: string) =>
    db.createThread({ title, workspace: dataDir, rawPrompt: "", brief: title, lane: "read" });
  const asResult = (partial: Partial<ResultEvent>): ResultEvent =>
    ({ type: "result", isError: false, ...partial } as unknown as ResultEvent);

  try {
    // 1. ANSWERED read-only → 'done' (owner is notified) → auto-closed (lands in the closed tray, no manual step).
    const answered = mkRead("read: which model does the reader use");
    await manager.finalizeReader(answered, asResult({ structuredOutput: { answered: true, escalated: false } }));
    const a = db.getThread(answered.id);
    check("answered read task auto-closes", a?.state === "closed", `got ${a?.state}`);
    check("closed_at set (arms the auto-purge clock, like a manual close)", typeof a?.closedAt === "number");
    check("closed_prev_state records it was 'done' (keeps the finished-correctly checkmark)", a?.closedPrevState === "done", `got ${a?.closedPrevState}`);
    check("readerDone persisted (no re-run on resume)", db.getThreadStageOutputs(answered.id).readerDone === true);
    check("the answer finding survives the close (readable on a closed thread)", db.listFindings(answered.id).some((f) => /answered the lookup read-only/.test(f.summary)));

    // 2. ESCALATED → parked in 'review', NEVER auto-closed (must be re-dispatched through the full pipeline).
    const escalated = mkRead("read: refactor the pipeline");
    await manager.finalizeReader(escalated, asResult({ structuredOutput: { answered: false, escalated: true, reason: "needs edits" } }));
    const e = db.getThread(escalated.id);
    check("escalated read task parks in 'review' (not closed)", e?.state === "review", `got ${e?.state}`);
    check("escalated read task is NOT closed", e?.state !== "closed");
    check("escalated posts a warning finding for re-dispatch", db.listFindings(escalated.id).some((f) => f.severity === "warning" && /escalated/i.test(f.summary)));

    // 3a. ERRORED (isError) → parked in 'review', NEVER auto-closed (must stay visible so it isn't lost).
    const errored = mkRead("read: this run crashed");
    await manager.finalizeReader(errored, asResult({ isError: true }));
    const er = db.getThread(errored.id);
    check("errored read task parks in 'review' (not closed)", er?.state === "review", `got ${er?.state}`);
    check("errored read task is NOT closed", er?.state !== "closed");

    // 3b. NO RESULT (reader died without a structured result) → same park, not closed.
    const died = mkRead("read: reader died");
    await manager.finalizeReader(died, undefined);
    const d = db.getThread(died.id);
    check("no-result read task parks in 'review' (not closed)", d?.state === "review", `got ${d?.state}`);
    check("no-result read task is NOT closed", d?.state !== "closed");
  } finally {
    // ThreadManager's only timers are unref'd (cap supervisor / purge), so tsx exits cleanly on its own.
    // Close the SQLite handle before removing the dir — Windows locks the open DB file, and an EPERM there
    // is harmless (temp dir, OS-reclaimed), so don't let cleanup fail the run.
    try { db.raw.close(); } catch { /* already closed */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock — harmless */ }
  }
}

// ---- run -------------------------------------------------------------------------------------------
console.log("Reader lane (Option C) — read-only enforcement test");
await testToolset();
await testGitAllowlist();
await testFinalizeDisposition();

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
