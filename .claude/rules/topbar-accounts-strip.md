---
paths:
  - "web/src/components/Accounts.tsx"
  - "web/src/styles.css"
  - "web/src/App.tsx"
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
node web/scripts/check-accounts-visible.cjs          # 1280,1440,1600,1700
ORCH_URL=http://127.0.0.1:4327 node web/scripts/check-accounts-visible.cjs   # throwaway instance
```
It fails when a chip isn't fully visible OR when the strip is scrollable at all on
desktop (`scrollWidth > clientWidth` = usage hidden until you drag). 1700px is the
width that catches a bound gone stale — run it against a throwaway instance, never
live prod (project memory `browser-test-throwaway-instance`).

Cross-ref: project memory `grok-cli-integration-facts.md`; global
`css_mobile_grid_column_minmax_clips.md`.
