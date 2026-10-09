const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { transcriptCalls, warnings } = require("./probe-token-burn.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-token-burn-"));
const parent = path.join(root, "session.jsonl");
const at = Date.parse("2026-01-02T12:00:00Z");
const call = (id, time, input) => JSON.stringify({ type: "assistant", timestamp: new Date(time).toISOString(),
  message: { id, usage: { input_tokens: input, output_tokens: 10 } } });
try {
  fs.writeFileSync(parent, [call("parent", at, 100_000), call("parent", at, 100_000)].join("\n"));
  assert.equal(transcriptCalls(parent).calls.length, 1, "streamed blocks represent one API call");
  const children = path.join(root, "session", "subagents");
  fs.mkdirSync(children, { recursive: true });
  fs.writeFileSync(path.join(children, "agent.jsonl"), [call("child", at + 1000, 1_600_000),
    call("child", at + 1000, 1_600_000), call("earlier", at - 60_000, 50_000)].join("\n"));
  fs.writeFileSync(path.join(children, "metadata.json"), "{}");
  const { calls } = transcriptCalls(parent);
  assert.equal(calls.length, 3, "child calls are included, deduplicated and non-transcripts ignored");
  assert.deepEqual(calls.map(c => c.at), [at - 60_000, at, at + 1000], "calls remain chronological");
  const own = calls.filter(c => c.at >= at && c.at <= at + 5000);
  const tokens = own.reduce((total, c) => total + c.tokens, 0);
  assert.equal(tokens, 1_700_020, "the run window includes its child usage and excludes prior calls");
  const run = { id: "run", role: "qa", started_at: at, calls: own.length, tokens,
    total_tokens: tokens, heavyTokens: 0, resumed: false };
  assert.equal(warnings([run], 1).some(w => w.includes("over-counting")), false,
    "legitimate delegated usage is not diagnosed as an accounting regression");
  assert.equal(warnings([{ ...run, total_tokens: tokens + 2_000_000 }], 1)
    .some(w => w.includes("over-counting")), true, "a real unexplained over-count still warns");
  console.log("token-burn probe: parent/child usage, stream deduplication, run windows and drift checks passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
