import { join } from "node:path";
import { config } from "../config.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ExtractionOffsets, memoryAgentHooks, type AgentMemory, type AgentRunKind } from "./agentHooks.js";
import { CardBuilder, type CardBuilderStatus } from "./cards.js";
import { MemoryCorpus, safeMemoryFile, type MemoryPatch, type NewMemory } from "./corpus.js";
import { ExtractionQueue, type ExtractionItem, type ExtractionStatus } from "./extraction.js";
import type { IndexStatus, IndexedFile } from "./indexStore.js";
import { MemoryModels, type MemoryModelDeps, type ProviderState } from "./models.js";
import { MemoryRecall, type RecallMode, type RecallResult } from "./recall.js";
import { MemoryWorkerClient } from "./workerClient.js";

export interface MemorySearchHit {
  name: string;
  description: string;
  /** The memory's file name inside the memory directory; `read` accepts it. */
  file: string;
  path: string;
  lastVerified: string;
  score: number;
  judgedBy: "model" | "lexical";
}

export interface MemoryService extends AgentMemory {
  readonly dir: string;
  /** Ranked memories; `mode` "prompt" or "session" answers exactly what that recall hook would inject. */
  search(query: string, k?: number, mode?: RecallMode): Promise<MemorySearchHit[]>;
  /** Full content of one memory file by its frontmatter name or file name. Scoped to the memory dir. */
  read(nameOrFile: string): Promise<string | null>;
  /** SDK hooks giving a Claude-based agent run native recall and extraction; undefined when off. */
  agentHooks(run: AgentRunKind): Options["hooks"] | undefined;
  /** Recall for a Codex run, which takes it as a prompt prefix; undefined when agent recall is off. */
  codexMemory(): { service: AgentMemory; dir: string } | undefined;
  /** Write a new memory file; returns its file name. */
  create(input: NewMemory): Promise<string>;
  update(file: string, patch: MemoryPatch): Promise<boolean>;
  /** Move a memory into the directory's trash; returns its new path, or null when it did not exist. */
  remove(file: string): Promise<string | null>;
}

export interface MemorySettings {
  /** Let Haiku (or Luna) judge relevance at query time; off = lexical ranking only. */
  modelRanking: boolean;
  /** Build retrieval cards for new and edited memories in the background. */
  cards: boolean;
  /** Process the automatic-extraction queue. */
  extraction: boolean;
  /** Fall back to Codex Luna when no Claude subscription can take a memory call. */
  lunaFallback: boolean;
  /** Give GGO's agents recall and extraction natively (SDK hooks for Claude, a prompt prefix for Codex). */
  agentRecall: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { modelRanking: true, cards: true, extraction: true, lunaFallback: true, agentRecall: true };

export interface MemoryServiceOptions {
  /** Where the derived search index lives. */
  indexPath?: string;
  /** Subscription access for Haiku and Luna; omitted, memory works lexically only. */
  models?: Omit<MemoryModelDeps, "runLuna" | "recordUsage">;
  settings?: () => MemorySettings;
  ownerName?: () => string;
  workerIdleMs?: number;
}

export interface MemoryStatus {
  dir: string;
  indexPath: string;
  workerRunning: boolean;
  index: IndexStatus;
  providers: { haiku: ProviderState; luna: ProviderState } | null;
  cards: CardBuilderStatus | null;
  extraction: ExtractionStatus | null;
  settings: MemorySettings;
}

const SNIPPET_LIMIT = 20_000;

/**
 * The owner's memory: Markdown files in `dir` (the source of truth, shared with Claude Code's own memory
 * tooling), a derived SQLite FTS index owned by an on-demand worker thread, and Haiku/Luna for relevance
 * judgement, retrieval cards and automatic extraction. Without model access it still searches, reads
 * and writes — lexically.
 */
export class FileMemoryService implements MemoryService {
  readonly corpus: MemoryCorpus;
  readonly indexPath: string;
  private readonly worker: MemoryWorkerClient;
  private readonly models: MemoryModels | null;
  private readonly recaller: MemoryRecall;
  private readonly cards: CardBuilder | null;
  private readonly extraction: ExtractionQueue | null;
  private readonly settings: () => MemorySettings;
  private offsets: ExtractionOffsets | null = null;

  constructor(readonly dir: string = config.memoryDir, options: MemoryServiceOptions = {}) {
    this.corpus = new MemoryCorpus(dir);
    this.indexPath = options.indexPath ?? defaultIndexPath(dir);
    this.settings = options.settings ?? (() => DEFAULT_MEMORY_SETTINGS);
    this.worker = new MemoryWorkerClient(this.indexPath, dir, {
      idleMs: options.workerIdleMs,
      onIndexChanged: () => {
        this.recaller?.clearCache();
        this.cards?.poke();
      },
    });
    this.models = options.models
      ? new MemoryModels({
          ...options.models,
          runLuna: (request) => this.worker.luna(request),
          recordUsage: (record) => void this.worker.recordUsage(record).catch(() => {}),
        })
      : null;
    this.recaller = new MemoryRecall((query, limit) => this.worker.search(query, limit), this.models, () => this.settings().modelRanking);
    const models = this.models;
    this.cards = models
      ? new CardBuilder({
          jobs: (limit, exclude) => this.worker.cardJobs(limit, exclude),
          store: async (cards) => {
            const stored = await this.worker.storeCards(cards);
            if (stored) this.recaller.clearCache();
            return stored;
          },
          models,
          enabled: () => this.settings().cards,
        })
      : null;
    this.extraction = models
      ? new ExtractionQueue({
          corpus: this.corpus,
          models,
          search: (query, limit) => this.worker.search(query, limit),
          ownerName: options.ownerName ?? (() => config.ownerName),
          enabled: () => this.settings().extraction,
          onWrite: () => this.changed(),
        })
      : null;
  }

