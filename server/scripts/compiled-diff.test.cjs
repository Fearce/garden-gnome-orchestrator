#!/usr/bin/env node
// Gate for `compiled-diff.cjs` — the predicate behind BOTH `health`'s "dist vs HEAD" line and
// `deploy.cjs --verify`. Run: `npm run test:compiled-diff`.
//
// What it is protecting: this answer decides whether an agent restarts production. A false "not
// running" invites a bounce that tree-kills every in-flight agent; a false "running" leaves a real
// change unshipped while claiming it landed. Those are not symmetric, and the second is the one a
// lenient predicate produces — so every "must still be reported" case below matters more than the
// "must be ignored" ones it sits beside.
//
// Real git, in a throwaway repo, because the whole predicate IS a `git diff` pathspec: asserting it
// against a mocked git would only prove the mock agrees with itself.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { diffBetween, liveness, serverRuntimeDiff, webInputDiff, SERVER_RUNTIME } = require("./compiled-diff.cjs");

let checks = 0;
const check = (name, cond, detail) => {
  checks++;
  if (!cond) {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else console.log(`  ✓ ${name}`);
};

// ---- a throwaway repo whose history we control -----------------------------------------------------

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "compiled-diff-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", windowsHide: true }).trim();

function write(rel, text) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

function commit(message) {
  git("add", "-A");
  git("-c", "user.email=gate@example.com", "-c", "user.name=gate", "commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

// Call the MODULE's functions, pointed at our temp repo — never a locally-composed pathspec. Composing
// one here was this gate's own first draft, and it made the gate blind: dropping SERVER_NOT_RUNTIME from
// the module left every assertion green, because the test was still excluding tests/tools itself. Which
// is the hand-copied-classifier failure `.claude/rules/change-a-sweep-check.md` names, committed inside
// the very gate meant to prevent it.
const serverDiff = (a, b) => serverRuntimeDiff(a, b, repo);
const webDiff = (a, b) => webInputDiff(a, b, repo);

try {
  git("init", "-q");
  write("server/src/index.ts", "export const v = 1;\n");
  write("server/tsconfig.json", '{"compilerOptions":{"target":"ES2022"}}\n');
  write("server/src/tests/thing.test.ts", "// a test\n");
  write("server/src/tools/probe.ts", "// a probe\n");
  write("server/scripts/thing.cjs", "// a script\n");
  write("server/package.json", '{"name":"s"}\n');
  write("web/src/App.tsx", "export const App = 1;\n");
  write("CLAUDE.md", "# docs\n");
  write(".claude/rules/thing.md", "# a rule\n");
  const base = commit("base");

  console.log("what MUST read as drift (a restart really would ship something):");
  write("server/src/index.ts", "export const v = 2;\n");
  const srcChanged = commit("server source");
  check("a server/src change is reported", (serverDiff(base, srcChanged) ?? []).length === 1);
  check("…and liveness calls it not-live", liveness(base, srcChanged, repo).reason === "runtime-changed");

  write("server/tsconfig.json", '{"compilerOptions":{"target":"ES2023"}}\n');
  const tsconfigChanged = commit("tsconfig");
  check("a server tsconfig change is reported (it changes the emitted JS)", (serverDiff(srcChanged, tsconfigChanged) ?? []).length === 1);

  console.log("\nwhat must NOT read as drift (a restart would ship nothing, and it kills live agents):");
  write("CLAUDE.md", "# docs, edited\n");
  write(".claude/rules/thing.md", "# a rule, edited\n");
  const docsOnly = commit("docs + rules");
  check("a docs/rules-only commit is not drift", (serverDiff(tsconfigChanged, docsOnly) ?? []).length === 0);
  check("…and liveness reports it as still live", liveness(tsconfigChanged, docsOnly, repo).reason === "no-runtime-change");
  check("…which is the whole point: live === true", liveness(tsconfigChanged, docsOnly, repo).live === true);

  write("server/scripts/thing.cjs", "// a script, edited\n");
  const scriptsOnly = commit("scripts");
  check("a scripts-only commit is not drift (nothing under scripts/ compiles into dist)", (serverDiff(docsOnly, scriptsOnly) ?? []).length === 0);

  write("server/src/tests/thing.test.ts", "// a test, edited\n");
  write("server/src/tools/probe.ts", "// a probe, edited\n");
  const testsOnly = commit("tests + tools");
  check("a tests/tools-only commit is not drift (compiled, but never executed by the server)", (serverDiff(scriptsOnly, testsOnly) ?? []).length === 0);

  write("server/package.json", '{"name":"s","version":"2"}\n');
  const pkgOnly = commit("package.json");
  check("a package.json change is not a REBUILD question (it is an install)", (serverDiff(testsOnly, pkgOnly) ?? []).length === 0);

  console.log("\nthe web half is answered separately (web/dist is static — rebuild + reload, never a restart):");
  write("web/src/App.tsx", "export const App = 2;\n");
  const webOnly = commit("web source");
  check("a web change is NOT server drift", (serverDiff(pkgOnly, webOnly) ?? []).length === 0);
  check("…but it IS reported as a web change", (webDiff(pkgOnly, webOnly) ?? []).length === 1);
  check("…so the server reads live while the web note fires", liveness(pkgOnly, webOnly, repo).live === true);

  console.log("\nthe cases where it must refuse to answer:");
  check("an identical pair is same-commit", liveness(base, base, repo).reason === "same-commit");
  check("an unknown commit yields null, never []", diffBetween("0000000000000000000000000000000000000000", "HEAD", SERVER_RUNTIME, repo) === null);
  check("…and a null must not read as live", liveness("0000000000000000000000000000000000000000", "1111111111111111111111111111111111111111", repo).live === false);
  check("…reported as unknown, not as a clean pass", liveness("0000000000000000000000000000000000000000", "1111111111111111111111111111111111111111", repo).reason === "unknown");
  check("a missing commit id is refused too", liveness(null, "HEAD", repo).live === false);

  console.log("\ndirection-agnostic (a dist built from a LATER commit is just as wrong):");
  check("reversing the pair still reports the change", (serverDiff(srcChanged, base) ?? []).length === 1);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

if (!process.exitCode) console.log(`\ncompiled-diff: ${checks} checks passed`);
