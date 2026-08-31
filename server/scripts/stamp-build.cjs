// Record WHICH commit a dist was built from, as the last step of `npm run build`.
//
// Without this, "is the live server running current code?" can only be answered from timestamps, and
// timestamps cannot distinguish the two orders a build and a commit legitimately happen in: build → verify →
// commit is the normal workflow, so a dist that is a minute OLDER than HEAD is usually correct, while a dist
// built before an unrelated later commit is not. Guessing from mtimes therefore either cries wolf on every
// sweep or misses the real case — a committed server change that was never built, which is exactly how the
// director Stop button shipped its web half and sat in prod for a day with no server half (2026-07-29).
//
// `nightly-health.cjs` reads this and compares the stamped commit against HEAD by CONTENT (did anything
// under server/src actually change between them), so it only warns when dist is genuinely behind.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(__dirname, "..", "dist", ".build-info.json");

const git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: REPO, windowsHide: true }).trim();

function main() {
  let info = { at: Date.now() };
  try {
    // `dirty` means the build may contain uncommitted code — in this shared checkout that can be a
    // concurrent agent's WIP, so it is worth recording rather than silently conflating with HEAD.
    info = { ...info, commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--", "server/src"]) !== "" };
  } catch {
    info = { ...info, commit: null, dirty: null }; // no git (a tarball deploy) — health treats this as "unknown", not "stale"
  }
  try {
    fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n", "utf8");
  } catch (e) {
    // Never fail a build over its own bookkeeping.
    console.warn(`stamp-build: could not write ${OUT}: ${String(e)}`);
  }
}

main();
