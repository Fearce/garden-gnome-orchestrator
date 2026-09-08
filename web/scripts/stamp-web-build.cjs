// Record WHICH commit `web/dist` was built from, as the last step of `npm run build --prefix web`.
//
// The server half has had this since 2026-07-29 (`server/scripts/stamp-build.cjs`), for a failure the
// web half is just as exposed to: a feature whose two halves ship separately, silently. That incident
// was the director Stop button shipping its WEB half while the server half sat unbuilt — and the check
// written afterwards only ever learned to watch the server. So nothing in this repo could answer "is
// the bundle in web/dist current?", and `deploy --verify` answered it from the SERVER's build commit,
// which is not a fact about web/dist at all: it nagged for a rebuild that had already happened, and
// stayed silent on a genuinely stale bundle whenever the live server happened to match HEAD.
//
// mtimes cannot answer it either — `web/dist` is rewritten wholesale by every build, and a checkout
// rewrites source mtimes — which is the same reasoning that put a commit stamp on the server dist.
//
// Read by `compiled-diff.cjs`'s `webDistState`, the single predicate `deploy.cjs --verify` and
// `nightly-health.cjs` share. Never fails the build: a missing stamp reads as "unknown", never as
// "current", so the worst a write failure costs is one honest "cannot prove it" line.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const DIST = path.resolve(__dirname, "..", "dist");
const OUT = path.join(DIST, ".build-info.json");

/** Vite's inputs, in the same shape `git status --porcelain --` accepts. Kept byte-identical to
 *  `compiled-diff.cjs`'s `WEB_INPUT`, which is what the currency comparison diffs. */
const WEB_INPUT = ["web/src", "web/index.html", "web/vite.config.ts", "web/tsconfig.json"];

const git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: REPO, windowsHide: true }).trim();

function main() {
  let info = { at: Date.now() };
  try {
    // `dirty` means this bundle may contain uncommitted web code. In this shared checkout that is
    // routinely a concurrent agent's WIP, so it is recorded rather than conflated with HEAD.
    info = { ...info, commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--", ...WEB_INPUT]) !== "" };
  } catch {
    info = { ...info, commit: null, dirty: null }; // no git (a tarball build) — read as "unknown", not "stale"
  }
  try {
    fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n", "utf8");
  } catch (e) {
    console.warn(`stamp-web-build: could not write ${OUT}: ${String(e)}`);
  }
}

main();
