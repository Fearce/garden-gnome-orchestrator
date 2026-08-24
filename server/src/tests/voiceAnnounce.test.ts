// The completion line is SPOKEN, so there is no glancing past a bad one. Same trap as the board title
// (see autoTitle.test.ts): a prompt that asserts the task was "a coding task" invites the model to
// dispute it out loud when the request didn't look like code. Free — the gateway probe and the model
// call both go through global fetch, which is stubbed here.
import assert from "node:assert/strict";
import type { Thread } from "../types.js";
import { completionAnnouncement } from "../orchestrator/voiceAnnounce.js";
import { disputesTheWork, looksLikeCommentary } from "../orchestrator/titleFromInjection.js";

const thread = {
  id: "e26b5a50-0000-0000-0000-000000000000",
  title: "Fix missing vehicles in Ulduar 10-man starting zone",
  brief: "i just entered ulduar on 10 man and there are no vehicles in the starting zone to enter??? pls fix",
} as Thread;

// The narrow predicate: only "this isn't real work" phrasings. A spoken sentence may open with "I" or
// "The", so the label-only openers must NOT be applied here — that is why the two are separate.
for (const bad of [
  "That wasn't really a coding task, but the vehicles are back",
  "Heads up, this is not a software issue — nothing was changed",
  "Done, though it was a gaming bug report rather than a programming task",
])
  assert.ok(disputesTheWork(bad), `must be caught before it is spoken: "${bad}"`);
for (const good of [
  "The Ulduar starting-zone vehicles are spawning again",
  "I've put the missing Ulduar vehicles back, first boss is doable now",
  "This one's done — party gear window now shows shirts and tabards",
])
  assert.ok(!disputesTheWork(good), `must still be spoken: "${good}"`);
assert.ok(looksLikeCommentary("I've put the missing Ulduar vehicles back"), "titles stay strict about openers");

type FetchArgs = Parameters<typeof fetch>;
const realFetch = globalThis.fetch;
let prompt = "";

/** Voice mode reported ON, then one canned model reply for the announcement. */
function stub(reply: string): void {
  prompt = "";
  globalThis.fetch = (async (url: FetchArgs[0], init?: FetchArgs[1]) => {
    if (String(url).includes("/api/status"))
      return new Response(JSON.stringify({ wake: { enabled: true } }), { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    prompt = body.messages[0]?.content ?? "";
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }), { status: 200 });
  }) as typeof fetch;
}

stub("The Ulduar starting-zone vehicles are spawning again");
assert.equal(await completionAnnouncement(thread, "stub-token"), "The Ulduar starting-zone vehicles are spawning again");
assert.doesNotMatch(prompt, /a coding task just finished/i, "the framing that made the titler argue is back");
assert.match(prompt, /Never remark on what sort of request it was/);

stub("Well, that was not really a coding task, but it's finished");
assert.equal(
  await completionAnnouncement(thread, "stub-token"),
  `Task complete: ${thread.title}.`,
  "an argument about the request must never reach the speakers",
);

globalThis.fetch = realFetch;
console.log("voiceAnnounce: neutral framing and the spoken-line guard verified");
