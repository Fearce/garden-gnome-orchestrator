import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import { cloudCreditsReady } from "../accounts/cloudCredits.js";
import type { Db } from "../db/db.js";
import type { Thread, ThreadState, SubTaskSpec } from "../types.js";
import { runChild } from "../childRunner.js";
import { CloudError, githubRepository } from "./service.js";
import { CLOUD_SESSION_ID, runCloudSession, type CloudRunInput, type CloudRunResult } from "./client.js";

const POLICY = "cloud_subtask_policy_v1";
const JOBS = "cloud_subtask_jobs_v1";
interface Policy { accountIds: string[]; repositories: string[] }
export interface CloudSubtaskJob {
  threadId: string; parentId: string; accountId: string; repository: string;
  state: "starting" | "running" | "review" | "uncertain" | "checked";
  sessionId: string | null; url: string | null; result: string | null; error: string | null;
  createdAt: number;
  runId: string;
}
interface Host {
  db: Db;
  accounts: AccountManager;
  setState(id: string, state: ThreadState, error?: string | null): void;
  message(id: string, text: string, runId?: string): void;
}
export function cloudAccountExhausted(a: { enabled: boolean; rateLimited: boolean; resetsAt?: number | null; fiveHour?: number | null; sevenDay?: number | null; fiveHourReset?: number | null; sevenDayReset?: number | null }, now = Date.now()): boolean {
  return a.enabled && ((a.rateLimited && (a.resetsAt == null || a.resetsAt > now))
    || ((a.fiveHour ?? 0) >= 100 && (a.fiveHourReset == null || a.fiveHourReset > now))
    || ((a.sevenDay ?? 0) >= 100 && (a.sevenDayReset == null || a.sevenDayReset > now)));
}

/** Cloud is a subtype of the existing Claude subtask, so the durable barrier and parent review apply.
 * Only a standalone, explicitly admitted brief is sent. No transcript, attachments or memory. */
