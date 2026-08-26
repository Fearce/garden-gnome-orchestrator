import { LiveBenchScores, evidenceFor, evidenceNote, parseCsv, parseRelease, type LiveBenchSnapshot } from "../orchestrator/liveBenchScores.js";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const categories = JSON.stringify({
  Reasoning: ["reason_a", "reason_b"],
  Coding: ["coding"],
  "Agentic Coding": ["agentic"],
});
const table = [
  "model,reason_a,reason_b,coding,agentic",
  "claude-sonnet-4-6-thinking-auto-medium-effort,80,100,70,60",
  "gpt-5.5-high,90,90,80,70",
  "gpt-5.5-xhigh,92,92,85,75",
  '"quoted,model",10,20,30,40',
].join("\n");

console.log("\nLiveBench daily selector evidence");
const csv = parseCsv(table);
check("CSV parser preserves quoted commas", csv[4]?.[0] === "quoted,model", JSON.stringify(csv[4]));

const rows = parseRelease(table, categories);
const sonnet = rows.find((r) => r.model.startsWith("claude-sonnet"));
check("category averages match the leaderboard rule", sonnet?.categories.Reasoning === 90, JSON.stringify(sonnet));
check("overall is the mean of category averages", sonnet?.overall === 73.3, JSON.stringify(sonnet));

const snapshot: LiveBenchSnapshot = { version: 1, release: "2026-06-25", fetchedAt: Date.now(), rows };
const exact = evidenceFor(snapshot, "claude-sonnet-4-6");
check("configured model matches a benchmarked effort variant exactly", exact?.match === "exact", JSON.stringify(exact));
const prior = evidenceFor(snapshot, "gpt-5.6-sol");
check("newer model gets an explicitly labelled older-family prior", prior?.match === "family-prior" && prior.variants.length === 2, JSON.stringify(prior));
check("prompt note carries release, match confidence and effort rows", /2026-06-25.*older same-family prior.*gpt-5\.5-high.*gpt-5\.5-xhigh/.test(evidenceNote(prior) ?? ""), evidenceNote(prior));
check("unrelated model does not inherit another family's score", evidenceFor(snapshot, "kimi-k2.7") == null);

const kv = new Map<string, string>();
const store = {
  kvGet: (key: string): string | null => kv.get(key) ?? null,
  kvSet: (key: string, value: string): void => { kv.set(key, value); },
};
const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetches++;
  const url = String(input);
  if (url.endsWith("constants.js")) return new Response('export const RELEASES = ["2026-01-01", "2026-06-25"];');
  if (url.includes("table_2026_06_25.csv")) return new Response(table);
  if (url.includes("categories_2026_06_25.json")) return new Response(categories);
  return new Response("missing", { status: 404 });
}) as typeof fetch;

try {
  const service = new LiveBenchScores(store);
  await service.refreshIfDue();
  check("first refresh persists one complete release", service.status().release === "2026-06-25" && kv.size === 1, JSON.stringify(service.status()));
  const afterFirst = fetches;
  await service.refreshIfDue();
  check("fresh daily cache avoids another network fetch", fetches === afterFirst, `${afterFirst} -> ${fetches}`);
  check("a restarted service immediately reads persistent evidence", new LiveBenchScores(store).note("gpt-5.6-sol")?.includes("family prior") === true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
