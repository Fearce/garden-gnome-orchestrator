/** Gate for an effort the owner names in their own words ("review this with high effort"): the detector,
 *  and that a director turn carrying one pins it on the dispatched task even when the director leaves the
 *  tool's `effort` empty — through the MCP tool, the CLI bridge, and skip-director. No provider calls. */
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunConfig, UserContent } from "../agents/runner.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { DispatchInput } from "../orchestrator/api.js";
import type { DirectorCliAction } from "../orchestrator/directorCliBridge.js";

const { detectEffortRequest } = await import("../orchestrator/effortRequest.js");
const { DIRECTOR_SERVER } = await import("../agents/toolNames.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Director } = await import("../orchestrator/director.js");
const { executeDirectorCliAction } = await import("../orchestrator/directorCliBridge.js");

// ---- the detector: a dated ledger of the owner's real sentences ----
const ASKS: Array<[string, string]> = [
  // 2026-09-28: dispatched at medium — the director left `effort` empty.
  ["Pls review this with high effort, fix anything you find, change the PR title and description to match and then merge it into main once done.", "high"],
  ["This is a Sol 5.6 Max effort task as we want to be diligent and careful.", "max"],
  ["run it at low effort", "low"],
  ["do this on a medium-effort pass", "medium"],
  ["effort: xhigh", "xhigh"],
  ["with maximum effort please", "max"],
  ["with extra high effort", "xhigh"],
];
const NOT_ASKS: string[] = [
  // Two levels named: a complaint about a past run, not an ask.
  "I literally said 'with high effort' and yet it started this task with medium effort. pls fix task f1487717",
  // Policy about other work, negated.
  "Our goal tasks should not run with high effort. Effort and model should be selectable in the goal creation && edit box.",
  // A pasted log line is cited, not asked.
  `x "info director(Robin) 01:52:41 PM Auto-selected gpt-6-astra at high effort for this task Strong autonomous coder"`,
  // …including one spanning several lines (2026-09-13).
  `Pls fix "info\ndirector(Robin)\n01:52:41 PM\nAuto-selected gpt-6-astra at high effort for this task\nStrong autonomous coder."`,
  // 2026-09-14: describes what a setting should allow, not this task.
  "This way we can set it to low tier models on low effort and keep working even when nearing usage limits without interruptions.",
  // Settings requests about models, not this task's implementor.
  "can you make sure my gpt 5.6 models use Max effort?",
  "used gpt 5.5.. I told u a few days ago that's illegal. Gpt 5.6 on low efforts is better and cheaper.. ffs",
  "with modern models, medium effort is enough for most tasks. Light effort is enough for smaller tasks.",
  "Closing that gap is high-value and mostly low-effort.",
  "fix the bug without high effort",
  "add a high effort toggle to the settings panel",
];
for (const [text, want] of ASKS) assert.equal(detectEffortRequest(text), want, `ask → ${want}: ${JSON.stringify(text)}`);
for (const text of NOT_ASKS) assert.equal(detectEffortRequest(text), null, `not an ask: ${JSON.stringify(text)}`);

// ---- wiring through a real Director turn ----
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

type ToolHandler = { handler: (args: unknown, extra: unknown) => Promise<unknown> };
type Registered = { instance: { _registeredTools: Record<string, ToolHandler> } };

const dir = mkdtempSync(join(tmpdir(), "effort-request-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);

try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const dispatched: DispatchInput[] = [];
  internals.dispatch = async (input: DispatchInput) => { dispatched.push(input); return `task-${dispatched.length}`; };
  internals.retitleFromBrief = async () => {};
  const target = { key: "claude:test", provider: "claude", model: "test-model", accountId: "a", accountLabel: "a" };
  internals.directorTargets = () => [target];
  internals.directorTargetReady = () => true;
  const runs: Array<{ cfg: AgentRunConfig }> = [];
  internals.createDirectorAgent = (_t: unknown, cfg: AgentRunConfig) => {
    runs.push({ cfg });
    return {
      finished: false, rateLimited: false, capped: false,
      onEvent: () => () => {}, onEnd: () => {},
      start(_content: UserContent) { return this; },
      send(_content: UserContent) {},
      stop: async () => {},
    };
  };
  const director = new Director(mgr, db, internals.hub, {} as Scheduler, {} as OperatorNotes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dInternals = director as any;
  dInternals.chooseTarget = async () => target;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const dispatchTool = () => (runs.at(-1)!.cfg.mcpServers![DIRECTOR_SERVER] as unknown as Registered).instance._registeredTools.dispatch!;

  director.handleUserMessage("Pls review this PR with high effort and merge it once done.");
  await settle();
  await dispatchTool().handler({ title: "T", workspace, brief: "B" }, {});
  assert.equal(dispatched[0]?.effort, "high", "the owner's named effort pins the task when the director omits it");
  await dispatchTool().handler({ title: "T", workspace, brief: "B", effort: "max" }, {});
  assert.equal(dispatched[1]?.effort, "max", "an explicit tool argument still wins");

  director.handleUserMessage("also bump the version");
  await dispatchTool().handler({ title: "T", workspace, brief: "B" }, {});
  assert.equal(dispatched[2]?.effort, "high", "a follow-up steering the same turn keeps the earlier ask");

  director.cancelTurn();
  dInternals.run = undefined;
  director.handleUserMessage("fix the typo in the README");
  await settle();
  await dispatchTool().handler({ title: "T", workspace, brief: "B" }, {});
  assert.equal(dispatched[3]?.effort, undefined, "a new turn without an ask leaves the pipeline to pick");

  // The CLI-bridge director dispatches through executeDirectorCliAction with the same turn defaults.
  director.cancelTurn();
  const turnMode = () => ({ durationMs: null, agentCount: null, effort: "max" as const });
  const cliDispatch = (kind: DirectorCliAction["kind"]) =>
    executeDirectorCliAction({ kind, title: "T", workspace, brief: "B" }, mgr, {} as Scheduler, {} as OperatorNotes, [], turnMode);
  await cliDispatch("dispatch");
  await cliDispatch("dispatch_read");
  assert.equal(dispatched[4]?.effort, "max", "the CLI bridge falls back to the turn's named effort");
  assert.equal(dispatched[5]?.effort, undefined, "the read lane never takes an implementor effort");

  // Skip-director: the message's own ask beats the composer's standing pick.
  mgr.setSettings({ skipDirectorRetitle: false, skipDirectorEffort: "low" });
  await director.dispatchDirect("review this with high effort", workspace);
  assert.equal(dispatched[6]?.effort, "high", "skip-director pins the effort named in the message");
  await director.dispatchDirect("review this", workspace);
  assert.equal(dispatched[7]?.effort, "low", "without one, the composer's pick applies");

  console.log("PASS — effort request");
} finally {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const i = mgr as any;
  for (const key of ["capSupervisor", "tokenResumeTimer", "capResumeWake"]) if (i[key]) clearTimeout(i[key]);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
