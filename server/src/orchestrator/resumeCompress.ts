// Cheap resume: compress an implementor's prior Claude Code session transcript LOCALLY into a small
// handoff, instead of reloading the whole ~hundreds-of-K-token context on a cold cache miss (the
// expensive part of a resume). Two stages: (1) a free static strip that drops re-derivable junk
// (old tool output, the model's thinking, big tool inputs, images) and keeps the conversation +
// a files-touched list; (2) a cheap Haiku summary of the OLD turns (recent turns stay verbatim).
//
// Mirrors the standalone tool at C:\claude-resume-lite (compress.mjs + summarize.mjs); vendored
// here so the orchestrator service stays self-contained and doesn't depend on that path existing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RECENT_VERBATIM = 24; // keep this many trailing messages verbatim
const RECENT_TOOL_RESULT_CHARS = 1500; // truncate kept tool results to this
const SUMMARY_MODEL = process.env.RESUME_SUMMARY_MODEL || "claude-haiku-4-5-20251001";
const CHUNK_CHARS = 600_000; // ~150k tokens, under Haiku's 200k context
const MAX_SUMMARY_OUTPUT = 16_000;
// Bound the cost of summarizing a pathologically long session: at most this many Haiku calls,
// keeping the most RECENT chunks (the oldest old-turns are least relevant to continuing). After
// the static strip, oldBody is usually one chunk, so this only bites on enormous sessions.
const MAX_SUMMARY_CHUNKS = 4;

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };

/** Locate a session transcript by id at ~/.claude/projects/<slug>/<id>.jsonl (the id is unique
 *  across project dirs, so we don't need to reconstruct the cwd→slug encoding). */
export function findTranscript(sessionId: string): string | null {
  const root = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return null;
  }
  for (const proj of projects) {
    const p = join(root, proj, `${sessionId}.jsonl`);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** How long since the session was last active, from its transcript's mtime (the .jsonl is appended
 *  as the session runs). null if no transcript is found. Used to decide whether the prompt cache is
 *  still warm — a recent resume is cheap + full-fidelity via a normal resume, so we don't compress. */
