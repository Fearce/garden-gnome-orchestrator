const assert = require("node:assert/strict");
const { cookieHeader, parseArgs, passwordFromEnvOrDotenv, socketUrl, targetSummary } = require("./inject-thread.cjs");

const ID = "400ba41a-eb82-4484-97db-e1a1a3d0ce50";

assert.deepEqual(
  parseArgs(["--thread", ID.toUpperCase(), "--message", "  steer the task  ", "--mode", "queue", "--url", "https://example.test/base/", "--confirm"]),
  { thread: ID, message: "steer the task", mode: "queue", url: "https://example.test/base", confirm: true },
  "normalizes the exact id and text before it reaches the socket",
);
assert.throws(() => parseArgs(["--thread", ID.slice(0, 8), "--message", "x"]), /full UUID/);
assert.throws(() => parseArgs(["--thread", ID, "--message", "x", "--mode", "later"]), /--mode/);
assert.throws(() => parseArgs(["--thread", ID, "--message", "   "]), /blank/);
assert.equal(socketUrl("http://127.0.0.1:4317"), "ws://127.0.0.1:4317/ws");
assert.equal(socketUrl("https://example.test/base/"), "wss://example.test/base/ws");
assert.equal(passwordFromEnvOrDotenv({ AUTH_PASSWORD: " secret " }, "missing"), "secret");
assert.equal(passwordFromEnvOrDotenv({}, "missing"), "");
assert.deepEqual(targetSummary({ id: ID, title: "Release task", state: "review", workspace: "C:\\workspace", brief: "ignored" }), {
  id: ID, title: "Release task", state: "review", workspace: "C:\\workspace",
});
assert.equal(cookieHeader({ getSetCookie: () => ["session=abc; Path=/; HttpOnly", "other=x; Path=/"] }), "session=abc; other=x");

console.log("inject-thread CLI: argument validation and exact-target transport helpers verified");
