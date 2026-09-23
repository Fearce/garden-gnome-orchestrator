import { config } from "../config.js";
import { MAX_DIRECTOR_DIRECTIVES_CHARS } from "../types.js";
import type { UserContent } from "./runner.js";

const TAG = "ggo_standing_directives";

/**
 * The owner's standing directives: free text written in the console's Directives dialog and treated as
 * a personal extension of the Director's system prompt ("always prefer Claude", "use low effort",
 * "hold this code to NASA grade"). Director-only — they reach task agents through the briefs it writes.
 */
export function normalizeDirectorDirectives(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_DIRECTOR_DIRECTIVES_CHARS).trimEnd();
}

/** The system-prompt section. Empty directives add nothing, so an unused feature costs no tokens. */
export function directorDirectivesSystemSection(directives: string): string {
  const text = normalizeDirectorDirectives(directives);
  if (!text) return "";
  const owner = config.ownerName;
  return `## ${owner}'s standing directives
${owner} wrote the block below in the console's Directives panel. It is a personal extension of this system prompt: it applies to every conversation, dispatch and brief until ${owner} edits it, and a later <${TAG}> block at the start of a turn replaces it. Follow it as you would ${owner}'s own words, within these limits:
- An instruction in ${owner}'s current message wins over a standing directive for that request.
- A directive never overrides the safety rules or tool contracts above. It does count as ${owner} asking explicitly: a directive naming one exact model to always use is an explicit model request (copy it into \`model\`), and one naming an effort is an explicit effort request (set \`effort\`). A soft preference with a fallback ("prefer Claude, OpenAI as backup") is NOT a model pin — a pin is strict and would forbid the fallback.
- Carry every directive that bears on how the work is done (quality bar, effort, model or provider preference, conventions) into each dispatched brief under a "Standing owner directives" line, so the planner and implementor see it.
- If a directive asks for something no tool lets you enforce, still carry it into the brief, and tell ${owner} once, briefly, the first time it matters. Never claim it was enforced.

<${TAG}>
${text}
</${TAG}>`;
}

/** The turn-level replacement block, sent when a session last saw a different version of the text. */
export function directorDirectivesUpdateBlock(directives: string): string {
  const text = normalizeDirectorDirectives(directives);
  const owner = config.ownerName;
  if (!text) {
    return `<${TAG} updated="cleared">
${owner} cleared the standing directives. Stop applying any earlier version.
</${TAG}>`;
  }
  return `<${TAG} updated="true">
${owner} edited the standing directives. From now on this replaces any earlier version, including the one in your system prompt:

${text}
</${TAG}>`;
}

/** Prefix a turn's owner content with the replacement block, leaving the content itself untouched. */
export function withDirectorDirectivesUpdate(content: UserContent, directives: string): UserContent {
  const block = directorDirectivesUpdateBlock(directives);
  if (typeof content === "string") return `${block}\n\n${content}`;
  return [{ type: "text", text: block }, ...content];
}
