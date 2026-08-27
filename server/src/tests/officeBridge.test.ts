// Office text-bridge extraction for CLI backends (Codex/Grok).
// Run: npx tsx src/tests/officeBridge.test.ts

import assert from "node:assert/strict";
import {
  endsWithOpenDeliverableMarker,
  endsWithOpenOfficeMarker,
  endsWithOpenOperatorNoteMarker,
  extractCliBridgeMessages,
  extractDeliverables,
  extractOfficeChat,
  extractOperatorNotes,
  MAX_OFFICE_BODY,
} from "../agents/officeBridge.js";

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

// CLI backends use a second bridge for the owner-facing note list. The marker is stripped from the
// transcript and the final ` | https://...` field becomes the click target, not part of the terse text.
{
  const raw = "Work is pushed.\nOPERATOR_NOTE: Review PR #42 before merging | https://github.com/acme/repo/pull/42\nThanks.";
  const { visible, notes } = extractOperatorNotes(raw);
  assert.deepEqual(notes, [{ body: "Review PR #42 before merging", url: "https://github.com/acme/repo/pull/42" }]);
  assert.ok(!visible.includes("OPERATOR_NOTE:"));
  assert.match(visible, /Work is pushed/);
  assert.match(visible, /Thanks/);
}

// If a CLI agent simply puts the URL in its short sentence, let OperatorNotes discover it exactly as the
// real MCP tool does instead of rejecting an otherwise useful note over one missing separator.
{
  const { notes } = extractOperatorNotes("OPERATOR_NOTE: PR is ready: https://github.com/acme/repo/pull/43");
  assert.deepEqual(notes, [{ body: "PR is ready: https://github.com/acme/repo/pull/43" }]);
}

// Grok's stream may split a marker across chunks. A mid-stream harvest must retain it; a terminal/newline
// flush can post the complete line. This prevents a partial `review PR` sentence becoming an owner task.
{
  const partial = extractOperatorNotes("OPERATOR_NOTE: review PR", { openEnded: false });
  assert.deepEqual(partial.notes, []);
  assert.equal(endsWithOpenOperatorNoteMarker(partial.visible), true);
  const complete = extractOperatorNotes(partial.visible + " #44 | https://github.com/acme/repo/pull/44\n", { openEnded: false });
  assert.deepEqual(complete.notes, [{ body: "review PR #44", url: "https://github.com/acme/repo/pull/44" }]);
  assert.equal(endsWithOpenOperatorNoteMarker(complete.visible), false);
}

// The lower-level office-then-notes ordering remains compatible for callers that do not need the
// composite three-bridge seam. One reply carrying both markers must deliver both and leave neither.
{
  const raw = [
    "Pushed the fix.",
    "OFFICE[team]: releasing officeBridge.ts, all yours",
    "OPERATOR_NOTE: PR #51 ready to merge | https://github.com/acme/repo/pull/51",
    "Done.",
  ].join("\n");
  const office = extractOfficeChat(raw);
  const { visible, notes } = extractOperatorNotes(office.visible);
  assert.deepEqual(
    office.posts,
    [{ scope: "project", body: "releasing officeBridge.ts, all yours" }],
    "the office post survives alongside a note marker",
  );
  assert.deepEqual(notes, [{ body: "PR #51 ready to merge", url: "https://github.com/acme/repo/pull/51" }]);
  assert.ok(!visible.includes("OFFICE[") && !visible.includes("OPERATOR_NOTE:"), "neither marker is left in the transcript");
  assert.match(visible, /Pushed the fix/);
  assert.match(visible, /Done\./);
}

