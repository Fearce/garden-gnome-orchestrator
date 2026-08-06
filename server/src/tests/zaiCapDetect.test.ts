// Regression: a z.ai run announces a spent quota in z.ai's words, not Anthropic's — `API Error: Request
// rejected (429) · [1310][Weekly/Monthly Limit Exhausted…]`. Neither SESSION_LIMIT_TEXT_RE nor
// RATE_LIMIT_RESULT_RE matched it, so `rateLimited` stayed false: no `noteZaiCap` latch, no provider
// hand-off (threadManager's `provider !== "claude"` cap block reads exactly that flag), the dead-end text
// shown to the owner, and the sweep filing the row as a REAL failure. Production case: the QA run on
// thread 25dc40d5, 2026-08-05 08:12. Run: npx tsx src/tests/zaiCapDetect.test.ts
//
// Driven through the runner's real SDK-message handler with canned messages — the public start() path
// spawns a live CLI against a real z.ai key, which no gate can do.

import assert from "node:assert/strict";
import { AgentRun, ZaiAgentRun, looksLikeCapNotice, resultLooksRateLimited } from "../agents/runner.js";
import type { AgentEvent } from "../types.js";

// Both wordings production has recorded, verbatim: the weekly exhaustion (the row that went unseen) and
// the 5h form, which is the majority shape — without it the pattern could be narrowed to the weekly
// wording alone and this gate would stay green while the common cap regressed.
const ZAI_CAPS = [
  "API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-07 05:17:25][20260805162117d671fff34d0b496f]",
  "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-08-04 23:03:31][202608042158519a0d33c649374d08]",
];
const ZAI_CAP = ZAI_CAPS[0]!;

function newRun<T extends AgentRun>(make: (cfg: { model: string; cwd: string }) => T): { run: T; events: AgentEvent[] } {
  const run = make({ model: "glm-5.2", cwd: process.cwd() });
  const events: AgentEvent[] = [];
  run.onEvent((e) => events.push(e));
  return { run, events };
}

/** Feed one SDK message through the runner's own normalizer (the path `consume()` drives). */
function handle(run: AgentRun, message: unknown): void {
  (run as unknown as { handle(m: unknown): void }).handle(message);
}

const assistantText = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const errorResult = (result: string) => ({ type: "result", subtype: "error_during_execution", is_error: true, result });

// --- Each cap notice as an assistant TEXT block: flagged, and swallowed rather than shown ---
for (const notice of ZAI_CAPS) {
  const { run, events } = newRun((c) => new ZaiAgentRun(c));
  handle(run, assistantText(notice));

  assert.equal(run.rateLimited, true, `a z.ai cap notice must set the failover flag the cap block reads: ${notice}`);
  assert.ok(
    events.some((e) => e.type === "rate_limit"),
    "the cap must be announced so the run's backend can be latched",
  );
  assert.ok(
    !events.some((e) => e.type === "text"),
    "the dead-end notice is swallowed, not shown to the owner as the agent's answer",
  );
}

// --- …and as an error RESULT, the belt-and-suspenders path (the same text is persisted as the run error) ---
for (const notice of ZAI_CAPS) {
  const { run } = newRun((c) => new ZaiAgentRun(c));
  handle(run, errorResult(notice));
  assert.equal(run.rateLimited, true, "an error result carrying the notice is the same cap");
}

// --- A z.ai run still works normally otherwise: ordinary text is neither swallowed nor a cap ---
for (const prose of [
  "I reviewed the diff and the weekly limit handling looks correct.",
  // An agent QUOTING the notice — this repo's own source carries the literal, so a z.ai agent working
  // on runner.ts writes it. Swallowing that message and latching its backend mid-task is the cost of an
  // unanchored match, which is why the pattern requires the notice to BE the message.
  `The run died with \`${ZAI_CAP}\`, which no regex matched.`,
]) {
  const { run, events } = newRun((c) => new ZaiAgentRun(c));
  handle(run, assistantText(prose));
  assert.equal(run.rateLimited, false, `prose about a limit is not a cap: ${prose.slice(0, 40)}…`);
  assert.equal(events.filter((e) => e.type === "text").length, 1, "ordinary text reaches the feed");
}

// --- The z.ai wording never speaks for a Claude run: it reaches the classifier only via ZaiAgentRun ---
{
  const { run } = newRun((c) => new AgentRun(c));
  handle(run, assistantText(ZAI_CAP));
  assert.equal(run.rateLimited, false, "a Claude run quoting z.ai's error must not latch a cap on the sub");
}

// --- Claude's own notice keeps working on both classes ---
{
  const notice = "You've hit your session limit · resets 5:30pm (Europe/Copenhagen)";
  for (const [label, make] of [
    ["claude", (c: { model: string; cwd: string }) => new AgentRun(c)],
    ["zai", (c: { model: string; cwd: string }) => new ZaiAgentRun(c)],
  ] as const) {
    const { run } = newRun(make);
    handle(run, assistantText(notice));
    assert.equal(run.rateLimited, true, `the CLI's own session-limit notice must still flag on ${label}`);
  }
}

// --- The shared predicates directly: the backend pattern is additive, never a replacement ---
{
  assert.equal(looksLikeCapNotice(ZAI_CAP), false, "no backend pattern → only Anthropic's wording counts");
  assert.equal(looksLikeCapNotice("You've hit your weekly limit · resets Jul 21, 10pm"), true);
  assert.equal(resultLooksRateLimited({ result: ZAI_CAP }), false);
  assert.equal(resultLooksRateLimited({ errors: [ZAI_CAP] }, /weekly\/monthly limit exhausted/i), true);
  assert.equal(resultLooksRateLimited({ api_error_status: 429 }), true, "the structured signal is unchanged");
}

console.log("z.ai cap detection: ok");
