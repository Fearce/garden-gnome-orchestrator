import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerConsoleMount, rewriteConsoleUrl } from "../webMount.js";
import { registerRemoteGate } from "../remoteAccess.js";

const app = Fastify({rewriteUrl:rewriteConsoleUrl});
registerConsoleMount(app);
app.get("/api/example", async (req, reply) => {
  if (req.headers.authorization !== "fixture") return reply.code(401).send({error:"unauthorized"});
  return {url:req.url};
});
app.get("/redirect", async (_, reply) => reply.redirect("/?e=forbidden"));
app.get("/external", async (_, reply) => reply.redirect("https://example.test/login"));
try {
  const canonical = await app.inject("/orchestrator?x=1");
  assert.equal(canonical.statusCode,308);
  assert.equal(canonical.headers.location,"/orchestrator/?x=1");
  for (const prefix of ["", "/orchestrator"]) {
    assert.equal((await app.inject(prefix+"/api/example")).statusCode,401,"same auth guard at both mounts");
    const result = await app.inject({url:prefix+"/api/example?x=1",headers:{authorization:"fixture"}});
    assert.equal(result.statusCode,200);
    assert.deepEqual(result.json(),{url:"/api/example?x=1"});
    assert.equal((await app.inject(prefix+"/redirect")).headers.location,prefix+"/?e=forbidden");
    assert.equal((await app.inject(prefix+"/external")).headers.location,"https://example.test/login");
  }
  assert.equal((await app.inject("/orchestrator-other/api/example")).statusCode,404);
  assert.equal(rewriteConsoleUrl({url:"/api/example?next=/orchestrator/"}),"/api/example?next=/orchestrator/");
  console.log("Native console mount passed: canonical URL, query strings, auth and redirects.");
} finally { await app.close(); }

// The opt-in remote gate must see the rewritten route and still protect it. The bare mount is
// only a redirect to the public sign-in shell; it must not strand signed-out visitors on a 401.
const originalRemoteAccess = process.env.REMOTE_ACCESS;
process.env.REMOTE_ACCESS = "1";
const tunneled = Fastify({ rewriteUrl: rewriteConsoleUrl });
registerRemoteGate(tunneled, { googleEnabled: () => true, isAuthed: cookie => cookie === "fixture=owner" });
registerConsoleMount(tunneled);
tunneled.get("/api/example", async () => ({ ok: true }));
tunneled.get("/api/me", async () => ({ required: true }));
tunneled.get("/*", async () => "sign-in shell");
try {
  const headers = { "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" };
  assert.equal((await tunneled.inject({ url: "/orchestrator", headers })).statusCode, 308);
  assert.equal((await tunneled.inject({ url: "/orchestrator/", headers })).statusCode, 200);
  assert.equal((await tunneled.inject({ url: "/orchestrator/api/me", headers })).statusCode, 200);
  assert.equal((await tunneled.inject({ url: "/orchestrator/api/example", headers })).statusCode, 401);
  assert.equal((await tunneled.inject({ url: "/orchestrator/api/example", headers: { ...headers, cookie: "fixture=owner" } })).statusCode, 200);
  console.log("Native mount preserves the opt-in remote gate and sign-in entry point.");
} finally {
  await tunneled.close();
  if (originalRemoteAccess === undefined) delete process.env.REMOTE_ACCESS;
  else process.env.REMOTE_ACCESS = originalRemoteAccess;
}
