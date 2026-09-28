// Where the Claude tokens actually go — "my usage was higher overnight with fewer agents, why?".
// Read-only. Safe while prod is up.
//
//   npm run probe:token-burn --prefix server                  last 3 days
//   npm run probe:token-burn --prefix server -- --days 7      a longer window
//   npm run probe:token-burn --prefix server -- --json        machine-readable, for a sweep
//
// Why it exists: many agents were asked to "optimize token efficiency" and none found the two biggest
// leaks, because every one of them reasoned about prompts and code instead of MEASURING. On a
// subscription ~98% of Claude tokens are cache reads, and a cache read is the WHOLE context re-read on
// every API call, so cost = calls × context size. Nothing in GGO showed context size per call:
//   • Turn-limit resumes reloaded the full session, so context stacked to ~1M before the CLI compacted
//     (fixed `fcce590` reseed, `952ea45` 300k compaction). Visible here as "context per call" doubling
//     day over day and as the share of tokens spent at a context above AUTO_COMPACT_K.
//   • `agent_runs` token/cost columns held the SESSION-cumulative totals the CLI restores on --resume,
//     so a 1-minute, 1-call run recorded 149M tokens and summing a task's rows double-counted every
//     earlier run (fixed with `agents/sessionUsage.ts`). Visible here as DB-vs-transcript drift.
//
// So it reads the transcripts, which log every API call's real usage, and checks what would have
// caught both on the day they appeared. Claude runs only: Codex/Grok keep no per-call transcript here.
//
// GOTCHAS:
//   • A run's calls are the transcript calls inside its [started_at, ended_at] window; one assistant
//     message streams as several lines with the same message id, so calls are deduplicated by id.
//   • Rows written before the sessionUsage fix are inflated by design — the drift check will flag old
//     resumed runs until they age out of the window. That is the old data, not a regression; a drift
//     on a run started after the fix IS one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const AUTO_COMPACT_K = 300;
const HEAVY_SHARE_WARN = 0.2;
const DAY_JUMP_WARN = 1.5;
const DRIFT_WARN = 1.3;
const WINDOW_SLACK_MS = 5000;

const argv = process.argv.slice(2);
const days = Number(argv[argv.indexOf("--days") + 1]) || 3;
const asJson = argv.includes("--json");
const M = (n) => +(n / 1e6).toFixed(1);
const K = (n) => Math.round(n / 1e3);

function sessionFiles() {
  const index = new Map();
  for (const dir of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(PROJECTS, dir.name))) {
      if (name.endsWith(".jsonl")) index.set(name.slice(0, -6), path.join(PROJECTS, dir.name, name));
    }
  }
  return index;
}

function transcriptCalls(file) {
  const calls = new Map();
  const compactions = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.includes('"compact_boundary"')) {
      try {
        compactions.push(Date.parse(JSON.parse(line).timestamp));
      } catch {}
      continue;
    }
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const u = entry.type === "assistant" ? entry.message?.usage : undefined;
    if (!u || calls.has(entry.message.id)) continue;
    const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    calls.set(entry.message.id, { at: Date.parse(entry.timestamp), context, tokens: context + (u.output_tokens || 0) });
  }
  return { calls: [...calls.values()].sort((a, b) => a.at - b.at), compactions };
}

function measureRuns(db, since) {
  const runs = db
    .prepare(
      `SELECT r.id, r.thread_id, r.role, r.model, r.session_id, r.started_at, r.ended_at, r.total_tokens, r.error, t.title
         FROM agent_runs r LEFT JOIN threads t ON t.id = r.thread_id
        WHERE r.started_at > ? AND r.session_id IS NOT NULL AND r.model LIKE 'claude%'
        ORDER BY r.started_at`,
    )
    .all(since);
  const firstRunOfSession = new Map(
    db.prepare(`SELECT session_id, MIN(started_at) first FROM agent_runs WHERE session_id IS NOT NULL GROUP BY session_id`).all().map((r) => [r.session_id, r.first]),
  );
  const files = sessionFiles();
  const cache = new Map();
  const measured = [];
  for (const run of runs) {
    const file = files.get(run.session_id);
    if (!file) continue;
    if (!cache.has(file)) cache.set(file, transcriptCalls(file));
    const { calls, compactions } = cache.get(file);
    const from = run.started_at - WINDOW_SLACK_MS;
    const to = (run.ended_at ?? Date.now()) + WINDOW_SLACK_MS;
    const own = calls.filter((c) => c.at >= from && c.at <= to);
    if (!own.length) continue;
    measured.push({
      ...run,
      resumed: firstRunOfSession.get(run.session_id) < run.started_at,
      calls: own.length,
      tokens: own.reduce((s, c) => s + c.tokens, 0),
      heavyTokens: own.filter((c) => c.context > AUTO_COMPACT_K * 1e3).reduce((s, c) => s + c.tokens, 0),
      firstContext: own[0].context,
      maxContext: Math.max(...own.map((c) => c.context)),
      compactions: compactions.filter((at) => at >= from && at <= to).length,
    });
  }
  return measured;
}

const day = (ms) => new Date(ms).toLocaleDateString("sv-SE");
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

