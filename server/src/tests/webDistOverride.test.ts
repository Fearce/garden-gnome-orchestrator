/**
 * Gate: a server pinned to a web bundle serves THAT bundle and never rebuilds the live one.
 *
 *   npm run test:web-dist --prefix server
 *
 * The running console serves `web/dist` out of this checkout, and every server process started in
 * built mode runs `webAutoBuild`, which rebuilds `web/dist` whenever `web/` sources look newer. A lab
 * boots a second such process, so before `WEB_DIST` existed every lab run was also a second
 * auto-builder racing prod's over the same directory, and a lab could only test uncommitted web code
 * by deploying it live first. `lab-harness.cjs` always sets `WEB_DIST` (its half is `test:lab-harness`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pinned = mkdtempSync(join(tmpdir(), "web-dist-pin-"));
process.once("exit", () => rmSync(pinned, { recursive: true, force: true }));
// config.ts reads env at import time, so both must be set before the dynamic imports below.
process.env.WEB_DIST = pinned;
process.env.npm_lifecycle_event = "start"; // built mode: the one where auto-build would otherwise run

const { config } = await import("../config.js");
const { shouldRunAutoBuild } = await import("../webAutoBuild.js");

assert.equal(config.webDist, resolve(pinned), "WEB_DIST pins the bundle the server serves");
assert.equal(shouldRunAutoBuild(), false, "an instance serving a pinned bundle never rebuilds web/dist");

delete process.env.WEB_DIST;
assert.equal(shouldRunAutoBuild(), true, "without a pin, built mode still auto-builds (prod is unchanged)");

console.log("web-dist gate passed - a pinned server serves its own bundle and never rebuilds the live one.");
