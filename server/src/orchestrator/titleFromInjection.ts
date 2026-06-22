// Derive a fresh board title from a directive the director injected into a running task. the user runs
// 4–5 tasks at once and loses track when a lane's scope drifts from its original title (a task created
// as "Fix the login redirect bug" but re-injected to do unrelated work still shows the stale
// title). After every inject we regenerate the title to reflect what the task is being asked to do NOW.
//
// Short directives (< SHORT_WORD_LIMIT words) are used verbatim — no model latency for "re-run the
// tests". Longer ones get a single ≤8-word Haiku summary via the same raw OAuth fetch the resume
// compressor uses (accountManager.auxToken()). Any failure (no token, network, non-200) returns null
// so the caller simply leaves the title unchanged — this is best-effort, never on the inject path.

const TITLE_MODEL = process.env.INJECT_TITLE_MODEL || "claude-haiku-4-5-20251001";
const SHORT_WORD_LIMIT = 10; // directives shorter than this are used verbatim, no model call
const MAX_TITLE_CHARS = 70; // hard cap; board lanes wrap two lines comfortably at this width

type Block = { type?: string; text?: string };

const TITLE_PROMPT = `Summarise, in 8 words or fewer, what a coding task is now being asked to do. Output ONLY the title: no quotes, no surrounding punctuation, no trailing period, no "Task:" prefix. Use imperative voice (e.g. "Re-run integration tests after the rename"). The directive follows:`;

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

async function summarize(message: string, token: string): Promise<string | null> {
  const body = JSON.stringify({
    model: TITLE_MODEL,
    max_tokens: 32,
    messages: [{ role: "user", content: `${TITLE_PROMPT}\n\n${message}` }],
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

/** A new board title summarising the latest injected directive, or null to leave the title unchanged.
 *  Verbatim (trimmed/capped) for short directives; a ≤8-word Haiku summary otherwise. Never throws. */
export async function titleFromInjection(message: string, token: string | undefined): Promise<string | null> {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < SHORT_WORD_LIMIT) return clampToWord(trimmed);
  if (!token) return null; // no account token for the model call — leave the title as-is
  const summary = await summarize(trimmed, token);
  return summary ? clampToWord(summary) : null;
}