function byDay(runs) {
  const rows = new Map();
  for (const r of runs) {
    const key = `${day(r.started_at)} ${r.role}`;
    const row = rows.get(key) ?? { day: day(r.started_at), role: r.role, runs: 0, calls: 0, tokensM: 0, heavy: 0, compactions: 0 };
    row.runs++;
    row.calls += r.calls;
    row.tokensM += r.tokens;
    row.heavy += r.heavyTokens;
    row.compactions += r.compactions;
    rows.set(key, row);
  }
  return [...rows.values()].map((r) => ({
    day: r.day,
    role: r.role,
    runs: r.runs,
    calls: r.calls,
    tokensM: M(r.tokensM),
    ctxPerCallK: K(r.tokensM / r.calls),
    [`over${AUTO_COMPACT_K}k`]: `${Math.round((100 * r.heavy) / r.tokensM)}%`,
    compactions: r.compactions,
  }));
}

function byThread(runs) {
  const rows = new Map();
  for (const r of runs) {
    const row = rows.get(r.thread_id) ?? { title: (r.title ?? r.thread_id).slice(0, 48), runs: 0, resumes: 0, calls: 0, tokens: 0, reload: 0, maxContext: 0, turnLimits: 0 };
    row.runs++;
    row.calls += r.calls;
    row.tokens += r.tokens;
    row.maxContext = Math.max(row.maxContext, r.maxContext);
    if (r.resumed) {
      row.resumes++;
      row.reload += r.firstContext;
    }
    if (/turn (limit|ceiling)|max_turns/i.test(r.error ?? "")) row.turnLimits++;
    rows.set(r.thread_id, row);
  }
  return [...rows.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12)
    .map((r) => ({ ...r, tokens: M(r.tokens), reload: M(r.reload), ctxPerCallK: K(r.tokens / r.calls), maxContext: K(r.maxContext) }));
}

function warnings(runs, days) {
  const out = [];
  const total = runs.reduce((s, r) => s + r.tokens, 0);
  const heavy = runs.reduce((s, r) => s + r.heavyTokens, 0);
  if (total && heavy / total > HEAVY_SHARE_WARN) {
    out.push(`${Math.round((100 * heavy) / total)}% of tokens were spent at a context above ${AUTO_COMPACT_K}k — sessions are growing past the compaction window (check CLAUDE_CODE_AUTO_COMPACT_WINDOW reaches the CLI, and resume reseeding).`);
  }
  const perDay = new Map();
  for (const r of runs.filter((r) => r.role === "implementor")) {
    const d = perDay.get(day(r.started_at)) ?? { tokens: 0, calls: 0 };
    d.tokens += r.tokens;
    d.calls += r.calls;
    perDay.set(day(r.started_at), d);
  }
  const ordered = [...perDay.entries()].sort();
  for (let i = 1; i < ordered.length; i++) {
    const [prevDay, prev] = ordered[i - 1];
    const [curDay, cur] = ordered[i];
    const ratio = cur.tokens / cur.calls / (prev.tokens / prev.calls);
    if (ratio > DAY_JUMP_WARN) out.push(`implementor context per call jumped ${ratio.toFixed(1)}× from ${prevDay} to ${curDay} — the same work is re-reading a much larger context.`);
  }
  const drifted = runs.filter((r) => r.total_tokens && r.total_tokens > r.tokens * DRIFT_WARN && r.total_tokens - r.tokens > 1e6);
  if (drifted.length) {
    const excess = drifted.reduce((s, r) => s + (r.total_tokens - r.tokens), 0);
    out.push(`${drifted.length} run(s) record ${M(excess)}M more tokens in agent_runs than their transcripts hold — the DB is over-counting (session-cumulative usage?). Newest: ${drifted.at(-1).id} started ${new Date(drifted.at(-1).started_at).toISOString()}.`);
  }
  const reload = runs.filter((r) => r.resumed).reduce((s, r) => s + r.firstContext, 0);
  if (total && reload / total > 0.1) out.push(`${Math.round((100 * reload) / total)}% of tokens are resumes re-reading their session on the first call.`);
  return out;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const since = Date.now() - days * 86400e3;
  const runs = measureRuns(db, since);
  const fresh = runs.filter((r) => !r.resumed);
  const startContext = [...new Set(fresh.map((r) => r.role))].map((role) => {
    const xs = fresh.filter((r) => r.role === role).map((r) => r.firstContext);
    return { role, freshRuns: xs.length, medianStartK: K(median(xs)), maxStartK: K(Math.max(...xs)) };
  });
  const report = { days, runs: runs.length, byDay: byDay(runs), startContext, topThreads: byThread(runs), warnings: warnings(runs, days) };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Claude token burn, last ${days} day(s) — ${runs.length} runs measured from transcripts\n`);
  console.log("By day and role (tokens = every API call's input + cache + output; ctxPerCall is the cost driver):");
  console.table(report.byDay);
  console.log("Context a FRESH run starts with (the prompt every one of its calls re-reads):");
  console.table(startContext);
  console.log("Top threads (reload = tokens resumes spent re-reading their session on the first call):");
  console.table(report.topThreads);
  if (report.warnings.length) for (const w of report.warnings) console.log(`⚠ ${w}`);
  else console.log("✓ no burn pattern crossed a warning threshold");
}

main();
