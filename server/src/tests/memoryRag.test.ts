/** Gate for GGO's memory: Markdown files as the source of truth, the worker-owned FTS index, Haiku
 *  relevance judgement with account fallback, honest no-capacity behaviour (lexical recall, queued work
 *  kept on disk), retrieval cards, automatic extraction, the agent hooks and the HTTP surface. Haiku is a
 *  fake fetch and Luna is reported unavailable, so no provider is called. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ggo-memory-rag-"));
process.env.DATA_DIR = join(root, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });

const { FileMemoryService, DEFAULT_MEMORY_SETTINGS } = await import("../memory/memory.js");
const { HAIKU_MODEL } = await import("../memory/models.js");
const { QUEUE_DIR } = await import("../memory/extraction.js");
const { TRASH_DIR, REVIEW_SECTION } = await import("../memory/corpus.js");
const { memoryAgentHooks, stripTaskEnvelope, userText, ExtractionOffsets } = await import("../memory/agentHooks.js");
const { MemorySettingsStore } = await import("../memory/settings.js");
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

function service(dir: string, opts: { haiku?: FakeHaiku; accounts?: string[]; settings?: () => MemorySettings; rateLimits?: string[] } = {}): Service {
  const accounts = opts.accounts ?? ["acct-a"];
  return new FileMemoryService(dir, {
    indexPath: join(root, `${Math.random().toString(36).slice(2)}.sqlite`),
    settings: opts.settings,
    ownerName: () => "Alex",
    models: opts.haiku
      ? {
          claudeAccount: (excluded) => {
            const id = accounts.find((a) => !excluded.includes(a));
            return id ? { id, token: id } : undefined;
          },
          onClaudeRateLimit: (id) => opts.rateLimits?.push(id),
          lunaLaunch: UNAVAILABLE_LUNA,
          fetchImpl: opts.haiku.fetchImpl,
        }
      : undefined,
  });
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${label}`);
}

try {
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
    const hooks = memoryAgentHooks(memory, dir, new ExtractionOffsets(join(root, "offsets.json")));
    const hook = hooks.UserPromptSubmit![0]!.hooks[0]!;
    const out = (await hook({ hook_event_name: "UserPromptSubmit", prompt: "## Brief\nthe office kettle needs descaling, chalky taste\n## Plan\nunrelated", session_id: "s", transcript_path: "", cwd: dir } as never, undefined, { signal: AbortSignal.timeout(5_000) })) as { hookSpecificOutput?: { additionalContext?: string } };
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /Descale the office kettle monthly/);
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
    assert.equal(memory.agentHooks(), undefined, "agent recall off means no hooks");
    assert.equal(memory.codexMemory(), undefined, "and no Codex prompt prefix");
    settings = { ...settings, agentRecall: true };
    assert.ok(memory.agentHooks()?.UserPromptSubmit);
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
  assert.equal(
    userText([
      JSON.stringify({ type: "user", message: { role: "user", content: "first owner line" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "agent reply" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "second owner line" }, { type: "tool_result", content: "x" }] } }),
      "not json",
    ]),
    "first owner line\n\nsecond owner line",
  );
  assert.equal(isPrimaryMemoryOwner({}, ["node", "dist/index.js"]), true);
  assert.equal(isPrimaryMemoryOwner({}), false, "a test run never owns the memory directory");
  assert.equal(isPrimaryMemoryOwner({ DATA_DIR: "/tmp/lab" }, ["node", "dist/index.js"]), false, "a lab with its own data dir never owns the memory directory");

  // ---- HTTP: console routes need the session, hook routes need the token on direct loopback ----
  {
    const dir = join(root, "http");
    seed(dir);
    const memory = service(dir);
    const kv = new Map<string, string>();
    const settings = new MemorySettingsStore({ get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) });
    const endpoint = new MemoryEndpoint(dir);
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
