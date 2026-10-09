/** Gate for GGO's memory: Markdown files as the source of truth, the worker-owned FTS index, Haiku
 *  relevance judgement with account fallback, honest no-capacity behaviour (lexical recall, queued work
 *  kept on disk), retrieval cards, automatic extraction, the agent hooks and the HTTP surface. Haiku is a
 *  fake fetch and Luna is reported unavailable, so no provider is called. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ggo-memory-rag-"));
process.env.DATA_DIR = join(root, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });

const { FileMemoryService, DEFAULT_MEMORY_SETTINGS } = await import("../memory/memory.js");
const { HAIKU_MODEL, MemoryModels } = await import("../memory/models.js");
const { CardBuilder } = await import("../memory/cards.js");
const { MemoryRecall } = await import("../memory/recall.js");
const { QUEUE_DIR } = await import("../memory/extraction.js");
const { TRASH_DIR, REVIEW_SECTION, MemoryCorpus, dropRelated, memoryChunks, parseMemory, patchMemoryText, today } = await import("../memory/corpus.js");
const { memoryAgentHooks, ownerWords, prefetchMemoryRecall, promptRecallQuery, queuedOwnerText, stripTaskEnvelope, userText, ExtractionOffsets, OwnerInputBuffer } = await import("../memory/agentHooks.js");
const { CodexAgentRun } = await import("../agents/codexRunner.js");
const { MemoryIndexStore } = await import("../memory/indexStore.js");
const { repoMapContext } = await import("../memory/repoMaps.js");
const { subTaskContractBlock } = await import("../orchestrator/subTasks.js");
const { acknowledgedInjection } = await import("../orchestrator/injection.js");
const { withCommunicationTurnPolicy } = await import("../agents/communicationPolicy.js");
const { MemorySettingsStore } = await import("../memory/settings.js");
const { MemoryWorkerClient } = await import("../memory/workerClient.js");
const { MemoryEndpoint, isPrimaryMemoryOwner } = await import("../memory/endpoint.js");
const { registerMemoryRoutes } = await import("../memory/routes.js");
const Fastify = (await import("fastify")).default;
type MemorySettings = typeof DEFAULT_MEMORY_SETTINGS;
type Service = InstanceType<typeof FileMemoryService>;

const UNAVAILABLE_LUNA = async () => ({ unavailable: "Luna is not used by this test" });

function seed(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const memory = (file: string, type: string, name: string, description: string, body: string, extra = "") =>
    writeFileSync(
      join(dir, file),
      `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\ncreated_at: 2026-01-02\nlast_verified: 2026-01-03\n${extra}---\n\n${body}\n`,
    );
  memory("feedback_kettle.md", "feedback", "Descale the office kettle monthly", "Kitchen appliance upkeep rule for the shared office", "Run the citric acid cycle on the first Monday.\n\n**Why:** hard water.\n**How to apply:** put it in the calendar.", "triggers:\n  - limescale\n");
  memory("reference_deploy.md", "reference", "Deploy with the coordinator script", "How to ship a server change safely", "Use the deploy script; it drains agents before the restart and verifies the build.");
  memory("user_stack.md", "user", "Primary stack is TypeScript and SQLite", "The owner's everyday languages and storage", "TypeScript on Node with SQLite through better-sqlite3.", "related: [reference_deploy.md]\n");
  memory("project_garden.md", "project", "Garden irrigation timer project", "Hobby project controlling the drip irrigation", "An ESP32 opens the valve at dawn for twelve minutes.");
  writeFileSync(join(dir, "MEMORY.md"), "# Memory index\n\n- [Kettle](feedback_kettle.md) — descale monthly\n- [Deploy](reference_deploy.md) — coordinator script\n");
}

interface FakeHaiku {
  calls: Array<{ account: string; system: string; user: string }>;
  fetchImpl: typeof fetch;
}

/** A Haiku stand-in that answers each memory prompt the way the real model is asked to. */
function fakeHaiku(opts: { rejectAccounts?: string[] } = {}): FakeHaiku {
  const calls: FakeHaiku["calls"] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const account = String((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    const body = JSON.parse(String(init.body)) as { model: string; system: string; messages: Array<{ content: string }> };
    assert.equal(body.model, HAIKU_MODEL, "memory asks for exactly the Haiku model it reports");
    const user = body.messages[0]!.content;
    calls.push({ account, system: body.system, user });
    if (opts.rejectAccounts?.includes(account)) {
      return new Response("{}", { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": "4102444800" } });
    }
    return Response.json({ content: [{ type: "text", text: answer(body.system, user) }], usage: { input_tokens: 900, output_tokens: 40 } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function answer(system: string, user: string): string {
  if (system.includes('{"ids"')) {
    const line = user.split("\n").find((l) => /^\[\d+\] Descale the office kettle/.test(l));
    return JSON.stringify({ ids: line && /chalky|boiler|kettle/i.test(user.split("Candidates:")[0]!) ? [Number(line.slice(1, line.indexOf("]")))] : [] });
  }
  if (system.includes("retrieval cards")) {
    const ids = [...user.matchAll(/^### Memory (\d+)\nTitle: (.*)$/gm)];
    return JSON.stringify({
      cards: ids.map(([, id, title]) => ({ id: Number(id), queries: [`question about ${title}`], keywords: /kettle/i.test(title!) ? ["zeppelin", "boiler"] : ["misc"] })),
    });
  }
  if (system.includes("strict memory extractor")) {
    return JSON.stringify({
      extractions: [
        { kind: "feedback", name: "Answer in British English", description: "The owner wants British spelling in every reply", body: "Use British spelling.\n\n**Why:** stated preference.\n**How to apply:** colour, not color.", confidence: 0.9, evidence_quote: "always write British English in replies" },
        { kind: "feedback", name: "Invented rule", description: "A rule the owner never said", body: "Made up.", confidence: 0.95, evidence_quote: "this sentence never appears in the transcript" },
      ],
    });
  }
  if (system.includes("check proposed memories")) return JSON.stringify({ duplicates: [{ id: 1, of: null }] });
  return "{}";
}

function service(dir: string, opts: { haiku?: FakeHaiku; accounts?: string[]; settings?: () => MemorySettings; rateLimits?: string[]; picks?: string[] } = {}): Service {
  const accounts = opts.accounts ?? ["acct-a"];
  return new FileMemoryService(dir, {
    indexPath: join(root, `${Math.random().toString(36).slice(2)}.sqlite`),
    settings: opts.settings,
    ownerName: () => "Alex",
    models: opts.haiku
      ? {
          claudeAccount: (excluded) => {
            const id = accounts.find((a) => !excluded.includes(a));
            if (id) opts.picks?.push(id);
            return id ? { id, token: id } : undefined;
          },
          claudeHasRoom: () => accounts.length > 0,
          onClaudeRateLimit: (id) => opts.rateLimits?.push(id),
          lunaLaunch: UNAVAILABLE_LUNA,
          fetchImpl: opts.haiku.fetchImpl,
        }
      : undefined,
  });
}

/** The owner's real files: some start with a byte-order mark, some use CRLF, many keep `type` nested under
 *  `metadata:`. Edits must keep each layout, and concurrent writers must not lose index pointers. */
async function corpusEditsKeepTheOwnersLayouts(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const corpus = new MemoryCorpus(dir);
  const names = ["Alpha note", "Bravo note", "Charlie note", "Delta note", "Echo note"];
  const created = await Promise.all(names.map((name) => corpus.create({ type: "reference", name, description: `${name} for the race check`, body: "Body text for the race." })));
  const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
  assert.deepEqual(created.filter((file) => !index.includes(`(${file})`)), [], "concurrent creates keep every index pointer");
  await Promise.all(created.slice(0, 3).map((file) => corpus.remove(file)));
  const pruned = readFileSync(join(dir, "MEMORY.md"), "utf8");
  assert.deepEqual(created.filter((file, i) => pruned.includes(`(${file})`) !== i >= 3), [], "concurrent removes drop exactly their own pointers");

  const bom = "﻿---\nname: Popup guard\ndescription: Guards the terminal popup\ntype: reference\nrelated: [gone.md, kept.md]\n---\n\nBody.\n";
  assert.equal(parseMemory("bom.md", bom).name, "Popup guard", "a byte-order mark does not hide the frontmatter");
  const bomPatched = patchMemoryText(bom, { description: "Guards the terminal popup, edited" }, "2026-10-05");
  assert.equal(parseMemory("bom.md", bomPatched).name, "Popup guard", "patching a BOM file keeps one frontmatter block");
  assert.equal(bomPatched.match(/^---$/gm)?.length, 2, "patching a BOM file does not prepend a second block");
  assert.deepEqual(parseMemory("bom.md", dropRelated(bom, "gone.md") ?? "").related, ["kept.md"], "a BOM file's related link is dropped");

  const crlf = "---\r\nname: Windows note\r\ndescription: Written on Windows\r\nmetadata:\r\n  type: feedback\r\nrelated: [gone.md]\r\n---\r\n\r\nLine one.\r\nLine two.\r\n";
  const retyped = patchMemoryText(crlf, { type: "project" }, "2026-10-05");
  assert.equal(parseMemory("crlf.md", retyped).type, "project", "a type edit reaches a nested metadata type");
  assert.equal(retyped.match(/type:/g)?.length, 1, "a type edit replaces the nested type instead of adding a second one");
  assert.ok(!/(^|[^\r])\n/.test(retyped), "a patched CRLF file stays CRLF throughout");
  assert.ok(!/(^|[^\r])\n/.test(dropRelated(crlf, "gone.md") ?? "\n"), "dropping a related link keeps CRLF");
}

/** A task run's user turns are mostly GGO's own text (kickoff, QA, office); only steering blocks are the
 *  owner's. A Co-work run's user turns are the owner's chat, minus GGO's policy wrapper. */
async function extractionReadsOnlyTheOwnersWords(dir: string): Promise<void> {
  const kickoff = "## Brief\nNever use git add -A; commit only your own hunks.\n## Plan\nsteps";
  const steering = acknowledgedInjection("From now on, write every reply in British English.");
  assert.equal(ownerWords(`${kickoff}\n\n${steering}\n\nQA: two tests fail`, "task"), "From now on, write every reply in British English.", "a task run keeps only the steering block's message");
  assert.equal(ownerWords(kickoff, "task"), "", "a task run without steering has no owner words");
  assert.equal(ownerWords(`${kickoff}\n\n${steering}`, "subtask"), "", "a sub-task's steering is its parent agent's, not the owner's");
  const contract = subTaskContractBlock({ spec: { spawnedByRole: "implementor" } as never, parentTitle: "Parent", canSpawn: false });
  const queuedSubtask = withCommunicationTurnPolicy(`# Task: Child\n\n## Brief\nDo it.\n\n${contract}`, false) as string;
  assert.equal(queuedOwnerText(`${queuedSubtask}\n\n${steering}`), "", "a queued sub-task transcript, recognised by its real contract heading, has no owner words");
  assert.equal(queuedOwnerText(`# Task: T\n\n## Brief\nb\n\n${steering}`), "From now on, write every reply in British English.", "a bare task kickoff is recognised too");
  assert.equal(queuedOwnerText("Plain Claude Code chat about kettles."), "Plain Claude Code chat about kettles.", "text from outside GGO passes through");
  const cowork = withCommunicationTurnPolicy("I always want the changelog updated with each release.", false) as string;
  assert.equal(ownerWords(cowork, "cowork"), "I always want the changelog updated with each release.", "a Co-work turn loses only GGO's wrapper");

  seed(dir);
  const off = service(dir, { haiku: fakeHaiku(), settings: () => ({ ...DEFAULT_MEMORY_SETTINGS, extraction: false }) });
  assert.equal(await off.enqueueExtraction({ source: "test", sessionId: null, text: "always ".repeat(80) }), "disabled", "the extraction toggle also governs agent runs");
  assert.equal(existsSync(join(dir, QUEUE_DIR)) ? readdirSync(join(dir, QUEUE_DIR)).filter((f) => f.endsWith(".json")).length : 0, 0, "nothing is queued while extraction is off");
  await off.close();

  const offsetsFile = join(dir, "offsets.json");
  const offsets = new ExtractionOffsets(offsetsFile);
  await Promise.all(Array.from({ length: 40 }, (_, i) => offsets.set(`t${i}`, i)));
  assert.equal(Object.keys(JSON.parse(readFileSync(offsetsFile, "utf8"))).length, 40, "concurrent offset writes leave valid JSON holding every transcript");
  const lru = new ExtractionOffsets(join(dir, "lru.json"));
  await lru.set("kept", 1);
  for (let i = 0; i < 499; i++) await lru.set(`filler${i}`, i);
  await lru.set("kept", 2);
  await lru.set("one-more", 1);
  assert.equal(await new ExtractionOffsets(join(dir, "lru.json")).get("kept"), 2, "trimming keeps the most recently used transcripts");
}

/** Usage is recorded fire-and-forget after each model call, so close() routinely meets a request in flight.
 *  It must still stop the worker thread: a thread left behind outlives its owner and can hang process exit. */
async function closeStopsTheWorkerWithWorkInFlight(dir: string): Promise<void> {
  seed(dir);
  const client = new MemoryWorkerClient(join(dir, "close.sqlite"), dir);
  await client.status();
  const inFlight = client.recordUsage({ provider: "claude", model: "m", purpose: "recall", inputTokens: 1, outputTokens: 1, ok: true });
  await client.close();
  assert.equal(client.running, false, "close() stops the worker even with a request in flight");
  await inFlight.then(
    () => undefined,
    () => undefined,
  );
  await assert.rejects(client.status(), /closed/, "a closed index takes no new work instead of starting another thread");

  const luna = new MemoryWorkerClient(join(dir, "luna-close.sqlite"), dir);
  const pidFile = join(dir, "child-pids.json");
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
  const answer = luna.luna({ command: process.execPath, args: ["-e", script], cwd: dir, env: process.env, prompt: "", timeoutMs: 60_000 }).catch(() => null);
  await until("the simulated Luna launcher and grandchild to start", () => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
  await luna.close();
  await answer;
  await until("shutdown to reap the Luna invocation tree", () => pids.every((pid) => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }));
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function boundedFallbackAndBackgroundRetries(dir: string): Promise<void> {
  let launches = 0;
  let calls = 0;
  const models = new MemoryModels({
    claudeAccount: () => undefined,
    claudeHasRoom: () => false,
    onClaudeRateLimit: () => {},
    lunaLaunch: async () => {
      launches++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { model: "gpt-6-luna", launch: { command: "unused", args: [], cwd: dir, env: {} } };
    },
    runLuna: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { text: '{"ids":[]}', inputTokens: 12, outputTokens: 2 };
    },
    recordUsage: () => {},
  });
  const request = { system: "test", user: "test", maxTokens: 10, purpose: "recall", lane: "interactive" as const, timeoutMs: 10_000 };
  await Promise.all(Array.from({ length: 5 }, () => models.complete(request)));
  assert.equal(launches, 1, "the Luna slot is reserved before asynchronous launch preparation");
  assert.equal(calls, 1, "concurrent interactive requests spawn at most one Luna process");

  seed(dir);
  const bad = fakeHaiku();
  bad.fetchImpl = (async () => Response.json({ content: [{ type: "text", text: "invalid JSON" }], usage: { input_tokens: 10, output_tokens: 1 } })) as typeof fetch;
  const memory = service(dir, { haiku: bad, settings: () => ({ ...DEFAULT_MEMORY_SETTINGS, cards: false }) });
  memory.start();
  await memory.enqueueExtraction({ source: "test", sessionId: null, text: "A durable user statement. ".repeat(30) });
  await until("an unusable answer to leave a scheduled retry", async () => {
    const state = (await memory.status()).extraction!;
    return state.state === "idle" && state.nextAttemptAt != null && state.nextAttemptAt > Date.now() + 60_000;
  });
  const queued = readdirSync(join(dir, QUEUE_DIR)).filter((f) => f.endsWith(".json"));
  assert.equal(queued.length, 1, "unusable answers preserve the queue item");
  assert.equal(JSON.parse(readFileSync(join(dir, QUEUE_DIR, queued[0]!), "utf8")).unusable, 1);
  await memory.close();

  let finish!: () => void;
  let started = false;
  let stored = 0;
  const cards = new CardBuilder({
    jobs: async () => [{ file: "note.md", hash: "hash", name: "Note", description: "Note description", triggers: [], body: "Body" }],
    store: async () => ++stored,
    enabled: () => true,
    models: { complete: async () => {
      started = true;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { text: '{"cards":[{"id":1,"queries":["alternate words"]}]}', model: HAIKU_MODEL };
    } } as unknown as InstanceType<typeof MemoryModels>,
  });
  cards.start();
  cards.poke(true);
  await until("card generation to start", () => started);
  cards.stop();
  finish();
  await until("card generation to settle after stop", () => cards.status().state === "idle");
  assert.equal(stored, 0, "a stopped builder does not write cards after its model responds");
  assert.equal(cards.status().nextAttemptAt, null, "a stopped builder schedules no more work");

  const unusable = new CardBuilder({
    jobs: async (_limit, exclude) => exclude.length ? [] : [{ file: "note.md", hash: "hash", name: "Note", description: "Note description", triggers: [], body: "Body" }],
    store: async () => 0,
    enabled: () => true,
    models: { complete: async () => ({ failure: "unusable" }) } as unknown as InstanceType<typeof MemoryModels>,
  });
  unusable.start();
  unusable.poke(true);
  await until("missing cards to get a retry after the pass", () => unusable.status().state === "idle" && (unusable.status().nextAttemptAt ?? 0) > Date.now() + 60_000);
  unusable.stop();
}

/** Every prompt recall holds its message back for a model call, so a task run recalls only for the owner's
 *  words, and a new run starts its kickoff's recall while the CLI is still booting. */
async function taskRecallWaitsOnlyForOwnerWords(): Promise<void> {
  const queries: string[] = [];
  const memory = {
    recall: async (query: string) => { queries.push(query); return { memories: [], model: null, fallbackReason: null, cached: false, ms: 0 }; },
    enqueueExtraction: async () => "queued" as const,
  };
  const kickoff = withCommunicationTurnPolicy("# Task: Kettle\n\n## Brief\nDescale the office kettle every month.\n\n## Plan\nsteps", true) as string;
  const office = withCommunicationTurnPolicy("🌐 [Online office - Alex @ Lab (implementor), working example on another machine]: pushed the parser fix", true) as string;
  const steering = acknowledgedInjection("Always write British English in replies.");
  assert.equal(promptRecallQuery(kickoff, "task"), "Descale the office kettle every month.", "a kickoff recalls on its brief");
  assert.equal(promptRecallQuery(office, "task"), "", "office chat in a task run is not the owner's words");
  assert.equal(promptRecallQuery("QA found two failing tests; fix them.", "subtask"), "", "a QA bounce is GGO's text");
  assert.equal(promptRecallQuery(`${office}\n\n${steering}`, "task"), "Always write British English in replies.", "steering recalls on the owner's message alone");
  assert.equal(promptRecallQuery("I always want the changelog updated.", "cowork"), "I always want the changelog updated.");
  assert.equal(promptRecallQuery("I always want the changelog updated."), "I always want the changelog updated.", "a prompt from outside GGO is the owner's");

  const hooks = memoryAgentHooks(memory, "unused-dir", "task");
  const prompt = (text: string) => hooks.UserPromptSubmit![0]!.hooks[0]!({ hook_event_name: "UserPromptSubmit", prompt: text, session_id: "s", transcript_path: "", cwd: "unused-cwd" } as never, undefined, { signal: AbortSignal.timeout(5_000) });
  await prompt(office);
  assert.equal(queries.length, 0, "an office push into a task run never waits on recall");
  await prompt(kickoff);
  assert.deepEqual(queries.splice(0), ["Descale the office kettle every month."]);

  prefetchMemoryRecall(hooks, [{ type: "text", text: kickoff }, { type: "image" }], "unused-cwd");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(queries.includes("Descale the office kettle every month."), "a new run prefetches its kickoff's prompt recall");
  assert.ok(queries.some((q) => q.startsWith("Working directory: unused-cwd")), "and its session recall");

  let lookups = 0;
  const recall = new MemoryRecall(async () => { lookups++; await new Promise((resolve) => setTimeout(resolve, 50)); return []; }, null, () => false);
  const [first, joined] = await Promise.all([recall.recall("kettle descaling", "prompt", 2, 5_000), recall.recall("kettle descaling", "prompt", 2, 5_000)]);
  assert.equal(lookups, 1, "the hook joins a prefetch already in flight instead of asking again");
  assert.deepEqual([first.cached, joined.cached], [false, true]);
}

async function codexInputsExtractOnlyOwnerWords(dir: string): Promise<void> {
  const queued: string[] = [];
  const memory = {
    recall: async () => ({ memories: [], model: null, fallbackReason: null, cached: false, ms: 0 }),
    enqueueExtraction: async (item: { text: string }) => { queued.push(item.text); return "queued" as const; },
  };
  const task = new OwnerInputBuffer(memory, "task");
  task.append("# Task: pipeline instructions only. ".repeat(30));
  await task.flush(null);
  assert.equal(queued.length, 0, "task kickoffs are not owner input");
  const words = "Always use British English when writing every reply to me. ".repeat(10);
  task.append(acknowledgedInjection(words));
  await task.flush("task-session");
  assert.deepEqual(queued.splice(0), [words.trim()], "task extraction keeps the actual steering only");
  const subtask = new OwnerInputBuffer(memory, "subtask");
  subtask.append(acknowledgedInjection(words));
  await subtask.flush(null);
  assert.equal(queued.length, 0, "a parent agent's subtask steering is never extracted");

  const previous = process.env.CODEX_BIN_JS;
  process.env.CODEX_BIN_JS = join(dir, "missing-codex.js");
  try {
    const runner = new CodexAgentRun({ model: "gpt-6-luna", effort: "low", apiKey: "", cwd: dir,
      memory: { service: memory, dir, run: "cowork", initialOwnerText: words } });
    runner.start(withCommunicationTurnPolicy("CO-WORK ROLE AND HISTORY ".repeat(50), false));
    await until("the Codex lifecycle to queue its owner input", () => queued.length > 0);
    assert.deepEqual(queued, [words.trim()], "Codex queues the original owner message, excluding its role prompt and history");
    await runner.stop();
    assert.equal(queued.length, 1, "stop does not queue the same completed batch twice");
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN_JS;
    else process.env.CODEX_BIN_JS = previous;
  }
}

try {
  await boundedFallbackAndBackgroundRetries(join(root, "qa-retries"));
  await taskRecallWaitsOnlyForOwnerWords();
  await codexInputsExtractOnlyOwnerWords(join(root, "codex-inputs"));
  {
    const repo = join(root, "maps-repo");
    const other = join(root, "other-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "agent_docs", "maps"), { recursive: true });
    writeFileSync(join(repo, "agent_docs", "maps", "calendar.md"), "---\nsubsystem: Calendar scheduler\nlast_verified: 2026-01-02\n---\nCalendar scheduler scheduling calendar jobs.");
    assert.match(await repoMapContext(join(repo, "src")), /Calendar scheduler/);
    assert.match(await repoMapContext(repo, "calendar scheduler"), /agent_docs\/maps\/calendar.md/);
    assert.equal(await repoMapContext(repo, "lunch salad soup"), "", "an unrelated prompt does not match a repo map");
    assert.equal(await repoMapContext(other, "calendar scheduler"), "", "map recall cannot cross repository boundaries");
    const unavailable = { recall: async () => { throw new Error("memory unavailable"); }, enqueueExtraction: async () => "unavailable" as const };
    const hooks = memoryAgentHooks(unavailable, root, "task");
    const out = await hooks.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", session_id: "s", transcript_path: "", cwd: join(repo, "src") } as never, undefined, { signal: AbortSignal.timeout(5000) });
    assert.match(JSON.stringify(out), /Calendar scheduler/, "native SDK recall preserves repo maps even if memory is unavailable");
  }
  {
    const dir = join(root, "unavailable-corpus");
    seed(dir);
    const store = new MemoryIndexStore(join(root, "corpus-preservation.sqlite"), dir);
    store.sync();
    const job = store.cardJobs(1)[0]!;
    store.storeCards([{ file: job.file, hash: job.hash, text: "alternate search words", model: HAIKU_MODEL }]);
    const initial = store.status();
    renameSync(dir, `${dir}-unavailable`);
    try {
      assert.throws(() => store.sync(), /ENOENT/, "a failed directory read is reported, never treated as deletion");
      assert.equal(store.status().files, initial.files, "an unavailable corpus keeps its indexed files");
      assert.equal(store.status().cards, initial.cards, "an unavailable corpus keeps its retrieval cards");
    } finally {
      renameSync(`${dir}-unavailable`, dir);
      store.close();
    }
  }
  // ---- lexical: no model access at all ----
  {
    const dir = join(root, "lexical");
    seed(dir);
    const memory = service(dir);
    const hits = await memory.search("how do I ship a server change", 3);
    assert.equal(hits[0]?.file, "reference_deploy.md", "lexical search ranks the deploy memory first");
    assert.equal(hits[0]?.judgedBy, "lexical");
    const offTopic = await memory.recall("what is the weather forecast for tomorrow", "prompt", 2, 5_000);
    assert.deepEqual(offTopic.memories, [], "an off-topic prompt injects nothing without a model");
    assert.equal(offTopic.fallbackReason, null, "nothing matched, so there was nothing to judge");
    const trigger = await memory.recall("there is limescale everywhere", "prompt", 2, 5_000);
    assert.equal(trigger.memories[0]?.file, "feedback_kettle.md", "a declared trigger phrase is recalled even with low coverage");
    assert.equal(trigger.memories[0]?.triggerHit, true, "a single-word trigger is a declared match too");
    assert.equal(trigger.fallbackReason, "model ranking is turned off");

    assert.match((await memory.read("Descale the office kettle monthly")) ?? "", /citric acid/, "read accepts the frontmatter name");
    assert.match((await memory.read("feedback_kettle")) ?? "", /citric acid/, "read accepts the file name without .md");
    assert.equal(await memory.read("../../etc/passwd"), null, "read never leaves the memory directory");

    const file = await memory.create({ type: "reference", name: "Status page lives on example.com", description: "Where the public status page is hosted", body: "https://status.example.com" });
    assert.equal(file, "reference_status_page_lives_on_example_com.md");
    assert.match(readFileSync(join(dir, "MEMORY.md"), "utf8"), /reference_status_page_lives_on_example_com\.md/, "a new memory gets an index pointer");
    assert.equal((await memory.list(0, 50, "")).total, 5, "the index sees the new file");
    assert.equal(await memory.update(file, { body: "https://status.example.com/v2" }), true);
    assert.match(readFileSync(join(dir, file), "utf8"), /status\.example\.com\/v2[\s\S]*$/);
    assert.match(readFileSync(join(dir, file), "utf8"), /last_verified: \d{4}-\d{2}-\d{2}/);
    assert.ok(await memory.remove("reference_deploy.md"), "remove moves the file");
    assert.ok(existsSync(join(dir, TRASH_DIR)) && readdirSync(join(dir, TRASH_DIR)).some((f) => f.endsWith("_reference_deploy.md")), "removed memories land in the trash");
    assert.doesNotMatch(readFileSync(join(dir, "MEMORY.md"), "utf8"), /reference_deploy\.md/, "its index pointer goes too");
    assert.doesNotMatch(readFileSync(join(dir, "user_stack.md"), "utf8"), /reference_deploy\.md/, "and so do related: links to it");
    assert.equal((await memory.list(0, 50, "")).total, 4);

    writeFileSync(join(dir, "feedback_external.md"), "---\nname: Written by another tool\ndescription: A memory written outside GGO\nmetadata:\n  type: feedback\n---\n\nPrefer tabs in makefiles.\n");
    memory.changed();
    await until("an externally written memory to be indexed", async () => (await memory.search("makefiles tabs", 1))[0]?.file === "feedback_external.md");

    // The whole of a long memory is searchable, not a prefix: the defect the retired pgvector chunker
    // shipped (28.5% of the corpus sat past its embedded prefix, 2026-08-17).
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about routine maintenance of the build farm and its many machines.`);
    const longText = (tail: string) => `---\nname: Build farm maintenance log\ndescription: Long running notes on the build farm\nmetadata:\n  type: reference\n---\n\n${paragraphs.join("\n\n")}\n\n${tail}\n`;
    writeFileSync(join(dir, "reference_build_farm.md"), longText("The last entry mentions the quokka rack."));
    memory.changed();
    await until("a word at the end of a long memory to be found", async () => (await memory.search("quokka rack", 1))[0]?.file === "reference_build_farm.md");
    writeFileSync(join(dir, "reference_build_farm.md"), longText("The last entry mentions the quokka rack.\n\nAn appended note about the narwhal switch."));
    memory.changed();
    await until("text appended to a long memory to be found", async () => (await memory.search("narwhal switch", 1))[0]?.file === "reference_build_farm.md");
    const chunks = memoryChunks(parseMemory("reference_build_farm.md", longText("tail")), 1600);
    assert.ok(chunks.length > 2, "a long memory splits into several chunks");
    assert.ok(chunks.every((c) => c.text.length <= 1600), "no chunk exceeds the budget");
    assert.ok(chunks.slice(1).every((c) => c.text.startsWith("Build farm maintenance log")), "every body chunk carries the memory's name");
    assert.equal(memoryChunks(parseMemory("short.md", "---\nname: Short\ndescription: d\n---\n\nOne line.\n")).length, 2, "a short memory stays one head and one body chunk");
    // Either end of the local day falls on a different UTC date on a box east or west of UTC.
    assert.equal(today(new Date(2026, 9, 5, 0, 30)), "2026-10-05", "created_at/last_verified use the local date just after midnight");
    assert.equal(today(new Date(2026, 9, 5, 23, 30)), "2026-10-05", "created_at/last_verified use the local date just before midnight");
    await corpusEditsKeepTheOwnersLayouts(join(root, "layouts"));
    await closeStopsTheWorkerWithWorkInFlight(join(root, "close"));
    unlinkSync(join(dir, "reference_build_farm.md"));
    memory.changed();

    const status = await memory.status();
    assert.equal(status.index.files, 5);
    assert.equal(status.providers, null, "no model access is reported as such");
    await memory.close();
  }

  // ---- Haiku judges relevance; a capped account hands over to the next ----
  {
    const dir = join(root, "haiku");
    seed(dir);
    const haiku = fakeHaiku({ rejectAccounts: ["acct-capped"] });
    const rateLimits: string[] = [];
    const memory = service(dir, { haiku, accounts: ["acct-capped", "acct-b"], rateLimits });
    const result = await memory.recall("the water boiler in the office kitchen tastes chalky", "prompt", 2, 10_000);
    assert.equal(result.model, HAIKU_MODEL);
    assert.deepEqual(result.memories.map((m) => m.file), ["feedback_kettle.md"], "the model picks the paraphrased memory and nothing else");
    assert.equal(result.memories[0]!.judgedBy, "model");
    assert.deepEqual(haiku.calls.map((c) => c.account), ["acct-capped", "acct-b"], "the capped account is skipped for the next one");
    assert.deepEqual(rateLimits, ["acct-capped"], "a rejected 5h window is reported to the account manager");
    const again = await memory.recall("the water boiler in the office kitchen tastes chalky", "prompt", 2, 10_000);
    assert.equal(again.cached, true, "a repeated prompt is served from the recall cache");
    assert.equal(haiku.calls.length, 2, "the cache spares a second model call");
    const usage = (await memory.status()).index.usageToday;
    assert.ok(usage.some((u) => u.provider === "claude" && u.purpose === "recall" && u.calls >= 1), "model calls land in the usage ledger");

    // Native agent hooks give a Claude-based run the same recall.
    const hooks = memoryAgentHooks(memory, dir, "task", new ExtractionOffsets(join(root, "offsets.json")));
    const hook = hooks.UserPromptSubmit![0]!.hooks[0]!;
    const out = (await hook({ hook_event_name: "UserPromptSubmit", prompt: "## Brief\nthe office kettle needs descaling, chalky taste\n## Plan\nunrelated", session_id: "s", transcript_path: "", cwd: dir } as never, undefined, { signal: AbortSignal.timeout(5_000) })) as { hookSpecificOutput?: { additionalContext?: string } };
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /Descale the office kettle monthly/);
    unlinkSync(join(dir, "feedback_kettle.md"));
    await until("external deletion to invalidate a cached recall", async () => !(await memory.recall("the water boiler in the office kitchen tastes chalky", "prompt", 2, 10_000)).memories.some((m) => m.file === "feedback_kettle.md"));
    await memory.close();
  }

  // ---- no capacity anywhere: recall degrades honestly, queued work stays on disk ----
  {
    const dir = join(root, "capped");
    seed(dir);
    const haiku = fakeHaiku();
    const memory = service(dir, { haiku, accounts: [] });
    const result = await memory.recall("there is limescale everywhere", "prompt", 2, 10_000);
    assert.equal(result.model, null);
    assert.equal(result.fallbackReason, "no Haiku or Luna capacity");
    assert.equal(result.memories[0]?.file, "feedback_kettle.md", "the lexical fallback still answers");
    memory.start();
    assert.equal(await memory.enqueueExtraction({ source: "test", sessionId: null, text: "too short" }), "too-short");
    assert.equal(await memory.enqueueExtraction({ source: "test", sessionId: "s1", text: `${"filler words about the build. ".repeat(20)}always write British English in replies` }), "queued");
    await until("the extraction queue to wait for capacity", async () => (await memory.status()).extraction?.state === "waiting-for-capacity");
    assert.equal(readdirSync(join(dir, QUEUE_DIR)).filter((f) => f.endsWith(".json")).length, 1, "the queued item is kept while no model has room");
    assert.equal(haiku.calls.length, 0);
    const providers = (await memory.status()).providers!;
    assert.equal(providers.haiku.available, false);
    assert.equal(providers.luna.detail, "Luna is not used by this test");
    await memory.close();

    const picks: string[] = [];
    const watched = service(dir, { haiku, picks });
    assert.equal((await watched.status()).providers!.haiku.available, true);
    assert.deepEqual(picks, [], "reading status never picks an account, so polling it cannot start a held subscription's window");
    await watched.close();
  }

  // ---- extraction writes only quoted, non-duplicate candidates ----
  {
    const dir = join(root, "extract");
    seed(dir);
    const memory = service(dir, { haiku: fakeHaiku() });
    mkdirSync(join(dir, QUEUE_DIR), { recursive: true });
    writeFileSync(join(dir, QUEUE_DIR, "0000-foreign.json"), JSON.stringify({ version: 1, source: "pre-compact", transcriptText: "another tool's shape" }));
    memory.start();
    await memory.enqueueExtraction({ source: "test", sessionId: "s2", text: `${"we talked about the build pipeline at length. ".repeat(12)}Please always write British English in replies from now on.` });
    await until("the extraction queue to drain", async () => readdirSync(join(dir, QUEUE_DIR)).filter((f) => f.endsWith(".json")).length === 0);
    assert.ok(readdirSync(join(dir, QUEUE_DIR, "failed")).some((f) => f.includes("0000-foreign")), "a file without queue-item text is set aside, never sent to a model");
    const written = readdirSync(dir).filter((f) => f.startsWith("feedback_answer_in_british"));
    assert.equal(written.length, 1, "the quoted candidate is written");
    const text = readFileSync(join(dir, written[0]!), "utf8");
    assert.match(text, /source: auto-extracted/);
    assert.match(text, /source_session: s2/);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith("feedback_invented_rule")), "a candidate whose quote is not in the text is rejected");
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    assert.ok(index.includes(REVIEW_SECTION) && index.includes(written[0]!), "auto-extracted memories are listed for review");
    const log = readFileSync(join(dir, "extraction-log.md"), "utf8");
    assert.match(log, /added `feedback_answer_in_british/);
    assert.match(log, /evidence-quote-not-in-transcript/);
    await memory.close();
  }

  // ---- a queued GGO agent transcript contributes only the owner's steering ----
  {
    const dir = join(root, "extract-ggo");
    seed(dir);
    const haiku = fakeHaiku();
    const memory = service(dir, { haiku });
    const kickoff = `# Task: Polish the release notes\n\n## Brief\nPlease always write British English in replies to the release channel.\n${"Process prose shared by every task. ".repeat(15)}`;
    mkdirSync(join(dir, QUEUE_DIR), { recursive: true });
    const queued = (name: string, text: string) =>
      writeFileSync(join(dir, QUEUE_DIR, name), JSON.stringify({ version: 1, source: "claude-code", sessionId: name, text, createdAt: new Date().toISOString() }));
    queued("0001-kickoff-only.json", withCommunicationTurnPolicy(kickoff, false) as string);
    queued("0002-steered.json", `${withCommunicationTurnPolicy(kickoff, false) as string}\n\n${acknowledgedInjection("Please always write British English in replies from now on.")}`);
    memory.start();
    memory.settingsChanged();
    await until("the GGO transcripts to drain", async () => readdirSync(join(dir, QUEUE_DIR)).filter((f) => f.endsWith(".json")).length === 0);
    const extractorCalls = haiku.calls.filter((c) => c.system.includes("strict memory extractor"));
    assert.equal(extractorCalls.length, 1, "a GGO transcript without steering never reaches a model");
    assert.ok(!extractorCalls[0]!.user.includes("Process prose shared by every task"), "the extractor sees the steering, not GGO's kickoff");
    const written = readdirSync(dir).filter((f) => f.startsWith("feedback_answer_in_british"));
    assert.equal(written.length, 1, "the owner's steered rule is still extracted");
    assert.match(readFileSync(join(dir, written[0]!), "utf8"), /source_session: 0002-steered\.json/);
    assert.match(readFileSync(join(dir, "extraction-log.md"), "utf8"), /0001-kickoff-only\.json[\s\S]*no owner words/, "the discarded transcript is logged");
    await memory.close();
  }

  // ---- retrieval cards make a memory findable by words it never uses ----
  {
    const dir = join(root, "cards");
    seed(dir);
    const memory = service(dir, { haiku: fakeHaiku() });
    assert.deepEqual(await memory.search("zeppelin", 3), [], "before cards nothing mentions zeppelin");
    memory.start();
    memory.changed();
    await until("cards for every memory", async () => (await memory.status()).index.cards === 4);
    const hits = await memory.search("zeppelin", 3);
    assert.equal(hits[0]?.file, "feedback_kettle.md", "the card's keyword finds the memory");
    await memory.close();
  }

  // ---- settings switch the model stage off ----
  {
    const dir = join(root, "settings");
    seed(dir);
    const haiku = fakeHaiku();
    let settings: MemorySettings = { ...DEFAULT_MEMORY_SETTINGS, modelRanking: false, agentRecall: false };
    const memory = service(dir, { haiku, settings: () => settings });
    const result = await memory.recall("the water boiler tastes chalky", "prompt", 2, 5_000);
    assert.equal(result.fallbackReason, "model ranking is turned off");
    assert.equal(haiku.calls.length, 0);
    assert.equal(memory.agentHooks("task"), undefined, "agent recall off means no hooks");
    assert.equal(memory.codexMemory(), undefined, "and no Codex prompt prefix");
    settings = { ...settings, agentRecall: true };
    assert.ok(memory.agentHooks("task")?.UserPromptSubmit);
    assert.equal(memory.codexMemory()?.dir, dir);
    await memory.close();

    const kv = new Map<string, string>();
    const store = new MemorySettingsStore({ get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) });
    assert.deepEqual(store.get(), DEFAULT_MEMORY_SETTINGS);
    kv.set("memory_settings", JSON.stringify({ cards: false, bogus: 1, extraction: "no" }));
    const fresh = new MemorySettingsStore({ get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) });
    assert.deepEqual(fresh.get(), { ...DEFAULT_MEMORY_SETTINGS, cards: false }, "malformed fields fall back to defaults one by one");
    assert.equal(fresh.update({ lunaFallback: false }).lunaFallback, false);
    assert.equal(JSON.parse(kv.get("memory_settings")!).lunaFallback, false);
  }

  // ---- hook helpers ----
  assert.equal(stripTaskEnvelope("## Context\nprocess prose\n## Brief\nFix the kettle timer\n## Plan\nsteps"), "Fix the kettle timer");
  assert.equal(stripTaskEnvelope("plain prompt"), "plain prompt");
  {
    let finish!: () => void;
    const recaller = new MemoryRecall(async () => [{ file: "note.md", name: "Note", description: "Description", excerpt: "", triggerHit: false }] as never, { complete: async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { text: '{"ids":[1]}', model: HAIKU_MODEL };
    } } as unknown as InstanceType<typeof MemoryModels>, () => true);
    const first = recaller.recall("query", "search", 1, 10_000);
    await until("recall judgement to start", () => !!finish);
    recaller.clearCache();
    finish();
    await first;
    finish = undefined as unknown as () => void;
    const second = recaller.recall("query", "search", 1, 10_000);
    await until("the new judgement to start", () => !!finish);
    finish();
    assert.equal((await second).cached, false, "an old model answer cannot repopulate an invalidated cache");
  }
  assert.equal(
    userText([
      JSON.stringify({ type: "user", message: { role: "user", content: "first owner line" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "agent reply" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "second owner line" }, { type: "tool_result", content: "x" }] } }),
      JSON.stringify({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued from a previous conversation. No Co-Authored-By trailer." } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Stop hook feedback: work is not saved" }] } }),
      "not json",
    ]),
    "first owner line\n\nsecond owner line",
    "a compaction summary and hook feedback are written by the harness, not the owner",
  );
  await extractionReadsOnlyTheOwnersWords(join(root, "owner-words"));
  assert.equal(isPrimaryMemoryOwner({}, ["node", "dist/index.js"]), true);
  assert.equal(isPrimaryMemoryOwner({}), false, "a test run never owns the memory directory");
  assert.equal(isPrimaryMemoryOwner({ DATA_DIR: "/tmp/lab" }, ["node", "dist/index.js"]), false, "a lab with its own data dir never owns the memory directory");
  assert.equal(isPrimaryMemoryOwner({ DATA_DIR: "/tmp/custom", MEMORY_PRIMARY: "1" }, ["node", "dist/index.js"]), true, "a primary deployment can explicitly own memory with custom storage");
  assert.equal(isPrimaryMemoryOwner({ DATA_DIR: "/tmp/lab", MEMORY_PRIMARY: "1", GGO_MEMORY_ISOLATED: "1" }, ["node", "dist/index.js"]), false, "an isolated lab cannot inherit primary memory ownership");

  // ---- HTTP: console routes need the session, hook routes need the token on direct loopback ----
  {
    const dir = join(root, "http");
    seed(dir);
    const memory = service(dir);
    const kv = new Map<string, string>();
    const settings = new MemorySettingsStore({ get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) });
    const endpoint = new MemoryEndpoint(dir);
    const freshEndpoint = new MemoryEndpoint(join(root, "new-install", "memory"));
    await freshEndpoint.publish("127.0.0.1", 4317);
    assert.ok(existsSync(join(root, "new-install", "memory", ".ggo-memory-endpoint.json")), "first boot creates the memory folder before publishing the handshake");
    const app = Fastify();
    registerMemoryRoutes(app, { memory, settings, endpoint, isAuthed: (cookie) => cookie === "session=ok" });
    await app.ready();
    const authed = { cookie: "session=ok" };
    assert.equal((await app.inject({ method: "GET", url: "/api/memory/status" })).statusCode, 401);
    const status = await app.inject({ method: "GET", url: "/api/memory/status", headers: authed });
    assert.equal(status.json().index.files, 4);
    const created = await app.inject({ method: "POST", url: "/api/memory/files", headers: authed, payload: { type: "user", name: "Prefers dark editor themes", description: "Editor appearance preference for the owner", body: "Dark themes everywhere." } });
    assert.equal(created.json().file, "user_prefers_dark_editor_themes.md");
    const got = await app.inject({ method: "GET", url: "/api/memory/files/user_prefers_dark_editor_themes.md", headers: authed });
    assert.match(got.json().text, /Dark themes everywhere/);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/memory/files/nope.md", headers: authed, payload: { body: "a body that is long enough" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/memory/files", headers: authed, payload: { type: "nonsense" } })).statusCode, 400);
    const search = await app.inject({ method: "POST", url: "/api/memory/search", headers: authed, payload: { query: "dark editor theme" } });
    assert.equal(search.json().memories[0].file, "user_prefers_dark_editor_themes.md");
    const removed = await app.inject({ method: "DELETE", url: "/api/memory/files/user_prefers_dark_editor_themes.md", headers: authed });
    assert.match(removed.json().trashedAs, /_user_prefers_dark_editor_themes.md$/);
    assert.equal((await app.inject({ method: "PUT", url: "/api/memory/settings", headers: authed, payload: { cards: false } })).json().cards, false);
    assert.equal((await app.inject({ method: "GET", url: "/api/memory/files", headers: { ...authed, "sec-fetch-site": "cross-site" } })).statusCode, 403, "cross-site console requests are refused");

    const hookPayload = { mode: "prompt", prompt: "limescale in the kettle again" };
    assert.equal((await app.inject({ method: "POST", url: "/api/memory/hook/recall", payload: hookPayload, headers: authed })).statusCode, 401, "the session cookie does not open hook routes");
    assert.equal((await app.inject({ method: "POST", url: "/api/memory/hook/recall", payload: hookPayload, headers: { authorization: "Bearer wrong" } })).statusCode, 401);
    const hook = await app.inject({ method: "POST", url: "/api/memory/hook/recall", payload: hookPayload, headers: { authorization: `Bearer ${endpoint.token}` } });
    assert.match(hook.json().context, /Descale the office kettle monthly/);
    const hookStatus = await app.inject({ method: "GET", url: "/api/memory/hook/status", headers: { authorization: `Bearer ${endpoint.token}` } });
    assert.equal(hookStatus.json().index.files, 4, "the hook scripts' `rag.py status` reads the live index");
    const hookSearch = await app.inject({ method: "POST", url: "/api/memory/hook/search", payload: { query: "kettle limescale" }, headers: { authorization: `Bearer ${endpoint.token}` } });
    assert.ok(hookSearch.json().hits[0].lastVerified, "search hits carry last_verified for `rag.py retrieve --json`");
    const asPrompt = await app.inject({ method: "POST", url: "/api/memory/hook/search", payload: { query: "limescale everywhere", k: 2, mode: "prompt" }, headers: { authorization: `Bearer ${endpoint.token}` } });
    assert.equal(asPrompt.json().hits[0].file, "feedback_kettle.md", "prompt-mode search answers what the prompt hook injects (the trigger audit uses it)");
    const forgot = await app.inject({ method: "POST", url: "/api/memory/hook/forget", payload: { file: "feedback_kettle.md" }, headers: { authorization: `Bearer ${endpoint.token}` } });
    assert.match(forgot.json().trashedAs, /_feedback_kettle\.md$/, "`rag.py forget` moves the memory to the trash");
    assert.equal((await app.inject({ method: "POST", url: "/api/memory/hook/forget", payload: { file: "../outside.md" }, headers: { authorization: `Bearer ${endpoint.token}` } })).statusCode, 404);
    const extracted = await app.inject({ method: "POST", url: "/api/memory/hook/extract", payload: { source: "claude-code", text: "short" }, headers: { authorization: `Bearer ${endpoint.token}` } });
    assert.equal(extracted.json().outcome, "unavailable", "without model access extraction is reported unavailable, not silently dropped");
    await endpoint.publish("0.0.0.0", 4317);
    const published = JSON.parse(readFileSync(join(dir, ".ggo-memory-endpoint.json"), "utf8"));
    assert.equal(published.url, "http://127.0.0.1:4317");
    assert.equal(published.token, endpoint.token);
    await app.close();
    await memory.close();
  }
  console.log("memory RAG gate: ok");
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A failed assertion can leave a worker holding its index open; the temp dir is harmless.
  }
}
