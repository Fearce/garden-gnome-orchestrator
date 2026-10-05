import type { CardInput, CardJob } from "./indexStore.js";
import { parseJsonObject, type MemoryModels } from "./models.js";

// Retrieval cards: for each memory, a model writes the questions and alternative words someone would use
// when that memory is what they need. The cards are indexed next to the memory's own text, so the lexical
// stage finds a memory by paraphrase even when no model is available to judge at query time. A card is
// keyed to the memory's content hash and rebuilt in the background after an edit.

const BATCH = 6;
const BODY_CHARS = 1_400;
const PAUSE_MS = 1_500;
const RETRY_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 90_000;
const BUSY_RETRY_MS = 30_000;

const SYSTEM =
  "You write retrieval cards for a personal knowledge base of an AI coding agent's long-term memories. For each memory, " +
  "write 5 short, varied questions or task requests a person might type when this memory is exactly what they need — " +
  "phrase them the way someone who has NOT read the memory would, using different words than its title — and 10 " +
  "alternative keywords or synonyms (tools, symptoms, concepts) that do not already appear in the title. Reply with JSON " +
  'only: {"cards":[{"id":1,"queries":["..."],"keywords":["..."]}]} with one entry per memory id.';

export type CardBuilderState = "idle" | "running" | "waiting-for-capacity" | "disabled";

export interface CardBuilderStatus {
  state: CardBuilderState;
  builtThisRun: number;
  lastError: string | null;
  nextAttemptAt: number | null;
}

export interface CardBuilderDeps {
  jobs: (limit: number, exclude: string[]) => Promise<CardJob[]>;
  store: (cards: CardInput[]) => Promise<number>;
  models: MemoryModels;
  enabled: () => boolean;
}

/** Background card generation: one batch at a time on the background lane, paused while no subscription
 *  has room, and completely idle (no timer) once every memory has a current card. */
export class CardBuilder {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private status_: CardBuilderStatus = { state: "idle", builtThisRun: 0, lastError: null, nextAttemptAt: null };

  constructor(private readonly deps: CardBuilderDeps) {}

  status(): CardBuilderStatus {
    return { ...this.status_, state: this.deps.enabled() ? this.status_.state : "disabled" };
  }

  /** Begin after the boot rush, so card work never competes with GGO starting up. */
  start(): void {
    this.started = true;
    this.schedule(STARTUP_DELAY_MS);
  }

  /** Memories changed: run soon. A wait for capacity keeps its own retry time unless `force`d. */
  poke(force = false): void {
    if (!this.started || this.running) return;
    if (!force && this.status_.state === "waiting-for-capacity") return;
    this.schedule(PAUSE_MS);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status_.nextAttemptAt = null;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.status_.nextAttemptAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.status_.nextAttemptAt = null;
      void this.run();
    }, delayMs);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    if (!this.started || this.running || !this.deps.enabled()) return;
    this.running = true;
    this.status_.state = "running";
    this.status_.builtThisRun = 0;
    const attempted: string[] = [];
    try {
      for (;;) {
        if (!this.started || !this.deps.enabled()) {
          this.status_.state = "idle";
          return;
        }
        const jobs = await this.deps.jobs(BATCH, attempted);
        if (!jobs.length) {
          this.status_.state = "idle";
          // Partial or unusable batches remain work, even after this pass has tried every file.
          if (attempted.length && (await this.deps.jobs(1, [])).length) this.schedule(RETRY_MS);
          return;
        }
        const built = await this.buildBatch(jobs);
        if (built === "busy") {
          this.status_.state = "idle";
          this.schedule(BUSY_RETRY_MS);
          return;
        }
        attempted.push(...jobs.map((job) => job.file));
        if (built == null) {
          this.status_.state = "waiting-for-capacity";
          this.schedule(RETRY_MS);
          return;
        }
        this.status_.builtThisRun += built;
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    } catch (err) {
      this.status_.lastError = err instanceof Error ? err.message : String(err);
      this.status_.state = "waiting-for-capacity";
      this.schedule(RETRY_MS);
    } finally {
      this.running = false;
    }
  }

  /** Cards stored for this batch; "busy" while another background job holds the lane; null when no
   *  subscription has room. */
  private async buildBatch(jobs: CardJob[]): Promise<number | "busy" | null> {
    const answer = await this.deps.models.complete({
      system: SYSTEM,
      user: jobs.map((job, i) => renderJob(job, i + 1)).join("\n\n"),
      maxTokens: 260 * jobs.length,
      purpose: "cards",
      lane: "background",
      timeoutMs: 120_000,
      accept: (text) => parseCards(text, jobs.length).size > 0,
    });
    if ("failure" in answer) {
      if (answer.failure === "unusable") return 0;
      if (answer.failure === "busy") return "busy";
      this.status_.lastError = "no Haiku or Luna capacity for card building";
      return null;
    }
    if (!this.started || !this.deps.enabled()) return 0;
    const cards = parseCards(answer.text, jobs.length);
    const inputs: CardInput[] = [];
    for (const [id, text] of cards) inputs.push({ file: jobs[id - 1]!.file, hash: jobs[id - 1]!.hash, text, model: answer.model });
    this.status_.lastError = null;
    return this.deps.store(inputs);
  }
}

function renderJob(job: CardJob, id: number): string {
  const body = job.body.length > BODY_CHARS ? `${job.body.slice(0, BODY_CHARS)}…` : job.body;
  return `### Memory ${id}\nTitle: ${job.name}\nSummary: ${job.description}\n${body}`;
}

/** Card text by 1-based memory id. */
export function parseCards(text: string, count: number): Map<number, string> {
  const parsed = parseJsonObject(text);
  const out = new Map<number, string>();
  if (!parsed || !Array.isArray(parsed.cards)) return out;
  for (const raw of parsed.cards) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { id?: unknown; queries?: unknown; keywords?: unknown };
    const id = Number(entry.id);
    if (!Number.isInteger(id) || id < 1 || id > count) continue;
    const queries = strings(entry.queries).slice(0, 8);
    const keywords = strings(entry.keywords).slice(0, 16);
    if (!queries.length && !keywords.length) continue;
    out.set(id, [...queries, keywords.join(", ")].filter(Boolean).join("\n"));
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean) : [];
}
