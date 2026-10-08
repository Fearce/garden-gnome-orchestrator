import assert from "node:assert/strict";
import Fastify from "fastify";
import { CloudSessionService, githubRepository, routineId } from "../cloudSessions/service.js";
import { registerCloudSessionRoutes } from "../cloudSessions/routes.js";
import type { Db } from "../db/db.js";

const values = new Map<string, string>();
const store = { kvGet: (key: string) => values.get(key) ?? null, kvSet: (key: string, value: string) => { values.set(key, value); } };
const token = ["sk", "ant", "oat01", "fixture", "only"].join("-");
let calls = 0;
let mode = "ok";
let release: (() => void) | undefined;
const service = new CloudSessionService(store, (async (url, init) => {
  calls++;
  assert.equal(String(url), "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire");
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01");
  assert.ok(JSON.parse(String(init?.body)).text.includes("Fix unit test"));
  if (mode === "pending") await new Promise<void>(resolve => { release = resolve; });
  if (mode === "network") throw new Error(token);
  if (mode === "invalid") return new Response(JSON.stringify({ type: "routine_fire", claude_code_session_id: "../../evil", claude_code_session_url: "https://example.com/evil" }));
  if (mode === "unauthorized") return new Response(token, { status: 401 });
  if (mode === "server") return new Response(token, { status: 503 });
  return new Response(JSON.stringify({ type: "routine_fire", claude_code_session_id: "session_test", claude_code_session_url: "https://example.com/evil" }));
}) as typeof fetch);
for (const raw of ["http://api.anthropic.com/v1/claude_code/routines/trig_test/fire", "https://example.com/v1/claude_code/routines/trig_test/fire", "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire?key=bad", "trig_bad/../../", "https://api.anthropic.com@evil.example/v1/claude_code/routines/trig_test/fire"]) assert.throws(() => routineId(raw));
assert.equal(routineId("https://api.anthropic.com/v1/claude_code/routines/trig_test/fire"), "trig_test");
assert.equal(githubRepository("git@github.com:example/webapp.git\n"), "example/webapp");
assert.equal(githubRepository("https://github.com/example/webapp.git"), "example/webapp");
assert.equal(githubRepository("https://github.com.evil.example/example/webapp.git"), null);
const connection = service.save({ label: "Cloud A", repository: "example/webapp", routineId: "trig_test", token });
assert.ok(!JSON.stringify(service.snapshot()).includes(token));
service.save({ ...connection, label: "Renamed", token: "" });
assert.throws(() => service.save({ ...connection, routineId: "trig_other", token: "" }), /own token/);
const input = { connectionId: connection.id, title: "Fix unit test", prompt: "Fix unit test and open a PR", cloudReady: true };
await assert.rejects(service.submit({ ...input, cloudReady: false }), /Confirm/);
await assert.rejects(service.submit({ ...input, prompt: "x".repeat(60001) }), /maximum/);
assert.equal(calls, 0);
const accepted = await service.submit({ ...input, sourceThreadId: "source" });
assert.equal(accepted.url, "https://claude.ai/code/session_test");
assert.equal(accepted.state, "submitted");
await assert.rejects(service.submit({ ...input, sourceThreadId: "source" }), /already/);
for (const failure of ["network", "invalid", "unauthorized", "server"]) {
  mode = failure;
  await assert.rejects(service.submit(input));
  assert.equal(service.jobs()[0]?.state, failure === "unauthorized" ? "failed" : "uncertain");
  assert.ok(!JSON.stringify(service.snapshot()).includes(token), "upstream errors cannot expose routine tokens");
}
mode = "pending";
const pending = service.submit(input);
await assert.rejects(service.submit(input), /submitting/);
assert.throws(() => service.remove(connection.id), /Wait/);
release!();
await pending;
values.set("cloud_session_jobs_v1", JSON.stringify([{ ...accepted, state: "submitting" }]));
assert.equal(new CloudSessionService(store).jobs()[0]?.state, "uncertain", "restart never blindly retries a cloud job");

const app = Fastify();
let localState = "implementing";
const db = {
  getThread: () => ({ id: "source", state: localState, workspace: ".", homeWorkspace: null, modelRequest: null, subTask: null }),
  listRuns: () => [],
} as unknown as Pick<Db, "getThread" | "listRuns">;
registerCloudSessionRoutes(app, service, db, cookie => cookie === "session=test");
for (const [method, url, payload] of [["GET", "/api/cloud-sessions", undefined], ["PUT", "/api/cloud-sessions/connections", {}], ["POST", "/api/cloud-sessions/jobs", input], ["DELETE", `/api/cloud-sessions/connections/${connection.id}`, undefined]] as const) {
  const response = await app.inject({ method, url, payload });
  assert.equal(response.statusCode, 401, "all routes require GGO authentication");
}
const snapshot = await app.inject({ method: "GET", url: "/api/cloud-sessions", headers: { cookie: "session=test" } });
assert.equal(snapshot.statusCode, 200);
assert.equal(snapshot.headers["cache-control"], "no-store");
assert.ok(!snapshot.body.includes(token));
const running = await app.inject({ method: "POST", url: "/api/cloud-sessions/jobs", headers: { cookie: "session=test" }, payload: { ...input, sourceThreadId: "source" } });
assert.equal(running.statusCode, 409, "a running local task cannot be offloaded simultaneously");
localState = "paused";
const mismatch = await app.inject({ method: "POST", url: "/api/cloud-sessions/jobs", headers: { cookie: "session=test" }, payload: { ...input, sourceThreadId: "source" } });
assert.equal(mismatch.statusCode, 409, "a cloud routine for another repository cannot take this task");
await app.close();
console.log("Cloud sessions: URL/auth validation, secret redaction, dispatch, uncertainty, duplicate/restart protection and authenticated routes passed.");
