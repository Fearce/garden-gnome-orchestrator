/* Locating the globally-installed Playwright, from any cwd, with no NODE_PATH.
 *
 * This lived in THREE hand-copied places (`lab-harness.cjs` for every lab, plus
 * `web/scripts/console-smoke.cjs` and `web/scripts/check-accounts-visible.cjs` for the sweep's two
 * browser probes), and all three carried the same blind spot, so one environment change broke the
 * labs and step 6 of the nightly sweep at once. It is one module now; require it, never re-copy it.
 *
 * The blind spot: they resolved a global install via `npm root -g` alone. That answers from npm's
 * configured `prefix`, so when the prefix has been pointed at a project checkout it names a tree
 * Playwright was never installed into, while the real copy sits in the platform default root. That
 * is the live state on this box (`npm root -g` resolves into a sibling checkout's
 * `server/node_modules`; Playwright is in `%APPDATA%\npm\node_modules`). Because the bare
 * `require("playwright")` candidates fail first without NODE_PATH, the whole ladder missed and
 * `probe:console` reported "Playwright not found" over a perfectly good install, which reads as a
 * dead console rather than a lookup bug.
 *
 * So: try every plausible root, and when none of them hit, name each path tried. A resolution error
 * that lists where it looked is the difference between a one-line fix and a re-diagnosis.
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** Every plausible global module root, most specific first. */
function globalModuleRoots() {
  const roots = [];
  const push = (p) => p && !roots.includes(p) && roots.push(p);
  // `npm.cmd` directly rather than `npm` under `shell: true`: the shell form works, but Node 22+
  // prints a DEP0190 warning for it on every call, which lands in the middle of probe output.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const args of [["root", "-g"], ["config", "get", "prefix"]]) {
    try {
      const out = execFileSync(npm, args, { windowsHide: true }).toString().trim();
      if (!out || out === "undefined") continue;
      // `root -g` is already a node_modules dir; `prefix` is its parent (plus lib/ off Windows).
      push(args[0] === "root" ? out : path.join(out, "node_modules"));
      if (args[0] === "prefix") push(path.join(out, "lib", "node_modules"));
    } catch {
      /* npm not on PATH, or this subcommand failed: the static roots below may still hit */
    }
  }
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, "npm", "node_modules"));
  if (process.env.HOME) push(path.join(process.env.HOME, ".npm-global", "lib", "node_modules"));
  push("/usr/local/lib/node_modules");
  return roots;
}

/** The `chromium` export of whichever Playwright this machine actually has. Throws naming every
 *  path tried, so a miss is diagnosable without re-deriving the search order. */
function loadChromium() {
  const tried = [];
  for (const mod of [process.env.PLAYWRIGHT_PATH, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return require(mod).chromium;
    } catch {
      tried.push(mod);
    }
  }
  for (const root of globalModuleRoots()) {
    for (const name of ["playwright", "playwright-core"]) {
      const candidate = path.join(root, name);
      try {
        return require(candidate).chromium;
      } catch {
        tried.push(candidate);
      }
    }
  }
  throw new Error(
    "Playwright not found. Install it (`npm i -g playwright`) or set PLAYWRIGHT_PATH to its module dir.\nTried:\n  " +
      tried.join("\n  "),
  );
}

module.exports = { loadChromium, globalModuleRoots };
