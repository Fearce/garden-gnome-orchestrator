import assert from "node:assert/strict";
import Fastify from "fastify";
import { isDirectLocal, isTunneled, loginOptions, registerRemoteGate, remoteCookieAttributes } from "../remoteAccess.js";

// A tunnel daemon (Tailscale Funnel/Serve, cloudflared) connects from loopback and names the real
// client in forwarding headers. A local child process connects from loopback and names nobody.
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
  for (const url of ["/api/me", "/api/auth/google", "/api/auth/callback", "/api/logout", "/api/login", "/api/health", "/api/deploy/status", "/api/update/status", "/ws"]) {
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

  for (const url of ["/api/me", "/api/auth/google", "/api/auth/callback?code=x&state=y", "/api/logout", "/assets/index-abc.js", "/"]) {
    assert.equal((await hit(url)).statusCode, 200, `${url} must load before sign-in`);
  }
  for (const url of ["/api/health", "/api/deploy/status", "/api/update/status", "/ws", "/api/not-a-route"]) {
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

console.log("PASS: tunnelled requests are Google-only, gated, and never treated as local");
