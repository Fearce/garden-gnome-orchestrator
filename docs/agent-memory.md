# Agent memory

GGO serves the owner's long-term agent memory: the Markdown files in `MEMORY_DIR`
(default `~/.claude/memory/`) that Claude Code, Codex, Grok Build and GGO's own agents
share. It indexes them, recalls the relevant ones for a prompt or a working directory,
writes retrieval cards, and extracts new memories from transcripts. It needs no local
model, no Docker and no database server, so it runs on an ordinary PC.

Code: `server/src/memory/`. Settings and UI: **Settings → Memory**
(`web/src/components/MemorySettings.tsx`). Gate: `npm run test:memory-rag --prefix server`.
Browser lab: `npm run memory-lab --prefix server` drives the page against a throwaway instance with its
own `DATA_DIR` and a seeded temp `MEMORY_DIR`, with model ranking switched off so it spends no model call.

## How recall works

1. **The files are the truth.** Every memory is a Markdown file with `name:`,
   `description:` and optional `triggers:`, `tags:`, `related:`, `created_at:` and
   `last_verified:` frontmatter. `MEMORY.md` is the human index. GGO never keeps a copy
   that could disagree with the files.
2. **A derived index in a worker thread.** `memoryWorker.ts` owns a SQLite FTS5 index
   (porter + unicode61) at `server/data/memory-index.sqlite`. The thread starts on the
   first request, re-reads changed files before it answers (a directory watcher marks the
   index dirty; without one it re-scans at most once a minute), and exits after 180 s idle.
   Nothing heavy runs on the server's event loop, and an idle GGO holds no index in memory.
   Each memory is indexed as a head chunk (name, description, triggers, tags) plus body
   slices on paragraph boundaries that each repeat the name and description, so a section
   deep in a long file still carries its topic.
3. **A model judges the shortlist.** The keyword stage proposes up to 16 candidates (24
   for a search) and Claude Haiku (`claude-haiku-4-5-20251001`) picks the ones that
   actually answer the request, or none. The "none" answer is what keeps off-topic prompts
   free of injected memories. Modes and their slot counts:

   | Mode | Used by | Slots |
   | --- | --- | --- |
   | `prompt` | the UserPromptSubmit hook, GGO's agents per prompt | 2 |
   | `session` | the SessionStart hook, GGO's agents at start | 4 |
   | `search` | the Settings search box, `rag.py retrieve`, the director's `search_memory` | up to 15 |

   A prompt that matches a memory's declared `triggers:` phrase gets that memory a
   guaranteed slot.
