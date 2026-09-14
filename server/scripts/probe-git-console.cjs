#!/usr/bin/env node
// Time the Git console's own round trips against a RUNNING instance, the way the owner experiences
// them: click the GitHub button (repo.list), land on a repo (repo.state), open a file's changes
// (repo.diff), and get an honest error for a path that is not a repository.
//
// It exists because "I cannot open repositories and cannot see changes" had no measurement behind it.
// The 2026-09-14 regression was a repo.list that resolved up to 80 historical task workspaces through
// git before replying, which on Windows stalled the picker for tens of seconds (and under load failed
// the page with net::ERR_NO_BUFFER_SPACE). Nothing in the sweep could see that: /api/health answers in
// 1ms while the picker hangs, and the unit gates all run against fixtures. This probe measures the
// legs directly, so the next report of a slow or empty picker is one command, not a browser session.
//
// Every command it sends is a READ (repo.list / repo.state / repo.diff). It never mutates a repo, so
// it is safe against production and needs no --confirm:
//   npm run probe:git-console --prefix server
//   npm run probe:git-console --prefix server -- --thread <task-id>   # the focused open a task does
//   npm run probe:git-console --prefix server -- --repo "C:\\path\\to\\repo" --json
// From server/, `node scripts/probe-git-console.cjs` is equivalent.

const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { login, passwordFromEnvOrDotenv, socketUrl } = require("./inject-thread.cjs");

const DEFAULT_URL = "http://127.0.0.1:4317";
// The reported stall was tens of seconds. Stay well above it so a slow leg is RECORDED rather than
// timing out just before the evidence arrives.
const DEFAULT_TIMEOUT_MS = 60_000;
/** Reported as a slow leg. The console is a control path, so a second is already visible. */
const DEFAULT_SLOW_MS = 1_000;
/** Fails the probe. A leg this slow is the reported regression, not a busy box. */
const DEFAULT_FAIL_MS = 10_000;
/** A path that cannot be a repository, for the invalid-path leg. Never created, never written. */
const NOT_A_REPO = path.join(os.tmpdir(), "__gg_git_console_probe_not_a_repo__");

