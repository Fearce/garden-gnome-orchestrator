// Recover a role's structured output from a CLI backend's free-form final text.
//
// The Claude Agent SDK produces a role's structured result (the plan, the research, the QA verdict) via a
// forced json_schema tool call, so `res.structuredOutput` arrives validated. A CLI backend only streams
// assistant text and can't attach our in-process schema tool, so:
//   • Codex: we ask it to END with a fenced ```json block matching the schema, then parse + shape-check here.
//   • Grok: the CLI takes `--json-schema` and puts the validated object on its `end` event (preferred), but
//     multi-turn roles also stream one JSON object per model turn into the text buffer — this module's
//     multi-candidate parse is the fallback when `end.structuredOutput` is missing.

/** A JSON-Schema-ish object with the fields this validator understands (a strict subset of the role
 *  schemas in roles.ts — enough to accept a well-formed result and reject a malformed one). */
export interface JsonSchemaLike {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  enum?: unknown[];
}

/** Pull the JSON object out of a CLI's final message. Prefers the LAST fenced ```json block (the agent's
 *  deliberate final answer, after any earlier illustrative snippets), then falls back to the last balanced
 *  top-level `{…}` in the text. Returns undefined when nothing parses. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const all = extractJsonObjects(text);
  return all.length ? all[all.length - 1] : undefined;
}

/** Every parseable top-level JSON object in `text`, in order of appearance. Fenced ```json blocks first
 *  (in document order), then bare balanced `{…}` objects that weren't already captured as a fence body.
 *  Grok multi-turn structured roles stream one JSON object per model turn into a single text buffer —
 *  callers that need the *last schema-valid* verdict iterate this list in reverse. */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  if (!text) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (obj: Record<string, unknown> | undefined) => {
    if (!obj) return;
    const key = JSON.stringify(obj);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(obj);
  };
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => !!s);
  for (const block of fenced) push(tryParseObject(block));
  for (const candidate of balancedObjects(text)) push(tryParseObject(candidate));
  return out;
}

function tryParseObject(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Every balanced top-level `{…}` substring in `text`, in order of appearance. Brace-counting that ignores
 *  braces inside JSON string literals (and their escapes) so a `}` in a string value doesn't close early. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
      }
    }
  }
  return out;
}

/** Shape-check a parsed object against the schema subset. Returns the first violation as a human message
 *  (fed back to the CLI agent as a retry nudge), or null when it satisfies the schema. Deliberately lenient:
 *  it enforces `required` presence, top-level types, and enums, but tolerates extra keys — the goal is to
 *  reject genuinely unusable output (missing the plan summary, a non-boolean QA pass), not to be a full
 *  JSON-Schema validator. */
export function validateAgainstSchema(value: unknown, schema: JsonSchemaLike, path = "result"): string | null {
  if (schema.enum && !schema.enum.includes(value as never)) {
    return `${path} must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)}).`;
  }
  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) return `${path}.${key} is required but missing.`;
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (obj[key] === undefined) continue; // only required keys must be present; optional ones are checked if given
        const err = validateAgainstSchema(obj[key], sub, `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array.`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateAgainstSchema(value[i], schema.items, `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : `${path} must be a string.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean.`;
    case "number":
    case "integer":
      return typeof value === "number" ? null : `${path} must be a number.`;
    default:
      return null; // unconstrained node
  }
}

export interface ParseResult {
  value?: Record<string, unknown>;
  error?: string;
}

/** Extract + validate a role's structured output from a CLI's final text in one call. Tries candidates
 *  newest-first (last fenced/balanced object is the deliberate final answer; earlier ones are drafts or
 *  multi-turn intermediate emissions). On success returns `{ value }`; on failure `{ error }` with a
 *  message suitable to send back as a correction nudge. */
export function parseStructuredText(text: string, schema: JsonSchemaLike): ParseResult {
  const candidates = extractJsonObjects(text);
  if (!candidates.length) {
    return { error: "No JSON object found in your reply. End your turn with a single ```json fenced block that matches the required schema and nothing after it." };
  }
  let lastErr: string | null = null;
  for (const obj of candidates.reverse()) {
    const err = validateAgainstSchema(obj, schema);
    if (!err) return { value: obj };
    lastErr = err;
  }
  return { error: `Your JSON didn't match the required schema: ${lastErr}` };
}

/** The instruction appended to a CLI role's kickoff so it terminates with a parseable structured block.
 *  Renders the JSON Schema inline so the agent knows the exact shape expected. */
export function jsonContractInstruction(schema: JsonSchemaLike): string {
  return [
    "When you have finished this role's work, end your FINAL message with a single fenced ```json code block",
    "containing ONLY a JSON object that conforms to this JSON Schema — no prose after it:",
    "",
    "```json-schema",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    "Emit every required field. Omit a field entirely rather than sending null. This JSON is how your result is",
    "read back into the pipeline, so it must be valid JSON and it must be the last thing in your message.",
  ].join("\n");
}

