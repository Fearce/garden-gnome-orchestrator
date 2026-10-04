---
paths:
  - "server/src/memory/**"
  - "server/src/tests/memoryRag.test.ts"
  - "web/src/components/MemorySettings.tsx"
  - "web/src/components/memorySettings.css"
---

# Agent memory: traps

Design, hook API, migration and recovery are in [docs/agent-memory.md](../../docs/agent-memory.md); read
it before changing recall, cards, extraction or the hook routes. Gate: `npm run test:memory-rag --prefix server`.

- **The hook routes are a contract with scripts outside this repo.** `rag.py` and `extractor.py` in the
  owner's user-level setup call `/api/memory/hook/*` and write `.ggo-extraction-queue/*.json` themselves.
  Add fields instead of renaming them; a renamed field silently drops every outside session to the keyword
  fallback. Keep the queue item at `{version:1, text, source, sessionId?, createdAt}`; other shapes are set
  aside into `failed/`, not retried.
- **Only the primary instance owns the memory directory.** `isPrimaryMemoryOwner()` is false whenever
  `DATA_DIR` is set or a test runs on default data. A lab or test must never publish
  `.ggo-memory-endpoint.json` or drain the queue, or the owner's live hooks start talking to a throwaway
  server. Give any new lab its own `DATA_DIR`.
- **Keep the index off the event loop.** SQLite work and Luna's CLI spawn run in `memoryWorker.ts`; the
  server side only posts messages. New index queries go through `workerProtocol.ts`, never a direct
  `better-sqlite3` handle in the server thread.
- **No embeddings exist on these subscriptions** (Anthropic: none; OpenAI: paid API key only, checked
  2026-10-04). Do not add a "use embeddings when available" path that a subscription-only install can
  never take. Paraphrase is the retrieval cards' job.
- **The hook budget is fixed by the host.** Claude Code and Codex kill a hook at 15 s. The script gives GGO
  7 s (`timeoutMs`) and reads for 8.5 s. A slower recall step must fall back inside `timeoutMs`; it must not
  rely on the client waiting longer.
- **Model calls ride agent capacity.** Haiku goes through `AccountManager.auxAccount` and reports
  rate-limit headers back. Never pin an account or bypass the lane limits in `models.ts`: memory must yield
  to agent work, not compete with it.
