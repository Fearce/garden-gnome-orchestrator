// Derive a concise board title from raw prose — used in two places, both best-effort:
//   • titleFromInjection: after the director injects a directive into a running task, so a lane whose
//     scope drifted (created "Fix the login redirect bug", re-injected to do unrelated work) stops
//     showing the stale title. The user runs several tasks at once and loses track otherwise.
//   • titleFromBrief: when the director is SKIPPED, the raw message is dispatched verbatim and the only
//     title we'd otherwise have is its truncated first line ("trash"). This gives skip-director tasks a
//     real board title without paying for the full Sonnet director — just one cheap Haiku call.
//
// Short prose (< SHORT_WORD_LIMIT words) is used verbatim — no model latency for "re-run the tests".
// Longer prose gets a single ≤8-word Haiku summary via the same raw OAuth fetch the resume compressor
// uses (accountManager.auxToken()). Any failure (no token, network, non-200) returns null so the caller
// simply leaves the title unchanged — this is best-effort, never blocks the inject or dispatch path.

const TITLE_MODEL = process.env.INJECT_TITLE_MODEL || "claude-haiku-4-5-20251001";
const SHORT_WORD_LIMIT = 10; // prose shorter than this is used verbatim, no model call
const MAX_TITLE_CHARS = 70; // hard cap; board lanes wrap two lines comfortably at this width

type Block = { type?: string; text?: string };

const INJECTION_PROMPT = `Summarise, in 8 words or fewer, what a coding task is now being asked to do. Output ONLY the title: no quotes, no surrounding punctuation, no trailing period, no "Task:" prefix. Use imperative voice (e.g. "Re-run integration tests after the rename"). The directive follows:`;
const BRIEF_PROMPT = `Summarise, in 8 words or fewer, what a coding task is being asked to do. Output ONLY the title: no quotes, no surrounding punctuation, no trailing period, no "Task:" prefix. Use imperative voice (e.g. "Add a dark-mode toggle to settings"). The task request follows:`;

/** Cap to MAX_TITLE_CHARS on a word boundary (so we never cut mid-word), trimming trailing punctuation. */
function clampToWord(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_TITLE_CHARS) return t;
  const slice = t.slice(0, MAX_TITLE_CHARS);
  const cut = slice.lastIndexOf(" ");
  return (cut > 0 ? slice.slice(0, cut) : slice).replace(/[\s.,;:]+$/, "") + "…";
}

/** Strip wrapping quotes/whitespace a model sometimes adds despite instructions, and a trailing period. */
function cleanTitle(s: string): string {
  return s
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim();
}

async function summarize(message: string, token: string, prompt: string, maxTokens = 32): Promise<string | null> {
  const body = JSON.stringify({
    model: TITLE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: `${prompt}\n\n${message}` }],
  });
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
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      continue; // network blip / timeout — retry once, then give up
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
            .join(" ")
            .trim()
        : "";
      const cleaned = cleanTitle(text);
      return cleaned || null;
    }
    await res.text().catch(() => ""); // drain to free the socket
    if (res.status !== 429 && res.status < 500) return null; // 4xx (auth etc.) — retry won't help
    // 429 / 5xx → loop and retry once
  }
  return null;
}

/** Shared core: a concise title from raw prose, or null to leave the title unchanged. Short prose is
 *  used verbatim (whitespace-collapsed, capped on a word boundary); longer prose gets a ≤8-word Haiku
 *  summary with the given prompt. Never throws — every failure path yields null. */
async function autoTitle(message: string, token: string | undefined, prompt: string): Promise<string | null> {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < SHORT_WORD_LIMIT) return clampToWord(trimmed.replace(/\s+/g, " "));
  if (!token) return null; // no account token for the model call — leave the title as-is
  const summary = await summarize(trimmed, token, prompt);
  return summary ? clampToWord(summary) : null;
}

/** A new board title summarising the latest injected directive, or null to leave the title unchanged. */
export function titleFromInjection(message: string, token: string | undefined): Promise<string | null> {
  return autoTitle(message, token, INJECTION_PROMPT);
}

/** A board title for a skip-director dispatch, whose raw message is the whole brief, or null to keep the
 *  caller's fallback (the truncated first line). Same verbatim-short / Haiku-long behaviour as injection. */
export function titleFromBrief(message: string, token: string | undefined): Promise<string | null> {
  return autoTitle(message, token, BRIEF_PROMPT);
}

/** One short Haiku line for an arbitrary prompt (voice announcements etc.) — the same raw OAuth fetch
 *  and best-effort contract as the titles: any failure (no token, network, non-200) yields null. */
export function haikuLine(message: string, token: string | undefined, prompt: string, maxTokens = 64): Promise<string | null> {
  return token ? summarize(message, token, prompt, maxTokens) : Promise.resolve(null);
}
