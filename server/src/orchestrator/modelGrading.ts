// Grading an auto-selected model's work. The point of the grade is the NEXT selection: without it,
// auto model selection is a coin flip repeated forever.
//
// It is deliberately DETERMINISTIC — computed from what the pipeline already knows about how the task
// went (did it get accepted, how many QA rounds it burned, what it cost, how long it took) rather than
// from a second model judging the first. A judge would cost a run per task, disagree with itself, and
// still be guessing at exactly the thing the pipeline measured directly.
//
// The scale, on purpose:
//   done   100 — accepted. QA passed, or the owner's delegate accepted it.
//   review  40 — the work landed on a human. Not worthless (it may be nearly right), but it failed the
//                one promise auto-selection makes: pick a model that can finish the job unattended.
//   failed   0
//   cancel   — never scored: the owner stopped it, which says nothing about the model.
// Each QA fix-round past the first costs 12, capped at 36 — so a `done` that needed four rounds (64)
// still ranks above a `review` that needed one (40). Reaching QA once is normal and free.

import type { AgentRun, ModelOutcome, ThreadState } from "../types.js";

export const QA_ROUND_PENALTY = 12;
export const MAX_QA_PENALTY = 36;

const OUTCOME_BASE: Record<ModelOutcome, number | null> = { done: 100, review: 40, failed: 0, cancelled: null };

/** The task states worth grading. Everything else is mid-flight. */
export function outcomeOfState(state: ThreadState): ModelOutcome | null {
  switch (state) {
    case "done":
      return "done";
    case "review":
      return "review";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** 0-100 quality score, or null when the ending carries no verdict about the model. */
export function scoreOutcome(outcome: ModelOutcome, qaRounds: number): number | null {
  const base = OUTCOME_BASE[outcome];
  if (base == null) return null;
  const penalty = Math.min(MAX_QA_PENALTY, Math.max(0, qaRounds - 1) * QA_ROUND_PENALTY);
  return Math.max(0, base - penalty);
}

/** What the task's runs say about the implementation: the totals, and whether ONE model did all of it. */
export function summarizeRuns(runs: AgentRun[]): {
  ranModels: string[];
  gradedModel: string | null;
  costUsd: number;
  numTurns: number;
} {
  const ranModels: string[] = [];
  for (const r of runs) if (r.role === "implementor" && !ranModels.includes(r.model)) ranModels.push(r.model);
  return {
    ranModels,
    // A task a cap-failover split across two backends is evidence about neither, so it scores but never
    // reaches the per-model scoreboard.
    gradedModel: ranModels.length === 1 ? ranModels[0]! : null,
    costUsd: runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    numTurns: runs.reduce((sum, r) => sum + (r.numTurns ?? 0), 0),
  };
}

export interface SettleFacts {
  state: ThreadState;
  runs: AgentRun[];
  qaRounds: number;
  dispatchedAt: number;
  settledAt: number;
  /** The task parked waiting for a usage window, not for a human — the cap supervisor will resume it. */
  capParked: boolean;
  /** A server restart killed the task mid-work; it is queued to auto-resume, so it hasn't ended. */
  restartInterrupted: boolean;
}

export interface GradePatch {
  outcome: ModelOutcome;
  score: number | null;
  qaRounds: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  ranModels: string;
  gradedModel: string | null;
}

/**
 * Grade a settled task, or return null when this ending isn't evidence about the model:
 * a state that isn't terminal, a quota park or a restart casualty (both resume later — grading them
 * would blame the model for the orchestrator's own interruptions), or a task that failed before an
 * implementor ever ran (a missing workspace, a blocked routing — nothing was implemented to judge).
 */
export function gradeSettledTask(f: SettleFacts): GradePatch | null {
  const outcome = outcomeOfState(f.state);
  if (!outcome) return null;
  if (f.capParked || f.restartInterrupted) return null;
  const summary = summarizeRuns(f.runs);
  if (!summary.ranModels.length) return null;
  return {
    outcome,
    score: scoreOutcome(outcome, f.qaRounds),
    qaRounds: f.qaRounds,
    costUsd: Number(summary.costUsd.toFixed(4)),
    numTurns: summary.numTurns,
    durationMs: Math.max(0, f.settledAt - f.dispatchedAt),
    ranModels: summary.ranModels.join(", "),
    gradedModel: summary.gradedModel,
  };
}
