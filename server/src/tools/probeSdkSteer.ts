/**
 * Probe what STEERING does to a live run — the sibling question to `probe:sdk-resume`.
 *
 * Why this exists: every path that reaches a running agent mid-work (an office-chat post, "Interrupt &
 * inject", Pause, a heads-up finding) hands it a message with a `priority`, and what that does to the
 * run's RESULT stream is an SDK behaviour with no documentation we control. Two bugs have now been paid
 * for on exactly this: `6a5e071` (a "now" send killed a schema-bound QA agent) and `dcd4548` (the aborted
 * turn's result read as the implementor finishing, so one chatroom post pushed four half-done tasks into
 * QA). Both diagnoses started by hand-writing a throwaway SDK harness. This is that harness, committed.
 *
 *   npm run probe:sdk-steer --prefix server
 *   npm run probe:sdk-steer --prefix server -- --mode next
 *   npm run probe:sdk-steer --prefix server -- --mode interrupt --at 8000 --model claude-haiku-4-5-20251001
 *
 * COSTS REAL QUOTA — it spawns a real `claude` subprocess on a real subscription. Defaults are cheap
 * (Haiku, one run, one steer ≈ $0.06).
 *
 * Reading the output: one line per result the run emitted, with the CLI's verbatim `terminal_reason`.
 * A turn the steering aborted reads `subtype=success is_error=false result=""` — indistinguishable from a
 * finish except by that reason — and the last line shows what `awaitTurnResult` (the production rule in
 * threadManager.ts: discard aborted turns, wait for the continuation) resolves on. If that lands on the
 * ABORTED turn, the `dcd4548` bug is back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRun, type ResultEvent } from "../agents/runner.js";
import { config } from "../config.js";

type Mode = "now" | "next" | "interrupt";

interface Args {
  mode: Mode;
  atMs: number;
  model: string;
  account: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = get("--mode");
  const at = Number(get("--at"));
  return {
    mode: mode === "next" || mode === "interrupt" ? mode : "now",
    atMs: Number.isFinite(at) && at > 0 ? at : 12_000,
    model: get("--model") ?? "claude-haiku-4-5-20251001",
    account: get("--account"),
  };
}

/** Busywork long enough to still be mid-turn when the steering lands, in tool calls rather than tokens. */
const BUSY_PROMPT =
  "Using the Bash tool, run `sleep 2` ten separate times, one tool call per message, announcing each " +
  "before you run it. Do not batch them into one command.";
/** Steering whose effect is unmistakable in the result text, so a continuation can't be confused for a finish. */
const STEER_TEXT = "Stop the sleeps. Reply with the single word BANANA and finish.";

/** Best-effort: a just-exited `claude` child can still hold the temp cwd on Windows. Never fatal. */
async function cleanup(cwd: string): Promise<void> {
  for (const waitMs of [0, 1500]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    try {
      rmSync(cwd, { recursive: true, force: true });
      return;
    } catch {
      /* the child is still exiting — retry once below */
    }
  }
  console.log(`  (note: could not remove ${cwd} — a CLI child still holds it; delete it later)`);
}

/** The production awaiter's rule, verbatim (threadManager.awaitTurnResult): skip aborted turns. */
async function awaitTurnResult(run: AgentRun): Promise<ResultEvent | undefined> {
  let res = await run.result();
  while (res?.aborted) res = await run.nextResult();
  return res;
}

function describe(r: ResultEvent, at: number): string {
  const text = (r.result ?? "").replace(/\s+/g, " ").slice(0, 40);
  return (
    `  [${String(at).padStart(6)}ms] subtype=${String(r.subtype).padEnd(9)} is_error=${String(r.isError).padEnd(5)} ` +
    `terminal_reason=${(r.terminalReason ?? "—").padEnd(18)} aborted=${String(!!r.aborted).padEnd(5)} ` +
    `turns=${String(r.numTurns ?? "—").padEnd(3)} result=${JSON.stringify(text)}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const acct = args.account ? config.accounts.find((a) => a.id === args.account) : config.accounts.find((a) => a.token);
  if (!acct?.token) {
    console.error(
      args.account
        ? `No account "${args.account}" with a token in config.accounts — check server/.env.`
        : "No Claude account with a token in config.accounts — check server/.env.",
    );
    process.exit(1);
  }

  const cwd = mkdtempSync(join(tmpdir(), "probe-sdk-steer-"));
  console.log(`\n=== sdk steering probe · mode "${args.mode}" at ${args.atMs}ms · ${args.model} · ${acct.label} ===\n`);

  const run = new AgentRun({
    model: args.model,
    cwd,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash"],
    settingSources: [],
    includePartialMessages: false,
    oauthToken: acct.token,
  });

  const startedAt = Date.now();
  const results: { evt: ResultEvent; at: number }[] = [];
  run.onEvent((e) => {
    if (e.type === "result") results.push({ evt: e, at: Date.now() - startedAt });
  });

  run.start(BUSY_PROMPT);
  const steerTimer = setTimeout(() => {
    console.log(`  [${String(Date.now() - startedAt).padStart(6)}ms] → steering (${args.mode})`);
    if (args.mode === "interrupt") {
      // The Pause control: abort with NOTHING queued behind it.
      void run.interrupt();
    } else {
      run.send(STEER_TEXT, { priority: args.mode });
    }
  }, args.atMs);

  // A bare interrupt leaves the run alive with no continuation, so the awaiter would wait forever — that
  // IS the production behaviour (the task sits paused). Bound it here so the probe still reports.
  const resolved = await Promise.race([
    awaitTurnResult(run),
    new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), args.atMs + 90_000)),
  ]);
  clearTimeout(steerTimer);
  await run.stop();
  await cleanup(cwd);

  console.log("");
  for (const r of results) console.log(describe(r.evt, r.at));

  const aborted = results.filter((r) => r.evt.aborted);
  const spend = results.reduce((s, r) => s + (r.evt.costUsd ?? 0), 0);
  console.log("\n=== verdict ===");
  console.log(`  the steering aborted a turn in flight: ${aborted.length ? `yes (${aborted.length})` : "no"}`);
  console.log(`  results emitted: ${results.length} (an abort emits its own, then the continuation emits another)`);
  if (resolved === "still waiting") {
    console.log("  awaitTurnResult: still waiting — correct for a bare interrupt with nothing queued (the task sits paused).");
  } else {
    const landedOnAbort = !!resolved?.aborted;
    console.log(`  awaitTurnResult resolved on: ${landedOnAbort ? "the ABORTED turn" : "a real turn"} — result=${JSON.stringify((resolved?.result ?? "").slice(0, 40))}`);
    console.log(
      landedOnAbort
        ? "  ⚠ REGRESSION — an aborted turn is being read as the run's outcome (this is the dcd4548 bug)."
        : "  ✓ the aborted turn was discarded and the continuation's result was taken.",
    );
  }
  console.log(`  total spend: $${spend.toFixed(4)}\n`);
  process.exit(0);
}

await main();
