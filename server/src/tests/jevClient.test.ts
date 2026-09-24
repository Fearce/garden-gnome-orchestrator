// The Jev (TypeSafe System One) client: request validation, retry policy, result parsing and rendering.
// No network — `fetchImpl` stands in for the API, `sleep` records backoff instead of waiting.
// Run: npm run test:jev-client --prefix server

import assert from "node:assert/strict";
import { evaluateJev, formatJevEvaluation, invalidJevQuestions, JevError } from "../agents/jevClient.js";
import { jevQuestionsFromText } from "../orchestrator/subTasks.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const answer = { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.25 } }, usage: { input_tokens: 2_000_000, output_tokens: 5 } };
const Q = { q: { type: "noul" as const, instructions: "Is it urgent?" } };

// ---- validation: the calling agent gets a message it can act on, before any request is made --------
assert.equal(invalidJevQuestions(Q), null);
assert.match(invalidJevQuestions({}) ?? "", /at least one/);
assert.match(invalidJevQuestions([]) ?? "", /object/);
assert.match(invalidJevQuestions({ "bad id!": Q.q }) ?? "", /Question id/);
assert.match(invalidJevQuestions({ q: { type: "maybe", instructions: "x" } }) ?? "", /noul.*choice.*score/);
assert.match(invalidJevQuestions({ q: { type: "noul" } }) ?? "", /instructions/);
assert.match(invalidJevQuestions({ q: { type: "choice", instructions: "x", criteria: { only: null } } }) ?? "", /two options/);
assert.match(invalidJevQuestions({ q: { type: "score", instructions: "x", criteria: ["one"] } }) ?? "", /2-10 levels/);
assert.equal(invalidJevQuestions({ q: { type: "score", instructions: "x", criteria: ["a", "b", "c"] } }), null);
assert.equal(invalidJevQuestions({ q: { type: "choice", instructions: { question: "x", data: [1] }, criteria: { a: null, b: "desc" } } }), null);

// ---- a successful call: bearer auth, the default model, cost from input tokens only -----------------
{
  let seen: { url: string; init?: RequestInit } | undefined;
  const res = await evaluateJev({
    apiKey: "k1",
    state: "state",
    questions: Q,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return ok(answer);
    }) as unknown as typeof fetch,
  });
  assert.equal(seen?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(new Headers(seen?.init?.headers).get("authorization"), "Bearer k1");
  assert.equal(JSON.parse(String(seen?.init?.body)).model, "jev-latest");
  assert.equal(res.model, "jev-1.13.0");
  assert.equal(res.inputTokens, 2_000_000);
  assert.ok(Math.abs(res.costUsd - 0.084) < 1e-12, String(res.costUsd));
}

// ---- 429/529 back off and retry (honouring retry-after); a 4xx caller error does not ---------------
{
  const statuses = [429, 529, 200];
  const waits: number[] = [];
  let calls = 0;
  const res = await evaluateJev({
    apiKey: "k",
    state: "s",
    questions: Q,
    sleep: async (ms) => void waits.push(ms),
    fetchImpl: (async () => {
      const status = statuses[calls++]!;
      return status === 200 ? ok(answer) : new Response("busy", { status, headers: status === 429 ? { "retry-after": "2" } : {} });
    }) as unknown as typeof fetch,
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 1000], "retry-after first, then exponential backoff");
  assert.equal(res.answers.q?.type, "noul");
}
{
  let calls = 0;
  await assert.rejects(
    evaluateJev({
      apiKey: "bad",
      state: "s",
      questions: Q,
      sleep: async () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("nope", { status: 401 });
      }) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof JevError && e.status === 401 && /API key/.test(e.message),
  );
  assert.equal(calls, 1, "a rejected key is not retried");
}
{
  let calls = 0;
  await assert.rejects(
    evaluateJev({
      apiKey: "k",
      state: "s",
      questions: Q,
      sleep: async () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("busy", { status: 529 });
      }) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof JevError && e.status === 529,
  );
  assert.equal(calls, 4, "overload retries are bounded");
}

// ---- an oversize state fails before the request, saying what to do ---------------------------------
await assert.rejects(
  evaluateJev({ apiKey: "k", state: "x".repeat(300_000), questions: Q, fetchImpl: (async () => ok(answer)) as unknown as typeof fetch }),
  /Trim the state/,
);

// ---- rendering: one line per answer, readable by the parent agent and the owner --------------------
{
  const text = formatJevEvaluation({
    model: "jev-1.13.0",
    inputTokens: 300,
    costUsd: 0.0000126,
    questions: {
      urgent: { type: "noul", instructions: "Is it urgent?" },
      team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: "bugs" } },
      mood: { type: "score", instructions: "How upset?", criteria: ["calm", "upset", "furious"] },
    },
    answers: {
      urgent: { type: "noul", noul: 0.953 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.88, tech: 0.12 }, confidence: 0.81 },
      mood: { type: "score", score: 1.05, legend: { "0": "calm", "1": "upset", "2": "furious" }, probabilities: { "0": 0, "1": 0.95, "2": 0.05 }, confidence: 0.92 },
    },
  });
  assert.match(text, /\*\*urgent\*\* \(yes\/no\): \*\*95\.3% yes\*\*/);
  assert.match(text, /\*\*team\*\* \(choice\): \*\*billing\*\* · confidence 81%/);
  assert.match(text, /\*\*mood\*\* \(score\): \*\*1\.05\*\* \(≈ upset\)/);
}

// ---- owner/parent follow-up text → questions ------------------------------------------------------
assert.deepEqual(jevQuestionsFromText("Is this safe?").questions, { answer: { type: "noul", instructions: "Is this safe?" } });
assert.deepEqual(jevQuestionsFromText('{"x":{"type":"noul","instructions":"y"}}').questions, { x: { type: "noul", instructions: "y" } });
assert.deepEqual(jevQuestionsFromText('{"questions":{"x":{"type":"noul","instructions":"y"}}}').questions, { x: { type: "noul", instructions: "y" } });
assert.match(jevQuestionsFromText('{"x":{"type":"choice","instructions":"y"}}').error ?? "", /criteria/);
assert.match(jevQuestionsFromText("   ").error ?? "", /judge/);

console.log("All jevClient checks passed.");
