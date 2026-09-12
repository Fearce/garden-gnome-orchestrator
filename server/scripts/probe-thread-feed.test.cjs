const assert = require("node:assert/strict");
const { parseArgs, resolveTarget, usage } = require("./probe-thread-feed.cjs");

assert.deepEqual(parseArgs([]), { url: "http://127.0.0.1:4317" }, "defaults to the local instance, no target pin");
assert.deepEqual(
  parseArgs(["--thread", "abc-123", "--url", "https://example.test/base/"]),
  { thread: "abc-123", url: "https://example.test/base" },
  "trims a trailing slash off --url",
);
assert.deepEqual(parseArgs(["--title", "warming up"]), { url: "http://127.0.0.1:4317", title: "warming up" });
assert.throws(() => parseArgs(["--thread", "x", "--title", "y"]), /not both/);
assert.throws(() => parseArgs(["--url", "not-a-url"]), /absolute http/);
assert.throws(() => parseArgs(["--url", "ftp://example.test"]), /http or https/);
assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);

const threads = [
  { id: "a", title: "Fix the login page", updatedAt: 100 },
  { id: "b", title: "Investigate warming up placeholder", updatedAt: 300 },
  { id: "c", title: "Old warming up report", updatedAt: 200 },
];
assert.equal(resolveTarget(threads, {}).id, "b", "no filter picks the most recently updated task");
assert.equal(resolveTarget(threads, { thread: "a" }).id, "a", "an id match wins outright");
assert.throws(() => resolveTarget(threads, { thread: "zzz" }), /no task exists with id/);
assert.equal(resolveTarget(threads, { title: "WARMING" }).id, "b", "title match is case-insensitive and picks the most recent of the matches");
assert.throws(() => resolveTarget(threads, { title: "nope" }), /no task title contains/);
assert.throws(() => resolveTarget([], {}), /no tasks to probe/);

assert.match(usage(), /--thread <uuid>/);
assert.match(usage("bad flag"), /error: bad flag/);

console.log("probe-thread-feed: argument validation and target resolution verified");
