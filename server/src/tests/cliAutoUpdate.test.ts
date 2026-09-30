import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildResult } from "../childRunner.js";
import type { CodexLauncher } from "../agents/codexLauncher.js";
import { ModelCatalog } from "../agents/modelCatalog.js";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import { HighlightNews, newlySeenModels } from "../news/highlightNews.js";
import { CliAutoUpdater, compareVersions, lockChanges, sweepAsideCopies, type CliAutoUpdaterDeps, type RegistryRelease } from "../toolchain/cliAutoUpdate.js";
import type { CliAutoUpdateStatus, HighlightNewsItem } from "../types.js";

// The CLI auto-updater and the highlighted-news feed. The updater's shell-outs (npm, git, tsc) go through
// an injected exec that plays npm and git against a real temp tree — package files, lockfile, installed
// packages, staging folders and a git HEAD — so each scenario asserts what would have happened on disk
// without touching the network, this checkout or the global npm prefix.

const tasks: Array<{ name: string; run: () => Promise<void> | void }> = [];
const check = (name: string, run: () => Promise<void> | void): void => {
  tasks.push({ name, run });
};

function fakeKv(): { kvGet: (k: string) => string | null; kvSet: (k: string, v: string) => void; map: Map<string, string> } {
  const map = new Map<string, string>();
  return { kvGet: (k) => map.get(k) ?? null, kvSet: (k, v) => void map.set(k, v), map };
}

const ok = (stdout = ""): ChildResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): ChildResult => ({ code: 1, stdout: "", stderr, timedOut: false });

const SDK = "@anthropic-ai/claude-agent-sdk";
const NATIVE = `claude-agent-sdk-${process.platform}-${process.arch}`;
const runtimeOf = (sdk: string): string => `2.1.${sdk.split(".")[2]}`;

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

function packageJson(sdk: string): string {
  return JSON.stringify({ name: "server", scripts: { build: "tsc" }, dependencies: { [SDK]: `^${sdk}`, zod: "^4.0.0" } }, null, 2) + "\n";
}

/** The shape npm writes: the SDK, this platform's binary package, another platform's (never installed
 *  here), and an unrelated package that must never be touched. */
