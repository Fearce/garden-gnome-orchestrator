// Real dispatch, Db, cap handling, subtask barrier and AccountManager. Only provider/git leaves are fake.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager as AccountsType } from "../accounts/accountManager.js";
import type { CloudRunInput } from "../cloudSessions/client.js";

const root = mkdtempSync(join(tmpdir(), "cloud-subtasks-test-"));
process.env.DATA_DIR = root;
process.env.CODEX_HOME_DIR = join(root, "codex");
process.env.CODEX_SOURCE_HOME = join(root, "codex-source");
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { cloudCreditsReady } = await import("../accounts/cloudCredits.js");
const { subTaskReport } = await import("../orchestrator/subTasks.js");
const { CloudSubtaskService } = await import("../cloudSessions/subtasks.js");
const hub = new EventHub();
const db = new Db(join(root, "test.sqlite"));
const workspace = join(root, "repository"); mkdirSync(workspace);
const clock = Date.now();
const credits = { remaining: 100, limit: 100, used: 0, expiresAt: clock + 86400000, locked: false, readAt: clock };
const account = { id: "cloud-test", label: "Cloud test", enabled: true, rateLimited: true, fiveHour: 100, sevenDay: 20,
  fiveHourReset: clock + 3600000, cloudCredits: credits };
let credentialValid = true;
let duringAccountVerification: (() => void) | undefined;
class StubAccounts {
  dto() { return [account]; }
  hasHeadroom() { return false; }
  dispatchPreview() { return { account: { id: account.id, label: account.label }, hasHeadroom: false }; }
  onUsageRefresh() {} effectiveUtilization() { return null; } soonestResetAt() { return null; }
  setPingInterval() {} applyEnabled() {} applyWeeklySafetyPct() {} setSpreadUsage() {} setProfileToken() {}
  auxToken() { return undefined; }
  cloudFallbackAccountCurrent() {
    return credentialValid && account.enabled && (account.rateLimited || account.fiveHour >= 100)
      && cloudCreditsReady(account.cloudCredits);
  }
  async cloudFallbackAccount() {
    duringAccountVerification?.();
    return credentialValid ? { id: account.id, label: account.label, token: "test-profile-login", organizationId: "org-test", remainingCredits: credits.remaining } : null;
  }
}
const manager = new ThreadManager(db, hub, new FileMemoryService(join(root, "memory")), new StubAccounts() as unknown as AccountsType);
const internals = manager as any;
const automatic = manager.cloudSubtasks as any;
const realStart = internals.startPipeline.bind(manager);
const localStarts: string[] = [];
internals.startPipeline = (id: string) => {
  if (db.getThread(id)?.subTask?.cloud) realStart(id);
  else localStarts.push(id);
};
const head = "a".repeat(40);
let dirty = false, pushed = true;
automatic.git = async (_cmd: string, args: string[]) => ({ code: 0, timedOut: false, stderr: "", stdout:
  args[0] === "config" ? "https://github.com/example/webapp.git" : args[0] === "status" ? (dirty ? " M README.md" : "")
    : args[0] === "symbolic-ref" ? "main" : args[0] === "ls-remote" ? `${pushed ? head : "b".repeat(40)}\trefs/heads/main` : args[0] === "rev-parse" ? head : "" });