// A junk body is the office bridge's oldest lesson, and the note list inherits it: strip the marker so
// it can't litter the transcript, but never put an unclickable row on the owner's list.
{
  for (const junk of ["OPERATOR_NOTE:\n", "OPERATOR_NOTE: \\n\n", "OPERATOR_NOTE: --- |\n"]) {
    const { visible, notes } = extractOperatorNotes(junk + "real text");
    assert.deepEqual(notes, [], `junk body must not post: ${JSON.stringify(junk)}`);
    assert.ok(!visible.includes("OPERATOR_NOTE"), `junk marker must still be stripped: ${JSON.stringify(junk)}`);
  }
}

// Two markers GLUED on one line — office-before-notes means the office body would otherwise eat the note
// marker whole, losing the owner's note AND broadcasting its PR link to the chatroom as a claim. Grok
// withholds the segment-separating newline while an OFFICE marker is open, so this is the common shape,
// not an exotic one: a separator of "", " " and ". " must all behave like a newline.
{
  for (const sep of ["", " ", ". "]) {
    const raw = `OFFICE[team]: claiming notes.ts${sep}OPERATOR_NOTE: PR #42 ready | https://github.com/acme/repo/pull/42\n`;
    const office = extractOfficeChat(raw);
    const { visible, notes } = extractOperatorNotes(office.visible);
    assert.equal(office.posts.length, 1, `one office post for separator ${JSON.stringify(sep)}`);
    assert.ok(
      !office.posts[0]!.body.includes("OPERATOR_NOTE"),
      `the office body must stop at the note marker (separator ${JSON.stringify(sep)})`,
    );
    assert.deepEqual(
      notes,
      [{ body: "PR #42 ready", url: "https://github.com/acme/repo/pull/42" }],
      `the note still lands for separator ${JSON.stringify(sep)}`,
    );
    assert.ok(!visible.includes("OPERATOR_NOTE") && !visible.includes("OFFICE["), "neither marker survives");
  }
}

// The extractors run CHAINED over one buffer, so each must honour the OTHER open markers: trimming a
// buffer that ends inside the other's half-streamed body eats the space the next chunk appends to.
{
  // Office marker open, no note marker — the notes pass must not trim the trailing space.
  const o1 = extractOfficeChat("Working on it.\nOFFICE[team]: claiming db.ts ", { openEnded: false });
  const n1 = extractOperatorNotes(o1.visible, { openEnded: false });
  const posts = extractOfficeChat(n1.visible + "and schema.ts\n", { openEnded: true }).posts;
  assert.deepEqual(posts, [{ scope: "project", body: "claiming db.ts and schema.ts" }], "a streamed office claim keeps its word break");

  // Note marker open, no office marker — the office pass (which runs first) must not trim it either.
  const o2 = extractOfficeChat("Done.\nOPERATOR_NOTE: review PR ", { openEnded: false });
  const n2 = extractOperatorNotes(o2.visible, { openEnded: false });
  assert.deepEqual(n2.notes, [], "a half-streamed note does not post");
  const finished = extractOperatorNotes(n2.visible + "#42 | https://x.example/p/42\n", { openEnded: true });
  assert.deepEqual(
    finished.notes,
    [{ body: "review PR #42", url: "https://x.example/p/42" }],
    "a streamed note keeps its word break",
  );
}

// CLI deliverables use a human-writable label/path line. A valid marker is stripped from the feed and
// becomes the exact payload ThreadManager records as a deliverable finding.
{
  const raw = "Built the guide.\nDELIVERABLE: Free provider setup guide | C:\\claude-orchestrator\\docs\\free-ai-provider-connections.md\nDone.";
  const { visible, deliverables } = extractDeliverables(raw);
  assert.deepEqual(deliverables, [
    {
      label: "Free provider setup guide",
      path: "C:\\claude-orchestrator\\docs\\free-ai-provider-connections.md",
    },
  ]);
  assert.ok(!visible.includes("DELIVERABLE:"));
  assert.match(visible, /Built the guide/);
  assert.match(visible, /Done\./);
}

// Ordinary prose that happens to say "deliverable:" is not the wire grammar and must remain visible.
{
  const raw = "The deliverable: provider guide is ready for review.";
  const { visible, deliverables } = extractDeliverables(raw);
  assert.deepEqual(deliverables, []);
  assert.equal(visible, raw);
}

