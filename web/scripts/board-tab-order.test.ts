/**
 * The owner's own board tab order: every tab reads it (desktop strip, narrow select, phone menu,
 * Settings), a stale or partial saved order never drops or duplicates a tab, and a move among the
 * visible tabs leaves the hidden ones where they were.
 * Run: `npm run test:modules --prefix server`.
 */
import assert from "node:assert/strict";
import { BOARD_TABS, moveBoardTab, orderedBoardTabs, sanitizeTabOrder, visibleBoardTabs } from "../src/lib/boardTabs.js";
import type { BoardView } from "../src/types.js";

const views = (tabs: readonly { view: string }[]) => tabs.map((tab) => tab.view);
const defaults = views(BOARD_TABS);

assert.deepEqual(views(orderedBoardTabs([])), defaults, "no saved order keeps the built-in order");

const surveillanceSecond = views(orderedBoardTabs(["tasks", "surveillance"]));
assert.deepEqual(surveillanceSecond.slice(0, 2), ["tasks", "surveillance"], "a saved prefix leads");
assert.equal(surveillanceSecond.length, defaults.length, "tabs the saved order never mentions are kept");
assert.deepEqual(surveillanceSecond.slice(2), defaults.filter((v) => v !== "tasks" && v !== "surveillance"), "the rest keep their built-in order");

assert.deepEqual(sanitizeTabOrder(["home", "nope", "home", 3, "tasks"]), ["home", "tasks"], "unknown and repeated entries are dropped");
assert.deepEqual(sanitizeTabOrder("tasks"), []);

const shown = views(visibleBoardTabs([], true, "tasks", ["surveillance"], ["tasks", "surveillance"]));
assert.deepEqual(shown.slice(0, 2), ["tasks", "surveillance"], "the visible strip follows the saved order");
assert.deepEqual(views(visibleBoardTabs([], true, "tasks", [], [])), views(visibleBoardTabs([], true, "tasks", [])), "the order argument is optional");

const full = views(orderedBoardTabs([])) as BoardView[];
const moved = moveBoardTab([], "surveillance", "ide");
assert.equal(moved.indexOf("surveillance"), full.indexOf("ide"), "a dropped tab takes the target's place");
assert.equal(moved.indexOf("ide"), full.indexOf("ide") + 1, "the target shifts one along");
assert.equal(moved.length, full.length, "a move never loses a tab");
assert.deepEqual(moveBoardTab(moved, "surveillance", "surveillance"), moved, "dropping a tab on itself changes nothing");

const later = moveBoardTab([], "tasks", "notes");
assert.deepEqual(later.slice(0, 4), ["ide", "remote", "notes", "tasks"], "a tab moved later lands after the target");

console.log("board tab order: checks passed");
