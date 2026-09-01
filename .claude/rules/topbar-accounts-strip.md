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
- At **900–1799px** desktop, `.accounts` wraps to a **full-width second row**
  so personal+secondary+Codex+Grok+z.ai all fit (see `eda230f`). Compact (≤899.98, which
  since 2026-08-18 includes a portrait 800px tablet) already full-width-scrolls the
  strip — `probe:chips` shares that bound as `DESKTOP_MIN` and does not treat a
  scrollable strip below it as clipping. **Adding or widening a chip moves the wrap
  bound** — don't
  bisect it by hand, print it: `npm run probe:chips -- --explain` reports the
  single-row floor per width (chips + fixed items + gaps + padding).
- **Measure the bound against the bar's WIDEST state, not the one on screen.** `.conn`
  swings 41px ("live") → 100px ("reconnecting…"), which moves the floor 1689 → **1748**.
  The original 1700px bound sat between those two numbers, so the chips clipped on every
  reconnect (2026-08-13). The probe now measures each width twice — live, then with the
  socket label widened — and fails on either.
- **Above the bound the chips must not shrink.** `@media (min-width: 1800px)` gives
  `.accounts { flex-shrink: 0 }` — the data chips hold their size, the elastic items
  (`.office` is `flex: 1`, basis 0; `.stat` is text) yield instead. The probe also fails
  if that pressure pushes any top-bar child off-screen instead.
- **Assert `getComputedStyle`, never the rule you wrote.** An equally specific declaration
  LATER in `styles.css` beats one inside a media query, so a rule can be completely inert
  while reading as load-bearing: the wrap block's `flex: 1 1 100%` computed as `0 1 auto`
  at every width (the wrap has always been content-driven), and the first `flex-shrink: 0`
  written above the base `.accounts` block did nothing at all.

## Verify before claiming done
```bash
npm run build && npm run chip-lab --prefix server        # boots its own instance, renders + asserts
npm run chip-lab --prefix server -- --list               # healthy | lapsed-weekly | stagger-hold | stale | capped
```
`chip-lab` (`server/scripts/chip-lab.cjs`) is the one-command version: temp DATA_DIR,
**bogus account tokens** (a live token makes the boot ping START a real 5h window and
wreck the stagger you're inspecting), seeded `account_usage_*` blobs, then a real
browser at 1280/1440/1600/1750/1800/1920 (straddling the bound) printing every meter's
text + tooltip. Exit 1 = clipped.
Use it for any change to a meter's *state* — an `idle`/`stale`/lapsed-reset reading
is invisible to a typecheck and to prod (whose accounts are usually healthy).

`npm run probe:chips` (`web/scripts/check-accounts-visible.cjs`) is the geometry-only
check against an already-running instance (`ORCH_URL=…`); it fails when a chip isn't
fully visible, when the strip is scrollable at all on desktop, or when a top-bar child
is pushed off-screen. Its last line is the one that doesn't depend on the sample widths:
it bisects for the viewport where **wrapping switches off** and fails if one row doesn't
fit there at the bar's widest. Sampling can't cover this on its own — move the bound and
the sample widths move with it, away from the range the old bound got wrong (proved:
after the 08-13 fix every sampled width passed against the *unfixed* CSS; only the bound
line went red). It clicks nothing, so
it is safe to point at prod for a **health** read (the nightly sweep does) — but prod's
chips are whatever prod's accounts happen to be, so it is never proof of YOUR change:
use `chip-lab`, which seeds the state. Never point `chip-lab` at prod — it wants its own
instance, and a live token would start a real 5h window.

Cross-ref: project memory `grok-cli-integration-facts.md`; global
`css_mobile_grid_column_minmax_clips.md`.
