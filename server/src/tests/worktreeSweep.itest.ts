/**
 * Integration test — the stale-worktree sweep (`orchestrator/worktreeSweep.ts`) against REAL git repos.
 * Run:  npm run test:worktree-sweep   (from server/)
 *
 * Merged and pushed worktrees go; unpushed-and-unmerged, dirty, live-owned, in-use and recently active ones
 * stay; a kept worktree of a finished task sheds its ignored build output.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

const { sweepRepoWorktrees, reposOf } = await import("../orchestrator/worktreeSweep.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ggo-sweep-test-")));
const repo = join(tmp, "app");
const remote = join(tmp, "remote.git");
git(tmp, "init", "--quiet", "--bare", remote);
mkdirSync(repo);
git(repo, "init", "--quiet", "-b", "master");
const emptyHooks = join(repo, ".git", "gate-empty-hooks");
mkdirSync(emptyHooks);
git(repo, "config", "core.hooksPath", emptyHooks);
for (const [k, v] of [["user.name", "T"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
writeFileSync(join(repo, ".gitignore"), "build/\nnode_modules/\n");
writeFileSync(join(repo, "README.md"), "base\n");
git(repo, "add", "-A");
git(repo, "commit", "--quiet", "-m", "base");
git(repo, "remote", "add", "origin", remote);
git(repo, "push", "--quiet", "origin", "master");

const home = join(tmp, "app.worktrees");
function worktree(name: string, branch: string, commit: boolean): string {
  const dir = join(home, name);
  git(repo, "worktree", "add", "--quiet", "-b", branch, dir);
  if (commit) {
    writeFileSync(join(dir, `${name}.txt`), name);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", name);
  }
  return dir;
}
const untouched = worktree("untouched", "feature/untouched", false); // merged trivially: nothing of its own
const pushed = worktree("pushed", "feature/pushed", true);
git(pushed, "push", "--quiet", "origin", "feature/pushed");
const unpushed = worktree("unpushed", "feature/unpushed", true);
const dirty = worktree("dirty", "feature/dirty", false);
writeFileSync(join(dirty, "scratch.txt"), "x");
const live = worktree("live", "ggo/live-aaaaaaaa", false);
const busy = worktree("busy", "feature/busy", false);
const failedTask = worktree("failedtask", "ggo/failedtask-bbbbbbbb", true); // unmerged, owner failed
mkdirSync(join(failedTask, "build"));
writeFileSync(join(failedTask, "build", "big.bin"), "x".repeat(4096));

const thread = (id: string, state: string): Thread => ({ id, state, worktrees: [] }) as unknown as Thread;
const threads = [thread("aaaaaaaa-0000", "implementing"), thread("bbbbbbbb-0000", "failed")];
const later = Date.now() + 13 * 3600_000;

const run = (dryRun: boolean) => sweepRepoWorktrees(repo, { threads, dryRun, now: later, processCommandLines: [`godot --path ${busy}`] });
const slash = (p: string): string => p.split(String.fromCharCode(92)).join("/").toLowerCase();
const find = (list: Awaited<ReturnType<typeof run>>, dir: string) => list.find((e) => slash(e.path) === slash(dir));

console.log("dry run changes nothing");
const dry = await run(true);
check("dry run reports untouched as removable", find(dry, untouched)?.action === "removed");
check("dry run left the folder", existsSync(untouched));
check("dry run left the build output", existsSync(join(failedTask, "build", "big.bin")));

console.log("real run");
const real = await run(false);
check("untouched worktree removed", !existsSync(untouched) && find(real, untouched)?.action === "removed");
check("pushed worktree removed", !existsSync(pushed));
check("pushed branch kept", git(repo, "branch", "--list", "feature/pushed") !== "");
check("unpushed work kept", existsSync(unpushed) && /not merged/.test(find(real, unpushed)?.reason ?? ""), find(real, unpushed)?.reason);
check("dirty worktree kept", existsSync(dirty) && /uncommitted/.test(find(real, dirty)?.reason ?? ""));
check("live task's worktree kept", existsSync(live) && /implementing/.test(find(real, live)?.reason ?? ""));
check("worktree used by a process kept", existsSync(busy) && /process/.test(find(real, busy)?.reason ?? ""));
check("failed task's unmerged worktree kept", existsSync(failedTask));
check("failed task's build output trimmed", !existsSync(join(failedTask, "build")) && existsSync(join(failedTask, `failedtask.txt`)));
check("main checkout untouched", existsSync(join(repo, "README.md")));

console.log("recently active unowned worktree is left alone");
const fresh = worktree("fresh", "feature/fresh", false);
const quick = await sweepRepoWorktrees(repo, { threads, now: Date.now(), processCommandLines: [] });
check("kept: active within 12h", existsSync(fresh) && /12h/.test(find(quick, fresh)?.reason ?? ""));

console.log("many tasks in one checkout resolve to one repo quickly");
const many = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, state: "done", workspace: repo, worktrees: [] }) as unknown as Thread);
const started = Date.now();
const repos = await reposOf(many);
const tookMs = Date.now() - started;
check("one repo found", repos.length === 1, JSON.stringify(repos));
check("one git lookup per distinct folder, not per task", tookMs < 5_000, `${tookMs} ms for 300 tasks`);

console.log("a starting manager leaves the sweep until boot has settled");
class StubAccounts {
  onUsageRefresh(): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(): void {}
  applyEnabled(): void {}
  applyWeeklySafetyPct(): void {}
  setSpreadUsage(): void {}
  setProfileToken(): void {}
  auxToken(): undefined {
    return undefined;
  }
}
const db = new Db(join(tmp, "orchestrator.sqlite"));
const failedThread = db.createThread({ title: "failed task", workspace: repo, rawPrompt: "p" });
db.updateThread(failedThread.id, { state: "failed" });
const sweepable = worktree("bootswept", `ggo/bootswept-${failedThread.id.slice(0, 8)}`, false);
new ThreadManager(db, new EventHub(), new FileMemoryService(join(tmp, "memory")), new StubAccounts() as unknown as AccountManager);
for (let i = 0; i < 50 && existsSync(sweepable); i++) await new Promise((r) => setTimeout(r, 100));
check("a merged worktree of a failed task survives the first seconds after boot", existsSync(sweepable));
db.raw.close();

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
