/**
 * Visibility of the optional local-service tabs (Script Hub, Surveillance, Home, Sidekick): hidden until
 * switched on, unaffected by the ordinary hide list, and never stored as anything but a known module.
 * Run: `npm run test:modules --prefix server`.
 */
import assert from "node:assert/strict";
import { BOARD_TABS, MODULE_VIEWS, isHideableTab, sanitizeHiddenTabs, sanitizeShownModules, visibleBoardTabs } from "../src/lib/boardTabs.js";

const views = (tabs: { view: string }[]) => tabs.map((tab) => tab.view);

const fresh = views(visibleBoardTabs([], true, "tasks", []));
for (const module of MODULE_VIEWS) assert.ok(!fresh.includes(module), `${module} is hidden by default`);
assert.ok(fresh.includes("calendar"), "ordinary tabs still show");

const two = views(visibleBoardTabs([], true, "tasks", ["home", "scripthub"]));
assert.ok(two.includes("home") && two.includes("scripthub"), "switched-on modules show");
assert.ok(!two.includes("surveillance") && !two.includes("sidekick"), "others stay hidden");
assert.deepEqual(two.filter((v) => MODULE_VIEWS.includes(v as never)), ["scripthub", "home"], "modules keep the tab order, not the order they were switched on");

assert.ok(views(visibleBoardTabs([], true, "sidekick", [])).includes("sidekick"), "the open view keeps its heading");
assert.ok(!views(visibleBoardTabs([], false, "remote", [])).includes("remote"), "remote control still needs to be set up");

for (const module of MODULE_VIEWS) assert.equal(isHideableTab(module), false, `${module} is not on the hide list`);
assert.deepEqual(sanitizeHiddenTabs(["home", "calendar"]), ["calendar"], "a module never lands in the hide list");
assert.deepEqual(sanitizeShownModules(["sidekick", "tasks", "nope", "scripthub"]), ["scripthub", "sidekick"]);
assert.deepEqual(sanitizeShownModules("home"), []);
assert.equal(BOARD_TABS.filter((tab) => tab.optional).length, MODULE_VIEWS.length, "every module tab is marked optional");

console.log("module tabs: visibility checks passed");
