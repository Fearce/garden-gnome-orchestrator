/**
 * Gate: the Appearance typefaces, and the invariants that keep them honest.
 *
 *   npm run test:fonts --prefix server
 *
 * A font picker is three claims the code makes to the owner, and each one fails silently:
 *
 *   · "choosing nothing changes nothing": the default option sets no attribute, so `fonts.css` must
 *     contain no rule that can match an unmarked <html> (the same mechanism that keeps Classic safe
 *     from a theme, and the same way to break it),
 *   · "this row is what you will get": the picker paints every specimen in the option's own stack,
 *     which is only true while the stack in `lib/font.ts` and the stack in `fonts.css` agree,
 *   · "it renders offline": a face named in a token but never imported falls through to the next
 *     entry in the stack, which looks like a working choice until the network is gone.
 *
 * It also pins the two wiring mistakes that typecheck cleanly: a face missing from index.html's
 * pre-paint list (the console then reflows on every single load), and a setting missing from
 * `persistView` (the other view settings then erase it on their next write).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(WEB, rel), "utf8");

// See themes.test.tsx: this gate is launched from the server package, whose tsx may compile the
// imported web JSX in classic mode, so the runtime has to be reachable as a global.
Object.assign(globalThis, { React });

// applyFonts writes to the live document; the gate runs in node, so stand one up.
const dataset: Record<string, string> = {};
Object.assign(globalThis, { document: { documentElement: { dataset } } });

const {
  UI_FONTS,
  MONO_FONTS,
  DISPLAY_FONTS,
  DEFAULT_FONT,
  DEFAULT_MONO_FONT,
  DEFAULT_DISPLAY_FONT,
  isFontId,
  isMonoFontId,
  isDisplayFontId,
  applyFonts,
} = await import("../src/lib/font.js");
const { FontPicker } = await import("../src/components/FontPicker.js");

const fontsCss = read("src/fonts.css");
/** The same sheet with its comments gone: a scan over raw text would match the selectors the file
 *  DOCUMENTS as well as the ones it declares, which is the false-positive direction. */
const fontsCssCode = fontsCss.replace(/\/\*[\s\S]*?\*\//g, "");
const classic = read("src/styles.css");
const nocturneCss = read("src/themes/nocturne.css");
const entry = read("src/main.tsx");
const html = read("index.html");

/** Every picker, paired with the attribute and the token it drives.
 *
 *  `defaultToken` is where the "Theme default" row's specimen comes from. For the first two that is
 *  the token they drive, because the default IS that token. The heading tier has no single default
 *  face, since the masthead is mono chrome and a theme may draw the whole tier in its own serif, so
 *  its default row advertises the face its largest and most-read member, a task card's header,
 *  renders in today. The row's note carries the rest; see DISPLAY_FONTS. */
const GROUPS = [
  { label: "interface", fonts: UI_FONTS, fallback: DEFAULT_FONT, attr: "data-font", token: "--font-sans", defaultToken: "--font-sans" },
  { label: "monospace", fonts: MONO_FONTS, fallback: DEFAULT_MONO_FONT, attr: "data-font-mono", token: "--font-mono", defaultToken: "--font-mono" },
  { label: "heading", fonts: DISPLAY_FONTS, fallback: DEFAULT_DISPLAY_FONT, attr: "data-font-display", token: "--font-display", defaultToken: "--font-sans" },
] as const;

assert.equal(DEFAULT_FONT, "default", 'the interface fallback has to stay "default": it is the no-attribute case');
assert.equal(DEFAULT_MONO_FONT, "default", 'the monospace fallback has to stay "default"');
assert.equal(DEFAULT_DISPLAY_FONT, "default", 'the heading fallback has to stay "default"');

/* ---- 1. nothing in fonts.css can reach a console that chose nothing ----------------------------- */

interface Block {
  head: string;
  body: string;
}

/** Every style rule with its declarations. At-rule wrappers are stepped through, not returned. */
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
  assert.equal(open.length, 0, "unbalanced braces while parsing src/fonts.css");
  return out;
}

