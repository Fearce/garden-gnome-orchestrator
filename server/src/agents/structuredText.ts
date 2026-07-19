// Recover a role's structured output from a CLI backend's free-form final text.
//
// The Claude Agent SDK produces a role's structured result (the plan, the research, the QA verdict) via a
// forced json_schema tool call, so `res.structuredOutput` arrives validated. A CLI backend (Codex) only
// streams assistant text and can't be handed our in-process schema, so to run those roles on it we ask it
// to END its turn with a fenced ```json block matching the schema, then parse + shape-check it here. Grok's
// CLI takes `--json-schema` and parses natively, so this text path is Codex-only.

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
  if (!text) return undefined;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => !!s);
  for (const block of fenced.reverse()) {
    const parsed = tryParseObject(block);
    if (parsed) return parsed;
  }
  for (const candidate of balancedObjects(text).reverse()) {
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  return undefined;
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

/** Extract + validate a role's structured output from a CLI's final text in one call. On success returns
 *  `{ value }`; on failure `{ error }` with a message suitable to send back as a correction nudge. */
export function parseStructuredText(text: string, schema: JsonSchemaLike): ParseResult {
  const obj = extractJsonObject(text);
  if (!obj) return { error: "No JSON object found in your reply. End your turn with a single ```json fenced block that matches the required schema and nothing after it." };
  const err = validateAgainstSchema(obj, schema);
  if (err) return { error: `Your JSON didn't match the required schema: ${err}` };
  return { value: obj };
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
