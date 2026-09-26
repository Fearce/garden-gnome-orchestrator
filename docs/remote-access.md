# Remote access: a private public link

GGO can be reached from any browser, anywhere, at a fixed HTTPS address such as
`https://ggo.tail1234.ts.net`, and only the owner's Google account gets in. It costs nothing:
Tailscale Funnel (free Personal plan) carries the traffic and a Google OAuth client (free) does
the sign-in. No router port is opened and GGO keeps listening on `127.0.0.1` only.

## How it stays locked

A tunnel daemon runs on this machine, so everything it relays arrives from loopback. GGO tells
those requests apart by the forwarding headers the tunnel adds (`X-Forwarded-For`, `Forwarded`,
`Tailscale-Funnel-Request` and similar; see `server/src/remoteAccess.ts`). For such a request:

- **Google sign-in only.** The sign-in screen shows no password field, and `/api/login` refuses
  a tunnelled request even with the right password. The Google account must equal `ALLOWED_EMAIL`.
- **Everything is behind the session.** Signed out, only the static console files and the four
  sign-in routes (`/api/me`, `/api/auth/google`, `/api/auth/callback`, `/api/logout`) answer. Every
  other API route and the WebSocket return 401, including `/api/health`, `/api/version` and the
  deploy routes that a direct local script may call without a session.
- **Fails closed.** If Google sign-in is not configured, every tunnelled request gets 403.
- **Secure cookies.** Session and sign-in cookies set over the HTTPS tunnel carry `Secure`.

Direct local use is unchanged, with one consequence to know: once Google sign-in is configured,
the local console asks for sign-in too. Use the Google button (it returns to the local address)
or set `AUTH_PASSWORD` for a local password.

## One-time setup

1. **Tailscale.** Install it (`winget install --id Tailscale.Tailscale -e`) and sign in from the
   tray icon or with `tailscale login`. Any Google account works for the Tailscale login. Note the
   machine's address: `tailscale status --json` shows it as `Self.DNSName`, e.g.
   `ggo.tail1234.ts.net`.
2. **Google OAuth client.** In <https://console.cloud.google.com/>:
   - Create a project (any name).
   - *APIs & Services > OAuth consent screen*: user type **External**, fill in the app name and
     your email, leave it in **Testing**, and add your Gmail address under **Test users**.
   - *APIs & Services > Credentials > Create credentials > OAuth client ID*: type **Web
     application**. Under **Authorized redirect URIs** add both:
     - `https://<your DNSName>/api/auth/callback`
     - `http://127.0.0.1:4317/api/auth/callback` (local sign-in)
   - Copy the client ID and client secret.
3. **`server/.env`:**
   ```
   GOOGLE_CLIENT_ID=<client id>
   GOOGLE_CLIENT_SECRET=<client secret>
   ALLOWED_EMAIL=<your gmail address>
   PUBLIC_ORIGIN=https://<your DNSName>
   SESSION_SECRET=<a long random string>
   ```
   `PUBLIC_ORIGIN` pins where Google returns a remote sign-in. `SESSION_SECRET` signs the session
   cookie; without it the Google client secret is reused.
4. **Restart GGO** so it reads the new values: `npm run deploy --prefix server`.
5. **Open the link:** `npm run remote-access --prefix server -- on`. The first time, Tailscale
   prints a link to allow Funnel for this machine; open it, approve, and the command continues.

## Daily use

```
npm run remote-access --prefix server            # status: off, or open and locked
npm run remote-access --prefix server -- on      # open the link
npm run remote-access --prefix server -- off     # close it
```

`.env` is read at startup, so after editing it the running GGO needs a restart before the link
can open. `on --when-live` waits (up to 24 hours, polling the local `/api/me`) until the running
GGO reports Google sign-in, then opens the link; run it in the background after a staged deploy.

`on` refuses until Google sign-in and `ALLOWED_EMAIL` are set. After opening, it probes the public
URL while signed out. It closes the link again unless the probe finds sign-in required, Google
offered, no password field, and `/api/deploy/status` and `/api/health` refused. `status` runs the
same probe. Exit codes: 0 fine, 1 unlocked or a command failed, 2 an owner step is missing.

The link survives reboots: Tailscale keeps the Funnel setting and starts with Windows. It only
works while this PC is on and GGO is running.

## Verification

- `npm run test:remote-access --prefix server`: the request classification, the gate, and the
  script's open/refuse/close-again flow against a fake `tailscale`.
- `npm run remote-access-lab --prefix server`: a throwaway instance behind a local Funnel stand-in,
  driven in a real browser: the stranger's view, refused routes, cookie flags, local sign-in, and
  the signed-in console with its WebSocket through the tunnel.
