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
// A summary that comments on the request rather than naming it counts as a failure too (see COMMENTARY):
// it gets one corrective retry, then falls back to the raw first line the caller already has.

const TITLE_MODEL = process.env.INJECT_TITLE_MODEL || "claude-haiku-4-5-20251001";
const SHORT_WORD_LIMIT = 10; // prose shorter than this is used verbatim, no model call
const MAX_TITLE_CHARS = 70; // hard cap; board lanes wrap two lines comfortably at this width

type Block = { type?: string; text?: string };

// The title is a LABEL, never a reply. The prompt used to ask what "a coding task" was being asked to
// do, which invited the model to dispute the premise whenever a request didn't look like code — a World
// of Warcraft server bug reported in game terms produced the board title "This is not a coding task -
// it's a gaming bug report about World of…". The owner wants a hint at the work, not an opinion about it.
const TITLE_RULES = `This is a label on a card, not a reply to the person: never judge, classify, refuse, or remark on what you are given, and never say what it is not. However it is worded — a bug report, a complaint, a symptom described in a product's own terms, a rant — it is real work someone is doing, so just name it, in the requester's own vocabulary. Output ONLY the label: no quotes, no surrounding punctuation, no trailing period, no "Task:" prefix. Prefer imperative voice`;

const INJECTION_PROMPT = `You are relabelling a card on a work board. In 8 words or fewer, name what the card is now being asked to do. ${TITLE_RULES} (e.g. "Re-run integration tests after the rename"). The directive follows:`;
const BRIEF_PROMPT = `You are labelling a card on a work board. In 8 words or fewer, name what is being asked for. ${TITLE_RULES} (e.g. "Add a dark-mode toggle to settings"). The request follows:`;
const RETRY_SUFFIX = `\nYour previous attempt commented on the request instead of labelling it. Do not describe or categorise the request — name the work, and nothing else.`;

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

// A prompt alone can't be trusted to hold — the model only has to slip once for its opinion to become
// the board label, and the label persists. Each pattern is anchored at the start (where a model turns to
// address the reader) or is a phrase no genuine label contains, so a real title survives: "Fix crash when
// players cannot enter vehicles" is untouched, while "I can't title this" and "This is not a coding task"
// are not. A false positive only costs the raw first line of the request, which is a fine hint by itself.
// Disputing that the request is real work — the failure that produced the WoW title. Applies to ANY
// model-written artifact about the owner's request, including a spoken line, so it's exported separately.
const DISPUTES_THE_WORK = [
  /\bnot (a|an|really|actually|truly)\b.{0,24}\b(task|request|bug|issue|problem|code|coding|programming|software)\b/i,
  /\b(coding|programming|development|software) (task|request)\b/i, // the framing leaking back out
];

// Addressing the reader instead of labelling. A LABEL only: a spoken sentence may open with "I" or
// "This", so these must not be applied to the voice line.
const ADDRESSES_THE_READER = [
  /^(i|we|you)\b/i, // "I can't…", "I'd call this…"
  /^(this|that|it|these|those)\b/i, // "This is not a coding task…"
  /^the (user|owner|requester|request|message|brief|prompt|input|text|above)\b/i,
  /^(sorry|apologies|unfortunately|note|hmm|actually|however|no|nothing)\b/i,
  /^(cannot|can't|unable)\b/i,
];

/** True when the model argued with the request instead of doing the job it was given — it decided the
 *  request isn't real work. Every caller that persists or speaks model prose should reject on this. */
export function disputesTheWork(text: string): boolean {
  const t = text.trim();
  return !!t && DISPUTES_THE_WORK.some((re) => re.test(t));
}

/** True when the model answered ABOUT the request instead of naming it — reject and fall back. */
export function looksLikeCommentary(title: string): boolean {
  const t = title.trim();
  return !!t && (disputesTheWork(t) || ADDRESSES_THE_READER.some((re) => re.test(t)));
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
  if (!summary) return null;
  if (!looksLikeCommentary(summary)) return clampToWord(summary);
  // It argued with the request. One corrective retry — a model told plainly that it commented instead of
  // labelling usually complies — and if it argues again, no title at all beats the wrong kind of title.
  const retry = await summarize(trimmed, token, prompt + RETRY_SUFFIX);
  return retry && !looksLikeCommentary(retry) ? clampToWord(retry) : null;
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
