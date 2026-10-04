import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REVIEW_SECTION, type MemoryCorpus, type MemoryType } from "./corpus.js";
import type { SearchCandidate } from "./indexStore.js";
import { parseJsonObject, type MemoryModels, type ModelFailure } from "./models.js";

// Automatic memory extraction. A producer — the Claude Code PreCompact hook (`extractor.py`) or GGO
// itself — drops the owner's own words from a conversation into a queue directory; GGO drains it in the
// background with Haiku (Luna as fallback). Each candidate must quote the owner verbatim, clear a
// confidence bar and survive a duplicate check against the nearest existing memories before it is
// written. A queued item stays on disk until a model has processed it, so nothing is lost while every
// subscription is capped or GGO is down.

export const QUEUE_DIR = ".ggo-extraction-queue";
export const LOG_FILE = "extraction-log.md";
const FAILED_DIR = "failed";
const MAX_EXTRACTIONS = 2;
const MIN_CONFIDENCE = 0.7;
const MIN_TEXT_CHARS = 400;
const MAX_TEXT_CHARS = 24_000;
const RETRY_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 120_000;
/** Unusable model answers tolerated before an item is set aside in `failed/` (kept, not deleted). */
const MAX_UNUSABLE = 3;
const BUSY_RETRY_MS = 30_000;
const KINDS = new Set<MemoryType>(["user", "feedback", "reference"]);
const LOG_HEADER =
  "# Extraction log\n\nAppend-only audit trail of every memory-extraction attempt (GGO's extraction queue). Review weekly alongside `last-report.md`.\n";

export interface ExtractionItem {
  version: 1;
  source: string;
  sessionId: string | null;
  createdAt: string;
  text: string;
  /** How many times a model answered this item in an unusable shape. */
  unusable?: number;
}

export interface ExtractionStatus {
  pending: number;
  state: "idle" | "running" | "waiting-for-capacity" | "disabled";
  lastRunAt: number | null;
  lastAdded: number;
  lastError: string | null;
}

interface Candidate {
  kind: MemoryType;
  name: string;
  description: string;
  body: string;
  confidence: number;
  quote: string;
}

export interface ExtractionDeps {
  corpus: MemoryCorpus;
  models: MemoryModels;
  search: (query: string, limit: number) => Promise<SearchCandidate[]>;
  ownerName: () => string;
  enabled: () => boolean;
  /** A memory was written: the index and caches should refresh. */
  onWrite: () => void;
}

export class ExtractionQueue {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private status_: Omit<ExtractionStatus, "pending" | "state"> & { waiting: boolean } = { lastRunAt: null, lastAdded: 0, lastError: null, waiting: false };

  constructor(private readonly deps: ExtractionDeps) {}

  private get dir(): string {
    return join(this.deps.corpus.dir, QUEUE_DIR);
  }

  async status(): Promise<ExtractionStatus> {
    const state = !this.deps.enabled() ? "disabled" : this.running ? "running" : this.status_.waiting ? "waiting-for-capacity" : "idle";
    const { waiting: _waiting, ...rest } = this.status_;
    return { ...rest, pending: (await this.pendingFiles()).length, state };
  }

  /** Persist an item; it is processed in the background. Returns false when the text is too short to hold
   *  a durable statement. */
  async enqueue(item: Omit<ExtractionItem, "version" | "createdAt">): Promise<boolean> {
    if (item.text.trim().length < MIN_TEXT_CHARS) return false;
    await mkdir(this.dir, { recursive: true });
    const full: ExtractionItem = { version: 1, createdAt: new Date().toISOString(), ...item, text: item.text.slice(-MAX_TEXT_CHARS) };
    const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
    const temp = join(this.dir, `${name}.tmp`);
    await writeFile(temp, JSON.stringify(full), "utf8");
    await rename(temp, join(this.dir, name));
    this.kick();
    return true;
  }

  start(): void {
    this.started = true;
    this.schedule(STARTUP_DELAY_MS);
  }

  /** New work arrived: run soon. A wait for capacity keeps its own retry time unless `force`d. */
  kick(force = false): void {
    if (!this.started || this.running) return;
    if (!force && this.status_.waiting) return;
    this.schedule(1_000);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
    this.timer.unref();
  }

