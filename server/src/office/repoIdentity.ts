import { basename } from "node:path";
import { resolveRepoRoot, runGit } from "../gitService.js";

/** How a workspace is named across the internet. `key` is what rooms are keyed on (never shown);
 *  `label` is what a human reads in the console and the relay's admin page. */
export interface RepoIdentity {
  key: string;
  label: string;
}

/**
 * The identity of the repository a task is working in — the thing two people's checkouts have in common.
 *
 * The LOCAL office keys its project rooms on `normalizeWorkspace(thread.workspace)`, a filesystem path.
 * That is exactly right on one machine and useless across the internet: Kevin's `C:\repos\card-marker`
 * and a friend's `~/dev/card-marker` are the same repository and would never group. So the online room
 * key is the repository's REMOTE identity — host + owner + name, stripped of scheme, credentials, `.git`
 * and case — which both checkouts agree on because they were cloned from it.
 *
 * A workspace with no remote (a scratch repo, a fresh `git init`) falls back to `name:<folder>`. Two
 * people who both have a `card-marker` folder still meet; two people who don't, don't. That is the best
 * available answer without a remote, and it is a strictly better default than not grouping at all.
 */
export async function repoIdentity(workspace: string): Promise<RepoIdentity | null> {
  const cached = cache.get(workspace);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.identity;
  const identity = await resolve(workspace);
  cache.set(workspace, { at: Date.now(), identity });
  return identity;
}

/** Drop a resolved identity so the next lookup re-reads git — used when a task's repo may have changed
 *  under us (a remote added, a workspace re-pointed). */
export function forgetRepoIdentity(workspace?: string): void {
  if (workspace) cache.delete(workspace);
  else cache.clear();
}

/**
 * Normalize a git remote URL to a stable cross-machine key. Every form of the same remote collapses to
 * one string:
 *
 *   git@github.com:Fearce/card-marker.git   ┐
 *   https://github.com/Fearce/card-marker    ├─→  github.com/fearce/card-marker
 *   ssh://git@github.com/Fearce/card-marker/ ┘
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
  // Trailing slashes come off FIRST: a copied browser URL can end `…/card-marker.git/`, where stripping
  // `.git` before the slash leaves it in the key and silently forks the room.
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  s = s.replace(/\/{2,}/g, "/").toLowerCase();
  // The relay validates room keys against a conservative character class; anything outside it would be
  // refused there, so refuse it here where the reason is visible.
  return /^[a-z0-9][a-z0-9._+\-/@]*\/[a-z0-9._+\-/@]+$/.test(s) ? s : null;
}

/** The human label for a normalized key: the last two segments, in the remote's own casing where we
 *  have it ("Fearce/card-marker"), else just the folder name. */
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

async function resolve(workspace: string): Promise<RepoIdentity | null> {
  const root = await resolveRepoRoot(workspace);
  if (!root) return null;
  const remote = await originUrl(root);
  if (remote) {
    const key = normalizeRemote(remote);
    if (key) return { key, label: remoteLabel(remote) };
  }
  const leaf = basename(root.replace(/[\\/]+$/, ""));
  const slug = leaf.toLowerCase().replace(/[^a-z0-9._+-]/g, "-");
  return slug ? { key: `name:${slug}`, label: leaf } : null;
}

/** `origin` if it exists, else the first remote — a fork-style checkout may only have `upstream`. */
async function originUrl(root: string): Promise<string | null> {
  const origin = await runGit(root, ["remote", "get-url", "origin"]);
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim();
  const all = await runGit(root, ["remote"]);
  const first = all.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  const url = await runGit(root, ["remote", "get-url", first]);
  return url.code === 0 && url.stdout.trim() ? url.stdout.trim() : null;
}
