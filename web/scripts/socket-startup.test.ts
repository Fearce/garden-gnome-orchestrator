import assert from "node:assert/strict";

const storage = new Map<string, string>();
const timers = new Map<number, () => void>();
let nextTimer = 0;
class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Array<{type: string; clientId?: string}> = [];
  onopen?: () => void;
  onmessage?: (event: {data: string}) => void;
  constructor(public url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(event: unknown) { this.onmessage?.({data: JSON.stringify(event)}); }
}
Object.assign(globalThis, {
  document: {baseURI:"https://example.test/orchestrator/", addEventListener() {}},
  location: {protocol:"https:",host:"example.test"},
  localStorage: {getItem:(key: string)=>storage.get(key)??null,setItem:(key: string,value: string)=>storage.set(key,value),removeItem:(key: string)=>storage.delete(key)},
  WebSocket: Socket,
  setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
  setInterval: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
  clearTimeout: (id: number) => timers.delete(id),
  clearInterval: (id: number) => timers.delete(id),
});
const {useStore, connect} = await import("../src/store.js");
// Two offline messages: hello already contains one, while the other still needs delivery.
useStore.getState().sendPrompt("Already received before disconnection");
useStore.getState().sendPrompt("Still needs delivery");
const [received, pending] = useStore.getState().outboundMessages;
assert.ok(received && pending);
connect();
const socket = Socket.instances.at(-1)!;
assert.equal(socket.url, "wss://example.test/orchestrator/ws");
socket.readyState = 1;
socket.onopen?.();
assert.deepEqual(socket.sent, [], "opening waits for the server hello; no duplicate snapshot or premature replay");
const hello = {
  type:"hello",threads:[],runs:[],findings:[],questions:[],accounts:[],approvalMode:false,
  director:[{id:received.id,role:"user",content:received.content,createdAt:received.createdAt}],
};
socket.receive(hello);
assert.deepEqual(socket.sent, [{type:"prompt.new",text:pending.content,clientId:pending.id}], "only unacknowledged messages replay after hello");
assert.equal(useStore.getState().outboundMessages.length, 1);
socket.receive(hello);
assert.equal(socket.sent.length, 1, "a later resync does not replay again");
connect();
const second = Socket.instances.at(-1)!;
second.readyState = 1;
second.onopen?.();
assert.equal(second.sent.length, 0);
second.receive(hello);
assert.equal(second.sent[0]?.clientId, pending.id, "a new connection retries the same idempotency key");
assert.equal(second.sent.length, 1);
console.log("Socket startup passed: mounted path, one hello, receipt-before-replay, reliable reconnect.");
