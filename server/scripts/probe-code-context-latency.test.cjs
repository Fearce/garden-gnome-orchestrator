const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  measureContexts,
  parseArgs,
  subjectsFromHello,
  summarizeProbe,
  timingSummary,
  usage,
} = require("./probe-code-context-latency.cjs");

assert.deepEqual(parseArgs([]), {
  url: "http://127.0.0.1:4317",
  limit: 100,
  routeBudgetMs: 5_000,
  timeoutMs: 120_000,
  json: false,
  help: false,
});
assert.deepEqual(
  parseArgs(["--url", "https://example.test/base/", "--limit", "40", "--route-budget-ms", "800", "--timeout-ms", "9000", "--json"]),
  { url: "https://example.test/base", limit: 40, routeBudgetMs: 800, timeoutMs: 9_000, json: true, help: false },
);
assert.throws(() => parseArgs(["--limit", "0"]), /integer from 1/);
assert.throws(() => parseArgs(["--url", "ftp://example.test"]), /http or https/);
assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
assert.match(usage(), /first navigation-ready frame/i);

const winWorkspace = ["C:", "Repo"].join("\\");
const winWorkspaceCaseVariant = ["c:", "repo"].join("/") + "/";
const hello = {
  threads: [
    { id: "t-1", title: "One", workspace: winWorkspace },
    { id: "t-2", title: "Two", workspace: winWorkspaceCaseVariant },
  ],
  supervisor: {
    events: [
      { threadId: "t-1", threadTitle: "One", workspace: winWorkspace },
      { threadId: "t-1", threadTitle: "One again", workspace: winWorkspace },
      { threadId: "t-2", threadTitle: "Two", workspace: winWorkspaceCaseVariant },
      { threadId: "gone", threadTitle: "Old task", workspace: winWorkspace },
      { threadId: null, workspace: null },
    ],
  },
};
const selected = subjectsFromHello(hello, 100);
assert.equal(selected.eventsScanned, 5);
assert.deepEqual(
  selected.subjects.map((subject) => subject.key),
  ["thread:t-1", "thread:t-2", `workspace:${winWorkspace}`],
  "the probe mirrors the panel and deduplicates repeated audit rows on the wire key",
);
assert.equal(subjectsFromHello(hello, 2).subjects.length, 1, "the visible-event limit applies before deduplication");

assert.deepEqual(timingSummary([1, 3, 2, 10]), { count: 4, p50Ms: 2, p90Ms: 10, maxMs: 10 });
const records = new Map([
  ["thread:t-1", { firstMs: 25, fullMs: 500, sawPending: true, firstContext: { ideWorkspaceId: "ide-1" } }],
  ["thread:t-2", { firstMs: 5_001, fullMs: 600, sawPending: true, firstContext: { ideWorkspaceId: "ide-1" } }],
  [`workspace:${winWorkspace}`, { firstMs: 20, fullMs: 550, firstContext: { error: "not a Git checkout" } }],
]);
const slow = summarizeProbe({ subjects: selected.subjects, eventsScanned: 5, records, routeBudgetMs: 5_000 });
assert.equal(slow.ok, false);
assert.equal(slow.routeOk, false);
assert.equal(slow.enrichmentOk, true);
assert.equal(
  slow.distinctWorkspaces,
  process.platform === "win32" ? 1 : 2,
  "workspace metrics follow the host filesystem's case sensitivity",
);
assert.deepEqual(slow.slowFirst.map((row) => row.key), ["thread:t-2"]);
assert.equal(slow.progressiveFrames, 2);

class FakeCodeContextSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
      this.deliver({
        type: "hello",
        threads: [
          { id: "t-1", title: "One", workspace: winWorkspace },
          { id: "t-2", title: "Two", workspace: winWorkspace },
        ],
        supervisor: { events: [
          { threadId: "t-1", workspace: winWorkspace },
          { threadId: "t-2", workspace: winWorkspace },
        ] },
      });
    });
  }

  send(raw) {
    const command = JSON.parse(raw);
    const key = `${command.kind}:${command.id}`;
    queueMicrotask(() => this.deliver({
      type: "code.context",
      key,
      context: { workspace: winWorkspace, ideWorkspaceId: "ide-repo", gitPending: true, error: null },
    }));
    queueMicrotask(() => this.deliver({
      type: "code.context",
      key,
      context: { workspace: winWorkspace, ideWorkspaceId: "ide-repo", gitPending: false, error: null },
    }));
  }

  deliver(event) {
    if (this.readyState === 1) this.emit("message", JSON.stringify(event));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}

(async () => {
  const measured = await measureContexts({
    url: "http://127.0.0.1:4317",
    cookie: "session=fake",
    routeBudgetMs: 1_000,
    timeoutMs: 100,
    WebSocketImpl: FakeCodeContextSocket,
  });
  assert.equal(measured.ok, true);
  assert.equal(measured.requests, 2);
  assert.equal(measured.distinctWorkspaces, 1);
  assert.equal(measured.first.count, 2);
  assert.equal(measured.full.count, 2);
  assert.equal(measured.progressiveFrames, 2, "both quick replies are observed before enrichment");
  assert.equal(measured.ideReadyOnFirstFrame, 2, "the first frame already carries the clickable IDE route");
  console.log("code-context latency probe: selection, timing verdict, and progressive wire flow verified");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
