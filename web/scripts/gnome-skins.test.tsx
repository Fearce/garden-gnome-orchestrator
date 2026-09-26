/**
 * Gate: the gnome skins, and the promises the owner signed off on.
 *
 *   npm run test:gnome-skins --prefix server
 *
 *   · rare skins stay rare: about 10% of gnomes outside December, and never a festive one,
 *   · every gnome wears a Santa hat in December unless it rolled a rare skin,
 *   · a skin decorates the gnome but never replaces it: the role-colored hat and the tool are drawn
 *     under every skin, and the Santa hat brings its own pom instead of stacking on the gnome's.
 */

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EVERYDAY_SKINS, FESTIVE_SKINS, Gnome, rollRareSkin, type RareSkin } from "../src/components/Gnome.js";

const ROLLS = 40_000;
const SEPTEMBER = new Date(2026, 8, 26);
const DECEMBER = new Date(2026, 11, 12);

function tally(now: Date): Map<RareSkin | null, number> {
  const counts = new Map<RareSkin | null, number>();
  for (let i = 0; i < ROLLS; i++) {
    const skin = rollRareSkin(now);
    counts.set(skin, (counts.get(skin) ?? 0) + 1);
  }
  return counts;
}

const share = (counts: Map<RareSkin | null, number>, keys: readonly (RareSkin | null)[]) =>
  keys.reduce((n, k) => n + (counts.get(k) ?? 0), 0) / ROLLS;

// Outside December: ~10% rare, the rest plain, no festive skin and no Santa hat.
const sept = tally(SEPTEMBER);
const septRare = share(sept, EVERYDAY_SKINS);
assert.ok(septRare > 0.085 && septRare < 0.115, `rare share outside December was ${septRare}`);
assert.equal(share(sept, [...FESTIVE_SKINS, "santa"]), 0, "a festive skin appeared outside December");
assert.equal(share(sept, [null]) + septRare, 1, "something other than plain or an everyday skin was rolled");
for (const skin of EVERYDAY_SKINS) assert.ok((sept.get(skin) ?? 0) > 0, `${skin} never came up`);

// December: every gnome that misses the rare roll wears a Santa hat; festive skins join the rare pool.
const dec = tally(DECEMBER);
assert.equal(dec.get(null) ?? 0, 0, "a December gnome went without a skin");
const santa = share(dec, ["santa"]);
assert.ok(santa > 0.885 && santa < 0.915, `Santa share in December was ${santa}`);
const decFestive = share(dec, FESTIVE_SKINS);
assert.ok(decFestive > 0.035 && decFestive < 0.065, `festive rare share in December was ${decFestive}`);
for (const skin of FESTIVE_SKINS) assert.ok((dec.get(skin) ?? 0) > 0, `${skin} never came up in December`);

// Every skin keeps the gnome: the role-colored hat and the role's tool render under it.
const HAT_D = 'd="M21 5C15 11 10 21 8 31c6-1.5 16-1.5 22 0C28 21 26 11 21 5Z" fill="currentColor"';
const plainPlanner = renderToStaticMarkup(<Gnome role="planner" skin={null} />);
assert.ok(plainPlanner.includes(HAT_D), "the plain gnome lost its hat");
assert.ok(!plainPlanner.includes("<clipPath"), "the plain gnome drew a skin");
for (const skin of [...EVERYDAY_SKINS, ...FESTIVE_SKINS, "santa"] as RareSkin[]) {
  const html = renderToStaticMarkup(<Gnome role="planner" skin={skin} />);
  assert.ok(html.includes(HAT_D), `${skin} hid the role-colored hat`);
  assert.ok(html.includes('rect x="28.8" y="24"'), `${skin} dropped the planner's clipboard`);
  assert.ok(html.length > plainPlanner.length, `${skin} drew nothing`);
}

// The Santa hat brings its own pom rather than stacking on the gnome's.
const GNOME_POM = 'cx="22" cy="5"';
assert.ok(plainPlanner.includes(GNOME_POM));
assert.ok(!renderToStaticMarkup(<Gnome role="planner" skin="santa" />).includes(GNOME_POM), "the Santa hat sat on top of the gnome's pom");

// Two gnomes on one page must not share a hat clip, or the second skin clips to the first gnome.
const pair = renderToStaticMarkup(
  <>
    <Gnome role="qa" skin="starry" />
    <Gnome role="qa" skin="starry" />
  </>,
);
const ids = [...pair.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
assert.equal(ids.length, 2);
assert.notEqual(ids[0], ids[1], "two gnomes share a clipPath id");

console.log("gnome-skins: all checks passed");
