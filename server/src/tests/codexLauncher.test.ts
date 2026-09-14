import assert from "node:assert/strict";
import { resolveCodexLauncher } from "../agents/codexLauncher.js";

const NPM = "C:\\Users\\Mikkel\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const DESKTOP = "C:\\Users\\Mikkel\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
const env = {
  APPDATA: "C:\\Users\\Mikkel\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Mikkel\\AppData\\Local",
};

function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}

console.log("Codex launcher resolution");

check("an explicit npm launcher override wins", () => {
  const override = "D:\\tools\\codex.js";
  const launcher = resolveCodexLauncher({ ...env, CODEX_BIN_JS: override }, () => false, "win32");
  assert.deepEqual(launcher, { command: process.execPath, args: [override], path: override, source: "npm-override" });
});

check("the global npm launcher is used when it is installed", () => {
  const launcher = resolveCodexLauncher(env, (path) => path === NPM, "win32");
  assert.deepEqual(launcher, { command: process.execPath, args: [NPM], path: NPM, source: "npm" });
});

check("the Codex desktop CLI is discovered when npm is absent", () => {
  const launcher = resolveCodexLauncher(env, (path) => path === DESKTOP, "win32");
  assert.deepEqual(launcher, { command: DESKTOP, args: [], path: DESKTOP, source: "desktop" });
});

check("a missing installation retains the actionable npm path", () => {
  const launcher = resolveCodexLauncher(env, () => false, "win32");
  assert.equal(launcher.path, NPM);
  assert.equal(launcher.source, "npm");
});

console.log("Codex launcher resolution: all assertions passed");
