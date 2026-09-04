/**
 * Gate: the Appearance themes, and the one invariant that makes them safe.
 *
 *   npm run test:themes --prefix server
 *
 * "Classic must stay EXACTLY as it is" is not a promise anyone can keep by reading a diff — a second
 * theme is thousands of declarations, and one of them landing outside its scope changes the console
 * for an owner who never opted in. The mechanism is that Classic sets NO attribute on <html>, so
 * every rule of every other theme has to be behind `[data-theme="<id>"]`. This file is what enforces
 * that, plus the four quieter ways the same guarantee leaks:
 *
 *   · a @keyframes name in a theme file colliding with one in styles.css (animation names are global,
 *     so a collision silently re-animates Classic),
 *   · a theme shipping without being listed in index.html's pre-paint script (it would flash Classic
 *     on every reload),
 *   · styles.css itself learning about a theme, which would make Classic conditional,
 *   · a Classic rule that hard-codes the amber accent instead of reading --accent, which then stays
 *     amber on a theme that never chose it (the leak runs the other way: Classic into the theme).
 *
 * It also renders the picker, because a theme nobody can select is not shipped.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(WEB, rel), "utf8");

// See model-request-ui.test.tsx: this gate is launched from the server package, whose tsx may compile
// the imported web JSX in classic mode, so the runtime has to be reachable as a global.
Object.assign(globalThis, { React });
const { THEMES, DEFAULT_THEME, isThemeId } = await import("../src/lib/theme.js");
const { ThemePicker } = await import("../src/components/ThemePicker.js");

const nonDefault = THEMES.filter((t) => t.id !== DEFAULT_THEME);
assert.ok(nonDefault.length >= 1, "there must be at least one theme besides the default");
assert.equal(DEFAULT_THEME, "classic", "Classic is the untouched console, so it has to remain the default");

/* ---- 1. every themed rule is scoped ------------------------------------------------------------ */

interface Rule {
  selector: string;
  atRule: string | null;
}

/** Selectors of every style rule in a stylesheet, with the at-rule they sit inside (if any).
 *  Keyframe steps (`0%`, `from`) are not selectors and are skipped. */
function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Rule[] = [];
  const stack: (string | null)[] = [];
  let prelude = "";
  for (const ch of src) {
    if (ch === "{") {
      const head = prelude.trim();
      const inKeyframes = stack.some((a) => a?.startsWith("@keyframes"));
      if (head.startsWith("@")) stack.push(head);
      else {
        if (!inKeyframes) for (const sel of head.split(",")) found.push({ selector: sel.trim(), atRule: stack.at(-1) ?? null });
        stack.push(null);
      }
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else if (ch === ";" && stack.at(-1) === undefined) {
      prelude = ""; // a top-level @import/@charset
    } else {
      prelude += ch;
    }
  }
  assert.equal(stack.length, 0, "unbalanced braces while parsing a stylesheet");
  return found;
}

/** The two attributes that keep a rule out of Classic's way. `data-theme` gates the whole document;
 *  `data-theme-preview` only ever matches a tile the Appearance picker renders, which is how a
 *  thumbnail can show a theme that is not the active one. */
const SCOPED = /\[data-theme(-preview)?[~^]?=/;

const keyframeNames = (css: string): string[] =>
  Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g), (m) => m[1]!);

const classic = read("src/styles.css");
const classicAnimations = new Set(keyframeNames(classic));

for (const theme of nonDefault) {
  const rel = `src/themes/${theme.id}.css`;
  assert.ok(fs.existsSync(path.join(WEB, rel)), `theme "${theme.id}" has no stylesheet at ${rel}`);
  const css = read(rel);

  const escaped = rules(css).filter((r) => !SCOPED.test(r.selector));
  assert.deepEqual(
    escaped.map((r) => r.selector),
    [],
    `${rel}: rule(s) that are not behind [data-theme…] — these apply on Classic too, which is the one ` +
      "thing a theme may never do",
  );

  const collisions = keyframeNames(css).filter((n) => classicAnimations.has(n));
  assert.deepEqual(collisions, [], `${rel}: @keyframes name(s) already used by styles.css — animation names are global: ${collisions.join(", ")}`);
  const unprefixed = keyframeNames(css).filter((n) => !n.startsWith(`${theme.id}-`));
  assert.deepEqual(unprefixed, [], `${rel}: @keyframes must be prefixed "${theme.id}-" so a future theme cannot collide: ${unprefixed.join(", ")}`);

  assert.ok(
    read("src/main.tsx").includes(`./themes/${theme.id}.css`),
    `${rel} is never imported, so the theme would select but never render`,
  );
}

/* ---- 2. Classic is unconditional -------------------------------------------------------------- */

assert.ok(
  !rules(classic).some((r) => SCOPED.test(r.selector)),
  "styles.css must not select on data-theme — Classic is the sheet, not a branch of it",
);

/* ---- 3. the pre-paint script knows every theme -------------------------------------------------- */

const html = read("index.html");
const bootList = html.match(/\[([^\]]*)\]\.indexOf\(t\)/);
assert.ok(bootList, "index.html no longer carries the pre-paint theme script");
const booted = Array.from(bootList[1]!.matchAll(/"([^"]+)"/g), (m) => m[1]!);
assert.deepEqual(
  booted.sort(),
  nonDefault.map((t) => t.id).sort(),
  "index.html's pre-paint script must list exactly the non-default theme ids, or that theme flashes Classic on every load",
);
for (const id of booted) assert.ok(isThemeId(id), `index.html paints "${id}", which is not a known theme`);