export function sessionAgeMs(sessionId: string): number | null {
  const p = findTranscript(sessionId);
  if (!p) return null;
  try {
    return Date.now() - statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

interface Compressed {
  oldBody: string;
  recentBody: string;
  fileList: string;
}

/** Static strip (free): conversation text + tool-call markers + a files-touched list; recent turns
 *  keep their (clipped) tool results, older turns drop them. */
function compressTranscript(jsonl: string): Compressed {
  const msgs: { role: string; content: Block[] }[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let o: { message?: { role?: string; content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const role = o.message?.role;
    const content = o.message?.content;
    if ((role === "user" || role === "assistant") && (Array.isArray(content) || typeof content === "string")) {
      msgs.push({ role, content: Array.isArray(content) ? (content as Block[]) : [{ type: "text", text: String(content) }] });
    }
  }

  const filesTouched = new Map<string, Set<string>>();
  const noteFile = (p: unknown, action: string) => {
    if (!p || typeof p !== "string") return;
    const set = filesTouched.get(p) ?? filesTouched.set(p, new Set()).get(p)!;
    set.add(action);
  };

  const oldParts: string[] = [];
  const recentParts: string[] = [];
  const total = msgs.length;
  msgs.forEach((m, i) => {
    const recent = i >= total - RECENT_VERBATIM;
    const parts: string[] = [];
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && b.text) {
        parts.push(b.text);
      } else if (b.type === "tool_use") {
        const arg = shortToolInput(b.input);
        parts.push(`\`[${b.name}${arg ? ` ${arg}` : ""}]\``);
        for (const p of fileArgs(b.input)) noteFile(p, fileAction(b.name ?? ""));
      } else if (b.type === "tool_result" && recent) {
        const txt = toolResultText(b.content);
        if (txt) parts.push("```\n" + clip(txt, RECENT_TOOL_RESULT_CHARS) + "\n```");
      } else if (b.type === "image") {
        parts.push("`[image]`");
      }
    }
    const body = parts.join("\n").trim();
    if (body) (recent ? recentParts : oldParts).push(`### ${m.role === "user" ? "Director/user" : "Implementor"}\n${body}`);
  });

  const fileList =
    filesTouched.size === 0
      ? "(none recorded)"
      : [...filesTouched.entries()].map(([p, set]) => `- ${p} (${[...set].join(", ")})`).join("\n");
  return { oldBody: oldParts.join("\n\n"), recentBody: recentParts.join("\n\n"), fileList };
}

const SUMMARY_PROMPT = `You are compressing the EARLIER part of a long Claude Code coding session into a dense handoff so another agent can seamlessly continue the work. Preserve everything load-bearing; drop only redundancy and chit-chat.

Capture: the goals and explicit instructions/preferences; every decision made and WHY; the current state (what's done / in progress / verified); files changed and what changed; the specific values, names, paths, commands, and IDs that matter; gotchas, constraints, and dead-ends discovered; and open questions / next steps.

Write a STRUCTURED BRIEF with these sections: "## Goal & constraints", "## Key decisions", "## Work done", "## Files & state", "## Gotchas / dead-ends", "## Open / next". Do NOT retell chronologically. Be thorough — prefer keeping a detail over losing it. Output ONLY the brief, no preamble.`;

async function summarizeChunk(chunk: string, token: string, partNote: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-cli/2.0.0",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: MAX_SUMMARY_OUTPUT,
        messages: [{ role: "user", content: `${SUMMARY_PROMPT}${partNote}\n\n---SESSION TRANSCRIPT (earlier turns)---\n${chunk}` }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    await res.text().catch(() => ""); // drain the body to free the socket; content unused
    return null;
  }
  let j: { content?: Block[] };
  try {
    j = (await res.json()) as { content?: Block[] };
  } catch {
    return null;
  }
  const text = Array.isArray(j.content)
    ? j.content
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim()
    : "";
  return text || null;
}

/** Split on message boundaries (each part starts with "### ") so a chunk never cuts a turn or
 *  code block in half; hard-splits any single oversized message as a last resort. */
function chunkOnBoundaries(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const seg of text.split(/(?=\n\n### )/)) {
    if (cur && cur.length + seg.length > max) {
      chunks.push(cur);
      cur = "";
    }
    cur += seg;
    while (cur.length > max) {
      chunks.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Haiku summary of the old transcript. Chunked on message boundaries for very long sessions and
 *  capped to the most recent MAX_SUMMARY_CHUNKS to bound cost. Returns null on any Haiku failure
 *  so the caller falls back to the free static strip. */
async function summarizeOldTurns(oldText: string, token: string): Promise<string | null> {
  if (!oldText.trim()) return "";
  const all = chunkOnBoundaries(oldText, CHUNK_CHARS);
  const dropped = Math.max(0, all.length - MAX_SUMMARY_CHUNKS);
  const chunks = dropped > 0 ? all.slice(all.length - MAX_SUMMARY_CHUNKS) : all;
  const out: string[] = [];
  if (dropped > 0) {
    out.push(
      `### Earlier — ${dropped} oldest segment(s) omitted to bound resume cost (the full transcript is on disk if an exact early detail is ever needed).`,
    );
  }
  for (let i = 0; i < chunks.length; i++) {
    const note = chunks.length > 1 ? ` (This is part ${i + 1} of ${chunks.length} of the earlier transcript.)` : "";
    const s = await summarizeChunk(chunks[i]!, token, note);
    if (s == null) return null;
    out.push(chunks.length > 1 ? `### Earlier — part ${i + 1}/${chunks.length}\n\n${s}` : s);
  }
  return out.join("\n\n");
}

function buildHandoff(oldRendered: string, recentBody: string, fileList: string): string {
  const out: string[] = [];
  if (oldRendered.trim()) out.push("### Earlier in the session", "", oldRendered.trim(), "");
  if (recentBody.trim()) out.push("### Most recent turns (verbatim)", "", recentBody.trim(), "");
  out.push("### Files touched this session (re-read current state as needed)", "", fileList);
  return out.join("\n");
}

export interface SessionHandoff {
  markdown: string;
  haiku: boolean; // true if the Haiku summary stage succeeded (else free static strip only)
}

/** Compress a prior implementor session into a handoff: find transcript → static strip → Haiku
 *  summary of old turns → markdown. Returns null when the transcript can't be found/read (caller
 *  then falls back to plan + git diff alone). `token` is an account's subscription token for the
 *  cheap Haiku call; without it (or on Haiku failure) the free static strip is used. */
export async function compressSession(sessionId: string, token: string | undefined): Promise<SessionHandoff | null> {
  const path = findTranscript(sessionId);
  if (!path) return null;
  let jsonl: string;
  try {
    jsonl = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { oldBody, recentBody, fileList } = compressTranscript(jsonl);
  let oldRendered = oldBody;
  let haiku = false;
  if (token && oldBody.trim()) {
    const s = await summarizeOldTurns(oldBody, token);
    if (s != null) {
      oldRendered = s;
      haiku = true;
    }
  }
  return { markdown: buildHandoff(oldRendered, recentBody, fileList), haiku };
}

// ---- static-strip helpers ----
function shortToolInput(input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const v =
    pick("file_path") ||
    pick("path") ||
    pick("command") ||
    pick("pattern") ||
    pick("query") ||
    pick("url") ||
    pick("prompt") ||
    pick("description") ||
    (Object.values(o).find((x) => typeof x === "string") as string | undefined);
  return v ? clip(String(v).replace(/\s+/g, " "), 80) : "";
}
function fileArgs(input: unknown): string[] {
  if (input == null || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  return ["file_path", "path", "notebook_path"].map((k) => o[k]).filter((x): x is string => typeof x === "string");
}
const fileAction = (name: string) => (/edit/i.test(name) ? "edited" : /write/i.test(name) ? "written" : "read");
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as Block).text) : "")).join("\n");
  return "";
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …[truncated]" : s);
