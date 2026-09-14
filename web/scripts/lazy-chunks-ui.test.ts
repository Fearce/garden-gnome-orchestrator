import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..");
const app = readFileSync(resolve(webRoot, "src", "App.tsx"), "utf8");
const board = readFileSync(resolve(webRoot, "src", "components", "Board.tsx"), "utf8");
const ide = readFileSync(resolve(webRoot, "src", "components", "ide", "Ide.tsx"), "utf8");
const boundary = readFileSync(resolve(webRoot, "src", "components", "LazyChunkBoundary.tsx"), "utf8");

assert.match(boundary, /Failed to fetch dynamically imported module/, "dynamic-import chunk failures are recognized");
assert.match(boundary, /sessionStorage\.getItem\(key\) === "1"/, "chunk recovery reloads at most once per build");
assert.match(boundary, /window\.location\.reload\(\)/, "chunk recovery can refresh onto the current bundle");

assert.match(app, /LazyChunkBoundary label="Git console"[\s\S]*<GitConsole /, "the top-bar Git console cannot crash the app on a stale lazy chunk");
assert.match(app, /LazyChunkBoundary label="Settings"[\s\S]*<SettingsPanel /, "settings shares the same lazy-chunk guard");
assert.match(board, /LazyChunkBoundary label="IDE"[\s\S]*<Ide \/>/, "the board IDE tab cannot crash the app on a stale lazy chunk");
assert.match(ide, /LazyChunkBoundary label="IDE source control"[\s\S]*<GitWorkspace /, "IDE source control is guarded too");
assert.match(ide, /LazyChunkBoundary label="Editor"[\s\S]*(TouchEditor|CodeEditor)/, "the editor chunks are guarded too");

console.log("Lazy Git and IDE chunks are guarded against stale mobile tabs.");
