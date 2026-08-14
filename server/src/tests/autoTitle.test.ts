// Board titles must HINT at the work, never comment on it. Dated ledger of the real titles that went
// wrong — paste the observed string in verbatim when a new one appears, and watch it fail first.
import assert from "node:assert/strict";
import { looksLikeCommentary, titleFromBrief, titleFromInjection } from "../orchestrator/titleFromInjection.js";

// 2026-08-14, thread e26b5a50 @ D:\WowPs — a World of Warcraft server bug reported in game terms.
// The titler answered the "what a coding task is being asked to do" framing by disputing it.
const REAL_BAD = "This is not a coding task - it's a gaming bug report about World of…";
const OBSERVED_BRIEF =
  "i just entered ulduar on 10 man and there are no vehicles in the starting zone to enter??? that makes the first boss literally impossible lol. pls fix";

const COMMENTARY_CASES = [
  REAL_BAD,
  "This is not a coding task",
  "That appears to be a gaming bug report",
  "It's a complaint about game behaviour, not code",
  "I can't summarise this as a coding task",
  "I'd describe this as a support request",
  "Cannot produce a title for a non-coding request",
  "Sorry, this request is not a software task",
  "Unfortunately no coding work is described here",
  "The user is reporting a World of Warcraft bug",
  "The request does not describe a programming task",
  "Note: this looks like a gameplay issue",
  "Gaming bug report, not a coding task",
];

// Real titles the same path produced for the same repo, plus phrasings the guard must not eat:
// negations and modal verbs belong in genuine bug titles.
const GENUINE_TITLES = [
  "Fix enter key to accept mob in common tab",
  "Allow using party items without switching heroes first",
  "Display equipped shirts and tabards in party gear window",
  "Fix condition headers to reference allies correctly",
  "Fix right-click usage for quest items in party inventory",
  "Add missing Ulduar 10-man starting-zone vehicles",
  "Fix crash when players cannot enter vehicles",
  "Re-run integration tests after the rename",
  "Add a dark-mode toggle to settings",
  "Stop the scheduler firing tasks that are not due",
  "Notify owner when no accounts have headroom",
  "Thisisnotawordboundary rename in the parser",
];

for (const bad of COMMENTARY_CASES) assert.ok(looksLikeCommentary(bad), `must be rejected as commentary: "${bad}"`);
for (const good of GENUINE_TITLES) assert.ok(!looksLikeCommentary(good), `must survive the guard: "${good}"`);

// The framing that caused it must not come back: neither prompt may call the input "a coding task",
// and both must carry the label-not-a-reply rule. Asserted against the real request, through the
// public entry points, with the model call stubbed — no token, no network, no quota.
type FetchArgs = Parameters<typeof fetch>;
const realFetch = globalThis.fetch;
let sentPrompts: string[] = [];
let replies: string[] = [];

function stubModel(canned: string[]): void {
  sentPrompts = [];
  replies = [...canned];
  globalThis.fetch = (async (_url: FetchArgs[0], init?: FetchArgs[1]) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    sentPrompts.push(body.messages[0]?.content ?? "");
    const text = replies.shift() ?? "";
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** The prompt sent on the i-th model call — asserts the call happened at all. */
function sent(i: number): string {
  const p = sentPrompts[i];
  assert.ok(p !== undefined, `expected a model call #${i}`);
  return p;
}

stubModel(["Add missing Ulduar 10-man starting-zone vehicles"]);
const clean = await titleFromBrief(OBSERVED_BRIEF, "stub-token");
assert.equal(clean, "Add missing Ulduar 10-man starting-zone vehicles");
assert.equal(sentPrompts.length, 1, "a compliant title must not trigger a retry");
assert.doesNotMatch(sent(0), /a coding task is being asked/, "the framing that caused the bad title is back");
assert.match(sent(0), /never judge, classify, refuse/);
assert.ok(sent(0).includes(OBSERVED_BRIEF), "the request itself must reach the model");

// Commentary → one corrective retry that says so → the retry's title is what lands.
stubModel([REAL_BAD, "Add missing Ulduar 10-man starting-zone vehicles"]);
assert.equal(await titleFromBrief(OBSERVED_BRIEF, "stub-token"), "Add missing Ulduar 10-man starting-zone vehicles");
assert.equal(sentPrompts.length, 2, "commentary must be retried once");
assert.match(sent(1), /commented on the request instead of labelling it/);

// Commentary twice → no title at all, so the caller keeps the owner's own first line.
stubModel([REAL_BAD, "This is still not a coding task"]);
assert.equal(await titleFromBrief(OBSERVED_BRIEF, "stub-token"), null, "a second commentary must not become the title");
assert.equal(sentPrompts.length, 2, "exactly one corrective retry, then give up");

// The injection path shares the rules and the guard.
stubModel([REAL_BAD, REAL_BAD]);
assert.equal(await titleFromInjection(OBSERVED_BRIEF, "stub-token"), null);
assert.doesNotMatch(sent(0), /a coding task is now being asked/);
assert.match(sent(0), /never judge, classify, refuse/);

globalThis.fetch = realFetch;
console.log("autoTitle: commentary guard, corrective retry and neutral title framing verified");
