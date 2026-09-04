// Is cross-machine coordination actually WORKING — and is any of this traffic an instance talking to
// itself? Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-office.cjs
//   npm run probe:office --prefix server
//
// Why it exists: on 2026-08-25 the operator reported "we are 2 connected working on the same repo and it doesn't
// seem like our gnomes are collaborating". The relay was healthy, both machines were on it, and the agents
// had genuinely exchanged file claims — every surface anyone could check said fine. Diagnosing it meant
// hand-writing SQLite one-liners and curling the relay, because NOTHING in the sweep looks at the online
// office at all. The two defects behind it were both invisible-by-construction, and both are checked here:
//
//   • The relay handed every instance its OWN agents and its OWN replayed chat back. `applyChat` skipped
//     the sender for LIVE chat, so the rule looked implemented while three other paths leaked. An instance
//     receiving itself is not cosmetic: `repoPeers` is the office ON-switch, so every solo agent believed
//     it had a teammate (itself) and the top bar drew the owner's own machine as a foreign one.
//   • A room holding a real cross-machine conversation was UNREACHABLE in the console, because every
//     chatroom surface counted local tasks only and a remote line carries no task.
//
// Both are provable from local data alone, which is what makes them checkable every night.
//
// GOTCHAS:
//   • `isCollaborationRoom` is IMPORTED from the built app (`dist/types.js`), never re-implemented here.
//     A hand-copied predicate is how this repo has been burned before (`CAP_RE`, `MIRRORED_HEADROOM_TERMS`)
//     — the probe would drift into reporting the room reachable long after the app stopped agreeing.
//   • The self-echo check is TIME-BOUNDED against the fix. Rows written before it are residue and are
//     reported as a note, not a failure: a check that cries wolf every night stops being read, and this
//     one would have gone permanently red on two pre-fix rows sitting in the operator's old room forever.
//   • Never open the DB through `Db` — its constructor RUNS MIGRATIONS. Read-only sqlite only.
//   • Nothing here prints the device token or the join code. The instance NAME is public (every peer
//     sees it); the credentials are not, and this output goes into a sweep transcript.

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

/**
 * The sender-filter fix, for the message text only — the BOUNDARY comes from the database.
 *
 * A line carrying this instance's own name before the fix is residue; after it, a live regression. The
 * boundary must therefore be "when did the fixed build first run HERE", and a hardcoded date is not that:
 * the bug was reported and fixed within one morning, so a date-granularity constant flagged two rows
 * written ninety minutes before the fix and went red on a healthy office — the exact cry-wolf failure
 * that makes a nightly check stop being read. `remote_instance_backfill_v1` is the honest boundary: the
 * fixed build stamps it on its first boot, so it dates itself per machine and needs no maintenance.
 */
const SELF_ECHO_FIX = { sha: "4f655c6", when: "2026-08-25", kv: "remote_instance_backfill_v1" };

/** The app's own answer to "is this room a collaboration the console will show?" — imported, never
 *  re-derived. Returns null when the server hasn't been built, so the caller can say so plainly. */
function loadIsCollaborationRoom() {
  try {
    return require(path.resolve(__dirname, "..", "dist", "types.js")).isCollaborationRoom;
  } catch {
    return null;
  }
}

function openDb() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

function readConfig(db) {
  const kv = (key) => db.prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value ?? "";
  return {
    enabled: kv("online_office_enabled") === "1",
    url: kv("online_office_url"),
    name: kv("online_office_name"),
    joined: !!kv("online_office_token"), // presence only — the token itself is never read out
    unlinked: parseUnlinked(kv("online_office_unlinked")),
    // When the fixed build first booted here. Absent = it never has, so nothing below can be a regression.
    fixAt: Number(kv(SELF_ECHO_FIX.kv)) || null,
  };
}