// The script cannot import the store, so it names the record as a string literal. Renaming the key
// would leave it reading nothing — and reading nothing is Classic, which looks exactly like a theme
// that failed to persist rather than one that failed to be painted early enough.
const storeKey = read("src/store.ts").match(/const VIEW_SETTINGS_KEY = "([^"]+)"/);
assert.ok(storeKey, "store.ts no longer declares VIEW_SETTINGS_KEY");
assert.ok(
  html.includes(`localStorage.getItem("${storeKey[1]!}")`),
  `index.html's pre-paint script reads a different record than the store writes ("${storeKey[1]!}")`,
);

/* ---- 4. the picker actually offers them --------------------------------------------------------- */

const render = (value: (typeof THEMES)[number]["id"]): string =>
  renderToStaticMarkup(React.createElement(ThemePicker, { value, onChange: () => {} }));

/** React does not promise attribute ORDER in its markup, so read the tile's opening tag and look
 *  inside it rather than matching the two attributes in sequence. */
const checked = (markup: string, id: string): boolean => {
  const tag = markup.match(new RegExp(`<button[^>]*data-theme-option="${id}"[^>]*>`));
  assert.ok(tag, `the picker omits "${id}"`);
  return /aria-checked="true"/.test(tag[0]);
};

const onClassic = render("classic");
for (const theme of THEMES) {
  assert.match(onClassic, new RegExp(`data-theme-preview="${theme.id}"`), `"${theme.id}" has no live sample tile`);
  assert.ok(onClassic.includes(theme.name), `the picker never names "${theme.name}"`);
}
assert.ok(checked(onClassic, "classic"), "Classic must read as the active tile on a fresh console");

const second = nonDefault[0]!.id;
const onSecond = render(second);
assert.equal((onSecond.match(/aria-checked="true"/g) ?? []).length, 1, "exactly one tile is ever the active one");
assert.ok(checked(onSecond, second), `selecting "${second}" must mark its own tile active`);
assert.ok(!checked(onSecond, "classic"), "Classic must stop reading as active once another theme is chosen");

// A radio group takes ONE tab stop and is walked with the arrow keys, so exactly one tile may be
// tabbable and it has to be the chosen one — otherwise Tab lands on a tile the arrows then move away
// from, and the group is unreachable in the order a keyboard user expects.
for (const [markup, active] of [
  [onClassic, "classic"],
  [onSecond, second],
] as const) {
  const tabbable = Array.from(markup.matchAll(/<button[^>]*data-theme-option="([^"]+)"[^>]*>/g)).filter((m) =>
    /tabindex="0"/i.test(m[0]),
  );
  assert.deepEqual(
    tabbable.map((m) => m[1]!),
    [active],
    `with "${active}" chosen, it must be the group's only tab stop`,
  );
}

/* ---- 5. it is reachable in Settings -------------------------------------------------------------- */

const panel = read("src/components/SettingsPanel.tsx");
assert.match(panel, /id: "appearance".*label: "Appearance"/, "no Appearance category in SETTINGS_CATEGORIES");
assert.match(panel, /category === "appearance"/, "the Appearance category has no icon arm, so the rail cannot draw it");
assert.match(panel, /<SettingsCategoryPanel id="appearance"/, "a Group outside a category panel renders on EVERY settings page");

/* ---- 6. nothing paints Classic's accent behind the theme's back --------------------------------- */

// Retinting `--accent` is how a theme changes the console's signal colour — except styles.css writes
// the amber literal directly in every focus ring rather than deriving it, so those rings stay amber on
// a theme that never chose amber. Each one is met by name in the theme stylesheet; this is what stops
// the tenth ring from being added without one, which is invisible until someone types in a field.
const CLASSIC_ACCENT = /oklch\(0\.(?:83|78) 0\.16 78/;

interface Block {
  head: string;
  body: string;
}

/** Every style rule with its declarations, at-rules included so a nested block is still reached. */
function blocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const open: { head: string; from: number }[] = [];
  let prelude = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "{") {
      open.push({ head: prelude.trim(), from: i + 1 });
      prelude = "";
    } else if (ch === "}") {
      const block = open.pop();
      if (block && !block.head.startsWith("@")) out.push({ head: block.head, body: src.slice(block.from, i) });
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  assert.equal(open.length, 0, "unbalanced braces while parsing a stylesheet");
  return out;
}

for (const theme of nonDefault) {
  const css = read(`src/themes/${theme.id}.css`);
  // Answered means a RULE answers it. The raw text also carries comments, so a substring check
  // against the whole file is satisfiable by naming the selector in a comment — the false-negative
  // direction a gate must not open. A theme's rule is the Classic selector scoped
  // (`[data-theme="…"] <selector>`), so the Classic selector appears inside one of its heads.
  const heads = blocks(css).flatMap((b) => b.head.split(",").map((s) => s.trim()));
  const unmet = blocks(classic)
    // `:root` is the token block itself — a theme answers it by redefining --accent, not by name.
    .filter((b) => b.head !== ":root" && CLASSIC_ACCENT.test(b.body))
    .flatMap((b) => b.head.split(",").map((s) => s.trim()))
    .filter((selector) => !heads.some((h) => h.includes(selector)));
  assert.deepEqual(
    unmet,
    [],
    `src/themes/${theme.id}.css never answers these rules, which hard-code Classic's amber instead of ` +
      `reading --accent — they would stay amber on ${theme.name}`,
  );
}

console.log(
  `Themes gate passed — ${THEMES.length} theme(s), ${nonDefault.length} scoped stylesheet(s) with no rule, ` +
    "keyframe, pre-paint entry or hard-coded accent escaping into Classic.",
);
