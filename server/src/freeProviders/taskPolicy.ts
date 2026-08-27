import { config } from "../config.js";
import type { Effort, ThreadLane } from "../types.js";
import type { FreeProviderTaskRole } from "./types.js";

export type FreeTaskSize = "small" | "large" | "uncertain";

export type FreeTaskPolicyCode =
  | "small-read-lane"
  | "small-low-effort-plan"
  | "wrong-lane"
  | "continuation"
  | "attachments"
  | "missing-brief"
  | "non-low-effort"
  | "brief-too-large"
  | "broad-scope"
  | "production-sensitive"
  | "external-or-live"
  | "uncertain-scope"
  | "multi-file"
  | "no-small-signal";

export interface FreeTaskPolicyLimits {
  maxBriefChars: number;
  maxBriefWords: number;
}

export interface FreeTaskPolicyInput {
  role: FreeProviderTaskRole;
  lane?: ThreadLane | null;
  title?: string;
  brief?: string;
  rawPrompt?: string;
  effortOverride?: Effort | null;
  /** Persisted runs for this exact role. Any prior launch makes this a retry/continuation. */
  priorRoleRuns?: number;
  /** Covers a provider-pinned or session-resuming caller even if a legacy DB has no prior run row. */
  isContinuation?: boolean;
  /** The bounded free harness intentionally accepts text only. */
  hasAttachments?: boolean;
}

export interface FreeTaskPolicyDecision {
  eligible: boolean;
  size: FreeTaskSize;
  code: FreeTaskPolicyCode;
  reason: string;
}

type Disqualifier = {
  code: Extract<FreeTaskPolicyCode, "broad-scope" | "production-sensitive" | "external-or-live" | "uncertain-scope">;
  size: Exclude<FreeTaskSize, "small">;
  reason: string;
  pattern: RegExp;
};

// These are deliberately negative-only signals. We never infer that an ordinary implementation is
// small from a short sentence alone: a terse "fix prod" can be harder than a page-long typo report.
// The positive signals are explicit and durable — dispatch_read's lane, or an operator-pinned `low`
// effort — and every ambiguous/broad/risky phrase below can only move a task back to a reliable backend.
const DISQUALIFIERS: readonly Disqualifier[] = [
  {
    code: "production-sensitive",
    size: "large",
    reason: "production-sensitive or high-risk work",
    pattern: /\b(?:production|prod\b|deploy(?:ment|ing)?|release|incident|outage|security|authentication|authorization|billing|payments?|database\s+migration|schema\s+migration|data\s+loss|destructive|purge|delete\s+all)\b/i,
  },
  {
    code: "external-or-live",
    size: "uncertain",
    reason: "external research or live-state verification",
    pattern: /https?:\/\/|\b(?:browse\s+the\s+web|web\s+search|external\s+research|latest\s+(?:version|release|news|status)|live\s+(?:site|service|system|environment|data)|current\s+(?:price|law|schedule|status))\b/i,
  },
  {
    code: "broad-scope",
    size: "large",
    reason: "broad, system-wide, or multi-stage scope",
    pattern: /\b(?:audit|quality\s+sweep|full\s+(?:quality|pipeline|fleet|system|repo|repository|codebase)|overhaul|redesign|rewrite|refactor|architecture|end[- ]to[- ]end|repo[- ]wide|repository[- ]wide|codebase[- ]wide|system[- ]wide|multi[- ]file|multiple\s+files?|across\s+(?:the\s+)?(?:repo|repository|codebase|system|pipeline|fleet)|all\s+(?:files?|routes?|providers?|tasks?|stages?|workspaces?|repos?|repositories)|every\s+(?:file|route|provider|task|stage|workspace|repo|repository))\b/i,
  },
  {
    code: "uncertain-scope",
    size: "uncertain",
    reason: "investigative or otherwise uncertain scope",
    pattern: /\b(?:investigate|diagnose|root\s+cause|research|evaluate|compare|figure\s+out|unknown|uncertain|comprehensive|thorough(?:ly)?|as\s+far\s+as\s+practical)\b/i,
  },
];

