import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { normalizeRecentRepo, recentRepoKey, type QuestionOption } from "../types.js";
import { SKIP } from "./findWorkspace.js";
import type { AskUserInput } from "../orchestrator/api.js";

/**
 * AUTO repo mode: pick the repository a composer send is about without the owner typing a path.
 *
 * The decision is deliberately conservative. A path the owner wrote in the message is authoritative; a
 * repo the message names unambiguously is used; a follow-up with no repo of its own continues the last
 * request's repo. Everything else (no signal, two similar names, a path that does not exist) becomes a
 * question with named candidates, never a guess. Only directories that exist right now are candidates,
 * and a task worktree (`<repo>.worktrees/<name>`) always stands for its main checkout.
 */

export interface RepoCandidate {
  path: string;
  label: string;
  /** Why it is offered, in words the owner reads in the picker. */
  why: string;
}

export type AutoRepoDecision =
  | { kind: "resolved"; repos: string[]; reason: string }
  | {
      kind: "ask";
      reason: "none" | "ambiguous" | "multiple" | "missing";
      candidates: RepoCandidate[];
      /** Several projects were named: the owner may pick more than one, and each gets its own task. */
      multiSelect: boolean;
      /** The explicit path that does not exist, for `missing`. */
      missingPath?: string;
    };

export interface AutoRepoContext {
  /** The composer's remembered repos, most recent first. */
  recent: string[];
  /** Workspaces earlier tasks ran in. */
  taskWorkspaces: string[];
  /** Directories scanned for git repositories (WORKSPACE_SEARCH_ROOTS). */
  searchRoots: string[];
  /** The repo the previous request in this conversation went to, if it is still recent enough to continue. */
  lastRepo?: string | null;
}

const CANDIDATE_LIMIT = 8;
const STRONG = 6;

// Words that name a kind of thing rather than a project. A repo called "web" must not claim every
// message about a web page, so these never count as a match on their own.
const GENERIC = new Set([
  "app", "apps", "api", "web", "site", "server", "client", "service", "services", "project", "projects",
  "repo", "repos", "repository", "code", "src", "lib", "libs", "core", "main", "test", "tests", "docs",
  "data", "tool", "tools", "util", "utils", "scripts", "demo", "example", "examples", "new", "old",
  "the", "and", "for", "with", "fix", "add", "update", "frontend", "backend", "ui", "cli", "bot",
]);

