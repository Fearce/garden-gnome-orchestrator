import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveRepoRoot, runGit } from "../gitService.js";

/** How a workspace is named across the internet. `key` is what rooms are keyed on (never shown);
 *  `label` is what a human reads in the console and the relay's admin page.
 *
 *  `aliases` are the OTHER identities of the same repository — every remote this checkout has besides the
 *  one `key` came from. A fork is the case that needs them: one checkout's `origin` is `upstream/gg`
 *  and another's is `contributor/gg`, so keying on `origin` alone puts two people editing one codebase in two rooms
 *  that can never see each other. Whichever side has the other's remote configured (a fork checkout's
 *  `upstream`, or a fork remote on the upstream side) supplies the link, and the two group. */
export interface RepoIdentity {
  key: string;
  label: string;
  aliases: string[];
}

/** Every identity a checkout answers to — `key` first, then its aliases. The unit of comparison for
 *  "are these two agents in the same repository": two identities match when these sets INTERSECT. */
export function identityKeys(id: RepoIdentity): string[] {
  return [id.key, ...id.aliases];
}

/** Whether two checkouts are the same repository. Deliberately not `a.key === b.key`: one side may know
 *  the link the other doesn't, and one side knowing it is enough. */
export function identitiesMatch(a: RepoIdentity, keys: readonly string[]): boolean {
  const mine = new Set(identityKeys(a));
  return keys.some((k) => mine.has(k));
}

/** The repository's bare name — `github.com/acme/storefront` → `storefront`, `name:scratch` →
 *  `scratch`. Two keys sharing a leaf are SUSPECTED of being one repo (a fork), never assumed to be:
 *  two similarly named repos on different accounts can be unrelated,
 *  which is why a matching leaf reports a suggestion and an explicit remote is what actually links them. */
export function repoLeaf(key: string): string {
  const bare = key.startsWith("name:") ? key.slice(5) : key;
  return bare.split("/").filter(Boolean).at(-1) ?? bare;
}

/**
 * The identity of the repository a task is working in — the thing two people's checkouts have in common.
 *
 * The LOCAL office keys its project rooms on `normalizeWorkspace(thread.workspace)`, a filesystem path.
 * That is exactly right on one machine and useless across the internet: two different local paths
 * can be the same repository and would never group. So the online room
 * key is the repository's REMOTE identity — host + owner + name, stripped of scheme, credentials, `.git`
 * and case — which both checkouts agree on because they were cloned from it.
 *
 * A remote-less repo that HOLDS a clone (a scratch `git init` at `C:\work` with the real checkout in
 * `C:\work\game-overlay`) is the clone's repository: that is what its agents edit, and a folder
 * name chosen locally must not keep them out of the clone's room. See `nestedIdentity`.
 *
 * Otherwise a workspace with no remote falls back to `name:<folder>`. Two people who both have a
 * `storefront` folder still meet; two people who don't, don't. That is the best available answer
 * without a remote, and it is a strictly better default than not grouping at all.
 */
export async function repoIdentity(workspace: string): Promise<RepoIdentity | null> {
  const cached = cache.get(workspace);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.identity;
  // Callers ask on every roster pass and relay message, and a git read waits behind the shared child
  // pool. Without sharing the pending read, each ask while one was queued spawned another `git config`
  // (179 waited over 5s in one minute after a restart), which deepened the queue they were waiting in.
  const pending = resolving.get(workspace);
  if (pending) return pending;
  const read: Promise<RepoIdentity | null> = resolve(workspace)
    .then((identity) => {
      // A forget during the read means its answer may already be stale; the next ask reads again.
      if (resolving.get(workspace) === read) cache.set(workspace, { at: Date.now(), identity });
      return identity;
    })
    .finally(() => {
      if (resolving.get(workspace) === read) resolving.delete(workspace);
    });
  resolving.set(workspace, read);
  return read;
}

/** Drop a resolved identity so the next lookup re-reads git — used when a task's repo may have changed
 *  under us (a remote added, a workspace re-pointed). */
export function forgetRepoIdentity(workspace?: string): void {
  if (workspace) {
    cache.delete(workspace);
    resolving.delete(workspace);
  } else {
    cache.clear();
    resolving.clear();
  }
}

/**
 * Normalize a git remote URL to a stable cross-machine key. Every form of the same remote collapses to
 * one string:
 *
 *   git@github.com:Acme/storefront.git   ┐
 *   https://github.com/Acme/storefront    ├─→  github.com/acme/storefront
 *   ssh://git@github.com/Acme/storefront/ ┘
 *
 * Exported for the unit gate — this function is the whole feature's hinge, and it is pure.
 */