// ── Feed humanization ─────────────────────────────────────────────────────────
// CLI structured roles (Grok `--json-schema`, Codex fenced JSON) stream machine JSON into the
// assistant transcript. Grok multi-turn QA is especially bad: one complete `{pass,summary}` object
// *per model turn*, concatenated into a single feed message that looks like a wall of raw JSON.
// These helpers rewrite that for the owner-facing feed while the pipeline still parses the raw text.

/** One human line (or short multi-line block) for a single structured object. Used for live progress
 *  deltas (`isLast: false` → bullet status) and for the final flush (`isLast: true` → Pass/Fail etc.). */
export function formatStructuredObject(
  obj: Record<string, unknown>,
  opts: { isLast?: boolean } = {},
): string | null {
  const isLast = opts.isLast ?? true;

  // QA verdict shape — boolean pass + summary (issues optional).
  if (typeof obj.pass === "boolean" && typeof obj.summary === "string") {
    const issues = Array.isArray(obj.issues)
      ? (obj.issues as unknown[]).filter(
          (i): i is Record<string, unknown> => !!i && typeof i === "object" && !Array.isArray(i) && typeof (i as { description?: unknown }).description === "string",
        )
      : [];
    // Intermediate Grok turns: pass:false (+ empty issues) are status ticks; pass:true are draft
    // finals the model re-emits many times before the real end event — never surface those mid-stream.
    if (!isLast) {
      if (obj.pass) return null;
      return `• ${obj.summary}`;
    }
    if (obj.pass) {
      const lines = [`**Pass** — ${obj.summary}`];
      if (issues.length) {
        lines.push("");
        for (const i of issues) lines.push(formatIssueLine(i));
      }
      return lines.join("\n");
    }
    if (issues.length === 0) return `**Status** — ${obj.summary}`;
    const lines = [`**Fail** — ${obj.summary}`, ""];
    for (const i of issues) lines.push(formatIssueLine(i));
    return lines.join("\n");
  }

  // Reader disposition.
  if (typeof obj.answered === "boolean" || typeof obj.escalated === "boolean") {
    if (obj.escalated) {
      const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "needs full pipeline";
      return isLast ? `**Escalated** — ${reason}` : `• Escalating: ${reason}`;
    }
    if (obj.answered) return isLast ? "**Answered** — lookup complete (see findings)." : "• Answering lookup…";
    return isLast ? "**Reader** — no answer posted." : null;
  }

  // Plan / research / generic summary-bearing objects.
  if (typeof obj.summary === "string") {
    const summary = obj.summary;
    if (!isLast) return `• ${summary}`;
    const hasSteps = Array.isArray(obj.steps) && (obj.steps as unknown[]).length > 0;
    const hasFacts = Array.isArray(obj.facts) && (obj.facts as unknown[]).length > 0;
    const hasMemories = Array.isArray(obj.memories) && (obj.memories as unknown[]).length > 0;
    const hasWarnings = Array.isArray(obj.warnings) && (obj.warnings as unknown[]).length > 0;
    if (!hasSteps && !hasFacts && !hasMemories && !hasWarnings && obj.nextAgent === undefined && obj.effort === undefined) {
      return summary;
    }
    const lines: string[] = [summary];
    if (hasSteps) {
      lines.push("", "Steps:");
      (obj.steps as unknown[]).forEach((raw, i) => {
        if (!raw || typeof raw !== "object") return;
        const s = raw as Record<string, unknown>;
        const title = typeof s.title === "string" ? s.title : `Step ${i + 1}`;
        const detail = typeof s.detail === "string" ? ` — ${s.detail}` : "";
        const files = Array.isArray(s.files) && s.files.length ? ` [${(s.files as unknown[]).map(String).join(", ")}]` : "";
        lines.push(`${i + 1}. ${title}${detail}${files}`);
      });
    }
    if (hasFacts) {
      lines.push("", "Key facts:");
      for (const raw of obj.facts as unknown[]) {
        if (!raw || typeof raw !== "object") continue;
        const f = raw as Record<string, unknown>;
        if (typeof f.claim !== "string") continue;
        lines.push(`- ${f.claim}${typeof f.source === "string" && f.source ? ` (${f.source})` : ""}`);
      }
    }
    if (hasMemories) {
      lines.push("", "Relevant memory:");
      for (const raw of obj.memories as unknown[]) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as Record<string, unknown>;
        if (typeof m.name !== "string") continue;
        lines.push(`- ${m.name}${typeof m.gist === "string" && m.gist ? ` — ${m.gist}` : ""}`);
      }
    }
    if (hasWarnings) {
      lines.push("", "Warnings: " + (obj.warnings as unknown[]).map(String).join("; "));
    }
    if (typeof obj.nextAgent === "string") lines.push("", `Next: ${obj.nextAgent}`);
    if (typeof obj.effort === "string") lines.push(`Effort: ${obj.effort}`);
    if (Array.isArray(obj.risks) && obj.risks.length) lines.push(`Risks: ${(obj.risks as unknown[]).map(String).join("; ")}`);
    if (Array.isArray(obj.openQuestions) && obj.openQuestions.length) {
      lines.push(`Open questions: ${(obj.openQuestions as unknown[]).map(String).join("; ")}`);
    }
    return lines.join("\n");
  }

  return null;
}

