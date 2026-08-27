// The relay's HTTP edge: who a request is attributed to, how often it may be wrong, and which surfaces
// the owner's credential unlocks. Half of this is pure (`access.ts`); the other half is the WIRING in
// `index.ts` — which guard sits on which route — so the second section boots the real server and talks
// to it over a socket. Free: no quota, no network beyond loopback, ~5s.
// Run: npx tsx src/access.test.ts   (or, from server/: npm run test:relay-access)

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  ADMIN_COOKIE,
  AdminSessions,
  JoinThrottle,
  SECURITY_HEADERS,
  clientIp,
  cookieValue,
  normalizeIp,
  sanitizeName,
  secretEquals,
} from "./access.js";

const HERE = join(fileURLToPath(import.meta.url), "..", "..");

// ---- clientIp: the header is client-supplied, and the join throttle is the only defence there is -----
{
  const PROXY = "172.18.0.4"; // a sibling on the docker network — what Caddy looks like to the relay

  assert.equal(clientIp(PROXY, "9.9.9.9", 1), "9.9.9.9", "one hop, one entry: today's Caddy, which REPLACES the header");

  assert.equal(
    clientIp(PROXY, "203.0.113.7, 9.9.9.9", 1),
    "9.9.9.9",
    "THE defect: a proxy that APPENDS leaves the caller's own value in front — reading it would hand anyone a fresh bucket per request",
  );
  assert.equal(clientIp(PROXY, ["203.0.113.7", "9.9.9.9"], 1), "9.9.9.9", "same when node splits the header into an array");

  assert.equal(clientIp("198.51.100.4", "10.0.0.1", 1), "198.51.100.4", "a PUBLIC peer reached us directly: its header means nothing");
  assert.equal(clientIp(PROXY, "not-an-address", 1), PROXY, "a non-address entry falls back rather than becoming a throttle key");
  assert.equal(clientIp(PROXY, "", 1), PROXY, "no header at all");
  assert.equal(clientIp(PROXY, undefined, 1), PROXY);
  assert.equal(clientIp(undefined, undefined, 1), "unknown", "a socket with no address still yields a key");

  assert.equal(clientIp(PROXY, "a, b, 1.1.1.1, 2.2.2.2", 2), "1.1.1.1", "two trusted hops counts two from the right");
  assert.equal(clientIp(PROXY, "1.1.1.1, 2.2.2.2", 9), "1.1.1.1", "more hops than entries stops at the leftmost");
  assert.equal(clientIp(PROXY, "9.9.9.9", 0), "9.9.9.9", "a nonsense hop count is clamped, never an out-of-range read");

  // One address must not be able to hold three budgets by dressing itself differently.
  assert.equal(normalizeIp("::ffff:9.9.9.9"), "9.9.9.9");
  assert.equal(normalizeIp("9.9.9.9:51234"), "9.9.9.9");
  assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normalizeIp("  2001:DB8::1  "), "2001:db8::1");
  assert.equal(normalizeIp("x".repeat(4000)).length, 45, "a huge header value can't become a huge map key");
}

// ---- JoinThrottle: the budget, and the memory bound --------------------------------------------------
{
  let now = 1_000_000;
  const t = new JoinThrottle(3, 8, () => now);

  assert.equal(t.limited("a"), false);
  t.record("a");
  t.record("a");
  assert.equal(t.limited("a"), false, "under the allowance");
  t.record("a");
  assert.equal(t.limited("a"), true, "at the allowance");
  assert.equal(t.limited("b"), false, "a different address has its own budget");

  now += 3600_001;
  assert.equal(t.limited("a"), false, "the window rolls");

  // The one structure an unauthenticated caller can grow. Lazy pruning kept an entry per address forever.
  const big = new JoinThrottle(10, 8, () => now);
  for (let i = 0; i < 5000; i++) big.record(`10.0.${i >> 8}.${i & 255}`);
  assert.ok(big.size() <= 8, `bounded under a flood of distinct addresses, got ${big.size()}`);

  // Expiry alone must clear it, without relying on the cap.
  const aging = new JoinThrottle(10, 1_000_000, () => now);
  for (let i = 0; i < 50; i++) aging.record(`10.1.0.${i}`);
  assert.equal(aging.size(), 50);
  now += 3600_001;
  aging.record("10.2.0.1");
  assert.equal(aging.size(), 1, "an hour later every stale key is gone, cap or no cap");
}

// ---- AdminSessions ----------------------------------------------------------------------------------
{
  let now = 5_000_000;
  const s = new AdminSessions(1000, 4, () => now);
  const id = s.mint();
  assert.ok(id.length >= 32, "a session id is a real secret, not a counter");
  assert.equal(s.valid(id), true);
  assert.equal(s.valid(""), false, "an absent cookie is never a session");
  assert.equal(s.valid("made-up"), false);
  assert.notEqual(s.mint(), id, "ids are unique");

  now += 1001;
  assert.equal(s.valid(id), false, "expired");

  const many = new AdminSessions(60_000, 4, () => now);
  for (let i = 0; i < 100; i++) many.mint();
  assert.ok(many.size() <= 4, `bounded, got ${many.size()}`);
}

