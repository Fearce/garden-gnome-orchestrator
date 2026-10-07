/** Gate for AUTO repo mode: the resolver's decisions (explicit paths, named repos, similar names,
 *  worktrees, follow-ups, topic changes, multi-repo requests, missing paths), and the Director routes
 *  around it: a stale manual pick never wins in AUTO, an ambiguous request asks with named candidates
 *  and dispatches exactly once after the answer (also across a restart), and manual mode is unchanged.
 *  No provider calls; every repo lives in a throwaway folder that is also the only search root. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "auto-repo-"));
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.WORKSPACE_SEARCH_ROOTS = join(dir, "projects");

import type { AccountManager } from "../accounts/accountManager.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { AskUserInput, DispatchInput } from "../orchestrator/api.js";
import type { DirectorMessage, Question } from "../types.js";

const { resolveAutoRepo, parseRepoAnswer, explicitPaths, mainCheckoutOf, askRepoChoice, searchRepos, autoRepoQuestion } = await import("../workspace/autoRepo.js");
const { clientCommandSchema } = await import("../ws/protocol.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Director, autoRepoTag } = await import("../orchestrator/director.js");

const repo = (...parts: string[]) => {
  const p = join(dir, ...parts);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
};
const ggo = repo("projects", "garden-gnome-orchestrator");
const ggoTree = join(dir, "projects", "garden-gnome-orchestrator.worktrees", "auto-toggle");
mkdirSync(ggoTree, { recursive: true });
writeFileSync(join(ggoTree, ".git"), "gitdir: elsewhere\n");
const tile = repo("projects", "tilebreaker");
const tileOld = repo("projects", "tilebreaker-old");
repo("projects", "web");
const ledger = repo("projects", "ledger-api");
const clientTile = repo("clients", "tilebreaker");
mkdirSync(join(ggo, "server", "src"), { recursive: true });
const ggoFile = join(ggo, "server", "src", "index.ts");
writeFileSync(ggoFile, "// fixture\n");

type Ctx = Parameters<typeof resolveAutoRepo>[1];
const ctx = (extra: Partial<Ctx> = {}): Ctx => ({
  recent: [ggo, tile],
  taskWorkspaces: [],
  searchRoots: [join(dir, "projects")],
  lastRepo: null,
  ...extra,
});
const resolved = (text: string, extra: Partial<Ctx> = {}) => {
  const d = resolveAutoRepo(text, ctx(extra));
  return d.kind === "resolved" ? d.repos : null;
};
const asked = (text: string, extra: Partial<Ctx> = {}) => {
  const d = resolveAutoRepo(text, ctx(extra));
  if (d.kind !== "ask") assert.fail(`"${text}" should ask, got ${JSON.stringify(d)}`);
  return d;
};

// ---- explicit owner paths are authoritative ----
assert.deepEqual(resolved(`please fix the build in ${ggo}.`), [ggo], "a directory in the message is used as written");
assert.deepEqual(resolved(`look at ${join(ggo, "server")} only`), [join(ggo, "server")], "a sub-directory is not widened to its repo");
assert.deepEqual(resolved(`the bug is in ${ggoFile}`), [ggo], "a file stands for its git checkout");
assert.deepEqual(resolved(`sync ${tile} and ${ledger}`), [tile, ledger], "several written paths become several repos");
assert.deepEqual(explicitPaths("see https://example.com/a/b and /srv/app/x"), ["/srv/app/x"], "a URL is not a path");
const typo = join(dir, "projects", "tilebreakr");
const missing = asked(`fix ${typo}`);
assert.equal(missing.reason, "missing", "a path that does not exist is asked about, never dispatched");
assert.ok(missing.candidates.length && missing.candidates.every((c) => c.path !== typo), "only real repos are offered");

// ---- repos the message names ----
assert.deepEqual(resolved("the garden gnome orchestrator composer needs a toggle"), [ggo], "the whole name");
assert.deepEqual(resolved("GGO: add an AUTO toggle"), [ggo], "the acronym of a three-word name");
assert.deepEqual(resolved("ledger api returns 500 on refunds"), [ledger], "a two-word name");
assert.deepEqual(resolved("tilebreaker-old needs its save format migrated"), [tileOld], "the more specific of two overlapping names wins");
assert.deepEqual(resolved("tilebreaker level 3 has a softlock"), [tile], "the shorter name when only it is said");
assert.equal(resolveAutoRepo("fix the web page header", ctx()).kind, "ask", "a generic repo name never claims a message on its own");
assert.ok(asked("make it faster").candidates.every((c) => !c.path.includes(".worktrees")), "a worktree is never its own candidate");
assert.equal(mainCheckoutOf(ggoTree), ggo, "a task worktree stands for its main checkout");
assert.deepEqual(resolved("garden gnome orchestrator follow-up", { recent: [ggoTree] }), [ggo], "a remembered worktree folds into its repo");

// similarly named repos in two places
const twins = asked("tilebreaker crashes on start", { recent: [tile, clientTile] });
assert.equal(twins.reason, "ambiguous");
assert.ok([tile, clientTile].every((p) => twins.candidates.some((c) => c.path === p)), "both same-named repos are offered by path");
assert.equal(twins.multiSelect, false);

// a request spanning two projects
const both = asked("bump the shared logger in ledger api and tilebreaker-old");
assert.equal(both.reason, "multiple");
assert.equal(both.multiSelect, true, "several named projects may all be picked");
assert.deepEqual(both.candidates.slice(0, 2).map((c) => c.path).sort(), [ledger, tileOld].sort());

// ---- follow-ups and topic changes ----
const none = asked("make the tests faster");
assert.equal(none.reason, "none");
assert.equal(none.candidates[0]?.path, ggo, "no signal: recent repos are offered, most recent first");
assert.deepEqual(resolved("also add a test for that", { lastRepo: tile }), [tile], "a follow-up continues the previous repo");
assert.deepEqual(resolved("now the ledger api needs the same fix", { lastRepo: tile }), [ledger], "a named repo beats the previous one (topic change)");
assert.equal(asked("make the tests faster", { lastRepo: tile }).candidates[0]?.path, tile, "without follow-up wording the previous repo is offered first, not assumed");

// ---- the question and its answer ----
assert.ok(autoRepoQuestion(both).options.every((o) => o.description && o.label), "each option names the repo and carries its path");
assert.deepEqual(parseRepoAnswer(`${tile}\n${ledger}\n`), [tile, ledger]);
assert.deepEqual(parseRepoAnswer("(no answer, timed out)"), [], "a timeout picks nothing");
assert.deepEqual(parseRepoAnswer(join(dir, "nope")), [], "a path that does not exist picks nothing");
assert.ok(searchRepos("ledger", ctx()).some((r) => r.path === ledger), "the picker search finds a repo by name");

// ---- director tag: the server inference, and an earlier manual pick retired ----
const tag = autoRepoTag(resolveAutoRepo("tilebreaker softlock", ctx()));
assert.ok(tag.includes("REPO MODE: AUTO") && tag.includes(tile) && tag.includes("does not apply"), "the tag names the inferred repo and retires old TARGET WORKSPACE tags");
assert.ok(autoRepoTag(both).includes("Candidates:") && autoRepoTag(both).includes("ask_user"), "an unclear tag lists candidates and says to ask");

// ---- the WebSocket boundary ----
assert.equal(clientCommandSchema.parse({ type: "prompt.direct", text: "x", autoRepo: true }).type, "prompt.direct");
assert.throws(() => clientCommandSchema.parse({ type: "prompt.new", text: "x", autoRepo: false }), "autoRepo is only ever `true`");

// ---- the director's repo question tool ----
const toolAsks: AskUserInput[] = [];
const toolApi = { askUser: async (input: AskUserInput) => (toolAsks.push(input), tile) };
const toolResult = await askRepoChoice(toolApi, { header: "Which repo?", question: "Which?", repos: [tile, join(dir, "ghost")], multiSelect: false });
assert.equal(toolAsks[0]?.kind, "repo");
assert.deepEqual(toolAsks[0]?.options.map((o) => o.description), [tile], "a path that does not exist is dropped from the picker");
assert.ok(toolResult.text.includes(tile) && !toolResult.error);
assert.ok((await askRepoChoice(toolApi, { header: "h", question: "q", repos: [join(dir, "ghost")], multiSelect: false })).error, "no real candidate is an error, not an empty picker");

// ---- Director routes ----
class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string | undefined { return undefined; }
}

const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService(join(dir, "memory"));
const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
const managers = [mgr];
const notes: string[] = [];
hub.subscribe((event) => {
  if (event.type === "director.message" && (event.message as DirectorMessage).role === "director") notes.push((event.message as DirectorMessage).content);
});
const tick = () => new Promise((r) => setImmediate(r));

try {
  // the preference persists like every other composer setting
  assert.equal(mgr.settings().autoRepo, false, "AUTO is off by default");
  mgr.setSettings({ autoRepo: true, recentRepos: [ggo, tile], skipDirectorRetitle: false });
  const reloaded = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  managers.push(reloaded);
  assert.equal(reloaded.settings().autoRepo, true, "AUTO survives a restart");

  // the real question store keeps the kind
  const live = mgr.askUser({ threadId: null, header: "Which repo?", question: "?", options: [{ label: "tilebreaker", description: tile }], multiSelect: false, kind: "repo" });
  const stored = db.listOpenQuestions().find((x) => x.kind === "repo");
  assert.ok(stored, "a repo question is stored with its kind");
  mgr.resolveQuestion(stored.id, tile);
  assert.equal(await live, tile);

  const dispatched: DispatchInput[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).dispatch = async (input: DispatchInput) => (dispatched.push(input), `task-${dispatched.length}-0000`);
  const director = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);

  // stale-selection prevention: a manual path still held by the composer loses to AUTO's inference
  await director.dispatchDirect("tilebreaker level 3 softlock", ggo, undefined, "11111111-1111-4111-8111-111111111111", undefined, true);
  assert.deepEqual(dispatched.map((d) => d.workspace), [tile], "AUTO ignores the stale manual path");
  assert.ok(notes.at(-1)!.includes("tilebreaker") && notes.at(-1)!.includes("AUTO repo"), "the confirmation names the repo and why");

  // manual mode: the typed path is the workspace, whatever the message says
  await director.dispatchDirect("tilebreaker level 3 softlock", ggo, undefined, "22222222-2222-4222-8222-222222222222");
  assert.equal(dispatched.at(-1)!.workspace, ggo, "with AUTO off the composer path is authoritative");

  // an explicit path in the message beats inference in AUTO too
  await director.dispatchVanilla(`fix the README in ${ledger}`, undefined, undefined, undefined, undefined, "33333333-3333-4333-8333-333333333333", true);
  assert.equal(dispatched.at(-1)!.workspace, ledger);
  assert.equal(dispatched.at(-1)!.lane, "vanilla");

  // ambiguous: ask with named candidates, then dispatch exactly once to the answer
  const asks: AskUserInput[] = [];
  let answerWith: (a: string) => void = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).askUser = (input: AskUserInput) => {
    asks.push(input);
    input.onAsked?.({ id: `q-${asks.length}` } as Question);
    return new Promise<string>((resolve) => (answerWith = resolve));
  };
  const before = dispatched.length;
  const waiting = director.dispatchDirect("make the tests faster", undefined, undefined, "44444444-4444-4444-8444-444444444444", undefined, true);
  await tick();
  assert.equal(asks[0]?.kind, "repo", "an unclear request opens the repo picker");
  assert.ok(asks[0]!.options.some((o) => o.description === ledger), "with the previous repo among the candidates");
  assert.ok(db.kvGet("auto_repo_pending:q-1"), "the waiting request is saved against the question");
  assert.equal(await director.resumeRepoQuestion("q-1", ledger), false, "a live question is answered by its own turn, not twice");
  answerWith(tile);
  await waiting;
  assert.equal(dispatched.length, before + 1, "one dispatch after the answer");
  assert.equal(dispatched.at(-1)!.workspace, tile);
  assert.equal(db.kvGet("auto_repo_pending:q-1"), null, "the saved request is cleared");

  // a timed-out or dismissed question dispatches nothing
  const timedOut = director.dispatchDirect("make the tests faster", undefined, undefined, "55555555-5555-4555-8555-555555555555", undefined, true);
  await tick();
  answerWith("(did not answer this in time)");
  await timedOut;
  assert.equal(dispatched.length, before + 1, "no repo picked, nothing dispatched");
  assert.ok(notes.at(-1)!.includes("didn't dispatch"), "and the owner is told");

  // multi-project: one task per picked repo, each told its share
  const multi = director.dispatchDirect("bump the logger in ledger api and tilebreaker-old", undefined, undefined, "66666666-6666-4666-8666-666666666666", undefined, true);
  await tick();
  assert.equal(asks.at(-1)!.multiSelect, true);
  answerWith(`${ledger}\n${tileOld}`);
  await multi;
  assert.deepEqual(dispatched.slice(-2).map((d) => d.workspace), [ledger, tileOld], "one task per repo");
  assert.ok(dispatched.at(-1)!.brief.includes(`covers ${tileOld} only`), "each brief names its own repo");

  // a restart killed the turn that asked: the answer still dispatches the saved request, once
  void director.dispatchDirect("make the tests faster", undefined, undefined, "77777777-7777-4777-8777-777777777777", undefined, true);
  await tick();
  const qid = `q-${asks.length}`;
  const rebooted = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);
  const count = dispatched.length;
  assert.equal(await rebooted.resumeRepoQuestion(qid, ledger), true);
  assert.equal(dispatched.length, count + 1);
  assert.equal(dispatched.at(-1)!.workspace, ledger);
  assert.equal(await rebooted.resumeRepoQuestion(qid, ledger), false, "and never twice");

  // director route: AUTO swaps the manual TARGET WORKSPACE tag for the AUTO tag and drops the field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (director as any).start = async () => {};
  director.handleUserMessage("tilebreaker softlock", ggo, undefined, undefined, "88888888-8888-4888-8888-888888888888", true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = JSON.stringify((director as any).pending);
  assert.ok(pending.includes("REPO MODE: AUTO") && pending.includes("tilebreaker"), "the director gets the AUTO tag with the inference");
  assert.ok(!pending.includes("garden-gnome-orchestrator"), "the stale manual path is not sent at all");

  console.log("PASS: auto repo");
} finally {
  for (const m of managers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const key of ["capSupervisor", "tokenResumeTimer", "capResumeWake"]) if ((m as any)[key]) clearTimeout((m as any)[key]);
  }
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