  /** Start the background jobs (card building, the extraction queue). Tests and tools skip this. */
  start(): void {
    this.cards?.start();
    this.extraction?.start();
  }

  async close(): Promise<void> {
    this.cards?.stop();
    this.extraction?.stop();
    await this.worker.close();
  }

  async search(query: string, k = 6, mode: RecallMode = "search"): Promise<MemorySearchHit[]> {
    const result = await this.recall(query, mode, k, 12_000);
    return result.memories.map((memory) => ({
      name: memory.name,
      description: memory.description,
      file: memory.file,
      path: join(this.dir, memory.file),
      lastVerified: memory.lastVerified,
      score: memory.score,
      judgedBy: memory.judgedBy,
    }));
  }

  agentHooks(run: AgentRunKind): Options["hooks"] | undefined {
    if (!this.settings().agentRecall) return undefined;
    this.offsets ??= new ExtractionOffsets();
    return memoryAgentHooks(this, this.dir, run, this.offsets);
  }

  codexMemory(): { service: AgentMemory; dir: string } | undefined {
    return this.settings().agentRecall ? { service: this, dir: this.dir } : undefined;
  }

  async recall(query: string, mode: RecallMode, limit: number, timeoutMs: number): Promise<RecallResult> {
    const started = Date.now();
    // External tools edit the source files too. Refresh before consulting the model-result cache.
    await this.worker.sync();
    return this.recaller.recall(query, mode, limit, timeoutMs - (Date.now() - started));
  }

  async read(nameOrFile: string): Promise<string | null> {
    const file = await this.resolve(nameOrFile);
    const text = file ? await this.corpus.read(file) : null;
    if (text == null) return null;
    return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}\n…(truncated)` : text;
  }

  /** Untruncated text plus index metadata, for the editor. */
  async get(file: string): Promise<{ meta: IndexedFile | null; text: string } | null> {
    const safe = safeMemoryFile(file);
    const text = safe ? await this.corpus.read(safe) : null;
    if (!safe || text == null) return null;
    return { meta: await this.worker.file(safe), text };
  }

  list(offset: number, limit: number, filter: string): Promise<{ total: number; files: IndexedFile[] }> {
    return this.worker.list(offset, limit, filter);
  }

  async create(input: NewMemory): Promise<string> {
    const file = await this.corpus.create(input);
    this.changed();
    return file;
  }

  async update(file: string, patch: MemoryPatch): Promise<boolean> {
    const ok = await this.corpus.update(file, patch);
    if (ok) this.changed();
    return ok;
  }

  /** Moves the file into the memory directory's trash; returns where it went. */
  async remove(file: string): Promise<string | null> {
    const moved = await this.corpus.remove(file);
    if (moved) this.changed();
    return moved;
  }

  async enqueueExtraction(item: Omit<ExtractionItem, "version" | "createdAt">): Promise<"queued" | "too-short" | "disabled" | "unavailable"> {
    if (!this.extraction) return "unavailable";
    if (!this.settings().extraction) return "disabled";
    return (await this.extraction.enqueue(item)) ? "queued" : "too-short";
  }

  /** Wake the background jobs after a toggle, so re-enabling one takes effect now rather than at its next timer. */
  settingsChanged(): void {
    this.recaller.clearCache();
    this.cards?.poke(true);
    this.extraction?.kick(true);
  }

  /** Re-read every file (a full rebuild of the derived rows; cards are kept). */
  async reindex(): Promise<void> {
    await this.worker.sync(true);
    this.recaller.clearCache();
    this.cards?.poke();
  }

  async status(): Promise<MemoryStatus> {
    return {
      dir: this.dir,
      indexPath: this.indexPath,
      workerRunning: this.worker.running,
      index: await this.worker.status(),
      providers: this.models ? await this.models.providers() : null,
      cards: this.cards?.status() ?? null,
      extraction: this.extraction ? await this.extraction.status() : null,
      settings: this.settings(),
    };
  }

  private async resolve(nameOrFile: string): Promise<string | null> {
    const raw = (nameOrFile ?? "").trim();
    if (!raw) return null;
    const byName = await this.worker.findByName(raw);
    return byName ?? safeMemoryFile(raw);
  }

  /** Something outside GGO wrote to the memory directory: re-read changed files before the next query. */
  changed(): void {
    this.worker.markDirty();
    this.recaller.clearCache();
    this.cards?.poke();
  }
}

/** The default memory directory's index lives with GGO's other data; any other directory (a test's, a
 *  second owner's) keeps its own index beside it, so two directories never share one. */
function defaultIndexPath(dir: string): string {
  return dir === config.memoryDir ? join(config.dataDir, "memory-index.sqlite") : join(dir, ".ggo-memory-index.sqlite");
}
