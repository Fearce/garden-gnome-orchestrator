import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { runChild } from "../childRunner.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

// Shared with the standalone agent CLI, so UI actions and agents use the same OS lock.
const transactions = createRequire(import.meta.url)("../../scripts/git-transaction.cjs") as {
  withCommonDirectory<T>(commonDir: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
  isGitWrite(args: string[]): boolean;
};
export const isGitWrite = transactions.isGitWrite;
const ownedCheckouts = new AsyncLocalStorage<ReadonlySet<string>>();

export async function withGitTransaction<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(cwd);
  const owned = ownedCheckouts.getStore();
  if (owned?.has(key)) return fn();
  // CreateProcess stays off the event loop, as for every other server Git call.
  const result = await runChild("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, timeoutMs: 15_000, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, urgent: true,
  });
  if (result.code !== 0) throw new Error(result.stderr || "Cannot resolve Git transaction directory.");
  return transactions.withCommonDirectory(await realpath(result.stdout.trim()), () =>
    ownedCheckouts.run(new Set([...(owned ?? []), key]), fn));
}
