// Which `server/src` runtime files' ON-DISK bytes are newer than a given instant.
//
// This is the only signal available when a process loads TypeScript SOURCE directly (tsx, under
// `npm run serve` -> scripts/supervise.cjs), because such a process has no build stamp
// (`src/buildInfo.ts` reads `dist/.build-info.json`, which does not exist under tsx: see
// listener-shape.cjs for how nightly-health.cjs tells that shape apart from a dist-loaded process).
// tsx's loader reads whatever bytes sat on disk at the moment it imported a file, so a file whose
// mtime is AFTER the process started is not what the process is running, whatever HEAD says.
//
// Extracted out of nightly-health.cjs's original inline `newestSrcMtimeMs` (which only ever asked
// "what is the single newest mtime", not "which files"), so the exclusion rules stay in one place
// instead of being redefined at each new call site: tests (`src/tests/`, `*.test.ts`, `*.itest.ts`)
// and agent tooling (`src/tools/`) are excluded, because neither is ever loaded by the running server,
// and an edit to one after boot must not trip a false "stale source" warning.
//
// Caveat baked into every caller's wording, not enforced here: a `git checkout` rewrites mtimes
// WHOLESALE, so a bulk-rewritten tree can look newer than it really is. This is corroborating
// evidence, not proof, on a freshly checked out tree (the same caveat the original comment in
// nightly-health.cjs documented, kept there verbatim).

const fs = require("node:fs");
const path = require("node:path");

const SERVER = path.resolve(__dirname, "..");
const DEFAULT_SRC_DIR = path.join(SERVER, "src");

/** Every compiled runtime `.ts`-family source under `srcDir`, with its mtime. Tests/tools excluded.
 *  Never throws: an unreadable directory yields an empty list, same as `newestSrcMtimeMs` always did. */
function walkRuntimeSrcFiles(srcDir = DEFAULT_SRC_DIR) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "tests" || e.name === "tools") continue;
        walk(full);
      } else if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.(test|itest)\.(ts|tsx|mts|cts)$/.test(e.name)) {
        let mtimeMs;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue; // deleted between readdir and stat, never fatal to the scan
        }
        out.push({ path: full, mtimeMs });
      }
    }
  };
  walk(srcDir);
  return out;
}

/** Newest mtime among those files, or null if `srcDir` is unreadable/empty. Same contract as the
 *  original inline `newestSrcMtimeMs` in nightly-health.cjs. */
function newestSrcMtimeMs(srcDir = DEFAULT_SRC_DIR) {
  const files = walkRuntimeSrcFiles(srcDir);
  if (!files.length) return null;
  return files.reduce((max, f) => (f.mtimeMs > max ? f.mtimeMs : max), 0);
}

/** Runtime files whose mtime is strictly after `sinceMs`, newest first, paths relative to `baseDir`
 *  (forward slashes, so a printed list reads the same on Windows as everywhere else). `baseDir`
 *  defaults to `server/` for real callers; a test points both `srcDir` and `baseDir` at one fixture. */
function srcFilesNewerThan(sinceMs, srcDir = DEFAULT_SRC_DIR, baseDir = SERVER) {
  if (!Number.isFinite(sinceMs)) return [];
  return walkRuntimeSrcFiles(srcDir)
    .filter((f) => f.mtimeMs > sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((f) => ({ path: path.relative(baseDir, f.path).split(path.sep).join("/"), mtimeMs: f.mtimeMs }));
}

module.exports = { walkRuntimeSrcFiles, newestSrcMtimeMs, srcFilesNewerThan };
