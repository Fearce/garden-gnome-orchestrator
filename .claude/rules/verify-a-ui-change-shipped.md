---
paths:
  - web/src/components/SettingsPanel.tsx
  - web/src/components/ThreadDetail.tsx
  - web/src/components/Board.tsx
  - web/src/App.tsx
  - web/src/styles.css
---

# Verifying a shipped console UI change (when you do / don't need a browser)

A green build/typecheck does NOT prove the feature works. But you usually DON'T
need to drive a browser either — climb this ladder and stop once you have enough:

1. **Deploy freshness** — `npm run health --prefix server`. The "process vs dist"
   block confirms the :4317 PID started AT/AFTER the dist mtime (fresh build
   loaded). If stale, deploy via the atomic hub restart before verifying.
2. **Shipped string** — `grep -oh "<label>" web/dist/assets/*.js | sort | uniq -c`.
   Proves the label is in the served bundle. Settings rows (ToggleRow/NumberRow)
   and buttons render their `label`/children UNCONDITIONALLY, so a hit is
   render-equivalent (the control is on screen whenever its panel opens). NOT
   proof for dynamically-built or feature-gated text — drive those.
3. **Server logic** — `npm run test:gates --prefix server` (free, ~9s) for the
   queue/routing/cap mechanics; add a targeted integration gate for new logic.

Reserve a real browser drive for genuinely interactive flows (a click that
mutates state, a round-trip persisting across reload, clipboard, drag). **Drive
it on a THROWAWAY instance** (recipe: project memory `browser-test-throwaway-
instance`), never against live prod.

## Gotcha: live prod is often modal-blocked — do NOT drive it
The live console frequently has a pending **director question** (an owner decision
awaiting Kevin) up as a full-screen `.scrim` + `.modal` (QuestionModal) that
intercepts ALL pointer events. You MUST NOT dismiss or answer it — it's Kevin's
call (e.g. a deploy-now/hold for an unrelated task). So an interactive drive
against `:4317` can be impossible, and force-dismissing the modal to reach
Settings would silently resolve/kill a real pending question. Use a throwaway
instance or fall back to steps 1–3. (This is exactly what burned a verify pass on
the different-provider-QA / per-repo-cap / copy-reference features.)

## Stable selectors (saves grepping App.tsx / Board.tsx)
- Settings open: `[aria-label="Open settings"]` (gear); panel
  `[role="dialog"][aria-label="Settings"]` (also `.settings-pop`).
- A task row: `.card` (click opens ThreadDetail); title `.closed-card-title`.
- Buttons: by text — `button:has-text("Copy reference")`.
- Clipboard in headless chromium: make the context with
  `permissions:["clipboard-read","clipboard-write"]` AND inject a `writeText`
  stub (`window.__copied = t`) — `readText()` alone can be gated in headless.

Cross-ref: `e2e-a-pipeline-lane.md` (driving a server-side LANE, no browser);
project memory `browser-test-throwaway-instance` (throwaway-instance mechanics).
