import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { currentCodexModel } from "../agents/codexModelGeneration.js";
import { chatgptLoginAvailable, seedCodexAuth } from "../agents/codexRunner.js";
import { codexUsageCapped } from "../agents/codexUsage.js";
import { withAgentToolPath } from "../agents/env.js";
import type { MemoryModelDeps } from "./models.js";

/** Luna on the ChatGPT plan only: memory work must never fall through to usage-billed API keys, so an
 *  API-key-only Codex setup reports Luna as unavailable instead of spending. */
export function codexLunaLaunch(codexEnabled: () => boolean, lunaAllowed: () => boolean): MemoryModelDeps["lunaLaunch"] {
  return async () => {
    if (!lunaAllowed()) return { unavailable: "Luna fallback is turned off in Settings → Memory" };
    if (!codexEnabled()) return { unavailable: "the Codex subscription is turned off in Settings → Subscriptions" };
    if (codexUsageCapped(Date.now())) return { unavailable: "the Codex plan is capped until its usage window resets" };
    const launcher = config.codex.launcher();
    if (!launcher.path || !existsSync(launcher.path)) return { unavailable: "the Codex CLI is not installed" };
    if (!chatgptLoginAvailable()) return { unavailable: "Codex is not signed in with a ChatGPT plan (`codex login`)" };
    if ((await seedCodexAuth(undefined)) !== "chatgpt") return { unavailable: "Codex is not signed in with a ChatGPT plan (`codex login`)" };
    const model = currentCodexModel("gpt-6-luna");
    const cwd = join(config.dataDir, "memory-luna-sandbox");
    await mkdir(cwd, { recursive: true });
    const env = withAgentToolPath({ ...process.env, CODEX_HOME: config.codex.home });
    delete env.OPENAI_API_KEY;
    return {
      model,
      launch: {
        command: launcher.command,
        args: [
          ...launcher.args, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
          "-s", "read-only", "--color", "never", "-C", cwd, "-c", 'model_reasoning_effort="low"', "-m", model, "-",
        ],
        cwd,
        env,
      },
    };
  };
}
