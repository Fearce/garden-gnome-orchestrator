import assert from "node:assert/strict";

Object.defineProperty(globalThis, "document", {
  value: { baseURI: "http://localhost/", addEventListener: () => {}, visibilityState: "visible" },
  configurable: true,
});
Object.defineProperty(globalThis, "location", {
  value: { protocol: "http:", host: "localhost", search: "", pathname: "/" },
  configurable: true,
});

type SentFrame = { type: string; [key: string]: unknown };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: SentFrame[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentFrame);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

const { connect, useStore } = await import("../src/store.js");
connect();
const socket = FakeWebSocket.instances[0]!;
assert.equal(socket.url, "ws://localhost/ws");
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
socket.sent.length = 0; // ignore connect's initial snapshot

const repoA = { path: "repo-a", name: "repo-a", taskCount: 1, activeCount: 0, isSelf: false, discovered: false };
const repoB = { path: "repo-b", name: "repo-b", taskCount: 0, activeCount: 0, isSelf: false, discovered: true };

useStore.getState().loadRepos(false, "thread-a");
assert.deepEqual(socket.sent.at(-1), { type: "repo.list", rescan: false, forThread: "thread-a" });
socket.onmessage?.({ data: JSON.stringify({ type: "repo.list", repos: [repoA], preferred: repoA.path }) });
assert.equal(useStore.getState().repoListPending, false, "a legacy repo.list reply without forThread still completes the active request");
assert.deepEqual(useStore.getState().repos, [repoA]);
assert.equal(useStore.getState().repoPreferred, repoA.path);

useStore.getState().loadRepos(false, "thread-current");
socket.onmessage?.({ data: JSON.stringify({ type: "repo.list", repos: [repoB], preferred: repoB.path, forThread: "thread-other" }) });
assert.equal(useStore.getState().repoListPending, true, "an explicit reply for another thread is still treated as stale");
assert.deepEqual(useStore.getState().repos, [repoA], "a stale reply must not replace the current picker list");

socket.onmessage?.({ data: JSON.stringify({ type: "repo.list", repos: [repoB], preferred: repoB.path, forThread: "thread-current" }) });
assert.equal(useStore.getState().repoListPending, false);
assert.deepEqual(useStore.getState().repos, [repoB]);
assert.equal(useStore.getState().repoPreferred, repoB.path);

useStore.getState().loadRepos(false, null);
assert.deepEqual(socket.sent.at(-1), { type: "repo.list", rescan: false });
socket.onmessage?.({ data: JSON.stringify({ type: "repo.list", repos: [repoA], preferred: null, forThread: null }) });
assert.equal(useStore.getState().repoListPending, false, "the top-bar Git console accepts the null-scope reply");
assert.deepEqual(useStore.getState().repos, [repoA]);
assert.equal(useStore.getState().repoPreferred, null);

console.log("Git console repo-list replies are compatible with null, scoped, and legacy reply shapes.");
process.exit(0);
