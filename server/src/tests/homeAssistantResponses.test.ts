import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDevice } from "../modules/worker/home/config.js";
import { HomeAssistantBridge } from "../modules/worker/home/homeAssistant.js";
import { HttpError } from "../modules/worker/router.js";

const root = await mkdtemp(join(tmpdir(), "ggo-ha-responses-"));
let mode: "retry" | "invalid" | "stalled" = "retry";
let stateReads = 0;
let tokenReads = 0;
const server = createServer((req, res) => {
  if (req.url === "/auth/token") {
    tokenReads++;
    res.end(JSON.stringify({ access_token: "sample-access-token", expires_in: 1800 }));
    return;
  }
  stateReads++;
  if (mode === "retry" && stateReads === 1) {
    res.writeHead(401);
    res.end("Please sign in again");
  } else if (mode === "retry") {
    res.end(JSON.stringify([{ entity_id: "vacuum.sample", state: "docked", attributes: { battery_level: 80 } }]));
  } else if (mode === "invalid") {
    res.end("<html>unavailable</html>");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[");
    // Headers arrive promptly, but the body never finishes.
  }
});
const timeout = AbortSignal.timeout;
try {
  await mkdir(join(root, ".storage"));
  await writeFile(join(root, ".storage", "auth"), JSON.stringify({ data: {
    users: [{ id: "sample-owner", is_owner: true }],
    refresh_tokens: [{ token: "sample-refresh-token", user_id: "sample-owner", token_type: "normal" }],
  } }));
  await writeFile(join(root, ".storage", "core.entity_registry"), JSON.stringify({ data: {
    entities: [{ entity_id: "vacuum.sample", device_id: "sample-device" }],
  } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const device = normalizeDevice({ id: "sample", homeAssistantEntityId: "vacuum.sample" });
  const bridge = () => new HomeAssistantBridge(url, root);
  assert.equal((await bridge().status(device)).status.battery, 80);
  assert.equal(stateReads, 2);
  assert.equal(tokenReads, 2);
  console.log("✓ Home Assistant consumes a non-JSON credential rejection and retries successfully");

  mode = "invalid";
  await assert.rejects(bridge().status(device), (error: unknown) =>
    error instanceof HttpError && error.status === 502 && /invalid JSON/.test(error.message));
  console.log("✓ Home Assistant reports malformed successful responses instead of empty device state");

  mode = "stalled";
  AbortSignal.timeout = (ms) => timeout(Math.min(ms, 150));
  await assert.rejects(bridge().status(device), (error: unknown) =>
    error instanceof HttpError && error.status === 504 && error.extra.haDown === true);
  console.log("✓ Home Assistant reports a stalled response body as an unavailable-service timeout");
} finally {
  AbortSignal.timeout = timeout;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
