import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerBrowserOriginGuard } from "../crossSite.js";
import {
  isDirectLocal,
  isLoopbackHost,
  isTunneled,
  loginOptions,
  registerLocalAutoSignIn,
  registerRemoteGate,
  remoteAccessEnabled,
  remoteCookieAttributes,
} from "../remoteAccess.js";

// A tunnel daemon (Tailscale Funnel/Serve, cloudflared) connects from loopback and names the real
// client in forwarding headers. A local child process connects from loopback and names nobody.
// Off by default: an install that never opted in treats a proxied request exactly as before.
const proxied = { ip: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } };
delete process.env.REMOTE_ACCESS;
assert.equal(remoteAccessEnabled(), false);
assert.equal(isTunneled(proxied), false, "no tunnel rules without REMOTE_ACCESS=1");
assert.equal(isDirectLocal(proxied), true, "loopback stays local, as before");
assert.deepEqual(loginOptions(proxied, { google: false, password: false }), { required: false, google: false, password: false });
assert.equal(remoteCookieAttributes(proxied), "");
{
  const app = Fastify();
  registerRemoteGate(app, { googleEnabled: () => false, isAuthed: () => false });
  app.get("/api/health", async () => ({ ok: true }));
  assert.equal((await app.inject({ url: "/api/health", headers: proxied.headers })).statusCode, 200, "the gate is inert");
  await app.close();
}
process.env.REMOTE_ACCESS = "1";

const local = { ip: "127.0.0.1", headers: {} };
const funnel = { ip: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", host: "pc.tail1234.ts.net" } };
const lan = { ip: "192.168.1.20", headers: {} };

assert.equal(isTunneled(local), false);
assert.equal(isTunneled(funnel), true);
assert.equal(isTunneled({ ip: "::ffff:127.0.0.1", headers: { forwarded: "for=203.0.113.9;proto=https" } }), true);
assert.equal(isTunneled({ ip: "::1", headers: { "tailscale-funnel-request": "?1" } }), true);
assert.equal(isTunneled(lan), false, "a direct LAN client keeps its existing login rules");

// The deploy/restart coordination endpoints trust a direct local caller only; a tunnel is not local.
assert.equal(isDirectLocal(local), true);
assert.equal(isDirectLocal(funnel), false);
assert.equal(isDirectLocal(lan), false);

// Through a tunnel the console is Google-only, even when a password is configured.
assert.deepEqual(loginOptions(funnel, { google: true, password: true }), { required: true, google: true, password: false });
assert.deepEqual(loginOptions(funnel, { google: false, password: false }), { required: true, google: false, password: false });
assert.deepEqual(loginOptions(local, { google: true, password: true }), { required: true, google: true, password: true });
assert.deepEqual(loginOptions(local, { google: false, password: false }), { required: false, google: false, password: false });

assert.equal(remoteCookieAttributes(funnel), "; Secure");
assert.equal(remoteCookieAttributes({ ip: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "http" } }), "");
assert.equal(remoteCookieAttributes(local), "", "local HTTP and HTTPS listeners share one cookie jar; never mark it Secure");

async function gatedApp(google: boolean) {
  const app = Fastify();
  registerRemoteGate(app, { googleEnabled: () => google, isAuthed: (cookie) => cookie === "orch_session=owner" });
  for (const url of ["/api/me", "/api/auth/google", "/api/auth/callback", "/api/logout", "/api/login", "/api/health", "/api/deploy/status", "/api/update/status", "/ws", "/api/desktop/redeem", "/api/desktop/ticket"]) {
    app.route({ method: ["GET", "POST"], url, handler: async () => ({ route: url }) });
  }
  app.get("/*", async () => "spa asset");
  app.setNotFoundHandler(async (_req, reply) => reply.code(200).send("spa shell"));
  await app.ready();
  return app;
}

