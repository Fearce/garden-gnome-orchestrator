import { parse, type ParseError } from "jsonc-parser";
export interface Snippet { name: string; prefixes: string[]; body: string; scope: string[]; description: string }
/** Read the declarative VS Code snippet format. No extension JS, commands or URLs execute. */
export function parseSnippets(source: string): Snippet[] {
  if (source.length > 200_000) throw new Error("Snippet file must be under 200 KB.");
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a VS Code snippet JSON object (comments are allowed).");
  const result: Snippet[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid snippet: ${name}`);
    const s = raw as Record<string, unknown>;
    const prefixes = typeof s.prefix === "string" ? [s.prefix] : s.prefix;
    const body = typeof s.body === "string" ? s.body : Array.isArray(s.body) && s.body.every(x => typeof x === "string") ? s.body.join("\n") : null;
    if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some(p => typeof p !== "string" || !p || p.length > 100) || body === null || body.length > 20_000 || (s.scope !== undefined && typeof s.scope !== "string")) throw new Error(`Invalid prefix, body or scope in “${name}”.`);
    result.push({ name: name.slice(0, 100), prefixes, body, scope: typeof s.scope === "string" ? s.scope.split(",").map(x => x.trim()).filter(Boolean) : [], description: typeof s.description === "string" ? s.description.slice(0, 500) : name });
  }
  if (!result.length || result.length > 200) throw new Error("Import between 1 and 200 snippets.");
  return result;
}