const FOLLOW_UP = [
  /^\s*(also|and|then|plus|additionally|next|again|same|continue|follow[- ]?up)\b/i,
  /\b(same repo|same project|that repo|this repo|that project|this project|there too|in there|as well|while you'?re there|the same place)\b/i,
];

/** A task worktree stands for the repo it was cut from: `C:\r\app.worktrees\x` → `C:\r\app`. */
export function mainCheckoutOf(path: string): string {
  const parts = normalizeRecentRepo(path).split(/[/\\]/);
  const at = parts.findIndex((p) => p.toLowerCase().endsWith(".worktrees"));
  if (at <= 0) return normalizeRecentRepo(path);
  const sep = path.includes("\\") || /^[A-Za-z]:/.test(path) ? "\\" : "/";
  parts[at] = parts[at]!.slice(0, -".worktrees".length);
  return normalizeRecentRepo(parts.slice(0, at + 1).join(sep));
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isRepo = (p: string): boolean => existsSync(join(p, ".git"));

/** The workspace an existing path stands for: a directory exactly as written, a file its nearest git checkout. */
function workspaceFor(path: string): string {
  if (isDir(path)) return path;
  const dir = dirname(path);
  for (let cur = dir; ; ) {
    if (isRepo(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return dir;
}

/** Absolute paths written in the message, trailing sentence punctuation and quotes removed. URLs are not paths. */
export function explicitPaths(text: string): string[] {
  const found: Array<{ path: string; at: number }> = [];
  // Match quoted/code-formatted paths first, preserving spaces. Mask their entire span so the
  // unquoted matcher cannot reinterpret a prefix as a different authoritative path.
  const unquoted = text.replace(/(["'`])([^\r\n]*?)\1/g, (span: string, _quote: string, value: string, at: number) => {
    if (!/^(?:[A-Za-z]:[\\/]|\/|~\/|\\\\)/.test(value)) return span;
    found.push({ path: value, at });
    return " ".repeat(span.length);
  });
  const windows = /(?<![\w/])([A-Za-z]:[\\/][^\s"'`<>|*?]*)/g;
  const posix = /(?:^|[\s("'`])((?:~|\/)(?:[^\s"'`<>|*?/]+\/?){2,})/g;
  for (const re of [windows, posix]) {
    for (const m of unquoted.matchAll(re)) {
      const raw = m[1]!.replace(/[.,;:!)\]}]+$/, "");
      if (raw.length > 3) found.push({ path: raw, at: m.index! });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((p) => p.path))];
}

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface NameMatch {
  score: number;
  /** The words of the repo name the message matched, used to prefer the more specific of two names. */
  phrase: string;
}

/** How strongly a message names a repo: the whole name, its acronym, all its words, or one distinctive word. */
export function nameMatch(repoPath: string, message: string): NameMatch | null {
  const name = basename(mainCheckoutOf(repoPath));
  const tokens = words(name);
  if (!tokens.length) return null;
  const said = ` ${words(message).join(" ")} `;
  const compact = message.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const phrase = tokens.join(" ");
  const generic = tokens.every((t) => GENERIC.has(t));
  if (said.includes(` ${phrase} `) || (tokens.length > 1 && ` ${compact} `.includes(` ${tokens.join("")} `))) {
    return { score: generic ? 3 : 10 + tokens.length, phrase };
  }
  const acronym = tokens.map((t) => t[0]).join("");
  if (tokens.length >= 3 && said.includes(` ${acronym} `)) return { score: 8, phrase };
  const distinctive = tokens.filter((t) => t.length >= 4 && !GENERIC.has(t));
  if (tokens.length > 1 && tokens.every((t) => said.includes(` ${t} `)) && distinctive.length) return { score: STRONG, phrase };
  const hits = distinctive.filter((t) => said.includes(` ${t} `));
  return hits.length ? { score: 3, phrase: hits.join(" ") } : null;
}

const discovered = new Map<string, { at: number; repos: string[] }>();
const DISCOVERY_TTL_MS = 60_000;

/** Git checkouts directly under each root and one level below, skipping task worktree folders and system noise. */
export function discoverRepos(roots: string[], opts: { maxDepth?: number; scanCap?: number; timeBudgetMs?: number } = {}): string[] {
  const key = roots.join("|");
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.repos;
  const maxDepth = opts.maxDepth ?? 2;
  let budget = opts.scanCap ?? 4000;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 1500);
  const repos: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || budget <= 0 || Date.now() > deadline) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget <= 0 || Date.now() > deadline) return;
      if (!e.isDirectory()) continue;
      const lname = e.name.toLowerCase();
      if (lname.startsWith("$") || lname.startsWith(".") || lname.endsWith(".worktrees") || SKIP.has(lname)) continue;
      budget--;
      const full = join(dir, e.name);
      if (isRepo(full)) repos.push(full);
      else walk(full, depth + 1);
    }
  };
  for (const root of roots) if (isDir(root)) walk(root, 1);
  discovered.set(key, { at: Date.now(), repos });
  return repos;
}

interface Known {
  path: string;
  source: "recent" | "task" | "found";
  rank: number;
}

/** Every verified workspace the owner has used or keeps beside one: recents, earlier tasks' repos, and
 *  git checkouts in the same parent folders and the search roots. One entry per workspace, worktrees folded in. */
export function knownRepos(ctx: AutoRepoContext): Known[] {
  const out = new Map<string, Known>();
  const add = (raw: string, source: Known["source"]) => {
    if (!raw?.trim()) return;
    const path = mainCheckoutOf(raw);
    const key = recentRepoKey(path);
    if (out.has(key) || !isDir(path)) return;
    out.set(key, { path, source, rank: out.size });
  };
  for (const p of ctx.recent) add(p, "recent");
  for (const p of ctx.taskWorkspaces) add(p, "task");
  const parents = [...new Set([...out.values()].map((k) => dirname(k.path)))];
  for (const p of discoverRepos([...parents, ...ctx.searchRoots])) add(p, "found");
  return [...out.values()];
}

const labelOf = (p: string): string => basename(p) || p;

function candidate(path: string, why: string): RepoCandidate {
  return { path, label: labelOf(path), why };
}

const SOURCE_WHY: Record<Known["source"], string> = {
  recent: "recently used",
  task: "earlier task",
  found: "found on disk",
};

/** Fill a candidate list with the last repo and the most recently used ones after the matches. */
function withFallbacks(first: RepoCandidate[], known: Known[], lastRepo?: string | null): RepoCandidate[] {
  const list = [...first];
  const seen = new Set(list.map((c) => recentRepoKey(c.path)));
  const push = (c: RepoCandidate) => {
    const key = recentRepoKey(c.path);
    if (seen.has(key) || list.length >= CANDIDATE_LIMIT) return;
    seen.add(key);
    list.push(c);
  };
  if (lastRepo && isDir(lastRepo)) push(candidate(mainCheckoutOf(lastRepo), "previous request"));
  for (const k of known.filter((k) => k.source !== "found")) push(candidate(k.path, SOURCE_WHY[k.source]));
  return list;
}

/** Decide the repo for one AUTO send. Pure apart from reading which directories exist. */
export function resolveAutoRepo(text: string, ctx: AutoRepoContext): AutoRepoDecision {
  const known = knownRepos(ctx);

  // 1. A path the owner wrote is authoritative: a directory is used as written, a file stands for its checkout.
  const paths = explicitPaths(text);
  if (paths.length) {
    const existing = [...new Map(paths.filter(existsSync).map(workspaceFor).map((p) => [recentRepoKey(p), p])).values()];
    const missing = paths.find((p) => !existsSync(p));
    if (!missing) return { kind: "resolved", repos: existing.map(normalizeRecentRepo), reason: "path in your message" };
    const near = known
      .map((k) => ({ k, m: nameMatch(k.path, missing!) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => candidate(x.k.path, "similar name"));
    return {
      kind: "ask", reason: "missing", missingPath: missing,
      candidates: withFallbacks([...existing.map((p) => candidate(p, "path in your message")), ...near], known, ctx.lastRepo),
      multiSelect: paths.length > 1,
    };
  }

  // 2. Repos the message names. The more specific of two overlapping names wins ("tilebreaker old" over "tilebreaker").
  const scored = known
    .map((k) => ({ k, m: nameMatch(k.path, text) }))
    .filter((x): x is { k: Known; m: NameMatch } => !!x.m)
    .sort((a, b) => b.m.score - a.m.score || a.k.rank - b.k.rank);
  const strong = scored.filter((x) => x.m.score >= STRONG);
  const namedText = words(text).join(" ");
  const specific = strong.filter(
    (x) => !strong.some((y) => {
      if (y === x || y.m.phrase === x.m.phrase || !` ${y.m.phrase} `.includes(` ${x.m.phrase} `)) return false;
      // Prune the shorter name only when it was mentioned solely inside the longer one. An
      // independent mention ("tilebreaker and tilebreaker-old") still means both projects.
      const remaining = namedText.replace(new RegExp(`\\b${y.m.phrase}\\b`, "g"), " ");
      return (nameMatch(x.k.path, remaining)?.score ?? 0) < STRONG;
    }),
  );
  if (specific.length === 1) {
    const only = specific[0]!.k.path;
    return { kind: "resolved", repos: [only], reason: `your message names ${labelOf(only)}` };
  }
  if (specific.length > 1) {
    // Two projects named outright, or one name that exists in two places (equal phrases are never pruned).
    const named = scored.filter((x) => x.m.score >= STRONG).map((x) => candidate(x.k.path, x.k.source === "found" ? "named · found on disk" : `named · ${SOURCE_WHY[x.k.source]}`));
    const distinctNames = new Set(specific.map((x) => labelOf(x.k.path).toLowerCase()));
    const multiple = distinctNames.size > 1;
    return { kind: "ask", reason: multiple ? "multiple" : "ambiguous", candidates: withFallbacks(named, known, ctx.lastRepo), multiSelect: multiple };
  }

  // 3. A follow-up with no repo of its own continues the previous request's repo.
  if (!scored.length && ctx.lastRepo && isDir(ctx.lastRepo) && FOLLOW_UP.some((re) => re.test(text))) {
    return { kind: "resolved", repos: [mainCheckoutOf(ctx.lastRepo)], reason: "follow-up to your previous request" };
  }

  // 4. Nothing decisive: ask, with the weak matches first.
  const weak = scored.map((x) => candidate(x.k.path, "partly named"));
  return { kind: "ask", reason: weak.length ? "ambiguous" : "none", candidates: withFallbacks(weak, known, ctx.lastRepo), multiSelect: false };
}

/** The owner-facing question for an `ask` decision. */
export function autoRepoQuestion(decision: Extract<AutoRepoDecision, { kind: "ask" }>): { header: string; question: string; options: QuestionOption[] } {
  const question =
    decision.reason === "missing"
      ? `\`${decision.missingPath}\` doesn't exist. Which repo did you mean?`
      : decision.reason === "multiple"
        ? "Your message names more than one repo. Pick every repo this is for; each gets its own task."
        : decision.reason === "ambiguous"
          ? "More than one repo could fit this request. Which one is it for?"
          : "I couldn't tell which repo this is for. Pick one, or search for it.";
  return {
    header: "Which repo?",
    question,
    options: decision.candidates.map((c) => ({ label: c.label, description: c.path })),
  };
}

/** The repo paths in a repo-picker answer: one per line, each an existing directory. Anything else (a
 *  timeout notice, a dismissal) yields nothing, so the caller never dispatches into a guessed path. */
export function parseRepoAnswer(answer: string): string[] {
  const paths = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && isDir(line))
    .map(normalizeRecentRepo);
  return [...new Map(paths.map((p) => [recentRepoKey(p), p])).values()];
}

/** Picker options for the candidate paths that exist right now, one per workspace, in the given order. */
export function repoOptions(paths: string[]): QuestionOption[] {
  const seen = new Set<string>();
  const options: QuestionOption[] = [];
  for (const raw of paths) {
    const path = raw?.trim() ? normalizeRecentRepo(raw) : "";
    if (!path || !isDir(path) || seen.has(recentRepoKey(path))) continue;
    seen.add(recentRepoKey(path));
    options.push({ label: labelOf(path), description: path });
  }
  return options;
}

/** The director's repo question (ask_user with `repos`): a repo picker over the candidates that exist, and
 *  a tool result stating the chosen path(s) or that nothing was picked, so it never dispatches on a guess. */
export async function askRepoChoice(
  api: { askUser(input: AskUserInput): Promise<string> },
  input: { header: string; question: string; repos: string[]; multiSelect: boolean },
): Promise<{ text: string; error?: true }> {
  const options = repoOptions(input.repos);
  if (!options.length) {
    return { text: "None of those repo paths exist. Call find_workspace for real candidates, then ask again.", error: true };
  }
  const answer = await api.askUser({ threadId: null, header: input.header, question: input.question, options, multiSelect: input.multiSelect, kind: "repo" });
  const picked = parseRepoAnswer(answer);
  return picked.length
    ? { text: `Chosen repo${picked.length > 1 ? "s (one task per repo)" : ""}:\n${picked.join("\n")}` }
    : { text: `No repo was picked (${answer.trim().slice(0, 120)}). Do NOT dispatch; tell the owner nothing was sent and why.` };
}

/** Repos for the picker's search box: known workspaces whose name or path contains every typed word. */
export function searchRepos(query: string, ctx: AutoRepoContext, limit = 12): RepoCandidate[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const known = knownRepos(ctx);
  const hits = terms.length ? known.filter((k) => terms.every((t) => k.path.toLowerCase().includes(t))) : known;
  return hits.slice(0, limit).map((k) => candidate(k.path, SOURCE_WHY[k.source]));
}