export class CloudSubtaskService {
  private active = new Map<string, AbortController>();
  private busyAccounts = new Set<string>();
  constructor(private host: Host, private runner: (input: CloudRunInput) => Promise<CloudRunResult> = runCloudSession,
    private git: typeof runChild = runChild) {
    for (const job of this.jobs()) {
      if (job.state === "starting" || job.state === "running") {
        job.state = "uncertain";
        job.error = "GGO restarted while observing cloud work. Check the session before retrying.";
        this.saveJob(job);
        this.host.db.updateRun(job.runId, { state: "error", endedAt: Date.now(), error: job.error });
      }
    }
  }
  private policy(): Policy {
    const raw = this.host.db.kvGet(POLICY);
    return raw ? JSON.parse(raw) as Policy : { accountIds: [], repositories: [] };
  }
  jobs(): CloudSubtaskJob[] { return JSON.parse(this.host.db.kvGet(JOBS) || "[]") as CloudSubtaskJob[]; }
  private saveJob(job: CloudSubtaskJob): void {
    // Active and uncertain records must survive even after 100 other jobs: losing one permits duplicates.
    this.host.db.kvSet(JOBS, JSON.stringify([job, ...this.jobs().filter(j => j.threadId !== job.threadId)]));
  }
  snapshot() {
    const policy = this.policy();
    return { ...policy, jobs: this.jobs(), accounts: this.host.accounts.dto().map(a => ({
      id: a.id, label: a.label, enabled: policy.accountIds.includes(a.id),
      ready: cloudAccountExhausted(a) && cloudCreditsReady(a.cloudCredits),
    })) };
  }
  configure(input: Record<string, unknown>): Policy {
    const ids = input.accountIds, repos = input.repositories;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && this.host.accounts.dto().some(a => a.id === id))
      || !Array.isArray(repos) || repos.length > 100 || !repos.every(r => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r))) {
      throw new CloudError("Choose existing subscriptions and GitHub owner/repository names.");
    }
    const policy = { accountIds: [...new Set(ids)] as string[], repositories: [...new Set(repos.map(r => r.toLowerCase()))] as string[] };
    this.host.db.kvSet(POLICY, JSON.stringify(policy));
    return policy;
  }
  markChecked(threadId: string): void {
    const job = this.jobs().find(j => j.threadId === threadId);
    if (!job || job.state !== "uncertain" || this.isActive(threadId)) throw new CloudError("Only an uncertain session with no active observer can be acknowledged.", 409);
    job.state = "checked";
    this.saveJob(job); // retain the record: acknowledging never permits re-submission of the same thread
  }
  /** No network mutation: inspect the local checkout and select a freshly verified capped account. */
  async admit(parent: Thread, work: SubTaskSpec["cloudWork"]): Promise<SubTaskSpec["cloud"] | undefined> {
    if (!work || parent.lane === "vanilla") return undefined;
    const policy = this.policy();
    if (!policy.accountIds.length || !policy.repositories.length) return undefined;
    const candidates = this.host.accounts.dto().filter(a => policy.accountIds.includes(a.id)
      && cloudAccountExhausted(a) && cloudCreditsReady(a.cloudCredits)
      && !this.jobs().some(j => j.accountId === a.id && j.state === "uncertain"));
    if (!candidates.length) return undefined;
    const run = (args: string[]) => this.git("git", args, { cwd: parent.workspace, urgent: true, timeoutMs: 15_000 });
    const [remote, status, head, branch] = await Promise.all([
      run(["config", "--get", "remote.origin.url"]), run(["status", "--porcelain"]),
      run(["rev-parse", "HEAD"]), run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ]);
    if ([remote, status, head, branch].some(r => r.code !== 0 || r.timedOut) || status.stdout.trim()) return undefined;
    const repository = githubRepository(remote.stdout);
    if (!repository || !policy.repositories.includes(repository)) return undefined;
    const branchName = branch.stdout.trim(), sha = head.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha) || !branchName || branchName.startsWith("-")) return undefined;
    const pushed = await run(["ls-remote", "--exit-code", "--refs", "origin", `refs/heads/${branchName}`]);
    if (pushed.code !== 0 || pushed.timedOut || pushed.stdout.split(/\s/)[0] !== sha) return undefined;
    // The DTO is already identity-attributed and fresh. Refresh credentials, balance and billing once
    // at the actual launch boundary, rather than spending the provider's read allowance twice.
    return { accountId: candidates[0]!.id, repository, branch: branchName, head: sha };
  }
  stop(id: string): void { this.active.get(id)?.abort(); }
  isActive(id: string): boolean { return this.active.has(id); }
  async run(thread: Thread): Promise<void> {
    const spec = thread.subTask, cloud = spec?.cloud;
    if (!cloud || !spec.cloudWork || !thread.parentId) return;
    const existing = this.jobs().find(j => j.threadId === thread.id);
    if (existing) {
      this.host.message(thread.id, `Cloud work already recorded (${existing.state}). ${existing.url ?? "Check Claude's session list."} No duplicate was started.`);
      this.host.setState(thread.id, "review", existing.error);
      return;
    }
    const policy = this.policy();
    if (!policy.accountIds.includes(cloud.accountId) || !policy.repositories.includes(cloud.repository)) {
      this.host.setState(thread.id, "review", "Cloud opt-in was removed.");
      return;
    }
    const controller = new AbortController();
    this.active.set(thread.id, controller);
    if (this.busyAccounts.has(cloud.accountId)) {
      this.host.setState(thread.id, "queued");
      this.host.message(thread.id, "Waiting for this subscription's current cloud subtask before verifying its remaining credits.");
    }
    const deadline = Date.now() + 30 * 60_000;
    while (this.busyAccounts.has(cloud.accountId) && !controller.signal.aborted && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (controller.signal.aborted) { this.active.delete(thread.id); return; }
    if (this.busyAccounts.has(cloud.accountId) || this.jobs().some(j => j.accountId === cloud.accountId && j.state === "uncertain")) {
      this.active.delete(thread.id);
      this.host.setState(thread.id, "review", "Check this subscription's unfinished cloud session before starting more work.");
      return;
    }
    this.busyAccounts.add(cloud.accountId);
    let checkout: string | undefined;
    let job: CloudSubtaskJob | undefined;
    try {
      const currentPolicy = this.policy();
      if (!currentPolicy.accountIds.includes(cloud.accountId) || !currentPolicy.repositories.includes(cloud.repository)) throw new CloudError("Cloud opt-in was removed. No task started.");
      const account = await this.host.accounts.cloudFallbackAccount(cloud.accountId);
      if (!account) throw new CloudError("Cloud account, cap, promotional balance or overage-off verification failed. No task started.");
      if (controller.signal.aborted) return;
      checkout = await mkdtemp(join(tmpdir(), "ggo-cloud-subtask-"));
      const clone = await this.git("git", ["clone", "--depth", "1", "--single-branch", "--branch", cloud.branch, "--", `https://github.com/${cloud.repository}.git`, checkout], { urgent: true, timeoutMs: 60_000 });
      if (clone.code !== 0 || clone.timedOut) throw new CloudError("Could not prepare the pushed cloud repository. No task started.");
      const head = await this.git("git", ["rev-parse", "HEAD"], { cwd: checkout, urgent: true });
      if (head.code !== 0 || head.stdout.trim() !== cloud.head) throw new CloudError("The remote branch moved. Prepare a new standalone subtask from its current state.");
      if (controller.signal.aborted) return;
      const run = this.host.db.createRun({ threadId: thread.id, role: "implementor", model: spec.model || "sonnet", account: `claude-cloud:${account.label}` });
      job = { threadId: thread.id, parentId: thread.parentId, accountId: cloud.accountId, repository: cloud.repository, runId: run.id,
        state: "starting", sessionId: null, url: null, result: null, error: null, createdAt: Date.now() };
      this.saveJob(job); // before the external mutation, including crashes before a session ID
      this.host.db.updateRun(run.id, { state: "running" });
      this.host.setState(thread.id, "implementing");
      this.host.message(thread.parentId, `Cloud credits: "${thread.title}" is running as a subtask on ${account.label}. Its result returns for review; it cannot access this machine.`);
      const prompt = `You are a cloud subtask. Your parent will review your result.\nTask: ${thread.title}\n\n${thread.brief}\n\n` +
        `Use only this repository and cloud environment. No local machine dependencies. ` +
        (spec.cloudWork === "review" ? "Read-only: do not edit, commit or push. Return findings with file references." : "Make changes on a new branch, test and push that branch, and return its name and a pull-request URL if available. Do not merge or deploy.") +
        " Never purchase credits or change billing. Finish with a concrete report of changes/findings, validation, blockers and the result to review.";
      const result = await this.runner({ token: account.token, organizationId: account.organizationId,
        repository: cloud.repository, revision: cloud.head, remainingCredits: account.remainingCredits,
        work: spec.cloudWork,
        prompt, model: spec.model || "sonnet", effort: spec.effort, signal: controller.signal,
        onSession: id => {
          if (!CLOUD_SESSION_ID.test(id) || !job) return;
          job.sessionId = id; job.url = `https://claude.ai/code/${id}`; job.state = "running";
          this.saveJob(job);
          this.host.db.updateRun(run.id, { sessionId: id });
          this.host.message(thread.id, `Claude cloud session: ${job.url}`, run.id);
        },
      });
      job.state = result.ok ? "review" : "uncertain";
      job.result = result.result; job.error = result.error;
      this.saveJob(job);
      this.host.db.updateRun(run.id, { state: result.ok ? "done" : "error", endedAt: Date.now(), error: job.error });
      this.host.message(thread.id, result.ok ? `Cloud result — parent review required\nSession: ${job.url}\n${result.result}` : `${result.error}\n${job.url ?? "Check Claude's session list."}`, run.id);
      if (!controller.signal.aborted) this.host.setState(thread.id, "review", job.error);
    } catch (error) {
      const message = error instanceof CloudError ? error.message : "Cloud observation failed. Check Claude before retrying.";
      if (job) { job.state = "uncertain"; job.error = message; this.saveJob(job); this.host.db.updateRun(job.runId, { state: "error", endedAt: Date.now(), error: message }); }
      if (!controller.signal.aborted) { this.host.message(thread.id, message, job?.runId); this.host.setState(thread.id, "review", message); }
    } finally {
      this.active.delete(thread.id); this.busyAccounts.delete(cloud.accountId);
      if (checkout) await rm(checkout, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
}