// A streamed Grok marker stays buffered until its path is complete; no partial card can be recorded.
{
  const partial = extractDeliverables("DELIVERABLE: Provider report | C:\\work\\provider", { openEnded: false });
  assert.deepEqual(partial.deliverables, []);
  assert.equal(endsWithOpenDeliverableMarker(partial.visible), true);
  const complete = extractDeliverables(partial.visible + "-report.md\nContinuing.", { openEnded: false });
  assert.deepEqual(complete.deliverables, [{ label: "Provider report", path: "C:\\work\\provider-report.md" }]);
  assert.equal(endsWithOpenDeliverableMarker(complete.visible), false);
  assert.match(complete.visible, /Continuing\./);
}

// Grok omits separators between model turns. A deliverable immediately followed by structured JSON or
// capitalized narration must keep an exact path, and a fenced JSON block must remain byte-valid.
{
  const fenced = extractCliBridgeMessages(
    'DELIVERABLE: QA evidence | C:\\work\\qa-evidence.md```json\n{"pass":true,"summary":"verified"}\n```',
  );
  assert.deepEqual(fenced.deliverables, [{ label: "QA evidence", path: "C:\\work\\qa-evidence.md" }]);
  assert.match(fenced.visible, /^```json\n/);
  assert.match(fenced.visible, /"pass":true/);

  const unfenced = extractCliBridgeMessages(
    'DELIVERABLE: QA evidence | C:\\work\\qa-evidence.md{"pass":true,"summary":"verified"}',
  );
  assert.deepEqual(unfenced.deliverables, [{ label: "QA evidence", path: "C:\\work\\qa-evidence.md" }]);
  assert.match(unfenced.visible, /^\{"pass":true/);

  const narrated = extractCliBridgeMessages("DELIVERABLE: QA evidence | C:\\work\\qa-evidence.mdFinished verification.");
  assert.deepEqual(narrated.deliverables, [{ label: "QA evidence", path: "C:\\work\\qa-evidence.md" }]);
  assert.match(narrated.visible, /Finished verification\./);
}

// Both runners use the composite extractor. All three markers may arrive glued in one Grok segment;
// each side effect must survive, while none of the bridge syntax reaches the persisted transcript.
{
  const raw =
    "Pushed." +
    "OFFICE[team]: releasing officeBridge.ts" +
    "DELIVERABLE: Bridge verification report | C:\\work\\bridge-report.md" +
    "OPERATOR_NOTE: PR #77 ready | https://github.com/acme/repo/pull/77\nFinished.";
  const result = extractCliBridgeMessages(raw);
  assert.deepEqual(result.posts, [{ scope: "project", body: "releasing officeBridge.ts" }]);
  assert.deepEqual(result.deliverables, [{ label: "Bridge verification report", path: "C:\\work\\bridge-report.md" }]);
  assert.deepEqual(result.notes, [{ body: "PR #77 ready", url: "https://github.com/acme/repo/pull/77" }]);
  assert.ok(!/OFFICE\[|OPERATOR_NOTE:|DELIVERABLE:/.test(result.visible), "all bridge markers are stripped");
  assert.match(result.visible, /Pushed\./);
  assert.match(result.visible, /Finished\./);
}

// Chaining the extractors mid-stream must preserve a deliverable's trailing space for the next chunk.
{
  const first = extractCliBridgeMessages("Done.\nDELIVERABLE: Final report | C:\\work\\final ", { openEnded: false });
  assert.deepEqual(first.deliverables, []);
  const finished = extractCliBridgeMessages(first.visible + "report.md\n", { openEnded: true });
  assert.deepEqual(finished.deliverables, [{ label: "Final report", path: "C:\\work\\final report.md" }]);
}

console.log("All officeBridge extraction checks passed.");