// The heading channel applies its token through one shared tier rule, which selects on the PRESENCE
// of the attribute rather than on a value. That is still unreachable by an unmarked <html>, so it
// counts as scoped, but `[data-font-display]` has to be accepted with no `=` after it.
const SCOPED = /\[data-font(-mono|-display)?[~^]?[=\]]/;
const selectors = blocks(fontsCss).flatMap((b) => b.head.split(",").map((s) => s.trim()));
assert.ok(selectors.length > 0, "src/fonts.css parsed to no rules at all");
assert.deepEqual(
  selectors.filter((s) => !SCOPED.test(s)),
  [],
  "src/fonts.css: rule(s) that are not behind [data-font…]. They would apply to a console that never " +
    "chose a typeface, which is the one thing this file may never do",
);

// And the reverse leak: styles.css must not learn about the pickers, or the default stops being
// "the sheet as written" and becomes one branch of it.
assert.ok(
  !blocks(classic).some((b) => SCOPED.test(b.head)),
  "src/styles.css must not select on data-font: the typeface options live in src/fonts.css",
);

/* ---- 2. every option exists in CSS, and installs exactly the stack the picker advertises --------- */

/** The stack a rule assigns to `token`, normalised so quoting style and spacing cannot fail a match. */
const normalise = (stack: string): string =>
  stack
    .replace(/'/g, '"')
    .split(",")
    .map((part) => part.trim())
    .join(", ");

for (const group of GROUPS) {
  const ids = group.fonts.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in the ${group.label} font list`);
  assert.ok(ids.includes(group.fallback), `the ${group.label} list must contain its own "${group.fallback}" entry`);

  for (const meta of group.fonts) {
    if (meta.id === group.fallback) {
      // "Theme default" advertises the token as styles.css declares it. A specimen that lies about
      // the face you already have is the one row nobody would ever check.
      const declared = classic.match(new RegExp(`${group.defaultToken}:\\s*([^;]+);`));
      assert.ok(declared, `src/styles.css no longer declares ${group.defaultToken}`);
      assert.equal(
        normalise(meta.stack),
        normalise(declared[1]!),
        `"${meta.name}" advertises a stack src/styles.css does not declare for ${group.defaultToken}`,
      );
      continue;
    }

    const rule = blocks(fontsCss).find(
      (b) => b.head.includes(`[${group.attr}="${meta.id}"]`) && b.body.includes(`${group.token}:`),
    );
    assert.ok(
      rule,
      `src/fonts.css never sets ${group.token} for [${group.attr}="${meta.id}"], so "${meta.name}" would select and change nothing`,
    );
    const assigned = rule.body.match(new RegExp(`${group.token}:\\s*([^;]+);`))![1]!;
    assert.equal(
      normalise(assigned),
      normalise(meta.stack),
      `"${meta.name}": the stack in src/fonts.css differs from the one lib/font.ts paints its specimen ` +
        "in, so the picker is selling a face it does not install",
    );
  }

  // No orphan rule either: a CSS block for an id no list offers is dead weight nobody can reach.
  const styled = new Set(Array.from(fontsCssCode.matchAll(new RegExp(`\\[${group.attr}="([^"]+)"\\]`, "g")), (m) => m[1]!));
  for (const id of styled) {
    assert.ok(ids.includes(id), `src/fonts.css styles [${group.attr}="${id}"], which is not an offered option`);
    assert.notEqual(
      id,
      group.fallback,
      `src/fonts.css styles the "${group.fallback}" option, which must set no attribute at all`,
    );
  }
}

assert.ok(isFontId("geist") && !isFontId("nope"), "isFontId must accept an offered interface face and reject anything else");
assert.ok(isMonoFontId("fira-code") && !isMonoFontId("geist"), "isMonoFontId must not accept an interface-only face");
assert.ok(
  isDisplayFontId("bricolage") && !isDisplayFontId("plex-sans"),
  "isDisplayFontId must accept an offered heading face and reject one only the interface list carries",
);

/* ---- 3. applying a choice marks the document, and the default unmarks it ------------------------- */

applyFonts("geist", "fira-code", "bricolage");
assert.deepEqual(
  dataset,
  { font: "geist", fontMono: "fira-code", fontDisplay: "bricolage" },
  "applyFonts must mark <html> with all three choices",
);
applyFonts(DEFAULT_FONT, "fira-code", "bricolage");
assert.deepEqual(
  dataset,
  { fontMono: "fira-code", fontDisplay: "bricolage" },
  'the default interface face must REMOVE the attribute, not write "default"',
);
applyFonts(DEFAULT_FONT, "fira-code", DEFAULT_DISPLAY_FONT);
assert.deepEqual(dataset, { fontMono: "fira-code" }, "the default heading face must remove its own attribute too");
applyFonts(DEFAULT_FONT, DEFAULT_MONO_FONT, DEFAULT_DISPLAY_FONT);
assert.deepEqual(dataset, {}, "all three defaults must leave <html> exactly as an untouched console has it");