4. **Fallbacks are bounded.** Haiku is tried on up to three Claude subscriptions that have
   room. Then OpenAI Luna runs through the installed Codex CLI on the ChatGPT plan (one at a
   time, and only with at least 8 s of the call's budget left). Then plain keyword ranking,
   which for `prompt`/`session` also requires half the query's terms to match before it
   injects anything.
5. **Retrieval cards cover paraphrase.** In the background, Haiku (or Luna) writes each
   memory a card of five likely questions and ten alternative keywords. Cards are indexed
   beside the text, keyed to the file's content hash, and rebuilt after an edit, so even
   the keyword fallback finds a memory by words it never uses. Card building runs one batch
   at a time, starts 90 s after boot, pauses while no subscription has room, and stops
   completely once every memory has a current card.

No subscription GGO uses exposes an embeddings endpoint (checked 2026-10-04: Anthropic's
OAuth tier has none, OpenAI's needs a paid API key), so memory uses these models as readers
rather than as an embedding source.

## Capacity and accounting

Memory's model calls ride the subscriptions agents use and the same capacity rules:

- Haiku takes `AccountManager.auxAccount`, which skips disabled, capped or near-limit Claude
  subscriptions. Its rate-limit headers feed the same usage tracking as agent runs.
- Luna runs only when Codex is enabled under Settings → Subscriptions and the memory
  setting "Luna fallback" is on.
- Two lanes bound concurrency: interactive (recall and search, 4 at a time) and background
  (cards and extraction, 1 at a time). A full lane falls back instead of queueing.
- Every call is logged with its purpose (`recall`, `search`, `cards`, `extract`), provider,
  model and tokens. Settings → Memory shows today's and the last 7 days' totals.

## Hook API for user-level tools

Claude Code, Codex and Grok Build run user-level hook scripts outside GGO
(`~/.claude/memory/scripts/rag.py` and `extractor.py`). They reach GGO through a handshake
file GGO writes into the memory directory at boot, `.ggo-memory-endpoint.json`, holding the
loopback URL, a per-boot token and the PID. Only the primary instance writes it: a lab or a
test run with its own `DATA_DIR` neither redirects the hooks to itself nor drains the shared
extraction queue.

The routes live under `/api/memory/hook/`. They accept only direct loopback requests (never
the relay or a proxy) carrying `Authorization: Bearer <token>`:

| Route | Body | Answer |
| --- | --- | --- |
| `POST recall` | `{mode:"prompt", prompt}` or `{mode:"session", cwd}`, optional `timeoutMs` 1000–15000 | the context block the hook injects |
| `POST search` | `{query, k ≤ 15, mode?}` | `{hits}` with file, name, description, `lastVerified`, score, `judgedBy` |
| `POST extract` | `{text, source, sessionId?}` | queues transcript text for extraction |
| `POST forget` | `{file}` | moves the memory to `.ggo-trash/`, removes its `MEMORY.md` pointer and `related:` links |
| `POST changed` | `{}` | marks the index dirty |
| `GET status` | | index size, card progress, provider state, extraction queue |

The hook scripts keep each call inside the host's 15 s hook timeout: GGO is given 7 s to
recall, the HTTP read waits 8.5 s, and the script's own watchdog stops at 10 s. When the
endpoint file is missing or GGO does not answer, the recall hooks fall back to a local BM25
keyword match over the files and say so in the injected block. The extractor writes its item
straight into the queue directory instead.

Inside GGO's own runs the hooks stand down (`GGO_MEMORY_NATIVE=1`) because GGO injects
recall itself: SDK hooks for Claude and z.ai runs, a prompt prefix for Codex runs.

## Extraction

`extraction.ts` drains `.ggo-extraction-queue/*.json` (`{version:1, source, sessionId?,
createdAt, text}`) on the background lane. For each item Haiku (Luna fallback) proposes at
most two durable facts. Each must quote the owner verbatim, and the quote is checked against
the text. Confidence must be at least 0.70. A second call then skips any proposal that an
existing memory already states. Survivors are written as new files tagged
`source: auto-extracted`, listed under MEMORY.md's "Auto-extracted (review pending)"
section, and every decision is appended to `extraction-log.md`.

An item that gets an unusable answer three times, or a file that is not a version-1 queue
item, is moved to `failed/` (with the reason in the log) rather than retried forever. While no subscription has room the
queue simply waits.

## Settings → Memory

The page shows index size, card progress, provider availability, the extraction queue and
token use. It has five toggles, all on by default: model ranking, retrieval cards,
automatic extraction, Luna fallback, and native recall for GGO's agents. Turning a toggle
off degrades that piece to its keyword-only or idle form; nothing else changes. The page
also searches memories and creates, edits and deletes them. Deletes go to `.ggo-trash/`,
and edits keep unknown frontmatter fields intact.

## Setting up on a new PC

1. Run GGO. Memory works with whatever Claude subscription GGO already uses. Enable Codex
   if you want the Luna fallback.
2. Point `MEMORY_DIR` in `server/.env` at your memory folder if it is not
   `~/.claude/memory/`. An empty or missing folder is fine; Settings → Memory can create
   the first memory.
3. For Claude Code, Codex or Grok Build outside GGO, install the user-level hook scripts
   (the owner's setup repo does this with a bootstrap script) and register them as
   SessionStart, UserPromptSubmit and PreCompact/SessionEnd hooks. They find GGO through
   the endpoint file; no other configuration exists.

## Migrating from the Ollama + pgvector setup

Before 2026-10-05 the same files were embedded with Ollama's `nomic-embed-text` into a
pgvector table, and a local `gemma4` model ran extraction. Moving to GGO is lossless by
construction, because the Markdown files were always the source of truth:

- GGO builds its index from the files on first use. Retrieval cards then build in the
  background over the following hours, as subscription room allows.
- The old pgvector database can stay as a read-only archive. Nothing reads or writes it.
  Delete it only once you no longer want it for comparison.
- The old hook scripts are replaced by thin GGO clients. Their previous versions stay in the
  setup repo's history if a rollback is ever needed.
- Ollama can be stopped and removed from autostart once no other project needs it.

Measured on the owner's corpus of about 1,300 memories, against a held-out eval of
paraphrased requests, with the same queries for both:

| | R@1 | R@2 | MRR | Off-topic prompts that injected something |
| --- | --- | --- | --- | --- |
| pgvector + nomic-embed (before) | 0.519 | 0.644 | 0.630 | 2 / 25 |
| GGO keyword + Haiku judge (prompt mode) | 0.875 | 0.919 | 0.897 | 1 / 25 |

## Recovery

- **A memory deleted by mistake:** move it back from `.ggo-trash/`, dropping the timestamp
  prefix from its file name, then restore its `MEMORY.md` pointer.
- **A corrupt or suspicious index:** stop GGO, delete `server/data/memory-index.sqlite`,
  and start GGO again. The index rebuilds from the files and the cards regenerate. Only the
  cards and the usage log are lost.
- **Hooks always say "local keyword matches":** the endpoint file is missing or stale. Run
  `python ~/.claude/memory/scripts/rag.py status`; start or restart GGO, which rewrites
  the file at boot.
- **A queue item that keeps failing:** it is in `.ggo-extraction-queue/failed/`, and
  `extraction-log.md` records why. Move it back to the queue directory to retry it.
