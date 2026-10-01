import { worktreeSlug } from "./taskWorktree.js";
import { haikuLine, looksLikeCommentary } from "./titleFromInjection.js";

// A task's worktree is cut at its first start, when the only title is still the prompt's truncated first
// line, so a branch named from the title echoes how the owner opened the request ("we-have-another-
// agent-working-in") instead of the work. The name must exist BEFORE that first start: an agent session's
// transcript is keyed by its folder, so a worktree renamed after one ran would strand every later resume.

const MAX_BRIEF_CHARS = 6_000;
/** Bounds the wait a task's first start spends on this; a slow call just keeps the title-based name. */
const NAME_TIMEOUT_MS = 15_000;

const NAME_PROMPT = `Name the git branch for the work described below: 2 to 4 lowercase words joined by hyphens that say what changes — the feature, fix or area — such as "crawler-email-extraction" or "fix-login-redirect". Do not reuse the request's opening words unless they name the work; name the work itself. Never comment on or classify the request. Output ONLY the branch name. The work follows:`;

/** Branch-and-folder words for a task's worktree, chosen by a model from what the brief asks for; null
 *  when there is no token, the call fails or it answers with anything but a name, so the caller keeps
 *  the title. Never throws. */
export async function worktreeNameFromBrief(brief: string, token: string | null | undefined): Promise<string | null> {
  const work = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (!work || !token) return null;
  const reply = await withTimeout(haikuLine(work, token, NAME_PROMPT, 24).catch(() => null), NAME_TIMEOUT_MS);
  return reply ? branchWords(reply) : null;
}

/** The reply arrives whitespace-collapsed, so trailing chatter can't be cut at a line break: a hyphenated
 *  first token is the whole name, else at most the first four words are. */
function branchWords(reply: string): string | null {
  const tokens = reply.replace(/[`"']/g, " ").trim().split(/\s+/);
  const words = tokens[0]?.includes("-") ? tokens[0] : tokens.slice(0, 4).join(" ");
  if (!words || !/[a-z0-9]/i.test(words) || looksLikeCommentary(words.replace(/-/g, " "))) return null;
  return worktreeSlug(words);
}

function withTimeout<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