function lockfile(sdk: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify(
      {
        name: "server",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { [SDK]: `^${sdk}` } },
          [`node_modules/${SDK}`]: { version: sdk, optionalDependencies: { [`@anthropic-ai/${NATIVE}`]: sdk } },
          [`node_modules/@anthropic-ai/${NATIVE}`]: { version: sdk, os: [process.platform], cpu: [process.arch], optional: true },
          "node_modules/@anthropic-ai/claude-agent-sdk-sunos-mips": { version: sdk, os: ["sunos"], cpu: ["mips"], optional: true },
          "node_modules/zod": { version: "4.1.0" },
          ...extra,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

interface Rig {
  root: string;
  serverRoot: string;
  stageRoot: string;
  codexPkg: string;
  calls: string[];
  restarts: string[];
  kv: ReturnType<typeof fakeKv>;
  published: CliAutoUpdateStatus[];
  updater: CliAutoUpdater;
  /** What `git show HEAD:server/package.json` answers; a commit moves it. */
  head: string;
  logs: string[];
  enabled: boolean;
  codexBusy: boolean;
  loadedSdk: string;
  claimed: boolean;
  deps: CliAutoUpdaterDeps;
}

interface RigOptions {
  sdk?: string;
  codex?: string | null;
  latest?: Record<string, RegistryRelease>;
  launcher?: CodexLauncher["source"];
  codexBusy?: boolean;
  loadedSdk?: string;
  behind?: number;
  /** A resolved lockfile that also moves these entries. */
  lockExtra?: Record<string, unknown>;
  respond?: (line: string, rig: Rig, cwd: string) => ChildResult | undefined;
}

const sdkDir = (r: Rig): string => join(r.serverRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
const nativeDir = (r: Rig): string => join(r.serverRoot, "node_modules", "@anthropic-ai", NATIVE);
const pkgFile = (r: Rig): string => join(r.serverRoot, "package.json");
const lockFile = (r: Rig): string => join(r.serverRoot, "package-lock.json");
const liveSdk = (r: Rig): string => readJson<{ version: string }>(join(sdkDir(r), "package.json")).version;
const liveNative = (r: Rig): string => readJson<{ version: string }>(join(nativeDir(r), "package.json")).version;
const liveCodex = (r: Rig): string => readJson<{ version: string }>(join(r.codexPkg, "package.json")).version;
const asides = (r: Rig): string[] => readdirSync(join(r.serverRoot, "node_modules", "@anthropic-ai")).filter((d) => d.startsWith("."));

function installPackage(dir: string, version: string): void {
  writeJson(join(dir, "package.json"), { version, claudeCodeVersion: runtimeOf(version) });
}

/** npm and git as the updater drives them, against the rig's tree. */
function play(line: string, r: Rig, cwd: string, options: RigOptions): ChildResult {
  const resolve = /install --package-lock-only --ignore-scripts @anthropic-ai\/claude-agent-sdk@\^(\S+)/.exec(line);
  if (resolve) {
    writeFileSync(join(cwd, "package.json"), packageJson(resolve[1]!));
    writeFileSync(join(cwd, "package-lock.json"), lockfile(resolve[1]!, options.lockExtra));
    return ok();
  }
  if (line.includes("install --package-lock-only --ignore-scripts --no-audit")) {
    const spec = readJson<{ dependencies: Record<string, string> }>(join(cwd, "package.json")).dependencies[SDK]!;
    writeFileSync(join(cwd, "package-lock.json"), lockfile(spec.replace(/^\^/, "")));
    return ok();
  }
  if (line.includes("install --legacy-peer-deps --no-package-lock")) {
    const deps = readJson<{ dependencies: Record<string, string> }>(join(cwd, "package.json")).dependencies;
    for (const [name, spec] of Object.entries(deps)) installPackage(join(cwd, "node_modules", ...name.split("/")), spec.replace(/^npm:.*@/, ""));
    return ok();
  }
  const codex = /install -g --prefix (\S+) @openai\/codex@(\S+)/.exec(line);
  if (codex) {
    const pkg = join(codex[1]!, "node_modules", "@openai", "codex");
    writeJson(join(pkg, "package.json"), { version: codex[2] });
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "codex.js"), "");
    return ok();
  }
  if (line.startsWith("git show HEAD:server/package.json")) return ok(r.head);
  if (line.startsWith("git commit")) {
    r.head = readFileSync(pkgFile(r), "utf8");
    return ok();
  }
  if (line.startsWith("git status")) return ok("");
  if (line.includes("rev-parse --abbrev-ref --symbolic-full-name")) return ok("origin/master\n");
  if (line.startsWith("git remote get-url")) return ok("https://github.com/Fearce/claude-orchestrator.git\n");
  return ok();
}

function rig(options: RigOptions = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "ggo-cli-update-"));
  const serverRoot = join(root, "repo", "server");
  const sdk = options.sdk ?? "0.3.280";
  const codexPkg = join(root, "npm", "node_modules", "@openai", "codex");
  const r = {
    root,
    serverRoot,
    stageRoot: join(root, "stage"),
    codexPkg,
    calls: [] as string[],
    restarts: [] as string[],
    kv: fakeKv(),
    published: [] as CliAutoUpdateStatus[],
    head: packageJson(sdk),
    logs: [] as string[],
    enabled: true,
    codexBusy: options.codexBusy ?? false,
    loadedSdk: options.loadedSdk ?? sdk,
    claimed: false,
  } as Rig;
  mkdirSync(serverRoot, { recursive: true });
  writeFileSync(pkgFile(r), packageJson(sdk));
  writeFileSync(lockFile(r), lockfile(sdk));
  installPackage(sdkDir(r), sdk);
  installPackage(nativeDir(r), sdk);
  writeFileSync(join(nativeDir(r), "claude.exe"), "");
  writeJson(join(serverRoot, "node_modules", "zod", "package.json"), { version: "4.1.0" });
  if (options.codex !== null) {
    writeJson(join(codexPkg, "package.json"), { version: options.codex ?? "0.156.1" });
    mkdirSync(join(codexPkg, "bin"), { recursive: true });
    writeFileSync(join(codexPkg, "bin", "codex.js"), "");
  }
  const latest = options.latest ?? { [SDK]: { version: sdk, claudeCodeVersion: runtimeOf(sdk) }, "@openai/codex": { version: options.codex ?? "0.156.1" } };
  r.deps = {
    repoRoot: join(root, "repo"),
    serverRoot,
    stageRoot: r.stageRoot,
    kvGet: r.kv.kvGet,
    kvSet: r.kv.kvSet,
    enabled: () => r.enabled,
    publish: (status) => r.published.push(status),
    log: (_level, message) => r.logs.push(message),
    codexLauncher: () => ({ command: process.execPath, args: [], path: join(codexPkg, "bin", "codex.js"), source: options.launcher ?? "npm" }),
    codexBusy: () => r.codexBusy,
    loadedSdkVersion: () => r.loadedSdk,
    upstream: async () => ({ branch: "master", behind: options.behind ?? 0, error: null }),
    claimCheckout: () => {
      if (r.claimed) return null;
      r.claimed = true;
      return () => {
        r.claimed = false;
      };
    },
    restartAvailable: async () => true,
    requestRestart: (label) => {
      r.restarts.push(label);
      return { outcome: "restarting", reason: "test", activeWork: 0 } as never;
    },
    fetchLatest: async (pkg) => {
      const release = latest[pkg];
      if (!release) throw new Error(`no release for ${pkg}`);
      return release;
    },
    sleep: async () => {},
    exec: async (cmd, args, { cwd }) => {
      const line = [cmd === process.execPath ? "node" : cmd, ...args.filter((a) => !/npm-cli\.js$/.test(a))].join(" ");
      r.calls.push(line);
      return options.respond?.(line, r, cwd) ?? play(line, r, cwd, options);
    },
  };
  r.updater = new CliAutoUpdater(r.deps);
  return r;
}