// ---- cookies, secrets, names ------------------------------------------------------------------------
{
  assert.equal(cookieValue(`other=1; ${ADMIN_COOKIE}=abc; last=2`, ADMIN_COOKIE), "abc");
  assert.equal(cookieValue(`${ADMIN_COOKIE}=abc`, ADMIN_COOKIE), "abc");
  assert.equal(cookieValue("other=1", ADMIN_COOKIE), "");
  assert.equal(cookieValue(undefined, ADMIN_COOKIE), "");
  assert.equal(cookieValue(`${ADMIN_COOKIE}_other=nope`, ADMIN_COOKIE), "", "a prefix match is not a match");
  assert.equal(cookieValue(`${ADMIN_COOKIE}=%`, ADMIN_COOKIE), "", "a malformed cookie is just an invalid session, not a thrown URI error");

  assert.equal(secretEquals("abc", "abc"), true);
  assert.equal(secretEquals("abc", "abd"), false);
  assert.equal(secretEquals("abc", "abcd"), false, "different lengths never throw, just fail");
  assert.equal(secretEquals("", ""), false, "an unset secret must never authenticate anything");

  const forged = sanitizeName(`ok\n[relay] "attacker" joined (deadbeef) from 1.2.3.4`);
  assert.ok(!forged.includes("\n"), "a newline in a joining instance's name would forge container log lines");
  assert.equal(sanitizeName("  spaced   out  "), "spaced out");
  assert.equal(sanitizeName("x".repeat(200)).length, 40);
  assert.equal(sanitizeName("\0\x07"), "");
}

// ---- the live server: which guard actually sits on which route --------------------------------------

const JOIN_CODE = randomBytes(18).toString("base64url");
const ADMIN_TOKEN = randomBytes(18).toString("base64url");

function freePort(): Promise<number> {
  return new Promise((ok, no) => {
    const probe = createServer();
    probe.on("error", no);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => ok(port));
    });
  });
}

/** Boot the REAL entrypoint under tsx, exactly as `npm run dev` does. Resolves once it answers, or
 *  rejects with whatever it printed before dying — which is how the placeholder checks are asserted. */
function bootRelay(env: Record<string, string>, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "src", "index.ts")], {
    cwd: HERE,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  return new Promise((ok, no) => {
    let settled = false;
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        no(new Error(`relay exited ${code} before listening:\n${output}`));
      }
    });
    const deadline = Date.now() + 30_000;
    const poll = setInterval(() => {
      if (settled) return clearInterval(poll);
      fetch(`http://127.0.0.1:${port}/api/health`)
        .then(() => {
          settled = true;
          clearInterval(poll);
          ok(child);
        })
        .catch(() => {
          if (Date.now() < deadline) return;
          settled = true;
          clearInterval(poll);
          child.kill();
          no(new Error(`relay never answered on :${port}\n${output}`));
        });
    }, 200);
  });
}

const dataDir = await mkdtemp(join(tmpdir(), "relay-access-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const relay = await bootRelay({ JOIN_CODE, ADMIN_TOKEN, DATA_DIR: dataDir, OFFICE_NAME: "Gate Office" }, port);

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, redirect: "manual" });

/** Open a real WebSocket against the running relay. Rejects with the refusal — the upgrade answers a
 *  bare `401` line, which `ws` surfaces as "Unexpected server response: 401". */
function openSocket(p: number, headers: Record<string, string>, onMessage?: (data: Buffer) => void): Promise<WebSocket> {
  return new Promise((ok, no) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, { headers });
    // A welcome can share the first TCP read with the upgrade. Subscribe before `open` resolves so a
    // real immediate greeting is observed rather than turning this test into a scheduler race.
    if (onMessage) ws.on("message", onMessage);
    ws.once("open", () => ok(ws));
    ws.once("error", (e: Error) => no(e));
  });
}

