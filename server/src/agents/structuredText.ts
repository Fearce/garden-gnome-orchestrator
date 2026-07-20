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

/**
 * Max length for an intermediate QA status bullet. Grok multi-turn QA often re-emits near-final
 * Fail/Pass narratives as pass:false objects before the real end event — those read as a wall of
 * long bullets. Real status ticks are short ("Starting QA", "Reading X").
 */
const QA_STATUS_TICK_MAX_CHARS = 120;

/** True when a QA object is a short mid-stream status tick (not a draft Pass/Fail verdict). */
export function isQaStatusTick(obj: Record<string, unknown>): boolean {
  if (typeof obj.pass !== "boolean" || typeof obj.summary !== "string") return false;
  // Draft Pass finals are re-emitted many times — never a progress bullet.
  if (obj.pass) return false;
  const issues = Array.isArray(obj.issues) ? obj.issues : [];
  // Non-empty issues ⇒ draft Fail, not a status tick.
  if (issues.length > 0) return false;
  const summary = obj.summary.trim();
  if (!summary) return false;
  if (summary.length > QA_STATUS_TICK_MAX_CHARS) return false;
  return true;
}

function qaIssues(obj: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(obj.issues)) return [];
  return (obj.issues as unknown[]).filter(
    (i): i is Record<string, unknown> =>
      !!i && typeof i === "object" && !Array.isArray(i) && typeof (i as { description?: unknown }).description === "string",
  );
}

/**
 * Split a long Grok/Codex QA summary into a short scannable headline + optional body. Grok often
 * dumps the whole investigation narrative into `summary`, which made `**Pass** — …` a wall of text
 * in the task feed (prod: weekly-safety QA, usage-chip QA).
 */
export function splitVerdictSummary(summary: string): { headline: string; body?: string } {
  let s = summary.trim().replace(/[ \t]+/g, " ");
  // Model often repeats the label: "Pass. Prior blocker is fixed…" / "FAIL — chip clipped…".
  s = s.replace(/^(?:pass|fail|status)\b\s*[.:—–-]\s*/i, "");
  if (!s) return { headline: summary.trim() || "" };

  // First sentence as headline when there's a real rest-of-essay after it.
  // Allow short punchy openers ("Ship it.", "Looks good.") when body is long enough —
  // Grok often leads with those then dumps the investigation.
  const m = /^(.{1,180}?[.!?…])(?:\s+)([\s\S]{40,})$/s.exec(s);
  if (m) {
    const head = m[1]!.trim();
    const body = m[2]!.trim();
    // Tiny openers ("OK.", "Yes.") make a weak card headline — promote the next sentence.
    // Keep punchy ones like "Ship it." / "Looks good." as the headline.
    if (head.length < 6) {
      const m2 = /^(.{6,180}?[.!?…])(?:\s+)([\s\S]{20,})$/s.exec(s);
      if (m2) return { headline: m2[1]!.trim(), body: m2[2]!.trim() };
    }
    return { headline: head, body };
  }

  // Single long clause with no sentence break — soft-cut at a natural pause.
  if (s.length > 200) {
    const cut = s.slice(0, 180);
    const at = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(", "), cut.lastIndexOf(" — "), cut.lastIndexOf(" - "));
    if (at > 60) {
      return {
        headline: s.slice(0, at).trim().replace(/[;,—–-]+$/, "") + "…",
        body: s.slice(at).replace(/^[\s;,—–-]+/, ""),
      };
    }
  }
  return { headline: s };
}

/** Final Pass/Fail/Status block: short headline, optional body, optional **Issues** list. */
function formatQaVerdict(
  kind: "Pass" | "Fail" | "Status",
  summary: string,
  issues: Record<string, unknown>[],
): string {
  const { headline, body } = splitVerdictSummary(summary);
  const lines = [`**${kind}** — ${headline}`];
  if (body) lines.push("", body);
  if (issues.length) {
    lines.push("", "**Issues**");
    for (const i of issues) lines.push(formatIssueLine(i));
  }
  return lines.join("\n");
}

