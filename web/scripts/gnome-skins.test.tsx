/**
 * Gate: the gnome skins, and the promises the owner signed off on.
 *
 *   npm run test:gnome-skins --prefix server
 *
 *   · rare skins stay rare: about 10% everyday and 1% super rare outside December,
 *   · every gnome wears a Santa hat in December unless it rolled a rare skin,
 *   · a skin decorates the gnome but never replaces it: the role-colored hat and the tool are drawn
 *     under every skin, except that the Santa hat turns the whole hat red and the crown replaces it
 *     with a crown over a role-colored cap (the owner's calls), while the robe keeps the role color.
 */

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EVERYDAY_SKINS, FESTIVE_SKINS, SUPER_RARE_SKINS, Gnome, rollRareSkin, type RareSkin } from "../src/components/Gnome.js";

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
const septSuperRare = share(sept, SUPER_RARE_SKINS);
assert.ok(septSuperRare > 0.007 && septSuperRare < 0.013, `super rare share outside December was ${septSuperRare}`);
assert.equal(share(sept, [...FESTIVE_SKINS, "santa"]), 0, "a festive skin appeared outside December");
assert.equal((sept.get(null) ?? 0) + [...EVERYDAY_SKINS, ...SUPER_RARE_SKINS].reduce((n, skin) => n + (sept.get(skin) ?? 0), 0), ROLLS, "something other than plain, rare or super rare was rolled");
for (const skin of EVERYDAY_SKINS) assert.ok((sept.get(skin) ?? 0) > 0, `${skin} never came up`);
for (const skin of SUPER_RARE_SKINS) assert.ok((sept.get(skin) ?? 0) > 0, `${skin} never came up`);

// December: every gnome that misses the rare roll wears a Santa hat; festive skins join the rare pool.
const dec = tally(DECEMBER);
assert.equal(dec.get(null) ?? 0, 0, "a December gnome went without a skin");
const santa = share(dec, ["santa"]);
assert.ok(santa > 0.875 && santa < 0.905, `Santa share in December was ${santa}`);
const decFestive = share(dec, FESTIVE_SKINS);
assert.ok(decFestive > 0.035 && decFestive < 0.065, `festive rare share in December was ${decFestive}`);
const decRare = share(dec, [...EVERYDAY_SKINS, ...FESTIVE_SKINS]);
assert.ok(decRare > 0.085 && decRare < 0.115, `rare share in December was ${decRare}`);
const decSuperRare = share(dec, SUPER_RARE_SKINS);
assert.ok(decSuperRare > 0.007 && decSuperRare < 0.013, `super rare share in December was ${decSuperRare}`);
for (const skin of FESTIVE_SKINS) assert.ok((dec.get(skin) ?? 0) > 0, `${skin} never came up in December`);

// Every skin keeps the gnome: the role-colored hat and the role's tool render under it.
const HAT_D = 'd="M21 5C15 11 10 21 8 31c6-1.5 16-1.5 22 0C28 21 26 11 21 5Z" fill="currentColor"';
const plainPlanner = renderToStaticMarkup(<Gnome role="planner" skin={null} />);
assert.ok(plainPlanner.includes(HAT_D), "the plain gnome lost its hat");
assert.ok(!plainPlanner.includes("<clipPath"), "the plain gnome drew a skin");
for (const skin of [...EVERYDAY_SKINS, ...FESTIVE_SKINS, ...SUPER_RARE_SKINS, "santa"] as RareSkin[]) {
  const html = renderToStaticMarkup(<Gnome role="planner" skin={skin} />);
  if (skin === "santa" || skin === "crown") {
    assert.ok(!html.includes(HAT_D), `${skin} did not replace the hat`);
    assert.ok(html.includes('d="M11 30C7 33 6 41 8 48h20c2-7 1-15-3-18-3 3-11 3-14 0Z" fill="currentColor"'), `the ${skin} gnome lost its role-colored robe`);
    if (skin === "santa") assert.ok(html.includes('fill="oklch(0.56 0.2 27)"'), "the Santa hat is not red");
    if (skin === "crown") assert.ok(html.includes('17.4 19 17.4s10 5 10 13.2c-6-1.4-14-1.4-20 0Z" fill="currentColor"'), "the crown lost its role-colored cap");
  } else {
    assert.ok(html.includes(HAT_D), `${skin} hid the role-colored hat`);
  }
  assert.ok(html.includes('rect x="28.8" y="24"'), `${skin} dropped the planner's clipboard`);
  assert.ok(html.length > plainPlanner.length, `${skin} drew nothing`);
}

// The crown and the phoenix flame take the pom's place rather than stacking on it; the Santa hat keeps it.
const GNOME_POM = 'cx="22" cy="5"';
assert.ok(plainPlanner.includes(GNOME_POM));
assert.ok(renderToStaticMarkup(<Gnome role="planner" skin="santa" />).includes(GNOME_POM), "the Santa hat lost its pom");
for (const skin of ["crown", "phoenix"] as RareSkin[]) {
  assert.ok(!renderToStaticMarkup(<Gnome role="planner" skin={skin} />).includes(GNOME_POM), `${skin} sat on top of the gnome's pom`);
}

// Only the cloud gnome floats; the bob lives on its own class so no other gnome moves.
assert.ok(renderToStaticMarkup(<Gnome role="planner" skin="cloud" />).includes("gnome-floating"), "the cloud gnome does not float");
for (const skin of [...EVERYDAY_SKINS, ...FESTIVE_SKINS, ...SUPER_RARE_SKINS, "santa", null] as (RareSkin | null)[]) {
  if (skin === "cloud") continue;
  assert.ok(!renderToStaticMarkup(<Gnome role="planner" skin={skin} />).includes("gnome-floating"), `${skin ?? "plain"} floats`);
}

// Only an active super rare gnome gets the premium glow and motions; a greyed-out one, or any
// everyday or festive skin, stays plain.
for (const skin of SUPER_RARE_SKINS) {
  const lit = renderToStaticMarkup(<Gnome role="planner" skin={skin} />);
  assert.ok(lit.includes("gnome-super") && lit.includes("--gnome-glow"), `${skin} has no premium glow`);
  assert.ok(!renderToStaticMarkup(<Gnome role="planner" skin={skin} active={false} />).includes("gnome-super"), `a greyed-out ${skin} still glows`);
}
for (const skin of [...EVERYDAY_SKINS, ...FESTIVE_SKINS, "santa", null] as (RareSkin | null)[]) {
  assert.ok(!renderToStaticMarkup(<Gnome role="planner" skin={skin} />).includes("gnome-super"), `${skin ?? "plain"} glows like a super rare`);
}

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
