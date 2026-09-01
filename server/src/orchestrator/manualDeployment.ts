import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isConfiguredCommitOnlyOrigin } from "../git/commitOnly.js";
import type {
  ManualDeployment,
  ManualDeploymentClaim,
  ManualDeploymentSummary,
  ManualDeploymentVerifier,
} from "../types.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^(?!-)(?!.*(?:\.\.|@\{|\\))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const ORIGIN_REF = /^(?:refs\/remotes\/)?origin\/[A-Za-z0-9][A-Za-z0-9._/-]{0,192}$/;
const MAX_FIELD = 2_000;
const MAX_CHECKS = 25;

export const MANUAL_DEPLOYMENT_HANDOFF_SUMMARY = "Complete in GGO — manual deployment pending";

export interface ManualDeploymentRepoInspection {
  ok: boolean;
  repoRoot?: string;
  originUrl?: string;
  headSha?: string;
  remoteSha?: string;
  ahead?: number;
  behind?: number;
  reasons: string[];
}

export interface ManualDeploymentQualification {
  ok: boolean;
  claim?: ManualDeploymentClaim;
  inspection?: ManualDeploymentRepoInspection;
  reasons: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== "string") return null;
  const valueTrimmed = value.trim();
  return valueTrimmed && valueTrimmed.length <= max ? valueTrimmed : null;
}

/** Strict parser shared by MCP/CLI/schema outputs and persisted-stage recovery. It accepts no legacy
 * aliases and defaults no safety assertion: incomplete evidence is deliberately ambiguous. */
export function parseManualDeploymentClaim(value: unknown): ManualDeploymentClaim | null {
  const input = record(value);
  if (!input || input.version !== 1) return null;
  const commitSha = boundedText(input.commitSha, 40)?.toLowerCase() ?? null;
  const remoteRef = boundedText(input.remoteRef, 200);
  const environment = boundedText(input.environment, 120);
  const instructions = boundedText(input.instructions);
  const assertions = record(input.assertions);
  if (
    !commitSha || !FULL_SHA.test(commitSha) ||
    !remoteRef || !SAFE_REF.test(remoteRef) || !ORIGIN_REF.test(remoteRef) ||
    !environment || !instructions || !assertions ||
    assertions.implementationCommitted !== true ||
    assertions.requiredVerificationPassed !== true ||
    assertions.noUncommittedChanges !== true ||
    assertions.noMergeOrDivergence !== true ||
    assertions.credentialsAndDataReady !== true ||
    assertions.noOwnerDecisionRequired !== true ||
    assertions.noAdditionalBlockers !== true ||
    assertions.postDeployVerificationRequired !== false
  ) return null;

  if (!Array.isArray(input.verification) || input.verification.length < 1 || input.verification.length > MAX_CHECKS) return null;
  const verification: ManualDeploymentClaim["verification"] = [];
  for (const raw of input.verification) {
    const check = record(raw);
    const command = boundedText(check?.command);
    if (!check || !command || check.outcome !== "passed") return null;
    verification.push({ command, outcome: "passed" });
  }

  return {
    version: 1,
    commitSha,
    remoteRef,
    environment,
    instructions,
    verification,
    assertions: {
      implementationCommitted: true,
      requiredVerificationPassed: true,
      noUncommittedChanges: true,
      noMergeOrDivergence: true,
      credentialsAndDataReady: true,
      noOwnerDecisionRequired: true,
      noAdditionalBlockers: true,
      postDeployVerificationRequired: false,
    },
  };
}

export function parseManualDeployment(value: unknown): ManualDeployment | null {
  const input = record(value);
  const claim = parseManualDeploymentClaim(input?.claim);
  if (
    !input || input.kind !== "manual_deployment" || input.version !== 1 || !claim ||
    !["declared", "verified", "invalidated"].includes(String(input.status)) ||
    !["implementor", "qa", "reviewer"].includes(String(input.declaredBy)) ||
    !boundedText(input.declaredRunId, 200) || typeof input.declaredAt !== "number" || !Number.isFinite(input.declaredAt)
  ) return null;
  const status = input.status as ManualDeployment["status"];
  const verifier = input.verifiedBy;
  if (status === "verified" && !["qa", "reviewer", "owner", "implementor_no_qa"].includes(String(verifier))) return null;
  return {
    kind: "manual_deployment",
    version: 1,
    status,
    claim,
    declaredBy: input.declaredBy as ManualDeployment["declaredBy"],
    declaredRunId: String(input.declaredRunId),
    declaredAt: input.declaredAt,
    ...(status === "verified" ? {
      verifiedBy: verifier as ManualDeploymentVerifier,
      verifiedRunId: typeof input.verifiedRunId === "string" ? input.verifiedRunId : null,
      verifiedAt: typeof input.verifiedAt === "number" && Number.isFinite(input.verifiedAt) ? input.verifiedAt : input.declaredAt,
    } : {}),
    ...(status === "invalidated" && boundedText(input.invalidReason) ? { invalidReason: boundedText(input.invalidReason)! } : {}),
  };
}

export function manualDeploymentSummary(value: unknown): ManualDeploymentSummary | null {
  const marker = parseManualDeployment(value);
  if (!marker) return null;
  return {
    status: marker.status,
    commitSha: marker.claim.commitSha,
    environment: marker.claim.environment,
    instructions: marker.claim.instructions,
    verifiedAt: marker.verifiedAt ?? null,
    invalidReason: marker.invalidReason ?? null,
  };
}

function git(workspace: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? result.error?.message ?? "").trim(),
  };
}

