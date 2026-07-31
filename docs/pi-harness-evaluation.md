# Should Pi replace the Claude Agent SDK harness?

*A decision brief — 31 July 2026. Investigation only, no code changes. Written after reading the
orchestrator's actual SDK usage, reading Pi's shipped type definitions (not just its docs), and
installing Pi 0.83.0 on this box and driving a real agent loop through it.*

**Subject:** [Pi](https://github.com/earendil-works/pi) — a minimal terminal coding harness by Mario
Zechner, now developed at Earendil Inc. Packages `@earendil-works/pi-coding-agent`,
`pi-agent-core`, `pi-ai`, `pi-tui`. MIT.
**Incumbent:** `@anthropic-ai/claude-agent-sdk` 0.3.220 (`server/src/agents/runner.ts`).

---

## TL;DR

**No — not as a replacement for the Claude harness. Yes — as a replacement for the CLI-backend
runners, and that's the version worth building.**

Pi is not a toy. It installed clean, runs natively on Windows, boots headlessly in RPC mode with no
auth, and drove a real tool-calling loop end-to-end on the first try (§1). It's MIT, actively
developed (last publish two days ago), and its session format, steering API and extension model are
in several places *better designed* than what we hand-rolled around the Agent SDK.

It still loses the swap on one fact that isn't a feature argument at all:

> **"Anthropic subscription auth is active for Claude Pro/Max accounts. Third-party harness usage
> draws from extra usage and is billed per token, not against Claude plan limits."**
> — Pi's own `docs/providers.md`

Every Claude run in this orchestrator costs **$0 marginal** today because the Agent SDK *is* the
first-party `claude` CLI, drawing on the Max plan's 5h/weekly windows. Under Pi the same run becomes
a metered charge — and, at the same time, roughly 60 KB of machinery whose only purpose is exploiting
those windows (`accountManager.ts`, `resetStagger.ts`, `usagePing.ts`, `resumeCapParked`, the account
chips) becomes dead code. You would be paying cash for the privilege of deleting the thing that made
it free. That is decisive on its own, before any feature comparison (§4).

On top of it sit three structural gaps: **no MCP**, **no forced structured output**, **no
`maxTurns`** — all three verified absent from Pi's shipped `.d.ts` files, not merely undocumented
(§5).

But the mirror image is genuinely attractive. Our *non-Claude* backends —
`codexRunner.ts` (38 KB) and `grokRunner.ts` (37 KB) — are hand-rolled CLI wrappers that had to give
up MCP, and therefore had to rebuild the office as a text bridge, structured output as a regex
scraper, and deliverables not at all (a gap `CLAUDE.md` documents outright). Pi speaks Codex, Grok,
z.ai, Gemini and 20+ providers through one loop, with real in-process tools. **One Pi-driven
`AgentRunLike` could replace both runners and hand the fallback lane capabilities it has never
had** (§6).

---

## 1. What Pi actually is — measured, not quoted

Everything in this section I ran on this machine. Install went into `%TEMP%\pi-eval`, nothing global
was touched, and `~/.pi/` was never authenticated.

| Check | Result |
|---|---|
| `npm i @earendil-works/pi-coding-agent` | 140 packages, 29 s, clean |
| `pi --version` | `0.83.0` (published 2026-07-29; scope created 2026-05-07) |
| License | **MIT** (vs. the Agent SDK's proprietary "SEE LICENSE IN README.md") |
| Windows | Runs natively. Needs a bash for its `bash` tool; Git Bash present and found automatically |
| Headless RPC | `pi --mode rpc` booted with **no provider auth** and answered `get_state`, `get_commands`, `get_session_stats`, `get_available_models` over LF-delimited JSONL |
| Real agent loop | `pi -p --mode json --provider zai --model glm-4.7 --tools read,ls,grep` — 47 events, streamed `thinking_delta`, issued a `read` tool call, returned the file's marker, `agent_settled`, exit 0 |
| Provider pickup | It auto-discovered `ZAI_API_KEY` from the environment and offered the z.ai catalogue — and, correctly, **saw none of our Claude credentials** (those live in `~/.claude`, not `~/.pi/agent/auth.json`) |

Built-in tools are exactly seven: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
Thinking levels are `off | minimal | low | medium | high | xhigh | max` — a **superset** of our
`Effort` enum, so `resolveEffort`/`clampEffort` would map straight across.

So: the thing works, it works here, and it works well. The rest of this brief is about fit, not
quality.

---

## 2. What the incumbent harness is actually load-bearing for

This is the requirements list the replacement has to satisfy. Everything below is in current use.

**From `Options` (`runner.ts:206-224`, configured per role in `roles.ts`):**

| Capability | Where it's used | Load-bearing because |
|---|---|---|
| `mcpServers` | all 7 roles | The **entire** agent→server control plane (§5.1) |
| `outputFormat: {json_schema}` | planner, researcher, QA, reviewer, reader | `pass`/`accept`/`escalated` are read as **control flow**, not prose |
| `maxTurns` | 40 / 40 / 60 / 60 / 40 / `implementorMaxTurns` | Deterministic `error_max_turns` at a **known** point → invisible warm resume |
| `env` per run | `buildEnv()` `runner.ts:93` | Per-run `CLAUDE_CODE_OAUTH_TOKEN` ⇒ concurrent agents on **different accounts** |
| `allowedTools` / `disallowedTools` | reader, QA, director | Harness-level read-only. `readerConfig` calls this out explicitly: enforced by the harness, *not* the prompt |
| `permissionMode` + `setPermissionMode()` | `bypassPermissions` / `plan` | Unattended running; `plan` for planner/researcher |
| `effort` | implementor, QA, reviewer | Per-task cost/quality dial |
| `resume` / `forkSession` | auto-resume, QA loop, cap-park recovery | Survives server restarts — sessions outlive the process |
| `settingSources: [user, project, local]` | implementor | Pulls in Kevin's global `~/.claude/CLAUDE.md`, repo rules, **and `.claude/settings.json` hooks** (the pgvector memory RAG layer) |
| `systemPrompt: preset claude_code` | implementor | The real Claude Code system prompt + our append |
| `agents` | available | Subagent definitions |
| `canUseTool` | available | Programmatic per-call gate |
| `includePartialMessages` | all | `text_delta` / `thinking_delta` → live console streaming |

**From `Query` and the message stream:** `interrupt()`, `setModel()`, `setPermissionMode()`,
`close()`; streaming *input* (the `InputQueue`) with `shouldQuery` and `priority` for mid-flight
injection; `system/init` → `session_id`; `result` → `structured_output`, `total_cost_usd`,
`num_turns`, `subtype`, `errors`; and `rate_limit_event` → `rate_limit_info`.

Also non-negotiable: the built-in `WebSearch` / `WebFetch` tools, which are the researcher role's
*only* capabilities (`roles.ts:199`).

---

## 3. Feature-for-feature

✅ parity or better · ⚠️ different, bridgeable · ❌ absent

| Requirement | Pi | Notes |
|---|---|---|
| Runs on Windows, headless | ✅ | Measured. RPC mode is a cleaner subprocess seam than the SDK's spawn-a-CLI-under-the-hood design |
| Streaming text + thinking deltas | ✅ | `message_update` / `thinking_delta`, measured |
| Tool-call / tool-result events | ✅ | `tool_execution_start/update/end` |
| Mid-flight injection | ✅ **better** | `steer()` (after current turn) vs `followUp()` (when idle) — explicit semantics vs. our hand-rolled `InputQueue` + `priority` |
| Interrupt | ✅ | `abort()` |
| Change model mid-session | ✅ | `setModel()` / `cycleModel()` |
| Effort tiers | ✅ | `off…max` thinking levels, a superset of our `Effort` |
| Session id, persistence, resume, fork | ✅ **better** | Tree-structured JSONL, documented format, `--session-dir`, `switchSession`/`fork`/`clone`, plus `setMessages()` to rewrite history directly |
| Cost + token accounting | ✅ | `get_session_stats` → `tokens{input,output,cacheRead,cacheWrite}`, `cost`, `contextUsage` |
| Per-run credential isolation | ✅ | `ANTHROPIC_OAUTH_TOKEN` env is honoured by `pi-ai`; `CredentialStore` is a pluggable interface. Multi-account rotation would port |
| Tool allow/deny list | ✅ | `--tools` / `--exclude-tools`, applied to built-in *and* custom tools |
| Custom in-process tools | ✅ | `customTools` / `pi.registerTool()` — typed, in-process |
| Project instruction files | ⚠️ | Loads `AGENTS.md` **and `CLAUDE.md`** walking up from cwd. But global is `~/.pi/agent/AGENTS.md`, not `~/.claude/CLAUDE.md` |
| Claude Code hooks + skills | ❌ | No `.claude/settings.json` equivalent. The SessionStart pgvector RAG hook, UserPromptSubmit hook and PreCompact extractor are Claude-Code-specific and would need rebuilding as Pi extensions |
| `WebSearch` / `WebFetch` | ❌ | Not built in. The researcher role has no other tools |
| Subagents | ❌ | "No sub-agents" — explicit design choice |
| **Forced structured output** | ❌ | **0 hits** for `jsonSchema`/`outputFormat`/`structuredOutput` across Pi's own 408 `.d.ts` files |
| **`maxTurns`** | ❌ | **0 hits.** No turn ceiling at any layer |
| **MCP** | ❌ | **0 hits.** "No MCP" is stated policy |
| Claude billed against the plan | ❌ | **Per-token extra usage** — §4 |

*(The `jsonSchemaOutputFormat` and `mcp.d.ts` symbols that show up in a naive recursive grep are
from the vendored `@anthropic-ai/sdk` transitive dependency, not Pi's API. Scoped to Pi's own
`dist/`, all three counts are zero.)*

---

## 4. The fact that decides it

Pi's `docs/providers.md`, verbatim:

> ### Claude Pro/Max
> Anthropic subscription auth is active for Claude Pro/Max accounts. **Third-party harness usage
> draws from [extra usage](https://claude.ai/settings/usage) and is billed per token, not against
> Claude plan limits.**

The Agent SDK is not a third-party harness — it *is* the `claude` CLI. That's why `buildEnv()`
deletes `ANTHROPIC_API_KEY` and calls it "the cardinal rule" (`runner.ts:95`): so every agent
authenticates via the Max subscription and costs nothing at the margin.

Swap to Pi and two things happen at once:

1. **Every Claude token becomes money.** Opus at $5/$25 per M, on unattended multi-hour tasks that
   routinely burn several turn-ceilings each. This is the same trap the DeepSeek brief identified —
   a metered bill added, not a bill cut.
2. **The machinery that made it free becomes pointless.** `accountManager.ts` (49 KB),
   `resetStagger.ts`, `usagePing.ts`, `classifyCap`, `resumeCapParked`, the whole Codex/Grok/z.ai
   failover ladder, the account chips, `probe:accounts`, `chip-lab` — all of it exists to schedule
   flat-fee windows. Per-token billing has no windows to schedule.

There is no clever way around this. Pointing Pi at Anthropic with a Claude Code OAuth token to be
*counted* as first-party would be deliberately misrepresenting the client; not recommended, and not
something I'd build.

**Corollary worth stating plainly:** this argument is specific to the *Claude* seat. It says nothing
against Pi for the backends we already pay for by other means — which is §6.

---

## 5. The three structural gaps, and how bridgeable each is

### 5.1 No MCP — the expensive one

All seven roles receive between two and three MCP servers each. All five servers are **in-process**
(`createSdkMcpServer`), so a tool handler closes over live server state — an implementor calling
`post_deliverable` mutates orchestrator SQLite directly, no IPC:

| Server | Tools | What breaks without it |
|---|---|---|
| `busServer.ts` | `post_finding`, `read_findings`, `post_deliverable`, `ask_user`, `notify_thread` | Findings feed, deliverable cards, the entire human-in-the-loop question flow |
| `officeServer.ts` | `office_look`, `chat_post`, `chat_read` | Cross-agent coordination in a shared checkout |
| `directorServer.ts` | dispatch / dispatch_read / thread control | The director can't dispatch |
| `gitReadServer.ts` | `git_read` | The read lane loses history without granting Bash |
| `memoryServer.ts` | `search_memory`, `read_memory` | Researcher memory recall |

**Bridgeable — but it's a real port, not a shim.** Pi's `registerTool` is in-process TypeScript, and
in RPC mode extensions run inside the `pi` child. A Pi extension could re-expose all of these by
calling back into the orchestrator over `127.0.0.1:4317` (already an authenticated Fastify API) or
over the RPC stdio channel. Every tool would be rewritten and re-tested. Note this is *strictly
better than what the Codex backend has today*, which is nothing.

### 5.2 No forced structured output

Five roles set `outputFormat: {json_schema}` and read the result as control flow — QA's `pass`
settles or bounces a task; the reviewer's `accept` marks it done; the reader's `escalated` parks it.

**Bridgeable, cheaply, and the code already exists.** `structuredText.ts` (26 KB) was written for
exactly this: it recovers a role's structured result from a CLI backend's free-form final text
(fenced ```json block → last balanced `{…}` → shape-check against the schema). A Pi backend would
reuse it verbatim. Real cost: schema *validation* moves from provider-enforced to best-effort, which
is a genuine reliability step down for a `pass` boolean — but it's the step down we already accepted
for Codex and Grok.

### 5.3 No `maxTurns`

The implementor's turn ceiling is not a safety net, it's a *feature*: a cutoff at a known point ends
with `error_max_turns`, which the orchestrator detects and warm-resumes invisibly while the prompt
cache is still hot (`roles.ts:227-230`). Without a ceiling, a runaway agent runs until it hits a
context wall — the one failure mode `TOKEN_FREEZE_FINDINGS.md` names as having **no** dedicated
recovery path.

**Bridgeable, externally.** Count `turn_end` events on the RPC stream and call `abort()` at N. That
gives a deterministic stop, though it lands as a generic abort rather than a typed subtype, so
`runError.ts` would need to learn the new shape.

**Not a gap:** Pi's built-in auto-compaction plus `compact()`/custom compaction hooks would actually
*close* the context-window-exceeded hole that the incumbent leaves open. Fair point in Pi's favour.

---

## 6. Where Pi is genuinely the right tool: the CLI-backend lane

Invert the question. The problem Pi solves brilliantly is **one loop, many providers** — and this
repo has that problem badly, just not on the Claude seat.

Today the fallback ladder is three hand-rolled implementations:

- `codexRunner.ts` — 38 KB wrapping `codex exec`, including a wedge watchdog, JSONL parsing, image
  temp-files, and the `OFFICE[team|office]:` **text bridge** that exists purely because Codex has no
  MCP.
- `grokRunner.ts` — 37 KB doing it again for Grok, plus `--json-schema` handling.
- z.ai — the one that got off easy, because GLM speaks the Anthropic wire format and could reuse
  `AgentRun` via an env swap (`ZaiAgentRun`).

Costs we're carrying because of that: ~75 KB of duplicated plumbing; two separate cap classifiers;
`structuredText.ts` as a scraper; the office reduced to prose parsing; and the flatly documented gap
— *"Codex-backend implementors have no bus tools and so can't emit deliverables at all (a known
gap)."*

**One `PiAgentRun implements AgentRunLike`, driving `pi --mode rpc`, would replace both runners** and
give that lane, for the first time:

- **Real tools instead of a text bridge** — `post_finding`, `post_deliverable`, `ask_user`,
  `chat_post` as registered Pi tools routed back over localhost. That closes the deliverables gap.
- **Provider-agnostic reach** — Codex, Grok, z.ai, Gemini, DeepSeek, Bedrock, local llama.cpp, all
  behind one runner. New backend = a models.json entry, not a new 37 KB file.
- **One event stream** to normalise instead of three.
- **Sessions we can actually manipulate** — documented JSONL + `setMessages()` would let
  `resumeCompress.ts` (15 KB of working around an opaque session store) do its job directly.
- **Flat-fee stays flat.** Codex on a ChatGPT plan and z.ai on the GLM Coding Plan are billed by
  those providers, not by Anthropic — so §4 simply doesn't apply to this lane. The asymmetry is
  worth naming: Anthropic meters third-party harnesses, while OpenAI *endorses* Pi's Codex
  subscription path (Pi's `docs/providers.md` links "Codex for OSS"). The provider whose plan we'd
  keep for free is precisely the one Pi would be driving.

`AgentRunLike` is already the seam for exactly this (`runner.ts:61`), and `startImplementor` already
picks the concrete class at one factory point. Architecturally this is the designed extension point,
same conclusion the DeepSeek brief reached.

---

## 7. Recommendation

1. **Don't replace the Claude harness.** §4 is dispositive, and §5.1–5.3 would each be a
   multi-day port to arrive somewhere strictly worse. The Agent SDK's real cost here is
   ugliness — the four-shape cap classifier in `runner.ts` exists because the SDK surfaces caps four
   different ways — and ugliness we've already paid for and tested is cheaper than a rewrite that
   also starts a metered bill.

2. **Do prototype `PiAgentRun` for the CLI-backend lane.** Highest value per line in this whole
   analysis: it deletes ~75 KB of bespoke runner, closes a documented capability gap, and makes every
   future backend an entry in a config file. Cheapest honest test, roughly a day:
   - a throwaway script that drives `pi --mode rpc` against z.ai and normalises its events into
     `AgentEvent` — confirms the event mapping is total;
   - one Pi extension registering `post_finding` + `post_deliverable`, POSTing to `127.0.0.1:4317`
     — confirms the tool bridge closes the deliverables gap;
   - a turn counter calling `abort()` at N — confirms the `maxTurns` substitute.

   If all three land, the full `AgentRunLike` is mostly mechanical. If the tool bridge doesn't work
   cleanly, stop: without it Pi is only marginally better than `codexRunner.ts`.

3. **Steal two ideas regardless of whether we adopt Pi.** `steer()` vs `followUp()` is a clearer
   model than our `priority` flag, and Pi's tree-structured session JSONL is what
   `resumeCompress.ts` wishes it had.

4. **Re-check §4 if Anthropic's policy changes.** The billing sentence is the only load-bearing
   objection to a full swap. If first-party plan usage is ever extended to third-party harnesses,
   this brief should be re-run — the feature gaps alone would not have settled it.

---

## Appendix — verification log

Everything asserted above was checked directly; nothing rests on a summary of a summary.

- **Incumbent surface:** read `server/src/agents/runner.ts` and `server/src/agents/roles.ts` in full;
  grepped `@anthropic-ai/claude-agent-sdk` across the repo (5 `createSdkMcpServer` call sites);
  confirmed version 0.3.220 in `server/package-lock.json`.
- **Pi docs:** downloaded all 19 `packages/coding-agent/docs/*.md` plus both READMEs from
  `raw.githubusercontent.com/earendil-works/pi/main` and read them locally — the billing sentence and
  the "No MCP"/"No sub-agents" statements are quoted from the files, not from a search result.
- **Pi API:** installed 0.83.0 into `%TEMP%\pi-eval` and grepped its **shipped `.d.ts` files** — 408
  files across all four Pi packages (`pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`),
  transitive dependencies excluded: `maxTurns` 0, `jsonSchema` 0, `outputFormat` 0,
  `structuredOutput` 0, `MCP` 0 (case-sensitive, all casings);
  `registerTool`, `customTools`, `excludeTools`, `setRuntimeApiKey`, `agentDir`, `sessionDir`,
  `ANTHROPIC_OAUTH_TOKEN` all present.
- **Runtime:** `--version`, `--help`; a `--mode rpc` probe answering four control commands with no
  auth; and a full `-p --mode json` run against z.ai GLM-4.7 that read a file via the `read` tool and
  returned its contents (47 events, exit 0).
- **Not done:** no Anthropic `/login` was performed, so Pi's Claude path was not exercised against a
  live Max account — the billing claim rests on Anthropic's/Pi's stated policy, not a measured
  invoice. Testing it would cost real extra-usage dollars to confirm a documented behaviour.