function formatIssueLine(i: Record<string, unknown>): string {
  const sev = typeof i.severity === "string" ? i.severity : "issue";
  const loc = typeof i.location === "string" && i.location ? ` (${i.location})` : "";
  return `- **${sev}**: ${String(i.description)}${loc}`;
}

/** Max intermediate status bullets kept in a feed rewrite. Grok multi-turn QA can emit dozens of
 *  near-duplicate ticks; the owner only needs a short checklist ahead of the final Pass/Fail. */
const MAX_FEED_PROGRESS = 8;

/**
 * Rewrite a CLI structured-role transcript for the owner-facing feed: keep any human prose, replace
 * raw JSON objects with short markdown (progress bullets + a final Pass/Fail or plan/research block).
 * Returns the original text unchanged when no JSON objects are present.
 *
 * Safe to call on already-humanized text (no JSON → identity) and on historical messages that were
 * persisted as raw multi-object walls before write-time humanization existed.
 */
export function formatStructuredRoleFeed(text: string): string {
  if (!text?.trim()) return text;
  const objects = extractJsonObjects(text);
  if (!objects.length) return text;

  const progress: string[] = [];
  let lastProgress: string | undefined;
  let finalBlock: string | undefined;
  for (let i = 0; i < objects.length; i++) {
    const isLast = i === objects.length - 1;
    const formatted = formatStructuredObject(objects[i]!, { isLast });
    if (!formatted) continue;
    if (!isLast) {
      // Collapse consecutive identical intermediate status lines (Grok sometimes re-emits the same tick).
      if (formatted === lastProgress) continue;
      lastProgress = formatted;
      progress.push(formatted);
      continue;
    }
    finalBlock = formatted;
  }

  // Keep the most recent progress ticks when Grok was chatty — older ones are usually "Starting QA".
  const capped =
    progress.length > MAX_FEED_PROGRESS
      ? [`• …${progress.length - MAX_FEED_PROGRESS} earlier checks`, ...progress.slice(-MAX_FEED_PROGRESS)]
      : progress;
  const blocks = finalBlock ? [...capped, finalBlock] : capped;

  const prose = stripJsonish(text);
  if (prose && !isJsonLeftover(prose)) {
    return prose + (blocks.length ? "\n\n" + blocks.join("\n") : "");
  }
  return blocks.length ? blocks.join("\n") : text;
}

/**
 * Live-stream helper: given the full accumulated text buffer and how many objects have already been
 * surfaced as progress deltas, return any newly completed objects as short bullet lines (never the
 * final Pass/Fail — that lands on flush via `formatStructuredRoleFeed`). Intermediate `pass:true`
 * drafts are skipped (same as the flush path).
 */
export function takeStructuredProgressLines(
  text: string,
  alreadyEmitted: number,
): { nextIndex: number; lines: string[] } {
  const objects = extractJsonObjects(text);
  if (objects.length <= alreadyEmitted) return { nextIndex: alreadyEmitted, lines: [] };
  const lines: string[] = [];
  let last = "";
  for (let i = alreadyEmitted; i < objects.length; i++) {
    // Never treat a still-streaming object as final — always progress bullets while the turn is open.
    const line = formatStructuredObject(objects[i]!, { isLast: false });
    if (!line || line === last) continue;
    last = line;
    lines.push(line);
  }
  return { nextIndex: objects.length, lines };
}

/** Remove fenced ```json blocks and bare balanced `{…}` objects, leaving surrounding prose. */
function stripJsonish(text: string): string {
  // Drop fenced blocks first so their braces don't also get counted as bare objects.
  let s = text.replace(/```(?:json)?\s*[\s\S]*?```/gi, "\n");
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) spans.push({ start, end: i + 1 });
      }
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i]!;
    s = s.slice(0, sp.start) + "\n" + s.slice(sp.end);
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** True when leftover text after stripping JSON is just punctuation/whitespace noise, not real prose. */
function isJsonLeftover(s: string): boolean {
  // Only commas, braces residue, quotes, backticks, ellipses-ish — nothing wordy.
  return !/[A-Za-z0-9]{3,}/.test(s);
}
