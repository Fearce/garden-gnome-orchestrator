import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..");
const app = readFileSync(resolve(webRoot, "src", "App.tsx"), "utf8");
const store = readFileSync(resolve(webRoot, "src", "store.ts"), "utf8");

assert.match(app, /import \{ ThreadDetail \} from "\.\/components\/ThreadDetail\.js"/, "task detail is in the startup bundle");
assert.doesNotMatch(app, /ThreadDetail\s*=\s*lazy\(/, "task opening cannot wait on a stale lazy chunk after deploy");
assert.match(
  app,
  /\{selected \? <ThreadDetail key=\{selected\} \/> : null\}/,
  "task detail renders directly without an unbounded suspense fallback",
);

assert.match(
  store,
  /message\.surface === "task"[^\n]+command\.type === "thread\.inject"[^\n]+!command\.images\?\.length/,
  "text task instructions are persisted in the browser outbox",
);
assert.match(store, /inject:[\s\S]*?const sent = sendOutbound\(/, "task instructions use reconnect replay instead of one-socket action waits");
assert.doesNotMatch(
  store,
  /No server receipt arrived after reconnecting\. The message was not delivered/,
  "silence can no longer manufacture a Not delivered verdict",
);
assert.match(
  store,
  /Silence is not proof of non-delivery[\s\S]*?scheduleOutboundConfirmation\(id\)/,
  "an unconfirmed command stays pending and retries with its correlation id",
);

console.log("Incident UI recovery checks passed: eager task detail and reconnect-safe task outbox.");