/** The same tree and kv after a restart: a new process, a new updater. */
function restarted(r: Rig, options: RigOptions = {}): Rig {
  r.updater.stop();
  const next = { ...r, calls: [] as string[], restarts: [] as string[] } as Rig;
  next.deps = {
    ...r.deps,
    enabled: () => next.enabled,
    codexBusy: () => next.codexBusy,
    loadedSdkVersion: () => next.loadedSdk,
    requestRestart: (label) => {
      next.restarts.push(label);
      return { outcome: "restarting", reason: "test", activeWork: 0 } as never;
    },
    claimCheckout: () => {
      if (next.claimed) return null;
      next.claimed = true;
      return () => {
        next.claimed = false;
      };
    },
    exec: async (cmd, args, { cwd }) => {
      const line = [cmd === process.execPath ? "node" : cmd, ...args.filter((a) => !/npm-cli\.js$/.test(a))].join(" ");
      next.calls.push(line);
      return options.respond?.(line, next, cwd) ?? play(line, next, cwd, options);
    },
  };
  next.updater = new CliAutoUpdater(next.deps);
  return next;
}

const cleanup = (r: Rig): void => {
  r.updater.stop();
  rmSync(r.root, { recursive: true, force: true });
};

const BUMP = { [SDK]: { version: "0.3.285", claudeCodeVersion: "2.1.285" }, "@openai/codex": { version: "0.156.1" } };
const isTypecheck = (line: string): boolean => line.includes("tsc") && line.includes("--noEmit");

console.log("CLI auto-update + highlighted news");

check("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("0.3.280", "0.3.285"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2", "1.2.3"), null);
  assert.equal(compareVersions("0.157.0-alpha.3", "0.157.0"), null);
});

