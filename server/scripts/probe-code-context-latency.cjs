#!/usr/bin/env node
// Measure the exact contextual-navigation fan-out rendered by the live Supervisor panel.
// Read-only: after authentication it sends only `code.context`, the same command each visible
// task/audit row sends when mounted.
//
//   npm run probe:code-context --prefix server
//   npm run probe:code-context --prefix server -- --json
//
// The first frame is the owner-facing latency: it ends "Locating this workspace..." and makes the
// folder/IDE route usable. Git enrichment may follow later. Report both separately so slow Git
// cannot hide whether navigation itself stayed interactive.

const WebSocket = require("ws");
const { login, passwordFromEnvOrDotenv, socketUrl } = require("./inject-thread.cjs");

const DEFAULT_URL = "http://127.0.0.1:4317";
const DEFAULT_LIMIT = 100;
const DEFAULT_ROUTE_BUDGET_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function usage(error) {
  return [
    error ? `error: ${error}` : null,
    "usage: node scripts/probe-code-context-latency.cjs [--url http://host:port] [--limit N] [--route-budget-ms N] [--timeout-ms N] [--json]",
    "",
    "Reads the live Supervisor snapshot, requests the same code contexts its rows render, and",
    "separately times the first navigation-ready frame and the later Git-enriched frame.",
  ].filter(Boolean).join("\n");
}

