import assert from "node:assert/strict";
import Fastify from "fastify";
import { createDesktopTickets, isDesktopClient, registerDesktopRoutes } from "../desktop.js";

const OWNER = "orch_session=owner";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0 Electron/44.5.1 Safari/537.36 GGODesktop/0.1.0";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0 Safari/537.36";
const THREAD = "61111111-1111-4111-8111-111111111111";

let clock = 1_000_000;
const kv = new Map<string, string>();
const tickets = createDesktopTickets(() => clock);
const app = Fastify();
registerDesktopRoutes(app, {
  isAuthed: (cookie) => !!cookie?.includes(OWNER),
  sessionCookie: () => "orch_session=fresh; HttpOnly; SameSite=Lax; Path=/; Max-Age=60",
  kv: { get: (key) => kv.get(key) ?? null, set: (key, value) => void kv.set(key, value) },
  tickets,
  now: () => clock,
});

assert.equal(isDesktopClient(DESKTOP_UA), true);
assert.equal(isDesktopClient(BROWSER_UA), false);
assert.equal(isDesktopClient(undefined), false);

// ---- tickets: only a signed-in, same-site console can mint one ----
assert.equal((await app.inject({ method: "POST", url: "/api/desktop/ticket" })).statusCode, 401);
assert.equal(
  (await app.inject({ method: "POST", url: "/api/desktop/ticket", headers: { cookie: OWNER, "sec-fetch-site": "cross-site" } })).statusCode,
  403,
  "another site cannot mint a sign-in ticket with the owner's cookie",
);
const minted = await app.inject({ method: "POST", url: "/api/desktop/ticket", headers: { cookie: OWNER, "sec-fetch-site": "same-origin" } });
assert.equal(minted.statusCode, 200);
const { ticket } = minted.json() as { ticket: string };
assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
assert.equal(minted.headers["cache-control"], "no-store");

// ---- redeeming signs the desktop window in once, then the ticket is spent ----
const redeemed = await app.inject({ url: `/api/desktop/redeem?ticket=${ticket}&thread=${THREAD}` });
assert.equal(redeemed.statusCode, 302);
assert.equal(redeemed.headers.location, `../../?thread=${THREAD}`, "relative, so a mounted console returns under its mount");
assert.match(String(redeemed.headers["set-cookie"]), /^orch_session=fresh/);
assert.equal(redeemed.headers["referrer-policy"], "no-referrer");
const replay = await app.inject({ url: `/api/desktop/redeem?ticket=${ticket}` });
assert.equal(replay.statusCode, 302);
assert.equal(replay.headers.location, "../../?e=desktop");
assert.equal(replay.headers["set-cookie"], undefined, "a spent ticket signs nobody in");

// An expired ticket is refused, and a malformed thread id is dropped rather than echoed.
const late = (await app.inject({ method: "POST", url: "/api/desktop/ticket", headers: { cookie: OWNER } })).json() as { ticket: string };
clock += 121_000;
const expired = await app.inject({ url: `/api/desktop/redeem?ticket=${late.ticket}` });
assert.equal(expired.headers.location, "../../?e=desktop");
const fresh = (await app.inject({ method: "POST", url: "/api/desktop/ticket", headers: { cookie: OWNER } })).json() as { ticket: string };
const odd = await app.inject({ url: `/api/desktop/redeem?ticket=${fresh.ticket}&thread=${encodeURIComponent("x\"><script>")}` });
assert.equal(odd.headers.location, "../../");
assert.match(String(odd.headers["set-cookie"]), /^orch_session=fresh/);
assert.equal((await app.inject({ url: "/api/desktop/redeem?ticket=short" })).headers.location, "../../?e=desktop");

// ---- the browser handoff after Google sign-in ----
const signedOut = await app.inject({ url: "/api/desktop/handoff" });
assert.equal(signedOut.statusCode, 302);
assert.equal(signedOut.headers.location, "../../");
const handoff = await app.inject({ url: "/api/desktop/handoff", headers: { cookie: OWNER } });
assert.equal(handoff.statusCode, 200);
assert.match(String(handoff.headers["content-type"]), /^text\/html/);
const link = /ggo:\/\/auth\?ticket=([A-Za-z0-9_-]{43})/.exec(handoff.body);
assert.ok(link, "the page links back into the desktop app with a fresh ticket");
assert.equal((await app.inject({ url: `/api/desktop/redeem?ticket=${link[1]}` })).headers.location, "../../");

// ---- presence: "Open in desktop" shows only where the app has run ----
const available = async (headers: Record<string, string>, remoteAddress?: string) =>
  ((await app.inject({ url: "/api/desktop/availability", headers: { cookie: OWNER, ...headers }, remoteAddress })).json() as { available: boolean }).available;

assert.equal((await app.inject({ url: "/api/desktop/availability" })).statusCode, 401);
assert.equal(await available({}), false, "nothing registered yet");
assert.equal((await app.inject({ method: "POST", url: "/api/desktop/presence", headers: { cookie: OWNER, "user-agent": BROWSER_UA } })).statusCode, 403, "a plain browser cannot claim to be the desktop app");
assert.equal((await app.inject({ method: "POST", url: "/api/desktop/presence", headers: { "user-agent": DESKTOP_UA } })).statusCode, 401);
assert.equal((await app.inject({ method: "POST", url: "/api/desktop/presence", headers: { cookie: OWNER, "user-agent": DESKTOP_UA } })).statusCode, 200);
assert.equal(await available({}), true, "a browser on the machine where the app ran sees the button");
assert.equal(await available({}, "192.0.2.5"), false, "another LAN machine has no ggo:// handler");

// The same app on a LAN machine registers that machine only.
await app.inject({ method: "POST", url: "/api/desktop/presence", headers: { cookie: OWNER, "user-agent": DESKTOP_UA }, remoteAddress: "192.0.2.7" });
assert.equal(await available({}, "192.0.2.7"), true);

// Through a remote link (a tunnel arrives from loopback) neither registration nor the button applies.
process.env.REMOTE_ACCESS = "1";
assert.equal(await available({ "x-forwarded-for": "203.0.113.9" }), false);
delete process.env.REMOTE_ACCESS;

// A registration not refreshed for 60 days is treated as uninstalled.
clock += 61 * 24 * 3600_000;
assert.equal(await available({}), false);

await app.close();
console.log("PASS: desktop tickets, browser handoff and presence");