try {
  // The public page is the whole question this gate exists for: it is served to anyone, so it must carry
  // counts and nothing else.
  {
    const r = await get("/");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Gate Office"), "the office names itself");
    assert.ok(!html.includes("Joined instances"), "no membership table");
    assert.ok(!html.includes("Rooms with traffic"), "no room list");
    assert.ok(html.includes("noindex"), "and it asks not to be indexed");

    for (const [h, v] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(r.headers.get(h), v, `${h} is set by the relay itself, not left to the reverse proxy`);
    }
    assert.ok(r.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), "not framable");
  }

  // Health answers "is it up" to anyone; how many devices have ever joined is a membership fact.
  {
    const anon = (await (await get("/api/health")).json()) as Record<string, unknown>;
    assert.equal(anon.ok, true);
    assert.equal(anon.members, undefined, "member COUNT is not public — the page deliberately withholds it");
    assert.equal(anon.uptimeSec, undefined, "the anonymous health response is exactly the same status data as the public page");
    assert.equal(anon.instancesOnline, 0);

    const owner = (await (await get("/api/health", { "x-admin-token": ADMIN_TOKEN })).json()) as Record<string, unknown>;
    assert.equal(owner.members, 0, "the owner sees it");
    assert.equal(typeof owner.uptimeSec, "number", "uptime stays available to the owner without making restarts public");
    const urlToken = (await (await get(`/api/health?key=${encodeURIComponent(ADMIN_TOKEN)}`)).json()) as Record<string, unknown>;
    assert.equal(urlToken.members, undefined, "an API query string must not unlock owner data");
  }

  // /admin and the member API.
  {
    assert.equal((await get("/admin")).status, 401);
    assert.equal((await get("/admin?key=wrong")).status, 401);
    const anon = await (await get("/admin")).text();
    assert.ok(!anon.includes("Joined instances"), "a refused /admin degrades to the PUBLIC page, not a partial owner view");

    assert.equal((await get("/api/members")).status, 401);
    assert.equal((await get("/api/members?key=wrong")).status, 401);
    assert.equal((await get(`/api/members?key=${encodeURIComponent(ADMIN_TOKEN)}`)).status, 401, "API reads never accept a logged URL token");
    assert.equal((await get("/api/members", { "x-admin-token": ADMIN_TOKEN })).status, 200);
    assert.equal((await get("/api/members", { authorization: `Bearer ${ADMIN_TOKEN}` })).status, 200);
  }

  // The key in the URL is traded for a cookie exactly once and redirected away.
  let cookie = "";
  {
    const r = await get(`/admin?key=${encodeURIComponent(ADMIN_TOKEN)}`);
    assert.equal(r.status, 303, "the key is not answered in place — it is redirected out of the address bar");
    assert.equal(r.headers.get("location"), "/admin");
    const setCookie = r.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("HttpOnly"), "script must not be able to read the owner session");
    assert.ok(setCookie.includes("Secure"), "and it must not travel in clear");
    assert.ok(setCookie.includes("SameSite=Strict"), "and never on a cross-site request");
    cookie = setCookie.split(";")[0]!;
    assert.ok(cookie.startsWith(`${ADMIN_COOKIE}=`));
    assert.ok(!cookie.includes(ADMIN_TOKEN), "the cookie is a session id, NOT the admin key itself");

    const page = await get("/admin", { cookie });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Joined instances"), "the cookie alone opens the owner view");

    const header = await get("/admin", { "x-admin-token": ADMIN_TOKEN });
    assert.equal(header.status, 200, "curl with the header is answered directly");
    assert.equal(header.headers.get("set-cookie"), null, "and is handed no session to keep");

    assert.equal((await get("/admin", { cookie: `${ADMIN_COOKIE}=forged` })).status, 401);
    assert.equal((await get("/admin", { cookie: `${ADMIN_COOKIE}=%` })).status, 401, "malformed cookies fail closed without an internal error");
  }

  // Revocation stays header-only, so introducing a cookie introduced no CSRF surface.
  {
    const viaCookie = await fetch(`${base}/api/members/whatever`, { method: "DELETE", headers: { cookie } });
    assert.equal(viaCookie.status, 401, "a session cookie must NOT be able to revoke a device");
    const viaUrl = await fetch(`${base}/api/members/whatever?key=${encodeURIComponent(ADMIN_TOKEN)}`, { method: "DELETE" });
    assert.equal(viaUrl.status, 401, "a mutation never accepts a logged URL token");
    const viaHeader = await fetch(`${base}/api/members/whatever`, {
      method: "DELETE",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    assert.equal(viaHeader.status, 404, "the documented header still works (404: no such member)");
  }

  const join = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/join`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  // The throttle, and the spoof it used to be defeated by. Every attempt varies only the LEFT-hand
  // X-Forwarded-For entry — the part a caller writes — so all of them must land in one bucket.
  {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await join({ code: "wrong", name: "probe" }, { "x-forwarded-for": `203.0.113.${i}, 9.9.9.9` });
      codes.push(r.status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401), "ten wrong codes are refused one at a time");
    assert.deepEqual(codes.slice(10), [429, 429], "the eleventh is throttled DESPITE a fresh spoofed address each time");

    // A genuinely different address, as the trusted hop would report it, still has its own budget.
    assert.equal((await join({ code: "wrong" }, { "x-forwarded-for": "203.0.113.1, 8.8.8.8" })).status, 401);
  }

  // The real code still works, and the token it mints is what opens the socket.
  let token = "";
  {
    const r = await join({ code: JOIN_CODE, name: "gate\nforged log line" }, { "x-forwarded-for": "1.1.1.1, 7.7.7.7" });
    assert.equal(r.status, 200);
    const answer = (await r.json()) as { token: string; instanceName: string };
    token = answer.token;
    assert.ok(token.length >= 32);
    assert.ok(!answer.instanceName.includes("\n"), "the instance name is sanitized before it reaches a log line");

    const owner = (await (await get("/api/members", { cookie })).json()) as { members: { name: string }[] };
    assert.equal(owner.members.length, 1);
  }

  // The socket refuses anything that isn't a live device token.
  {
    for (const [label, headers] of [
      ["no token", {}],
      ["a made-up token", { authorization: "Bearer nope" }],
      ["the JOIN CODE, which is not a device token", { authorization: `Bearer ${JOIN_CODE}` }],
    ] as const) {
      const refused = await openSocket(port, headers).then(
        (ws) => {
          ws.close();
          return null;
        },
        (e: Error) => e.message,
      );
      assert.ok(refused, `the WebSocket must refuse ${label}`);
      assert.ok(/401/.test(refused), `and say 401 so the console shows "re-join in Settings" (${label}): ${refused}`);
    }
  }

  // THE regression this section exists for: the HTTP timeouts above must not reach an established
  // socket. `requestTimeout` is 15s, the relay's own heartbeat is 30s, and a real office connection is
  // open for days — so hold one past the request timeout and prove it still answers.
  {
    const frames: string[] = [];
    const ws = await openSocket(
      port,
      { authorization: `Bearer ${token}`, "x-office-instance": "gate" },
      (d: Buffer) => frames.push((JSON.parse(String(d)) as { t: string }).t),
    );

    await new Promise((r) => setTimeout(r, 18_000));
    assert.equal(ws.readyState, ws.OPEN, "an established socket must survive requestTimeout — the office holds these for days");

    // The pong window opens only NOW: a timer started before the wait would expire during it and report
    // a dead socket that was merely un-asked.
    const pong = new Promise<boolean>((ok) => {
      ws.on("message", (d: Buffer) => {
        if ((JSON.parse(String(d)) as { t: string }).t === "pong") ok(true);
      });
      setTimeout(() => ok(false), 5_000).unref();
    });
    ws.send(JSON.stringify({ t: "ping" }));
    assert.equal(await pong, true, "and still be answering after it");
    assert.ok(frames.includes("welcome"), "the office greeted it on connect, as it does every real instance");
    ws.close();
  }

  // A body past the cap is refused, and the process survives it.
  {
    const huge = await fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(64 * 1024) }),
    }).catch(() => null);
    assert.ok(huge === null || huge.status !== 200, "an oversized body never authenticates");
    assert.equal((await get("/api/health")).status, 200, "and the relay is still serving afterwards");
  }

  assert.equal((await get("/nope")).status, 404);
} finally {
  relay.kill();
}

// ---- refusing to run an office anyone can walk into --------------------------------------------------
// `deploy.sh` seeds .env from .env.example on a fresh host. The example's old placeholder was 38 chars,
// so the length check waved it through and a first deploy started a working relay whose join code was a
// literal string in a public repository.
for (const [label, code] of [
  ["the placeholder that used to ship in .env.example", "change-me-to-something-long-and-random"],
  ["a hand-typed stand-in", "changeme"],
  ["an empty code", ""],
  ["a 19-character code", "a".repeat(19)],
  ["a short code", "abc"],
] as const) {
  const p = await freePort();
  const failed = await bootRelay({ JOIN_CODE: code, DATA_DIR: dataDir }, p).then(
    (child) => {
      child.kill();
      return null;
    },
    (e: Error) => e.message,
  );
  assert.ok(failed, `must refuse to boot with ${label}`);
  assert.ok(/JOIN_CODE/.test(failed), `and say why (${label}): ${failed.slice(0, 200)}`);
}

// The owner key protects membership and activity metadata. It is optional (an owner may deliberately
// disable the admin surface), but once configured it needs the same entropy floor as the join code.
{
  const p = await freePort();
  const failed = await bootRelay({ JOIN_CODE, ADMIN_TOKEN: "b".repeat(19), DATA_DIR: dataDir }, p).then(
    (child) => {
      child.kill();
      return null;
    },
    (e: Error) => e.message,
  );
  assert.ok(failed, "must refuse a short configured admin token");
  assert.ok(/ADMIN_TOKEN/.test(failed), `and say why: ${failed.slice(0, 200)}`);
}

await rm(dataDir, { recursive: true, force: true });
console.log("relay access: all assertions passed");
