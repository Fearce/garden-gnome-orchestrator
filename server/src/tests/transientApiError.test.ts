import assert from "node:assert/strict";
import { transientApiErrorInfo } from "../agents/runner.js";

const transient = [
  "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
  "API Error: 500 Internal server error.",
  "HTTP 503 Service Unavailable",
  "upstream connection reset",
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
  { status: 429, message: "quota exceeded" },
];

for (const value of terminal) {
  assert.equal(transientApiErrorInfo(value), undefined, `expected non-transient: ${JSON.stringify(value)}`);
}

console.log("transient API error classifier: ok");
