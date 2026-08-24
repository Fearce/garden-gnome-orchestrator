// Diagnose auto model selection — "which model did it choose for that task, and was that a good call?".
// Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-model-picks.cjs            # the scoreboard + the 20 most recent picks
//   npm run probe:model-picks --prefix server -- 50 --repo claude-orchestrator
//
// Two sections, because they answer different questions:
//   • THE SCOREBOARD is what the NEXT pick reads (db.modelStats): per-model averages over graded tasks
//     whose whole implementation ran on that one model. If a model looks wrong here, the next selection
//     is being steered by it — that is the feedback loop working, or misfiring, in one table.
//   • THE PICKS are the individual calls, so a suspicious average can be traced to the tasks behind it.
//     An UNGRADED row is normal for a task still running; an ungraded row on a settled task means the
//     ending carried no verdict (a quota park, a restart casualty, a cancel — see modelGrading.ts).
//     `split` marks a task a cap-failover moved across backends: it scores, but credits no model.
//
// The grade rows deliberately OUTLIVE their tasks (no FK — a closed task is purged after 30 days), so a
// pick whose thread is gone still counts here and simply has no state to show.

const path = require("node:path");
const Database = require("better-sqlite3");

const DB = process.env.ORCH_DB || path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

function parseArgs(argv) {
  const out = { limit: 20, repo: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") out.repo = String(argv[++i] ?? "").toLowerCase();
    else if (/^\d+$/.test(argv[i])) out.limit = parseInt(argv[i], 10);
  }
  return out;
}

const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;
const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const mins = (ms) => `${Math.round((ms ?? 0) / 60_000)}m`;
const ago = (at) => {
  const h = (Date.now() - at) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};

/** The same aggregate the selector is handed — kept in SQL so it can't drift from db.modelStats(). */
function scoreboard(db, repo) {
  return db
    .prepare(
      `SELECT provider, graded_model AS model, COUNT(*) AS picks, AVG(score) AS avg_score,
              AVG(CASE WHEN outcome='done' THEN 1.0 ELSE 0.0 END) AS done_rate,
              AVG(COALESCE(qa_rounds,0)) AS avg_qa, AVG(COALESCE(cost_usd,0)) AS avg_cost,
              AVG(COALESCE(duration_ms,0)) AS avg_ms
         FROM model_grades
        WHERE graded_model IS NOT NULL AND score IS NOT NULL${repo ? " AND workspace LIKE @like" : ""}
        GROUP BY provider, graded_model
        ORDER BY picks DESC, avg_score DESC`,
    )
    .all(repo ? { like: `%${repo}%` } : {});
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(DB, { readonly: true });
  db.pragma("busy_timeout = 4000");

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_grades'").get();
  if (!tables) {
    console.log("No model_grades table — this database predates auto model selection.");
    return 0;
  }

  // Counted under the SAME filter as everything below it — a header that reports the whole table while
  // the sections beneath show one repo is the kind of quietly-wrong line nobody re-reads.
  const where = args.repo ? " WHERE workspace LIKE @like" : "";
  const bind = args.repo ? { like: `%${args.repo}%` } : {};
  const total = db.prepare(`SELECT COUNT(*) AS n FROM model_grades${where}`).get(bind).n;
  const graded = db
    .prepare(`SELECT COUNT(*) AS n FROM model_grades${where}${where ? " AND" : " WHERE"} graded_at IS NOT NULL`)
    .get(bind).n;
  const enabled = db.prepare("SELECT value FROM kv WHERE key='setting_auto_model_selection'").get()?.value === "1";
  console.log(`\n=== auto model selection — ${enabled ? "ON" : "off"} ===`);
  console.log(`  ${total} pick(s) recorded, ${graded} graded${args.repo ? `   (repo filter: ${args.repo})` : ""}`);
  if (!total) {
    console.log("\n  Nothing picked yet. Turn the setting on in Settings → Auto model selection; every task\n  dispatched after that is picked and graded.");
    return 0;
  }

  console.log("\n=== the scoreboard the next pick reads ===");
  const rows = scoreboard(db, args.repo);
  if (!rows.length) {
    console.log("  (nothing graded yet — a pick only enters the scoreboard once its task settles with a verdict)");
  } else {
    console.log("  model                                picks  score  accepted   qa   cost    time");
    for (const r of rows) {
      console.log(
        `  ${r.model.padEnd(36)} ${String(r.picks).padStart(4)}  ${String(Math.round(r.avg_score)).padStart(5)}  ${pct(r.done_rate).padStart(8)}  ${r.avg_qa.toFixed(1).padStart(3)}  ${money(r.avg_cost).padStart(6)}  ${mins(r.avg_ms).padStart(5)}`,
      );
    }
  }

  console.log(`\n=== the ${args.limit} most recent picks ===`);
  const picks = db
    .prepare(
      `SELECT g.*, t.state AS thread_state FROM model_grades g LEFT JOIN threads t ON t.id = g.thread_id
        ${args.repo ? "WHERE g.workspace LIKE @like" : ""}
        ORDER BY g.created_at DESC LIMIT @limit`,
    )
    .all(args.repo ? { like: `%${args.repo}%`, limit: args.limit } : { limit: args.limit });
  for (const p of picks) {
    const ungraded = !p.thread_state
      ? "ungraded — its task is no longer in the database (the pick outlives it by design)"
      : ["done", "review", "failed", "cancelled"].includes(p.thread_state)
        ? "ungraded — its ending carried no verdict (quota park / restart / cancel)"
        : `running (${p.thread_state})`;
    const verdict =
      p.graded_at == null
        ? ungraded
        : `${p.outcome} ${p.score == null ? "(not scored)" : `${p.score}/100`} · ${p.qa_rounds ?? 0} QA · ${money(p.cost_usd)} · ${mins(p.duration_ms)}`;
    const split = p.graded_at != null && p.graded_model == null ? `  ⚠ split across ${p.ran_models}` : "";
    console.log(`\n  ${p.thread_id.slice(0, 8)}  ${p.model} @ ${p.effort}   ${ago(p.created_at)}`);
    console.log(`    "${(p.title || "").slice(0, 72)}"`);
    if (p.reason) console.log(`    chose it because: ${p.reason}`);
    console.log(`    → ${verdict}${split}`);
  }
  console.log("");
  return 0;
}

process.exit(main());