  private async pendingFiles(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((file) => file.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  private async drain(): Promise<void> {
    if (this.running || !this.deps.enabled()) return;
    this.running = true;
    this.status_.waiting = false;
    try {
      for (const file of await this.pendingFiles()) {
        if (!this.deps.enabled()) return;
        const outcome = await this.processFile(file);
        if (outcome === "busy") {
          this.schedule(BUSY_RETRY_MS);
          return;
        }
        if (outcome === "no-capacity") {
          this.status_.waiting = true;
          this.schedule(RETRY_MS);
          return;
        }
      }
    } catch (err) {
      this.status_.lastError = err instanceof Error ? err.message : String(err);
      this.schedule(RETRY_MS);
    } finally {
      this.running = false;
      this.status_.lastRunAt = Date.now();
    }
  }

  private async processFile(file: string): Promise<"done" | ModelFailure["failure"]> {
    const path = join(this.dir, file);
    let item: ExtractionItem;
    try {
      item = JSON.parse(await readFile(path, "utf8")) as ExtractionItem;
    } catch {
      await this.setAside(path, file, "unreadable queue file");
      return "done";
    }
    if (item?.version !== 1 || typeof item.text !== "string") {
      await this.setAside(path, file, "not a queue item (no version-1 text)");
      return "done";
    }
    const result = await this.extract(item);
    if (result === "busy") return "busy";
    if (result === "no-capacity") {
      this.status_.lastError = "no Haiku or Luna capacity; the item stays queued";
      return "no-capacity";
    }
    if (result === "unusable") {
      const unusable = (item.unusable ?? 0) + 1;
      if (unusable >= MAX_UNUSABLE) await this.setAside(path, file, `${unusable} unusable model answers`);
      else await writeFile(path, JSON.stringify({ ...item, unusable }), "utf8");
      return "done";
    }
    await this.deps.corpus.appendLog(LOG_FILE, logBlock(item, result), LOG_HEADER);
    await unlink(path).catch(() => {});
    this.status_.lastAdded = result.added.length;
    this.status_.lastError = null;
    if (result.added.length) this.deps.onWrite();
    return "done";
  }

  /** Move an item the models cannot process into `failed/`, where it stays for the owner to inspect. */
  private async setAside(path: string, file: string, reason: string): Promise<void> {
    const failed = join(this.dir, FAILED_DIR);
    await mkdir(failed, { recursive: true });
    await rename(path, join(failed, file));
    await this.deps.corpus.appendLog(LOG_FILE, `\n## ${new Date().toISOString()}\n\nqueue item \`${file}\` set aside in \`${QUEUE_DIR}/${FAILED_DIR}/\`: ${reason}\n`, LOG_HEADER);
  }

  private async extract(item: ExtractionItem): Promise<ExtractionResult | ModelFailure["failure"]> {
    const owner = this.deps.ownerName();
    const answer = await this.deps.models.complete({
      system: extractorSystem(owner),
      user: extractorUser(owner, item.text),
      maxTokens: 1_200,
      purpose: "extract",
      lane: "background",
      timeoutMs: 120_000,
      accept: (text) => Array.isArray(parseJsonObject(text)?.extractions),
    });
    if ("failure" in answer) return answer.failure;
    const raw = (parseJsonObject(answer.text)?.extractions as unknown[]).slice(0, MAX_EXTRACTIONS);
    const result: ExtractionResult = { model: answer.model, returned: raw.length, added: [], duplicates: [], rejected: [] };
    const valid: Candidate[] = [];
    for (const entry of raw) {
      const checked = validate(entry, item.text);
      if (typeof checked === "string") result.rejected.push(`${checked} — name=${JSON.stringify(nameOf(entry))}`);
      else valid.push(checked);
    }
    if (!valid.length) return result;
    const duplicates = await this.duplicates(valid);
    if (typeof duplicates === "string") return duplicates;
    for (const [i, candidate] of valid.entries()) {
      const twin = duplicates.get(i);
      if (twin) {
        result.duplicates.push(`${JSON.stringify(candidate.name)} (already covered by \`${twin}\`)`);
        continue;
      }
      const file = await this.deps.corpus.create(
        {
          name: candidate.name,
          description: candidate.description,
          type: candidate.kind,
          body: candidate.body,
          extra: { source: "auto-extracted", ...(item.sessionId ? { source_session: item.sessionId } : {}) },
        },
        REVIEW_SECTION,
        "Memory files written by GGO's extraction queue. Promote a row to its proper section in this index once you've reviewed it.",
      );
      result.added.push(`\`${file}\` (conf ${candidate.confidence}): ${JSON.stringify(candidate.name)}`);
    }
    return result;
  }

  /** Index of each candidate that repeats an existing memory, mapped to that memory's file. */
  private async duplicates(candidates: Candidate[]): Promise<Map<number, string> | ModelFailure["failure"]> {
    const neighbours = await Promise.all(candidates.map((c) => this.deps.search(`${c.name}\n${c.description}\n${c.body}`, 6)));
    if (neighbours.every((list) => !list.length)) return new Map();
    const blocks = candidates.map((candidate, i) => {
      const list = neighbours[i]!.map((n, j) => `  (${j + 1}) ${n.file}: ${n.name} — ${n.description}`).join("\n") || "  (none)";
      return `New memory ${i + 1}: ${candidate.name} — ${candidate.description}\n${candidate.body}\nNearest existing memories:\n${list}`;
    });
    const answer = await this.deps.models.complete({
      system:
        "You check proposed memories against existing ones. A proposal is a duplicate only when an existing memory already " +
        'states the same rule or fact (rewording does not make it new). Reply with JSON only: {"duplicates":[{"id":1,"of":2}]} ' +
        'where "of" is the number of the existing memory it repeats, or null when it is new.',
      user: blocks.join("\n\n"),
      maxTokens: 200,
      purpose: "extract",
      lane: "background",
      timeoutMs: 90_000,
      accept: (text) => Array.isArray(parseJsonObject(text)?.duplicates),
    });
    if ("failure" in answer) return answer.failure;
    const out = new Map<number, string>();
    for (const raw of parseJsonObject(answer.text)?.duplicates as unknown[]) {
      const entry = raw as { id?: unknown; of?: unknown } | null;
      const id = Number(entry?.id) - 1;
      const of = Number(entry?.of) - 1;
      const match = neighbours[id]?.[of];
      if (match) out.set(id, match.file);
    }
    return out;
  }
}

interface ExtractionResult {
  model: string;
  returned: number;
  added: string[];
  duplicates: string[];
  rejected: string[];
}

function nameOf(entry: unknown): string {
  return entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name : "?";
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A usable candidate, or why it was rejected. The evidence quote must appear verbatim (modulo whitespace)
 *  in the producer's text, which is the owner's own words only. */
export function validate(entry: unknown, text: string): Candidate | string {
  if (!entry || typeof entry !== "object") return "not-an-object";
  const e = entry as Record<string, unknown>;
  const kind = e.kind as MemoryType;
  if (!KINDS.has(kind)) return `invalid-kind (${JSON.stringify(e.kind)})`;
  const [name, description, body, quote] = [e.name, e.description, e.body, e.evidence_quote].map((v) => (typeof v === "string" ? v.trim() : ""));
  if (!name || !description || !body) return "missing-required-fields";
  const confidence = Number(e.confidence);
  if (!Number.isFinite(confidence)) return "invalid-confidence";
  if (confidence < MIN_CONFIDENCE) return `confidence-too-low (${confidence})`;
  if (quote!.length < 10) return "evidence-quote-missing-or-too-short";
  if (!squash(text).includes(squash(quote!))) return "evidence-quote-not-in-transcript";
  return { kind, name: name!.slice(0, 80), description: description!.slice(0, 200), body: body!, confidence, quote: quote! };
}

function extractorSystem(owner: string): string {
  return `You are a strict memory extractor for ${owner}'s AI coding agents. Your job is to find DURABLE facts about ${owner} in their own words from a conversation that should persist to FUTURE sessions across ALL their projects.

EXTRACT ONLY:
- Preferences ${owner} states about how they want agents to work ("I prefer X", "don't do Y", "always Z")
- Rules or constraints they reinforce (correcting an agent's behavior with an expectation for future sessions)
- New facts about their stack, tools, collaborators, or environment that are STABLE (not changing weekly)
- References to external resources (URLs, project locations) they want remembered

NEVER EXTRACT:
- Episodic events ("asked about X today", "we worked on Y")
- Project-specific implementation details
- Speculation, interpretation, or paraphrasing — only literal direct statements
- Sensitive personal-life details (mental health, relationships, finances), credentials or secrets
- Statements about a one-off task that won't apply to future sessions

You MUST return strict JSON only. No preamble, no commentary, no code fences.`;
}

function extractorUser(owner: string, text: string): string {
  return `TRANSCRIPT CHUNK (${owner}'s words only):

${text}

INSTRUCTIONS:
1. Find at MOST ${MAX_EXTRACTIONS} new durable facts worth persisting. Quality over quantity — if nothing meets the bar, return an empty list.
2. For each fact you must have a VERBATIM quote from the transcript above. Copy the exact words ${owner} used. If you can't quote them, you don't have evidence.
3. confidence < ${MIN_CONFIDENCE} → don't include the extraction at all.
4. Return STRICT JSON matching this schema, nothing else:

{"extractions": [{"kind": "user" | "feedback" | "reference", "name": "Short title in sentence case (under 60 chars)", "description": "One sentence describing this memory, under 120 chars", "body": "For 'feedback': the rule, then a 'Why:' line, then a 'How to apply:' line. For 'user': factual prose. For 'reference': the external resource and what it's for.", "confidence": 0.0, "evidence_quote": "literal verbatim words from the transcript above"}]}

If no extractions qualify, return: {"extractions": []}`;
}

function logBlock(item: ExtractionItem, result: ExtractionResult): string {
  const lines = [
    `\n## ${new Date().toISOString()}\n`,
    `source: ${item.source}${item.sessionId ? ` (session \`${item.sessionId}\`)` : ""}, text ${item.text.length} chars, model ${result.model}`,
    `candidates returned by extractor: ${result.returned}`,
  ];
  if (result.added.length) lines.push("**Added:**", ...result.added.map((line) => `  - added ${line}`));
  if (result.duplicates.length) lines.push("**Skipped (duplicate of existing):**", ...result.duplicates.map((line) => `  - skipped ${line}`));
  if (result.rejected.length) lines.push("**Rejected:**", ...result.rejected.map((line) => `  - rejected: ${line}`));
  if (!result.added.length && !result.duplicates.length && !result.rejected.length) lines.push("(no candidates met the bar — nothing added)");
  return `${lines.join("\n")}\n`;
}
