/**
 * Integration test — no agent ever runs nameless.
 *
 * Every agent (a thread × role pair) is given a generated name the moment its run row is written, so a
 * header like "QA (Name, Opus 5.5 High)" never renders without the name. This drives the real Db hook,
 * ThreadManager naming, the wireRun guard and the one-time backfill against a throwaway DB:
 *  - every role is named at creation, distinctly within its task, and the UI hears it (chat.name);
 *  - a rerun, a resume and a server restart keep the same name;
 *  - an agent's own pick replaces the placeholder, which is then not held for the reuse window;
 *  - the guard throws in strict (gate) mode and names + logs in production;
 *  - agents that ran before this shipped are backfilled once;
 *  - nothing outside Db.createRun inserts an agent_runs row, so no path can bypass the hook.
 *
 * Run:  npm run test:agent-names   (from server/)   — or:  npx tsx src/tests/agentNames.itest.ts
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Role } from "../types.js";
import type { ServerEvent } from "../ws/protocol.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { agentKey, unnamedAgentLabel } = await import("../types.js");
const { generatedAgentName } = await import("../orchestrator/officeNames.js");

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
}

const AGENT_ROLES: Role[] = ["planner", "researcher", "implementor", "qa", "reader", "reviewer"];
const GENERATED = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

type Db = InstanceType<typeof Db>;

function boot(db: Db) {
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const dir = mkdtempSync(join(tmpdir(), "agent-names-mem-"));
  const mgr = new ThreadManager(db, hub, new FileMemoryService(dir), new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    mgr,
    internals,
    events,
    names: () => events.filter((e): e is Extract<ServerEvent, { type: "chat.name" }> => e.type === "chat.name"),
    warnings: () => events.filter((e) => e.type === "log" && e.level === "warn").map((e) => (e as { message: string }).message),
    stop() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withDb(fn: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-names-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  try {
    fn(db);
  } finally {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const thread = (db: Db, title: string) => db.createThread({ title, workspace: "C:/repos/names", rawPrompt: "do the thing" });

/** An agent_runs row written around Db.createRun — the shape of a path that bypassed the hook, or of a
 *  run recorded before names were generated at creation. */
function rawRun(db: Db, threadId: string, role: Role): void {
  db.raw
    .prepare("INSERT INTO agent_runs(id, thread_id, role, model, state, started_at) VALUES(?, ?, ?, 'claude-x', 'done', ?)")
    .run(`raw-${threadId}-${role}`, threadId, role, Date.now());
}

function withStrict<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.GGO_STRICT_AGENT_NAMES;
  if (value === undefined) delete process.env.GGO_STRICT_AGENT_NAMES;
  else process.env.GGO_STRICT_AGENT_NAMES = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.GGO_STRICT_AGENT_NAMES;
    else process.env.GGO_STRICT_AGENT_NAMES = before;
  }
}

console.log("\n=== agent names — every agent is named at creation ===\n");

console.log("Test A — every role is named the moment its run row is written");
withDb((db) => {
  const h = boot(db);
  const t = thread(db, "All roles");
  for (const role of AGENT_ROLES) db.createRun({ threadId: t.id, role, model: "claude-x", account: "acct" });
  const names = AGENT_ROLES.map((role) => h.mgr.officeName(t.id, role));
  for (const [i, role] of AGENT_ROLES.entries()) {
    check(`${role} has a generated name, not its bare role`, GENERATED.test(names[i]!) && names[i] !== unnamedAgentLabel(role), names[i]);
  }
  check("the task's agents have distinct names", new Set(names).size === AGENT_ROLES.length, names.join(", "));
  check("the UI hears each name (one chat.name per agent)", h.names().length === AGENT_ROLES.length && h.names().every((e) => e.threadId === t.id), JSON.stringify(h.names()));
  check("the hello snapshot carries every name", AGENT_ROLES.every((role) => h.mgr.officeNameOverrides()[agentKey(t.id, role)] === h.mgr.officeName(t.id, role)));
  check("the director keeps its operator-chosen name", h.mgr.ensureAgentName(t.id, "director") === h.mgr.officeName(t.id, "director"));
  h.stop();
});

console.log("Test B — reruns, resumes and a restart keep the agent's name");
withDb((db) => {
  const h = boot(db);
  const t = thread(db, "Rerun");
  db.createRun({ threadId: t.id, role: "qa", model: "claude-x", account: "acct" });
  const first = h.mgr.officeName(t.id, "qa");
  db.createRun({ threadId: t.id, role: "qa", model: "gpt-6.1-sol", account: "codex:gpt-6.1-sol" });
  db.createRun({ threadId: t.id, role: "qa", model: "claude-x", account: "acct" });
  check("a second and third QA run (rerun / failover / resume) keep the name", h.mgr.officeName(t.id, "qa") === first, `${first} → ${h.mgr.officeName(t.id, "qa")}`);
  check("no rename is broadcast for a rerun", h.names().length === 1);
  h.stop();
  const restarted = boot(db);
  check("a restarted server shows the same name", restarted.mgr.officeName(t.id, "qa") === first);
  db.createRun({ threadId: t.id, role: "qa", model: "claude-x", account: "acct" });
  check("a run after the restart keeps it too", restarted.mgr.officeName(t.id, "qa") === first);
  restarted.stop();
});