function positiveInteger(raw, flag, max = 300_000) {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${flag} must be an integer from 1 to ${max}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    limit: DEFAULT_LIMIT,
    routeBudgetMs: DEFAULT_ROUTE_BUDGET_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
    } else if (arg === "--limit") {
      options.limit = positiveInteger(argv[++i], "--limit", 1_000);
    } else if (arg === "--route-budget-ms") {
      options.routeBudgetMs = positiveInteger(argv[++i], "--route-budget-ms");
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(argv[++i], "--timeout-ms");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
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

const codeKey = (kind, id) => `${kind}:${id}`;
const workspaceKey = (workspace) => {
  const normalized = String(workspace ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/** Mirror SupervisorPanel's choice exactly: a still-listed task resolves by task id; an old audit
 * row whose task has left the board resolves by its recorded workspace. Duplicate rows share one
 * client request, so the probe deduplicates on the same wire key. */
function subjectsFromHello(hello, limit = DEFAULT_LIMIT) {
  const threads = Array.isArray(hello.threads) ? hello.threads : [];
  const events = Array.isArray(hello.supervisor?.events) ? hello.supervisor.events.slice(0, limit) : [];
  const byThread = new Map(threads.map((thread) => [thread.id, thread]));
  const byKey = new Map();

  for (const event of events) {
    const thread = event.threadId ? byThread.get(event.threadId) : null;
    let subject = null;
    if (thread) {
      subject = {
        kind: "thread",
        id: thread.id,
        workspace: thread.workspace ?? event.workspace ?? null,
        label: thread.title ?? event.threadTitle ?? thread.id,
      };
    } else if (event.workspace) {
      subject = {
        kind: "workspace",
        id: event.workspace,
        workspace: event.workspace,
        label: event.threadTitle ?? event.workspace,
      };
    }
    if (!subject) continue;
    subject.key = codeKey(subject.kind, subject.id);
    if (!byKey.has(subject.key)) byKey.set(subject.key, subject);
  }

  return { eventsScanned: events.length, subjects: [...byKey.values()] };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function timingSummary(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function summarizeProbe({ subjects, eventsScanned, records, routeBudgetMs, timedOut = false }) {
  const rows = subjects.map((subject) => ({ subject, ...(records.get(subject.key) ?? {}) }));
  const firstTimes = rows.flatMap((row) => Number.isFinite(row.firstMs) ? [row.firstMs] : []);
  const fullTimes = rows.flatMap((row) => Number.isFinite(row.fullMs) ? [row.fullMs] : []);
  const missingFirst = rows.filter((row) => !Number.isFinite(row.firstMs));
  const missingFull = rows.filter((row) => !Number.isFinite(row.fullMs));
  const slowFirst = rows
    .filter((row) => Number.isFinite(row.firstMs) && row.firstMs > routeBudgetMs)
    .map((row) => ({ key: row.subject.key, label: row.subject.label, ms: row.firstMs }));
  const firstErrors = rows.filter((row) => row.firstContext?.error).map((row) => ({
    key: row.subject.key,
    error: row.firstContext.error,
  }));
  const workspaces = new Set(subjects.map((subject) => workspaceKey(subject.workspace)).filter(Boolean));
  const routeOk = missingFirst.length === 0 && slowFirst.length === 0;
  const enrichmentOk = missingFull.length === 0;

  return {
    ok: routeOk && enrichmentOk,
    routeOk,
    enrichmentOk,
    timedOut,
    eventsScanned,
    requests: subjects.length,
    distinctWorkspaces: workspaces.size,
    first: timingSummary(firstTimes),
    full: timingSummary(fullTimes),
    progressiveFrames: rows.filter((row) => row.sawPending).length,
    ideReadyOnFirstFrame: rows.filter((row) => row.firstContext?.ideWorkspaceId).length,
    firstErrors,
    slowFirst,
    missingFirst: missingFirst.map((row) => row.subject.key),
    missingFull: missingFull.map((row) => row.subject.key),
    routeBudgetMs,
  };
}

function measureContexts({
  url,
  cookie,
  limit = DEFAULT_LIMIT,
  routeBudgetMs = DEFAULT_ROUTE_BUDGET_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  WebSocketImpl = WebSocket,
  now = Date.now,
}) {
  return new Promise((resolve, reject) => {
    const openedAt = now();
    const socket = new WebSocketImpl(socketUrl(url), { headers: { Cookie: cookie } });
    let settled = false;
    let helloSeen = false;
    let sentAt = null;
    let subjects = [];
    let eventsScanned = 0;
    let connectMs = null;
    let helloMs = null;
    const records = new Map();

    const finish = (error, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve({
        connectMs,
        helloMs,
        ...summarizeProbe({ subjects, eventsScanned, records, routeBudgetMs, timedOut }),
      });
    };

    const timer = setTimeout(() => {
      if (!helloSeen) return finish(new Error(`timed out after ${timeoutMs}ms waiting for the Supervisor snapshot`));
      finish(null, true);
    }, timeoutMs);

    socket.once("open", () => { connectMs = now() - openedAt; });
    socket.once("error", (error) => finish(new Error(`WebSocket failed: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) finish(new Error("WebSocket closed before every code context arrived"));
    });
    socket.on("message", (raw) => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }

      if (event.type === "hello" && !helloSeen) {
        helloSeen = true;
        helloMs = now() - openedAt;
        const selected = subjectsFromHello(event, limit);
        eventsScanned = selected.eventsScanned;
        subjects = selected.subjects;
        if (!subjects.length) {
          return finish(new Error("the live Supervisor snapshot has no workspace-bearing audit rows to probe"));
        }
        for (const subject of subjects) records.set(subject.key, {});
        sentAt = now();
        for (const subject of subjects) {
          socket.send(JSON.stringify({ type: "code.context", kind: subject.kind, id: subject.id }));
        }
        return;
      }

      if (event.type !== "code.context" || sentAt == null || !records.has(event.key)) return;
      const record = records.get(event.key);
      const elapsed = now() - sentAt;
      if (!Number.isFinite(record.firstMs)) {
        record.firstMs = elapsed;
        record.firstContext = event.context;
      }
      if (event.context?.gitPending === true) record.sawPending = true;
      else {
        record.fullMs = elapsed;
        record.fullContext = event.context;
      }
      if ([...records.values()].every((value) => Number.isFinite(value.fullMs))) finish(null);
    });
  });
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

async function runProbe(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const loginFn = dependencies.loginFn ?? login;
  const health = await timedHealth(options.url, options.timeoutMs, fetchImpl);
  const loginStarted = Date.now();
  const cookie = await loginFn(options.url, options.password);
  const loginMs = Date.now() - loginStarted;
  const result = await measureContexts({
    ...options,
    cookie,
    WebSocketImpl: dependencies.WebSocketImpl,
    now: dependencies.now,
  });
  return { url: options.url, health, loginMs, ...result };
}

const metric = (summary) => summary.count
  ? `p50=${summary.p50Ms}ms p90=${summary.p90Ms}ms max=${summary.maxMs}ms (${summary.count})`
  : "no replies";

function renderResult(result) {
  console.log("=== Code-context latency ===");
  console.log(`instance: ${result.url}`);
  console.log(`health: ${result.health.ms}ms${result.health.ok ? "" : ` (status ${result.health.status ?? "error"})`}`);
  console.log(`snapshot: ${result.eventsScanned} Supervisor events -> ${result.requests} requests across ${result.distinctWorkspaces} workspaces`);
  console.log(`navigation-ready first frame: ${metric(result.first)}`);
  console.log(`Git-enriched final frame:     ${metric(result.full)}`);
  console.log(`progressive replies: ${result.progressiveFrames}/${result.requests}; IDE ready on first frame: ${result.ideReadyOnFirstFrame}/${result.requests}`);
  if (result.firstErrors.length) console.log(`first-frame explanations: ${result.firstErrors.length}`);
  if (result.slowFirst.length) {
    console.log(`slow first frames over ${result.routeBudgetMs}ms:`);
    for (const row of result.slowFirst.slice(0, 20)) console.log(`  ${row.ms}ms  ${row.label} (${row.key})`);
  }
  if (result.missingFirst.length) console.log(`missing first frames: ${result.missingFirst.join(", ")}`);
  if (result.missingFull.length) console.log(`missing Git frames: ${result.missingFull.join(", ")}`);
  if (result.ok) {
    console.log(`verdict: PASS - every row left the locating state within ${result.routeBudgetMs}ms and Git enrichment completed`);
  } else if (!result.routeOk) {
    console.log(`verdict: FAIL - navigation stayed blocked past ${result.routeBudgetMs}ms`);
  } else {
    console.log("verdict: FAIL - navigation was ready, but Git enrichment did not complete");
  }
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
  const password = passwordFromEnvOrDotenv(env);
  if (!password) {
    console.error("error: AUTH_PASSWORD is not set (and server/.env has no AUTH_PASSWORD line)");
    return 2;
  }
  try {
    const result = await runProbe({ ...options, password });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else renderResult(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_ROUTE_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  measureContexts,
  parseArgs,
  runProbe,
  subjectsFromHello,
  summarizeProbe,
  timingSummary,
  usage,
};

if (require.main === module) main().then((code) => { process.exitCode = code; });
