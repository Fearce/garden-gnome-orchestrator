/** Gate for the owner's standing directives: persisted setting, the Director's system-prompt section,
 *  the per-session replacement block, and the dispatch `effort` a directive can now pin. No provider calls. */
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunConfig, UserContent } from "../agents/runner.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { DispatchInput } from "../orchestrator/api.js";

const { MAX_DIRECTOR_DIRECTIVES_CHARS } = await import("../types.js");
const { normalizeDirectorDirectives, directorDirectivesSystemSection } = await import("../agents/directorDirectives.js");
const { directorConfig } = await import("../agents/roles.js");
const { clientCommandSchema } = await import("../ws/protocol.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Director } = await import("../orchestrator/director.js");
const { createDirectorServer } = await import("../bus/directorServer.js");
const { executeDirectorCliAction } = await import("../orchestrator/directorCliBridge.js");

const TAG = "ggo_standing_directives";
const RULES = "Always prefer Claude models. OpenAI is the backup.\nUse low effort unless the task is clearly hard.";
const fakeServer = {} as McpServerConfig;

function systemText(cfg: AgentRunConfig): string {
  return typeof cfg.systemPrompt === "string" ? cfg.systemPrompt : cfg.systemPrompt?.append ?? "";
}
function text(content: UserContent | undefined): string {
  if (content === undefined) return "";
  return typeof content === "string"
    ? content
    : content.map((block) => {
      if (!block || typeof block !== "object" || !("text" in block)) return "";
      return typeof block.text === "string" ? block.text : "";
    }).join("\n");
}

// ---- pure helpers ----
assert.equal(normalizeDirectorDirectives("  a\r\nb\r  "), "a\nb", "CRLF/CR become LF and the text is trimmed");
assert.equal(normalizeDirectorDirectives("x".repeat(MAX_DIRECTOR_DIRECTIVES_CHARS + 50)).length, MAX_DIRECTOR_DIRECTIVES_CHARS, "capped");
assert.equal(directorDirectivesSystemSection("   "), "", "empty directives add nothing to the prompt");

const withRules = directorConfig({ director: fakeServer, memory: fakeServer }, "Dir", { directives: RULES });
const without = directorConfig({ director: fakeServer, memory: fakeServer }, "Dir", { directives: "" });
assert.ok(systemText(withRules).includes(`<${TAG}>\n${RULES}\n</${TAG}>`), "the verbatim directives sit in the system prompt");
assert.ok(!systemText(without).includes(TAG), "no section when unset");
assert.match(systemText(withRules), /A soft preference with a fallback .* is NOT a model pin/, "a preference is not turned into a strict pin");
assert.match(systemText(withRules), /Standing owner directives/, "the director carries directives into briefs");
const { systemPrompt: _a, ...restWith } = withRules;
const { systemPrompt: _b, ...restWithout } = without;
assert.deepEqual(restWith, restWithout, "directives change wording only — model, tools and permissions are untouched");

assert.deepEqual(
  clientCommandSchema.parse({ type: "settings.set", settings: { directorDirectives: RULES } }),
  { type: "settings.set", settings: { directorDirectives: RULES } },
  "the WebSocket settings transport accepts the field",
);
assert.throws(
  () => clientCommandSchema.parse({ type: "settings.set", settings: { directorDirectives: "x".repeat(MAX_DIRECTOR_DIRECTIVES_CHARS + 1) } }),
  "an oversized payload is refused at the boundary",
);

// ---- persistence through ThreadManager ----
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

const dir = mkdtempSync(join(tmpdir(), "director-directives-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService(join(dir, "memory"));
const managers: InstanceType<typeof ThreadManager>[] = [];
const newManager = () => {
  const m = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  managers.push(m);
  return m;
};

try {
  const mgr = newManager();
  assert.equal(mgr.settings().directorDirectives, "", "default is no directives");
  mgr.setSettings({ directorDirectives: `  ${RULES.replace(/\n/g, "\r\n")}  ` });
  assert.equal(mgr.settings().directorDirectives, RULES, "saved normalized");
  assert.equal(newManager().settings().directorDirectives, RULES, "survives a restart");

  // ---- the Director: system prompt on a fresh session, a replacement block only on change ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const target = { key: "claude:test", provider: "claude", model: "test-model", accountId: "a", accountLabel: "a" };
  internals.directorTargetReady = () => true;
  const runs: Array<{ cfg: AgentRunConfig; resume?: string; started?: UserContent; sent: UserContent[] }> = [];
  internals.createDirectorAgent = (_t: unknown, cfg: AgentRunConfig, opts: { resume?: string }) => {
    const record = { cfg, resume: opts?.resume, started: undefined as UserContent | undefined, sent: [] as UserContent[] };
    runs.push(record);
    return {
      finished: false, rateLimited: false, capped: false,
      onEvent: () => () => {}, onEnd: () => {},
      start(content: UserContent) { record.started = content; return this; },
      send(content: UserContent) { record.sent.push(content); },
      stop: async () => {},
    };
  };
  const director = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dInternals = director as any;
  dInternals.chooseTarget = async () => target;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  director.handleUserMessage("first message");
  await settle();
  assert.equal(runs.length, 1);
  assert.ok(systemText(runs[0]!.cfg).includes(RULES), "a fresh session gets the directives in its system prompt");
  assert.ok(!text(runs[0]!.started).includes(`<${TAG} updated`), "…and no redundant turn block");

  director.handleUserMessage("second message, nothing changed");
  assert.equal(runs[0]!.sent.length, 1, "a live run is steered, not restarted");
  assert.ok(!text(runs[0]!.sent[0]).includes(TAG), "unchanged directives are not repeated every turn");

  const EDITED = "Use medium effort for everything.";
  mgr.setSettings({ directorDirectives: EDITED });
  director.handleUserMessage("third message after an edit");
  const edited = text(runs[0]!.sent[1]);
  assert.ok(edited.includes(`<${TAG} updated="true">`) && edited.includes(EDITED), "a live session receives the edit as a replacement block");
  assert.ok(edited.indexOf(TAG) < edited.indexOf("third message after an edit"), "the block precedes the owner's words");
  director.handleUserMessage("fourth message");
  assert.ok(!text(runs[0]!.sent[2]).includes(TAG), "the replacement is sent once");

  // A resumed session: its system prompt is rebuilt, but its history may carry the older block, so a
  // changed version still arrives as a turn block. The run finishes, the owner edits, then speaks.
  dInternals.run = undefined;
  dInternals.sessions.set("claude", "session-1");
  mgr.setSettings({ directorDirectives: "" });
  director.handleUserMessage("fifth message after clearing");
  await settle();
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.resume, "session-1", "the session was resumed");
  assert.ok(text(runs[1]!.started).includes(`<${TAG} updated="cleared">`), "clearing reaches a resumed session");
  assert.ok(!systemText(runs[1]!.cfg).includes(TAG), "and its rebuilt system prompt carries none");

  dInternals.run = undefined;
  director.handleUserMessage("sixth message, still cleared");
  await settle();
  assert.ok(!text(runs[2]!.started).includes(TAG), "a resume with an unchanged version adds nothing");
  director.cancelTurn();

  // ---- dispatch effort: a directive naming an effort can now pin it, through both transports ----
  const dispatched: DispatchInput[] = [];
  internals.dispatch = async (input: DispatchInput) => { dispatched.push(input); return `task-${dispatched.length}`; };
  const server = createDirectorServer(mgr, () => [], () => {}, {} as Scheduler, {} as OperatorNotes) as unknown as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  await server.instance._registeredTools.dispatch!.handler({ title: "T", workspace, brief: "B", effort: "low" }, {});
  await server.instance._registeredTools.dispatch!.handler({ title: "T", workspace, brief: "B" }, {});
  assert.equal(dispatched[0]?.effort, "low", "the MCP dispatch tool forwards an explicit effort");
  assert.equal(dispatched[1]?.effort, undefined, "omitted effort stays unset, so the pipeline still picks");

  await executeDirectorCliAction({ kind: "dispatch", title: "T", workspace, brief: "B", effort: "medium" }, mgr, {} as Scheduler, {} as OperatorNotes, []);
  await executeDirectorCliAction({ kind: "dispatch_read", title: "T", workspace, brief: "B", effort: "max" }, mgr, {} as Scheduler, {} as OperatorNotes, []);
  assert.equal(dispatched[2]?.effort, "medium", "the CLI bridge forwards an explicit effort");
  assert.equal(dispatched[3]?.effort, undefined, "the read lane never takes an implementor effort");

  console.log("PASS — director directives");
} finally {
  for (const m of managers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i = m as any;
    for (const key of ["capSupervisor", "tokenResumeTimer", "capResumeWake"]) if (i[key]) clearTimeout(i[key]);
  }
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
