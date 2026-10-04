const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { waitForAppClose } = require("./app-shutdown.cjs");

test("a successful quit releases its timer so the probe process can exit", async () => {
  const child = spawn(process.execPath, ["-e", "require('./app-shutdown.cjs').waitForAppClose({close: async () => {}})"], { cwd: __dirname, windowsHide: true, stdio: "ignore" });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("quit left a timeout keeping the process alive")), 5000); }),
    ]);
    assert.equal(code, 0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
});

test("a stuck quit fails instead of being reported as an app closed measurement", async () => {
  await assert.rejects(waitForAppClose({ close: () => new Promise(() => {}) }, 20), /refusing to measure it as closed/);
});

test("a quit failure preserves the actual error", async () => {
  const failure = new Error("inspector disconnected");
  await assert.rejects(waitForAppClose({ close: async () => { throw failure; } }), error => error === failure);
});
