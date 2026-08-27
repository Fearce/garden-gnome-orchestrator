/**
 * Integration gate for the ThreadManager's free-provider handoff.
 *
 * The provider adapters and bounded harness have their own focused unit coverage. This pins the
 * production seam that sits above both: a real Db + EventHub + ThreadManager must record a free reader
 * run, accept a finding-backed answer, and reject an `answered:true` result that forgot the finding so
 * runRole proceeds into its unchanged paid-backend fallback branch. No real credential or inference call
 * is made; only the provider HTTP leaf is stubbed.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunConfig } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { READER_SCHEMA } = await import("../agents/roles.js");
const { T } = await import("../agents/toolNames.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { FreeProviderService } = await import("../freeProviders/service.js");

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  auxToken(): string | undefined { return undefined; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

type ReplyMode = "answer-with-finding" | "answer-without-finding";
let mode: ReplyMode = "answer-with-finding";
let completionCalls = 0;

const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://api.kilo.ai/api/gateway/models") {
    return json({ data: [{
      id: "vendor/coder:free",
      name: "Stub Free Coder",
      context_length: 128_000,
      pricing: { prompt: "0", completion: "0", request: "0" },
      supported_parameters: ["tools"],
    }] });
  }
  if (url === "https://api.kilo.ai/api/gateway/chat/completions") {
    completionCalls++;
    const request = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> };
    if (mode === "answer-with-finding" && !request.messages?.some((message) => message.role === "tool")) {
      return json({
        model: "vendor/coder:free",
        choices: [{ message: {
          content: "",
          tool_calls: [{
            id: "finding-1",
            type: "function",
            function: {
              name: T.postFinding,
              arguments: JSON.stringify({ summary: "The lookup answer", detail: "The stubbed free reader posted this finding.", severity: "info" }),
            },
          }],
        } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      });
    }
    return json({
      model: "vendor/coder:free",
      choices: [{ message: { content: "```json\n{\"answered\":true,\"escalated\":false}\n```" } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    });
  }
  throw new Error(`unexpected provider URL: ${url}`);
}) as typeof fetch;

const root = mkdtempSync(join(tmpdir(), "free-routing-itest-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(root, "orchestrator.sqlite"));
const hub = new EventHub();
const providers = new FreeProviderService(db, {}, fetchStub);
providers.update("kilo", { enabled: true });
providers.setRoutingEnabled(true);
await providers.refresh("kilo");
const manager = new ThreadManager(db, hub, new FileMemoryService(join(root, "memory")), new StubAccounts() as unknown as AccountManager, providers);

function thread(title: string): Thread {
  return db.createThread({ title, workspace, rawPrompt: title, brief: title, lane: "read" });
}

function readerConfig(): AgentRunConfig {
  return {
    model: "free-test",
    cwd: workspace,
    systemPrompt: "Answer the lookup and post its finding.",
    outputFormat: { type: "json_schema", schema: READER_SCHEMA },
  } as AgentRunConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runFreeReader = (current: Thread) => (manager as any).tryFreeStructuredRole(
  current,
  "reader",
  "What does the stub say?",
  () => readerConfig(),
);

try {
  const answered = thread("free reader posts its answer");
  const success = await runFreeReader(answered);
  assert.ok(success && !success.isError, "a finding-backed free reader result is accepted");
  assert.ok(db.listFindings(answered.id).some((finding) => finding.summary === "The lookup answer"), "the reader's actual answer finding reaches the task board");
  const successRun = db.listRuns(answered.id).find((run) => run.account === "free:kilo");
  assert.equal(successRun?.state, "done", "the free reader has a normal completed agent_runs row");
  await manager.finalizeReader(answered, success);
  assert.equal(db.getThread(answered.id)?.state, "closed", "the accepted free reader traverses the normal reader finalizer");

  mode = "answer-without-finding";
  const missingFinding = thread("free reader forgets finding");
  const rejected = await runFreeReader(missingFinding);
  assert.equal(rejected, undefined, "answered:true without a finding is rejected so runRole continues to its paid fallback");
  const failedRun = db.listRuns(missingFinding.id).find((run) => run.account === "free:kilo");
  assert.equal(failedRun?.state, "error", "the rejected free run is visible as an error rather than silently accepted");
  assert.match(failedRun?.error ?? "", /without posting its answer finding/i);
  assert.ok(
    db.listFindings(missingFinding.id).some((finding) => /could not finish the free reader run/i.test(finding.summary)),
    "the fallback reason is recorded for the owner and paid-ladder diagnosis",
  );
  assert.ok(completionCalls >= 3, "the real free harness made its bounded provider turns through ThreadManager");

  console.log("free-provider ThreadManager routing integration passed");
} finally {
  // The temporary manager owns only unref'd timers in this configuration. Closing the real DB before
  // removing the temporary directory keeps Windows from retaining the SQLite handle into another gate.
  try { db.raw.close(); } catch { /* already closed */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* OS cleanup can reclaim a locked temp dir */ }
}