check("lockChanges lists moved top-level packages for this platform only, and flags nested ones", () => {
  const before = JSON.parse(lockfile("0.3.280"));
  const after = JSON.parse(lockfile("0.3.285", { "node_modules/foo/node_modules/bar": { version: "2.0.0" }, "node_modules/@openai/codex-alias": { name: "@openai/codex", version: "1.0.0" } }));
  const { swap, nested } = lockChanges(before, after);
  assert.deepEqual(swap.map((c) => c.name).sort(), ["@anthropic-ai/claude-agent-sdk", `@anthropic-ai/${NATIVE}`, "@openai/codex-alias"].sort());
  assert.equal(swap.find((c) => c.name === "@openai/codex-alias")?.spec, "npm:@openai/codex@1.0.0");
  assert.deepEqual(nested, ["foo/node_modules/bar"]);
  assert.equal(lockChanges(before, before).swap.length, 0, "an unchanged lockfile moves nothing");
});

check("the first roster for a provider seeds silently; later ids are news; the seen set never shrinks", () => {
  assert.deepEqual(newlySeenModels(null, ["a", "b"]), { fresh: [], seen: ["a", "b"] });
  assert.deepEqual(newlySeenModels(["a", "b"], ["b", "c"]), { fresh: ["c"], seen: ["a", "b", "c"] });
  assert.deepEqual(newlySeenModels(["a", "b", "c"], ["a", "b"]).fresh, []);
});

check("HighlightNews announces a new model once, and dismissing removes only that item", () => {
  const kv = fakeKv();
  const events: HighlightNewsItem[][] = [];
  const news = new HighlightNews(kv as unknown as Db, (items) => events.push(items));
  news.observeModels("claude", ["claude-opus-5-5", "claude-sonnet-5"]);
  assert.equal(news.list().length, 0, "seeding announces nothing");
  news.observeModels("claude", ["claude-opus-6", "claude-opus-5-5", "claude-sonnet-5"]);
  news.observeModels("codex", ["gpt-6-astra"]);
  news.observeModels("codex", ["gpt-6-astra", "gpt-6-nova"]);
  assert.deepEqual(news.list().map((i) => i.id), ["model:codex:gpt-6-nova", "model:claude:claude-opus-6"]);
  news.observeModels("claude", ["claude-opus-6"]);
  assert.equal(news.list().length, 2, "a model seen again is not re-announced");
  news.dismiss("model:claude:claude-opus-6");
  assert.deepEqual(news.list().map((i) => i.model), ["gpt-6-nova"]);
  news.dismissAll();
  assert.equal(news.list().length, 0);
  assert.deepEqual(events.at(-1), []);
});

check("ModelCatalog hands its cached Claude roster to the news observer on refresh", async () => {
  const kv = fakeKv();
  kv.kvSet("cache_claude_models", JSON.stringify(["claude-opus-5-5"]));
  const seen: Array<[string, string[]]> = [];
  const catalog = new ModelCatalog(
    kv as unknown as Db,
    { firstUsableToken: () => undefined } as unknown as AccountManager,
    () => undefined,
    () => undefined,
    () => {},
    () => {},
    (provider, models) => seen.push([provider, models]),
  );
  await catalog.refresh();
  assert.deepEqual(seen.find(([p]) => p === "claude")?.[1], ["claude-opus-5-5"]);
});

check("a Codex CLI behind the registry is staged, swapped in, and the old copy swept", async () => {
  const r = rig({ codex: "0.156.1", latest: { [SDK]: { version: "0.3.280" }, "@openai/codex": { version: "0.159.2" } } });
  mkdirSync(join(dirname(r.codexPkg), ".codex-a1B2c3"), { recursive: true });
  await r.updater.checkNow();
  assert.ok(r.calls.some((c) => c.includes(`install -g --prefix ${join(r.stageRoot, "codex")} @openai/codex@0.159.2`)), r.calls.join("\n"));
  assert.ok(!r.calls.some((c) => /install -g @openai/.test(c)), "never installed in place");
  assert.equal(liveCodex(r), "0.159.2");
  assert.ok(existsSync(join(r.codexPkg, "bin", "codex.js")));
  assert.deepEqual(readdirSync(dirname(r.codexPkg)), ["codex"], "npm's and the swap's aside copies are gone");
  const status = r.updater.current();
  assert.equal(status.codex.state, "updated");
  assert.equal(status.codex.installed, "0.159.2");
  assert.ok(status.nextCheckAt > Date.now(), "the next check is scheduled");
  cleanup(r);
});

