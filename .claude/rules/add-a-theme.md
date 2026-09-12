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

## Adding a TYPEFACE (the three pickers on the same page)
The interface, heading and monospace faces are the same mechanism one level down, and the same
rule carries it: **"Theme default" sets no attribute**, so `web/src/fonts.css` is entirely behind
`[data-font="<id>"]` / `[data-font-mono="<id>"]` / `[data-font-display…]` and a console that
chose nothing matches nothing in it. `test:fonts` fails on a rule that escapes, in either
direction (it also refuses a `[data-font…]` selector appearing in `styles.css`).

Touch map, all five or the face half-ships:
1. `web/package.json` + `npm install --prefix web` the `@fontsource-variable/<family>` (or
   `@fontsource/<family>`) package, and import it in `web/src/main.tsx`. Never a font-CDN
   `<link>`: the console is LAN/offline-first, and a missing face falls silently through to the
   next entry in the stack, which looks like a working choice until the network is gone.
2. `web/src/lib/font.ts`: the id in the `FontId` / `MonoFontId` / `DisplayFontId` union and an
   entry in `UI_FONTS` / `MONO_FONTS` / `DISPLAY_FONTS` (name, category, note, exact `stack`).
3. `web/src/fonts.css`: `:root[data-font="<id>"] { --font-sans: <the same stack>; }`, plus the
   tracking (and leading, if the face needs it) on `body`. `styles.css` already tracks `body` at
   -0.006em for Inter Tight, so a face that wants its own number has to restate it. A HEADING
   face sets `--font-display` and `--font-display-tracking` instead; the shared tier rule reads
   that token with NO fallback, so a face that omits it inherits the body's tracking instead.
4. `web/index.html`: the id in the pre-paint list. Sharper than the theme's case, since a face
   applied after the bundle loads REFLOWS the whole console, on every single load.
5. Nothing else. `persistView` already carries `uiFont`/`monoFont`/`displayFont`, and
   `SettingsPanel` renders whatever the three lists hold.

The heading channel has rules of its own, because unlike the other two it does not merely swap a
token that rules already read. Nothing faces the heading tier AS a tier, so `fonts.css` applies
`--font-display` to an explicit selector list (masthead, card headers, section and lane headings,
the panel title and its rename input, dialog titles), and that list is the feature:
- **Every tier selector starts `:root[data-font-display] `.** `[data-theme="nocturne"] .card
  .title` faces the same element, and `fonts.css` is imported BEFORE the theme, so the bare
  attribute ties it and loses on source order. That tie was the reported bug (the owner's "I
  still can't change the font for the task headers" was Nocturne's serif winning), and
  re-introducing it looks exactly like a face that simply did not apply. `test:fonts` computes
  the specificity of both sides and fails on a tie.
- **Chips, meters, badges, clocks and every transcript surface stay OUT of the tier.** They read
  as data, and the top bar's widths are measured against JetBrains Mono's advance
  (`npm run probe:chips`). The gate refuses those selectors by name.
- A face may restate the tier's weight and size when it needs to, and then owes the phone sizes
  as well (the same trap a theme hits, above). Instrument Serif is the worked example: one
  weight only, so the tier's 600 would otherwise be drawn as a synthetic bold.

Rules that bite:
- **The stack is written twice (font.ts and fonts.css) and must match**, because the picker
  paints each row in the option's own stack while a DIFFERENT face is active. A row that
  advertises a face the rule does not install is the one lie nobody can see. `test:fonts`
  compares them, normalised for quoting and spacing. The heading list's "Theme default" row is
  the one exception, and a deliberate one: that tier has no single default face, so the row
  advertises `--font-sans` (what a card header renders in today) and its NOTE carries the rest.
- **A monospace option needs the 600/1000 advance the others have.** The top bar's meters and
  the account chips are measured against JetBrains Mono's width; a narrower or wider mono needs
  `npm run probe:chips` re-run before it can be offered.
- **`--font-serif` may not reach a HEADING.** It is the empty-state flourish (`.empty .big`, the
  Supervisor and Co-work empty panes): placeholder art, not the name of anything. A theme that
  faces a heading-tier element with it hands a serif to an owner who chose no heading typeface
  and cannot see a picker for one, which is exactly what Nocturne did until 2026-09-12. The
  heading list offers Instrument Serif as an explicit pick instead. `test:fonts` audits every
  theme sheet against the tier and fails on any serif-resolving family.
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
stack match, the pre-paint lists, `persistView`, the bundled-family check, the heading tier's
coverage and its specificity against the theme, all three rendered pickers), then
`npm run appearance-lab --prefix server -- --shots data/appearance-lab-shots`, whose typeface
pass picks a face in each of the three pickers, proves the other two did not move, checks that
`document.fonts` actually LOADED the face (a computed `font-family` only echoes the stack), and
picks "Theme default" back to prove all three attributes come back OFF. Point `--shots` inside
`server/data/` so the pictures outlive the run without dirtying the checkout.
