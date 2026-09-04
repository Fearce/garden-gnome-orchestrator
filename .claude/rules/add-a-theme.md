---
paths:
  - "web/src/themes/*.css"
  - "web/src/lib/theme.ts"
  - "web/src/components/ThemePicker.tsx"
  - "web/index.html"
  - "web/src/styles.css"
---

# Adding a console theme (Settings → Appearance)

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
5. Nothing else. The store persists it in the shared `director_settings` record via
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

## Verify
`npm run test:themes --prefix server` (free, no browser: scoping, keyframe collisions, the
pre-paint list, the accent leak, the rendered picker) then `npm run appearance-lab --prefix
server -- --shots <dir>` — a real browser against its own throwaway instance, which is the only
check that can prove the claim: it snapshots Classic's computed style, switches, reloads,
switches back, and diffs property for property. Read a colour drift there carefully — a card
read the instant it stops being selected is still mid-transition, and `getComputedStyle`
reports the ANIMATED value (that is what `settled()` waits out, not a product bug).
