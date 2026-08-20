import assert from "node:assert/strict";
import { transientApiErrorInfo } from "../agents/runner.js";

const transient = [
  "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
  "API Error: 500 Internal server error.",
  "HTTP 503 Service Unavailable",
  "upstream connection reset",
  // The API being unreachable is the same bounded retry-then-hand-off case as a 5xx. These are the exact
  // strings production recorded; both used to fail the run outright instead of retrying or switching provider.
  "API Error: Unable to connect to API (ConnectionRefused)",
  "API Error: Unable to connect to API (FailedToOpenSocket)",
  "error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
  "connect ECONNREFUSED 127.0.0.1:443",
  { api_error_status: 502, result: "bad gateway" },
  { error: { type: "overloaded_error", message: "Overloaded" } },
];

for (const value of transient) {
  assert.ok(transientApiErrorInfo(value), `expected transient: ${JSON.stringify(value)}`);
}

const terminal = [
  "429 Too Many Requests",
  "rate limit reached",
  "401 Unauthorized",
  "validation failed",
  "processed 500 records successfully",
  // Prose about connecting something is not a transport failure — the unreachable-API patterns must stay tight.
  "the user refused to connect the tool to this workspace",
  { status: 429, message: "quota exceeded" },
];

for (const value of terminal) {
  assert.equal(transientApiErrorInfo(value), undefined, `expected non-transient: ${JSON.stringify(value)}`);
}

console.log("transient API error classifier: ok");