let calls = 0, hold = false, mode = "ok";
let finish: (() => void) | undefined;
automatic.runner = async (input: CloudRunInput) => {
  calls++;
  assert.equal(input.token, "test-profile-login");
  assert.equal(input.repository, "example/webapp");
  assert.equal(input.revision, head);
  assert.ok(input.prompt.includes("Read-only: do not edit"));
  if (mode === "unsent") return { ok: false, sessionId: null, result: null, started: false, error: "Cloud opt-in was removed. No cloud session was started." };
  input.onSession("session_test");
  if (hold) await new Promise<void>(resolve => { finish = resolve; input.signal.addEventListener("abort", () => resolve(), { once: true }); });
  return { ok: mode === "ok" && !input.signal.aborted, sessionId: "session_test", result: mode === "ok" && !input.signal.aborted ? "Repository review: parser has a missing bounds check." : null, error: mode === "ok" && !input.signal.aborted ? null : "No verified cloud result." };
};
const parentId = await manager.dispatch({ title: "Parent", workspace, brief: "Review repository" });
internals.setState(parentId, "implementing");
const parent = db.getThread(parentId)!;
const model = manager.subTasks.roster().find(p => p.provider === "claude")!.defaultModel!;
const spawner = { threadId: parentId, role: "implementor" as const, runId: null };
const input = { provider: "claude", model, title: "Review parser", brief: "Read parser and report bounds checking findings.", cloudWork: "review" };
async function settled(id: string) {
  for (let i = 0; i < 150; i++) { if (db.getThread(id)?.state === "review") return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail(`cloud child did not settle: ${db.getThread(id)?.state}`);
}
try {
  assert.equal(await manager.cloudSubtasks.admit(parent, "review"), undefined, "opt-in defaults off");
  manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: ["example/webapp"] });
  assert.throws(() => manager.cloudSubtasks.configure({ accountIds: ["unknown"], repositories: ["example/webapp"] }));
  assert.throws(() => manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: ["https://example.com/evil"] }));
  assert.equal(await manager.cloudSubtasks.admit(parent, undefined), undefined, "undeclared work stays local");
  dirty = true; assert.equal(await manager.cloudSubtasks.admit(parent, "review"), undefined, "dirty checkout cannot upload"); dirty = false;
  pushed = false; assert.equal(await manager.cloudSubtasks.admit(parent, "review"), undefined, "unpublished commit cannot offload"); pushed = true;
  credentialValid = false;
  const invalidAccount = (await manager.subTasks.spawn(spawner, { ...input, title: "Rejected account" })).thread!;
  await settled(invalidAccount.id);
  assert.equal(calls, 0, "unverified launch account never starts a cloud agent");
  credentialValid = true;
  duringAccountVerification = () => manager.cloudSubtasks.configure({ accountIds: [], repositories: ["example/webapp"] });
  const revoked = (await manager.subTasks.spawn(spawner, { ...input, title: "Revoked cloud opt-in" })).thread!;
  await settled(revoked.id);
  assert.equal(calls, 0, "revoking opt-in during verification prevents session creation");
  assert.match(db.getThread(revoked.id)?.error ?? "", /opt-in was removed/);
  duringAccountVerification = undefined;
  manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: ["example/webapp"] });
  duringAccountVerification = () => manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: [] });
  const revokedRepository = (await manager.subTasks.spawn(spawner, { ...input, title: "Revoked cloud repository" })).thread!;
  await settled(revokedRepository.id);
  assert.equal(calls, 0, "revoking repository permission during verification prevents session creation");
  duringAccountVerification = undefined;
  manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: ["example/webapp"] });
  for (const bad of [{ ...credits, remaining: 0 }, { ...credits, expiresAt: clock - 1 }, { ...credits, locked: true }, { ...credits, readAt: clock - 3600000 }, { ...credits, readAt: clock + 3600000 }]) {
    assert.equal(cloudCreditsReady(bad), false);
    account.cloudCredits = bad;
    assert.equal(await manager.cloudSubtasks.admit(parent, "review"), undefined, "invalid balance cannot offload");
  }
  account.cloudCredits = credits;
  account.rateLimited = false; account.fiveHour = 20;
  assert.equal(await manager.cloudSubtasks.admit(parent, "review"), undefined, "ordinary allowance is used before cloud fallback");
  account.rateLimited = true; account.fiveHour = 100;
  const child = (await manager.subTasks.spawn(spawner, input)).thread!;
  assert.ok(child?.subTask?.cloud, "cap-triggered spawn chooses cloud automatically");
  await settled(child.id);
  assert.equal(calls, 1);
  assert.ok(!localStarts.includes(child.id), "cloud does not invoke a local implementor");
  const job = manager.cloudSubtasks.jobs()[0]!;
  assert.equal(job.state, "review"); assert.equal(job.url, "https://claude.ai/code/session_test");
  assert.ok(db.listRuns(child.id)[0]?.sessionId === "session_test", "run and provider session are durable");
  assert.ok(subTaskReport(db, db.getThread(child.id)!).includes("missing bounds check"), "parent receives actual cloud result");
  assert.equal(db.getThread(parentId)?.state, "implementing", "cloud completion does not complete the parent");
  await manager.cloudSubtasks.run(db.getThread(child.id)!);
  assert.equal(calls, 1, "resume never re-submits cloud work");
  assert.ok(!JSON.stringify(manager.cloudSubtasks.snapshot()).includes("test-profile-login"), "snapshot redacts credentials");
  // Explicit cloud requests exercise the same spawn path, with no silent local fallback.
  const explicit = { ...input, cloudOnly: true };
  const startsBeforeRefusals = localStarts.length, childrenBeforeRefusals = db.listSubTasks(parentId).length;
  assert.equal((await manager.subTasks.spawn(spawner, { ...explicit, provider: "codex" })).ok, false);
  assert.equal((await manager.subTasks.spawn(spawner, { ...explicit, cloudWork: undefined })).ok, false);
  manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: ["example/other"] });
  const disallowed = await manager.subTasks.spawn(spawner, explicit);
  assert.equal(disallowed.ok, false);
  assert.match(disallowed.message, /example\/webapp is not allowed/);
  assert.match(disallowed.message, /No local sub-agent was started/);
  manager.cloudSubtasks.configure({ accountIds: [account.id], repositories: ["example/webapp"] });
  pushed = false;
  assert.match((await manager.subTasks.spawn(spawner, explicit)).message, /Push the current branch/);
  pushed = true;
  account.enabled = false;
  assert.equal((await manager.subTasks.spawn(spawner, explicit)).ok, false);
  account.enabled = true;
  account.cloudCredits = { ...credits, remaining: 0 };
  assert.equal((await manager.subTasks.spawn(spawner, explicit)).ok, false);
  account.cloudCredits = credits;
  assert.equal(localStarts.length, startsBeforeRefusals, "cloud-only refusals never launch local agents");
  assert.equal(db.listSubTasks(parentId).length, childrenBeforeRefusals, "refusals never create misleading children");
  account.rateLimited = false; account.fiveHour = 20; dirty = true;
  const required = await manager.subTasks.spawn(spawner, { ...explicit, title: "Explicit cloud before cap" });
  assert.equal(required.ok, true);
  assert.match(required.message, /on Claude cloud/);
  assert.equal(db.getThread(required.thread!.id)?.subTask?.cloudOnly, true, "cloud-only choice survives DB parsing");
  await settled(required.thread!.id);
  assert.equal(localStarts.length, startsBeforeRefusals, "explicit cloud never invokes local implementation");
  assert.equal(manager.cloudSubtasks.jobs().find(j => j.threadId === required.thread!.id)?.state, "review");
  assert.match(db.listMessages(parentId).map(m => m.content).join("\n"), /Explicit cloud before cap.*on Claude cloud/);
  const localResume = internals.resumeImplementorOnly;
  let localResumeCalls = 0;
  internals.resumeImplementorOnly = async () => { localResumeCalls++; return { ok: true, state: "implementing" }; };
  const resumedCloud = await manager.resumeThread(required.thread!.id, undefined, true);
  assert.equal(resumedCloud.ok, false, "finished cloud child cannot resume locally");
  assert.match(resumedCloud.error ?? "", /cloud session in Claude/);
  assert.equal(localResumeCalls, 0, "cloud-only review never reaches local resume");
  assert.equal((await manager.autoReview(required.thread!.id)).ok, false, "cloud results are reviewed in the parent, without a local review pipeline");
  internals.resumeImplementorOnly = localResume;
  dirty = false;
  const ordinary = await manager.subTasks.spawn(spawner, { ...input, title: "Automatic local with reason" });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.thread?.subTask?.cloud, undefined);
  assert.match(ordinary.message, /Cloud fallback not admitted: No opted-in subscription is capped/);
  assert.ok(localStarts.includes(ordinary.thread!.id));
  internals.setState(ordinary.thread!.id, "review");
  account.rateLimited = true; account.fiveHour = 100;
  mode = "unsent";
  const unsent = (await manager.subTasks.spawn(spawner, { ...input, title: "Unsent cloud create" })).thread!;
  await settled(unsent.id);
  mode = "ok";
  const unsentJob = manager.cloudSubtasks.jobs().find(j => j.threadId === unsent.id)!;
  assert.equal(unsentJob.state, "checked", "a provably unsent create does not demand a remote check");
  assert.ok(await manager.cloudSubtasks.admit(parent, "review"), "an unsent create does not block the account");

  // Exercise the actual cap-result loop, not only initial dispatch admission.
  const cappedChild = db.createThread({ title: "Capped child", workspace, rawPrompt: input.brief, brief: input.brief,
    parentId, subTask: { provider: "claude", model, effort: null, spawnedByRole: "implementor", spawnedByName: null, spawnedByRunId: null, cloudWork: "review" } });
  internals.capacityDemand = () => ({ label: "test", expectedDurationMs: 1000, expectedBurnPct: 0, reservePct: 0, substantial: false });
  internals.acctById = () => null;
  internals.latestImplementorRunModel = () => model;
  const cappedRun = { rateLimited: true, sessionId: "local-session", result: async () => ({ type: "result", subtype: "error_during_execution", isError: true }), stop: async () => {} };
  const turn = await internals.awaitImplementorResult(cappedChild, undefined, "brief", cappedRun, account.id, false, "continue");
  assert.equal(turn.res?.isError, false, "mid-run cap uses cloud subtask result");
  assert.ok(db.getThread(cappedChild.id)?.subTask?.cloud, "mid-run cloud type is durable");

  // The existing parent barrier must resume the parent with the report, exactly once.
  const deliveries: string[] = [];
  internals.stopLive = async () => {};
  internals.startResumedImplementor = async (_thread: unknown, _kickoff: unknown, _session: unknown, opts: { directorNote: string }) => {
    deliveries.push(opts.directorNote); return { run: {}, accountId: "cloud-test" };
  };
  internals.flushDirectorNotes = () => {};
  internals.awaitImplementorCompletion = async () => ({ type: "result", subtype: "success", isError: false });
  const success = { type: "result", subtype: "success", isError: false };
  await internals.integrateSubTasks(parent, undefined, "parent brief", success, true);
  assert.ok(deliveries[0]?.includes("missing bounds check"), "parent barrier resumes with cloud report for review");
  await internals.integrateSubTasks(parent, undefined, "parent brief", success, true);
  assert.equal(deliveries.length, 1, "parent results are delivered exactly once");

  mode = "failed";
  const failed = (await manager.subTasks.spawn(spawner, { ...input, title: "Ambiguous provider" })).thread!;
  await settled(failed.id);
  assert.equal(manager.cloudSubtasks.jobs().find(j => j.threadId === failed.id)?.state, "uncertain");
  assert.ok(subTaskReport(db, db.getThread(failed.id)!).includes("No verified cloud result"), "ambiguous outcome is returned for review");
  assert.equal(await manager.cloudSubtasks.admit(parent, "review"), undefined, "uncertain session blocks more work on that account");
  manager.cloudSubtasks.markChecked(failed.id);
  assert.ok(await manager.cloudSubtasks.admit(parent, "review"), "explicit remote check releases account for independent work");
  mode = "ok";

  hold = true;
  const firstPending = (await manager.subTasks.spawn(spawner, { ...input, title: "First pending review" })).thread!;
  for (let i = 0; i < 150 && !finish; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(finish, "cloud observation started");
  const callsBeforeQueue = calls;
  const pending = (await manager.subTasks.spawn(spawner, { ...input, title: "Queued review" })).thread!;
  await new Promise(r => setTimeout(r, 50));
  assert.equal(db.getThread(pending.id)?.state, "queued", "same-account cloud work waits for current observer");
  assert.equal(calls, callsBeforeQueue, "queue does not oversubscribe a cloud account");
  const releaseFirst = finish; finish = undefined; releaseFirst?.();
  await settled(firstPending.id);
  for (let i = 0; i < 150 && !finish; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(finish, "next cloud child runs when account frees");
  const snapshot = manager.cloudSubtasks.snapshot();
  assert.equal(snapshot.jobs[0]?.state, "running");
  await manager.interruptThread(pending.id);
  assert.equal(db.getThread(pending.id)?.state, "paused", "interrupt stops local observer");
  (finish as (() => void) | undefined)?.(); await new Promise(r => setTimeout(r, 100));
  assert.equal(manager.cloudSubtasks.jobs().find(j => j.threadId === pending.id)?.state, "uncertain", "interrupted remote work never pretends to be stopped");
  const stoppedResume = await manager.resumeThread(pending.id, "Continue", true);
  assert.equal(stoppedResume.ok, false, "paused cloud child cannot resume locally");
  assert.match(stoppedResume.error ?? "", /session_test/);
  assert.equal(db.getThread(pending.id)?.state, "paused", "refusing resume preserves the cloud child and observer state");
  internals.setState(pending.id, "cancelled");
  assert.equal((await manager.retryThread(pending.id)).ok, false, "retry cannot erase a cloud child's recorded outcome");
  assert.equal(db.getThread(pending.id)?.state, "cancelled");
  const before = calls;
  const recovery = new CloudSubtaskService({ db, accounts: new StubAccounts() as unknown as AccountsType,
    setState: (id, state, error) => internals.setState(id, state, error), message: () => {} }, automatic.runner, automatic.git);
  await recovery.run(db.getThread(pending.id)!);
  assert.equal(calls, before, "restart does not duplicate an uncertain job");

  const { default: Fastify } = await import("fastify");
  const { CloudSessionService } = await import("../cloudSessions/service.js");
  const { registerCloudSessionRoutes } = await import("../cloudSessions/routes.js");
  const app = Fastify();
  registerCloudSessionRoutes(app, new CloudSessionService(db), db, cookie => cookie === "test-auth", recovery);
  try {
    assert.equal((await app.inject({ method: "PUT", url: "/api/cloud-sessions/automatic", payload: { accountIds: [account.id], repositories: ["example/webapp"] } })).statusCode, 401);
    assert.equal((await app.inject({ method: "PUT", url: "/api/cloud-sessions/automatic", headers: { cookie: "test-auth" }, payload: { accountIds: ["unknown"], repositories: [] } })).statusCode, 400);
    const snap = await app.inject({ method: "GET", url: "/api/cloud-sessions", headers: { cookie: "test-auth" } });
    assert.equal(snap.statusCode, 200); assert.ok(snap.json().automatic.jobs.length > 0);
    assert.ok(!snap.body.includes("test-profile-login"), "authenticated cloud API exposes no tokens");
    assert.equal((await app.inject({ method: "POST", url: `/api/cloud-sessions/automatic/jobs/${pending.id}/checked`, headers: { cookie: "test-auth" } })).statusCode, 200);
    assert.equal(recovery.jobs().find(j => j.threadId === pending.id)?.state, "checked", "API acknowledges uncertainty without deleting duplicate record");
  } finally { await app.close(); }

  // Real AccountManager verifies refreshed identity, balance and billing, without live credentials.
  const realAccounts = new AccountManager([{ id: "verified", label: "Verified", token: "inference", profileToken: "profile" }], hub);
  const state = (realAccounts as any).states.get("verified");
  Object.assign(state, { organizationId: "org-test", rateLimited: true, fiveHour: 100, fiveHourReset: clock + 3600000 });
  const oldFetch = globalThis.fetch;
  let org = "org-test", paidEnabled = false, grant = 100;
  globalThis.fetch = (async (url: string | URL) => new Response(JSON.stringify(String(url).endsWith("/profile")
    ? { organization: { uuid: org } } : String(url).includes("/prepaid/credits")
      ? { amount: 0, currency: "USD", auto_reload_settings: { enabled: false } }
      : { organization: { uuid: org }, extra_usage: { is_enabled: paidEnabled }, iguana_necktie: { limit_dollars: 100, used_dollars: 100 - grant, remaining_dollars: grant, resets_at: new Date(clock + 86400000).toISOString() } }))) as typeof fetch;
  try {
    assert.ok(await realAccounts.cloudFallbackAccount("verified"), "matching refreshed account accepted");
    const current = () => realAccounts.cloudFallbackAccountCurrent("verified", "profile", "org-test");
    assert.ok(current(), "fresh launch eligibility accepted");
    state.enabled = false; assert.equal(current(), false, "disabled subscription revokes launch"); state.enabled = true;
    state.account.profileToken = "replacement"; assert.equal(current(), false, "replaced profile token revokes old launch"); state.account.profileToken = "profile";
    state.organizationId = "other-org"; assert.equal(current(), false, "changed identity revokes launch"); state.organizationId = "org-test";
    const freshCredits = state.cloudCredits;
    for (const bad of [null, { ...freshCredits, remaining: 0 }, { ...freshCredits, locked: true },
      { ...freshCredits, expiresAt: Date.now() - 1 }, { ...freshCredits, readAt: Date.now() - 3600000 }]) {
      state.cloudCredits = bad; assert.equal(current(), false, "unusable credits revoke launch after environment discovery");
    }
    state.cloudCredits = freshCredits;
    state.rateLimited = false; state.fiveHour = 10; assert.equal(current(), false, "reset cap revokes launch");
    assert.ok(await realAccounts.cloudFallbackAccount("verified", false), "explicit cloud verifies grant without a cap");
    assert.equal(realAccounts.cloudFallbackAccountCurrent("verified", "profile", "org-test", false), true);
    state.enabled = false;
    assert.equal(realAccounts.cloudFallbackAccountCurrent("verified", "profile", "org-test", false), false, "explicit cloud still checks account enablement");
    state.enabled = true;
    paidEnabled = true;
    assert.equal(await realAccounts.cloudFallbackAccount("verified", false), null, "explicit cloud still refuses paid overage");
    paidEnabled = false;
    state.rateLimited = true; state.fiveHour = 100;
    assert.ok(await realAccounts.cloudFallbackAccount("verified"), "fresh read restores launch after overage is off");
    assert.ok(current());

    org = "other-org"; assert.equal(await realAccounts.cloudFallbackAccount("verified"), null, "wrong-account profile rejected"); org = "org-test";
    paidEnabled = true; assert.equal(await realAccounts.cloudFallbackAccount("verified"), null, "paid overage enabled rejected"); paidEnabled = false;
    grant = 0; assert.equal(await realAccounts.cloudFallbackAccount("verified"), null, "depleted fresh grant rejected"); grant = 100;
    state.rateLimited = false; state.fiveHour = 10; assert.equal(await realAccounts.cloudFallbackAccount("verified"), null, "uncapped refreshed account rejected");

    // A throttled balance read must not ask the operator to replace a valid login.
    for (const status of [429, 401]) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: { type: status === 429 ? "rate_limit_error" : "authentication_error" } }), { status })) as typeof fetch;
      await (realAccounts as any).readResetCredits(state);
      assert.equal(realAccounts.dto()[0]?.cloudCredits, undefined, "failed credit reads keep cloud admission closed");
      const error = realAccounts.dto()[0]?.resetCreditsError ?? "";
      assert.match(error, status === 429 ? /rate.limited.*next refresh/i : /profile token rejected/i);
      if (status === 429) assert.doesNotMatch(error, /re-copy|replace|rejected/i, "throttling does not demand a new login");
    }
  } finally { globalThis.fetch = oldFetch; }

  // Exercise the real hosted-session protocol, including the exact source of result events.
  const { runCloudSession } = await import("../cloudSessions/client.js");
  let sessionCount = 0, polls = 0, notified = false, resultMode = "ok";
  const protocolInput: CloudRunInput = { token: "profile-test", organizationId: "org-test", repository: "example/webapp",
    revision: head, remainingCredits: 2, work: "review", prompt: "Read package.json", model: "sonnet", effort: "high",
    signal: new AbortController().signal, onSession: id => { assert.equal(id, "cse_protocol"); notified = true; } };
  const provider = (async (url: string | URL, options: RequestInit) => {
    assert.ok(String(url).startsWith("https://api.anthropic.com/v1/"));
    assert.ok(!String(url).includes("profile-test") && !String(url).includes("routines"));
    assert.equal((options.headers as Record<string, string>)["x-organization-uuid"], "org-test");
    const session = { id: "cse_protocol", environment_id: "env_hosted", environment_kind: "anthropic_cloud", worker_status: "idle" };
    if (String(url).includes("environment_providers")) return new Response(JSON.stringify({ environments: [
      { kind: "bridge", state: "active", environment_id: "env_local" },
      { kind: "anthropic_cloud", state: "active", environment_id: "env_hosted", name: "Default" },
    ] }));
    if (options.method === "POST") {
      sessionCount++;
      assert.equal(sessionCount, 1, "session creation never retries");
      const body = JSON.parse(String(options.body));
      assert.equal(body.config.sources[0].revision, head, "cloud clones the verified exact commit");
      assert.equal(body.config.max_budget_usd, 2, "per-run estimate ceiling cannot exceed admitted grant");
      assert.equal(body.config.max_turns, 40);
      assert.equal(body.events[0].payload.request.mode, "auto");
      if (protocolInput.work === "review") assert.ok(body.config.disallowed_tools.includes("Bash"));
      else assert.match(body.config.outcomes[0].git_info.branches[0], /^claude\/ggo-/);
      if (resultMode === "lost") throw new Error("lost response after accepting create");
      return new Response(JSON.stringify({ session }));
    }
    assert.ok(notified, "session is durably recorded before observing output");
    if (String(url).includes("/events?")) {
      polls++;
      const payload = { type: "result", subtype: resultMode === "failed" ? "error_max_budget_usd" : "success", is_error: resultMode === "failed", result: "Actual remote findings" };
      return new Response(JSON.stringify({ data: polls === 1 ? [
        { source: "client", payload }, { source: "worker", payload: { type: "assistant", message: { content: "partial response" } } },
      ] : [{ source: "worker", payload }] }));
    }
    return new Response(JSON.stringify({ response_shape: session }));
  }) as typeof fetch;
  const runProtocol = async () => {
    sessionCount = 0; polls = 0; notified = false;
    return runCloudSession(protocolInput, provider, async () => {});
  };
  assert.equal((await runProtocol()).result, "Actual remote findings");
  assert.equal(polls, 2, "client-spoofed result and idle metadata do not complete a task");
  protocolInput.work = "change"; assert.equal((await runProtocol()).ok, true, "change tasks get a separate push branch");
  resultMode = "failed"; assert.equal((await runProtocol()).ok, false, "provider budget stop is not success");
  resultMode = "lost"; const lost = await runProtocol();
  assert.equal(lost.ok, false); assert.equal(lost.sessionId, null); assert.equal(sessionCount, 1);
  const aborted = new AbortController(); aborted.abort();
  sessionCount = 0;
  assert.equal((await runCloudSession({ ...protocolInput, signal: aborted.signal }, provider, async () => {})).ok, false);
  assert.equal(sessionCount, 0, "aborted work cannot create a session");
  sessionCount = 0;
  const revokedCreate = await runCloudSession({ ...protocolInput, canCreate: () => false }, provider, async () => {});
  assert.equal(revokedCreate.ok, false);
  assert.equal(sessionCount, 0, "revocation after environment discovery cannot create a session");
  assert.equal(revokedCreate.started, false, "an unsent create is not reported as a possibly running session");
  assert.match(revokedCreate.error ?? "", /opt-in was removed/);
  assert.equal(lost.started, undefined, "a lost create response stays uncertain");
  // Exercise service authorization through the real client after asynchronous environment discovery.
  const eligibilityService = new CloudSubtaskService({ db, accounts: new StubAccounts() as unknown as AccountsType,
    setState: () => {}, message: () => {} }, launch => runCloudSession(launch, async (url, options) => {
      if (String(url).includes("environment_providers")) account.enabled = false;
      return provider(url, options!);
    }, async () => {}), automatic.git);
  const disabledChild = db.createThread({ title: "Disabled before cloud creation", workspace, rawPrompt: input.brief,
    brief: input.brief, parentId, subTask: { provider: "claude", model, effort: null, spawnedByRole: "implementor",
      spawnedByName: null, spawnedByRunId: null, cloudWork: "review",
      cloud: { accountId: account.id, repository: "example/webapp", branch: "main", head } } });
  sessionCount = 0;
  await eligibilityService.run(disabledChild);
  account.enabled = true;
  assert.equal(sessionCount, 0, "disabling the subscription during environment discovery prevents the actual create POST");
  assert.equal(eligibilityService.jobs().find(j => j.threadId === disabledChild.id)?.state, "checked",
    "a disabled subscription stops before session creation without blocking other work");
  assert.match(eligibilityService.jobs().find(j => j.threadId === disabledChild.id)?.error ?? "", /account eligibility changed/,
    "the regression must reach the final eligibility guard, not an unrelated pre-create failure");
  console.log("cloud-subtasks: cap dispatch, mid-run fallback, admission, parent result, interrupt and restart checks passed");
} finally {
  for (const timer of [internals.capSupervisor, internals.tokenResumeTimer, internals.capResumeWake]) if (timer) clearTimeout(timer);
  await new Promise(r => setTimeout(r, 100));
  db.raw.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