/* ---- 4. the pre-paint script knows every face ---------------------------------------------------- */

// A theme applied late flashes a palette; a FACE applied late reflows the entire console, on every
// load. So index.html paints both before the bundle exists, from the same record the store writes.
for (const [variable, group] of [
  ["f", GROUPS[0]],
  ["m", GROUPS[1]],
  ["d", GROUPS[2]],
] as const) {
  const list = html.match(new RegExp(`\\[([^\\]]*)\\]\\.indexOf\\(${variable}\\)`));
  assert.ok(list, `index.html no longer carries the pre-paint list for the ${group.label} typeface`);
  const booted = Array.from(list[1]!.matchAll(/"([^"]+)"/g), (m) => m[1]!);
  assert.deepEqual(
    booted.slice().sort(),
    group.fonts
      .filter((f) => f.id !== group.fallback)
      .map((f) => f.id)
      .sort(),
    `index.html's pre-paint script must list exactly the non-default ${group.label} ids, or that face ` +
      "reflows the console on every load",
  );
}
assert.match(html, /dataset\.font\s*=/, "index.html never sets data-font before paint");
assert.match(html, /dataset\.fontMono\s*=/, "index.html never sets data-font-mono before paint");
assert.match(html, /dataset\.fontDisplay\s*=/, "index.html never sets data-font-display before paint");

const storeSource = read("src/store.ts");
const storeKey = storeSource.match(/const VIEW_SETTINGS_KEY = "([^"]+)"/);
assert.ok(storeKey, "store.ts no longer declares VIEW_SETTINGS_KEY");
assert.ok(
  html.includes(`localStorage.getItem("${storeKey[1]!}")`),
  `index.html's pre-paint script reads a different record than the store writes ("${storeKey[1]!}")`,
);

/* ---- 5. the choice survives the next write to any OTHER view setting ----------------------------- */

// Every view setting shares one localStorage record, so a field missing from persistView is erased
// the next time an unrelated toggle is flipped. That is invisible until a reload much later.
const persist = storeSource.match(/const persistView[\s\S]*?\}\);/);
assert.ok(persist, "store.ts no longer declares persistView");
for (const field of ["uiFont", "monoFont", "displayFont"]) {
  assert.ok(
    new RegExp(`${field}: s\\.${field},`).test(persist[0]),
    `persistView does not write ${field} back, so the next change to any other view setting erases it`,
  );
  assert.ok(
    new RegExp(`${field}: is(Font|MonoFont|DisplayFont)Id\\(v\\.${field}\\)`).test(storeSource),
    `loadViewSettings does not validate ${field}, so a corrupt record would apply an unknown face`,
  );
}
assert.match(entry, /import "\.\/fonts\.css";/, "main.tsx never imports the typeface stylesheet");
assert.match(
  entry,
  /applyFonts\(useStore\.getState\(\)\.uiFont, useStore\.getState\(\)\.monoFont, useStore\.getState\(\)\.displayFont\)/,
  "main.tsx never reconciles <html> with the stored faces at boot",
);

/* ---- 6. every face it offers ships in the bundle -------------------------------------------------- */

// Faces the operating system supplies. Everything else a stack names FIRST has to be in the bundle:
// the console is served on the LAN and used offline, and a missing face falls silently through to
// the next entry, which looks like a working choice.
const SYSTEM_FACES = new Set(["Segoe UI", "Cascadia Code", "SF Mono", "Helvetica Neue"]);
const deps = JSON.parse(read("package.json")).dependencies as Record<string, string>;

