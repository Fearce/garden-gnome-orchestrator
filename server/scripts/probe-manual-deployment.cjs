// Name every task that GGO already finished but that still waits on the owner to deploy by hand —
// and every handoff that was REFUSED, with the reason. Read-only. Safe while prod is up (WAL +
// busy_timeout); `--fetch` is the one opt-in that touches the network, and only remote-tracking refs.
//
//   node scripts/probe-manual-deployment.cjs [--fetch] [--json]
//   npm run probe:manual-deployment --prefix server
//
// Why it exists: the manual-deployment handoff settles such a task `done` instead of parking it in
// `review`. That is the point of the feature — a verified change waiting only on the owner must stop
// burning Supervisor/auto-review tokens — but it also moved that work OUT of the one place anything
// listed it. `probe:parks` reads `review` and `failed`; a task waiting on the owner's own deploy is now
// in neither, so between shipping the feature and shipping this probe the queue was invisible: GGO
// considered the work finished, and nothing on the box could answer "what is waiting on me to deploy?"
// This is that list, plus the two invariants that make it trustworthy.
//
// The distinction that matters here is NOT done-vs-parked. It is:
//   • WAITING — the marker is `verified`, the task is `done`, and the declared commit is still local.
//     Nothing is coming for it: no supervisor, no auto-review, no resume. Only the owner deploying it.
//   • DISCHARGED — the same marker, but the declared commit is now an ancestor of its declared remote
//     ref, so it was pushed. Kept visible for one listing rather than dropped, because "did that go out?"
//     is the question asked right after "what is waiting?".
//   • REFUSED — an agent asserted a handoff and the server's independent Git/orchestration check said no.
//     That is the system working, but the reason is the fastest answer to "why did my task not settle?".
//
// GOTCHAS:
//   • A remote-tracking ref is only as fresh as the last `git fetch`, so a commit the owner pushed from
//     another machine reads as WAITING until this checkout fetches. Every row is therefore stamped with
//     that repo's last-fetch age, and `--fetch` refreshes the tracking refs first (it never touches the
//     worktree, the index or HEAD — safe while an agent is mid-edit in the same tree).
//   • The task workspace is often the PARENT of the checkout (workspace `…\project`, repo
//     `…\project\service`), which is what made the server's first Git verification reject valid
//     handoffs. Resolve the repo by asking which candidate actually CONTAINS the claimed commit — the
//     same key the server settled on. Never by directory name.
//   • `verified` is the only status that means done. `declared` is an implementor's assertion that no
//     verification boundary has crossed yet, and it is NOT owner-actionable — listing the two together
//     would put unverified claims on the owner's deploy queue.
//   • Exit is non-zero ONLY for the two real defects below, never for a long queue. A task waiting six
//     weeks on the owner is the owner's call; a `verified` marker on a task that never reached `done`,
//     or a settled task whose owner-visible "deploy this" note is missing, are bugs in the settle path.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const ENV_PATH = path.resolve(__dirname, "..", ".env");

// Mirrors orchestrator/manualDeployment.ts. A settled handoff posts this finding and a matching feed
// line; its absence on a done task is the "silently skipped deployment" the feature exists to prevent.
const HANDOFF_SUMMARY = "Complete in GGO — manual deployment pending";

const CLASSES = [
  { key: "waiting", title: "waiting on your manual deployment" },
  { key: "discharged", title: "already pushed since the handoff" },
  { key: "declared", title: "declared, no verification boundary crossed yet" },
  { key: "refused", title: "handoff refused by the server's own check" },
];

function git(cwd, args, timeout = 10_000) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim() };
}

/** The claimed commit is the key, not the directory name: a workspace may be the parent of the real
 * checkout, and a parent may hold several. Ask each candidate whether it has that object. */
function resolveRepo(workspace, commitSha) {
  if (!workspace || !fs.existsSync(workspace)) return null;
  const candidates = [];
  const direct = git(workspace, ["rev-parse", "--show-toplevel"]);
  if (direct.ok && direct.stdout) candidates.push(direct.stdout);
  else {
    let entries = [];
    try {
      entries = fs.readdirSync(workspace, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(workspace, entry.name, ".git"))) continue;
      const root = git(path.join(workspace, entry.name), ["rev-parse", "--show-toplevel"]);
      if (root.ok && root.stdout && !candidates.includes(root.stdout)) candidates.push(root.stdout);
    }
  }
  const owning = candidates.find((root) => git(root, ["cat-file", "-e", `${commitSha}^{commit}`]).ok);
  return owning ?? candidates[0] ?? null;
}

