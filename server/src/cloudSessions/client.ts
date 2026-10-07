import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface CloudRunResult {
  sessionId: string | null;
  result: string | null;
  ok: boolean;
  error: string | null;
  /** False only when GGO provably never sent the create request, so no billable session can exist. */
  started?: boolean;
}
export interface CloudRunInput {
  token: string;
  organizationId: string;
  repository: string;
  revision: string;
  remainingCredits: number;
  work: "review" | "change";
  prompt: string;
  model: string;
  effort?: string | null;
  signal: AbortSignal;
  onSession(id: string): void;
  canCreate?(): boolean;
}
export const CLOUD_SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;
const API = "https://api.anthropic.com/v1";
type ObjectValue = Record<string, any>;

/** Normal hosted sessions, using the OAuth protocol observed in Claude Code 2.1.292.
 * This is not the routine API. The CLI's new-session print mode is disabled in that build.
 * Create is never retried: a dropped response can still have started a billed VM. */
export async function runCloudSession(input: CloudRunInput, request: typeof fetch = fetch,
  pause: (signal: AbortSignal) => Promise<unknown> = signal => delay(10_000, undefined, { signal })): Promise<CloudRunResult> {
  let sessionId: string | null = null;
  let createSent = false;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30 * 60_000)]);
  const headers = { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json",
    "anthropic-version": "2023-06-01", "anthropic-client-platform": process.platform,
    "User-Agent": "ggo-cloud/1.0", "x-organization-uuid": input.organizationId };
  const read = async (path: string, body?: ObjectValue): Promise<ObjectValue> => {
    const response = await request(`${API}${path}`, { method: body ? "POST" : "GET", headers,
      ...(body && { body: JSON.stringify(body) }), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("Response too large");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unreadable response");
    return value as ObjectValue;
  };
  try {
    if (signal.aborted || !input.organizationId || !/^[\w.-]+\/[\w.-]+$/.test(input.repository)
      || !/^[a-f0-9]{40,64}$/.test(input.revision) || !Number.isFinite(input.remainingCredits) || input.remainingCredits <= 0) throw new Error("Invalid admission");
    const environments = await read("/environment_providers?limit=100");
    const hosted = Array.isArray(environments.environments) ? environments.environments.filter((e: ObjectValue) =>
      e?.kind === "anthropic_cloud" && e.state === "active" && /^env_[A-Za-z0-9_-]+$/.test(e.environment_id)) : [];
    const environment = hosted.find((e: ObjectValue) => e.name === "Default") ?? hosted[0];
    if (!environment) return { sessionId, result: null, ok: false, started: false,
      error: "No active Anthropic cloud environment. Complete Claude Code cloud onboarding for this subscription." };
    const outputBranch = input.work === "change" ? `claude/ggo-${randomUUID().slice(0, 8)}` : null;
    const prompt = input.prompt + (outputBranch
      ? `\nUse the cloud checkout's generated branch ${outputBranch} for all commits and pushes. Do not create or push another branch. Your parent will review this branch before integration.` : "");
    // Environment discovery awaits the provider. Recheck local opt-in immediately before POST.
    if (signal.aborted || input.canCreate?.() === false) throw new Error("Cloud opt-in was removed");
    createSent = true;
    const created = await read("/code/sessions", {
      title: "GGO repository subtask", environment_id: environment.environment_id,
      events: [
        { payload: { type: "control_request", request_id: randomUUID(), request: { subtype: "set_permission_mode", mode: "auto" } } },
        { payload: { uuid: randomUUID(), session_id: "", type: "user", parent_tool_use_id: null,
          message: { role: "user", content: prompt } } },
      ],
      config: { sources: [{ type: "git_repository", url: `https://github.com/${input.repository}`, revision: input.revision }],
        outcomes: outputBranch ? [{ type: "git_repository", git_info: { type: "github",
          repo: input.repository, branches: [outputBranch] } }] : [],
        ...(input.work === "review" && { disallowed_tools: ["Edit", "Write", "NotebookEdit", "Bash"] }),
        model: input.model, ...(input.effort && { effort_level: input.effort }),
        max_turns: 40, max_budget_usd: Math.min(5, input.remainingCredits) },
    });
    const session = created.session;
    if (!session || typeof session.id !== "string" || !CLOUD_SESSION_ID.test(session.id)
      || session.environment_kind !== "anthropic_cloud" || session.environment_id !== environment.environment_id) throw new Error("Unverified session");
    sessionId = session.id;
    input.onSession(sessionId!);
    let failures = 0;
    while (!signal.aborted) {
      let metadata: ObjectValue, events: ObjectValue;
      try {
        metadata = await read(`/code/sessions/${sessionId}`);
        events = await read(`/code/sessions/${sessionId}/events?limit=100&sort_order=desc`);
        failures = 0;
      } catch {
        // Only reads may retry, never creation. Stop rather than hammering failed account reads.
        if (++failures >= 3 || signal.aborted) throw new Error("Observation failed");
        await pause(signal); continue;
      }
      const current = metadata.response_shape ?? metadata.session;
      if (current?.id !== sessionId || !Array.isArray(events.data)) throw new Error("Unverified observation");
      // The event endpoint is newest-first. Worker result is authoritative; an assistant text or
      // idle container alone is never proof that the task completed successfully.
      const completed = events.data.find((e: ObjectValue) => e?.source === "worker" && e.payload?.type === "result")?.payload;
      if (completed) {
        const result = typeof completed.result === "string" ? completed.result.slice(0, 60_000) : null;
        const ok = completed.subtype === "success" && completed.is_error === false && !!result?.trim();
        return { sessionId, result: ok ? result : null, ok,
          error: ok ? null : "Claude cloud did not complete successfully. Open the session to review its result." };
      }
      if (["requires_action", "cancelled", "rejected", "failed", "error"].includes(current.worker_status)
        || current.status === "archived") throw new Error("Cloud needs attention");
      await pause(signal);
    }
    throw new Error("Observer stopped");
  } catch (error) {
    // Before the create request nothing can be billed or running, so do not demand a remote check.
    if (!createSent) return { sessionId: null, result: null, ok: false, started: false,
      error: error instanceof Error && error.message === "Cloud opt-in was removed"
        ? "Cloud opt-in was removed. No cloud session was started."
        : "No cloud session was started. Check this subscription's Claude cloud access before retrying." };
    // Do not expose provider bodies or secrets; preserve uncertainty even if create returned no ID.
    return { sessionId, result: null, ok: false,
      error: "No verified cloud result. Check Claude's session list before starting more cloud work; a session may still be running." };
  }
}
