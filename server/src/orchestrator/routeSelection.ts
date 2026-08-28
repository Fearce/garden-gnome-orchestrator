// Deterministic, explainable pre-planner routing: whether THIS task benefits from the planner and/or QA,
// independent of whether those roles are ENABLED (enabled = available, not mandatory — see CLAUDE.md
// "Task-aware route selection"). A pure function of the task's own title/brief text plus a few structural
// dispatch signals (shotgun/timed/effort) — no model call, so the pick is reproducible, free, and instant.
//
// Bias mirrors the read lane's own philosophy (docs/ARCHITECTURE.md §5): when signals are mixed or absent,
// keep the full route. A wrongly-kept planner/QA costs a bit of time; a wrongly-skipped one on a risky or
// ambiguous task costs quality with nobody watching. So the "narrow" (implementor-only) tier is reached
// only when the task is confidently small — everything else, including genuine ambiguity, keeps both.

import type { Effort, RouteDecision, RouteScope } from "../types.js";

export interface RouteInput {
  title: string;
  brief: string;
  /** The owner asked for multiple parallel agents (shotgun) — decomposition is definitionally not narrow. */
  shotgun?: boolean;
  /** Requested wall-clock work window, in hours, for a timed task. */
  timedHours?: number;
  /** Operator-pinned implementor effort at dispatch, if any (a skip-director composer pick). */
  effortOverride?: Effort | null;
  /**
   * Evidence from a reader-lane escalation. It informs the normal route, but is not an override:
   * an obvious one-file edit may still go directly to the implementor, while evidence of a broad
   * investigation or independent verification selects the stages that actually help.
   */
  readerEscalation?: { reason?: string; answer?: string } | null;
}

interface Signal {
  name: string;
  re: RegExp;
}

// Each hit alone is enough to keep (or restore) the full pipeline, however short or confident the brief
// reads. Grouped by the "breadth/risk" and "ambiguity" dimensions the routing policy is built on.
const RISK_SIGNALS: Signal[] = [
  {
    name: "security/auth",
    re: /\b(security|vulnerab(?:le|ility)|exploit|xss|csrf|sql injection|auth(?:entication|orization)?|login|logout|session|oauth|jwt|2fa|mfa|credential|secret|password|encrypt|decrypt|permission|access[- ]control|privileg)/i,
  },
  { name: "money/finance", re: /\b(payment|billing|invoice|financial|real[- ]money|trading|wallet|refund|checkout|pricing)\b/i },
  {
    name: "data/destructive",
    re: /\b(migrat(?:e|ion)|schema change|database|backfill|drop table|delete (?:all|every)|truncate|destructive|irreversib|force[- ]push|reset --hard|rm -rf)\b/i,
  },
  { name: "production/infra", re: /\b(production\b|\bprod\b|deploy(?:ment)?|infra(?:structure)?|ci\/cd|pipeline config|release process)\b/i },
  {
    name: "broad scope",
    re: /\b(across the (?:codebase|repo|project)|entire (?:codebase|repo|project|system)|every file|all files|system[- ]wide|whole (?:codebase|repo|application)|rewrite|redesign|re-?architect|major refactor)\b/i,
  },
  { name: "new design surface", re: /\b(new (?:feature|integration|service|endpoint|api|system)|design decision|architecture|introduce (?:a|an) new)\b/i },
  {
    name: "open-ended/ambiguous",
    re: /\b(investigate|figure out|diagnose|not sure|unclear|unsure|look into|why (?:is|does|are)|root cause|determine (?:the|why|what|how)|explore (?:options|approaches)|design (?:a|an|the)|decide (?:how|whether)|how should|best way to)\b/i,
  },
];

// Supplementary evidence only — narrow eligibility is decided by the STRUCTURAL gate below (length, file
// count, single-part request); a keyword hit here just gets named in the reason when it also matches.
const NARROW_SIGNALS: Signal[] = [
  { name: "typo/wording", re: /\b(typo|spelling|wording|copy edit|rename|renaming)\b/i },
  { name: "small, contained fix", re: /\b(one[- ]line|single file|small fix|quick fix|minor (?:fix|change|tweak)|tiny|trivial|simple fix)\b/i },
  { name: "version bump", re: /\b(bump (?:the )?version|version bump|update (?:a |the )?dependency version)\b/i },
  { name: "comment/doc edit", re: /\b(update (?:a |the )?comment|fix (?:a |the )?comment|add (?:a )?comment|fix (?:a |the )?docstring)\b/i },
];

// A contained task can need an independent check without needing a separate planning pass. Keep this
// deliberately specific: a normal request to merely "test" an idea is still classified by the broader
// structural/ambiguity policy below, while an explicit build/test/verification requirement earns QA.
const VERIFICATION_SIGNALS: Signal[] = [
  { name: "explicit verification", re: /\b(?:verify|verification|independent check|regression check|test suite|run (?:the )?(?:tests|test suite|build|typecheck|lint)|build (?:and|\/|\+)|typecheck|lint)\b/i },
];

const HEAVY_EFFORTS = new Set<Effort>(["xhigh", "max", "ultra"]);

function matches(text: string, signals: Signal[]): string[] {
  return signals.filter((s) => s.re.test(text)).map((s) => s.name);
}

/** Coarse, over-counting-safe file/path mention count — not a real path parser. Over-counting only pushes
 *  toward the fuller route, which is the safe direction for a false positive here. */
function countFileMentions(text: string): number {
  const hits = text.match(/\b[\w.-]+\/[\w./-]*\.[a-z]{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|py|cs|go|rs|java|rb|php|md|json|ya?ml|sql|cjs|mjs)\b/gi) ?? [];
  return new Set(hits.map((h) => h.toLowerCase())).size;
}

