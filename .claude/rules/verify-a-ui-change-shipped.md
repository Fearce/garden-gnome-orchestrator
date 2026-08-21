---
paths:
  - web/src/components/SettingsPanel.tsx
  - web/src/components/ThreadDetail.tsx
  - web/src/components/Board.tsx
  - web/src/App.tsx
  - web/src/styles.css
---

# Verifying a shipped console UI change (when you do / don't need a browser)

A green build/typecheck does NOT prove the feature works — but you usually don't need a browser either.
Climb this ladder, stopping once you have enough:

1. **Deploy freshness** — `npm run health --prefix server`: its "process vs dist" block confirms the :4317
   PID started AT/AFTER the dist mtime. If stale, deploy via the atomic hub restart before verifying.
2. **Shipped string** — grep the bundle `index.html` actually references, never `assets/*.js` (dist keeps
   old hashed bundles, so a glob can hit a stale one), from the REPO ROOT (`web/dist` doesn't exist
   relative to `server/`): `S=$(curl -s :4317/ | grep -o 'assets/index-[^"]*\.js'); grep -c "<label>"
   web/dist/$S`. Settings rows and buttons render their `label` UNCONDITIONALLY, so a hit is
   render-equivalent — but NOT proof for dynamically-built or feature-gated text. Drive those.
3. **Server logic** — `npm run test:gates --prefix server` (free, ~5min) for queue/routing/cap mechanics;
   add a gate for new logic.

Reserve a real browser for genuinely interactive flows (a click that mutates state, a round-trip surviving
reload, clipboard, drag) — on a THROWAWAY instance, and **DON'T hand-roll one**: `scripts/lab-harness.cjs`
boots/kills/authenticates it (bogus tokens so the boot ping can't start a real 5h window; kills by port
owner, never by process name). A "lab" is a committed script on top of it that seeds its own state and
drives one surface — copy the closest of `chip-lab.cjs` (accounts strip), `git-console-lab.cjs` (Git
console + fixture repo), `tablet-lab.cjs` (both tablet orientations in a TOUCH context),
`model-select-lab.cjs` (a Settings toggle's round-trip + a server-fed table) and `inject-lab.cjs`
(state-conditional button labels + a click that must not kill the task). Never against live prod.
**Read `lab-harness.cjs`'s header first** — selectors, `has-text` vs `text-is`, touch context, clipboard
permissions and CSS load order are all in there; instance mechanics are in project memory
`browser-test-throwaway-instance`.

**In a lab, wait for the socket's `hello`, not for the shell to mount — and never believe an optimistic
control.** Everything server-authoritative (settings, accounts, any broadcast collection) renders NEUTRAL
DEFAULTS until that frame lands, so a check opening on `.topbar` reads "off" and an empty list on a busy
box — indistinguishable from the feature being broken. `.accounts .acct` is hello-only, so it is the
signal. And a settings toggle flips its own `aria-checked` BEFORE the round-trip (`store.setSettings` is
optimistic), so re-reading it proves nothing and reloading straight after races the write: poll the
instance's own kv row (`waitForPersisted` in `model-select-lab.cjs`) — the claim you actually mean.

## READING prod is fine, INTERACTING with it is not
"Never browser-test prod" is about *interaction*; stopping there sends agents off to hand-roll a script
(2026-08-01 — one clicked a card on `:4317`). A no-click load mutates nothing and is the only way to see
the console still boots: `npm run probe:console` (mounted / WS live / no errors) and `npm run probe:chips`
(geometry). Keep both click-free, and read them as HEALTH only — prod's state isn't your change's state.
**Often it can't be driven anyway:** a pending director question sits as a full-screen `.scrim` + `.modal`
intercepting ALL pointer events, and dismissing it to reach Settings silently kills a real question that
was the owner's to answer. Use a lab, or steps 1–3 (this burned a verify pass on three features).

Cross-ref: `e2e-a-pipeline-lane.md` (driving a server-side LANE, no browser).
