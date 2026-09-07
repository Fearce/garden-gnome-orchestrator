import assert from "node:assert/strict";

Object.assign(globalThis, {
  document: { baseURI: "http://127.0.0.1:4317/orchestrator/" },
});

const { coordinatedRestartPending } = await import("../src/lib/restartStatus.js");

const calls: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(response: { ok: boolean; body?: unknown } | Error): void {
  Object.assign(globalThis, {
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return {
        ok: response.ok,
        json: async () => response.body,
      };
    },
  });
}

mockFetch({ ok: true, body: { pending: { requesters: [{ commit: "81025f3" }] } } });
assert.equal(await coordinatedRestartPending(), true, "a pending coordinator row must hold the reload");
assert.equal(calls.at(-1)?.url, "/orchestrator/api/deploy/status", "the helper must respect a mounted app path");
assert.equal(calls.at(-1)?.init?.cache, "no-store", "deploy status must not be cached");

mockFetch({ ok: true, body: { pending: null } });
assert.equal(await coordinatedRestartPending(), false, "no pending restart means the version watcher may reload");

mockFetch({ ok: false });
assert.equal(await coordinatedRestartPending(), false, "a non-OK status must not strand an available client reload");

mockFetch(new Error("offline"));
assert.equal(await coordinatedRestartPending(), false, "a transient deploy-status failure must not throw out of the watcher");

console.log("Version-watch gate passed — deploy-status fallback detects pending coordinated restarts.");
