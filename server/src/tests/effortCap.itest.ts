/**
 * Unit test — the per-subscription MAX reasoning-effort clamp (`clampEffort` in agents/roles.ts).
 *
 * The director/planner picks each task's effort; a subscription's configured max only CAPS it (so a tiny
 * task stays cheap and nothing exceeds the tier the operator allowed for that sub). Codex/Grok caps top out
 * below Claude's `max`, so the clamp must also bound a Claude-tier request down into a CLI backend's range.
 *
 * Run:  npm run test:effort   (from server/)   — or:  npx tsx src/tests/effortCap.itest.ts
 * Exits non-zero if any assertion fails.
 */

import { clampEffort } from "../agents/roles.js";
import { claudeEffortsForModel, CODEX_EFFORTS, codexEffortsForModel, GROK_EFFORTS, grokEffortsForModel, resolveClaudeEffort, resolveCodexEffort, ZAI_EFFORTS } from "../types.js";
import { clientCommandSchema } from "../ws/protocol.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(`${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); console.log(`  ✗ ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log("\nclampEffort");
eq("under the cap → unchanged (tiny task stays low)", clampEffort("low", "max"), "low");
eq("at the cap → unchanged", clampEffort("high", "high"), "high");
eq("over the cap → capped down", clampEffort("max", "high"), "high");
eq("Claude 'max' capped to a Codex 'xhigh' backend", clampEffort("max", "xhigh"), "xhigh");
eq("Claude 'xhigh' capped to a Grok 'high' backend", clampEffort("xhigh", "high"), "high");
eq("medium under a high cap → medium", clampEffort("medium", "high"), "medium");
eq("high over a low cap → low", clampEffort("high", "low"), "low");
eq("uncapped (max cap) never lowers a request", clampEffort("xhigh", "max"), "xhigh");

console.log("\nCodex model effort support");
eq("GPT-5.6 Sol exposes Ultra", codexEffortsForModel("gpt-5.6-sol").at(-1), "ultra");
eq("GPT-5.6 Terra snapshots expose Ultra", codexEffortsForModel("gpt-5.6-terra-2026-07-01").at(-1), "ultra");
eq("GPT-5.6 Luna stops at Max", codexEffortsForModel("gpt-5.6-luna").at(-1), "max");
eq("Daybreak Blue exposes Ultra", codexEffortsForModel("gpt-daybreak-blue-latest").at(-1), "ultra");
eq("GPT-5.3 Codex stops at Extra High", codexEffortsForModel("gpt-5.3-codex").at(-1), "xhigh");
eq("legacy Codex safely lowers a stale Max setting", resolveCodexEffort("gpt-5.3-codex", "max"), "xhigh");
eq("GPT-5.6 keeps Max", resolveCodexEffort("gpt-5.6-sol", "max"), "max");
eq("Luna safely lowers a stale Ultra setting", resolveCodexEffort("gpt-5.6-luna", "ultra"), "max");

console.log("\nClaude and Grok model effort support");
eq("Claude Opus 4.8 exposes all five tiers", claudeEffortsForModel("claude-opus-4-8").join(","), "low,medium,high,xhigh,max");
eq("Claude Sonnet 4.6 exposes Max but not Extra High", claudeEffortsForModel("claude-sonnet-4-6").join(","), "low,medium,high,max");
eq("Claude Haiku safely lowers unsupported Max", resolveClaudeEffort("claude-haiku-4-5-20251001", "max"), "high");
eq("Grok 4.6 exposes Extra High", grokEffortsForModel("grok-4.6").at(-1), "xhigh");
eq("Grok 4.5 stops at High", grokEffortsForModel("grok-4.5").at(-1), "high");

console.log("\nCodex settings protocol");
eq(
  "WebSocket settings accepts every canonical Codex effort",
  CODEX_EFFORTS.every((effort) => clientCommandSchema.safeParse({ type: "settings.set", settings: { codexEffort: effort } }).success),
  true,
);
eq(
  "WebSocket settings accepts every Grok 4.6 effort",
  GROK_EFFORTS.every((effort) => clientCommandSchema.safeParse({ type: "settings.set", settings: { grokEffort: effort } }).success),
  true,
);
eq(
  "WebSocket settings keeps z.ai on its verified effort set",
  ZAI_EFFORTS.every((effort) => clientCommandSchema.safeParse({ type: "settings.set", settings: { zaiEffort: effort } }).success)
    && !clientCommandSchema.safeParse({ type: "settings.set", settings: { zaiEffort: "xhigh" } }).success,
  true,
);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
