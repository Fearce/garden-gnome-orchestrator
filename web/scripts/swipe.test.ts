import assert from "node:assert/strict";
import { classifyDrag, commitsAt, paneAfterSwipe } from "../src/lib/swipe.js";

/**
 * The decisions behind the phone swipe gestures, without a browser: which way a drag is going, when a
 * release closes a sheet or changes pane, and which pane a sideways swipe leads to. The touch wiring
 * itself is driven in a real mobile browser by `npm run swipe-lab --prefix server`.
 *
 * Run: npm run test:swipe --prefix server
 */

// A finger resting on the glass drifts a few pixels; that must not pick a direction yet.
assert.equal(classifyDrag(0, 0), "pending");
assert.equal(classifyDrag(6, 6), "pending");

assert.equal(classifyDrag(0, 40), "down");
assert.equal(classifyDrag(0, -40), "up");
assert.equal(classifyDrag(40, 0), "right");
assert.equal(classifyDrag(-40, 0), "left");

// A slightly diagonal vertical scroll stays a scroll, so a board scroll never flips the pane.
assert.equal(classifyDrag(30, 28), "down");
assert.equal(classifyDrag(-30, -28), "up");
// Sideways needs a clear lead over vertical.
assert.equal(classifyDrag(40, 20), "right");

// Far enough commits regardless of speed; a slow short drag springs back; a quick flick commits.
assert.equal(commitsAt(200, 0.05, 180), true);
assert.equal(commitsAt(100, 0.1, 180), false);
assert.equal(commitsAt(60, 0.9, 180), true);
// ...but not a twitch, however fast.
assert.equal(commitsAt(20, 3, 180), false);

// The Director is the left tab: dragging right reveals it, dragging left goes back to the board.
assert.equal(paneAfterSwipe("board", 120), "director");
assert.equal(paneAfterSwipe("director", -120), "board");
assert.equal(paneAfterSwipe("board", -120), null);
assert.equal(paneAfterSwipe("director", 120), null);

console.log("swipe: ok");
