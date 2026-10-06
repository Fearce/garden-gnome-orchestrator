/**
 * Dry-run (default) or real run of the stale-worktree sweep, outside the server:
 *   npx tsx src/tools/sweepWorktrees.ts [--apply] [--repo <path>]...
 * Reads task ownership from a COPY of the live database, so it never touches the server's file. Without
 * --repo it sweeps every repository GGO tasks have worked in. The server runs the same sweep on boot and daily.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { Db } from "../db/db.js";
import { reposOf, sweepRepoWorktrees } from "../orchestrator/worktreeSweep.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const repoArgs = args.flatMap((a, i) => (a === "--repo" ? [args[i + 1]!] : []));

const copyDir = mkdtempSync(join(tmpdir(), "ggo-sweep-"));
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(config.dbPath + suffix)) copyFileSync(config.dbPath + suffix, join(copyDir, "orchestrator.sqlite" + suffix));
const threads = new Db(join(copyDir, "orchestrator.sqlite")).listThreads();
const repos = repoArgs.length ? repoArgs : await reposOf(threads);

let freed = 0;
for (const repo of repos) {
  for (const e of await sweepRepoWorktrees(repo, { dryRun: !apply, threads, throttleMs: 250 })) {
    freed += e.freedBytes ?? 0;
    console.log(`${e.action.padEnd(7)} ${e.path} [${e.branch ?? "-"}] ${e.reason}${e.freedBytes ? ` (${(e.freedBytes / 1e9).toFixed(2)} GB)` : ""}`);
  }
}
console.log(`${apply ? "freed" : "reclaimable"} ~${(freed / 1e9).toFixed(2)} GB across ${repos.length} repo(s)`);
process.exit(0);
