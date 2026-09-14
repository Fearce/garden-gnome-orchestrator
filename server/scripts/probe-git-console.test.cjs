// Gate for probe-git-console.cjs. A probe is only worth running if it DETECTS the failure it claims to
// watch for, so every scenario below is a defect the probe must catch, not just a happy path it must
// survive (same discipline as db-size.test.cjs and probe-hot-paths' checker gate).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  DEFAULT_FAIL_MS,
  DEFAULT_SLOW_MS,
  DEFAULT_TIMEOUT_MS,
  NOT_A_REPO,
  changeCounts,
  chooseRepo,
  firstChangedFile,
  parseArgs,
  runProbe,
  slowLegs,
  usage,
} = require("./probe-git-console.cjs");

const SELF = "C:\\repos\\garden-gnome-orchestrator";
const OTHER = "C:\\repos\\with space\\sidekick";

function repoRef(path, extra = {}) {
  return { path, name: path.split("\\").pop(), taskCount: 1, activeCount: 0, isSelf: false, discovered: false, ...extra };
}

function repoState(path, extra = {}) {
  return {
    path,
    name: path.split("\\").pop(),
    isRepo: true,
    error: null,
    branch: "master",
    detached: false,
    branches: [],
    remoteBranches: [],
    remotes: [],
    upstreamRef: "origin/master",
    pushRef: "origin/master",
    ahead: 1,
    behind: 0,
    isCommitOnly: false,
    pushState: "ahead",
    files: [
      { path: "server/src/a.ts", status: "modified", added: 3, removed: 1, binary: false },
      { path: "server/src/new.ts", status: "untracked", added: 9, removed: 0, binary: false },
    ],
    staged: ["server/src/a.ts"],
    unstaged: ["server/src/new.ts"],
    commits: [],
    lastFetchAt: null,
    webUrl: null,
    busy: [],
    ...extra,
  };
}

class FakeConsoleServer {
  constructor(overrides = {}) {
    this.sockets = new Set();
    this.repos = overrides.repos ?? [repoRef(SELF, { isSelf: true }), repoRef(OTHER, { discovered: true })];
    this.warmRepos = overrides.warmRepos ?? null;
    this.preferred = overrides.preferred ?? null;
    this.echoThread = overrides.echoThread; // undefined = echo faithfully
    this.state = overrides.state ?? ((path) => repoState(path));
    this.diff = overrides.diff ?? ((file) => ({ path: file, binary: false, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false }));
    this.invalid = overrides.invalid ?? { isRepo: false, error: `not a git repository: ${NOT_A_REPO}` };
    this.delayMs = overrides.delayMs ?? {};
    this.listCalls = 0;
  }

  connect(socket) {
    this.sockets.add(socket);
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.emit("open");
      socket.deliver({ type: "hello", threads: [] }, 0);
    });
  }

  receive(socket, command) {
    if (command.type === "repo.list") {
      this.listCalls += 1;
      const repos = this.listCalls > 1 && this.warmRepos ? this.warmRepos : this.repos;
      socket.deliver(
        {
          type: "repo.list",
          repos,
          preferred: this.preferred,
          forThread: this.echoThread === undefined ? command.forThread ?? null : this.echoThread,
        },
        this.delayMs.list ?? 0,
      );
      return;
    }
    if (command.type === "repo.state") {
      const state = command.path === NOT_A_REPO ? { ...repoState(command.path), ...this.invalid } : this.state(command.path);
      socket.deliver({ type: "repo.state", path: command.path, state }, this.delayMs.state ?? 0);
      return;
    }
    if (command.type === "repo.diff") {
      socket.deliver(
        { type: "repo.diff", path: command.path, file: command.file, commit: null, diff: this.diff(command.file) },
        this.delayMs.diff ?? 0,
      );
    }
  }
}

function fakeWebSocket(server) {
  return class FakeWebSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.readyState = 0;
      server.connect(this);
    }

    send(raw) {
      server.receive(this, JSON.parse(raw));
    }

    deliver(event, delayMs = 0) {
      const payload = JSON.stringify(event);
      const emit = () => { if (this.readyState === this.OPEN) this.emit("message", payload); };
      if (delayMs > 0) setTimeout(emit, delayMs);
      else queueMicrotask(emit);
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      server.sockets.delete(this);
      this.emit("close");
    }
  };
}

