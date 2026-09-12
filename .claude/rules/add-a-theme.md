---
paths:
  - "web/src/themes/*.css"
  - "web/src/lib/theme.ts"
  - "web/src/components/ThemePicker.tsx"
  - "web/index.html"
  - "web/src/styles.css"
  - "web/src/fonts.css"
  - "web/src/lib/font.ts"
  - "web/src/components/FontPicker.tsx"
---

# Adding a console theme or typeface (Settings → Appearance)

Read before adding a third theme, editing `web/src/themes/*.css`, or touching a Classic
rule a theme answers. CLAUDE.md § "Appearance themes" has the shape; this is what bites.

## The one thing to keep true
**Classic is `styles.css` with NO attribute on `<html>`.** That is the entire mechanism by
which "Classic is exactly as it was" survives a theme nobody reviewed line by line: a theme
can only be a set of rules behind `[data-theme="<id>"]`, so an owner who never opted in
cannot be reached by one. Never make Classic conditional — no `:root:not([data-theme])`, no
`[data-theme="classic"]` block, no shared "base" sheet lifted out of `styles.css`.

## The touch map (miss one and the theme half-ships)
1. `web/src/themes/<id>.css` — every rule scoped, every `@keyframes` prefixed `<id>-`.
2. `web/src/lib/theme.ts` — the `ThemeId` union and a `THEMES` entry (name, tagline, what
   actually changes — the picker prints all three).
3. `web/src/main.tsx` — `import "./themes/<id>.css";` (scoped, so importing costs Classic nothing).
4. `web/index.html` — add the id to the pre-paint script's list, or the theme flashes Classic
   on **every** load: the bundle runs after first paint, so JS alone is always too late.
5. **A typeface the console doesn't already bundle** → import its `@fontsource/<family>` faces in
   `web/src/main.tsx` — never a font-CDN `<link>`: the console is LAN/offline-first, and an
   unreachable CDN drops the theme's identity to the next stack face (Georgia), which looks like
   a working theme. `test:themes` reads your `--font-*` tokens and fails until the import exists.
6. Nothing else. The store persists it in the shared `director_settings` record via
   `persistView`, and `SettingsPanel` renders whatever `THEMES` holds.

## Rules that bit
- **Restate Classic's mobile sizes.** `[data-theme=…] .card .title` out-specifies
  `@media (max-width: 899.98px) { .card .title }` — an attribute selector beats a bare class —
  so a theme that restyles a heading keeps its DESKTOP size on a phone until it restates the
  compact one. Gate: the lab's phone pass.
- **A Classic rule that hard-codes the amber literal is a leak the other way.** Nine focus
  rings write `oklch(0.83 0.16 78 / 0.14)` instead of reading `--accent`, so retinting the
  token is not enough — each has to be met by name. `test:themes` fails on a tenth.
- **The picker's tiles are painted by the theme they advertise** (`data-theme-preview`), not by
  copied swatches. Consequence: while your theme is active it has overwritten `:root`, so the
  CLASSIC tile needs the handful of Classic tokens restated inside
  `[data-theme="<id>"] [data-theme-preview="classic"]` — otherwise it advertises your palette.
- **Animate arrivals only.** The feed streams and the board re-sorts on live data; animating
  either flickers. Every animation needs a `prefers-reduced-motion` opt-out.
- **`.theme-transition` is on `<html>` for the length of the cross-fade only.** Leaving a
  global `transition: … !important` live would put a fade on every state change in the app.

## Adding a TYPEFACE (the second picker on the same page)
The interface and monospace faces are the same mechanism one level down, and the same rule
carries it: **"Theme default" sets no attribute**, so `web/src/fonts.css` is entirely behind
`[data-font="<id>"]` / `[data-font-mono="<id>"]` and a console that chose nothing matches
nothing in it. `test:fonts` fails on a rule that escapes, in either direction (it also refuses
a `[data-font…]` selector appearing in `styles.css`).

Touch map, all five or the face half-ships:
1. `web/package.json` + `npm install --prefix web` the `@fontsource-variable/<family>` (or
   `@fontsource/<family>`) package, and import it in `web/src/main.tsx`. Never a font-CDN
   `<link>`: the console is LAN/offline-first, and a missing face falls silently through to the
   next entry in the stack, which looks like a working choice until the network is gone.
2. `web/src/lib/font.ts` — the id in the `FontId` / `MonoFontId` union and an entry in
   `UI_FONTS` / `MONO_FONTS` (name, category, note, and the exact `stack`).
3. `web/src/fonts.css` — `:root[data-font="<id>"] { --font-sans: <the same stack>; }`, plus the
   tracking (and leading, if the face needs it) on `body`. `styles.css` already tracks `body` at
   -0.006em for Inter Tight, so a face that wants its own number has to restate it.
4. `web/index.html` — the id in the pre-paint list. Sharper than the theme's case: a face
   applied after the bundle loads REFLOWS the whole console, on every single load.
5. Nothing else. `persistView` already carries `uiFont`/`monoFont`, and `SettingsPanel` renders
   whatever the two lists hold.

Rules that bite:
- **The stack is written twice (font.ts and fonts.css) and must match**, because the picker
  paints each row in the option's own stack while a DIFFERENT face is active. A row that
  advertises a face the rule does not install is the one lie nobody can see. `test:fonts`
  compares them, normalised for quoting and spacing.
- **A monospace option needs the 600/1000 advance the others have.** The top bar's meters and
  the account chips are measured against JetBrains Mono's width; a narrower or wider mono needs
  `npm run probe:chips` re-run before it can be offered.
- **Leave `--font-serif` alone.** It is a theme's display accent (Nocturne's titles, the empty
  states), not the owner's body-face choice.
- **The default entry advertises `styles.css`'s own token**, so changing `--font-sans` or
  `--font-mono` there means changing the matching `stack` in `font.ts`. The gate compares those
  two as well.

## Verify
`npm run test:themes --prefix server` (free, no browser: scoping, keyframe collisions, the
pre-paint list, the accent leak, the rendered picker) then `npm run appearance-lab --prefix
server -- --shots <dir>` — a real browser against its own throwaway instance, which is the only
check that can prove the claim: it snapshots Classic's computed style, switches, reloads,
switches back, and diffs property for property. Read a colour drift there carefully — a card
read the instant it stops being selected is still mid-transition, and `getComputedStyle`
reports the ANIMATED value (that is what `settled()` waits out, not a product bug).

For a typeface: `npm run test:fonts --prefix server` (free, no browser: scoping both ways, the
stack match, the pre-paint lists, `persistView`, the bundled-family check, both rendered
pickers), then drive it in a real browser against a throwaway instance on :5317
(`bash ~/Claude/tools/orch-throwaway.sh start -r <repo> -p 5317`, never prod): pick a face,
assert the computed `font-family` on `body` and on a `.conn` mono element, reload, and pick
"Theme default" again to prove both attributes come back OFF.