const tunnelHeaders = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
{
  const app = await gatedApp(true);
  const hit = (url: string, extra: Record<string, string> = {}, method: "GET" | "POST" = "GET") =>
    app.inject({ method, url, headers: { ...tunnelHeaders, ...extra } });

  for (const url of ["/api/me", "/api/auth/google", "/api/auth/callback?code=x&state=y", "/api/logout", "/api/desktop/redeem?ticket=x", "/assets/index-abc.js", "/"]) {
    assert.equal((await hit(url)).statusCode, 200, `${url} must load before sign-in`);
  }
  for (const url of ["/api/health", "/api/deploy/status", "/api/update/status", "/ws", "/api/desktop/ticket", "/api/not-a-route"]) {
    assert.equal((await hit(url)).statusCode, 401, `${url} must need sign-in through the tunnel`);
  }
  assert.equal((await hit("/api/login", {}, "POST")).statusCode, 401, "no remote password guessing");
  assert.equal((await hit("/api/deploy/status", { cookie: "orch_session=owner" })).statusCode, 200);

  // Percent-encoding and duplicate slashes must not route around the gate.
  for (const url of ["/%61pi/deploy/status", "/api/deploy/status/", "/api//deploy/status"]) {
    const res = await hit(url);
    assert.ok(res.statusCode === 401 || res.body === "spa shell", `${url} leaked ${res.statusCode} ${res.body}`);
  }

  // Direct local traffic is untouched by the gate.
  assert.equal((await app.inject({ url: "/api/deploy/status" })).statusCode, 200);
  await app.close();
}
{
  const app = await gatedApp(false);
  for (const url of ["/", "/api/me", "/api/auth/google"]) {
    const res = await app.inject({ url, headers: tunnelHeaders });
    assert.equal(res.statusCode, 403, `${url}: a tunnel without Google sign-in must fail closed`);
  }
  assert.equal((await app.inject({ url: "/api/deploy/status", headers: { ...tunnelHeaders, cookie: "orch_session=owner" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/me" })).statusCode, 200);
  await app.close();
}

// ---- Remote link on: the owner at this PC is signed in automatically on localhost; nobody else is ----
assert.equal(isLoopbackHost("localhost:4317"), true);
assert.equal(isLoopbackHost("127.0.0.1:4317"), true);
assert.equal(isLoopbackHost("[::1]:4317"), true);
assert.equal(isLoopbackHost("localhost"), true);
assert.equal(isLoopbackHost("evil.example:4317"), false, "a DNS-rebinding page names its own host");
assert.equal(isLoopbackHost("localhost.evil.example"), false);
assert.equal(isLoopbackHost("127.999.999.999"), false, "a numeric-looking hostname is not necessarily a loopback IP");
assert.equal(isLoopbackHost(undefined), false);

async function trustedApp(enabled: boolean) {
  const app = Fastify();
  registerLocalAutoSignIn(app, {
    enabled: () => enabled,
    isAuthed: (cookie) => /orch_session=minted/.test(cookie ?? ""),
    sessionCookie: () => "orch_session=minted; HttpOnly; SameSite=Lax; Path=/",
  });
  app.get("/api/me", async (req) => ({ authed: /orch_session=minted/.test(req.headers.cookie ?? "") }));
  await app.ready();
  return app;
}
{
  const app = await trustedApp(true);
  const local = await app.inject({ url: "/api/me", headers: { host: "localhost:4317", cookie: "theme=dark" } });
  assert.deepEqual(local.json(), { authed: true }, "a direct local visit is signed in for this request");
  assert.match(String(local.headers["set-cookie"]), /orch_session=minted/, "and keeps the session for the WebSocket");

  const rebound = await app.inject({ url: "/api/me", headers: { host: "evil.example:4317" } });
  assert.deepEqual(rebound.json(), { authed: false }, "a page on another host that resolves to 127.0.0.1 gets nothing");
  const tunnelled = await app.inject({ url: "/api/me", headers: { host: "localhost:4317", "x-forwarded-for": "203.0.113.9" } });
  assert.deepEqual(tunnelled.json(), { authed: false }, "the public link is never trusted as local");
  process.env.REMOTE_ACCESS = "0";
  const proxiedOff = await app.inject({ url: "/api/me", headers: { host: "localhost:4317", "x-forwarded-for": "203.0.113.9" } });
  assert.deepEqual(proxiedOff.json(), { authed: false }, "nor any proxy when the remote link is off");
  process.env.REMOTE_ACCESS = "1";
  const lan = await app.inject({ url: "/api/me", remoteAddress: "192.168.1.20", headers: { host: "localhost:4317" } });
  assert.deepEqual(lan.json(), { authed: false }, "another machine on the LAN is not local");
  const already = await app.inject({ url: "/api/me", headers: { host: "localhost:4317", cookie: "orch_session=minted" } });
  assert.equal(already.headers["set-cookie"], undefined, "no new cookie when the session is already valid");
  await app.close();
}
{
  const app = await trustedApp(false);
  const off = await app.inject({ url: "/api/me", headers: { host: "localhost:4317" } });
  assert.deepEqual(off.json(), { authed: false }, "off unless the owner opts in");
  await app.close();
}

// A browser on another site must not receive the session minted for direct localhost,
// use it for an API write, or open the main read/write WebSocket with it.
{
  const app = Fastify();
  registerBrowserOriginGuard(app);
  registerLocalAutoSignIn(app, {
    enabled: () => true,
    isAuthed: (cookie) => /orch_session=minted/.test(cookie ?? ""),
    sessionCookie: () => "orch_session=minted; HttpOnly; SameSite=Lax; Path=/",
  });
  let writes = 0;
  app.post("/api/update/apply", async () => ({ writes: ++writes }));
  app.get("/api/me", async () => ({ ok: true }));
  app.get("/api/auth/callback", async () => ({ ok: true }));
  app.get("/ws", async () => ({ ok: true }));
  await app.ready();
  const host = { host: "localhost:4317" };
  const cross = await app.inject({ method: "POST", url: "/api/update/apply", headers: { ...host, "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.headers["set-cookie"], undefined, "cross-site requests never mint a session");
  assert.equal(writes, 0);
  assert.equal((await app.inject({ url: "/api/me", headers: { ...host, "sec-fetch-site": "cross-site" } })).statusCode, 403, "API reads also reject another site");
  assert.equal((await app.inject({ method: "POST", url: "/api/update/apply", headers: { ...host, origin: "https://evil.example" } })).statusCode, 403, "Origin fallback covers clients without Fetch Metadata");
  assert.equal((await app.inject({ method: "POST", url: "/api/update/apply", headers: { ...host, "sec-fetch-site": "same-origin" } })).statusCode, 200, "console writes still work");
  assert.equal(writes, 1);
  assert.equal((await app.inject({ url: "/ws", headers: { ...host, origin: "https://evil.example" } })).statusCode, 403, "WebSocket upgrade checks Origin");
  assert.equal((await app.inject({ url: "/ws", headers: { ...host, origin: "null" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/ws", headers: { ...host, origin: "http://localhost:3940" } })).statusCode, 200, "the local Deck may proxy from another loopback port");
  assert.equal((await app.inject({ url: "/ws", headers: { ...host, origin: "http://localhost:4317" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/ws", headers: { host: "127.0.0.1:4317", "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "owner.example", origin: "https://owner.example" } })).statusCode, 200, "the public same-origin proxy remains usable");
  assert.equal((await app.inject({ url: "/ws", headers: { host: "127.0.0.1:4317", "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "owner.example", origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/auth/callback", headers: { ...host, "sec-fetch-site": "cross-site" } })).statusCode, 200, "Google's callback must remain reachable");
  await app.close();
}

{
  const app = Fastify();
  registerBrowserOriginGuard(app, () => false);
  app.get("/", async () => "console");
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/ws", async () => "snapshot");
  await app.ready();
  for (const url of ["/", "/api/health", "/ws"]) {
    const rebound = await app.inject({ url, headers: { host: "evil.example", origin: "http://evil.example", "sec-fetch-site": "same-origin" } });
    assert.equal(rebound.statusCode, 403, `${url}: unauthenticated loopback must resist DNS rebinding`);
    assert.equal((await app.inject({ url, headers: { host: "127.0.0.1:4317" } })).statusCode, 200);
  }
  await app.close();
}

console.log("PASS: tunnelled requests are Google-only, gated, and never treated as local");
