// Reads an explicit implementor-effort ask out of the owner's own words ("review this with high effort",
// "this is a Max effort task", "effort: low"). The director's dispatch tool has an `effort` argument for
// this, but the model can leave it empty; this is the deterministic backstop that keeps the owner's
// literal ask from silently falling to the route default.
//
// Precision over recall: a miss only leaves the pipeline's own effort pick in place, while a false
// positive pins the wrong effort on a whole task. So it fires only on request-shaped phrasings, never
// on quoted text, a negated clause, or a message naming two different levels ("I said high, it ran medium").

import type { Effort } from "../types.js";

const LEVEL = String.raw`(low|light|medium|high|x-?high|extra[- ]high|max|maximum)`;

const REQUEST_SHAPES: RegExp[] = [
  // Not "on": "set it to low tier models on low effort" describes a setting, not this task.
  new RegExp(String.raw`\b(?:with|at)\s+(?:a\s+)?${LEVEL}[- ]effort\b`, "gi"),
  new RegExp(String.raw`\b${LEVEL}[- ]effort\s+(?:task|run|pass|review|job|mode)\b`, "gi"),
  new RegExp(String.raw`\beffort\s*[:=]\s*${LEVEL}\b`, "gi"),
];

const NEGATION = /\b(?:not|never|no|without|don'?t|doesn'?t|shouldn'?t|won'?t|isn'?t)\b|n't\b/i;

/** Quoted spans are cited, not asked — a pasted log line or "you said 'with high effort'". */
const QUOTED = /"[^"]{0,800}"|“[^”]{0,800}”|‘[^’\n]*’|`[^`]{0,800}`|(^|[\s(])'[^'\n]*'(?=[\s.,;:!?)]|$)/g;

const ANY_MENTION = new RegExp(String.raw`\b${LEVEL}[- ]effort\b`, "gi");

export function detectEffortRequest(text: string): Effort | null {
  if (mentionedLevels(text).size > 1) return null;
  const plain = text.replace(QUOTED, "$1 ");
  const levels = new Set<Effort>();
  for (const shape of REQUEST_SHAPES) {
    for (const m of plain.matchAll(shape)) {
      if (!negated(plain, m.index ?? 0)) levels.add(normalizeLevel(m[1] ?? ""));
    }
  }
  return levels.size === 1 ? [...levels][0]! : null;
}

/** Every level named anywhere, quotes included — two different ones make the message ambiguous. */
function mentionedLevels(text: string): Set<Effort> {
  return new Set([...text.matchAll(ANY_MENTION)].map((m) => normalizeLevel(m[1] ?? "")));
}

/** A negation in the few words before the phrase, within the same clause ("should not run with high effort"). */
function negated(text: string, at: number): boolean {
  const clause = text.slice(Math.max(0, at - 40), at).split(/[.!?;\n]/).pop() ?? "";
  return NEGATION.test(clause.split(/\s+/).slice(-5).join(" "));
}

function normalizeLevel(word: string): Effort {
  const w = word.toLowerCase().replace(/[- ]/g, "");
  if (w === "light") return "low";
  if (w === "maximum") return "max";
  if (w === "xhigh" || w === "extrahigh") return "xhigh";
  return w as Effort;
}