/** One human line (or short multi-line block) for a single structured object. Used for live progress
 *  deltas (`isLast: false` → bullet status) and for the final flush (`isLast: true` → Pass/Fail etc.). */
export function formatStructuredObject(
  obj: Record<string, unknown>,
  opts: { isLast?: boolean } = {},
): string | null {
  const isLast = opts.isLast ?? true;

  // QA verdict shape — boolean pass + summary (issues optional).
  if (typeof obj.pass === "boolean" && typeof obj.summary === "string") {
    const issues = qaIssues(obj);
    // Intermediate: only short empty-issues status ticks. Draft Pass/Fail re-emits are skipped so the
    // feed doesn't become a wall of near-identical long bullets (prod: Grok usage QA).
    // Use markdown `- ` (not unicode •) so the feed Markdown renderer actually builds a list.
    if (!isLast) {
      if (!isQaStatusTick(obj)) return null;
      return `- ${obj.summary.trim()}`;
    }
    if (obj.pass) return formatQaVerdict("Pass", obj.summary, issues);
    if (issues.length === 0) return formatQaVerdict("Status", obj.summary, []);
    return formatQaVerdict("Fail", obj.summary, issues);
  }

  // Reader disposition.
  if (typeof obj.answered === "boolean" || typeof obj.escalated === "boolean") {
    if (obj.escalated) {
      const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "needs full pipeline";
      return isLast ? `**Escalated** — ${reason}` : `- Escalating: ${reason}`;
    }
    if (obj.answered) return isLast ? "**Answered** — lookup complete (see findings)." : "- Answering lookup…";
    return isLast ? "**Reader** — no answer posted." : null;
  }

  // Plan / research / generic summary-bearing objects.
  if (typeof obj.summary === "string") {
    const summary = obj.summary;
    if (!isLast) return `- ${summary}`;
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
 * Returns the original text unchanged when no JSON objects are present (after optionally compacting
 * an already-humanized but bloated QA checklist from an earlier formatter).
 *
 * Safe to call on already-humanized text and on historical messages that were persisted as raw
 * multi-object walls before write-time humanization existed.
 */
export function formatStructuredRoleFeed(text: string): string {
  if (!text?.trim()) return text;
  const objects = extractJsonObjects(text);
  if (!objects.length) return compactHumanizedQaChecklist(text);

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

  // Prefer EARLY status ticks ("Starting QA", "Reading…") — late ticks are often near-final
  // rephrases that survived the draft filter. When still over the cap, keep the first N + a tail count.
  const capped =
    progress.length > MAX_FEED_PROGRESS
      ? [...progress.slice(0, MAX_FEED_PROGRESS), `- …${progress.length - MAX_FEED_PROGRESS} more checks`]
      : progress;
  // Blank line before the final Pass/Fail so the Markdown renderer splits checklist vs verdict
  // (adjacent non-blank lines would otherwise glue into one paragraph).
  const blocks =
    finalBlock && capped.length
      ? [...capped, "", finalBlock]
      : finalBlock
        ? [finalBlock]
        : capped;

  // Brace-balanced fragments inside already-human prose (e.g. restart body `{"id":"claude-orchestrator"}`
  // in an issue description) are NOT role-output walls. Treating them as such used to stripJsonish
  // the narrative and skip compactHumanizedQaChecklist — so **Issues** never applied and second
  // pass was non-identity (prod: nightly Fail messages mentioning hub restart JSON).
  if (!blocks.length) return compactHumanizedQaChecklist(text);

  const prose = stripJsonish(text);
  if (prose && !isJsonLeftover(prose)) {
    return prose + "\n\n" + blocks.join("\n");
  }
  return blocks.join("\n");
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

/**
 * Second-pass cleanup for messages already written by an earlier humanizer that still looked like a
 * wall: long mid-stream draft-fail bullets were kept as checklist items. Drop progress bullets that
 * would fail `isQaStatusTick` (by length), re-cap early ticks, ensure a blank line before Pass/Fail,
 * and label an Issues: section when issue bullets follow the verdict. Identity when nothing changes.
 */
function compactHumanizedQaChecklist(text: string): string {
  if (!/\*\*(?:Pass|Fail|Status)\*\*/.test(text)) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const verdictIdx = lines.findIndex((l) => /^\*\*(?:Pass|Fail|Status)\*\*/.test(l.trim()));
  if (verdictIdx < 0) return text;

  const before = lines.slice(0, verdictIdx);
  const after = lines.slice(verdictIdx);

  const progress: string[] = [];
  let last = "";
  for (const line of before) {
    const t = line.trim();
    if (!t) continue;
    // Accept both markdown `-`/`*` and legacy unicode • progress bullets.
    const m = /^[-*+•]\s+(.*)$/.exec(t);
    if (!m) continue;
    const body = (m[1] ?? "").trim();
    if (!body || body.length > QA_STATUS_TICK_MAX_CHARS) continue;
    const bullet = `- ${body}`;
    if (bullet === last) continue;
    last = bullet;
    progress.push(bullet);
  }

  const capped =
    progress.length > MAX_FEED_PROGRESS
      ? [...progress.slice(0, MAX_FEED_PROGRESS), `- …${progress.length - MAX_FEED_PROGRESS} more checks`]
      : progress;

  // Rebuild the verdict block: Pass/Fail headline (+ body), **Issues**, issue bullets.
  let verdictLine = "";
  const issueLines: string[] = [];
  const trailing: string[] = [];
  for (const line of after) {
    const t = line.trim();
    if (!t) continue;
    if (!verdictLine && /^\*\*(?:Pass|Fail|Status)\*\*/.test(t)) {
      verdictLine = t;
      continue;
    }
    // Accept both plain "Issues:" (older humanizer) and bold "**Issues**".
    if (/^(?:\*\*)?Issues:?\*\*\s*$/i.test(t) || /^Issues:\s*$/i.test(t)) continue;
    const issue = /^[-*+•]\s+(\*\*[^*]+\*\*:.*)$/.exec(t);
    if (issue) {
      issueLines.push(`- ${issue[1]}`);
      continue;
    }
    trailing.push(t);
  }

  // Re-split an essay-length `**Pass** — whole investigation…` into headline + body (history load).
  let bodyFromSplit: string | undefined;
  if (verdictLine) {
    const vm = /^\*\*(Pass|Fail|Status)\*\*\s*[—–-]\s*([\s\S]+)$/.exec(verdictLine);
    if (vm) {
      const { headline, body } = splitVerdictSummary(vm[2]!);
      verdictLine = `**${vm[1]}** — ${headline}`;
      bodyFromSplit = body;
    }
  }

  const verdictParts: string[] = [];
  if (verdictLine) verdictParts.push(verdictLine);
  if (bodyFromSplit) verdictParts.push("", bodyFromSplit);
  // Trailing prose that isn't issues (e.g. already-split body from a prior pass) stays after the
  // headline; skip when we just produced the same body via re-split so the second pass is identity.
  const trailingKeep = trailing.filter((t) => !bodyFromSplit || t !== bodyFromSplit);
  if (trailingKeep.length) {
    // Avoid duplicating a body that already starts the trailing block after our split.
    if (!(bodyFromSplit && trailingKeep[0] === bodyFromSplit)) {
      verdictParts.push(...(bodyFromSplit || verdictLine ? ["", ...trailingKeep] : trailingKeep));
    }
  }
  if (issueLines.length) {
    // Blank line before **Issues** so Markdown keeps the verdict as its own paragraph.
    verdictParts.push("", "**Issues**", ...issueLines);
  }

  const blocks =
    capped.length && verdictParts.length
      ? [...capped, "", ...verdictParts]
      : verdictParts.length
        ? verdictParts
        : capped;
  const next = blocks.join("\n");
  // Normalize comparison — ignore trailing whitespace / final newline drift.
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n+$/, "").trimEnd();
  return norm(next) === norm(text) ? text : next;
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