export function normalizeRemote(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme
  s = s.replace(/^[^/@]+@/, ""); // user (and any password already stripped with the scheme's authority)
  s = s.replace(/^([^/:]+):(?!\d)/, "$1/"); // scp-style "host:owner/repo" → "host/owner/repo"
  s = s.replace(/^([^/:]+):\d+\//, "$1/"); // an explicit port is not part of the identity
  // Trailing slashes come off FIRST: a copied browser URL can end `…/storefront.git/`, where stripping
  // `.git` before the slash leaves it in the key and silently forks the room.
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  s = s.replace(/\/{2,}/g, "/").toLowerCase();
  // The relay validates room keys against a conservative character class; anything outside it would be
  // refused there, so refuse it here where the reason is visible.
  return /^[a-z0-9][a-z0-9._+\-/@]*\/[a-z0-9._+\-/@]+$/.test(s) ? s : null;
}

/** The human label for a normalized key: the last two segments, in the remote's own casing where we
 *  have it ("Acme/storefront"), else just the folder name. */
export function remoteLabel(url: string): string {
  const bare = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^/@]+@/, "")
    .replace(/:(?!\d)/, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = bare.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || bare;
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; identity: RepoIdentity | null }>();
const resolving = new Map<string, Promise<RepoIdentity | null>>();

async function resolve(workspace: string): Promise<RepoIdentity | null> {
  const root = await resolveRepoRoot(workspace);
  if (!root) return null;
  const own = fromRemotes(await remoteUrls(root));
  if (own) return own;
  const nested = await nestedIdentity(workspace);
  if (nested) return nested;
  const leaf = basename(root.replace(/[\\/]+$/, ""));
  const slug = leaf.toLowerCase().replace(/[^a-z0-9._+-]/g, "-");
  return slug ? { key: `name:${slug}`, label: leaf, aliases: [] } : null;
}

/** The identity a checkout's remotes give it: the first normalizable remote is primary, the rest aliases. */
function fromRemotes(remotes: { name: string; url: string }[]): RepoIdentity | null {
  const primary = remotes.find((r) => normalizeRemote(r.url));
  if (!primary) return null;
  const key = normalizeRemote(primary.url) as string;
  const aliases = [...new Set(remotes.map((r) => normalizeRemote(r.url)).filter((k): k is string => !!k && k !== key))];
  return { key, label: remoteLabel(primary.url), aliases };
}

/**
 * The identity of the remote-backed checkout directly inside a remote-less workspace.
 *
 * Only immediate children are read, and they must ALL name the same repository (sibling worktrees of one
 * clone do). Two different repositories side by side leave the workspace on its folder name: picking
 * either would seat its agents in an unrelated project's room. The folder's own `name:` key is not kept
 * as an alias, because another machine's same-named folder is no evidence of a shared repository.
 */
async function nestedIdentity(workspace: string): Promise<RepoIdentity | null> {
  let children: string[];
  try {
    children = readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => join(workspace, e.name))
      .filter((dir) => existsSync(join(dir, ".git")));
  } catch {
    return null; // unreadable folder
  }
  const found: RepoIdentity[] = [];
  for (const dir of children) {
    const id = fromRemotes(await remoteUrls(dir));
    if (id) found.push(id);
  }
  const first = found[0];
  if (!first || found.some((id) => id.key !== first.key)) return null;
  return { ...first, aliases: [...new Set(found.flatMap((id) => id.aliases))] };
}

/**
 * Every remote this checkout has, `origin` first — one `git config` read rather than a `get-url` per
 * remote. Order decides which identity is PRIMARY (the room this instance posts into and the label a
 * human sees), and `origin` staying first is what keeps the key unchanged for every checkout that isn't
 * a fork. The rest become aliases: a fork-style checkout may only have `upstream`, and a checkout with
 * neither still answers to whatever single remote it does have.
 */
async function remoteUrls(root: string): Promise<{ name: string; url: string }[]> {
  const res = await runGit(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (res.code !== 0) return [];
  const found: { name: string; url: string }[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^remote\.(.+)\.url\s+(\S.*)$/.exec(line.trim());
    const name = m?.[1];
    const url = m?.[2]?.trim();
    if (name && url) found.push({ name, url });
  }
  return found.sort((a, b) => rank(a.name) - rank(b.name));
}

/** `origin` outranks everything; `upstream` is the next most likely to be the canonical repo. */
const rank = (name: string): number => (name === "origin" ? 0 : name === "upstream" ? 1 : 2);
