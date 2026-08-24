// "Does the RUNNING server differ between these two commits?" — the one predicate behind both
// `nightly-health.cjs`'s `dist vs HEAD` line and `deploy.cjs --verify`.
//
// It exists as its own module because those two checks answer the same question and must never drift:
// health learned on 2026-08-18 (`4075fdf`) that a check whose remedy is bouncing prod has to be right,
// and got a content comparison — while `--verify` kept comparing raw commit SHAs, so a docs-only or
// scripts-only commit made it print "your change is NOT running" and invite a restart that tree-kills
// every in-flight agent. A second hand-written copy of the rule would drift the same way again, which is
// exactly what `probe:run-errors`'s cap-classifier agreement section exists to catch elsewhere.
//
// Pure and require-safe: no side effects on import, so a gate can hold it (`test:compiled-diff`).

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");

/** What tsc compiles into the RUNNING server. `tsconfig.json` is an input (its target/lib change the
 *  emitted JS); `package.json` is not (a dependency bump changes `node_modules`, not `dist`, and is
 *  handled by an install, not a rebuild). */
const SERVER_RUNTIME = ["server/src", "server/tsconfig.json"];
/** Compiled, but never executed by the server — so a committed test or probe must NOT read as drift.
 *  Health has excluded these since it started comparing content; `--verify` now agrees. */
const SERVER_NOT_RUNTIME = [":(exclude)server/src/tests", ":(exclude)server/src/tools"];
/** What Vite bundles into `web/dist`. A change here needs a rebuild + a browser reload, NOT a restart —
 *  `web/dist` is static — so it is reported separately rather than folded into the server answer. */
const WEB_INPUT = ["web/src", "web/index.html", "web/vite.config.ts", "web/tsconfig.json"];

/**
 * Files differing between two commits under `pathspec`.
 *
 * Two-dot on purpose, so it is direction-agnostic: a dist built from a LATER commit than HEAD (someone
 * checked out backwards) is just as much a mismatch as one built from an earlier commit.
 *
 * @returns {string[] | null} changed paths, or null when git cannot compare the two (an unreachable
 *   commit after a rebase, no git at all) — a null must never be read as "nothing changed".
 */
function diffBetween(a, b, pathspec, cwd = REPO) {
  if (!a || !b) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${a}..${b}`, "--", ...pathspec], {
      encoding: "utf8",
      cwd,
      stdio: "pipe",
    }).trim();
    return out ? out.split(/\r?\n/) : [];
  } catch {
    return null;
  }
}

/** Runtime server sources that differ between two commits — i.e. whether a restart would ship anything.
 *  Empty means the two commits produce the same running server, however far apart they are.
 *  `cwd` defaults to this checkout; the gate points it at a throwaway repo whose history it controls. */
function serverRuntimeDiff(a, b, cwd) {
  return diffBetween(a, b, [...SERVER_RUNTIME, ...SERVER_NOT_RUNTIME], cwd);
}

/** Web sources that differ between two commits — a rebuild + reload, never a restart. */
function webInputDiff(a, b, cwd) {
  return diffBetween(a, b, WEB_INPUT, cwd);
}

/**
 * The whole verdict for "the live build is `liveCommit`, HEAD is `headCommit` — is my change running?"
 *
 * @returns {{ live: boolean, reason: "same-commit"|"no-runtime-change"|"runtime-changed"|"unknown",
 *   serverChanged: string[]|null, webChanged: string[]|null }}
 *   `live` is true only when the running process genuinely contains HEAD's server behaviour. It stays
 *   FALSE for "unknown": a check that cannot prove a deploy landed must not claim it did.
 */
function liveness(liveCommit, headCommit, cwd) {
  if (liveCommit && headCommit && liveCommit === headCommit) {
    return { live: true, reason: "same-commit", serverChanged: [], webChanged: [] };
  }
  const serverChanged = serverRuntimeDiff(liveCommit, headCommit, cwd);
  const webChanged = webInputDiff(liveCommit, headCommit, cwd);
  if (serverChanged === null) return { live: false, reason: "unknown", serverChanged: null, webChanged };
  if (serverChanged.length) return { live: false, reason: "runtime-changed", serverChanged, webChanged };
  return { live: true, reason: "no-runtime-change", serverChanged: [], webChanged };
}

module.exports = { diffBetween, serverRuntimeDiff, webInputDiff, liveness, SERVER_RUNTIME, SERVER_NOT_RUNTIME, WEB_INPUT };
