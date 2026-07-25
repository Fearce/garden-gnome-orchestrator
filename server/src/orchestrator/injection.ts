import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import type { AgentRunLike, SendOpts } from "../agents/runner.js";

/**
 * Format a live owner injection consistently for every implementor backend.
 *
 * Claude's streaming SDK can receive this while its current turn is running;
 * Codex and Grok finish or interrupt their batch and resume with it. The
 * delivery mechanics differ, but the instruction must not: a vague contextual
 * note is too easy for a provider to defer or overlook.
 */
export function acknowledgedInjection(message: string): string {
  return [
    "[DIRECTOR INJECTION — ACKNOWLEDGEMENT REQUIRED]",
    message.trim(),
    "[/DIRECTOR INJECTION]",
    "",
    "This is new, highest-priority direction from the task owner. It overrides conflicting earlier assumptions.",
    "Before any further investigation, tool use, implementation, or final answer, begin your next visible response with `ACK:` and briefly state how you will apply this direction. Then apply it; do not treat it as background context or merely repeat it.",
  ].join("\n");
}

/** Acknowledge without breaking a planner/QA JSON contract. */
export function structuredAcknowledgedInjection(message: string): string {
  return [
    "[DIRECTOR INJECTION — ACKNOWLEDGEMENT REQUIRED]",
    message.trim(),
    "[/DIRECTOR INJECTION]",
    "",
    "This is new, highest-priority direction from the task owner. It overrides conflicting earlier assumptions.",
    "Your response must remain schema-valid. Begin its required `summary` field with `ACK:` and briefly state how you applied this direction, then complete the requested structured response.",
  ].join("\n");
}

/**
 * A Codex/Grok CLI invocation is one whole agentic batch, not one assistant
 * turn. An ordinary append would otherwise remain invisible until the task
 * finishes. Human steering must interrupt that batch and resume immediately.
 */
export function injectionSendOptions(
  run: AgentRunLike,
  mode: "append" | "interrupt",
): SendOpts | undefined {
  return mode === "interrupt" || run instanceof CodexAgentRun || run instanceof GrokAgentRun
    ? { priority: "now" }
    : undefined;
}
