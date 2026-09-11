// Is the process bound to a port running COMPILED `dist/index.js`, or TypeScript SOURCE loaded
// directly by tsx (CLAUDE.md's "supervisor" deployment: `npm run serve` -> scripts/supervise.cjs ->
// `node <tsx cli> src/index.ts`, `ORCH_SUPERVISED=1` -> `process.exit(75)` -> respawn on fresh source)?
//
// `nightly-health.cjs`'s "process vs dist" section asked a dist-shaped question (process start vs
// dist mtime) of every process, on the assumption that CLAUDE.md's Windows script-hub/dist deployment
// is the only shape. It is not: this same repo also runs under `npm run serve`, where the process
// never reads `dist` at all. On 2026-09-11 that produced two false claims in one sweep against a
// perfectly healthy process: a "process started at/after dist mtime (fresh build likely loaded)" line
// that meant nothing (the process never loaded dist to begin with), and `distVsHead`'s "that committed
// change is NOT live, however fresh the process looks" clause read as proof that commit `b26fdaa` was
// undeployed. It was live: the process started AFTER that commit landed, and had never touched dist.
// The genuinely undeployed commit was a different, later one (`78dc504`).
//
// Classified from the LISTENER's own command line (verified against a real `npm run serve` process:
// `"...\node.exe" --require ...\tsx\dist\preflight.cjs --import file:///.../tsx/dist/loader.mjs
// src/index.ts`), never from its parent/grandparent: tsx's own CLI re-spawns a child with the loader
// flags, and it is that CHILD that binds the port, so the port owner's own command line already
// carries everything needed. Never guess: an ambiguous or unreadable command line is "unknown", which
// callers must treat the same as "cannot confirm dist", not as a silent alias for either shape.

/**
 * @param {string|null|undefined} commandLine the full command line of the process bound to the port
 * @returns {"dist"|"source"|"unknown"}
 */
function classifyListenerShape(commandLine) {
  if (typeof commandLine !== "string" || !commandLine.length) return "unknown";
  const dist = /dist[\\/]index\.js/i.test(commandLine);
  const source = /tsx[\\/]dist[\\/](cli|loader|preflight)\.(c|m)?js/i.test(commandLine) && /src[\\/]index\.ts/i.test(commandLine);
  if (dist && !source) return "dist";
  if (source && !dist) return "source";
  return "unknown"; // neither pattern matched, or (implausibly) both did: never pick a side without proof
}

module.exports = { classifyListenerShape };
