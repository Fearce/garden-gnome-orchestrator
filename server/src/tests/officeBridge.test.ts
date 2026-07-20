// Office text-bridge extraction for CLI backends (Codex/Grok).
// Run: npx tsx src/tests/officeBridge.test.ts

import assert from "node:assert/strict";
import { extractOfficeChat } from "../agents/officeBridge.js";

// Canonical standalone line (Codex agent_message shape).
{
  const { visible, posts } = extractOfficeChat("Hello team.\nOFFICE[team]: claiming server/src/foo.ts\nContinuing work.");
  assert.deepEqual(posts, [{ scope: "project", body: "claiming server/src/foo.ts" }]);
  assert.equal(visible, "Hello team.\n\nContinuing work.");
}

// General office scope.
{
  const { posts } = extractOfficeChat("OFFICE[office]: all hands — restarting the hub shortly");
  assert.deepEqual(posts, [{ scope: "general", body: "all hands — restarting the hub shortly" }]);
}

// Grok streaming-json failure mode: successive model turns concatenated with NO newlines.
// Real production sample (Sten/weekly-safety) left OFFICE markers in the feed because the old
// ^...$ line regex never matched mid-string. When the marker is mid-blob with no trailing
// separator, the body runs to end-of-string (capped at 500) — post still fires, marker still strips.
{
  const raw =
    "I'll implement weekly safety.Weekly safety for Claude looks present.Safety commits are already on master." +
    "OFFICE[team]: weekly-safety feature already shipped on master (9c367d5) — not editing; leaving to teammates";
  const { visible, posts } = extractOfficeChat(raw);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.scope, "project");
  assert.match(posts[0]!.body, /weekly-safety feature already shipped/);
  assert.ok(!visible.includes("OFFICE["));
  assert.match(visible, /I'll implement weekly safety/);
  assert.match(visible, /Safety commits are already on master\./);
}

// Marker then a newline-separated continuation (body must not swallow the next paragraph).
{
  const raw =
    "Claiming now.\nOFFICE[team]: taking grokRunner.ts + officeBridge.ts\nI'll start the parser fix.";
  const { visible, posts } = extractOfficeChat(raw);
  assert.deepEqual(posts, [{ scope: "project", body: "taking grokRunner.ts + officeBridge.ts" }]);
  assert.match(visible, /Claiming now/);
  assert.match(visible, /I'll start the parser fix/);
}

// Backtick-wrapped (model copies the doctrine's `OFFICE[team]: ...` formatting).
{
  const { visible, posts } = extractOfficeChat("Before.\n`OFFICE[team]: claiming accounts/`\nAfter.");
  assert.deepEqual(posts, [{ scope: "project", body: "claiming accounts/" }]);
  assert.ok(!visible.includes("OFFICE["));
  assert.ok(!visible.includes("`"));
}

// Multiple markers in one blob.
{
  const { posts } = extractOfficeChat(
    "OFFICE[team]: claiming A\nmid\nOFFICE[team]: also claiming B\nOFFICE[office]: fyi everyone",
  );
  assert.equal(posts.length, 3);
  assert.equal(posts[0]!.body, "claiming A");
  assert.equal(posts[1]!.body, "also claiming B");
  assert.equal(posts[2]!.scope, "general");
}

// Case-insensitive scope + surrounding whitespace.
{
  const { posts } = extractOfficeChat("  OFFICE[Team]:   hello world   ");
  assert.deepEqual(posts, [{ scope: "project", body: "hello world" }]);
}

// Body capped at 500 chars.
{
  const long = "x".repeat(600);
  const { posts } = extractOfficeChat(`OFFICE[team]: ${long}`);
  assert.equal(posts[0]!.body.length, 500);
}

// Clean pass-through when no markers.
{
  const { visible, posts } = extractOfficeChat("Just normal implementor narration.\nNo office.");
  assert.deepEqual(posts, []);
  assert.equal(visible, "Just normal implementor narration.\nNo office.");
}

console.log("All officeBridge extraction checks passed.");
