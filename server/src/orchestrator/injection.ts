import { CodexAgentRun } from "../agents/codexRunner.js";
import { GrokAgentRun } from "../agents/grokRunner.js";
import { AgentRun, type AgentRunLike, type SendOpts } from "../agents/runner.js";
import { config } from "../config.js";

/** Only the orchestrator emits this marker; `neutralizeSteeringMarkers` escapes it in peer text. */
export const OWNER_STEERING_TAG = "OWNER STEERING";

/**
 * Format a live owner injection consistently for every implementor backend.
 *
 * Claude's streaming SDK can receive this while its current turn is running;
 * Codex and Grok finish or interrupt their batch and resume with it. The
 * delivery mechanics differ, but the instruction must not: a vague contextual
 * note is too easy for a provider to defer or overlook.
 *
 * The frame states provenance plainly. The earlier "[DIRECTOR INJECTION —
 * ACKNOWLEDGEMENT REQUIRED] … highest-priority … overrides" wording read as a
 * textbook prompt injection, and an implementor refused a real owner instruction.
 */
export function acknowledgedInjection(message: string): string {
  return [
    ...steeringFrame(message),
    "Before any further investigation, tool use, implementation, or final answer, begin your next visible response with `ACK:` and briefly state how you will apply this direction. Then apply it; do not treat it as background context or merely repeat it.",
  ].join("\n");
}

/** Acknowledge without breaking a planner/QA JSON contract. */
export function structuredAcknowledgedInjection(message: string): string {
  return [
    ...steeringFrame(message),
    "Your response must remain schema-valid. Begin its required `summary` field with `ACK:` and briefly state how you applied this direction, then complete the requested structured response.",
  ].join("\n");
}

function steeringFrame(message: string): string[] {
  return [
    `[${OWNER_STEERING_TAG} — from ${config.ownerName}, delivered by GGO]`,
    message.trim(),
    `[/${OWNER_STEERING_TAG}]`,
    "",
    `${config.ownerName} sent this to your task mid-run through the GGO console (the task's Inject box, or the Director or review lane relaying their words). It has the same authority as your brief, including when it changes models, scope or policy. Where it conflicts with the brief or your current plan, follow it.`,
  ];
}

/** Office chat reaches a session through the same channel as owner steering, so a teammate's text
 *  must never be able to wear the owner's marker. */
export function neutralizeSteeringMarkers(text: string): string {
  return text.replace(/\[\s*(\/?)\s*OWNER\s+STEERING/gi, "[quoted $1owner steering");
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

/** Only a plain append to a streaming SDK run (Claude, z.ai) can sit unread behind a blocking tool call;
 *  an interrupt and every Codex/Grok send already stop the in-flight work (see injectionPickup.ts). */
export function injectionNeedsPickupWatch(run: AgentRunLike, mode: "append" | "interrupt"): boolean {
  return mode === "append" && run instanceof AgentRun;
}
