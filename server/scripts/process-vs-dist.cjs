// Is the RUNNING process on the code that is currently in `dist`?
//
// The sibling question — is `dist` built from HEAD? — became a fact when `stamp-build.cjs` started
// recording the commit each build came from, and `nightly-health.cjs` compares that stamp to HEAD by
// CONTENT. This half had no fact behind it, so it was inferred from two timestamps: dist newer than the
// process start, plus any `server/src` file touched since. Neither signal means what it looks like:
//
//   - a rebuild for a docs- or scripts-only commit writes byte-identical server output with a fresh mtime;
//   - a checkout (or an agent rewriting a file with the same bytes) restamps sources that did not change.
//
// So on 2026-08-18 the sweep reported "likely a real stale build (someone needs a restart)" against a
// process that was running exactly the right code, and disproving it by hand took ~8 tool calls. Worse, a
// bogus warning here asks for a production bounce that interrupts every in-flight agent.
//
// The process now reports which build it loaded (`/api/health` → `build`, read once at boot by
// `src/buildInfo.ts`), so this compares commit to commit and, when they differ, asks git whether anything
// under `server/src` actually changed between them — the same content test the dist-vs-HEAD half uses.

/**
 * @param {object} args
 * @param {{commit: string|null, at: number|null, dirty: boolean|null}|null} args.running
 *        `build` from the live `/api/health`; null when the endpoint omitted it.
 * @param {{commit: string|null, at: number|null, dirty: boolean|null}|null} args.dist
 *        Parsed `dist/.build-info.json`.
 * @param {string[]|null} args.changedFiles
 *        `server/src` files differing between the two commits (tests/tools excluded), or null if git
 *        could not compare them. Ignored when the commits are equal.
 * @returns {{state: "current"|"stale"|"dirty-build"|"unstamped"|"unknown", detail: string}}
 */
function classifyProcessBuild({ running, dist, changedFiles }) {
  if (!running) {
    return {
      state: "unstamped",
      detail:
        "the running process reports no build stamp — it started before this check shipped, or runs from " +
        "source under tsx. Falling back to mtimes, which cannot tell a content-free rebuild from a real one",
    };
  }
  if (!running.commit) {
    return { state: "unstamped", detail: "the running process loaded a build that recorded no commit (no git at build time)" };
  }
  if (!dist || !dist.commit) {
    return { state: "unknown", detail: "dist has no usable .build-info.json to compare the running build against" };
  }

  const runShort = running.commit.slice(0, 8);
  const distShort = dist.commit.slice(0, 8);

  if (running.commit !== dist.commit) {
    if (changedFiles == null) {
      return { state: "unknown", detail: `git cannot compare the running build ${runShort} to dist ${distShort} (unreachable after a rebase?)` };
    }
    if (changedFiles.length) {
      const shown = changedFiles.slice(0, 3).join(", ");
      return {
        state: "stale",
        detail:
          `the process is running build ${runShort} but dist holds ${distShort}, and ${changedFiles.length} ` +
          `server/src file(s) differ between them (${shown}${changedFiles.length > 3 ? ", …" : ""}) — that built ` +
          "change is NOT live. Issue the atomic hub restart",
      };
    }
  }

  // Content-equal. A dirty build is the one case where equal commits still prove nothing, because either
  // side may carry uncommitted code that the commit id does not describe.
  if (running.dirty || dist.dirty) {
    return {
      state: "dirty-build",
      detail:
        `process build ${runShort} and dist ${distShort} match on server/src, but ${running.dirty ? "the running build" : "dist"} ` +
        "was built from a DIRTY tree — equal commits do not prove equal code here",
    };
  }

  if (running.commit === dist.commit) {
    return { state: "current", detail: `the process is running the build now in dist (${runShort})` };
  }
  return {
    state: "current",
    detail:
      `the process is running build ${runShort} and dist holds ${distShort}, but nothing under server/src ` +
      "differs between them — a docs/scripts/web-only rebuild, no runtime drift, no restart needed",
  };
}

module.exports = { classifyProcessBuild };
