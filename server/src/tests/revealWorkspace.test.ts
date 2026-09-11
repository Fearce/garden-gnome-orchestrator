// Reveal-workspace gate: the containment rules and the HTTP contract behind the clickable folder
// chip. No real file manager is ever launched here; the launcher is injected.
// Run: npm run test:reveal-workspace --prefix server

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  fileManagerCommand,
  knownWorkspaces,
  revealWorkspace,
  type LaunchFileManager,
  type WorkspaceSource,
} from "../workspace/revealWorkspace.js";

const dir = await mkdtemp(join(tmpdir(), "reveal-ws-"));
const file = join(dir, "not-a-folder.txt");
await writeFile(file, "x");
const gone = join(dir, "deleted-workspace");

/** Records what would have been spawned instead of opening a real Explorer window. */
function recordingLaunch(): { launch: LaunchFileManager; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    launch: async (cmd, args) => {
      calls.push({ cmd, args });
    },
  };
}

// --- the known-workspace allow-list -----------------------------------------------------------
const source: WorkspaceSource = {
  listThreads: () => [{ workspace: dir }, { workspace: "  " }, { workspace: gone }],
  listCoworkSessions: () => [{ workspace: file }],
  listScheduledTasks: () => [{ workspace: "C:\\Users\\Mikkel\\projects\\" }],
};
const known = knownWorkspaces(source);

assert.equal(known.has(dir.replace(/\\/g, "/").toLowerCase()), true, "a task workspace is openable");
assert.equal(known.has("c:/users/mikkel/projects"), true, "a trailing separator is normalized away, and case is ignored");
assert.equal(known.size, 4, "blank workspaces are dropped and duplicates collapse");

// --- refusals ---------------------------------------------------------------------------------
const platform: NodeJS.Platform = "win32";

assert.deepEqual(await revealWorkspace("   ", known, { platform }), { ok: false, status: 400, error: "No folder was given." });

const relative = await revealWorkspace("projects\\thing", known, { platform });
assert.equal(relative.ok, false);
assert.equal(relative.ok === false && relative.status, 400);

// The containment that keeps this from being a "launch anything" endpoint: an existing directory
// that no card ever showed is still refused, and refused BEFORE the disk is touched.
const stranger = recordingLaunch();
const unknown = await revealWorkspace(tmpdir(), known, { platform, launch: stranger.launch });
assert.equal(unknown.ok, false, "an unknown but real directory is refused");
assert.equal(unknown.ok === false && unknown.status, 403);
assert.equal(stranger.calls.length, 0, "nothing is spawned for a refused path");

// A nested path inside a known workspace is not itself known, so it cannot be smuggled through.
const nested = await revealWorkspace(join(dir, "child"), known, { platform, launch: stranger.launch });
assert.equal(nested.ok === false && nested.status, 403, "a child of a known workspace is not itself openable");
assert.equal(stranger.calls.length, 0);

// The deleted-workspace path the console has to survive: the card still shows it, the disk doesn't.
const missing = await revealWorkspace(gone, known, { platform, launch: stranger.launch });
assert.equal(missing.ok, false);
assert.equal(missing.ok === false && missing.status, 404);
assert.equal(missing.ok === false && missing.error, "That folder no longer exists on this machine.");
assert.equal(stranger.calls.length, 0, "a missing folder never reaches the file manager");

const notADir = await revealWorkspace(file, known, { platform, launch: stranger.launch });
assert.equal(notADir.ok === false && notADir.status, 400, "a file that is somehow registered as a workspace is refused");

// --- the successful open ----------------------------------------------------------------------
const windows = recordingLaunch();
assert.deepEqual(await revealWorkspace(dir, known, { platform, launch: windows.launch }), { ok: true });
assert.deepEqual(windows.calls, [{ cmd: "explorer.exe", args: [dir] }], "the path is one argv element, never a shell string");

const mac = recordingLaunch();
assert.deepEqual(await revealWorkspace(dir, known, { platform: "darwin", launch: mac.launch }), { ok: true });
assert.deepEqual(mac.calls, [{ cmd: "open", args: [dir] }]);

const linux = recordingLaunch();
assert.deepEqual(await revealWorkspace(dir, known, { platform: "linux", launch: linux.launch }), { ok: true });
assert.deepEqual(linux.calls, [{ cmd: "xdg-open", args: [dir] }]);

assert.equal(fileManagerCommand("aix", dir), null, "an unmapped platform has no command");
const unsupported = await revealWorkspace(dir, known, { platform: "aix" });
assert.equal(unsupported.ok === false && unsupported.status, 501);

// A launcher that fails (missing binary, denied) becomes a reported error, not an unhandled throw.
const broken = await revealWorkspace(dir, known, {
  platform,
  launch: async () => {
    throw new Error("ENOENT");
  },
});
assert.equal(broken.ok === false && broken.status, 500);
assert.equal(broken.ok === false && broken.error.includes("explorer.exe"), true);

// --- the HTTP contract --------------------------------------------------------------------------
// Mirrors the route in index.ts: auth gate, string-only body, status + { error } envelope.
const isAuthed = (cookie?: string): boolean => cookie === "session=yes";
const app = Fastify({ logger: false });
const served = recordingLaunch();
app.post<{ Body: { path?: string } }>("/api/fs/reveal", async (req, reply) => {
  if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
  const requested = typeof req.body?.path === "string" ? req.body.path : "";
  const result = await revealWorkspace(requested, knownWorkspaces(source), { platform, launch: served.launch });
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return { ok: true };
});

const headers = { cookie: "session=yes", "content-type": "application/json" };
assert.equal((await app.inject({ method: "POST", url: "/api/fs/reveal", payload: { path: dir } })).statusCode, 401, "the endpoint is auth-gated");
assert.equal(served.calls.length, 0);

const opened = await app.inject({ method: "POST", url: "/api/fs/reveal", headers, payload: { path: dir } });
assert.equal(opened.statusCode, 200);
assert.deepEqual(opened.json(), { ok: true });
assert.deepEqual(served.calls, [{ cmd: "explorer.exe", args: [dir] }]);

const deleted = await app.inject({ method: "POST", url: "/api/fs/reveal", headers, payload: { path: gone } });
assert.equal(deleted.statusCode, 404);
assert.equal(deleted.json<{ error: string }>().error, "That folder no longer exists on this machine.");

const outside = await app.inject({ method: "POST", url: "/api/fs/reveal", headers, payload: { path: tmpdir() } });
assert.equal(outside.statusCode, 403);

// A non-string body member must not reach the reveal logic as an object.
const bogus = await app.inject({ method: "POST", url: "/api/fs/reveal", headers, payload: { path: { toString: "nope" } } });
assert.equal(bogus.statusCode, 400);
assert.equal(served.calls.length, 1, "only the one legitimate open ever spawned anything");

await app.close();
await rm(dir, { recursive: true, force: true });

console.log("All reveal-workspace checks passed.");