/**
 * The relay's one-line headline. Every count is OPTIONAL because the relay decides what an anonymous
 * caller may know, and that decision moves: `members` went behind the admin key in `970ab04` (how many
 * devices have joined is a membership fact), and this line promptly read "undefined member machine(s)"
 * — a probe reporting a fault that wasn't one, which is how a check stops being read.
 */
function relaySummary(health) {
  const parts = [];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const add = (v, one, many) => {
    const n = num(v);
    if (n !== null) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(health.instancesOnline, "instance online", "instances online");
  add(health.agentsOnline, "agent", "agents");
  add(health.sharedRepos, "shared repo", "shared repos");
  // Absent for an anonymous read, which is the norm — say nothing rather than name a missing number.
  add(health.members, "member machine", "member machines");
  return parts.length ? parts.join(", ") : "reachable, but reporting no counts";
}

/** The suggestions `OnlineOffice.recordLookalikes` left behind. Never trusted into a shape — this row is
 *  written by a build that may be older or newer than this script. */
function parseUnlinked(raw) {
  try {
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list.filter((p) => p && typeof p.local === "string" && typeof p.remote === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Split every project-room line that names a machine into the three things worth knowing apart.
 * Exported for the gate: this is the whole judgement, and it is what has to keep working.
 */
function classifyOfficeRows({ rows, selfName, fixAt }) {
  const out = { liveEcho: [], residue: [], unstamped: [] };
  for (const r of rows) {
    const stamped = r.remote_instance ?? null;
    const fromName = senderMachine(r.sender_name);
    const machine = stamped || fromName;
    if (!machine) continue;
    if (selfName && machine === selfName) {
      // This instance receiving its own traffic. Before the fix that was the bug; after it, a regression.
      // With no boundary (the fixed build has never booted here) nothing can be called a regression yet.
      (fixAt && r.created_at >= fixAt ? out.liveEcho : out.residue).push(r);
    } else if (!stamped) {
      // Genuinely remote, but nothing recorded the machine — so it counts toward no room's participants.
      out.unstamped.push(r);
    }
  }
  return out;
}

/** "Sif @ remote workstation" -> "remote workstation". The stamp `receiveRemoteChat` has always written into
 *  sender_name, and the only recoverable machine on rows predating the `remote_instance` column. */
function senderMachine(senderName) {
  const at = typeof senderName === "string" ? senderName.indexOf(" @ ") : -1;
  return at < 0 ? null : senderName.slice(at + 3);
}

/** Every project room a machine other than this one has spoken in, with the app's own reachability
 *  verdict. A room here that the console will NOT show is the "invisible conversation" defect. */
function crossMachineRooms(db, selfName, isCollaborationRoom) {
  const rows = db
    .prepare(
      `SELECT room,
              MAX(workspace) AS workspace,
              MAX(created_at) AS last_at,
              GROUP_CONCAT(DISTINCT thread_id) AS thread_ids
         FROM chat_messages
        WHERE scope = 'project'
        GROUP BY room`,
    )
    .all();
  const machines = new Map();
  for (const m of db
    .prepare(
      `SELECT room, remote_instance FROM chat_messages
        WHERE scope = 'project' AND remote_instance IS NOT NULL
        GROUP BY room, remote_instance`,
    )
    .all()) {
    machines.set(m.room, [...(machines.get(m.room) ?? []), m.remote_instance]);
  }
  return rows
    .map((r) => {
      const remoteInstances = (machines.get(r.room) ?? []).filter((n) => n !== selfName);
      const threadIds = String(r.thread_ids ?? "").split(",").filter(Boolean);
      return {
        room: r.room,
        workspace: r.workspace ?? "",
        lastAt: r.last_at,
        threadIds,
        remoteInstances,
        reachable: isCollaborationRoom ? isCollaborationRoom({ threadIds, remoteInstances }) : null,
      };
    })
    .filter((r) => r.remoteInstances.length)
    .sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * The directors' room — the people's half of the office, which no other section can see: it is not a
 * project room, so the rollup and reachability checks above skip it by construction.
 *
 * Informational, never a failure: a quiet room is the normal state of a room for humans. The one line
 * worth printing is `soloSoFar` — a room only THIS machine has ever spoken in. Membership is opt-in
 * (an instance joins by declaring a director), so that is exactly what talking into a room the other
 * console never joined looks like from here, and there is no other symptom.
 */
function directorsRoomSummary(db, selfName) {
  const rows = db.prepare("SELECT remote_instance, created_at FROM chat_messages WHERE room = 'directors'").all();
  const machines = [...new Set(rows.map((r) => r.remote_instance).filter((n) => n && n !== selfName))];
  return {
    lines: rows.length,
    mine: rows.filter((r) => !r.remote_instance).length,
    machines,
    lastAt: rows.reduce((a, r) => Math.max(a, r.created_at), 0),
    soloSoFar: rows.length > 0 && machines.length === 0,
  };
}

/** The relay's PUBLIC health endpoint — no admin key, so this works from any checkout. Unreachable is a
 *  note, never a failure: the whole feature is designed to degrade soft when the relay is down. */
async function relayHealth(url) {
  if (!url) return null;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    const err = e;
    return { error: err.cause?.message || err.message };
  }
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** The verdict, separated from the printing so the gate can assert on it. */
function verdictFor({ echo, rooms }) {
  const problems = [];
  if (echo.liveEcho.length) {
    problems.push(
      `${echo.liveEcho.length} line(s) since ${SELF_ECHO_FIX.when} carry THIS instance's own name — ` +
        `the sender filter has regressed on one of: relay roster, relay history replay, client presence, client chat`,
    );
  }
  const hidden = rooms.filter((r) => r.reachable === false);
  if (hidden.length) {
    problems.push(
      `${hidden.length} room(s) hold a cross-machine conversation the console will NOT show — ` +
        `${hidden.map((r) => r.room).join(", ")}`,
    );
  }
  return { ok: problems.length === 0, problems };
}

async function main() {
  const db = openDb();
  const cfg = readConfig(db);
  const isCollaborationRoom = loadIsCollaborationRoom();

  console.log("=== online office ===");
  if (!cfg.joined) {
    console.log("  not joined — Settings → Online office. Nothing to check; local pipelines are unaffected.");
    db.close();
    process.exit(0);
  }
  console.log(`  joined as "${cfg.name}" → ${cfg.url}${cfg.enabled ? "" : "   (presence switched OFF)"}`);
  const health = await relayHealth(cfg.url);
  if (!health) console.log("  relay: no address recorded");
  else if (health.error) console.log(`  relay: UNREACHABLE (${health.error}) — the office degrades soft; local work is unaffected`);
  else {
    console.log(`  relay: ${relaySummary(health)}`);
  }

  const rows = db
    .prepare(
      `SELECT id, room, sender_name, remote_instance, created_at FROM chat_messages
        WHERE scope = 'project' AND thread_id IS NULL`,
    )
    .all();
  const echo = classifyOfficeRows({ rows, selfName: cfg.name, fixAt: cfg.fixAt });

  console.log("\n=== self-echo check ===");
  if (echo.liveEcho.length) {
    console.log(`  ✗ ${echo.liveEcho.length} line(s) stamped with this instance's own name ("${cfg.name}") AFTER the fix:`);
    for (const r of echo.liveEcho.slice(0, 8)) console.log(`      ${r.room}  ${r.sender_name ?? "(system)"}  ${ago(r.created_at)}`);
    console.log(`    An instance must never receive what it sent. See .claude/rules/online-office.md.`);
  } else if (!cfg.fixAt) {
    console.log(`  ⚠ the fixed build (${SELF_ECHO_FIX.sha}) has never booted here, so no line can be judged a regression yet.`);
  } else {
    console.log(`  ✓ nothing carries this instance's own name since the echo fix ran here (${SELF_ECHO_FIX.sha}, ${ago(cfg.fixAt)})`);
  }
  if (echo.residue.length) {
    const rooms = [...new Set(echo.residue.map((r) => r.room))];
    console.log(`  ↳ ${echo.residue.length} pre-fix row(s) remain in ${rooms.join(", ")} — residue the bug wrote, deliberately`);
    console.log(`    left uncounted by the backfill (stamping them would rebuild the phantom teammate in the data).`);
  }
  if (echo.unstamped.length) {
    console.log(`  ⚠ ${echo.unstamped.length} genuinely-remote line(s) carry no machine stamp — they count toward no room's`);
    console.log(`    participants, so their room can go unreachable. Check receiveRemoteChat still sets remoteInstance.`);
  }

  console.log("\n=== cross-machine rooms ===");
  const rooms = crossMachineRooms(db, cfg.name, isCollaborationRoom);
  if (isCollaborationRoom === null) {
    console.log("  (server not built — run `npm run build --prefix server` to get the reachability verdict)");
  }
  if (!rooms.length) {
    console.log("  none — no other machine has spoken in a repo room here.");
  }
  for (const r of rooms) {
    const reach = r.reachable === null ? "reachability unknown" : r.reachable ? "reachable ✓" : "NOT REACHABLE ✗";
    console.log(
      `  ${r.room}\n      ${r.threadIds.length} local task(s) · ${r.remoteInstances.length} machine(s) ` +
        `(${r.remoteInstances.join(", ")}) · last ${ago(r.lastAt)} · ${reach}`,
    );
  }

  // The blind spot this section exists for: everything above inspects rooms that FORMED, so two machines
  // that should have met and never did read as an absence of activity. On 2026-08-26 that was exactly the
  // case: one checkout on the upstream repo, another on a fork, three agents in one codebase and two
  // rooms, while this probe printed a clean two-way pass.
  console.log("\n=== repositories that look like the same project but aren't grouped ===");
  if (!cfg.unlinked.length) {
    console.log("  none — every remote repo sharing a name with one of yours is grouped with it.");
  } else {
    for (const p of cfg.unlinked) {
      console.log(`  ⚠ "${p.remote}" on ${p.instance ?? "another machine"} vs your "${p.local}"`);
    }
    console.log("    Same repository name, different owner — so they are separate rooms and those agents");
    console.log("    cannot see each other. If it IS the same project (a fork), add the other side as a");
    console.log("    remote in that checkout and they group on the next presence tick. If the two are");
    console.log("    genuinely unrelated repos that share a name, this is correct and nothing needs doing.");
  }

  console.log("\n=== directors' room (the people, not their agents) ===");
  const people = directorsRoomSummary(db, cfg.name);
  if (!people.lines) {
    console.log("  empty — nobody has said anything here yet. Normal; it is a room for humans.");
  } else {
    console.log(
      `  ${people.lines} line(s) · ${people.mine} from here · ` +
        `${people.machines.length} other machine(s)${people.machines.length ? ` (${people.machines.join(", ")})` : ""} · last ${ago(people.lastAt)}`,
    );
    if (people.soloSoFar) {
      console.log("  ↳ only this machine has ever spoken here. Membership is opt-in (a console joins by");
      console.log("    declaring its director), so this is also what an office whose other machines run a");
      console.log("    build predating the room looks like — check their version before assuming silence.");
    }
  }

  const verdict = verdictFor({ echo, rooms });
  console.log("\n=== verdict ===");
  if (verdict.ok) console.log("  ✓ the online office is two-way: nothing is echoing back, every cross-machine room is reachable");
  else for (const p of verdict.problems) console.log(`  ✗ ${p}`);
  db.close();
  process.exit(verdict.ok ? 0 : 1);
}

module.exports = { SELF_ECHO_FIX, classifyOfficeRows, directorsRoomSummary, parseUnlinked, relaySummary, senderMachine, verdictFor };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
