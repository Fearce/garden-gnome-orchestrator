import { LiveBenchScores, evidenceFor, evidenceNote, leaderboardOf, parseCsv, parseModelOrganizations, parseRelease, type LiveBenchSnapshot } from "../orchestrator/liveBenchScores.js";

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

const modelLinks = `export const modelLinks = {
    // effort variants inherit their base entry's organization
    "gpt-5.5-high": { url: "https://openai.com", organization: "OpenAI", displayName: "GPT-5.5 High", reasoner: true,
        variants: [ { rawName: "gpt-5.5-xhigh", displayName: 'GPT-5.5 "xHigh"' }, ], },
    /* a base entry wins over a variant of the same id */
    claude_base: { organization: "Anthropic", variants: [{ rawName: "quoted,model" }] },
    "quoted,model": { organization: "Quoted Labs", version: 3, openweight: false, note: 'it\\'s "fine"\\n\\u00e9' },
    "no-org": { url: \`https://example.com\` },
};

const variantLookup = {};
export const getModelInfo = (name) => modelLinks[name];
`;
const organizations = parseModelOrganizations(modelLinks);
check("organizations parse without executing the module", organizations.get("gpt-5.5-high") === "OpenAI" && organizations.size === 4 && !organizations.has("no-org"), JSON.stringify([...organizations]));
check("an effort variant inherits its base organization", organizations.get("gpt-5.5-xhigh") === "OpenAI");
check("a base entry wins over a same-named variant", organizations.get("quoted,model") === "Quoted Labs");
let refused = false;
try {
  parseModelOrganizations("export const modelLinks = { a: { organization: lookup() } };");
} catch {
  refused = true;
}
check("code inside the table is refused rather than evaluated", refused);

const board = leaderboardOf(snapshot, [{ provider: "codex", model: "gpt-5.5" }, { provider: "claude", model: "claude-opus-5-5" }]);
check("leaderboard keeps the release's category order", board.categories.join("|") === "Reasoning|Coding|Agentic Coding", board.categories.join("|"));
check("leaderboard carries every snapshot row", board.rows.length === rows.length);
check(
  "rows are marked with the local models they are exact evidence for",
  board.rows.filter((r) => r.usableAs.length).map((r) => r.model).join("|") === "gpt-5.5-high|gpt-5.5-xhigh" &&
    board.rows.find((r) => r.model === "gpt-5.5-high")?.usableAs[0] === "codex:gpt-5.5",
  JSON.stringify(board.rows.map((r) => [r.model, r.usableAs])),
);

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
  if (url.endsWith("modelLinks.js") && linksUp) return new Response(modelLinks);
  return new Response("missing", { status: 404 });
}) as typeof fetch;
let linksUp = true;
const cached = (): LiveBenchSnapshot => JSON.parse(kv.get("livebench_scores_v1") ?? "null") as LiveBenchSnapshot;

try {
  const service = new LiveBenchScores(store);
  await service.refreshIfDue();
  check("first refresh persists one complete release", service.status().release === "2026-06-25" && kv.size === 1, JSON.stringify(service.status()));
  check("the cached release carries the site's organizations", cached().organizationsCaptured === true && cached().rows.find((r) => r.model === "gpt-5.5-xhigh")?.organization === "OpenAI", JSON.stringify(cached().rows));
  check("a model the site does not list stays without an organization", cached().rows.find((r) => r.model.startsWith("claude-sonnet"))?.organization === undefined);
  const afterFirst = fetches;
  await service.refreshIfDue();
  check("fresh daily cache avoids another network fetch", fetches === afterFirst, `${afterFirst} -> ${fetches}`);
  check("a restarted service immediately reads persistent evidence", new LiveBenchScores(store).note("gpt-5.6-sol")?.includes("family prior") === true);

  const reloaded = new LiveBenchScores(store).leaderboard([]);
  check("the Settings loader serves the persisted release", reloaded.snapshot?.release === "2026-06-25" && reloaded.snapshot.rows.length === rows.length && reloaded.lastError === null, JSON.stringify(reloaded).slice(0, 200));

  const { organizationsCaptured: _dropped, ...legacy } = cached();
  kv.set("livebench_scores_v1", JSON.stringify({ ...legacy, rows: legacy.rows.map(({ organization: _o, ...row }) => row) }));
  const upgraded = new LiveBenchScores(store);
  const beforeUpgrade = fetches;
  await upgraded.refreshIfDue();
  check("a fresh snapshot cached before organizations existed is refreshed once", fetches > beforeUpgrade && cached().organizationsCaptured === true, `${beforeUpgrade} -> ${fetches}`);

  linksUp = false;
  await upgraded.refreshIfDue(true);
  check("an unavailable organization table never fails the scores refresh", cached().organizationsCaptured === false && cached().rows.length === rows.length && upgraded.leaderboard([]).lastError === null);
  const afterLinksDown = fetches;
  await upgraded.refreshIfDue();
  check("a release cached without organizations still waits out the daily TTL", fetches === afterLinksDown, `${afterLinksDown} -> ${fetches}`);

  const empty = new Map<string, string>();
  const offline = new LiveBenchScores({ kvGet: (key) => empty.get(key) ?? null, kvSet: (key, value) => { empty.set(key, value); } });
  globalThis.fetch = (async () => new Response("down", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;
  await offline.refreshIfDue();
  const failedBoard = offline.leaderboard([]);
  check("with no snapshot the loader reports the refresh error instead of rows", failedBoard.snapshot === null && /503/.test(failedBoard.lastError ?? ""), JSON.stringify(failedBoard));
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
