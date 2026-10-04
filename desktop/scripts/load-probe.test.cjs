const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("../../server/node_modules/ws");

async function runAgainst(mode) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/login") return res.writeHead(200, { "set-cookie": "session=probe-test" }).end("{}");
    res.writeHead(req.url === "/api/me" && mode === "http-error" ? 503 : 200, { "content-type": "application/json" });
    res.end("{}");
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    if (mode !== "hello-timeout") socket.send(JSON.stringify({ type: "hello", threads: [] }));
    // Intentionally no pong: a responsive HTTP service must not hide a stalled WebSocket.
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "load-probe.cjs"), "--url", `http://127.0.0.1:${server.address().port}`, "--samples", "1"], {
        env: { ...process.env, AUTH_PASSWORD: "probe-test" }, windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", data => output += data);
      child.stderr.on("data", data => output += data);
      const timer = setTimeout(() => { child.kill(); reject(new Error("probe did not fail within 25 seconds")); }, 25_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ code, output }); });
    });
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const [mode, expected] of [
  ["http-error", /\/api\/me returned HTTP 503/],
  ["hello-timeout", /WebSocket hello did not arrive within 15 seconds/],
  ["pong-timeout", /WebSocket pong did not arrive within 15 seconds/],
]) {
  test(`load measurement fails on ${mode}`, async () => {
    const result = await runAgainst(mode);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, expected);
    assert.doesNotMatch(result.output, /app closed:/);
  });
}