/** Bulleted/numbered list items or explicit multi-part connectors — a compound (multi-deliverable)
 *  request benefits from planning even when each individual part reads simply on its own. */
function countCompoundMarkers(text: string): number {
  const bullets = text.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? [];
  const connectors = text.match(/\b(?:also|additionally|as well as|and then|furthermore)\b/gi) ?? [];
  return bullets.length + connectors.length;
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// Too little text to be confident either way (an empty/near-empty brief) must never read as confidently
// narrow — there's nothing to base that confidence on. A hit against a NARROW_SIGNALS phrase widens the
// upper bound (the brief itself says what kind of small change this is); with no such phrase, the bound
// is tighter — a longer, keyword-free brief is exactly the "not obviously contained" case that should
// fall through to the conservative default instead.
const NARROW_WORD_MIN = 4;
const NARROW_WORD_LIMIT_HINTED = 60;
const NARROW_WORD_LIMIT_UNHINTED = 20;
const NARROW_FILE_LIMIT = 2;

/**
 * Choose the smallest capable pipeline route for a task, purely from its own text plus a few structural
 * dispatch signals. Three tiers — a deliberately coarse policy, matching the read lane's own precedent of
 * explainable tiers over a continuum:
 *
 *   - "broad"    → keep the planner AND QA. Any risk, breadth, or ambiguity signal forces this — a task
 *                  that touches security/money/data/production, is phrased as multi-file or system-wide,
 *                  or is itself open-ended ("investigate", "figure out why") always keeps both roles.
 *   - "narrow"   → implementor only. Reached ONLY when no risk/ambiguity signal fired AND the brief is
 *                  short, references at most a couple of files, and is not a compound (multi-part) ask.
 *   - "standard" → add only the missing support for a contained task (currently QA alone for an
 *                  explicit verification need); otherwise the conservative default keeps both roles when
 *                  the task is not confidently narrow, exactly like the reader lane's "misrouting to the cheap path
 *                  is the unsafe direction" rule.
 *
 * Deterministic and explainable: identical input always yields the identical decision, and every decision
 * carries the matched signal names (`signals`) behind its one-line `reason`.
 */
export function selectRoute(input: RouteInput): RouteDecision {
  const text = `${input.title}\n${input.brief}`;
  const escalationText = input.readerEscalation ? `${input.readerEscalation.reason ?? ""}\n${input.readerEscalation.answer ?? ""}` : "";
  // Reader evidence is task evidence, not a blanket "full pipeline" flag. Including it means an
  // escalation that discovered auth/data/production risk retains the safeguards those terms warrant.
  const evidenceText = escalationText ? `${text}\n${escalationText}` : text;

  if (input.shotgun) {
    return {
      usePlanner: true,
      useQa: true,
      scope: "broad",
      reason: "multiple agents requested — decomposing the work and reviewing the combined result both matter",
      signals: ["multi-agent split"],
    };
  }

  const riskHits = matches(evidenceText, RISK_SIGNALS);
  const fileCount = countFileMentions(text);
  const compoundCount = countCompoundMarkers(text);
  const wordCount = countWords(text);

  const structural: string[] = [];
  if (fileCount >= 4) structural.push(`touches ${fileCount}+ files`);
  if (compoundCount >= 2) structural.push("multiple distinct requirements");
  if ((input.timedHours ?? 0) >= 2) structural.push("multi-hour work window");
  if (input.effortOverride && HEAVY_EFFORTS.has(input.effortOverride)) structural.push(`operator pinned ${input.effortOverride} effort`);

  if (riskHits.length > 0 || structural.length > 0) {
    const signals = [...riskHits, ...structural];
    return {
      usePlanner: true,
      useQa: true,
      scope: "broad" as RouteScope,
      reason: `broad or risk-bearing work (${signals.join("; ")}) — keeping planning and QA`,
      signals,
    };
  }

  const narrowHits = matches(text, NARROW_SIGNALS);
  const narrowWordLimit = narrowHits.length > 0 ? NARROW_WORD_LIMIT_HINTED : NARROW_WORD_LIMIT_UNHINTED;
  if (wordCount >= NARROW_WORD_MIN && wordCount <= narrowWordLimit && fileCount <= NARROW_FILE_LIMIT && compoundCount === 0) {
    const verificationHits = matches(evidenceText, VERIFICATION_SIGNALS);
    if (verificationHits.length > 0) {
      const signals = [
        `short, single-scope brief (${wordCount} words${fileCount ? `, ${fileCount} file ref(s)` : ""})`,
        ...narrowHits,
        ...verificationHits,
      ];
      return {
        usePlanner: false,
        useQa: true,
        scope: "standard" as RouteScope,
        reason: `contained change with an explicit verification need (${signals.join("; ")}) — implementor + QA, no planning needed`,
        signals,
      };
    }
    const signals = [`short, single-scope brief (${wordCount} words${fileCount ? `, ${fileCount} file ref(s)` : ""})`, ...narrowHits];
    return {
      usePlanner: false,
      useQa: false,
      scope: "narrow" as RouteScope,
      reason: `narrow, contained change (${signals.join("; ")}) — implementor runs alone, no planning or QA needed`,
      signals,
    };
  }

  return {
    usePlanner: true,
    useQa: true,
    scope: "standard" as RouteScope,
    reason: "no clear narrow-scope signal — keeping planning and QA (the safe default when it's not obviously contained)",
    signals: [],
  };
}
