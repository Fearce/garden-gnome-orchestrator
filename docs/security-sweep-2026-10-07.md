# Security sweep — 2026-10-07

## Scope and outcome

Reviewed the public source tree, server and browser authentication boundaries, remote access, WebSocket upgrades, Markdown links, production dependencies, privacy and secret scans, and the live local-only deployment route. The confirmed request and rendering weaknesses below were fixed, tested, committed, pushed, and deployed. This sweep does not establish that the application is free of every vulnerability.

## Fixed

- A request relayed through a loopback proxy could reach local-only routes without a session when `REMOTE_ACCESS` was off. `isDirectLocal` now rejects any request carrying forwarding headers. Before the fix, a forwarded unauthenticated request to `/api/deploy/status` returned 200; after deployment it returns 401, while a direct loopback request still returns 200.
- Browser API writes and WebSocket upgrades now reject foreign origins. The guard also rejects an unauthenticated loopback request with a non-loopback Host, closing a DNS rebinding path.
- Agent-supplied Markdown links now reject unsafe URL schemes before rendering.
- Session cookies use a random process key unless `SESSION_SECRET` is configured; a password or static default is no longer used as the signing key. Invalid cookie encodings fail as unauthenticated requests, and password cooldown state is bounded.
- Google code-exchange identity claims now require the Google issuer, this client as audience, a future expiry, and an explicitly verified email.
- Updated server, web, and relay dependencies and constrained vulnerable transitive packages where compatible. The server production audit changed from 1 critical / 8 high / 11 moderate / 3 low to 0 critical / 0 high / 7 moderate / 4 low. The web and relay audits report zero advisories.

## Verification

- Focused remote access and WebSocket handshake lab: 19/19, including a foreign-origin 403 and valid same-origin/proxied 101 upgrades.
- Google ID token claim regression and server typecheck: passed.
- Markdown link rendering test and browser check: passed; web typecheck and build passed.
- Production dependency override audit, PDF parser test, privacy scan, and README claims: passed.
- Live server deployment verification: build matches committed HEAD; direct local request 200, forwarded unauthenticated request 401, foreign-origin request 403. The shared checkout's web build contains another task's uncommitted UI work, so this is not a clean web artifact verification.
- A broad free-gate run encountered the previously tracked module startup timeout under concurrent load. Its result is not a green suite verdict; focused security checks above passed.

## Open risks and follow-up

- `npm run audit:secrets --prefix server` still detects the existing HTTPS PFX passphrase in published Git history. The passphrase must be rotated and the published history remediation coordinated with the repository owner and fork. The existing work board items under **Blocked / waiting** track both actions.
- The remaining server production advisories (7 moderate, 4 low) come through the bundled Graphify CLI dependencies; compatible patched releases are unavailable at this sweep. The desktop development dependency tree has 8 moderate advisories through Electron Builder's `sprintf-js` 1.x dependency. Recheck as upstream packages release fixes.
- Remote tunnel classification relies on a trusted local proxy forwarding client metadata. A proxy that strips every forwarding header is indistinguishable from a direct loopback client to the current single listener. Remote deployment documentation must be followed and the proxy configuration verified before exposure; a separate listener or authenticated proxy protocol would remove this assumption.
