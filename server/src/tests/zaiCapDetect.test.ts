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
import { AgentRun, ZaiAgentRun, looksLikeCapNotice, parseUsageLimitResetAt, resultLooksRateLimited } from "../agents/runner.js";
import { CodexAgentRun } from "../agents/codexRunner.js";
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
    !events.some((e) => e.type === "text"),
    "the dead-end notice is swallowed, not shown to the owner as the agent's answer",
  );

  // The CLI repeats the notice while the session winds down, and every rate_limit event reaches
  // AccountManager — so the cap is announced exactly once per run, as flagCapFromSignal documents.
  handle(run, assistantText(notice));
  assert.equal(
    events.filter((e) => e.type === "rate_limit").length,
    1,
    "the cap is announced once per run, however often the CLI repeats it",
  );
}

// --- Unstructured cap text keeps the provider's reset, not merely a generic cooldown ---
{
  const codexStyle = "You've hit your usage limit. Try again at Sep 2nd, 2030 2:23 PM.";
  const codexReset = new Date("Sep 2, 2030 2:23 PM").getTime();
  assert.equal(parseUsageLimitResetAt(codexStyle), codexReset, "the shared parser understands a provider-stated absolute reset");
  const { run: claude } = newRun((c) => new AgentRun(c));
  handle(claude, errorResult(codexStyle));
  assert.equal(claude.rateLimitInfo?.resetsAt, codexReset, "a Claude error result propagates its stated absolute reset");

  const zaiStyle = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2030-09-02 14:23:00]";
  const zaiReset = new Date(2030, 8, 2, 14, 23, 0).getTime();
  assert.equal(parseUsageLimitResetAt(zaiStyle), zaiReset, "the shared parser understands a provider-stated numeric reset");
  const { run: zai } = newRun((c) => new ZaiAgentRun(c));
  handle(zai, assistantText(zaiStyle));
  assert.equal(zai.rateLimitInfo?.resetsAt, zaiReset, "a z.ai cap notice propagates its stated numeric reset");
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
  assert.equal(resultLooksRateLimited({ result: ZAI_CAP }), true, "an error result's generic 429/quota wording is a provider handoff");
  assert.equal(resultLooksRateLimited({ errors: [ZAI_CAP] }, /weekly\/monthly limit exhausted/i), true);
  assert.equal(resultLooksRateLimited({ api_error_status: 429 }), true, "the structured signal is unchanged");
  assert.equal(resultLooksRateLimited({ error: { response: { status: 429 } } }), true, "a nested SDK response.status=429 is recognized");
  assert.equal(resultLooksRateLimited({ stop_reason: "rate_limit" }), true, "the SDK rate_limit stop code is unchanged");
  assert.equal(resultLooksRateLimited({ error: { code: "insufficient_quota" } }), true, "nested insufficient_quota codes are recognized");
  assert.equal(
    resultLooksRateLimited({ error: { message: "Selected model is at capacity. Please try a different model." } }),
    true,
    "a provider model-capacity rejection is retryable through the fallback ladder",
  );
}

// SDK assistant errors can nest the HTTP status under error.response and carry the only reset wording
// in that nested error. Both must survive into the rate-limit latch rather than degrading to a short
// generic cooldown or a terminal review park.
{
  const resetText = "You've hit your usage limit. Try again at Sep 2nd, 2030 2:23 PM.";
  const expectedReset = new Date("Sep 2, 2030 2:23 PM").getTime();
  const { run } = newRun((c) => new AgentRun(c));
  handle(run, {
    type: "assistant",
    error: { response: { status: 429 }, message: resetText },
    message: { content: [] },
  });
  assert.equal(run.rateLimited, true, "a nested assistant HTTP 429 reaches the cap fallback path");
  assert.equal(run.rateLimitInfo?.resetsAt, expectedReset, "the nested provider reset is retained on the cap latch");
  assert.equal(run.rateLimitInfo?.resetSource, "provider", "the parsed nested reset is marked provider-stated");
}

