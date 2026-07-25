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
