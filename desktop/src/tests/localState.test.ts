import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { downloadPath } from "../downloadPath";
import { checkoutPort, findCheckout, isCheckout, portInUse, serverLogPath, startDetachedServer, urlPort } from "../localServer";
import { loadSettings, saveSettings } from "../settings";
import { DEFAULT_SERVER_URL } from "../serverUrl";

const scratch = mkdtempSync(join(tmpdir(), "ggo-desktop-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fakeCheckout(dir: string): string {
  mkdirSync(join(dir, "server", "scripts"), { recursive: true });
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "server", "scripts", "supervise.cjs"), "");
  writeFileSync(join(dir, "server", "package.json"), "{}");
  writeFileSync(join(dir, "web", "package.json"), "{}");
  return dir;
}

test("settings fall back field by field and round-trip", () => {
  const dir = join(scratch, "settings");
  assert.deepEqual(loadSettings(dir), { serverUrl: DEFAULT_SERVER_URL, checkoutDir: null, bounds: null }, "first run");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "desktop-settings.json"), JSON.stringify({ serverUrl: "javascript:x", checkoutDir: "relative/path", bounds: { x: 0, y: 0, width: 10, height: 10 } }));
  assert.deepEqual(loadSettings(dir), { serverUrl: DEFAULT_SERVER_URL, checkoutDir: null, bounds: null }, "hand-mangled values are dropped");

  writeFileSync(join(dir, "desktop-settings.json"), "{ not json");
  assert.equal(loadSettings(dir).serverUrl, DEFAULT_SERVER_URL);

  const saved = { serverUrl: "https://example.com/orchestrator/", checkoutDir: scratch, bounds: { x: 10, y: 20, width: 1200, height: 800, maximized: true } };
  saveSettings(dir, saved);
  assert.deepEqual(loadSettings(dir), saved);
  assert.ok(readFileSync(join(dir, "desktop-settings.json"), "utf8").endsWith("\n"));
});

test("the checkout is found from inside it, or from a chosen folder", () => {
  const checkout = fakeCheckout(join(scratch, "ggo"));
  const unpacked = join(checkout, "desktop", "release", "win-unpacked", "resources");
  mkdirSync(unpacked, { recursive: true });
  assert.equal(isCheckout(checkout), true);
  assert.equal(findCheckout(null, [unpacked]), checkout, "a packaged build inside the repo finds its checkout");
  assert.equal(findCheckout(null, [join(scratch, "settings")]), null);

  const other = fakeCheckout(join(scratch, "other"));
  assert.equal(findCheckout(other, [unpacked]), other, "a chosen folder wins");
  assert.equal(findCheckout(join(scratch, "settings"), [unpacked]), checkout, "a chosen folder that is not a checkout is ignored");
});

test("the server log follows the environment's DATA_DIR, as the supervisor that writes it does", () => {
  const checkout = fakeCheckout(join(scratch, "logs"));
  assert.equal(serverLogPath(checkout, {}), join(checkout, "server", "data", "server.log"));
  writeFileSync(join(checkout, "server", ".env"), "AUTH_PASSWORD=unused\nDATA_DIR=\"./state\"\n");
  assert.equal(serverLogPath(checkout, {}), join(checkout, "server", "data", "server.log"), "the supervisor never reads server/.env");
  assert.equal(serverLogPath(checkout, { DATA_DIR: "./state" }), join(checkout, "server", "state", "server.log"));
  assert.equal(serverLogPath(checkout, { DATA_DIR: join(scratch, "elsewhere") }), join(scratch, "elsewhere", "server.log"));
});

test("the checkout's port comes from the environment, then server/.env, then 4317", () => {
  const checkout = fakeCheckout(join(scratch, "ports"));
  assert.equal(checkoutPort(checkout, {}), 4317);
  writeFileSync(join(checkout, "server", ".env"), "AUTH_PASSWORD=unused\nPORT=\"4400\"\n");
  assert.equal(checkoutPort(checkout, {}), 4400);
  assert.equal(checkoutPort(checkout, { PORT: "4500" }), 4500, "the server loads .env without overriding the environment");
  assert.equal(checkoutPort(checkout, { PORT: "not-a-port" }), 4317);
  assert.equal(urlPort("http://127.0.0.1:4317/"), 4317);
  assert.equal(urlPort("https://example.com/orchestrator/"), 443);
  assert.equal(urlPort("http://example.com/"), 80);
});

test("Start GGO launches the supervisor from a checkout path PowerShell would misread", { skip: process.platform !== "win32" }, async () => {
  const checkout = fakeCheckout(join(scratch, "ggo [1] \u2019s copy"));
  const marker = join(checkout, "server", "started.json");
  writeFileSync(
    join(checkout, "server", "scripts", "supervise.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1) }));\n`,
  );
  const { pid } = await startDetachedServer(checkout, process.execPath);
  assert.ok(pid > 0);
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  const started = JSON.parse(readFileSync(marker, "utf8")) as { cwd: string; argv: string[] };
  assert.equal(started.cwd, join(checkout, "server"), "the supervisor runs in server/, where a relative DATA_DIR resolves");
  assert.deepEqual(started.argv, [join(checkout, "server", "scripts", "supervise.cjs")]);
});

test("a port is in use only while something listens on it", async () => {
  const listener = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => listener.once("listening", done));
  const { port } = listener.address() as { port: number };
  assert.equal(await portInUse(`http://127.0.0.1:${port}/`), true);
  await new Promise((done) => listener.close(done));
  assert.equal(await portInUse(`http://127.0.0.1:${port}/`), false);
});

test("a download keeps its name, made safe, and never overwrites", () => {
  const dir = join(scratch, "downloads");
  const taken = new Set([join(dir, "report.md"), join(dir, "report (1).md")]);
  const exists = (path: string) => taken.has(path);
  assert.equal(downloadPath(dir, "report.md", exists), join(dir, "report (2).md"));
  assert.equal(downloadPath(dir, "shot.png", exists), join(dir, "shot.png"));
  assert.equal(downloadPath(dir, "../../evil.cmd", exists), join(dir, "evil.cmd"), "a path in the suggestion is dropped");
  assert.equal(downloadPath(dir, "a:b?.txt", exists), join(dir, "a_b_.txt"));
  assert.equal(downloadPath(dir, "...", exists), join(dir, "download"));
  assert.equal(downloadPath(dir, "", exists), join(dir, "download"));
});
