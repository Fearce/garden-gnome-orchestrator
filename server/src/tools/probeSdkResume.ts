/**
 * Probe the Agent SDK's RESUME semantics with the real `AgentRun` the orchestrator uses.
 *
 * Why this exists: the whole auto-resume machinery (`awaitImplementorCompletion`) rests on assumptions
 * about what `--resume` does — that a resumed query gets a FRESH turn budget, and that it actually reaches
 * the model. Those are SDK behaviours, not ours, and they are not documented anywhere we control. The
 * 2026-07-27 silent-resume bug was a resume returning `success` with 0 turns, $0 and no output at all;
 * diagnosing it meant hand-writing a throwaway SDK harness. This is that harness, committed, so the next
 * agent asks the question in one command instead of rebuilding it.
 *
 *   npm run probe:sdk-resume --prefix server
 *   npm run probe:sdk-resume --prefix server -- --resumes 4 --max-turns 6 --model claude-haiku-4-5-20251001
 *
 * COSTS REAL QUOTA — it spawns real `claude` subprocesses on a real subscription. Defaults are deliberately
 * cheap (Haiku, maxTurns 4, 3 resumes ≈ $0.10). Bump the model only when the question is model-specific.
 *
 * Reading the output: `turns` is what the SDK reported for that query, `out` counts the events the run
 * actually produced (text / thinking / tool_use). **`out: 0` on a non-error result is the silent-resume
 * signature** — the CLI loaded the session and exited without reaching the model. Seeing it here means the
 * phenomenon still reproduces; `ranSilently` in threadManager.ts is what handles it in production.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRun } from "../agents/runner.js";
import { config } from "../config.js";

interface Args {
  resumes: number;
  maxTurns: number;
  model: string;
  account: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const n = Number(get(flag));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    resumes: num("--resumes", 3),
    maxTurns: num("--max-turns", 4),
    model: get("--model") ?? "claude-haiku-4-5-20251001",
    account: get("--account"),
  };
}

/** A workspace with enough small files that a low turn ceiling is reached by reading them one at a time. */
function seedWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "probe-sdk-resume-"));
  for (let i = 1; i <= 12; i++) writeFileSync(join(cwd, `f${i}.txt`), `file ${i} contents\n`);
  return cwd;
}

/** Best-effort, never fatal: a just-exited `claude` child can still hold the temp cwd on Windows, and
 *  losing a scratch directory must never cost the run's results (an EBUSY here used to swallow them). */
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

interface Attempt {
  label: string;
  subtype: string | undefined;
  turns: number | undefined;
  cost: number | undefined;
  out: number;
  seconds: number;
  session: string | undefined;
}

/** One real SDK query — fresh when `resume` is absent, a warm resume of that session id when present. */
async function attempt(label: string, prompt: string, o: { cwd: string; token: string; args: Args; resume?: string }): Promise<Attempt> {
  const run = new AgentRun({
    model: o.args.model,
    cwd: o.cwd,
    permissionMode: "bypassPermissions",
    settingSources: [],
    maxTurns: o.args.maxTurns,
    oauthToken: o.token,
    ...(o.resume ? { resume: o.resume } : {}),
  });
  let out = 0;
  run.onEvent((e) => {
    if (e.type === "text" || e.type === "thinking" || e.type === "tool_use") out++;
  });
  const startedAt = Date.now();
  run.start(prompt);
  const res = await run.result();
  await run.stop();
  return {
    label,
    subtype: res?.subtype,
    turns: res?.numTurns,
    cost: res?.costUsd,
    out,
    seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    session: run.sessionId,
  };
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

  const cwd = seedWorkspace();
  console.log(`\n=== sdk resume probe · ${args.model} · maxTurns ${args.maxTurns} · ${acct.label} ===`);
  console.log(`workspace ${cwd}\n`);

  const attempts: Attempt[] = [];
  try {
    attempts.push(
      await attempt("fresh", `Read every f*.txt file in ${cwd} ONE AT A TIME with separate Read calls, then summarize each.`, {
        cwd,
        token: acct.token,
        args,
      }),
    );
    let session = attempts[0]?.session;
    for (let i = 1; i <= args.resumes && session; i++) {
      attempts.push(
        await attempt(`resume ${i}`, "Keep going — you stopped at a turn limit, not because you were done. Continue where you left off.", {
          cwd,
          token: acct.token,
          args,
          resume: session,
        }),
      );
      session = attempts[attempts.length - 1]?.session ?? session;
    }
  } finally {
    await cleanup(cwd);
  }

  for (const a of attempts) {
    const flag = a.subtype !== undefined && !/^error/.test(a.subtype) && a.out === 0 ? "  ⚠ SILENT (no output — the run never reached the model)" : "";
    console.log(
      `  ${a.label.padEnd(9)} subtype=${String(a.subtype).padEnd(16)} turns=${String(a.turns).padEnd(4)} out=${String(a.out).padEnd(4)} ` +
        `$${(a.cost ?? 0).toFixed(4)} ${String(a.seconds).padStart(5)}s session=${(a.session ?? "—").slice(0, 8)}${flag}`,
    );
  }

  const silent = attempts.filter((a) => a.subtype !== undefined && !/^error/.test(a.subtype) && a.out === 0);
  const resumed = attempts.slice(1);
  console.log("\n=== verdict ===");
  console.log(`  resumes reusing the same session id: ${resumed.every((a) => a.session === attempts[0]?.session) ? "yes" : "no"}`);
  console.log(`  every resume got a usable turn budget: ${resumed.length > 0 && resumed.every((a) => (a.turns ?? 0) > 0) ? "yes" : "NO"}`);
  console.log(
    silent.length
      ? `  ⚠ ${silent.length} attempt(s) returned success having produced NOTHING — the silent-resume phenomenon still reproduces.`
      : "  ✓ no silent attempt in this run (the phenomenon is intermittent — absence here is not proof it's gone).",
  );
  console.log(`  total spend: $${attempts.reduce((s, a) => s + (a.cost ?? 0), 0).toFixed(4)}\n`);
  process.exit(0);
}

await main();
