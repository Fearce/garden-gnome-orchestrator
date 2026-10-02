# Director sharing (lending a subscription to office members as their Director)

Read before touching `server/src/office/directorShare/`, `server/src/agents/sharedDirectorRun.ts`, the
shared-target branch of `server/src/orchestrator/director.ts`, the `share.*` frames in
`relay/src/{protocol,core}.ts`, or `web/src/components/DirectorSharingSettings.tsx`.
Settings: **Settings > Providers > Director sharing.** Online-office basics: `online-office.md`.

## What it is
A console (the donor) opts a single subscription in, with a deadline. Other members of the online office
(recipients) see the offer, pick it explicitly, and their Director's model calls run on the donor's key.
Only the model call crosses: the recipient's Director, command bridge (`DIRECTOR_CLI_PROTOCOL`), tools,
memory, conversation and dispatched tasks all stay on the recipient and run on its own subscriptions.
One call = recipient transcript in, one JSON Director command out (`SharedDirectorRun`).

## Which subscriptions may be shared: API keys only
Provider terms, checked 2026-10-02, sources in `server/src/office/directorShare/policy.ts`. Claude Free/Pro/Max OAuth, a
ChatGPT-plan Codex login, a SuperGrok login and the z.ai GLM Coding Plan all forbid making the account
available to others, so they are LISTED with the reason and have no controls. An OpenAI API key (`sk-`)
and an xAI API key (`XAI_API_KEY`) are per-token billed to the key owner and shareable. Do not add a plan
login to the shareable set: that is bypassing the provider's access rules, not a missing feature.

## Rules that bite
- **Expiry is a comparison, never an event.** A share is live only while `now < expiresAt`, read at every
  call, every reply and every view (`DirectorShareHost.sweep`). The single timer only makes the transition
  prompt. Nothing consults the timer to decide, so sleep, downtime across the deadline, or a stale
  discovery cache cannot extend a share. A reply that lands after the deadline is withheld.
- **`shareId` is minted on every opt-in.** An expired or stopped share cannot be edited back to life;
  sharing again is a fresh opt-in with a new id, so an old recipient selection or cached offer can never
  ride a later share.
- **Every rule lives on the donor.** The relay and recipient hold copies of an offer; the donor re-checks
  status, endpoint, size, concurrency and the hourly limit per call. The relay additionally stamps `from`,
  routes a reply only to the original caller, refuses calls to unadvertised or expired shares, and settles
  pending calls when either side disconnects.
- **No silent fallback.** While a share is selected it is the Director's ONLY target. Every failover path
  in `director.ts` checks `provider === "shared"` first and ends the turn with the donor's reason
  (`endSharedTurn`). Switching back is the owner's click ("Use my own subscriptions").
- **Never forward provider bodies.** `providerCall.ts` composes errors from status + error code only;
  an auth error body echoes part of the key.
- **The relay feature is gated, not versioned.** `welcome.features` contains `director-sharing`. An older
  relay never says so, and the console shows `relay-unsupported` and refuses to share rather than offering
  a control that cannot work. `RELAY_PROTOCOL` stays 1; all new fields are optional.

## Verify
`npm run test:director-sharing --prefix server` (donor rules, recipient refusals, the Director's
no-fallback), `test:relay-core` (routing, forgery, disconnect settlement), and
`npm run director-share-lab --prefix server` (two real consoles, a real relay, a fake provider: share,
discover, a Director round trip, deadline edit, Stop mid-call, live expiry, downtime expiry, phone width).
The lab needs uncommitted work compiled to an isolated entry: see `lab-harness.cjs`. A relay change
also needs `relay/deploy.sh` from a clean `git archive` export, or the live office stays `relay-unsupported`.