check("a Codex install killed mid-download leaves the live CLI untouched and retries soon", async () => {
  const r = rig({
    latest: { [SDK]: { version: "0.3.280" }, "@openai/codex": { version: "0.159.2" } },
    respond: (line) => (line.includes("@openai/codex@0.159.2") ? { code: null, stdout: "", stderr: "", timedOut: true } as unknown as ChildResult : undefined),
  });
  await r.updater.checkNow();
  assert.equal(liveCodex(r), "0.156.1");
  assert.equal(r.updater.current().codex.state, "failed");
  assert.ok(r.updater.current().nextCheckAt - Date.now() <= 20 * 60_000 + 1000, "retried within 20 minutes, not 6 hours");
  cleanup(r);
});

check("a Codex update waits while a Codex agent is mid-turn — including one that starts during the download", async () => {
  const busy = rig({ codexBusy: true, latest: { [SDK]: { version: "0.3.280" }, "@openai/codex": { version: "0.159.2" } } });
  await busy.updater.checkNow();
  assert.equal(busy.updater.current().codex.state, "waiting");
  assert.ok(!busy.calls.some((c) => c.includes("@openai/codex@")), "nothing is downloaded");
  cleanup(busy);

  const late = rig({
    latest: { [SDK]: { version: "0.3.280" }, "@openai/codex": { version: "0.159.2" } },
    respond: (line, self) => {
      if (line.includes("@openai/codex@0.159.2")) self.codexBusy = true;
      return undefined;
    },
  });
  await late.updater.checkNow();
  assert.equal(late.updater.current().codex.state, "waiting");
  assert.equal(liveCodex(late), "0.156.1", "the live CLI is not swapped under a running agent");
  cleanup(late);
});

check("a Codex Desktop launcher or a deliberately installed prerelease is left alone", async () => {
  const desktop = rig({ launcher: "desktop" });
  await desktop.updater.checkNow();
  assert.equal(desktop.updater.current().codex.state, "unmanaged");
  cleanup(desktop);

  const alpha = rig({ codex: "0.160.0-alpha.3", latest: { [SDK]: { version: "0.3.280" }, "@openai/codex": { version: "0.159.2" } } });
  await alpha.updater.checkNow();
  assert.equal(alpha.updater.current().codex.state, "unmanaged");
  assert.equal(liveCodex(alpha), "0.160.0-alpha.3");
  assert.ok(!alpha.calls.some((c) => c.includes("@openai/codex@")));
  cleanup(alpha);
});

