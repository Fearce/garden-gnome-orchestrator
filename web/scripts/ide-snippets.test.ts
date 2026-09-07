import assert from "node:assert/strict";
import { parseSnippets } from "../src/components/ide/snippets.js";
import { strToU8, zipSync } from "fflate";
import { readSnippetVsix, snippetSource } from "../src/components/ide/vsix.js";
import { RequestCache } from "../src/components/ide/cache.js";
const snippets = parseSnippets(`{ // VS Code JSONC
  "Console": { "prefix": ["log", "print"], "scope": "javascript, typescript", "body": ["console.log($1);", "$0"], "description": "Print a value" },
}`);
assert.equal(snippets.length, 1);
assert.deepEqual(snippets[0]?.prefixes, ["log", "print"]);
assert.equal(snippets[0]?.body, "console.log($1);\n$0");
assert.deepEqual(snippets[0]?.scope, ["javascript", "typescript"]);
for (const source of ["[]", "null", "{}", "invalid", '{"s":{"prefix":"x","body":5}}', '{"s":{"prefix":[],"body":"x"}}', "x".repeat(200001)]) assert.throws(() => parseSnippets(source));
assert.equal(parseSnippets('{"s":{"prefix":"x","body":"${1:placeholder}"}}')[0]?.body, "${1:placeholder}");
console.log("VS Code snippet import: schema, limits, comments, scopes and placeholders passed.");
const archive = (path = "./snippets/test.json", body = '{"Log":{"prefix":"log","body":"console.log($1);$0"}}') => zipSync({
  "extension/package.json": strToU8(JSON.stringify({ name: "snippets", publisher: "test", version: "1.0.0", license: "MIT", main: "./evil.js", contributes: { commands: [], snippets: [{ language: "typescript", path }] } })),
  "extension/snippets/test.json": strToU8(body),
  "extension/evil.js": strToU8('throw new Error("must never execute")'),
});
const extension = readSnippetVsix(archive());
assert.equal(extension.id, "test.snippets");
assert.deepEqual(extension.snippets[0]?.scope, ["typescript"]);
assert.deepEqual(extension.ignored, ["commands", "executable extension code"]);
assert.equal(parseSnippets(snippetSource(extension.snippets))[0]?.body, "console.log($1);$0");
for (const path of ["../../escape.json", "/absolute.json", "C:/file.json", "code.js", "missing.json"]) assert.throws(() => readSnippetVsix(archive(path)));
assert.throws(() => readSnippetVsix(archive("./snippets/test.json", "x".repeat(200001))));
assert.throws(() => readSnippetVsix(new Uint8Array(6 * 1024 * 1024)));
console.log("VSIX snippet contributions: scoped import, ignored executable code, traversal, size and missing-file guards passed.");

let clock = 0, calls = 0;
const cache = new RequestCache(2, 100, () => clock);
const load = async () => ++calls;
assert.deepEqual(await Promise.all([cache.read("a", load, 30), cache.read("a", load, 30)]), [1, 1]);
assert.equal(await cache.read("a", load, 30), 1);
clock = 31;
assert.equal(await cache.read("a", load, 30), 2);
assert.equal(await cache.read("a", load, 30, true), 3);
await cache.read("b", load, 30); cache.peek("a"); await cache.read("c", load, 30);
assert.equal(cache.peek("b"), undefined, "least-recently used entry evicted");
let finish!: (value: string) => void;
const old = cache.read("race", () => new Promise<string>(resolve => { finish = resolve; }), 30);
await Promise.resolve(); cache.invalidate(key => key === "race");
await cache.read("race", async () => "fresh", 30);
finish("stale"); await old;
assert.equal(cache.peek("race"), "fresh", "invalidated in-flight result cannot replace newer data");
await cache.read("large", async () => "x".repeat(100), 30);
assert.equal(cache.peek("large"), undefined, "byte limit enforced");
await assert.rejects(cache.read("failure", async () => { throw new Error("offline"); }, 30));
assert.equal(await cache.read("failure", async () => "recovered", 30), "recovered");
cache.invalidate(); assert.equal(cache.peek("race"), undefined);
console.log("IDE memory cache: deduplication, expiry, fresh reads, LRU/byte bounds, invalidation races and failure recovery passed.");
