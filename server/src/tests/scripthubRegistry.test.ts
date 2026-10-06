import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editEntry, readEntry } from "../modules/worker/scripthub/registry.js";

test("registry editing preserves peer entries, unknown settings and rejects stale/invalid saves", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-edit-"));
  const file = join(root, "scripts.json");
  try {
    const alpha = { id: "alpha", displayName: "Alpha", keepAlive: true, keepAlivePolicy: "manual", start: { type: "process", executable: "node", args: ["app.js"], custom: 42 }, status: { processMatchers: ["app.js"] } };
    await writeFile(file, JSON.stringify({ version: 1, scripts: [alpha, { id: "beta" }] }));
    const before = await readEntry(file, "alpha");
    // Another agent registers a different entry while this editor is open.
    const registry = JSON.parse(await readFile(file, "utf8"));
    registry.scripts.push({ id: "gamma", description: "Peer work" });
    await writeFile(file, JSON.stringify(registry));
    const request = { revision: before.revision, entry: { ...before.entry, displayName: "New name", description: "Edited", start: { ...alpha.start, args: ["app.js", "--flag"] } } };
    const result = await editEntry(file, "alpha", request);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.scripts[0].start.custom, 42);
    assert.deepEqual(saved.scripts[0].status, alpha.status);
    assert.deepEqual(saved.scripts.slice(1), [{ id: "beta" }, { id: "gamma", description: "Peer work" }]);
    assert.notEqual(result.revision, before.revision);
    await assert.rejects(editEntry(file, "alpha", request), /changed since/);
    const text = await readFile(file, "utf8");
    for (const entry of [{ ...result.entry, id: "renamed" }, { ...result.entry, keepAlive: false }, { ...result.entry, start: { args: "bad" } }, { ...result.entry, notes: 42 }, { ...result.entry, status: { processMatchers: ["["] } }, { ...result.entry, status: { portMatchers: [70000] } }, { ...result.entry, tags: ["changed"] }]) {
      await assert.rejects(editEntry(file, "alpha", { revision: result.revision, entry }));
      assert.equal(await readFile(file, "utf8"), text);
    }
    const simultaneous = await Promise.allSettled([
      editEntry(file, "alpha", { revision: result.revision, entry: { ...result.entry, description: "One" } }),
      editEntry(file, "alpha", { revision: result.revision, entry: { ...result.entry, description: "Two" } }),
    ]);
    assert.equal(simultaneous.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(simultaneous.filter((item) => item.status === "rejected").length, 1);
    await assert.rejects(readFile(`${file}.lock`), { code: "ENOENT" });
    // A crashed upsert helper's lock goes stale after 30s, matching upsert_script.py.
    const latest = await readEntry(file, "alpha");
    await writeFile(`${file}.lock`, "12345");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    await editEntry(file, "alpha", { revision: latest.revision, entry: { ...latest.entry, description: "After stale lock" } });
    assert.equal(JSON.parse(await readFile(file, "utf8")).scripts[0].description, "After stale lock");
    await assert.rejects(readFile(`${file}.lock`), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
