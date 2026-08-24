import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** What `scripts/stamp-build.cjs` wrote into `dist/.build-info.json` as the last step of `npm run build`. */
export interface BuildInfo {
  commit: string | null;
  at: number | null;
  dirty: boolean | null;
}

/**
 * Which build THIS process loaded.
 *
 * `stamp-build.cjs` already records which commit a `dist` came from, and `nightly-health.cjs` compares that
 * stamp to HEAD by content — so "is the built code current?" is a fact. The other half, "is the RUNNING
 * process on that build?", had no fact behind it and was inferred from mtimes: dist newer than the process
 * start, plus any `server/src` file touched since. Both signals are rewritten by things that change no
 * runtime code at all — a rebuild for a docs/scripts commit produces byte-identical server output with a
 * fresh mtime, and a checkout restamps source files wholesale — so the check cried wolf on 2026-08-18 and
 * cost ~8 tool calls to disprove by hand.
 *
 * Read ONCE, at module load. `npm run build` rewrites the stamp in place, so re-reading it later would make
 * the process report a build it never loaded — precisely the confusion this value exists to end.
 */
const loaded: BuildInfo | null = readStamp();

function readStamp(): BuildInfo | null {
  // dist/buildInfo.js sits beside dist/.build-info.json. Under tsx the module is src/buildInfo.ts, where no
  // stamp exists — so a dev server reports null rather than borrowing whatever dist happens to hold.
  const stampFile = join(dirname(fileURLToPath(import.meta.url)), ".build-info.json");
  try {
    const parsed = JSON.parse(readFileSync(stampFile, "utf8")) as Partial<BuildInfo>;
    return {
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      at: typeof parsed.at === "number" ? parsed.at : null,
      dirty: typeof parsed.dirty === "boolean" ? parsed.dirty : null,
    };
  } catch {
    return null;
  }
}

export function buildInfo(): BuildInfo | null {
  return loaded;
}

/** One-line build identity for a log line — short commit, plus the `dirty` flag when it's set. */
export function buildLabel(): string {
  if (!loaded) return "unstamped (running from source, or built without the stamp step)";
  if (!loaded.commit) return "no commit recorded at build time";
  return `${loaded.commit.slice(0, 8)}${loaded.dirty ? " (dirty build)" : ""}`;
}