console.log("Test C — an agent's own pick replaces the placeholder");
withDb((db) => {
  const h = boot(db);
  const t = thread(db, "Self-naming");
  db.createRun({ threadId: t.id, role: "qa", model: "claude-x", account: "acct" });
  const placeholder = h.mgr.officeName(t.id, "qa");
  const asked = h.internals.namingNote(t.id, "qa", true) as string | undefined;
  check("an agent on its placeholder is still asked to invent a name", !!asked && asked.includes("office_set_name"));
  check("the agent's pick is accepted", h.mgr.setOfficeName(t.id, "qa", "Quillon Fettle").name === "Quillon Fettle");
  check("its own name now shows", h.mgr.officeName(t.id, "qa") === "Quillon Fettle");
  check("a self-named agent is not asked again", h.internals.namingNote(t.id, "qa", true) === undefined);
  const other = thread(db, "Other task");
  db.createRun({ threadId: other.id, role: "implementor", model: "claude-x", account: "acct" });
  check("the released placeholder is not reserved for the reuse window", h.mgr.setOfficeName(other.id, "implementor", placeholder).ok, placeholder);
  db.createRun({ threadId: t.id, role: "qa", model: "claude-x", account: "acct" });
  check("a later run keeps the self-picked name", h.mgr.officeName(t.id, "qa") === "Quillon Fettle");
  h.stop();
});

console.log("Test D — generated names avoid names already held");
withDb((db) => {
  const h = boot(db);
  const holder = thread(db, "Holder");
  db.createRun({ threadId: holder.id, role: "implementor", model: "claude-x", account: "acct" });
  const t = thread(db, "Newcomer");
  // Make the newcomer's first-choice name already taken by the holder, so generation must walk past it.
  const firstChoice = generatedAgentName(agentKey(t.id, "qa"), new Set());
  h.mgr.setOfficeName(holder.id, "implementor", firstChoice);
  db.createRun({ threadId: t.id, role: "qa", model: "claude-x", account: "acct" });
  const got = h.mgr.officeName(t.id, "qa");
  check("a name another agent holds is skipped", got !== firstChoice && GENERATED.test(got), `${firstChoice} vs ${got}`);
  h.stop();
});

console.log("Test E — the wireRun guard");
withDb((db) => {
  const h = boot(db);
  const t = thread(db, "Bypassed");
  rawRun(db, t.id, "qa");
  // wireRun is where every ThreadManager agent starts; the guard is its first step.
  const fake = { onEvent: () => () => {}, onEnd: () => {} };
  const start = (threadId: string, role: Role) => h.internals.wireRun(fake, threadId, `raw-${threadId}-${role}`, role, "acct");
  let threw: unknown = null;
  withStrict("1", () => {
    try {
      start(t.id, "qa");
    } catch (e) {
      threw = e;
    }
  });
  check("strict mode (the gate suite) fails loudly on a nameless agent", threw instanceof Error && /started without a name/.test((threw as Error).message), String(threw));
  check("…and did not quietly name it", h.mgr.officeName(t.id, "qa") === unnamedAgentLabel("qa"));
  withStrict(undefined, () => start(t.id, "qa"));
  check("production names the agent", GENERATED.test(h.mgr.officeName(t.id, "qa")), h.mgr.officeName(t.id, "qa"));
  check("…and logs that it had to", h.warnings().some((w) => /started without a name; assigned "/.test(w)), JSON.stringify(h.warnings()));
  const named = thread(db, "Named normally");
  db.createRun({ threadId: named.id, role: "implementor", model: "claude-x", account: "acct" });
  let quiet = true;
  withStrict("1", () => {
    try {
      start(named.id, "implementor");
    } catch {
      quiet = false;
    }
  });
  check("an agent named by the creation hook passes the guard", quiet);
  h.stop();
});

console.log("Test F — the one-time backfill names agents that ran before");
withDb((db) => {
  const old = thread(db, "Old task");
  const selfNamed = thread(db, "Old self-named task");
  for (const role of ["planner", "implementor", "qa"] as Role[]) db.createRun({ threadId: old.id, role, model: "claude-x" });
  db.createRun({ threadId: selfNamed.id, role: "qa", model: "claude-x" });
  db.kvSet("office_names", JSON.stringify({ [agentKey(selfNamed.id, "qa")]: "Pellet Quibble" }));
  const h = boot(db);
  for (const role of ["planner", "implementor", "qa"] as Role[]) {
    check(`an old ${role} is backfilled`, GENERATED.test(h.mgr.officeName(old.id, role)), h.mgr.officeName(old.id, role));
  }
  check("a name the agent picked itself is left alone", h.mgr.officeName(selfNamed.id, "qa") === "Pellet Quibble");
  check("the backfill is announced once", h.events.some((e) => e.type === "log" && /Named 3 agent\(s\)/.test((e as { message: string }).message)));
  h.stop();
  rawRun(db, old.id, "reader");
  const again = boot(db);
  check("the backfill is one-time (kv-flagged)", again.mgr.officeName(old.id, "reader") === unnamedAgentLabel("reader"));
  again.stop();
});

console.log("Test G — Db.createRun is the only writer of agent_runs, so no path can skip the hook");
{
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "tests") walk(path);
      } else if (/\.ts$/.test(entry)) {
        const hits = readFileSync(path, "utf8").match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+agent_runs\b/gi) ?? [];
        if (hits.length) offenders.push(`${relative(srcRoot, path)} ×${hits.length}`);
      }
    }
  };
  walk(srcRoot);
  check("exactly one INSERT INTO agent_runs, in db/db.ts", offenders.length === 1 && /^db[\\/]db\.ts ×1$/.test(offenders[0]!), offenders.join(", "));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