function options(extra = {}) {
  return {
    url: "http://127.0.0.1:4317",
    thread: null,
    repo: null,
    timeoutMs: 500,
    slowMs: 1_000,
    failMs: 10_000,
    json: false,
    help: false,
    password: "not-used-by-the-fake",
    ...extra,
  };
}

function dependencies(server) {
  return {
    WebSocketImpl: fakeWebSocket(server),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    loginFn: async () => "session=fake",
  };
}

// ---- pure helpers -------------------------------------------------------------------------------

assert.deepEqual(parseArgs([]), {
  url: "http://127.0.0.1:4317",
  thread: null,
  repo: null,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  slowMs: DEFAULT_SLOW_MS,
  failMs: DEFAULT_FAIL_MS,
  json: false,
  help: false,
});
assert.deepEqual(parseArgs(["--json", "--thread", "abc", "--repo", OTHER, "--slow-ms", "250", "--fail-ms", "900", "--url", "https://example.test/base/"]), {
  url: "https://example.test/base",
  thread: "abc",
  repo: OTHER,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  slowMs: 250,
  failMs: 900,
  json: true,
  help: false,
});
assert.throws(() => parseArgs(["--slow-ms", "0"]), /integer from 1/);
assert.throws(() => parseArgs(["--url", "ftp://example.test"]), /http or https/);
assert.throws(() => parseArgs(["--thread"]), /--thread requires/);
assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
assert.match(usage(), /Read-only/);

assert.deepEqual(chooseRepo([repoRef(SELF, { isSelf: true })], "C:\\pref", "C:\\explicit"), { path: "C:\\explicit", why: "requested" });
assert.deepEqual(chooseRepo([repoRef(SELF, { isSelf: true })], "C:\\pref", null), { path: "C:\\pref", why: "server preferred" });
assert.deepEqual(chooseRepo([repoRef(OTHER), repoRef(SELF, { isSelf: true })], null, null), { path: SELF, why: "orchestrator checkout" });
assert.deepEqual(chooseRepo([repoRef(OTHER)], null, null), { path: OTHER, why: "first listed" });
assert.equal(chooseRepo([], null, null), null);

assert.deepEqual(changeCounts(repoState(SELF)), { files: 2, staged: 1, unstaged: 1, untracked: 1 });
assert.deepEqual(changeCounts({}), { files: 0, staged: 0, unstaged: 0, untracked: 0 });
assert.equal(firstChangedFile(repoState(SELF)), "server/src/a.ts");
assert.equal(firstChangedFile(repoState(SELF, { files: [] })), null);
assert.deepEqual(slowLegs({ timings: { openListMs: 4, stateMs: 80, note: "ignored" } }, 50), [{ name: "stateMs", ms: 80 }]);

// ---- live-shaped scenarios ----------------------------------------------------------------------