for (const group of GROUPS) {
  for (const meta of group.fonts) {
    const first = meta.stack.split(",")[0]!.trim();
    const quoted = first.match(/^"(.+)"$/);
    if (!quoted || SYSTEM_FACES.has(quoted[1]!)) continue;
    const family = quoted[1]!;
    const variable = family.endsWith(" Variable");
    const slug = (variable ? family.slice(0, -" Variable".length) : family).toLowerCase().replace(/\s+/g, "-");
    const pkg = `${variable ? "@fontsource-variable" : "@fontsource"}/${slug}`;
    assert.ok(deps[pkg], `"${meta.name}" is set in ${family}, but web/package.json does not depend on ${pkg}`);
    // A real import statement, not a bare substring: the file's comments name the packages too.
    assert.ok(
      new RegExp(`^\\s*import\\s+["']${pkg}(/|["'])`, "m").test(entry),
      `main.tsx never imports ${pkg}, so "${meta.name}" would fall through to the next face in its ` +
        "stack, a working-looking choice until the network is gone",
    );
  }
}

assert.ok(
  !/url\(\s*["']?https?:\/\//i.test(fontsCssCode),
  "src/fonts.css references a remote resource by URL. Bundle it instead (the console must render offline)",
);

/* ---- 7. the pickers render, and behave as one radio group each ------------------------------------ */

const render = (group: (typeof GROUPS)[number], value: string): string =>
  renderToStaticMarkup(
    React.createElement(FontPicker, {
      fonts: group.fonts as never,
      value: value as never,
      onChange: () => {},
      ariaLabel: group.label,
      sample: "Sample",
    }),
  );

for (const group of GROUPS) {
  const fallbackMarkup = render(group, group.fallback);
  for (const meta of group.fonts) {
    assert.ok(fallbackMarkup.includes(`data-font-option="${meta.id}"`), `the ${group.label} picker omits "${meta.id}"`);
    assert.ok(fallbackMarkup.includes(meta.name), `the ${group.label} picker never names "${meta.name}"`);
    // The specimen has to be SET in the face, not merely listed beside its name.
    const family = meta.stack.split(",")[0]!.trim().replace(/"/g, "");
    assert.ok(
      new RegExp(`font-family:[^"]*${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(fallbackMarkup),
      `"${meta.name}" is listed but nothing in its row is drawn in it`,
    );
  }

  const other = group.fonts.find((f) => f.id !== group.fallback)!;
  const chosen = render(group, other.id);
  assert.equal((chosen.match(/aria-checked="true"/g) ?? []).length, 1, `exactly one ${group.label} row is ever active`);
  const tag = chosen.match(new RegExp(`<button[^>]*data-font-option="${other.id}"[^>]*>`));
  assert.ok(tag && /aria-checked="true"/.test(tag[0]), `selecting "${other.id}" must mark its own row active`);

  // A radio group takes ONE tab stop and is walked with the arrows, so the chosen row is the only
  // tabbable one, otherwise Tab lands on a row the arrows immediately move away from.
  for (const [markup, active] of [
    [fallbackMarkup, group.fallback],
    [chosen, other.id],
  ] as const) {
    const tabbable = Array.from(markup.matchAll(/<button[^>]*data-font-option="([^"]+)"[^>]*>/g)).filter((m) =>
      /tabindex="0"/i.test(m[0]),
    );
    assert.deepEqual(
      tabbable.map((m) => m[1]!),
      [active],
      `with "${active}" chosen, it must be the ${group.label} group's only tab stop`,
    );
  }
}

/* ---- 8. it is reachable in Settings ---------------------------------------------------------------- */

const panel = read("src/components/SettingsPanel.tsx");
assert.match(
  panel,
  /<SettingsCategoryPanel id="appearance"/,
  "the Appearance category panel is gone, so the pickers would render on every settings page",
);
for (const list of ["UI_FONTS", "MONO_FONTS", "DISPLAY_FONTS"]) {
  assert.ok(new RegExp(`fonts=\\{${list}\\}`).test(panel), `SettingsPanel never renders a FontPicker over ${list}`);
}
assert.match(panel, /onChange=\{setUiFont\}/, "the interface picker is not wired to the store");
assert.match(panel, /onChange=\{setMonoFont\}/, "the monospace picker is not wired to the store");
assert.match(panel, /onChange=\{setDisplayFont\}/, "the heading picker is not wired to the store");
assert.match(
  read("src/components/ide/CodeEditor.tsx"),
  /attributeFilter: \[[^\]]*"data-font-mono"/,
  "the editor does not watch data-font-mono, so Monaco would keep the face it booted with",
);

/* ---- 9. the heading tier: what it reaches, what it must not, and whether it wins ----------------- */

/* This channel is the only one that does not merely swap a token. --font-sans and --font-mono are
 * already read by the rules that want them, so a face there is a one-line change; the heading tier
 * is not faced by any single token today, so fonts.css has to APPLY --font-display to a list of
 * elements. That list is the feature, and it has three ways to be quietly wrong:
 *
 *   . an element drops out (renamed class, a selector edited away) and one heading keeps the old
 *     face while the rest change, which reads as a rendering bug rather than a missing rule,
 *   . a selector loses the `:root` prefix, at which point a theme that faces the same element ties
 *     it and wins on source order, so the owner's explicit pick silently does nothing under that
 *     theme. That is the exact bug this whole channel was built to fix,
 *   . the list grows into the readouts. Chips, meters, badges and transcripts are DATA, several of
 *     them measured against JetBrains Mono's advance (`npm run probe:chips`), and a heading face
 *     has no business in any of them.
 */

/** The elements the heading face must reach, and the reason each belongs to the tier. */
const TIER = [
  [".wordmark .sub", "the masthead in the top bar"],
  [".rail-head h2", "the rail's section heading"],
  [".board-head h2", "the board's section heading"],
  [".board-tab", "the board's view switcher, which reads as a heading beside it"],
  [".cowork-board-head h3", "the Co-work board's section heading"],
  [".card .title", "a task card's header"],
  [".cowork-card-name", "a Co-work card's header"],
  [".detail-head h2", "the task panel's title"],
  [".title-edit", "the input that replaces that title on a rename, so the panel does not jump"],
  [".settings-head h3", "the Settings dialog title"],
  [".modal .m-head h3", "every other dialog title"],
] as const;

/** Every class name styles.css declares, so a tier selector can be checked against reality. */
const CLASSIC_CLASSES = new Set(
  blocks(classic).flatMap((b) => b.head.match(/\.[\w-]+/g) ?? []),
);

const tierRule = blocks(fontsCss).find((b) => /font-family:\s*var\(--font-display\)/.test(b.body));
assert.ok(tierRule, "src/fonts.css never applies var(--font-display) to anything, so the heading picker is inert");
const tierSelectors = tierRule.head.split(",").map((sel) => sel.trim());

const PREFIX = ":root[data-font-display] ";
for (const [selector, why] of TIER) {
  assert.ok(
    tierSelectors.includes(PREFIX + selector),
    `the heading tier does not cover "${selector}" (${why}), so that heading keeps a face the owner cannot change`,
  );
  // And every class it names still exists: a renamed one would leave a rule selecting nothing, which
  // looks exactly like a face that "did not apply". Checked against the class names styles.css
  // actually declares, not a substring scan, so `.card` cannot be satisfied by `.card-dismiss`.
  for (const cls of selector.match(/\.[\w-]+/g) ?? []) {
    assert.ok(
      CLASSIC_CLASSES.has(cls),
      `src/styles.css no longer declares "${cls}" (from "${selector}", ${why}), so the heading tier is ` +
        "aimed at a class that has been renamed away",
    );
  }
}
for (const selector of tierSelectors) {
  assert.ok(
    selector.startsWith(PREFIX),
    `the heading tier's "${selector}" does not start with "${PREFIX}". The bare attribute ties a theme ` +
      "rule facing the same element and loses on source order, so a chosen face would do nothing there",
  );
}

/** CSS specificity as [ids, classes, types], enough for the flat selectors both sheets use. */
function specificity(selector: string): [number, number, number] {
  const withoutAttrs = selector.replace(/\[[^\]]*\]/g, "");
  return [
    (selector.match(/#[\w-]+/g) ?? []).length,
    (selector.match(/\.[\w-]+/g) ?? []).length +
      (selector.match(/\[[^\]]*\]/g) ?? []).length +
      (selector.match(/:(?!:)[\w-]+/g) ?? []).length,
    (withoutAttrs.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
}
const beats = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

assert.deepEqual(specificity(":root[data-font-display] .card .title"), [0, 4, 0], "the specificity model drifted");
assert.deepEqual(specificity('[data-theme="nocturne"] .card .title'), [0, 3, 0], "the specificity model drifted");

/** A selector's compound parts, with the ones that qualify <html> itself (`:root`, the theme and
 *  typeface attributes) dropped: those say WHICH console, not which element. */
const parts = (selector: string): string[] =>
  selector
    .split(/[\s>+~]+/)
    .filter((part) => part.length > 0 && !/^(?::root)?(?:\[[^\]]*\])*$/.test(part));

/** Whether `a` appears inside `b` in order: a descendant chain matches every element a longer chain
 *  ending the same way does, which is what makes the two rules candidates for the same heading. */
const subsequence = (a: string[], b: string[]): boolean => {
  let i = 0;
  for (const part of b) if (i < a.length && a[i] === part) i += 1;
  return i === a.length;
};

/** Could these two rules ever style the SAME element? Same final compound, and one chain contained
 *  in the other. `.settings-head h3` and `.modal .m-head h3` share a final `h3` and are still two
 *  different headings, so the containment half is what keeps this from crying wolf. */
function sameElement(a: string, b: string): boolean {
  const [pa, pb] = [parts(a), parts(b)];
  if (pa.length === 0 || pb.length === 0) return false;
  if (pa[pa.length - 1] !== pb[pb.length - 1]) return false;
  return subsequence(pa, pb) || subsequence(pb, pa);
}

// The real comparison, against the theme that actually faces this tier. fonts.css is imported before
// the theme, so a tie loses; every heading they can both reach has to be won outright.
let contested = 0;
for (const block of blocks(nocturneCss)) {
  if (!/font-family:/.test(block.body)) continue;
  for (const themed of block.head.split(",").map((sel) => sel.trim())) {
    for (const mine of tierSelectors.filter((sel) => sameElement(sel, themed))) {
      contested += 1;
      assert.ok(
        beats(specificity(mine), specificity(themed)),
        `"${mine}" does not out-specify the theme's "${themed}" (${specificity(mine)} vs ${specificity(themed)}), ` +
          "so choosing a heading face would leave that element in the theme's own face",
      );
    }
  }
}
assert.ok(
  contested >= 5,
  `only ${contested} heading element(s) were compared against src/themes/nocturne.css. The theme faces this ` +
    "tier, so a near-zero overlap means the selectors drifted apart and the comparison proved nothing",
);

// The shared tracking rule reads --font-display-tracking with no fallback, so every face has to set
// it. An unset custom property makes the whole declaration invalid at computed-value time, which
// falls back to the INHERITED tracking rather than the element's own.
for (const meta of DISPLAY_FONTS) {
  if (meta.id === DEFAULT_DISPLAY_FONT) continue;
  const rule = blocks(fontsCss).find((b) => b.head.includes(`[data-font-display="${meta.id}"]`));
  assert.ok(
    rule && /--font-display-tracking:\s*[^;]+;/.test(rule.body),
    `"${meta.name}" sets no --font-display-tracking, so its headings inherit the body tracking of a face ` +
      "that is no longer on screen",
  );
}

// Data stays data. These are the readouts the console measures with, and a heading face reaching one
// of them is both a design regression and, for the chip row, a measured-width regression.
const DATA_SURFACES = [
  ".acct",
  ".meter-",
  ".badge",
  ".pip",
  ".conn",
  ".stat",
  ".build-tag",
  ".ws-path",
  ".task-elapsed",
  ".fi ",
  ".monaco",
  "code",
  "pre",
];
for (const surface of DATA_SURFACES) {
  assert.ok(
    !tierSelectors.some((sel) => sel.includes(surface)),
    `the heading tier reaches "${surface}", which reads as data and must stay on --font-mono`,
  );
}
const displayBlocks = blocks(fontsCss).filter((b) => b.head.includes("data-font-display"));
for (const block of displayBlocks) {
  for (const token of ["--font-sans", "--font-mono"]) {
    assert.ok(
      !block.body.includes(`${token}:`),
      `a [data-font-display] rule sets ${token}. The heading channel owns --font-display only; ` +
        "reaching another channel's token is how one picker starts overriding another",
    );
  }
}

console.log(
  `Fonts gate passed: ${UI_FONTS.length} interface, ${MONO_FONTS.length} monospace and ${DISPLAY_FONTS.length} heading ` +
    `face(s), each scoped, bundled, pre-painted, persisted and selectable. The heading tier covers ${TIER.length} ` +
    "element(s), out-specifies the theme on every one they share, and reaches nothing that reads as data, " +
    "with nothing at all reaching a console that chose none of them.",
);
