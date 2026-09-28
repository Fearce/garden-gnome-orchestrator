/**
 * Unit gate - a resumed session's run is charged only for its own tokens and cost.
 *
 * On `--resume` the Claude CLI restores the session's saved totals, so every result's `modelUsage` and
 * `total_cost_usd` are SESSION-cumulative; only `result.usage` covers the query alone. Recording them
 * verbatim put 149M tokens on a 1-minute run that made one 0.6M-token API call (2026-09-28), and summing
 * a resumed task's rows counted each earlier run again: 710M recorded for a session whose transcript
 * holds 255M. `codex exec resume` does the same with `turn.completed.usage`, which is the thread's
 * running total, also persisted in its rollout's `token_count` events.
 *
 * The live shapes below are copied from a real SDK probe (three resumed one-word Haiku turns: modelUsage
 * 18,013 → 36,056 → 54,418 tokens, cost 0.0353 → 0.0391 → 0.0417).
 *
 * Free: synthetic results and a temp rollout, no DB/network/agent.
 * Run: npm run test:session-usage (from server/)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunMeter, CodexRunMeter, codexRolloutTokenUsage, subtractTokenUsage } from "../agents/sessionUsage.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const haiku = "claude-haiku-4-5-20251001";
function result(cumulative: { input: number; output: number; read: number; write: number }, cost: number, query: { input: number; output: number; read: number; write: number }) {
  return {
    modelUsage: {
      [haiku]: {
        inputTokens: cumulative.input,
        outputTokens: cumulative.output,
        cacheReadInputTokens: cumulative.read,
        cacheCreationInputTokens: cumulative.write,
        costUSD: cost,
      },
    },
    total_cost_usd: cost,
    usage: {
      input_tokens: query.input,
      output_tokens: query.output,
      cache_read_input_tokens: query.read,
      cache_creation_input_tokens: query.write,
    },
  };
}

const first = result({ input: 10, output: 51, read: 0, write: 17045 }, 0.035294, { input: 10, output: 51, read: 0, write: 17045 });
const second = result({ input: 20, output: 89, read: 17045, write: 17995 }, 0.0390985, { input: 10, output: 38, read: 17045, write: 950 });
const third = result({ input: 30, output: 122, read: 35040, write: 18319 }, 0.041721, { input: 10, output: 33, read: 17995, write: 324 });

console.log("fresh session");
{
  const meter = new ClaudeRunMeter(false);
  const a = meter.measure(first);
  check("a fresh run reports the CLI's totals unchanged", a.tokenUsage?.totalTokens === 17106 && a.costUsd === 0.035294, JSON.stringify(a));
}

console.log("resumed session, one query per process");
{
  const meter = new ClaudeRunMeter(true);
  const b = meter.measure(second);
  check("a resumed run's tokens are its own query, not the session", b.tokenUsage?.totalTokens === 18043, JSON.stringify(b.tokenUsage));
  check("its cache reads are this query's only", b.tokenUsage?.cacheReadInputTokens === 17045);
  check("its cost is a share of the cumulative, well under it", (b.costUsd ?? 1) > 0 && (b.costUsd ?? 1) < 0.0390985 / 2, String(b.costUsd));
}

console.log("resumed session, several queries in one process (steering)");
{
  const meter = new ClaudeRunMeter(true);
  meter.measure(second);
  const c = meter.measure(third);
  check("the run's total covers both of its own queries", c.tokenUsage?.totalTokens === 18043 + 18362, JSON.stringify(c.tokenUsage));
  const onlyThird = new ClaudeRunMeter(true).measure(third).costUsd ?? 0;
  const bothCost = c.costUsd ?? 0;
  check("its cost grows by the exact cumulative delta after the first result", Math.abs(bothCost - onlyThird - (0.0390985 - 0.035294)) < 0.002, `${bothCost} vs ${onlyThird}`);
}

console.log("resumed session opened by a housekeeping turn");
{
  const meter = new ClaudeRunMeter(true);
  meter.measure(result({ input: 10, output: 51, read: 0, write: 17045 }, 0.035294, { input: 0, output: 0, read: 0, write: 0 }));
  const d = meter.measure(second);
  check("a 0-turn housekeeping result pins the restored baseline exactly", d.tokenUsage?.totalTokens === 18043 && Math.abs((d.costUsd ?? 0) - (0.0390985 - 0.035294)) < 1e-9, JSON.stringify(d));
}

console.log("missing usage");
{
  const meter = new ClaudeRunMeter(true);
  const e = meter.measure({ modelUsage: undefined, total_cost_usd: undefined, usage: undefined });
  check("no modelUsage still yields no token usage", e.tokenUsage === undefined && e.costUsd === undefined);
}

console.log("subtractTokenUsage");
{
  const diff = subtractTokenUsage(
    { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60, cacheCreationInputTokens: 0, reasoningOutputTokens: 10, totalTokens: 120 },
    { inputTokens: 40, outputTokens: 30, cacheReadInputTokens: 20, cacheCreationInputTokens: 0, reasoningOutputTokens: 4, totalTokens: 70 },
  );
  check("never goes negative", diff.outputTokens === 0 && diff.inputTokens === 60 && diff.reasoningOutputTokens === 6);
  check("keeps a reported total's own convention", diff.totalTokens === 50);
}

console.log("codex rollout baseline");
const home = mkdtempSync(join(tmpdir(), "codex-rollout-"));
try {
  const thread = "01a0d8de-d0d6-7560-97cb-5712368c17d7";
  const dir = join(home, "sessions", "2026", "09", "25");
  mkdirSync(dir, { recursive: true });
  const tokenCount = (total: number, cached: number) =>
    JSON.stringify({
      timestamp: "2026-09-25T14:01:49.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: total - 100, cached_input_tokens: cached, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: total }, last_token_usage: { total_tokens: 5 } } },
    });
  writeFileSync(
    join(dir, `rollout-2026-09-25T16-01-16-${thread}.jsonl`),
    [JSON.stringify({ type: "session_meta", payload: { id: thread } }), tokenCount(22213, 0), tokenCount(14654285, 14000000), JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } })].join("\n") + "\n",
  );
  const base = await codexRolloutTokenUsage(home, thread);
  check("reads the thread's LAST running total from its rollout", base?.totalTokens === 14654285 && base.cacheReadInputTokens === 14000000, JSON.stringify(base));
  check("an unknown thread has no baseline", (await codexRolloutTokenUsage(home, "no-such-thread")) === undefined);
  check("a missing CODEX_HOME has no baseline", (await codexRolloutTokenUsage(join(home, "absent"), thread)) === undefined);

  const cumulative = (total: number) => ({ inputTokens: total - 100, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total });
  const resumed = new CodexRunMeter(home);
  await resumed.beginTurn(thread);
  check("a resumed thread is charged only past its rollout's total", resumed.record(thread, cumulative(15000000))?.totalTokens === 15000000 - 14654285);
  await resumed.beginTurn(thread);
  check("a later steering turn keeps the run's first baseline", resumed.record(thread, cumulative(15500000))?.totalTokens === 15500000 - 14654285);
  check("a fresh-fallback thread adds its whole total", resumed.record("fresh-thread", cumulative(2000))?.totalTokens === 15500000 - 14654285 + 2000);
  const fresh = new CodexRunMeter(home);
  await fresh.beginTurn(undefined);
  check("a fresh run reports the CLI's total unchanged", fresh.record("new-thread", cumulative(22213))?.totalTokens === 22213);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} - ${passed} passed, ${failed} failed ===`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exitCode = failed === 0 ? 0 : 1;