(async () => {
  const healthy = await runProbe(options(), dependencies(new FakeConsoleServer()));
  assert.equal(healthy.ok, true, healthy.error ?? healthy.defects.join("; "));
  assert.deepEqual(healthy.defects, []);
  for (const leg of ["loginMs", "connectMs", "helloMs", "openListMs", "stateMs", "diffMs", "warmListMs", "invalidStateMs"]) {
    assert.equal(typeof healthy.timings[leg], "number", `${leg} is measured`);
  }
  assert.equal(healthy.picker.repos, 2);
  assert.equal(healthy.picker.discovered, 1);
  assert.equal(healthy.repo.path, SELF, "with no preference it lands on the orchestrator's own checkout");
  assert.equal(healthy.repo.why, "orchestrator checkout");
  assert.deepEqual(healthy.repo.changes, { files: 2, staged: 1, unstaged: 1, untracked: 1 });
  assert.equal(healthy.diff.file, "server/src/a.ts");
  assert.ok(healthy.diff.patchChars > 0);
  assert.equal(healthy.invalid.isRepo, false);
  assert.match(healthy.invalid.error, /not a git repository/);

  // A focused open must land on the server's preferred repo and see its forThread echoed back.
  const focusedServer = new FakeConsoleServer({ preferred: OTHER });
  const focused = await runProbe(options({ thread: "task-1" }), dependencies(focusedServer));
  assert.equal(focused.ok, true, focused.error ?? focused.defects.join("; "));
  assert.equal(focused.picker.forThread, "task-1");
  assert.equal(focused.repo.path, OTHER, "a path with a space is opened as given");
  assert.equal(focused.repo.why, "server preferred");

  // The discard trap: a reply whose forThread does not match the request in flight.
  const mismatched = await runProbe(options({ thread: "task-1" }), dependencies(new FakeConsoleServer({ echoThread: null })));
  assert.equal(mismatched.ok, false, "a dropped forThread echo is a defect");
  assert.match(mismatched.defects.join("; "), /echoed forThread=null.*discards/);

  // An empty picker is the owner-visible "cannot open repositories".
  const empty = await runProbe(options(), dependencies(new FakeConsoleServer({ repos: [] })));
  assert.equal(empty.ok, false);
  assert.match(empty.defects.join("; "), /no repositories/);

  // A listed repo the server then refuses to open.
  const brokenRepo = await runProbe(
    options(),
    dependencies(new FakeConsoleServer({ state: (path) => repoState(path, { isRepo: false, error: "fatal: not a git repository" }) })),
  );
  assert.equal(brokenRepo.ok, false);
  assert.match(brokenRepo.defects.join("; "), /is not a repository.*cannot open/);

  // Changes that never render: a changed file whose diff comes back empty.
  const emptyDiff = await runProbe(
    options(),
    dependencies(new FakeConsoleServer({ diff: (file) => ({ path: file, binary: false, patch: "", truncated: false }) })),
  );
  assert.equal(emptyDiff.ok, false);
  assert.match(emptyDiff.defects.join("; "), /empty patch/);

  // A clean tree has no diff to fetch, and that is a PASS, not a missing leg.
  const clean = await runProbe(options(), dependencies(new FakeConsoleServer({ state: (path) => repoState(path, { files: [], staged: [], unstaged: [] }) })));
  assert.equal(clean.ok, true, clean.error ?? clean.defects.join("; "));
  assert.equal(clean.diff.skipped, "clean working tree");
  assert.equal(clean.timings.diffMs, undefined);

  // Both halves of the invalid-path contract.
  const badPathAccepted = await runProbe(options(), dependencies(new FakeConsoleServer({ invalid: { isRepo: true, error: null } })));
  assert.equal(badPathAccepted.ok, false);
  assert.match(badPathAccepted.defects.join("; "), /claimed .*is a repository/);
  const badPathSilent = await runProbe(options(), dependencies(new FakeConsoleServer({ invalid: { isRepo: false, error: null } })));
  assert.equal(badPathSilent.ok, false);
  assert.match(badPathSilent.defects.join("; "), /no error text/);

  // The regression this probe was built for: a picker that answers, but far too slowly.
  const stalled = await runProbe(options({ failMs: 10, slowMs: 5 }), dependencies(new FakeConsoleServer({ delayMs: { list: 60 } })));
  assert.equal(stalled.ok, false, "a picker slower than --fail-ms fails the probe");
  assert.ok(stalled.tooSlow.some((leg) => leg.name === "openListMs"), "the slow leg is named");
  assert.deepEqual(stalled.defects, [], "slowness is a timing verdict, not a structural defect");

  // A reply that never arrives at all is an error, not a silent pass.
  const silent = await runProbe(options({ timeoutMs: 40 }), dependencies(new FakeConsoleServer({ delayMs: { list: 400 } })));
  assert.equal(silent.ok, false);
  assert.match(silent.error, /timed out.*repo\.list \(console open\)/);

  // Background discovery is reported as a delta rather than mistaken for a changed picker.
  const warming = new FakeConsoleServer({ warmRepos: [repoRef(SELF, { isSelf: true }), repoRef(OTHER, { discovered: true }), repoRef("C:\\repos\\third", { discovered: true })] });
  const warmed = await runProbe(options(), dependencies(warming));
  assert.equal(warmed.ok, true, warmed.error ?? warmed.defects.join("; "));
  assert.deepEqual(warmed.warm, { repos: 3, added: 1 });

  console.log("git-console probe: arguments, picker/state/diff timings, and every failure it claims to catch verified");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
