// Unit test: GGO caps the CLI's auto-compact window on the runs it drives (no network, no DB).
// Run: npm run test:auto-compact-window
//
// Opus 5.5's own window is ~1M tokens, and the CLI only compacts near it. A long implementor session
// therefore re-read 500k-900k tokens on every call before compacting once (measured 2026-09-28, a long
// goal's step 8: 677 calls, 319M tokens of context, two compactions). The env var is the CLI's documented
// override and takes precedence over settings, so it is what these runs must carry.

delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
delete process.env.AUTO_COMPACT_WINDOW_TOKENS;

const { buildEnv } = await import("../agents/runner.js");
const { implementorConfig } = await import("../agents/roles.js");
const { config } = await import("../config.js");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const servers = { bus: { type: "stdio", command: "x" }, office: { type: "stdio", command: "x" } } as const;

console.log("auto-compact-window: the default");
check("the configured default is well under the 1M model window", config.autoCompactWindowTokens > 0 && config.autoCompactWindowTokens <= 400_000, String(config.autoCompactWindowTokens));
check("a Claude run carries the configured window", buildEnv({ oauthToken: "tok" })[KEY] === String(config.autoCompactWindowTokens), String(buildEnv({ oauthToken: "tok" })[KEY]));
check("a z.ai run carries it too", buildEnv({ baseUrl: "https://example.test", authToken: "k" })[KEY] === String(config.autoCompactWindowTokens));

console.log("auto-compact-window: per-run overrides");
check("an explicit window is passed through", buildEnv({ oauthToken: "tok", autoCompactWindow: 250_000 })[KEY] === "250000");
check("0 leaves the CLI's own window", buildEnv({ oauthToken: "tok", autoCompactWindow: 0 })[KEY] === undefined);
process.env[KEY] = "123456";
check("an inherited value is the operator's choice and wins", buildEnv({ oauthToken: "tok" })[KEY] === "123456");
check("even over 0", buildEnv({ oauthToken: "tok", autoCompactWindow: 0 })[KEY] === "123456");
delete process.env[KEY];

console.log("auto-compact-window: role configs");
check("a pipeline implementor takes the default", implementorConfig("C:/w", servers as never).autoCompactWindow === undefined);
check("a Default-mode session keeps the stock CLI window", implementorConfig("C:/w", servers as never, { vanilla: true }).autoCompactWindow === 0);

if (failures) {
  console.error(`\nauto-compact-window: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nauto-compact-window: all checks passed");