// OpenAI's standard billing wording reverses the older "quota exceeded" phrasing. It is still a
// retryable provider condition in every shape the pipeline receives: a Claude SDK error result, a
// thrown transport exception, and a Codex CLI `turn.failed` event.
{
  const openAiQuota = "You exceeded your current quota, please check your plan and billing details.";
  assert.equal(resultLooksRateLimited({ result: openAiQuota }), true, "OpenAI's current-quota wording is recognized");

  const { run: resultRun } = newRun((c) => new AgentRun(c));
  handle(resultRun, errorResult(openAiQuota));
  assert.equal(resultRun.rateLimited, true, "a Claude SDK error result routes OpenAI quota exhaustion to failover");

  const { run: thrownRun } = newRun((c) => new AgentRun(c));
  const thrown = Object.assign(new Error(openAiQuota), { status: 429 });
  (thrownRun as unknown as { handleThrownProviderError(error: unknown): void }).handleThrownProviderError(thrown);
  assert.equal(thrownRun.rateLimited, true, "a thrown HTTP 429 synthesizes the cap signal consumed by stage fallback");
  assert.equal(thrownRun.lastResult?.isError, true, "a thrown cap also resolves the waiting stage result");

  const codex = new CodexAgentRun({ model: "gpt-5.6", effort: "low", cwd: process.cwd(), apiKey: "test-key" });
  (codex as unknown as { handleEvent(event: unknown): void }).handleEvent({ type: "turn.failed", error: { message: openAiQuota } });
  assert.equal(codex.capped, true, "a Codex CLI quota error uses the same provider fallback path");

  for (const error of [
    { message: "Request rejected by upstream provider", code: "insufficient_quota" },
    { message: "Request rejected by upstream provider", code: "rate_limit" },
    { message: "Insufficient quota" },
    { message: "insufficient-quota" },
  ]) {
    const structuredCodex = new CodexAgentRun({ model: "gpt-5.6", effort: "low", cwd: process.cwd(), apiKey: "test-key" });
    (structuredCodex as unknown as { handleEvent(event: unknown): void }).handleEvent({ type: "turn.failed", error });
    assert.equal(structuredCodex.capped, true, `Codex ${JSON.stringify(error)} is a provider-fallback cap`);
  }

  const errorEventCodex = new CodexAgentRun({ model: "gpt-5.6", effort: "low", cwd: process.cwd(), apiKey: "test-key" });
  (errorEventCodex as unknown as { handleEvent(event: unknown): void }).handleEvent({
    type: "error",
    error: { message: "Request rejected by upstream provider", code: "insufficient_quota" },
  });
  assert.equal(errorEventCodex.capped, true, "a Codex error event with structured quota code is a cap too");
}

// --- A CLI can put the cap in ordinary final assistant text but label the enclosing turn a success ---
// This exact shape used to bypass the fallback ladder: the runner accepted `turn.completed` even though
// the only final agent message was a provider rejection.
{
  const notice = "You've hit your usage limit. Try again at Sep 2nd, 2030 2:23 PM.";
  const reset = new Date("Sep 2, 2030 2:23 PM").getTime();
  const codex = new CodexAgentRun({ model: "gpt-5.6", effort: "low", cwd: process.cwd(), apiKey: "test-key" });
  const internal = codex as unknown as { handleEvent(event: unknown): void; onTurnClose(code: number | null): void };
  internal.handleEvent({ type: "item.completed", item: { type: "agent_message", text: notice } });
  internal.handleEvent({ type: "turn.completed" });
  internal.onTurnClose(0);
  assert.equal(codex.capped, true, "a Codex assistant-text cap must latch the backend before a success envelope is accepted");
  assert.equal(codex.rateLimitInfo?.resetsAt, reset, "Codex assistant-text cap preserves its stated reset");
  assert.equal(codex.lastResult?.isError, true, "a Codex success envelope after a cap becomes a fallback error");
}

console.log("z.ai cap detection: ok");
