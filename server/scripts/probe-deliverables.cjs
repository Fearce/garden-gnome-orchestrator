// "The owner clicked a deliverable card and got an error": which cards are dead, and why.
// Read-only. Safe while prod is up (WAL + busy_timeout). Opens no browser, serves no bytes.
//
//   node scripts/probe-deliverables.cjs            # the whole store
//   node scripts/probe-deliverables.cjs -- 14      # only findings from the last 14 days
//   npm run probe:deliverables --prefix server
//
// WHY IT EXISTS. A deliverable is the one finding kind carrying an owner-addressable action: the console
// renders View/Download/Copy-path, and the bytes come from `GET /api/deliverable/:id`, which re-derives
// the path from `findings.path` plus the owning task's workspace on EVERY click. So a card can render
// perfectly and still be dead, and nothing notices. The console has no way to know, and the failure only
// surfaces as the owner clicking a card and getting an error page.
//
// That is not hypothetical. The 2026-09-14 "deliverables are missing" task had to hand-derive, from raw
// SQLite, whether the rows still existed and still resolved, purely to answer "is this a persistence bug
// or a UI bug?", which is the question every deliverables report starts with. The first run of this probe
// against the live database answered it in one command AND found a second, unreported defect nobody had
// asked about: 32 of 268 persisted cards were already unserveable, 12 of them because the agent surfaced
// a file from its own harness scratchpad, which is outside the task workspace by construction and can
// therefore never be served (403), not even at the instant it was posted.
//
// WHAT IT CHECKS. The classifier below is a deliberate MIRROR of the route in `server/src/index.ts`
// (`/api/deliverable/:id`): same order, same checks, same 25 MB cap, so a class here is the HTTP status
// the owner would actually get. Keep the two in step. The whole value of this probe is that its verdict
// is the route's verdict, and a mirror that has drifted is worse than no probe at all.
//
// WHAT IS RED, AND WHY ONLY THAT. Exiting non-zero on "a file went away" would make this permanently red
// over the owner's own housekeeping. Deleting a months-old screenshot is not a defect, and a probe that
// is always red stops being read (`nightly-quality-sweep.md`). So a missing file is a WARNING, however
// old, and only three things fail the probe, each of them a defect at EMISSION time that code owns:
//   - a deliverable with no path at all: an emission path bypassed validation, and the route 404s always.
//   - a deliverable whose task row is gone: the FK says impossible, so seeing one means it happened.
//   - a RECENT deliverable that escapes its workspace. This one was never serveable, not for a minute.
//     It is the agent's path being wrong when it posted, so a recent one means it is still happening now.
//     Older escapes are the same defect already committed to history: reported, never red.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
/** Must equal MAX_DELIVERABLE_BYTES in `server/src/index.ts`. A smaller value here invents failures. */
const MAX_DELIVERABLE_BYTES = 25 * 1024 * 1024;
/** How recent an escape has to be to count as "still happening" rather than history. */
const LIVE_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** The owner-facing meaning of each class, keyed to the HTTP status the route would actually return. */
const CLASSES = {
  ok: { http: 200, text: "serves" },
  "no-path": { http: 404, text: "no path recorded, so the route cannot even look" },
  "no-task": { http: 404, text: "its task row is gone, so there is nothing to resolve against" },
  "workspace-gone": { http: 404, text: "the task workspace no longer exists on disk" },
  missing: { http: 404, text: "the file is gone" },
  escapes: { http: 403, text: "resolves OUTSIDE the task workspace, so it was never serveable" },
  "not-a-file": { http: 404, text: "not a regular file" },
  "too-large": { http: 413, text: `over the ${MAX_DELIVERABLE_BYTES / 1048576} MB serving cap` },
};

/**
 * Classify one deliverable exactly the way `GET /api/deliverable/:id` would, in the route's own order.
 * `io` is injected so the gate can drive the branches against real temp files without a live database.
 */
