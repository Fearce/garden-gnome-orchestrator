# Optional admin portal link

GGO can show a return link to an admin portal without changing its authentication, workers or provider accounts. This is disabled by default.

- `GGO_PORTAL_URL`: HTTPS admin URL (loopback HTTP is allowed for development).
- `GGO_PORTAL_LABEL`: link label, default `Admin workspace`.
- `GGO_ENVIRONMENT_LABEL`: tooltip context, default `Personal GGO`.

Authenticated `GET /api/portal` returns navigation metadata. A personal gateway may supply this endpoint instead. URLs are checked on both server and client; a return URL is never accepted as authentication or permission.

For Gnomerang, each human has a separate gateway identity and personal GGO environment. Subscription credentials stay in that environment; they are not shared through the company vault. Local bridges forward only the person's loopback GGO and preserve its native authentication. Hosted deployment requires separate data/auth volumes and runtime limits per person. This optional link alone does not implement tenant isolation or provision workers.

Verification: root `npm run typecheck` and `node server/node_modules/tsx/dist/cli.mjs server/src/tests/portalLink.test.ts`. Existing installations return `{enabled:false}` unless explicitly configured; the UI renders no extra navigation.
