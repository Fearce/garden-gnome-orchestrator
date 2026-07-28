---
paths:
  - "web/src/components/Accounts.tsx"
  - "web/src/styles.css"
  - "web/src/App.tsx"
  - "server/src/accounts/*.ts"
---

# Top-bar accounts strip (chips must stay on-screen)

When you add or widen a subscription chip (Claude / Codex / Grok), the strip can
overflow the top bar. **WS/API "usage present" is not acceptance** — the chip
must be *visible* at common desktop widths.

## Layout rules (do not re-break)
- `.app` uses `grid-template-columns: minmax(0, 1fr)` and `overflow: hidden`.
- `.topbar` has `min-width: 0`.
- `.accounts` has `min-width: 0`, `overflow-x: auto`, chips `flex: 0 0 auto`.
- At **769–1699px** desktop, `.accounts` wraps to a **full-width second row**
  so personal+vota+Codex+Grok+z.ai all fit (see `eda230f`). Mobile (≤768) already
  full-width-scrolls the strip. The upper bound is measured, not decorative: five
  chips are ~848px and the rest of the bar takes ~780px, so the strip only fits
  inline from ~1700px. **Adding or widening a chip moves that bound** — re-measure
  (`.accounts` scrollWidth > clientWidth = clipped) and update the media query.

## Verify before claiming done
```bash
npm run build && npm run chip-lab --prefix server        # boots its own instance, renders + asserts
npm run chip-lab --prefix server -- --list               # healthy | lapsed-weekly | stagger-hold | stale | capped
```
`chip-lab` (`server/scripts/chip-lab.cjs`) is the one-command version: temp DATA_DIR,
**bogus account tokens** (a live token makes the boot ping START a real 5h window and
wreck the stagger you're inspecting), seeded `account_usage_*` blobs, then a real
browser at 1280/1440/1600/1700 printing every meter's text + tooltip. Exit 1 = clipped.
Use it for any change to a meter's *state* — an `idle`/`stale`/lapsed-reset reading
is invisible to a typecheck and to prod (whose accounts are usually healthy).

`node web/scripts/check-accounts-visible.cjs` is the geometry-only check against an
already-running instance (`ORCH_URL=…`); it fails when a chip isn't fully visible OR
when the strip is scrollable at all on desktop. Never point either at live prod.

Cross-ref: project memory `grok-cli-integration-facts.md`; global
`css_mobile_grid_column_minmax_clips.md`.
