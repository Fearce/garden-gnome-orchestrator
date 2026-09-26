// Gate for scripts/remote-access.cjs: the public link must never open, or stay open, unlocked.
const assert = require("node:assert/strict");
const {
  readiness,
  parseTailscaleStatus,
  parseFunnelStatus,
  runCommand,
  FUNNEL_OFF_ARGS,
} = require("./remote-access.cjs");

const READY_ENV = {
  REMOTE_ACCESS: "1",
  GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret",
  ALLOWED_EMAIL: "owner@gmail.com",
  SESSION_SECRET: "x".repeat(48),
  PUBLIC_ORIGIN: "https://pc.tail1234.ts.net",
};
const DNS = "pc.tail1234.ts.net";
const URL_ = `https://${DNS}`;

// ---- readiness: Google sign-in and an owner address are the lock; nothing opens without them ----
{
  const r = readiness({}, URL_);
  assert.equal(r.ready, false);
  assert.match(r.blockers.join("\n"), /GOOGLE_CLIENT_ID/);
  assert.match(r.blockers.join("\n"), /ALLOWED_EMAIL/);
}
assert.equal(readiness({ ...READY_ENV, ALLOWED_EMAIL: "you@example.com" }, URL_).ready, false, "the placeholder owner is not an owner");
assert.equal(readiness({ ...READY_ENV, REMOTE_ACCESS: "" }, URL_).ready, false, "the server lock must be switched on first");
assert.deepEqual(readiness(READY_ENV, URL_), { ready: true, blockers: [], warnings: [] });
{
  const r = readiness({ ...READY_ENV, PUBLIC_ORIGIN: "", SESSION_SECRET: "" }, URL_);
  assert.equal(r.ready, true, "pinning the origin and a dedicated secret are advice, not the lock");
  assert.match(r.warnings.join("\n"), /PUBLIC_ORIGIN=https:\/\/pc\.tail1234\.ts\.net/);
  assert.match(r.warnings.join("\n"), /SESSION_SECRET/);
}

