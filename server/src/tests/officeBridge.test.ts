// Office text-bridge extraction for CLI backends (Codex/Grok).
// Run: npx tsx src/tests/officeBridge.test.ts

import assert from "node:assert/strict";
import { endsWithOpenOfficeMarker, extractOfficeChat, MAX_OFFICE_BODY } from "../agents/officeBridge.js";

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
// separator, the body runs to end-of-string (capped) — post still fires, marker still strips.
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

// Body capped at MAX_OFFICE_BODY.
{
  const long = "x".repeat(600);
  const { posts } = extractOfficeChat(`OFFICE[team]: ${long}`);
  assert.ok(posts[0]!.body.length <= MAX_OFFICE_BODY);
}

// Clean pass-through when no markers.
{
  const { visible, posts } = extractOfficeChat("Just normal implementor narration.\nNo office.");
  assert.deepEqual(posts, []);
  assert.equal(visible, "Just normal implementor narration.\nNo office.");
}

// REAL prod failure (Mads/trading_orchestrator, 2026-07-20): Grok glued successive model turns into
// one blob. The first OFFICE claim must NOT swallow the following narration, and a second OFFICE
// later in the blob must still post as its own short message. Prior extractor produced one mega-body
// that included "Implementing…", "Next up…", and a nested second OFFICE[team] marker.
{
  const raw =
    "I will integrate Grok." +
    "OFFICE[team]: claiming trading_orchestrator grok integration — orchestrator.py, agent_spawn.ps1, new grok_agent_loop.ps1, selftest, README; plus script-hub agent-orchestrator SCHEMA/HTML" +
    "Implementing the multi-provider failover, Grok account row, spawn/loop scripts, and dashboard wiring." +
    "Next up: spawn path and Grok agent loop." +
    "Accounts show Grok live. Committing and pushing both repos, then restarting the services." +
    "OFFICE[team]: Grok fully integrated in trading_orchestrator — accounts row, 3-way failover, spawn ";
  const { visible, posts } = extractOfficeChat(raw);
  assert.equal(posts.length, 2, `expected 2 posts, got ${posts.length}: ${JSON.stringify(posts)}`);
  assert.match(posts[0]!.body, /^claiming trading_orchestrator/);
  assert.ok(!posts[0]!.body.includes("Implementing"), `first body swallowed narration: ${posts[0]!.body}`);
  assert.ok(!posts[0]!.body.includes("OFFICE["), `first body nested a second marker: ${posts[0]!.body}`);
  assert.match(posts[1]!.body, /^Grok fully integrated/);
  assert.ok(!visible.includes("OFFICE["));
  // Narration after the claim must remain visible in the transcript.
  assert.match(visible, /Implementing the multi-provider/);
  assert.match(visible, /I will integrate Grok/);
}

// Glued turn after a finished sentence: body ends at the period, next sentence stays visible.
{
  const raw = "OFFICE[team]: claiming accounts/routing.Next I will edit threadManager.";
  const { visible, posts } = extractOfficeChat(raw);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.body, "claiming accounts/routing.");
  assert.match(visible, /Next I will edit threadManager/);
}

// Marker mid-string with a trailing newline then more content (weekly-safety shape).
{
  const raw =
    "Safety commits are already on master. I'll verify nothing is still incomplete." +
    "OFFICE[team]: weekly-safety feature already shipped on master (9c367d5) — not editing\n\n" +
    "## Status: already complete";
  const { visible, posts } = extractOfficeChat(raw);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.body, /weekly-safety feature already shipped/);
  assert.ok(!posts[0]!.body.includes("## Status"));
  assert.match(visible, /## Status: already complete/);
  assert.ok(!visible.includes("OFFICE["));
}

// Empty body — strip the marker, post nothing (Grok segment harvest relies on this to stay idempotent).
{
  const { visible, posts } = extractOfficeChat("Before.\nOFFICE[team]:\nAfter.");
  assert.deepEqual(posts, []);
  assert.ok(!visible.includes("OFFICE["));
  assert.match(visible, /Before/);
  assert.match(visible, /After/);
}

// Re-extracting the already-stripped visible text must not produce a second post (segment harvest + flush).
{
  const once = extractOfficeChat("OFFICE[team]: claiming foo.ts\nContinuing.");
  assert.equal(once.posts.length, 1);
  const twice = extractOfficeChat(once.visible);
  assert.deepEqual(twice.posts, []);
  assert.equal(twice.visible, once.visible);
}

// REAL prod failure (Fen/claude-orchestrator, 2026-07-20): Grok streams tokens and interleaves
// thought events mid-answer. Mid-segment harvest with openEnded bodies posted truncated fragments
// ("claimi") and junk ("\n"). Closed-ended harvest must leave incomplete markers unposted.
{
  const partial = extractOfficeChat("OFFICE[team]: claimi", { openEnded: false });
  assert.deepEqual(partial.posts, [], `mid-stream partial must not post: ${JSON.stringify(partial.posts)}`);
  assert.match(partial.visible, /OFFICE\[team\]:\s*claimi/);

  // More tokens arrive — still no hard terminator.
  const stillOpen = extractOfficeChat(partial.visible + "ng officeBridge.ts", { openEnded: false });
  assert.deepEqual(stillOpen.posts, []);
  assert.match(stillOpen.visible, /claiming officeBridge\.ts/);

  // Newline completes the claim — now it posts.
  const done = extractOfficeChat(stillOpen.visible + "\nContinuing the fix.", { openEnded: false });
  assert.equal(done.posts.length, 1);
  assert.equal(done.posts[0]!.body, "claiming officeBridge.ts");
  assert.match(done.visible, /Continuing the fix/);
  assert.ok(!done.visible.includes("OFFICE["));
}

// Final flush may accept open-ended bodies (message ends without a trailing newline).
{
  const fin = extractOfficeChat("OFFICE[team]: claiming officeBridge.ts for the team-chat fix", { openEnded: true });
  assert.equal(fin.posts.length, 1);
  assert.match(fin.posts[0]!.body, /claiming officeBridge/);
}

// Junk bodies (literal \n escape, punctuation-only) never post, even when terminated.
{
  const junk = extractOfficeChat("Before.\nOFFICE[team]: \\n\nAfter.", { openEnded: true });
  assert.deepEqual(junk.posts, []);
  assert.ok(!junk.visible.includes("OFFICE["));
  assert.match(junk.visible, /Before/);
  assert.match(junk.visible, /After/);
}

// endsWithOpenOfficeMarker drives whether Grok appends a segment-separator newline.
{
  assert.equal(endsWithOpenOfficeMarker("OFFICE[team]: claimi"), true);
  assert.equal(endsWithOpenOfficeMarker("OFFICE[team]: claiming foo.ts\n"), false);
  assert.equal(endsWithOpenOfficeMarker("Just narration, no marker."), false);
  assert.equal(endsWithOpenOfficeMarker("Done.\nOFFICE[team]: claiming a\nMore text."), false);
}

// Mid-segment: complete claim + incomplete second marker — post the first, keep the second.
{
  const mixed = extractOfficeChat(
    "OFFICE[team]: claiming A\nmid\nOFFICE[team]: claimi",
    { openEnded: false },
  );
  assert.equal(mixed.posts.length, 1);
  assert.equal(mixed.posts[0]!.body, "claiming A");
  assert.match(mixed.visible, /OFFICE\[team\]:\s*claimi/);
  assert.match(mixed.visible, /mid/);
}

console.log("All officeBridge extraction checks passed.");
