#!/usr/bin/env node

const assert = require("node:assert/strict");
const { classifyListenerShape } = require("./listener-shape.cjs");

// --- THE 2026-09-11 CASE: source-run, verified against a real `npm run serve` process --------------
{
  const cmd =
    '"C:\\Program Files\\nodejs\\node.exe" --require ' +
    "C:\\Users\\Mikkel\\projects\\garden-gnome-orchestrator\\server\\node_modules\\tsx\\dist\\preflight.cjs --import " +
    "file:///C:/Users/Mikkel/projects/garden-gnome-orchestrator/server/node_modules/tsx/dist/loader.mjs src/index.ts";
  assert.equal(classifyListenerShape(cmd), "source");
}
// The tsx CLI wrapper itself (the port owner's PARENT in the real tree) must not be mistaken for the
// port owner: its own command line has no --import loader flag, so it must not read as "source" either
// if it were (wrongly) handed to this function.
{
  const cmd = '"C:\\Program Files\\nodejs\\node.exe" C:\\...\\server\\node_modules\\tsx\\dist\\cli.mjs src/index.ts';
  assert.equal(classifyListenerShape(cmd), "source", "the cli.mjs wrapper form must still classify as source on its own");
}
// A `tsx watch` dev loop uses the same loader shape.
{
  const cmd = 'node --import file:///.../tsx/dist/loader.mjs src/index.ts';
  assert.equal(classifyListenerShape(cmd), "source");
}

// --- THE SCRIPT-HUB/DIST SHAPE ------------------------------------------------------------------
{
  assert.equal(classifyListenerShape('"C:\\Program Files\\nodejs\\node.exe" dist\\index.js'), "dist");
}
{
  assert.equal(classifyListenerShape("node dist/index.js"), "dist", "forward-slash form (a non-Windows or WSL-style path)");
}

// --- NEVER GUESS -----------------------------------------------------------------------------------
{
  assert.equal(classifyListenerShape(null), "unknown");
  assert.equal(classifyListenerShape(undefined), "unknown");
  assert.equal(classifyListenerShape(""), "unknown");
  assert.equal(classifyListenerShape("node scripts/supervise.cjs"), "unknown", "the SUPERVISOR's own line names neither dist nor source");
  assert.equal(classifyListenerShape("node -e \"console.log(1)\""), "unknown");
}
{
  // Implausible, but a command line naming both must not be resolved by picking one at random.
  const cmd = "node dist/index.js --import file:///tsx/dist/loader.mjs src/index.ts";
  assert.equal(classifyListenerShape(cmd), "unknown");
}

console.log("listener-shape: ok");
