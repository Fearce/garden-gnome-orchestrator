// Is `dist` built from current HEAD's server code? The gap `process-vs-dist.cjs` cannot see: that
// module compares the RUNNING PROCESS to `dist`; this compares `dist` to HEAD. Both can agree
// perfectly while `dist` ITSELF predates HEAD, which is how a feature shipped its web half and sat in
// prod for a day with its server half unbuilt (the director Stop button, 2026-07-29).
//
// Extracted out of nightly-health.cjs so the WORDING contract can be gated, not just the state.
// Before 2026-09-11 the "stale" detail asserted liveness directly: "that committed change is NOT
// live, however fresh the process looks". That claim is true only when the running process actually
// LOADS dist, which this function has no way to know: it reads `dist/.build-info.json` and HEAD, full
// stop. A process that never touches dist at all (tsx loading `server/src` directly under
// `npm run serve`) inherited that false liveness verdict anyway, and an operator read it as proof a
// just-landed commit (`b26fdaa`) was undeployed. It was live; a different, later commit was the one
// genuinely missing (`78dc504`). So: this module states the fact it owns (dist lags HEAD by N files)
// and nothing else. The liveness clause belongs to the CALLER, gated on having independently confirmed
// the running process's shape (`listener-shape.cjs`) actually reads dist.
//
// Compared by CONTENT, never by timestamp: build -> verify -> commit is the normal order, so a dist a
// minute older than HEAD is usually correct, and mtimes are rewritten wholesale by a checkout.

/**
 * @param {object} args
 * @param {{commit: string|null, dirty: boolean|null}|null} args.distStamp parsed `dist/.build-info.json`,
 *        or null when it could not be read/parsed at all.
 * @param {string[]|null} args.changedFiles `server/src` files differing between the stamped commit and
 *        HEAD (tests/tools excluded), or null when git could not compare them, or when there is no
 *        stamped commit to compare from. Ignored when there is no usable commit.
 * @returns {{state: "current"|"stale"|"dirty-build"|"unknown", detail: string}}
 */
function classifyDistVsHead({ distStamp, changedFiles }) {
  if (!distStamp) {
    return { state: "unknown", detail: "dist has no .build-info.json, built before build stamping, or by a bare `tsc`" };
  }
  if (!distStamp.commit) {
    return { state: "unknown", detail: "the build recorded no commit (no git at build time)" };
  }
  const short = String(distStamp.commit).slice(0, 8);
  if (changedFiles === null) {
    return { state: "unknown", detail: `git cannot compare the built commit ${short} to HEAD (unreachable after a rebase?)` };
  }
  if (changedFiles.length) {
    return {
      state: "stale",
      detail:
        `dist was built from ${short}, and ${changedFiles.length} server/src file(s) have changed in HEAD since ` +
        `(${changedFiles.slice(0, 3).join(", ")}${changedFiles.length > 3 ? ", …" : ""})`,
    };
  }
  if (distStamp.dirty) {
    return {
      state: "dirty-build",
      detail: `dist matches HEAD's server/src (built from ${short}) but was built from a DIRTY tree, so it may carry uncommitted code`,
    };
  }
  return { state: "current", detail: `dist was built from ${short}, whose server/src matches HEAD` };
}

module.exports = { classifyDistVsHead };
