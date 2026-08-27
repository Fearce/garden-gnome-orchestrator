/**
 * Unit test — the model catalog's FAILURE behaviour, which is the part that cannot be seen in production.
 *
 * Every picker unions the live list with a curated fallback, so a provider whose fetch is failing still
 * renders a plausible dropdown. The only symptom is a roster that quietly stops tracking that provider —
 * which is exactly how z.ai's list sat four GLM releases behind, and how one transient at boot cost six
 * hours of staleness with nothing logged. So: a failure must be reported, must not stop the other
 * providers, and must be retried well before the 6h cadence.
 *
 * Run:  npm run test:model-catalog   (from server/)
 */

process.env.MODEL_CATALOG_RETRY_MS = "10";

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";

const { ModelCatalog } = await import("../agents/modelCatalog.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const kv = new Map<string, string>();
const db = { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) } as unknown as Db;
const accounts = { firstUsableToken: () => "claude-token" } as unknown as AccountManager;

// The Grok list is read from the CLI's own cache FILE, so it is the provider that stays reachable while
// every network fetch is failing — which makes it the proof that one bad provider doesn't stop the rest.
const grokHome = mkdtempSync(join(tmpdir(), "ggo-catalog-"));
writeFileSync(join(grokHome, "models_cache.json"), JSON.stringify({ models: { "grok-4.6": {} } }), "utf8");
const { config } = await import("../config.js");
(config.grok as { home: string }).home = grokHome;

const logs: string[] = [];
let changes = 0;
const realFetch = globalThis.fetch;
let zaiFails = true;

globalThis.fetch = (async (url: string | URL | Request) => {
  const href = String(url);
  if (href.includes("z.ai")) {
    if (zaiFails) throw new Error("socket hang up");
    return new Response(JSON.stringify({ data: [{ id: "glm-5.3", created_at: "2026-08-14T00:00:00Z" }] }), { status: 200 });
  }
  if (href.includes("anthropic.com")) return new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }] }), { status: 200 });
  return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), { status: 200 });
}) as typeof fetch;

const catalog = new ModelCatalog(db, accounts, () => "openai-key", () => "zai-key", () => { changes++; }, (_l, m) => logs.push(m));

try {
  // Observed rather than awaited bare: the pre-fix shape read each provider's key OUTSIDE its try, so a
  // throw abandoned the whole refresh. Letting that propagate here would crash the run instead of naming
  // the defect, and every later assertion would go unrun.
  let refreshThrew = "";
  try {
    await catalog.refresh();
  } catch (error) {
    refreshThrew = error instanceof Error ? error.message : String(error);
  }
  check("one provider's failure never aborts the whole refresh", refreshThrew === "", refreshThrew);

  check("a failing provider is reported, not swallowed", logs.some((m) => /z\.ai/.test(m)), JSON.stringify(logs));
  check("…and the reason survives into the message", logs.some((m) => /socket hang up/.test(m)), JSON.stringify(logs));
  check("a provider that failed keeps no half-written cache", !kv.has("cache_zai_models"), String(kv.get("cache_zai_models")));

  check("a provider listed BEFORE the failure still stored", kv.get("cache_claude_models") === JSON.stringify(["claude-opus-5"]), String(kv.get("cache_claude_models")));
  check("a provider listed AFTER the failure still stored", kv.get("cache_grok_models") === JSON.stringify(["grok-4.6"]), String(kv.get("cache_grok_models")));

  // The retry is what keeps one transient at boot from costing six hours; MODEL_CATALOG_RETRY_MS is 10ms here.
  zaiFails = false;
  await new Promise((r) => setTimeout(r, 120));
  check("a failed refresh retries long before the 6h cadence", kv.get("cache_zai_models") === JSON.stringify(["glm-5.3"]), String(kv.get("cache_zai_models")));
  check("a refresh that changed something notifies the console", changes > 0, String(changes));

  const settled = logs.length;
  await catalog.refresh();
  check("a clean refresh reports nothing", logs.length === settled, JSON.stringify(logs.slice(settled)));
} finally {
  globalThis.fetch = realFetch;
  catalog.stop();
  rmSync(grokHome, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
