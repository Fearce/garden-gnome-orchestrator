---
paths:
  - web/src/components/SettingsPanel.tsx
  - web/src/components/ThreadDetail.tsx
  - web/src/components/Board.tsx
  - web/src/App.tsx
  - web/src/styles.css
---

# Verifying a shipped console UI change (when you do / don't need a browser)

A green build/typecheck does NOT prove the feature works — but you usually don't
need a browser either. Climb this ladder, stop once you have enough:

1. **Deploy freshness** — `npm run health --prefix server`. The "process vs dist"
   block confirms the :4317 PID started AT/AFTER the dist mtime (fresh build
   loaded). If stale, deploy via the atomic hub restart before verifying.
2. **Shipped string** — grep the bundle `index.html` actually references, not
   `assets/*.js` (dist keeps old hashed bundles, so a glob can hit a stale one):
   `S=$(curl -s :4317/ | grep -o 'assets/index-[^"]*\.js'); grep -c "<label>" web/dist/$S`
   — from the REPO ROOT, `web/dist` doesn't exist relative to `server/`. Settings rows
   and buttons render their `label` UNCONDITIONALLY, so a hit is render-equivalent;
   NOT proof for dynamically-built or feature-gated text — drive those.
3. **Server logic** — `npm run test:gates --prefix server` (free; ~4min, most of it
   the two real-git gates) for queue/routing/cap mechanics; add a gate for new logic.

Reserve a real browser drive for genuinely interactive flows (a click that
mutates state, a round-trip persisting across reload, clipboard, drag). **Drive
it on a THROWAWAY instance, and DON'T hand-roll one** — `scripts/lab-harness.cjs`
already boots/kills/authenticates it (bogus tokens so the boot ping can't start a
real 5h window; kill by port owner, never by process name). A "lab" is a committed
script built on it that seeds its own state and drives the surface: `chip-lab.cjs`
(the accounts strip), `git-console-lab.cjs` (the Git console + its fixture repo) and
`tablet-lab.cjs` (both tablet orientations in a TOUCH context) are the three
references — copy the closest one. Mechanics: project memory
`browser-test-throwaway-instance`. Never against live prod.

**A touch change needs `tablet-lab`, and only `tablet-lab`.** `hasTouch`/`isMobile` are
`browser.newContext()` options, not viewport ones, and they are what make Chromium report
`pointer: coarse` / `hover: none` — so every other browser check in this repo runs with a
FINE pointer and is structurally blind to the coarse-pointer and hover:none blocks at the
end of `styles.css`. `npm run tablet-lab --prefix server` drives 1280×800 and 800×1280,
asserting reachability (the ✕ closes, the hover-only actions have a tap route), a tap-target
sweep with a documented exception list, and the clamp that keeps a persisted desktop
`--detail-w` on screen.

**A component's own CSS file loads AFTER `styles.css`, so styling its selectors from
`styles.css` is a source-order bet you will eventually lose.** `main.tsx` imports
`styles.css` first, then the component tree pulls in `gitChanges.css` / `gitConsole.css`
/ `diff.css` — which land later in the bundle. An equally-specific rule for `.changes-chip`
or a `.gc-*` selector written in `styles.css` therefore applies only while the component
file happens not to declare the same property, and nothing goes red the day it does. Put
the rule in the component's own file. Same trap, one level up, as the `getComputedStyle`
rule in `topbar-accounts-strip.md`: assert what the element computes, never what you wrote.

## The line: READING prod is fine, INTERACTING with it is not
"Never browser-test prod" is about *interaction*; stopping there sends agents off to
hand-roll a script (2026-08-01 — one clicked a card on `:4317`). A no-click load
mutates nothing and is the only way to see the console still boots: `npm run
probe:console` (mounted / WS live / no errors) and `npm run probe:chips` (geometry).
A HEALTH read only — prod's state isn't your change's state. Keep both click-free.

## Gotcha: live prod is often modal-blocked — do NOT drive it
A pending **director question** sits as a full-screen `.scrim` + `.modal` intercepting
ALL pointer events. NEVER dismiss or answer it — it's the owner's call, and dismissing
it to reach Settings silently kills a real question. So an interactive drive on `:4317`
can be impossible: use a lab, or steps 1–3. (This burned a verify pass on the
different-provider-QA / per-repo-cap / copy-reference features.)

## Stable selectors (saves grepping App.tsx / Board.tsx)
- Settings: `[aria-label="Open settings"]` (gear) → `[role="dialog"][aria-label="Settings"]`.
  Git console: `[aria-label="Open Git"]` → `.gc-window`. A task row: `.card`.
- Buttons by text: `has-text` is a SUBSTRING match, so adding a button can break an
  existing selector (strict-mode violation: "Auto-review & mark done" also matches
  `has-text("Mark done")`) — use `text-is` when a label contains another's.
- State badges are CSS-uppercased (`.detail-head .badge`): the DOM reads `AUTO-REVIEW`,
  so compare case-insensitively, not against the `stateLabel` string.
- Clipboard in headless chromium: context `permissions:["clipboard-read","clipboard-write"]`
  AND a `writeText` stub (`window.__copied = t`) — `readText()` alone can be gated.

Cross-ref: `e2e-a-pipeline-lane.md` (driving a server-side LANE, no browser);
project memory `browser-test-throwaway-instance` (throwaway-instance mechanics).