function classifyDeliverable(row, io = fs) {
  if (!row.workspace) return { class: "no-task" };
  if (!row.path || !row.path.trim()) return { class: "no-path" };

  const candidate = path.isAbsolute(row.path) ? row.path : path.join(row.workspace, row.path);

  // Resolve symlinks on BOTH sides, as the route does: a link inside the workspace pointing out of it
  // must not pass containment, and the comparison has to be between canonical, same-cased paths.
  let realWs;
  try {
    realWs = io.realpathSync(row.workspace);
  } catch {
    return { class: "workspace-gone", candidate };
  }
  let realFile;
  try {
    realFile = io.realpathSync(candidate);
  } catch {
    return { class: "missing", candidate };
  }

  const rel = path.relative(realWs, realFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { class: "escapes", candidate, resolved: realFile };
  }

  let st;
  try {
    st = io.statSync(realFile);
  } catch {
    return { class: "missing", candidate };
  }
  if (!st.isFile()) return { class: "not-a-file", candidate, resolved: realFile };
  if (st.size > MAX_DELIVERABLE_BYTES) return { class: "too-large", candidate, resolved: realFile, bytes: st.size };
  return { class: "ok", candidate, resolved: realFile, bytes: st.size };
}

/**
 * docs/agent-reference/CLAUDE-full.md documents one recurring way a deliverable 404s: a RELATIVE path resolves against the task
 * WORKSPACE, which here is routinely the PARENT of the git checkout, so a file saved into the repo is
 * not found. That is a fixable mistake rather than rot, so when a relative path is missing, look one
 * level down for the same basename and name the absolute path that WOULD have worked.
 */
