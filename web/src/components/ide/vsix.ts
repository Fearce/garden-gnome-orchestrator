import { strFromU8, unzipSync } from "fflate";
import { parseSnippets, type Snippet } from "./snippets.js";
export interface SnippetExtension { id: string; version: string; license: string; snippets: Snippet[]; ignored: string[] }
const MAX_ARCHIVE = 5 * 1024 * 1024;
const safePath = (p: string) => !/[\\:\x00-\x1f]/.test(p) && p.split("/").every(s => s && s !== "." && s !== "..");
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Extract ONLY declared snippet data, in memory. Never write archives to the host, import JS,
 * execute entry points or evaluate package scripts. Reject oversized and ambiguous entries first. */
export function readSnippetVsix(bytes: Uint8Array): SnippetExtension {
  if (bytes.length > MAX_ARCHIVE) throw new Error("VSIX packages must be under 5 MB.");
  const extract = (wanted: Set<string>) => {
    let total = 0, entries = 0;
    const seen = new Set<string>();
    const files = unzipSync(bytes, { filter(file) {
      if (++entries > 5000) throw new Error("Too many archive entries.");
      if (!wanted.has(file.name)) return false;
      if (seen.has(file.name)) throw new Error("Duplicate VSIX contribution path.");
      seen.add(file.name); total += file.originalSize;
      if (file.originalSize > 200_000 || total > 1_000_000) throw new Error("VSIX snippet data exceeds the import limit.");
      return true;
    } });
    for (const path of wanted) if (!Object.hasOwn(files, path)) throw new Error(`VSIX is missing ${path}.`);
    return files;
  };
  const manifestBytes = extract(new Set(["extension/package.json"]))["extension/package.json"]!;
  const manifest: unknown = JSON.parse(strFromU8(manifestBytes));
  if (!record(manifest) || typeof manifest.name !== "string" || typeof manifest.publisher !== "string" || typeof manifest.version !== "string" || !record(manifest.contributes)) throw new Error("VSIX has no valid extension manifest.");
  const declarations = manifest.contributes.snippets;
  if (!Array.isArray(declarations) || !declarations.length || declarations.length > 40) throw new Error("This extension has no supported snippet contributions (limit: 40 files).");
  const wanted = new Set<string>();
  const contributions = declarations.map(value => {
    if (!record(value) || typeof value.path !== "string" || (value.language !== undefined && typeof value.language !== "string")) throw new Error("Invalid snippet contribution.");
    const path = value.path.replace(/^\.\//, "");
    if (!safePath(path) || !/\.(json|code-snippets)$/i.test(path)) throw new Error("Snippet contributions must reference JSON files inside the extension.");
    const key = `extension/${path}`; wanted.add(key);
    return { path: key, language: value.language as string | undefined };
  });
  const files = extract(wanted);
  const snippets = contributions.flatMap(c => parseSnippets(strFromU8(files[c.path]!)).map(s => ({ ...s, scope: c.language ? [c.language] : s.scope })));
  if (snippets.length > 200) throw new Error("Extension exceeds the 200-snippet limit.");
  const ignored = Object.keys(manifest.contributes).filter(k => k !== "snippets");
  if (manifest.main || manifest.browser) ignored.push("executable extension code");
  return { id: `${manifest.publisher}.${manifest.name}`.slice(0, 200), version: manifest.version.slice(0, 50), license: typeof manifest.license === "string" ? manifest.license.slice(0, 150) : "Not declared by publisher", snippets, ignored };
}

export function snippetSource(snippets: Snippet[]): string {
  return JSON.stringify(Object.fromEntries(snippets.map((s, i) => [`${s.name} (${i + 1})`, { prefix: s.prefixes, body: s.body, scope: s.scope.join(","), description: s.description }])));
}
