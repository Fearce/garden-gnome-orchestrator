/**
 * "Summarize done task deliverables" gate.
 *
 * REAL: SQLite, ThreadManager settle path (setState → publishState), stage outputs, EventHub, the
 * thread.history hook, prompt building and source keys. STUBBED: global fetch (the Sonnet call) and the
 * account token. No network or quota is used.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { DeliverableSummary, Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { buildDeliverableSummaryPrompt, cleanDeliverableSummary, summarySourceKey, DELIVERABLE_SUMMARY_MODEL, OAUTH_SYSTEM_PROMPT } = await import(
  "../orchestrator/deliverableSummary.js"
);

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

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
  auxToken(): string | undefined { return "aux-token"; }
}

type Privates = {
  setState(threadId: string, state: Thread["state"], error?: string | null): void;
  capSupervisor?: NodeJS.Timeout;
  tokenResumeTimer?: NodeJS.Timeout;
  capResumeWake?: NodeJS.Timeout;
};

// ---- the Sonnet call, stubbed: every request is recorded; the reply text is scripted per call ----
const calls: Array<{ model: string; prompt: string; auth: string; system?: string }> = [];
let nextReply: (prompt: string) => string = () => "Shipped the fix.\n\n**Deliverables**\n- Report — `report.md`";
let gate: Promise<void> | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).includes("api.anthropic.com/v1/messages")) return realFetch(url, init);
  const body = JSON.parse(String(init?.body)) as { model: string; system?: string; messages: Array<{ content: string }> };
  const prompt = body.messages[0]!.content;
  calls.push({ model: body.model, prompt, auth: String((init?.headers as Record<string, string>).Authorization), system: body.system });
  if (gate) await gate;
  return new Response(JSON.stringify({ content: [{ type: "text", text: nextReply(prompt) }] }), { status: 200 });
}) as typeof fetch;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const dir = mkdtempSync(join(tmpdir(), "deliverable-summary-"));
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const published: Array<{ threadId: string; summary: DeliverableSummary }> = [];
hub.subscribe((event) => {
  if (event.type === "thread.deliverableSummary") published.push({ threadId: event.threadId, summary: event.summary });
});
const manager = new ThreadManager(db, hub, new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
const priv = manager as unknown as Privates;

const CAP_PARK_PREFIX = "⏳ Auto-resume pending"; // mirrors threadManager.ts (module-private there)
const FINAL_REPORT ="Implemented the export.\n\nValidation: `npm test` passed.\n\nCommit abc123 pushed.";
const QA_NOISE = "QA verdict: PASS — reviewed every hunk, nothing to add.";

/** A task with one completed implementor memo and QA chatter after it in the feed. */
function seedTask(title: string): string {
  const t = db.createThread({ title, workspace: dir, rawPrompt: `${title} brief` });
  db.updateThread(t.id, { state: "implementing", brief: `Please ${title}.` });
  const run = db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5-5", account: "subscription-a" });
  db.updateRun(run.id, { state: "done", endedAt: Date.now() });
  db.addMessage({ threadId: t.id, runId: run.id, role: "implementor", kind: "text", content: FINAL_REPORT });
  db.upsertImplementationMemo({
    threadId: t.id,
    runId: run.id,
    outcome: "completed",
    handoff: "qa",
    report: FINAL_REPORT,
    model: "claude-opus-5-5",
    startedAt: Date.now() - 1000,
    completedAt: Date.now(),
  });
  const qa = db.createRun({ threadId: t.id, role: "qa", model: "claude-opus-5-5", account: "subscription-a" });
  db.addMessage({ threadId: t.id, runId: qa.id, role: "qa", kind: "text", content: QA_NOISE });
  return t.id;
}

console.log("\nA. prompt and source key");
const baseInput = {
  title: "Export CSV",
  brief: "Add a CSV export.",
  state: "review" as const,
  reviewReason: "Needs the owner to approve the schema.",
  report: FINAL_REPORT,
  deliverables: [{ label: "Export sample", path: "out/sample.csv", description: "Ten rows" }],
};
const prompt = buildDeliverableSummaryPrompt(baseInput);
check("prompt carries the brief, report, file and review reason", ["Add a CSV export.", FINAL_REPORT, "out/sample.csv", "approve the schema"].every((part) => prompt.includes(part)));
check("the default summarizer is a Sonnet model", /sonnet/.test(DELIVERABLE_SUMMARY_MODEL), DELIVERABLE_SUMMARY_MODEL);
check("source key is stable for identical inputs", summarySourceKey(baseInput) === summarySourceKey({ ...baseInput }));
check("a new deliverable changes the source key", summarySourceKey(baseInput) !== summarySourceKey({ ...baseInput, deliverables: [...baseInput.deliverables, { label: "x", path: "x.md" }] }));
check("review → done changes the source key", summarySourceKey(baseInput) !== summarySourceKey({ ...baseInput, state: "done" }));
check("a reply that disputes the work is rejected", cleanDeliverableSummary("This is not a coding task, so nothing was done.") === null);
check("a heading preamble is stripped", cleanDeliverableSummary("## Summary\n\nShipped it.") === "Shipped it.");

console.log("\nB. setting off (the default) costs nothing");
check("the setting defaults to off", manager.settings().summarizeDoneDeliverables === false);
const offTask = seedTask("off task");
priv.setState(offTask, "done");
manager.deliverableSummaryOnOpen(offTask);
await settle();
check("no Sonnet call while off, on settle or on open", calls.length === 0, String(calls.length));