check("an SDK bump stages, swaps, typechecks, commits only the package files, pushes, then restarts", async () => {
  const r = rig({ latest: BUMP });
  await r.updater.checkNow();
  const order = [
    "git status --porcelain -- server/package.json server/package-lock.json",
    "node", // the baseline typecheck
    "node install --package-lock-only --ignore-scripts @anthropic-ai/claude-agent-sdk@^0.3.285",
    "node install --legacy-peer-deps --no-package-lock",
    "node", // the typecheck against the new SDK
    "git commit --only",
    "git push",
  ];
  let at = -1;
  for (const step of order) {
    const next = r.calls.findIndex((c, i) => i > at && c.startsWith(step) && (step !== "node" || isTypecheck(c)));
    assert.ok(next > at, `${step} runs after the previous step:\n${r.calls.join("\n")}`);
    at = next;
  }
  assert.ok(!r.calls.some((c) => /node install @anthropic-ai/.test(c)), "never npm-installed in place");
  const commit = r.calls.find((c) => c.startsWith("git commit"))!;
  assert.ok(commit.includes("chore(deps): bump the Claude Agent SDK to 0.3.285 (Claude Code 2.1.285)"), commit);
  assert.ok(commit.endsWith("-- server/package.json server/package-lock.json"), "only the two package files are committed");
  assert.equal(liveSdk(r), "0.3.285");
  assert.equal(liveNative(r), "0.3.285", "this platform's binary package moved with it");
  assert.ok(!existsSync(join(r.serverRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk-sunos-mips")), "another platform's package is never installed");
  assert.equal(readJson<{ version: string }>(join(r.serverRoot, "node_modules", "zod", "package.json")).version, "4.1.0", "an unrelated package is not touched");
  assert.equal(readFileSync(pkgFile(r), "utf8"), packageJson("0.3.285"));
  assert.equal(readFileSync(lockFile(r), "utf8"), lockfile("0.3.285"));
  assert.deepEqual(asides(r), [], "the replaced folders are swept");
  assert.deepEqual(r.restarts, ["Claude runtime auto-update"]);
  assert.equal(r.kv.kvGet("cli_auto_update_inflight"), "", "the bump marker is cleared");
  assert.equal(r.claimed, false, "the checkout is released");
  const status = r.updater.current().claude;
  assert.equal(status.state, "updated");
  assert.equal(status.runtime, "2.1.285");
  cleanup(r);
});

check("an SDK that breaks the typecheck is swapped back, restored byte for byte, remembered and not retried", async () => {
  let typechecks = 0;
  const r = rig({ latest: BUMP, respond: (line) => (isTypecheck(line) ? (++typechecks === 2 ? fail("src/agents/runner.ts(12,3): error TS2322") : ok()) : undefined) });
  await r.updater.checkNow();
  assert.equal(typechecks, 3, "baseline, the new SDK, then the old one again to pin the blame");
  assert.ok(!r.calls.some((c) => c.startsWith("git commit")), "nothing is committed");
  assert.equal(r.restarts.length, 0);
  assert.equal(liveSdk(r), "0.3.280");
  assert.equal(liveNative(r), "0.3.280");
  assert.equal(readFileSync(pkgFile(r), "utf8"), packageJson("0.3.280"));
  assert.equal(readFileSync(lockFile(r), "utf8"), lockfile("0.3.280"));
  assert.equal(r.updater.current().claude.state, "failed");
  assert.match(r.updater.current().claude.detail, /no longer typechecks/);
  r.calls.length = 0;
  await r.updater.checkNow();
  assert.ok(!r.calls.some((c) => c.includes("claude-agent-sdk@")), "the same failed release is not retried");
  cleanup(r);
});

check("a typecheck that still fails after the undo is someone else's edit: no ban, retried soon", async () => {
  let typechecks = 0;
  const r = rig({ latest: BUMP, respond: (line) => (isTypecheck(line) ? (++typechecks === 1 ? ok() : fail("src/x.ts: error TS1005")) : undefined) });
  await r.updater.checkNow();
  assert.equal(liveSdk(r), "0.3.280");
  assert.equal(r.updater.current().claude.state, "failed");
  assert.equal(r.kv.kvGet("cli_auto_update_failed_sdk"), null, "not banned");
  assert.ok(r.updater.current().nextCheckAt - Date.now() <= 20 * 60_000 + 1000);
  cleanup(r);
});

check("a teammate's package.json edit during the bump is never committed or discarded", async () => {
  let typechecks = 0;
  const r = rig({
    latest: BUMP,
    respond: (line, self) => {
      if (isTypecheck(line) && ++typechecks === 2) {
        const pkg = readJson<{ scripts: Record<string, string> }>(pkgFile(self));
        pkg.scripts["test:mine"] = "node mine.js";
        writeFileSync(pkgFile(self), JSON.stringify(pkg, null, 2) + "\n");
      }
      return undefined;
    },
  });
  await r.updater.checkNow();
  assert.ok(!r.calls.some((c) => c.startsWith("git commit")), "nothing is committed");
  const pkg = readJson<{ scripts: Record<string, string>; dependencies: Record<string, string> }>(pkgFile(r));
  assert.equal(pkg.scripts["test:mine"], "node mine.js", "their edit survives");
  assert.equal(pkg.dependencies[SDK], "^0.3.280", "only the SDK line is reverted");
  assert.equal(liveSdk(r), "0.3.280");
  assert.equal(r.updater.current().claude.state, "waiting");
  cleanup(r);
});

check("a restart between the swap and the commit: the next process finishes the bump", async () => {
  let typechecks = 0;
  const r = rig({
    latest: BUMP,
    respond: (line) => {
      if (isTypecheck(line) && ++typechecks === 2) throw new Error("killed by a deploy");
      return undefined;
    },
  });
  await r.updater.checkNow();
  assert.equal(liveSdk(r), "0.3.285", "the process died with the new SDK swapped in");
  assert.notEqual(r.kv.kvGet("cli_auto_update_inflight"), "", "and its marker still recorded");
  const next = restarted(r);
  next.loadedSdk = "0.3.285"; // the new process booted on the swapped-in SDK
  await next.updater.checkNow();
  assert.ok(next.calls.some((c) => c.startsWith("git commit") && c.includes("0.3.285")), next.calls.join("\n"));
  assert.equal(next.kv.kvGet("cli_auto_update_inflight"), "");
  assert.equal(next.restarts.length, 0, "it already runs the new SDK, so no second restart");
  assert.equal(next.updater.current().claude.state, "updated");
  cleanup(next);
});

check("a restart before the package files were written: the next process undoes the swap", async () => {
  let typechecks = 0;
  const r = rig({
    latest: BUMP,
    respond: (line) => {
      if (isTypecheck(line) && ++typechecks === 2) throw new Error("killed by a deploy");
      return undefined;
    },
  });
  await r.updater.checkNow();
  writeFileSync(pkgFile(r), packageJson("0.3.280"));
  writeFileSync(lockFile(r), lockfile("0.3.280"));
  const next = restarted(r);
  await next.updater.checkNow();
  assert.equal(liveSdk(next), "0.3.280");
  assert.equal(liveNative(next), "0.3.280");
  assert.ok(!next.calls.some((c) => c.startsWith("git commit")));
  assert.ok(!next.calls.some((c) => c.includes("--package-lock-only --ignore-scripts --no-audit")), "untouched package files are not re-resolved");
  assert.equal(readFileSync(lockFile(next), "utf8"), lockfile("0.3.280"));
  assert.equal(next.kv.kvGet("cli_auto_update_inflight"), "");
  cleanup(next);
});

check("a commit blocked by another agent's index.lock is retried; a commit that fails outright is undone", async () => {
  let commits = 0;
  const busy = rig({
    latest: BUMP,
    respond: (line) => (line.startsWith("git commit") && ++commits <= 2 ? fail("fatal: Unable to create '.git/index.lock': File exists.") : undefined),
  });
  await busy.updater.checkNow();
  assert.equal(commits, 3);
  assert.equal(busy.updater.current().claude.state, "updated");
  cleanup(busy);

  const broken = rig({ latest: BUMP, respond: (line) => (line.startsWith("git commit") ? fail("pre-commit hook failed") : undefined) });
  await broken.updater.checkNow();
  assert.equal(liveSdk(broken), "0.3.280");
  assert.equal(readFileSync(pkgFile(broken), "utf8"), packageJson("0.3.280"));
  assert.equal(broken.kv.kvGet("cli_auto_update_failed_sdk"), null, "a commit failure is not the SDK's fault");
  assert.equal(broken.updater.current().claude.state, "failed");
  cleanup(broken);
});

check("a release that moves nested dependencies is refused before anything is touched", async () => {
  const r = rig({ latest: BUMP, lockExtra: { "node_modules/foo/node_modules/bar": { version: "2.0.0" } } });
  await r.updater.checkNow();
  assert.equal(liveSdk(r), "0.3.280");
  assert.ok(!r.calls.some((c) => c.includes("--legacy-peer-deps")), "nothing is staged");
  assert.equal(readFileSync(pkgFile(r), "utf8"), packageJson("0.3.280"));
  assert.match(r.updater.current().claude.detail, /nested dependencies/);
  cleanup(r);
});

check("an owner update holding the checkout, or the toggle going off mid-check, stops the bump", async () => {
  const held = rig({ latest: BUMP });
  held.claimed = true;
  await held.updater.checkNow();
  assert.equal(held.updater.current().claude.state, "waiting");
  assert.equal(liveSdk(held), "0.3.280");
  assert.ok(!held.calls.some((c) => c.startsWith("git commit")));
  cleanup(held);

  const off = rig({
    latest: { [SDK]: BUMP[SDK], "@openai/codex": { version: "0.159.2" } },
    respond: (line, self) => {
      if (line.includes("@openai/codex@0.159.2")) self.enabled = false;
      return undefined;
    },
  });
  await off.updater.checkNow();
  assert.ok(!off.calls.some((c) => c.includes("claude-agent-sdk@")), "the Claude bump never starts");
  assert.equal(off.updater.current().nextCheckAt, 0, "and nothing is scheduled");
  cleanup(off);
});

check("uncommitted package files or an out-of-date checkout hold the bump", async () => {
  const dirty = rig({ latest: BUMP, respond: (line) => (line.startsWith("git status") ? ok(" M server/package.json\n") : undefined) });
  await dirty.updater.checkNow();
  assert.equal(dirty.updater.current().claude.state, "waiting");
  assert.match(dirty.updater.current().claude.detail, /uncommitted/);
  assert.ok(!dirty.calls.some((c) => c.includes("claude-agent-sdk@")));
  cleanup(dirty);

  const behind = rig({ latest: BUMP, behind: 2 });
  await behind.updater.checkNow();
  assert.match(behind.updater.current().claude.detail, /2 commits behind/);
  assert.ok(!behind.calls.some((c) => c.includes("claude-agent-sdk@")));
  cleanup(behind);
});

check("a committed SDK this process has not loaded yet triggers one restart", async () => {
  const r = rig({ sdk: "0.3.285", loadedSdk: "0.3.280", latest: BUMP });
  await r.updater.checkNow();
  await r.updater.checkNow();
  assert.deepEqual(r.restarts, ["Claude runtime auto-update"], "restarted exactly once");
  cleanup(r);
});

check("an instance on its own data directory stands down and never runs a command", async () => {
  const kv = fakeKv();
  const calls: string[] = [];
  const updater = new CliAutoUpdater({
    repoRoot: tmpdir(),
    serverRoot: tmpdir(),
    kvGet: kv.kvGet,
    kvSet: kv.kvSet,
    enabled: () => true,
    standDownReason: "lab instance",
    publish: () => {},
    log: () => {},
    codexLauncher: () => ({ command: "", args: [], path: "", source: "npm" }),
    codexBusy: () => false,
    loadedSdkVersion: () => null,
    upstream: async () => ({ branch: "master", behind: 0, error: null }),
    claimCheckout: () => () => {},
    restartAvailable: async () => true,
    requestRestart: () => {
      throw new Error("must not restart");
    },
    fetchLatest: async () => {
      throw new Error("must not fetch");
    },
    exec: async (cmd) => {
      calls.push(cmd);
      return ok();
    },
  });
  updater.start();
  await updater.checkNow();
  updater.toggled(true);
  assert.equal(calls.length, 0);
  assert.equal(updater.current().claude.state, "unmanaged");
  assert.equal(updater.current().nextCheckAt, 0);
});

check("sweepAsideCopies only removes aside copies of that package", () => {
  const scope = mkdtempSync(join(tmpdir(), "ggo-aside-"));
  for (const d of [".codex-Xy12", ".codex-ggo1a2b", ".codex-other-pkg-Xy12", "codex", ".codexish"]) mkdirSync(join(scope, d));
  assert.equal(sweepAsideCopies(scope, "codex"), 2);
  assert.deepEqual(["codex", ".codex-other-pkg-Xy12", ".codexish"].map((d) => existsSync(join(scope, d))), [true, true, true]);
  rmSync(scope, { recursive: true, force: true });
});

let failed = 0;
for (const task of tasks) {
  try {
    await task.run();
    console.log(`  ok  ${task.name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${task.name}`);
    console.error(error);
  }
}
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\nall ${tasks.length} passed`);
process.exit(0);
