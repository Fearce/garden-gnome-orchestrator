import type { ChatScope } from "../types.js";

/**
 * CLI backends (Codex, Grok) have no office MCP tools. Implementors post by emitting a standalone
 * `OFFICE[team|office]: <msg>` marker in assistant text; the runner intercepts it, strips it from the
 * task transcript, and posts through the real office chat backend.
 *
 * Matching is deliberately looser than "whole line only":
 * - Grok streaming-json often concatenates successive model turns WITHOUT newlines
 *   (`...done.OFFICE[team]: claiming fooI'll keep going`), so a `^...$` line regex silently drops posts.
 * - Models also copy the doctrine's backtick wrapping: `` `OFFICE[team]: msg` ``.
 *
 * Body ends at the next newline, the next OFFICE marker, or end-of-string (then capped at 500 chars).
 */
const OFFICE_CHAT_RE =
  /`?OFFICE\[(team|office)\]\s*:\s*([^`\n]+?)`?(?=\s*(?:\n|`?OFFICE\[|$))/gi;

export function extractOfficeChat(text: string): {
  visible: string;
  posts: Array<{ scope: ChatScope; body: string }>;
} {
  const posts: Array<{ scope: ChatScope; body: string }> = [];
  if (!text) return { visible: "", posts };

  const visible = text
    .replace(OFFICE_CHAT_RE, (_match, scopeRaw: string, bodyRaw: string) => {
      const body = String(bodyRaw ?? "").trim();
      if (body) {
        posts.push({
          scope: String(scopeRaw).toLowerCase() === "office" ? "general" : "project",
          body: body.slice(0, 500),
        });
      }
      // Drop the marker; leave a newline so surrounding sentences don't glue together.
      return "\n";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { visible, posts };
}
