// A task's branch and worktree folder are named after the WORK, not the first words of the owner's
// prompt. Reported 2026-10-01: "Improve email extraction rate in web crawler" ran on
// ggo/we-have-another-agent-working-in-5ec874c0, because the worktree was cut from the dispatch-time
// title — the prompt's truncated first line. The model call is stubbed: no token, no network, no quota.
import assert from "node:assert/strict";
import { worktreeNameFromBrief } from "../orchestrator/worktreeName.js";

const OBSERVED_BRIEF =
  "We have another agent working in the crawler right now, so be careful. The email extraction rate is way too low on the dentist sites, figure out why and improve it.";

type FetchArgs = Parameters<typeof fetch>;
const realFetch = globalThis.fetch;
let sentPrompts: string[] = [];

function stubModel(reply: string, status = 200): void {
  sentPrompts = [];
  globalThis.fetch = (async (_url: FetchArgs[0], init?: FetchArgs[1]) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    sentPrompts.push(body.messages[0]?.content ?? "");
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

stubModel("crawler-email-extraction");
assert.equal(await worktreeNameFromBrief(OBSERVED_BRIEF, "stub-token"), "crawler-email-extraction");
assert.equal(sentPrompts.length, 1);
assert.ok(sentPrompts[0]!.includes(OBSERVED_BRIEF), "the brief itself must reach the model");
assert.match(sentPrompts[0]!, /opening words/, "the prompt must steer away from echoing the request's first words");

stubModel('"Fix Login Redirect"');
assert.equal(await worktreeNameFromBrief("the login page sends me to a 404", "stub-token"), "fix-login-redirect", "a quoted, cased reply still yields a clean slug");
stubModel("`fix-login-redirect`\n\nThis name describes the fix.");
assert.equal(await worktreeNameFromBrief("the login page sends me to a 404", "stub-token"), "fix-login-redirect", "chatter after the name is dropped");
stubModel("Fix the login redirect loop for users");
assert.equal(await worktreeNameFromBrief("the login page sends me to a 404", "stub-token"), "fix-the-login-redirect", "spaced words are capped at four");

stubModel("This is not a coding task");
assert.equal(await worktreeNameFromBrief(OBSERVED_BRIEF, "stub-token"), null, "commentary must never become a branch name");

stubModel("---");
assert.equal(await worktreeNameFromBrief(OBSERVED_BRIEF, "stub-token"), null, "a reply with no usable words falls back to the title");

stubModel("", 401);
assert.equal(await worktreeNameFromBrief(OBSERVED_BRIEF, "stub-token"), null, "a failed call falls back to the title");

stubModel("unused");
assert.equal(await worktreeNameFromBrief(OBSERVED_BRIEF, null), null, "no token means no call");
assert.equal(sentPrompts.length, 0);
assert.equal(await worktreeNameFromBrief("   ", "stub-token"), null, "an empty brief has nothing to name");
assert.equal(sentPrompts.length, 0);

stubModel("a-very-long-branch-name-that-keeps-going-and-going-forever");
const long = await worktreeNameFromBrief(OBSERVED_BRIEF, "stub-token");
assert.ok(long && long.length <= 32 && !long.endsWith("-"), `a long name is clamped on a hyphen-free end: ${long}`);

globalThis.fetch = realFetch;
console.log("worktreeName: model-chosen branch words, commentary guard and fallbacks verified");