/** Independent repository proof. A configured commit-only repo may have local commits AHEAD of the declared remote
 * ref are valid; any BEHIND/diverged commit is not. */
export function inspectManualDeploymentRepository(
  workspace: string,
  claim: ManualDeploymentClaim,
  commitOnlyRemotePattern: string,
): ManualDeploymentRepoInspection {
  const reasons: string[] = [];
  if (!existsSync(workspace)) return { ok: false, reasons: ["The workspace no longer exists."] };

  const root = git(workspace, ["rev-parse", "--show-toplevel"]);
  if (!root.ok || !root.stdout) return { ok: false, reasons: ["The workspace is not a Git repository."] };
  const origin = git(workspace, ["remote", "get-url", "origin"]);
  if (!origin.ok || !origin.stdout) reasons.push("The repository has no readable origin remote.");
  else if (!isConfiguredCommitOnlyOrigin(origin.stdout, commitOnlyRemotePattern)) {
    reasons.push("The origin does not match the configured commit-only repository rule.");
  }

  const head = git(workspace, ["rev-parse", "HEAD"]);
  if (!head.ok || !FULL_SHA.test(head.stdout.toLowerCase())) reasons.push("HEAD does not resolve to a commit.");
  else if (head.stdout.toLowerCase() !== claim.commitSha) reasons.push(`HEAD moved after the deployment claim (${head.stdout.slice(0, 12)} != ${claim.commitSha.slice(0, 12)}).`);

  const remote = git(workspace, ["rev-parse", "--verify", `${claim.remoteRef}^{commit}`]);
  if (!remote.ok || !FULL_SHA.test(remote.stdout.toLowerCase())) reasons.push(`The declared integration ref ${claim.remoteRef} does not resolve.`);

  let ahead: number | undefined;
  let behind: number | undefined;
  if (head.ok && remote.ok) {
    const counts = git(workspace, ["rev-list", "--left-right", "--count", `${claim.remoteRef}...HEAD`]);
    const match = counts.stdout.match(/^(\d+)\s+(\d+)$/);
    if (!counts.ok || !match) reasons.push(`Could not compare HEAD with ${claim.remoteRef}.`);
    else {
      behind = Number(match[1]);
      ahead = Number(match[2]);
      if (behind > 0) reasons.push(`HEAD is behind/diverged from ${claim.remoteRef} by ${behind} commit${behind === 1 ? "" : "s"}.`);
    }
  }

  const status = git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) reasons.push("Git status could not be verified.");
  else if (status.stdout) reasons.push("The working tree has uncommitted or untracked changes.");

  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = git(workspace, ["rev-parse", "--path-format=absolute", "--git-path", name]);
    if (path.ok && path.stdout && existsSync(path.stdout)) reasons.push(`A Git ${name.toLowerCase().replaceAll("_", " ")} operation is still in progress.`);
  }

  return {
    ok: reasons.length === 0,
    repoRoot: root.stdout,
    originUrl: origin.stdout || undefined,
    headSha: head.stdout.toLowerCase() || undefined,
    remoteSha: remote.stdout.toLowerCase() || undefined,
    ahead,
    behind,
    reasons,
  };
}

/** Combine the structured assertion with live repository and orchestration blockers. */
export function qualifyManualDeployment(
  workspace: string,
  rawClaim: unknown,
  commitOnlyRemotePattern: string,
  blockers: readonly string[] = [],
): ManualDeploymentQualification {
  const claim = parseManualDeploymentClaim(rawClaim);
  if (!claim) return { ok: false, reasons: ["The manual deployment evidence is incomplete or malformed."] };
  const inspection = inspectManualDeploymentRepository(workspace, claim, commitOnlyRemotePattern);
  const reasons = [...blockers.filter((item) => item.trim()), ...inspection.reasons];
  return { ok: reasons.length === 0, claim, inspection, reasons };
}

export function declareManualDeployment(
  claim: ManualDeploymentClaim,
  role: ManualDeployment["declaredBy"],
  runId: string,
  at = Date.now(),
): ManualDeployment {
  return { kind: "manual_deployment", version: 1, status: "declared", claim, declaredBy: role, declaredRunId: runId, declaredAt: at };
}

export function verifyManualDeployment(
  marker: ManualDeployment,
  verifier: ManualDeploymentVerifier,
  runId?: string | null,
  at = Date.now(),
): ManualDeployment {
  return { ...marker, status: "verified", verifiedBy: verifier, verifiedRunId: runId ?? null, verifiedAt: at, invalidReason: undefined };
}

export function invalidateManualDeployment(marker: ManualDeployment, reason: string): ManualDeployment {
  return { ...marker, status: "invalidated", verifiedBy: undefined, verifiedRunId: undefined, verifiedAt: undefined, invalidReason: reason.slice(0, MAX_FIELD) };
}

export function manualDeploymentHandoffDetail(claim: ManualDeploymentClaim, ownerName: string): string {
  const checks = claim.verification.map((item) => `- ${item.command}`).join("\n");
  return [
    `GGO work is complete at commit ${claim.commitSha}. The implementation is committed, the working tree is clean, ${claim.remoteRef} has no unseen commits, and required verification passed.`,
    "",
    `Pending external action for ${ownerName}: deploy this already-verified change to ${claim.environment}.`,
    claim.instructions,
    "",
    "Verified checks:",
    checks,
    "",
    "No owner decision, missing credential/data, unresolved merge, additional implementation, or essential post-deploy verification remains. This task is done in GGO and will not be auto-reviewed or resumed.",
  ].join("\n");
}
