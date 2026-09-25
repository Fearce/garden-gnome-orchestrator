import assert from "node:assert/strict";
import Fastify from "fastify";
import { portalLink, registerPortalLink } from "../portalLink.js";

assert.deepEqual(portalLink({}), { enabled: false });
for (const url of ["javascript:alert(1)", "http://remote.example", "https://user:password@example.com", "not a URL"]) assert.deepEqual(portalLink({ GGO_PORTAL_URL: url }), { enabled: false });
assert.deepEqual(portalLink({ GGO_PORTAL_URL: "https://admin.example", GGO_PORTAL_LABEL: "My company" }), { enabled: true, url: "https://admin.example/", label: "My company", environment: "Personal GGO" });
const app = Fastify();
registerPortalLink(app, cookie => cookie === "private-test-session");
assert.equal((await app.inject({ url: "/api/portal" })).statusCode, 401);
assert.equal((await app.inject({ url: "/api/portal", headers: { cookie: "private-test-session" } })).statusCode, 200);
await app.close();
console.log("PASS: optional portal navigation, safe URLs and authenticated metadata");