// ---- parsing the tailscale CLI's JSON ----
assert.deepEqual(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.` } })), { state: "Running", dnsName: DNS });
assert.deepEqual(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } })), { state: "NeedsLogin", dnsName: null });
assert.deepEqual(parseTailscaleStatus("not json"), { state: "Unknown", dnsName: null });
const funnelOn = JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } },
  AllowFunnel: { [`${DNS}:443`]: true },
});
assert.deepEqual(parseFunnelStatus(funnelOn, 4317), { public: true, url: URL_ });
assert.deepEqual(parseFunnelStatus("{}", 4317), { public: false, url: null });
assert.deepEqual(
  parseFunnelStatus(JSON.stringify({ Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } }, AllowFunnel: { [`${DNS}:443`]: true } }), 4317),
  { public: false, url: null },
  "a funnel to some other app is not GGO's link",
);

// ---- the command flow, against a fake tailscale and a fake network ----
function harness({ env = READY_ENV, state = "Running", funnel = "{}", probe = "locked" } = {}) {
  const calls = [];
  let funnelJson = funnel;
  const tailscale = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return { status: 0, stdout: JSON.stringify({ BackendState: state, Self: { DNSName: state === "Running" ? `${DNS}.` : "" } }) };
    if (args.join(" ") === "funnel status --json") return { status: 0, stdout: funnelJson };
    if (args[0] === "funnel" && args.includes("--bg")) { funnelJson = funnelOn; return { status: 0, stdout: "" }; }
    if (args.join(" ") === FUNNEL_OFF_ARGS.join(" ")) { funnelJson = "{}"; return { status: 0, stdout: "" }; }
    return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (probe === "down") throw new Error("ECONNREFUSED");
    if (path === "/api/me") return { status: 200, json: async () => ({ authed: false, required: true, google: true, password: probe === "password-offered" }) };
    return { status: probe === "open" ? 200 : 401, json: async () => ({}) };
  };
  const lines = [];
  return { calls, lines, deps: { env, port: 4317, tailscale, fetchImpl, log: (l) => lines.push(l) } };
}

(async () => {
  {
    const h = harness({ env: {} });
    assert.equal(await runCommand("on", h.deps), 2);
    assert.ok(!h.calls.some((c) => c.includes("--bg")), "must not open the link before Google sign-in is configured");
  }
  {
    const h = harness({ state: "NeedsLogin" });
    assert.equal(await runCommand("on", h.deps), 2);
    assert.match(h.lines.join("\n"), /tailscale up/);
    assert.ok(!h.calls.some((c) => c.includes("--bg")));
  }
  {
    const h = harness();
    assert.equal(await runCommand("on", h.deps), 0);
    assert.ok(h.calls.includes("funnel --bg http://127.0.0.1:4317"), h.calls.join("\n"));
    assert.match(h.lines.join("\n"), /https:\/\/pc\.tail1234\.ts\.net/);
  }
  for (const probe of ["open", "password-offered"]) {
    const h = harness({ probe });
    assert.equal(await runCommand("on", h.deps), 1, `${probe}: an unlocked link is a failure`);
    assert.ok(h.calls.includes(FUNNEL_OFF_ARGS.join(" ")), `${probe}: an unlocked link is closed again at once`);
  }
  {
    // Status on an open link that turns out unlocked (e.g. an old server build) reports it; only `on` reverts.
    const h = harness({ funnel: funnelOn, probe: "open" });
    assert.equal(await runCommand("status", h.deps), 1);
    assert.match(h.lines.join("\n"), /NOT locked/);
  }
  {
    const h = harness({ funnel: funnelOn });
    assert.equal(await runCommand("status", h.deps), 0);
    assert.match(h.lines.join("\n"), /locked/);
  }
  {
    const h = harness();
    assert.equal(await runCommand("status", h.deps), 0, "a closed link is a healthy state");
    assert.match(h.lines.join("\n"), /off/i);
  }
  {
    const h = harness({ funnel: funnelOn });
    assert.equal(await runCommand("off", h.deps), 0);
    assert.ok(h.calls.includes(FUNNEL_OFF_ARGS.join(" ")));
  }
  {
    // --when-live waits for the RUNNING server to have Google sign-in (a restart onto the new .env),
    // polling the direct local /api/me, and only then opens the link.
    const h = harness();
    const localAnswers = [false, false, true];
    const publicFetch = h.deps.fetchImpl;
    h.deps.fetchImpl = async (url, init) =>
      url.startsWith("http://127.0.0.1:4317/")
        ? { status: 200, json: async () => ({ google: localAnswers.shift() ?? true }) }
        : publicFetch(url, init);
    let slept = 0;
    h.deps.sleep = async () => { slept += 1; };
    h.deps.waitDeadlineMs = 60_000;
    assert.equal(await runCommand("on", { ...h.deps, whenLive: true }), 0);
    assert.equal(slept, 2, "polled until the running server loaded Google sign-in");
    assert.ok(h.calls.includes("funnel --bg http://127.0.0.1:4317"));
  }
  {
    const h = harness();
    h.deps.fetchImpl = async () => ({ status: 200, json: async () => ({ google: false }) });
    let now = 0;
    h.deps.now = () => now;
    h.deps.sleep = async (ms) => { now += ms; };
    h.deps.waitDeadlineMs = 90_000;
    assert.equal(await runCommand("on", { ...h.deps, whenLive: true }), 1, "gave up waiting");
    assert.ok(!h.calls.some((c) => c.includes("--bg")), "never opens against a server without Google sign-in");
    assert.match(h.lines.join("\n"), /never/);
  }
  {
    const h = harness();
    h.deps.tailscale = null;
    assert.equal(await runCommand("status", h.deps), 2);
    assert.match(h.lines.join("\n"), /winget install/);
  }
  console.log("PASS: remote-access opens only a locked link, and closes it if the lock fails");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