function suggestWorkspaceRelativeFix(row, io = fs) {
  if (!row.path || path.isAbsolute(row.path)) return null;
  const wanted = path.basename(row.path);
  let entries;
  try {
    entries = io.readdirSync(row.workspace, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    for (const guess of [path.join(row.workspace, entry.name, row.path), path.join(row.workspace, entry.name, wanted)]) {
      try {
        if (io.statSync(guess).isFile()) return guess;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** An escape whose real path sits in the agent harness's own scratch area, which no task workspace contains. */
function looksLikeAgentScratch(p) {
  return /[\\/](scratchpad|scratch)[\\/]/i.test(p || "") || /[\\/]Temp[\\/]claude[\\/]/i.test(p || "");
}

/**
 * The census plus the verdict. Only an emission-time defect is fatal (see the header for why a missing
 * file never is). `now` is injected so the gate can pin the live window instead of racing the clock.
 */
function verdictFor(classified, { now = Date.now(), windowDays = LIVE_WINDOW_DAYS } = {}) {
  const counts = {};
  for (const r of classified) counts[r.class] = (counts[r.class] ?? 0) + 1;

  const broken = classified.filter((r) => r.class !== "ok");
  const liveEscapes = classified.filter((r) => r.class === "escapes" && now - r.createdAt <= windowDays * DAY_MS);
  const noPath = classified.filter((r) => r.class === "no-path");
  const noTask = classified.filter((r) => r.class === "no-task");

  const problems = [];
  if (noPath.length) {
    problems.push({ fatal: true, text: `${noPath.length} deliverable(s) recorded with no path: an emission path skipped validation` });
  }
  if (noTask.length) {
    problems.push({ fatal: true, text: `${noTask.length} deliverable(s) whose task row is gone: the cascade or the write order is wrong` });
  }
  if (liveEscapes.length) {
    const scratch = liveEscapes.filter((r) => looksLikeAgentScratch(r.resolved ?? r.candidate)).length;
    problems.push({
      fatal: true,
      text:
        `${liveEscapes.length} deliverable(s) posted in the last ${windowDays}d resolve OUTSIDE their task workspace` +
        (scratch ? ` (${scratch} of them from an agent's own scratch area)` : "") +
        ", so those cards 403 the moment they are created",
    });
  }
  const staleEscapes = counts.escapes ? counts.escapes - liveEscapes.length : 0;
  if (staleEscapes) {
    problems.push({ fatal: false, text: `${staleEscapes} older escaping deliverable(s): the same defect, already in history` });
  }
  if (counts.missing || counts["workspace-gone"]) {
    problems.push({
      fatal: false,
      text: `${(counts.missing ?? 0) + (counts["workspace-gone"] ?? 0)} deliverable(s) whose file is gone, which is often the owner's own housekeeping and never a code defect`,
    });
  }
  if (counts["too-large"]) {
    problems.push({ fatal: false, text: `${counts["too-large"]} deliverable(s) over the serving cap: the card renders and the download 413s` });
  }
  if (counts["not-a-file"]) {
    problems.push({ fatal: false, text: `${counts["not-a-file"]} deliverable(s) pointing at a directory or device` });
  }

  return {
    counts,
    total: classified.length,
    servable: counts.ok ?? 0,
    broken: broken.length,
    problems,
    fatal: problems.some((p) => p.fatal),
    ok: problems.length === 0,
  };
}

function loadRows(db, sinceDays) {
  const since = sinceDays ? Date.now() - sinceDays * DAY_MS : 0;
  return db
    .prepare(
      `SELECT f.id, f.thread_id AS threadId, f.path, f.label, f.summary, f.created_at AS createdAt,
              f.from_role AS role, t.workspace, t.title, t.state
         FROM findings f
         LEFT JOIN threads t ON t.id = f.thread_id
        WHERE f.kind = 'deliverable' AND f.created_at >= ?
        ORDER BY f.created_at DESC`,
    )
    .all(since);
}

const ageOf = (ms) => {
  const days = (Date.now() - ms) / DAY_MS;
  return days < 1 ? `${Math.max(1, Math.round(days * 24))}h` : `${Math.round(days)}d`;
};

function main() {
  const argDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)));
  const sinceDays = Number.isFinite(argDays) && argDays > 0 ? argDays : 0;

  if (!fs.existsSync(DB_PATH)) {
    console.log(`no database at ${DB_PATH}, so there is nothing to read`);
    return;
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 4000");

  const rows = loadRows(db, sinceDays);
  const classified = rows.map((r) => ({ ...r, ...classifyDeliverable(r) }));
  db.close();

  const scope = sinceDays ? `last ${sinceDays}d` : "all time";
  console.log(`\n=== deliverable cards (${scope}, ${DB_PATH}) ===`);
  if (!classified.length) {
    console.log("  no deliverables recorded, so there is nothing to check");
    return;
  }

  const verdict = verdictFor(classified);
  console.log(`  ${verdict.total} card(s) · ${verdict.servable} serve · ${verdict.broken} would fail on click`);
  for (const [cls, n] of Object.entries(verdict.counts).sort((a, b) => b[1] - a[1])) {
    if (cls === "ok") continue;
    console.log(`    ${String(n).padStart(4)} × ${cls.padEnd(14)} HTTP ${CLASSES[cls].http}: ${CLASSES[cls].text}`);
  }

  const broken = classified.filter((r) => r.class !== "ok");
  if (broken.length) {
    console.log("\n=== every card that would fail, newest first ===");
    for (const r of broken) {
      const who = (r.title ?? "(task gone)").slice(0, 46);
      console.log(`  ${CLASSES[r.class].http} ${r.class.padEnd(14)} ${ageOf(r.createdAt).padStart(4)} ago  ${who}`);
      console.log(`      ${r.label || r.summary}`);
      console.log(`      path: ${r.path ?? "(none)"}`);
      if (r.class === "escapes") {
        console.log(`      -> workspace ${r.workspace} does not contain ${r.resolved}`);
        if (looksLikeAgentScratch(r.resolved ?? r.candidate)) {
          console.log("      -> that is the agent's own scratch area; copy the file INTO the workspace before posting it");
        }
      }
      if (r.class === "missing") {
        const fix = suggestWorkspaceRelativeFix(r);
        if (fix) console.log(`      -> a relative path resolves against the WORKSPACE, not the repo; this file is at ${fix}`);
      }
      if (r.class === "too-large") console.log(`      -> ${(r.bytes / 1048576).toFixed(1)} MB`);
    }
  }

  console.log("\n=== verdict ===");
  if (verdict.ok) {
    console.log("  ✓ every recorded deliverable still resolves, is contained, and is under the serving cap");
  } else {
    for (const p of verdict.problems) console.log(`  ${p.fatal ? "✗" : "⚠"} ${p.text}`);
  }
  if (verdict.fatal) {
    console.log("\n  ✗ a card was born broken. That is emission-side: the path an agent posted could never be served.");
    process.exitCode = 1;
  } else if (!verdict.ok) {
    console.log("\n  ⚠ nothing is being created broken; the rows above are history or the owner's own file cleanup.");
  }
}

if (require.main === module) main();

module.exports = {
  classifyDeliverable,
  suggestWorkspaceRelativeFix,
  looksLikeAgentScratch,
  verdictFor,
  MAX_DELIVERABLE_BYTES,
  LIVE_WINDOW_DAYS,
};