manager.setSettings({ summarizeDoneDeliverables: true });
check("setSettings persists on", db.kvGet("setting_summarize_done_deliverables") === "1" && manager.settings().summarizeDoneDeliverables === true);

console.log("\nC. a task settling to done is summarized once, from the memo only");
const doneTask = seedTask("done task");
manager.postFinding({ threadId: doneTask, fromRole: "implementor", kind: "deliverable", summary: "Report", label: "Report", path: join(dir, "report.md"), detail: "The owner report", severity: "info" });
priv.setState(doneTask, "done");
await settle();
check("exactly one Sonnet call", calls.length === 1, String(calls.length));
check("it rides the subscription aux token", calls[0]?.auth === "Bearer aux-token");
check("the call names the Sonnet summarizer model", calls[0]?.model === DELIVERABLE_SUMMARY_MODEL);
// Without the Claude Code system prompt a subscription token gets 429 on every Sonnet call (measured live).
check("it identifies as Claude Code, which an OAuth token needs for Sonnet", calls[0]?.system === OAUTH_SYSTEM_PROMPT, calls[0]?.system);
check("the prompt holds the final report and the deliverable", !!calls[0]?.prompt.includes(FINAL_REPORT) && !!calls[0]?.prompt.includes("report.md"));
check("QA feed chatter never reaches the summarizer", !calls[0]?.prompt.includes(QA_NOISE));
const stored = db.getThreadStageOutputs(doneTask).deliverableSummary;
check("the summary is stored durably", stored?.text.startsWith("Shipped the fix.") === true && stored?.taskState === "done", JSON.stringify(stored));
check("it is published live to the console", published.some((event) => event.threadId === doneTask && event.summary.sourceKey === stored?.sourceKey));
check("it names the memo it condensed", stored?.memoId === db.listImplementationMemos(doneTask)[0]?.id);

priv.setState(doneTask, "done");
check("opening the task returns the stored summary", manager.deliverableSummaryOnOpen(doneTask)?.sourceKey === stored?.sourceKey);
await settle();
check("an unchanged task is never summarized twice", calls.length === 1, String(calls.length));

console.log("\nD. a changed input regenerates; a cap-park does not; a real review does");
manager.postFinding({ threadId: doneTask, fromRole: "implementor", kind: "deliverable", summary: "Chart", label: "Chart", path: join(dir, "chart.png"), severity: "info" });
manager.deliverableSummaryOnOpen(doneTask);
await settle();
check("a new deliverable triggers one fresh summary", calls.length === 2 && !!calls[1]?.prompt.includes("chart.png"), String(calls.length));

const capTask = seedTask("cap parked");
calls.length = 0;
priv.setState(capTask, "review", `${CAP_PARK_PREFIX} — all compatible capacity is currently capped.`);
await settle();
check("a cap-park review is not a finish and is not summarized", calls.length === 0, String(calls.length));
// Settle it out of reach of the real cap supervisor, which would otherwise auto-resume it into a pipeline.
db.updateThread(capTask, { state: "closed", error: null });

const reviewTask = seedTask("review task");
priv.setState(reviewTask, "review", "Needs you to approve the migration.");
await settle();
check("a genuine review settle is summarized", calls.length === 1 && !!calls[0]?.prompt.includes("approve the migration"), String(calls.length));
check("its summary records the review state", db.getThreadStageOutputs(reviewTask).deliverableSummary?.taskState === "review");

console.log("\nE. inputs that change mid-call are never stored stale");
calls.length = 0;
const raceTask = seedTask("race task");
let release!: () => void;
gate = new Promise<void>((resolve) => (release = resolve));
nextReply = (p) => (p.includes("late.md") ? "Fresh summary with late.md." : "Stale summary.");
priv.setState(raceTask, "done");
await settle();
manager.postFinding({ threadId: raceTask, fromRole: "implementor", kind: "deliverable", summary: "Late", label: "Late", path: join(dir, "late.md"), severity: "info" });
manager.deliverableSummaryOnOpen(raceTask); // a second trigger with new inputs while the first is in flight
gate = null;
release();
await settle();
await settle();
const raced = db.getThreadStageOutputs(raceTask).deliverableSummary;
check("the stored summary describes the current inputs", raced?.text === "Fresh summary with late.md.", raced?.text);
check("no stale summary was ever published", !published.some((event) => event.threadId === raceTask && event.summary.text === "Stale summary."));

console.log("\nF. a failed call leaves nothing behind");
calls.length = 0;
nextReply = () => "";
const failTask = seedTask("fail task");
priv.setState(failTask, "done");
await settle();
check("an empty reply stores no summary", calls.length === 1 && db.getThreadStageOutputs(failTask).deliverableSummary == null);

manager.setSettings({ summarizeDoneDeliverables: false });
check("setSettings persists off", db.kvGet("setting_summarize_done_deliverables") === "0");

globalThis.fetch = realFetch;
try {
  if (priv.capSupervisor) clearInterval(priv.capSupervisor);
  if (priv.tokenResumeTimer) clearTimeout(priv.tokenResumeTimer);
  if (priv.capResumeWake) clearTimeout(priv.capResumeWake);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
} catch {
  // The process exits below; Windows releases a transient SQLite/temp-dir handle with it.
}

console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
