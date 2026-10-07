import { randomUUID } from "node:crypto";
import type { KvStore } from "../freeProviders/ledger.js";

export const CLOUD_ROUTINE_PROMPT = "Execute the repository task described in the routine-fire-payload block. Work only in the repositories attached to this routine. Follow their project instructions, run relevant tests, and commit changes on a new branch. Open a pull request for review; never merge, deploy, or force-push. If the task needs a local machine, local services, private files, or credentials that are not available in this cloud environment, stop and explain the dependency. Finish with the result, validation, and branch or pull-request URL.";
const CONNECTIONS = "cloud_session_connections_v1";
const JOBS = "cloud_session_jobs_v1";
const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;

interface Connection {
  id: string;
  label: string;
  repository: string;
  routineId: string;
  token: string;
}
export type CloudConnection = Omit<Connection, "token"> & { configured: boolean };
export interface CloudJob {
  id: string;
  connectionId: string;
  label: string;
  repository: string;
  title: string;
  sourceThreadId: string | null;
  createdAt: number;
  state: "submitting" | "submitted" | "failed" | "uncertain";
  sessionId: string | null;
  url: string | null;
  error: string | null;
}
export class CloudError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function required(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new CloudError(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}
export function routineId(value: unknown): string {
  const raw = required(value, "Routine ID or fire URL", 300);
  if (/^trig_[A-Za-z0-9_-]+$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const match = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9_-]+)\/fire$/.exec(url.pathname);
    if (url.origin === "https://api.anthropic.com" && !url.username && !url.password && !url.search && !url.hash && match) return match[1]!;
  } catch { /* rejected below */ }
  throw new CloudError("Use the routine's trig_ ID or its https://api.anthropic.com fire URL.");
}
export function githubRepository(value: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** Supported routine fire API only. Tokens have no balance, transcript or completion read scope. */
export class CloudSessionService {
  private readonly pending = new Set<string>();
  constructor(private readonly store: KvStore, private readonly request: typeof fetch = fetch) {
    // Never retry a submission after a restart: the provider may already have accepted it.
    const jobs = this.jobs();
    if (jobs.some(j => j.state === "submitting")) {
      this.saveJobs(jobs.map(j => j.state === "submitting" ? { ...j, state: "uncertain", error: "GGO restarted during submission. Check Claude's session list before starting another job." } : j));
    }
  }
  private read<T>(key: string): T[] {
    const value = this.store.kvGet(key);
    if (!value) return [];
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows)) throw new CloudError("Cloud session storage is invalid.", 500);
    return rows as T[];
  }
  private connections(): Connection[] { return this.read<Connection>(CONNECTIONS); }
  jobs(): CloudJob[] { return this.read<CloudJob>(JOBS); }
  private saveJobs(jobs: CloudJob[]): void { this.store.kvSet(JOBS, JSON.stringify(jobs.slice(0, 100))); }
  snapshot() {
    return { connections: this.connections().map(({ token, ...c }) => ({ ...c, configured: !!token })), jobs: this.jobs(), routinePrompt: CLOUD_ROUTINE_PROMPT };
  }
  save(input: Record<string, unknown>): CloudConnection {
    const rows = this.connections();
    const existing = typeof input.id === "string" ? rows.find(c => c.id === input.id) : undefined;
    if (input.id && !existing) throw new CloudError("Cloud connection not found.", 404);
    if (!existing && rows.length >= 20) throw new CloudError("Remove an unused connection before adding another.");
    const label = required(input.label, "Connection label", 100);
    const repository = required(input.repository, "GitHub repository (owner/repo)", 200).toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new CloudError("Use a GitHub repository in owner/repo form.");
    const nextRoutineId = routineId(input.routineId);
    const token = input.token === undefined || input.token === "" ? existing?.token : required(input.token, "Routine token", 1000);
    if (!token || !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token)) throw new CloudError("Enter the bearer token generated for this routine's API trigger.");
    if (existing && existing.routineId !== nextRoutineId && !input.token) throw new CloudError("A different routine needs its own token.");
    const connection: Connection = { id: existing?.id ?? randomUUID(), label, repository, routineId: nextRoutineId, token };
    this.store.kvSet(CONNECTIONS, JSON.stringify([connection, ...rows.filter(c => c.id !== connection.id)]));
    const { token: _secret, ...dto } = connection;
    return { ...dto, configured: true };
  }
  remove(id: string): void {
    if (this.pending.has(id)) throw new CloudError("Wait for the current submission before removing this connection.", 409);
    this.store.kvSet(CONNECTIONS, JSON.stringify(this.connections().filter(c => c.id !== id)));
  }
  connectionRepository(id: string): string | undefined { return this.connections().find(c => c.id === id)?.repository; }
  async submit(input: Record<string, unknown>): Promise<CloudJob> {
    if (input.cloudReady !== true) throw new CloudError("Confirm this task can run using only the cloud repository and environment.");
    const connection = this.connections().find(c => c.id === input.connectionId);
    if (!connection) throw new CloudError("Choose a configured cloud routine.");
    const title = required(input.title, "Task title", 200);
    const prompt = required(input.prompt, "Task brief", 60_000);
    const sourceThreadId = typeof input.sourceThreadId === "string" ? input.sourceThreadId : null;
    if (this.pending.has(connection.id) || (sourceThreadId && this.jobs().some(j => j.sourceThreadId === sourceThreadId && j.state !== "failed"))) {
      throw new CloudError("This task already has a cloud submission, or this routine is submitting. Open its session before starting another.", 409);
    }
    const job: CloudJob = { id: randomUUID(), connectionId: connection.id, label: connection.label, repository: connection.repository, title, sourceThreadId, createdAt: Date.now(), state: "submitting", sessionId: null, url: null, error: null };
    this.pending.add(connection.id);
    try {
      this.saveJobs([job, ...this.jobs()]);
      let response: Response;
      try {
        response = await this.request(`https://api.anthropic.com/v1/claude_code/routines/${connection.routineId}/fire`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${connection.token}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({ text: `Task: ${title}\nRepository: ${connection.repository}\n\n${prompt}` }),
        });
      } catch {
        throw new CloudError("Submission outcome is unknown (network failure or timeout). Check Claude's session list before retrying.", 502);
      }
      if (!response.ok) {
        // Never persist or echo upstream bodies: they can contain credentials and untrusted text.
        job.state = response.status >= 500 ? "uncertain" : "failed";
        const hint = response.status === 401 ? "Regenerate the routine token." : response.status === 403 ? "Check cloud access for this Claude account." : response.status === 404 ? "Check the routine ID." : response.status === 429 ? "Claude's routine or account limit was reached." : response.status === 400 ? "Check that the routine is enabled." : "Check Claude's session list before retrying.";
        throw new CloudError(`Claude returned HTTP ${response.status}. ${hint}`, 502);
      }
      let data: Record<string, unknown>;
      try { data = await response.json() as Record<string, unknown>; } catch { throw new CloudError("Claude accepted the request but returned unreadable session details. Check its session list.", 502); }
      const id = data?.claude_code_session_id;
      if (data?.type !== "routine_fire" || typeof id !== "string" || !SESSION_ID.test(id)) throw new CloudError("Claude accepted the request without valid session details. Check its session list.", 502);
      job.sessionId = id;
      // Derive the URL; do not trust a provider-supplied redirect destination.
      job.url = `https://claude.ai/code/${id}`;
      job.state = "submitted";
      return job;
    } catch (error) {
      if (job.state === "submitting") job.state = "uncertain";
      job.error = error instanceof CloudError ? error.message : "Cloud submission failed. Check Claude before retrying.";
      throw error instanceof CloudError ? error : new CloudError(job.error, 502);
    } finally {
      this.pending.delete(connection.id);
      this.saveJobs(this.jobs().map(j => j.id === job.id ? job : j));
    }
  }
}
