---
paths:
  - "web/src/components/Accounts.tsx"
  - "web/src/components/Board.tsx"
  - "web/src/styles.css"
  - "web/src/App.tsx"
  - "server/src/accounts/*.ts"
---

# Subscription usage strip

Desktop usage lives in the board's **existing 18px top padding**, directly between
header gnomes and board tabs. The owner explicitly rejected adding a header row or
moving the director/task panels down (2026-10-01).

## Layout contract
- At desktop widths (>=900px), `Board` mounts `<Accounts placement="desktop" />`.
  `.board-usage` has an 18px height and -18px top margin: zero added layout height.
  Never increase board padding or header height to make room for the chips.
- Chips are one 16px line: account name, window labels, short **18px fixed tracks**,
  and values. Burn pace/reset/idle details remain in meter tooltips and accessible
  labels. Banked-reset buttons remain visible and retain their confirmation.
- Desktop usage is permanent, independent of the old `orch-usage-hidden` setting.
  Focus mode still hides ambient usage/gnomes. The desktop strip never shares
  horizontal space with the gnomes.
- The strip has `min-width: 0` and horizontal overflow inside the board. Five normal
  chips fit on a wide desktop; a narrow board (director/detail open) may scroll.
  Every individual chip must be fully reachable, with no page/header overflow.
  The region is keyboard-focusable for arrow-key scrolling.
- Below 900px, App mounts the gauge and the original full-size phone popover.
  Only one Accounts instance subscribes to provider state at either breakpoint.
- `.app` retains `grid-template-columns: minmax(0, 1fr)` and `overflow: hidden`;
  `.topbar` retains `min-width: 0`.
- Assert computed geometry, not the CSS declaration. Later styles and theme rules
  can override a correct-looking rule.

## Verify
```bash
npm run build --prefix web
npm run usage-strip-lab --prefix server -- --shots data/usage-strip-lab-shots
npm run chip-lab --prefix server -- --shots data/chip-lab-shots
npm run probe:chips -- --explain
```

`usage-strip-lab` boots an isolated instance with bogus tokens and browser-only
fixtures. It checks five subscriptions at 900/1100/1280/1440/1920/2560px, short bars,
zero movement of the header/director/tabs/cards when usage is removed, Nocturne,
mobile popovers, focus mode, reset buttons, and tooltip details.

`chip-lab` seeds real usage states in a temporary DATA_DIR: healthy, lapsed-weekly,
stagger-hold, stale, capped, Grok free/metered, and Codex healthy/no-CLI. Run relevant
scenarios after changing meter presentation. It checks reachable chips, visible
meter-column spills, and tracks >=12px. Never point this lab at production or use
real account tokens: a boot ping can start a real 5h window and shift its stagger.

`probe:chips` is a read-only geometry check against an already-running instance
(`ORCH_URL=...`). It checks usage inside existing padding, unchanged panel positions,
chip reachability, short tracks, and topbar fit while live and reconnecting. It is
safe for production health checks, but fixture labs are the evidence for a change.

When patching a pinned lab asset as a negative control, also remove its `.css.br`
and `.css.gz` siblings; otherwise the server serves the old precompressed CSS.
