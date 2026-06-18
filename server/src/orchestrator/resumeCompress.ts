// Cheap resume: compress an implementor's prior Claude Code session transcript LOCALLY into a small
// handoff, instead of reloading the whole ~hundreds-of-K-token context on a cold cache miss (the
// expensive part of a resume). Stages:
//   1. A FREE static strip that drops re-derivable junk (old tool output, the model's thinking, big
//      tool inputs, images) and keeps the conversation text + recent (clipped) tool results + a
//      files-touched list. This alone shrinks a transcript enormously.
//   2. The OLD turns (everything before the last RECENT_VERBATIM messages) are then either:
//        - kept VERBATIM when already small (≤ INLINE_OLD_MAX_CHARS) — NO Haiku call at all, which
//          is the common case; or
//        - summarized by a SINGLE Haiku call over only the most-recent HAIKU_INPUT_CAP_CHARS of
//          them (older context dropped with a note). So the Haiku INPUT is bounded and cheap rather
//          than re-reading an entire (possibly 200k+ token) session — and the fallback when Haiku
//          can't run is the SAME capped slice, never the full transcript.
//   The recent turns always stay verbatim.
//
// Mirrors the standalone tool at C:\claude-resume-lite (compress.mjs + summarize.mjs); vendored
// here so the orchestrator service stays self-contained and doesn't depend on that path existing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RECENT_VERBATIM = 24; // keep this many trailing messages verbatim
const RECENT_TOOL_RESULT_CHARS = 1500; // truncate kept tool results to this
const SUMMARY_MODEL = process.env.RESUME_SUMMARY_MODEL || "claude-haiku-4-5-20251001";
const MAX_SUMMARY_OUTPUT = Number(process.env.RESUME_SUMMARY_OUTPUT || 8_000); // a dense brief, not a re-rendering
// Old turns this small after the static strip aren't worth a Haiku round-trip — drop them into the
// handoff verbatim (full fidelity, zero summary tokens). Most sessions land here → no Haiku call.
const INLINE_OLD_MAX_CHARS = Number(process.env.RESUME_INLINE_OLD_MAX || 24_000); // ~6k tokens
// When the old turns ARE large, cap what we feed Haiku to the most-recent slice (one call, no
// multi-chunk fan-out). Older context is the least load-bearing for "continue the work" and the
// full transcript stays on disk (RESUME_FULL_SESSION=1 reloads it). ~90k tokens of chars —
// comfortably under Haiku's 200k window and far below the old 4×150k worst case.
const HAIKU_INPUT_CAP_CHARS = Number(process.env.RESUME_HAIKU_INPUT_CAP || 360_000);

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

The task brief and the plan are provided to that agent SEPARATELY and authoritatively, so do NOT restate the goal, the requirements, or the plan — capture only what actually HAPPENED in this session that those can't tell it: every decision made and WHY; the current state (what's done / in progress / verified vs not); files changed and what specifically changed; the concrete values, names, paths, commands, and IDs that matter; gotchas, constraints, and dead-ends discovered; and the remaining work / open questions.

Write a STRUCTURED BRIEF with these sections: "## Key decisions", "## Work done", "## Files & state", "## Gotchas / dead-ends", "## Open / next". Do NOT retell chronologically and do NOT add a goal/plan recap. Be thorough on the above — prefer keeping a detail over losing it. Output ONLY the brief, no preamble.`;

async function summarizeChunk(chunk: string, token: string, partNote: string): Promise<string | null> {
  const body = JSON.stringify({
    model: SUMMARY_MODEL,
    max_tokens: MAX_SUMMARY_OUTPUT,
    messages: [{ role: "user", content: `${SUMMARY_PROMPT}${partNote}\n\n---SESSION TRANSCRIPT (earlier turns)---\n${chunk}` }],
  });
  // One retry: a transient 429/5xx/network blip shouldn't silently dump us onto the (capped) static
  // strip. Non-retryable statuses (4xx) and a second failure fall through to null → static fallback.
  for (let attempt = 0; attempt < 2; attempt++) {
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
        body,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      continue; // network error / timeout — retry once, then give up
    }
    if (res.status === 200) {
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
    await res.text().catch(() => ""); // drain the body to free the socket; content unused
    if (res.status !== 429 && res.status < 500) {
      console.warn(`[resume] Haiku summary HTTP ${res.status} — falling back to the static strip.`);
      return null; // 4xx (e.g. auth) — retrying won't help
    }
    // 429 / 5xx → loop and retry once
  }
  console.warn("[resume] Haiku summary failed after a retry — falling back to the static strip.");
  return null;
}

/** Keep only the most-recent `max` chars, aligned to a message boundary ("### ") so we never start
 *  mid-turn. Returns the kept tail and how many chars were dropped. The recent old-turns matter most
 *  for continuing; the oldest are least load-bearing and remain on disk. */
function capRecentText(text: string, max: number): { kept: string; dropped: number } {
  if (text.length <= max) return { kept: text, dropped: 0 };
  const tail = text.slice(text.length - max);
  const cut = tail.indexOf("\n### ");
  const kept = cut >= 0 ? tail.slice(cut + 1) : tail;
  return { kept, dropped: text.length - kept.length };
}

/** Haiku summary of the old turns — a SINGLE call over the most-recent HAIKU_INPUT_CAP_CHARS (older
 *  context dropped with a note). One call: no multi-chunk fan-out, no cross-chunk context loss, no
 *  4×-output blow-up. Returns null on Haiku failure so the caller falls back to the (capped) static
 *  strip. Only reached when the old turns are too big to inline verbatim. */
async function summarizeOldTurns(oldText: string, token: string): Promise<string | null> {
  const trimmed = oldText.trim();
  if (!trimmed) return "";
  const { kept, dropped } = capRecentText(trimmed, HAIKU_INPUT_CAP_CHARS);
  const note = dropped
    ? ` (Only the most recent ~${Math.round(kept.length / 1000)}k chars of the earlier transcript are included; ~${Math.round(dropped / 1000)}k older chars were omitted to bound resume cost — the full transcript is on disk if an exact early detail is needed.)`
    : "";
  const s = await summarizeChunk(kept, token, note);
  if (s == null) return null;
  return dropped ? `### (Oldest part of the earlier transcript omitted to bound cost.)\n\n${s}` : s;
}

/** The static-strip fallback when Haiku can't run (no token / failure): the SAME capped most-recent
 *  slice rather than the whole old body, so a failed summary can never balloon into a near-full
 *  transcript reload — the cost the cold path exists to avoid. */
function cappedStatic(oldBody: string): string {
  const { kept, dropped } = capRecentText(oldBody, HAIKU_INPUT_CAP_CHARS);
  return dropped
    ? `*(Oldest ~${Math.round(dropped / 1000)}k chars elided to bound resume cost; full transcript on disk.)*\n\n${kept}`
    : kept;
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
  if (oldBody.trim()) {
    if (oldBody.length <= INLINE_OLD_MAX_CHARS) {
      // Already small after the static strip — keep verbatim (full fidelity, no Haiku tokens spent).
      oldRendered = oldBody;
    } else if (token) {
      const s = await summarizeOldTurns(oldBody, token);
      // Haiku failed → the capped static strip (still far smaller than a full transcript reload).
      oldRendered = s ?? cappedStatic(oldBody);
      haiku = s != null;
    } else {
      // No account token for the Haiku call → capped static strip.
      oldRendered = cappedStatic(oldBody);
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
