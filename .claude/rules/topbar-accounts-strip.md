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
- At **769–1500px** desktop, `.accounts` wraps to a **full-width second row**
  so personal+vota+Codex+Grok all fit (see `eda230f`). Mobile (≤768) already
  full-width-scrolls the strip.

## Verify before claiming done
```bash
node web/scripts/check-accounts-visible.cjs
# or Playwright at viewport 1280 and 1440:
#   .acct.grok getBoundingClientRect fully inside window (or after scrollLeft max
#   fully inside .accounts client box); text matches /7d/ and /mo|SUPERGROK/
```
Fail if the chip's left edge is past `innerWidth - 40` with no scrollable ancestor.

Cross-ref: project memory `grok-cli-integration-facts.md`; global
`css_mobile_grid_column_minmax_clips.md`.