// Count only path-like tokens, not every dotted product/model name. More than two named files is a
// useful conservative signal that a supposedly low-effort change has already expanded beyond a tiny
// source+test pair.
const PATH_HINT_RE = /(?:[A-Za-z]:[\\/][^\s`"'|]+|(?:^|[\s`"'(])(?:\.\.?[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)+|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|cs|php|swift|kt|md|json|ya?ml|toml|css|scss|html|sql)\b)/gim;

function boundedText(input: FreeTaskPolicyInput): string {
  return (input.brief?.trim() || input.rawPrompt?.trim() || input.title?.trim() || "").trim();
}

function words(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

function pathHintCount(text: string): number {
  return new Set((text.match(PATH_HINT_RE) ?? []).map((value) => value.trim().toLowerCase())).size;
}

/**
 * Conservative, deterministic admission policy for scarce recurring-free inference. It intentionally
 * has no LLM fallback: spending a provider call to decide whether a task deserves a provider call would
 * consume the budget we are trying to protect, and an uncertain judgement must resolve to "reliable".
 */
export function classifyFreeTask(
  input: FreeTaskPolicyInput,
  limits: FreeTaskPolicyLimits = config.freeTaskPolicy,
): FreeTaskPolicyDecision {
  const reject = (size: Exclude<FreeTaskSize, "small">, code: FreeTaskPolicyCode, reason: string): FreeTaskPolicyDecision => ({
    eligible: false,
    size,
    code,
    reason,
  });

  if ((input.priorRoleRuns ?? 0) > 0 || input.isContinuation) {
    return reject("uncertain", "continuation", "Free allowance is first-attempt only; this role already ran or is continuing prior work.");
  }
  if (input.hasAttachments) {
    return reject("uncertain", "attachments", "Tasks with images or block attachments are not confidently small and stay on a reliable backend.");
  }
  if (input.role === "reader" && input.lane !== "read") {
    return reject("uncertain", "wrong-lane", "A free reader requires the explicitly bounded read-only dispatch lane.");
  }
  if (input.role === "planner" && input.lane === "read") {
    return reject("uncertain", "wrong-lane", "Read-lane work belongs to the bounded reader, not a planner run.");
  }

  const brief = boundedText(input);
  if (!brief) return reject("uncertain", "missing-brief", "The task has no bounded brief, so its size cannot be classified safely.");

  const signalText = `${input.title ?? ""}\n${brief}`;
  const wordCount = words(brief);
  if (brief.length > limits.maxBriefChars || wordCount > limits.maxBriefWords) {
    return reject(
      "large",
      "brief-too-large",
      `The brief exceeds the small-task limit (${brief.length}/${limits.maxBriefChars} characters, ${wordCount}/${limits.maxBriefWords} words).`,
    );
  }

  for (const disqualifier of DISQUALIFIERS) {
    if (disqualifier.pattern.test(signalText)) {
      return reject(disqualifier.size, disqualifier.code, `The task signals ${disqualifier.reason}; use a reliable provider.`);
    }
  }

  if (pathHintCount(signalText) > 2) {
    return reject("large", "multi-file", "The brief names more than two files or paths, so the scope is not a tiny bounded change.");
  }

  if (input.effortOverride && input.effortOverride !== "low") {
    return reject("large", "non-low-effort", `The task explicitly requests ${input.effortOverride} effort, which is outside the free small-task policy.`);
  }

  if (input.role === "reader") {
    return {
      eligible: true,
      size: "small",
      code: "small-read-lane",
      reason: `Explicit read-only lane, first attempt, and bounded ${wordCount}-word brief with no broad or high-risk signals.`,
    };
  }

  if (input.effortOverride !== "low") {
    return reject("uncertain", "no-small-signal", "Planner work has no explicit low-effort signal; uncertain size stays on a reliable provider.");
  }

  return {
    eligible: true,
    size: "small",
    code: "small-low-effort-plan",
    reason: `Explicit low effort, first attempt, and bounded ${wordCount}-word brief with no broad or high-risk signals.`,
  };
}
