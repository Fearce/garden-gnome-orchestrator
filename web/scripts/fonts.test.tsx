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

const { UI_FONTS, MONO_FONTS, DEFAULT_FONT, DEFAULT_MONO_FONT, isFontId, isMonoFontId, applyFonts } = await import(
  "../src/lib/font.js"
);
const { FontPicker } = await import("../src/components/FontPicker.js");

const fontsCss = read("src/fonts.css");
/** The same sheet with its comments gone: a scan over raw text would match the selectors the file
 *  DOCUMENTS as well as the ones it declares, which is the false-positive direction. */
const fontsCssCode = fontsCss.replace(/\/\*[\s\S]*?\*\//g, "");
const classic = read("src/styles.css");
const entry = read("src/main.tsx");
const html = read("index.html");

/** Both pickers, paired with the attribute and the token each one drives. */
const GROUPS = [
  { label: "interface", fonts: UI_FONTS, fallback: DEFAULT_FONT, attr: "data-font", token: "--font-sans" },
  { label: "monospace", fonts: MONO_FONTS, fallback: DEFAULT_MONO_FONT, attr: "data-font-mono", token: "--font-mono" },
] as const;

assert.equal(DEFAULT_FONT, "default", 'the interface fallback has to stay "default": it is the no-attribute case');
assert.equal(DEFAULT_MONO_FONT, "default", 'the monospace fallback has to stay "default"');

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

const SCOPED = /\[data-font(-mono)?[~^]?=/;
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
      const declared = classic.match(new RegExp(`${group.token}:\\s*([^;]+);`));
      assert.ok(declared, `src/styles.css no longer declares ${group.token}`);
      assert.equal(
        normalise(meta.stack),
        normalise(declared[1]!),
        `"${meta.name}" advertises a stack src/styles.css does not declare for ${group.token}`,
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

/* ---- 3. applying a choice marks the document, and the default unmarks it ------------------------- */

applyFonts("geist", "fira-code");
assert.deepEqual(dataset, { font: "geist", fontMono: "fira-code" }, "applyFonts must mark <html> with both choices");
applyFonts(DEFAULT_FONT, "fira-code");
assert.deepEqual(dataset, { fontMono: "fira-code" }, 'the default interface face must REMOVE the attribute, not write "default"');
applyFonts(DEFAULT_FONT, DEFAULT_MONO_FONT);
assert.deepEqual(dataset, {}, "both defaults must leave <html> exactly as an untouched console has it");

/* ---- 4. the pre-paint script knows every face ---------------------------------------------------- */

// A theme applied late flashes a palette; a FACE applied late reflows the entire console, on every
// load. So index.html paints both before the bundle exists, from the same record the store writes.
for (const [variable, group] of [
  ["f", GROUPS[0]],
  ["m", GROUPS[1]],
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
for (const field of ["uiFont", "monoFont"]) {
  assert.ok(
    new RegExp(`${field}: s\\.${field},`).test(persist[0]),
    `persistView does not write ${field} back, so the next change to any other view setting erases it`,
  );
  assert.ok(
    new RegExp(`${field}: is(Font|MonoFont)Id\\(v\\.${field}\\)`).test(storeSource),
    `loadViewSettings does not validate ${field}, so a corrupt record would apply an unknown face`,
  );
}
assert.match(entry, /import "\.\/fonts\.css";/, "main.tsx never imports the typeface stylesheet");
assert.match(
  entry,
  /applyFonts\(useStore\.getState\(\)\.uiFont, useStore\.getState\(\)\.monoFont\)/,
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
for (const list of ["UI_FONTS", "MONO_FONTS"]) {
  assert.ok(new RegExp(`fonts=\\{${list}\\}`).test(panel), `SettingsPanel never renders a FontPicker over ${list}`);
}
assert.match(panel, /onChange=\{setUiFont\}/, "the interface picker is not wired to the store");
assert.match(panel, /onChange=\{setMonoFont\}/, "the monospace picker is not wired to the store");
assert.match(
  read("src/components/ide/CodeEditor.tsx"),
  /attributeFilter: \[[^\]]*"data-font-mono"/,
  "the editor does not watch data-font-mono, so Monaco would keep the face it booted with",
);

console.log(
  `Fonts gate passed: ${UI_FONTS.length} interface and ${MONO_FONTS.length} monospace face(s), each scoped, ` +
    "bundled, pre-painted, persisted and selectable, with nothing reaching a console that chose neither.",
);