function usage(error) {
  return [
    error ? `error: ${error}` : null,
    "usage: node scripts/probe-git-console.cjs [--url http://host:port] [--thread <id>] [--repo <path>]",
    "                                          [--timeout-ms N] [--slow-ms N] [--fail-ms N] [--json]",
    "",
    "Times the Git console's read path on a running instance: the picker's repo.list, a repo.state,",
    "the first changed file's repo.diff, a warm second repo.list, and the error a non-repository path",
    "returns. Read-only: it sends no repo.action and changes nothing.",
  ].filter(Boolean).join("\n");
}

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 1 || value > 600_000) {
    throw new Error(`${flag} must be an integer from 1 to 600000`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    thread: null,
    repo: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    slowMs: DEFAULT_SLOW_MS,
    failMs: DEFAULT_FAIL_MS,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--url") {
      const value = argv[++i];
      if (!value) throw new Error("--url requires a value");
      options.url = value;
    } else if (arg === "--thread") {
      const value = argv[++i];
      if (!value || value.length > 100) throw new Error("--thread requires a task id of at most 100 characters");
      options.thread = value;
    } else if (arg === "--repo") {
      const value = argv[++i];
      if (!value || value.length > 600) throw new Error("--repo requires a path of at most 600 characters");
      options.repo = value;
    } else if (arg === "--timeout-ms") options.timeoutMs = positiveInteger(argv[++i], "--timeout-ms");
    else if (arg === "--slow-ms") options.slowMs = positiveInteger(argv[++i], "--slow-ms");
    else if (arg === "--fail-ms") options.failMs = positiveInteger(argv[++i], "--fail-ms");
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  let parsed;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new Error("--url must be an absolute http(s) URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("--url must use http or https");
  options.url = parsed.toString().replace(/\/$/, "");
  return options;
}

class EventSocket {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.waiters = new Set();
    socket.on("message", (raw) => this.accept(raw));
    socket.on("error", (error) => this.rejectAll(new Error(`WebSocket failed: ${error.message}`)));
    socket.on("close", () => this.rejectAll(new Error("WebSocket closed before the expected reply")));
  }

  accept(raw) {
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  rejectAll(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out after ${this.timeoutMs}ms waiting for ${label}`));
      }, this.timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Send one command and time the matching reply: the unit every leg below is measured in. */
  async round(command, predicate, label) {
    const reply = this.waitFor(predicate, label);
    const started = Date.now();
    if (this.socket.readyState !== WebSocket.OPEN && this.socket.readyState !== this.socket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.socket.send(JSON.stringify(command));
    return { event: await reply, ms: Date.now() - started };
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

async function openEventSocket({ url, cookie, timeoutMs, WebSocketImpl = WebSocket }) {
  const started = Date.now();
  const socket = new WebSocketImpl(socketUrl(url), { headers: { Cookie: cookie } });
  const channel = new EventSocket(socket, timeoutMs);
  const helloReply = channel.waitFor((event) => event.type === "hello", "initial hello");
  let connectMs;
  const opened = new Promise((resolve, reject) => {
    socket.once("open", () => {
      connectMs = Date.now() - started;
      resolve();
    });
    socket.once("error", (error) => reject(new Error(`WebSocket connection failed: ${error.message}`)));
  });
  try {
    const [, hello] = await Promise.all([opened, helloReply]);
    return { channel, hello, connectMs, helloMs: Date.now() - started };
  } catch (error) {
    channel.close();
    throw error;
  }
}

/** Which repository the console would land on: an explicit pick, else the server's own preference for
 *  the focused task, else the orchestrator's checkout, else whatever the picker listed first. */
function chooseRepo(repos, preferred, explicit) {
  if (explicit) return { path: explicit, why: "requested" };
  if (preferred) return { path: preferred, why: "server preferred" };
  const self = repos.find((repo) => repo.isSelf);
  if (self) return { path: self.path, why: "orchestrator checkout" };
  if (repos[0]) return { path: repos[0].path, why: "first listed" };
  return null;
}

/** The staged / unstaged / untracked split the drawer shows, from one repo.state reply. */
function changeCounts(state) {
  const files = Array.isArray(state.files) ? state.files : [];
  return {
    files: files.length,
    staged: Array.isArray(state.staged) ? state.staged.length : 0,
    unstaged: Array.isArray(state.unstaged) ? state.unstaged.length : 0,
    untracked: files.filter((file) => file.status === "untracked").length,
  };
}

/** The first file whose diff the drawer would fetch, or null on a clean tree. */
function firstChangedFile(state) {
  const files = Array.isArray(state.files) ? state.files : [];
  const file = files.find((entry) => entry && typeof entry.path === "string" && entry.path.length > 0);
  return file ? file.path : null;
}

async function measureOpen(channel, options, result) {
  const forThread = options.thread ?? null;
  const listed = await channel.round(
    { type: "repo.list", rescan: false, ...(options.thread ? { forThread: options.thread } : {}) },
    (event) => event.type === "repo.list",
    "repo.list (console open)",
  );
  result.timings.openListMs = listed.ms;
  const repos = Array.isArray(listed.event.repos) ? listed.event.repos : [];
  result.picker = {
    repos: repos.length,
    discovered: repos.filter((repo) => repo.discovered).length,
    preferred: listed.event.preferred ?? null,
    forThread: listed.event.forThread ?? null,
  };
  // The console DISCARDS a reply whose forThread does not match the request in flight, so a server
  // that fails to echo it leaves the picker empty however fast it answered.
  if (result.picker.forThread !== forThread) {
    result.defects.push(
      `repo.list echoed forThread=${JSON.stringify(result.picker.forThread)} for a request of ${JSON.stringify(forThread)}, which the console discards`,
    );
  }
  if (repos.length === 0) result.defects.push("repo.list returned no repositories, so the picker would be empty");
  return repos;
}

async function measureRepo(channel, options, result, repos) {
  const chosen = chooseRepo(repos, result.picker.preferred, options.repo);
  if (!chosen) {
    result.defects.push("no repository to inspect: the picker listed none and none was given with --repo");
    return;
  }
  result.repo = { path: chosen.path, why: chosen.why };

  const state = await channel.round(
    { type: "repo.state", path: chosen.path },
    (event) => event.type === "repo.state" && event.path === chosen.path,
    "repo.state (open a repository)",
  );
  result.timings.stateMs = state.ms;
  const dto = state.event.state ?? {};
  result.repo.isRepo = dto.isRepo === true;
  result.repo.branch = dto.branch ?? null;
  result.repo.ahead = dto.ahead ?? 0;
  result.repo.behind = dto.behind ?? 0;
  result.repo.error = dto.error ?? null;
  result.repo.changes = changeCounts(dto);
  if (!result.repo.isRepo) {
    result.defects.push(
      `repo.state says ${chosen.path} is not a repository${dto.error ? ` (${dto.error})` : ""}, so the console offered a repo it cannot open`,
    );
    return;
  }

  const file = firstChangedFile(dto);
  if (!file) {
    result.diff = { file: null, skipped: "clean working tree" };
    return;
  }
  const diff = await channel.round(
    { type: "repo.diff", path: chosen.path, file },
    (event) => event.type === "repo.diff" && event.path === chosen.path && event.file === file,
    "repo.diff (open a file's changes)",
  );
  result.timings.diffMs = diff.ms;
  const patch = diff.event.diff ?? {};
  result.diff = {
    file,
    binary: patch.binary === true,
    truncated: patch.truncated === true,
    patchChars: typeof patch.patch === "string" ? patch.patch.length : 0,
  };
  if (!result.diff.binary && result.diff.patchChars === 0) {
    result.defects.push(`repo.diff returned an empty patch for the changed file ${file}, so the drawer would show nothing`);
  }
}

/** The second open. A cold list plus background discovery is the design, so this is where the full
 *  picker must have arrived, and it must still answer fast. */
async function measureWarmOpen(channel, options, result) {
  const warm = await channel.round(
    { type: "repo.list", rescan: false, ...(options.thread ? { forThread: options.thread } : {}) },
    (event) => event.type === "repo.list",
    "repo.list (warm re-open)",
  );
  result.timings.warmListMs = warm.ms;
  const repos = Array.isArray(warm.event.repos) ? warm.event.repos : [];
  result.warm = { repos: repos.length, added: repos.length - result.picker.repos };
}

/** A path that is not a repository must come back quickly, saying so, with something the owner can act
 *  on: the brief's "clear actionable error", asserted on the live server rather than a fixture. */
async function measureInvalidPath(channel, result) {
  const invalid = await channel.round(
    { type: "repo.state", path: NOT_A_REPO },
    (event) => event.type === "repo.state" && event.path === NOT_A_REPO,
    "repo.state (path that is not a repository)",
  );
  result.timings.invalidStateMs = invalid.ms;
  const dto = invalid.event.state ?? {};
  result.invalid = { isRepo: dto.isRepo === true, error: dto.error ?? null };
  if (result.invalid.isRepo) result.defects.push(`repo.state claimed ${NOT_A_REPO} is a repository`);
  else if (!result.invalid.error) {
    result.defects.push("repo.state refused a non-repository path with no error text, so the console has nothing to show");
  }
}

async function timedHealth(url, timeoutMs, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: error.message };
  }
}

function slowLegs(result, thresholdMs) {
  return Object.entries(result.timings)
    .filter(([, value]) => typeof value === "number" && value >= thresholdMs)
    .map(([name, ms]) => ({ name, ms }));
}

async function runProbe(options, dependencies = {}) {
  const result = {
    ok: false,
    url: options.url,
    thread: options.thread ?? null,
    timings: {},
    picker: { repos: 0, discovered: 0, preferred: null, forThread: null },
    repo: null,
    diff: null,
    warm: null,
    invalid: null,
    defects: [],
    error: null,
  };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const loginFn = dependencies.loginFn ?? login;
  const WebSocketImpl = dependencies.WebSocketImpl ?? WebSocket;
  result.health = await timedHealth(options.url, options.timeoutMs, fetchImpl);

  let channel;
  try {
    const loginStarted = Date.now();
    const cookie = await loginFn(options.url, options.password);
    result.timings.loginMs = Date.now() - loginStarted;

    const opened = await openEventSocket({ url: options.url, cookie, timeoutMs: options.timeoutMs, WebSocketImpl });
    channel = opened.channel;
    result.timings.connectMs = opened.connectMs;
    result.timings.helloMs = opened.helloMs;

    const repos = await measureOpen(channel, options, result);
    await measureRepo(channel, options, result, repos);
    await measureWarmOpen(channel, options, result);
    await measureInvalidPath(channel, result);
  } catch (error) {
    result.error = error.message;
  } finally {
    channel?.close();
  }

  result.slow = slowLegs(result, options.slowMs);
  result.tooSlow = slowLegs(result, options.failMs);
  result.ok = !result.error && result.defects.length === 0 && result.tooSlow.length === 0;
  return result;
}

function renderResult(result, options) {
  console.log("=== Git console latency ===");
  console.log(`instance: ${result.url}${result.thread ? ` (focused task ${result.thread})` : ""}`);
  console.log(`health: ${result.health.ms}ms${result.health.ok ? "" : ` (status ${result.health.status ?? "error"})`}`);
  for (const [leg, label] of [
    ["loginMs", "login"],
    ["connectMs", "ws connect"],
    ["helloMs", "hello"],
    ["openListMs", "repo.list (open)"],
    ["stateMs", "repo.state"],
    ["diffMs", "repo.diff"],
    ["warmListMs", "repo.list (warm)"],
    ["invalidStateMs", "repo.state (invalid path)"],
  ]) {
    if (result.timings[leg] != null) console.log(`${label}: ${result.timings[leg]}ms`);
  }
  console.log(
    `picker: ${result.picker.repos} repo(s), ${result.picker.discovered} from disk discovery, preferred ${result.picker.preferred ?? "none"}`,
  );
  if (result.warm) {
    console.log(`warm re-open: ${result.warm.repos} repo(s)${result.warm.added > 0 ? ` (+${result.warm.added} after background discovery)` : ""}`);
  }
  if (result.repo) {
    console.log(`repo: ${result.repo.path} (${result.repo.why})`);
    if (result.repo.isRepo) {
      console.log(`  branch ${result.repo.branch ?? "detached"} - ahead ${result.repo.ahead} - behind ${result.repo.behind}`);
      const c = result.repo.changes;
      if (c) console.log(`  changes: ${c.files} file(s): ${c.staged} staged, ${c.unstaged} unstaged, ${c.untracked} untracked`);
    } else {
      console.log(`  NOT a repository${result.repo.error ? `: ${result.repo.error}` : ""}`);
    }
  }
  if (result.diff) {
    console.log(
      result.diff.skipped
        ? `diff: skipped (${result.diff.skipped})`
        : `diff: ${result.diff.file}, ${result.diff.patchChars} chars${result.diff.truncated ? " (truncated)" : ""}${result.diff.binary ? " (binary)" : ""}`,
    );
  }
  if (result.invalid) {
    console.log(`invalid path: ${result.invalid.isRepo ? "REPORTED AS A REPO" : `refused, "${result.invalid.error ?? "(no message)"}"`}`);
  }
  if (result.slow.length) {
    console.log(`slow legs >=${options.slowMs}ms: ${result.slow.map((leg) => `${leg.name}=${leg.ms}ms`).join(", ")}`);
  }
  for (const defect of result.defects) console.log(`defect: ${defect}`);
  if (result.ok) console.log("verdict: PASS - the console opens, reads a repository, and refuses a bad path");
  else if (result.error) console.log(`verdict: FAIL - ${result.error}`);
  else if (result.tooSlow.length) {
    console.log(`verdict: FAIL - ${result.tooSlow.map((leg) => `${leg.name}=${leg.ms}ms`).join(", ")} exceeded --fail-ms ${options.failMs}`);
  } else console.log(`verdict: FAIL - ${result.defects.length} defect(s) above`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(usage(error.message));
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  // A blank AUTH_PASSWORD is not automatically a stop: an instance with no auth configured at all is
  // open on localhost and `login` returns an empty cookie for it. Let the server decide, and report
  // its refusal, rather than refusing here on a box where the console needs no password.
  const result = await runProbe({ ...options, password: passwordFromEnvOrDotenv(env) });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else renderResult(result, options);
  return result.ok ? 0 : 1;
}

module.exports = {
  DEFAULT_FAIL_MS,
  DEFAULT_SLOW_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  EventSocket,
  NOT_A_REPO,
  changeCounts,
  chooseRepo,
  firstChangedFile,
  openEventSocket,
  parseArgs,
  renderResult,
  runProbe,
  slowLegs,
  usage,
};

if (require.main === module) main().then((code) => { process.exitCode = code; });