function lastFetchAgeMs(repoRoot) {
  const gitDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (!gitDir.ok || !gitDir.stdout) return null;
  for (const name of ["FETCH_HEAD", "HEAD"]) {
    try {
      return Date.now() - fs.statSync(path.join(gitDir.stdout, name)).mtimeMs;
    } catch {
      /* a checkout that has never fetched has no FETCH_HEAD; fall through to HEAD */
    }
  }
  return null;
}

/** Has the declared commit reached the ref the claim was verified against? That, and only that, is what
 * separates "still on the owner's desk" from "on its way". */
function pushState(repoRoot, claim, doFetch) {
  if (!repoRoot) return { key: "unknown", note: "the checkout could not be resolved from the workspace" };
  if (doFetch) {
    const remote = String(claim.remoteRef).replace(/^refs\/remotes\//, "").split("/")[0];
    git(repoRoot, ["fetch", "--quiet", remote], 60_000);
  }
  if (!git(repoRoot, ["cat-file", "-e", `${claim.commitSha}^{commit}`]).ok) {
    return { key: "unknown", note: `${claim.commitSha.slice(0, 12)} is not in ${repoRoot}` };
  }
  if (!git(repoRoot, ["rev-parse", "--verify", `${claim.remoteRef}^{commit}`]).ok) {
    return { key: "unknown", note: `${claim.remoteRef} does not resolve in this checkout` };
  }
  const contained = git(repoRoot, ["merge-base", "--is-ancestor", claim.commitSha, claim.remoteRef]).ok;
  const fetchAge = lastFetchAgeMs(repoRoot);
  const stamp = fetchAge == null ? "never fetched" : `last fetch ${humanAge(fetchAge)} ago`;
  return contained
    ? { key: "pushed", note: `on ${claim.remoteRef} (${stamp})` }
    : { key: "local", note: `not yet on ${claim.remoteRef} (${stamp})` };
}

function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function readEnv(key) {
  try {
    const line = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((row) => row.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : "";
  } catch {
    return "";
  }
}

function stageOutputs(row) {
  try {
    return JSON.parse(row.stage_outputs || "{}") || {};
  } catch {
    return {};
  }
}

/** Pure, so the gate can drive every branch without a database or a repository. `push` is supplied by
 * the caller because resolving it costs Git calls; classification itself must stay total. */
function classifyManualDeployment(marker, attempt, threadState, push) {
  if (marker && marker.status === "verified") {
    if (push && push.key === "pushed") return { key: "discharged" };
    return { key: "waiting" };
  }
  if (marker && marker.status === "declared") return { key: "declared" };
  if (marker && marker.status === "invalidated") {
    return { key: "refused", reason: marker.invalidReason || "no reason was recorded" };
  }
  if (attempt) return { key: "refused", reason: attempt.reason || "no reason was recorded" };
  return null;
}

/** The two states that are defects rather than queue depth. Kept beside the classifier so the gate pins
 * both, and so a future settle-path change cannot quietly stop posting the owner's note. */
function invariantFailures(entry) {
  const failures = [];
  const settled = ["done", "cancelled", "closed"];
  if (entry.marker && entry.marker.status === "verified" && !settled.includes(entry.state)) {
    failures.push(`verified handoff but the task is ${entry.state}, not done — the settle path did not complete`);
  }
  if (entry.marker && entry.marker.status === "verified" && entry.state === "done" && !entry.hasHandoffNote) {
    failures.push("settled done without the owner-visible deploy note — it looks like a silent deployment");
  }
  return failures;
}

function collect(db) {
  const rows = db
    .prepare("SELECT id, title, state, workspace, stage_outputs, updated_at FROM threads WHERE stage_outputs LIKE '%manualDeployment%'")
    .all();
  const noteThreads = new Set(
    db.prepare("SELECT DISTINCT thread_id FROM findings WHERE summary=?").all(HANDOFF_SUMMARY).map((row) => row.thread_id),
  );
  const entries = [];
  for (const row of rows) {
    const stage = stageOutputs(row);
    const marker = stage.manualDeployment && typeof stage.manualDeployment === "object" ? stage.manualDeployment : null;
    const attempt = stage.manualDeploymentAttempt && typeof stage.manualDeploymentAttempt === "object" ? stage.manualDeploymentAttempt : null;
    if (!marker && !attempt) continue;
    entries.push({
      id: row.id,
      title: row.title || "(untitled)",
      state: row.state,
      workspace: row.workspace,
      marker,
      attempt,
      claim: marker && marker.claim ? marker.claim : null,
      at: (marker && (marker.verifiedAt || marker.declaredAt)) || (attempt && attempt.at) || row.updated_at,
      hasHandoffNote: noteThreads.has(row.id),
    });
  }
  return entries.sort((a, b) => a.at - b.at);
}

function main() {
  const args = process.argv.slice(2);
  const doFetch = args.includes("--fetch");
  const asJson = args.includes("--json");

  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}`);
    process.exit(2);
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");

  const entries = collect(db);
  for (const entry of entries) {
    if (entry.claim && entry.marker && entry.marker.status === "verified") {
      entry.repoRoot = resolveRepo(entry.workspace, entry.claim.commitSha);
      entry.push = pushState(entry.repoRoot, entry.claim, doFetch);
    }
    entry.class = classifyManualDeployment(entry.marker, entry.attempt, entry.state, entry.push);
    entry.failures = invariantFailures(entry);
  }
  db.close();

  const pattern = readEnv("NO_PUSH_REPO_PATTERN");
  const failures = entries.filter((entry) => entry.failures.length);

  if (asJson) {
    console.log(JSON.stringify({ pattern, entries: entries.map(({ repoRoot, ...rest }) => ({ ...rest, repoRoot })) }, null, 2));
    process.exit(failures.length ? 1 : 0);
  }

  console.log(`\n=== manual deployment handoffs ===`);
  console.log(`  commit-only rule: ${pattern ? `origin contains "${pattern}"` : "NOT CONFIGURED (NO_PUSH_REPO_PATTERN is empty — no repo can hand off)"}`);
  if (!entries.length) {
    console.log("  ✓ no task has ever declared a manual deployment — nothing is waiting on you to deploy.");
  }

  for (const { key, title } of CLASSES) {
    const group = entries.filter((entry) => entry.class && entry.class.key === key);
    if (!group.length) continue;
    console.log(`\n=== ${title} (${group.length}) ===`);
    for (const entry of group) {
      console.log(`  ${entry.id.slice(0, 8)}  ${entry.title.slice(0, 68)}`);
      if (entry.claim) {
        console.log(
          `      env ${entry.claim.environment} · commit ${entry.claim.commitSha.slice(0, 12)} · ` +
            `${key === "declared" ? "declared" : "verified"} ${humanAge(Date.now() - entry.at)} ago` +
            `${entry.marker && entry.marker.verifiedBy ? ` by ${entry.marker.verifiedBy}` : ""}`,
        );
      }
      if (entry.push) console.log(`      ↳ ${entry.push.key === "pushed" ? "pushed" : entry.push.key === "local" ? "LOCAL ONLY" : "unknown"} — ${entry.push.note}`);
      if (key === "waiting" && entry.claim) console.log(`      ↳ deploy: ${entry.claim.instructions.replace(/\s+/g, " ").slice(0, 200)}`);
      if (entry.class.reason) console.log(`      ↳ refused: ${String(entry.class.reason).replace(/\s+/g, " ").slice(0, 200)}`);
      for (const failure of entry.failures) console.log(`      ⚠ ${failure}`);
    }
  }

  const waiting = entries.filter((entry) => entry.class && entry.class.key === "waiting").length;
  console.log(
    `\n  ${waiting ? "⚠" : "✓"} ${waiting} task(s) finished in GGO and waiting on your deploy, ` +
      `${entries.filter((entry) => entry.class && entry.class.key === "declared").length} unverified, ` +
      `${entries.filter((entry) => entry.class && entry.class.key === "refused").length} refused.`,
  );
  if (failures.length) console.log(`  ⚠ ${failures.length} settle-path defect(s) above — those are bugs, not queue depth.`);
  console.log("  ↳ full run trail for any one: npm run probe:task-runs --prefix server -- <id>");
  process.exit(failures.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { classifyManualDeployment, invariantFailures, resolveRepo, pushState, humanAge, HANDOFF_SUMMARY, CLASSES };
