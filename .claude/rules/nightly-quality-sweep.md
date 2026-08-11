# Nightly / quality sweep + resume-after-bounce

When the brief is a health/quality sweep ("nightly check", "make sure everything is smooth") or you
are auto-resumed after an orchestrator restart that already completed, run `npm run quality`. It executes
the eight checks below in order and stops at the first failing command. Run an individual step only when
you are diagnosing a failure or re-checking a specific surface.

## 1. `npm run health --prefix server`
(`nightly-health.cjs`) — hits `/api/health`, checks `:4317` vs `dist` **and `dist` vs HEAD**, greps live
reliability symbols, lists dirty git paths, summarizes SQLite parks/caps/stuck runs, and scans `crash.log`
for real faults vs benign memory high-water notes. Exit 1 = hard fail; a dirty tree alone does **not** fail.
Read **`dist` vs HEAD** carefully: process-vs-dist can agree while `dist` itself predates HEAD — how a
feature shipped its web half and sat in prod a full day unbuilt on the server (Stop button, 2026-07-29). It
compares by CONTENT (`dist/.build-info.json`'s commit vs HEAD's `server/src`, tests excluded); timestamps
alone would cry wolf every sweep. A warn = `npm run build` + the atomic hub restart.

## 2. `npm run typecheck && npm run test:gates --prefix server` — health does NOT run the gates
health greps dist symbols only, so a green one can sit on top of crash-broken gates (a missing
`StubAccounts.setSpreadUsage` once slipped past a "13/13 green" claim). `test:gates` (`scripts/run-gates.cjs`)
runs every registered FREE gate in ~90s (don't hardcode the count) and exits non-zero on any failure — stubs
+ a throwaway git repo, no `claude` subprocess, no quota. Once, at the end; never gate by gate.
`test:gate-registration` checks the suite is itself complete: a `test:*` script missing from `GATES`, or a
`src/tests` file with no script at all, is a failure.

## 3. `npm run probe:run-errors --prefix server` — triage the non-done runs (`-- 168` for 7 days)
`health`'s `runs 24h: { error: 10 }` is a COUNT, and most non-done runs are expected: a turn-ceiling cutoff,
a cap that failed over, a restart that auto-resumed, a retried 5xx. The probe classifies each, lists only
what needs a human, and **verifies the mechanism ran** (a cap/restart on a `review`/`failed` task with no
later run = something stopped mid-work). `num_turns` at the role's ceiling (implementor
`implementorMaxTurns`, qa 60, others 40) is a benign cutoff — that misread is why this step exists. Backs
health's `non-done reasons:` line. Gate: `test:run-classify`.
**Read the `cap classifier agreement` section when it appears.** Its regexes are a hand-copied mirror of
`runner.ts`'s, and on 08-05 both were blind to z.ai's wording at once — so it now diffs itself against
`agent_runs.cap_flagged` (what the RUNNER concluded). "Looks like a cap here but the RUNNER never flagged
one" means that run did NOT fail over: teach the backend's wording to `providerCapText`, then mirror it
into `CAP_RE`. The reverse is only noise in this probe. A silent section is not proof — when BOTH are
blind (the 08-05 case) the row reads `real`, so check `cap_flagged` on any real failure. Gate: `test:cap-flag`.

## 4. `npm run probe:parks --prefix server` — name the parked AND abandoned tasks
health's park line is a count too; this is the "read the thread error" it asks for — each task's id, age,
reason and last run, from the same classifier, so the two can't disagree. Classes: **stalled**
(QA/auto-review/resume stopped mid-verification — only a Resume or Auto-review clears it), **verdict**
(finished, awaiting the owner — by design, however old), **capWait** (`⏳ Auto-resume pending` — the cap
supervisor owns it, acting manually races it), **unknown** (wording drifted from `PARK_CLASSES` — fix the
classifier). A stalled park is already tagged **bug or stale** on its `↳` line (`recovery-features.cjs`,
gate `test:recovery-features`): `stale — … predates <feature> (<sha>); a Resume exercises the fix`, or
`… continuations already spent — the recovery mechanism ran and gave up`. Trust it, don't re-derive ship
dates by hand; only a stalled park tagged NEITHER needs a `probe:task-runs` drill. Gate: `test:park-classify`.
**Read the second section too — `review` is not the only state waiting on a person.** A restart's casualties
sit in `failed`, which no sweep step read until 08-10: nine had piled up, two stranded mid-work for two days
(08-08's own sweep among them) because the auto-resume they were promised died with the process that promised
it. **promised** is the class to act on (still claiming "auto-resuming…" — a Resume clears it, and a boot now
re-arms it automatically); **clickResume** is the standing owner queue, like `verdict`.

## 5. `npm run probe:accounts --prefix server` — backend headroom (the one watch-item)
A green sweep still leaves headroom to eyeball. Prints the Claude subs' 5h/7d capacity, then the **failover
ladder** — Codex / Grok / z.ai as `available (5h x% · 7d y%)`, `CAPPED — frees in <countdown>`, `NO ROOM —
<window> at N%`, or `disabled` — and a **ladder depth** line. Nothing counts as a rung while either window
is ≥98%, sub or backend: a "5h 0%" sub with a spent weekly doesn't, and neither does a backend never
rejected (so unlatched) but simply spent — that's `NO ROOM`; reading the latch alone once reported 3 rungs
over a 1-rung reality. Windows aren't the only door: Grok also meters a monthly CREDIT pool routing refuses
it on, so its line carries `credits N%` and a dry pool is `NO ROOM — monthly credits`. A window whose reset
has already passed has rolled over and counts as free even at 100% (routing agrees) — that is why Grok can
read `7d 100%` and still be a rung. A reported reset >2× its own period is a backend sentinel, printed but
never counted down (z.ai answered Jan 2027 for a 5h window). Depth ≤1 is what to act on: a burst then parks.
One capped/spent backend is normal. Gate: `test:failover-ladder`.

## 6. `npm run probe:console` — the console still loads (health cannot see this)
`/api/health` proves the SERVER answers; a bundle that throws on mount or a WS that never connects keeps it
green over a dead UI. `console-smoke.cjs` asserts the app mounted, `.conn` reads live, and zero console
errors / failed requests (`-- --shot <png>` saves screenshot evidence for the report). `npm run probe:chips`
is the separate 4-width chip-clipping check. Both are read-only and **click NOTHING** — that is what makes
them the only browser checks safe against prod; read `.claude/rules/verify-a-ui-change-shipped.md` before
extending either, and never hand-roll your own drive against `:4317`.

## 7. `npm run audit:deps --prefix server && npm run audit:secrets --prefix server` — security hygiene
`audit:deps` asks npm only about packages deployed to the server (`--omit=dev`) and fails when it finds a
**high** or **critical** advisory. It still prints lower-severity upstream notices so they are visible without
turning a healthy sweep red. Do not run `npm audit fix` blindly in the shared checkout. You no longer have to
derive the fix by hand: on a failure it prints, per advisory, where the package sits, the version that clears
it, and **each parent's declared range with a verdict** — `a floor bump, safe to override` means every parent
already accepts the fix (make the override), while `fights semver` means the parent needs upgrading instead.
**A `fights semver` line always carries a follow-up naming whether that upgrade actually exists**, because it
often does not: `no parent upgrade exists, so an override is the only route` means the parent still pins the
vulnerable version in its NEWEST release (officeparser has pinned `pdfjs-dist` exactly in every release), and
overriding past the pin is then correct — verify the consumer still works, and key the override on the major
line so a future upstream major fails the override audit loudly instead of silently forcing a downgrade.
When the advisory sits in one branch but a sibling needs a different major, scope the override to the
**narrowest direct-dependency branch**, rather than overriding the common ancestor: npm applies an ancestor's
override to every descendant. For example, an affected `root > provider > nanoid` path beside a `root > docx >
nanoid@5` path needs `"root": { "provider": { "nanoid": "^3.3.18" } }`, not `"root": { "nanoid":
"3.3.18" }`. Confirm with `npm ls nanoid --omit=dev --all` that the patched copy is on the affected branch and
the sibling kept its required major. The override audit walks nested selectors so that full path is still checked.
**An override is verified at the RESOLUTION path but takes effect at the LOAD path**, so confirm the patched
copy is the one that RUNS: officeparser also hardcodes a CDN worker URL pinned to the vulnerable pdfjs, which
would have made the 08-07 fix cosmetic had Node used it. `test:pdf-parse` now holds that (parses a real PDF,
fails on a `PDF_WORKER_FALLBACK`); a dep that loads by URL/vendored copy/wasm blob needs the same treatment.
It also runs the **override audit** (`audit:overrides` standalone) over `package.json`'s `overrides`, because
a pin that stopped binding is invisible — npm never reports one, and `audit:deps` only goes red later, once a
new advisory lands on whatever quietly came unpinned. **Key an override on the major line with a range value**
(`"brace-expansion@^2": "^2.1.4"`), never an exact version: the 08-02 pin to `2.1.3` was itself in the
advisory range days later, and its `minimatch@9.0.9` parent key would have silently become a no-op on the next
bump. A dead selector fails; an exact one warns. Unlike a `scripts/*.cjs` fix, a dependency patch **needs a
deploy** — the old copies stay resident in the running process. `audit:secrets` checks the real gitignored
`.env` values against both the tracked tree and git history, known token shapes, tracked secret-type files,
and public-repo basics. Both commands are read-only.

## 8. `npm run probe:db-size --prefix server` — what the DB is made of, and is any of it waste
The one watch-item that used to have no probe, so it was tracked in prose — which drifted into being
WRONG and stayed wrong for weeks: it named `messages` as "the bulk" because `messages` has the most
ROWS, while by BYTES it was `attachments` (183 MB of 291.7 MB from 337 rows, 75 MB of it the same
pictures stored per reference; `1cd7154`). **Measure table size with `dbstat`, never `COUNT(*)`** — this
probe does, folding each index into the table it serves. It also standing-checks the attachment store
and **exits non-zero on a regression**: duplicate blobs keyed exactly as `addAttachment` keys its dedupe
(sha256+name+type, so a deliberately re-named copy is not miscounted), and rows with no sha256 (an
insert path that bypassed it). An orphan is a WARNING only — a crash between storing bytes and writing
the message that points at them leaves one legitimately. Free pages are headroom, not waste: SQLite
reuses them, so don't propose a `VACUUM` (exclusive lock on a live DB, buys only file size). Growth
itself is never a failure — once nothing is duplicated, shrinking further is Kevin's retention DECISION.
Gate: `test:db-size`.

## Do / don't
- **Do NOT re-restart** if the resume note says the bounce already completed — only verify live `dist` + health.
- **Do NOT `git add -A`** when `health` lists dirty paths; those are usually a concurrent implementor's WIP
  (office claims win). Pathspec only your files. Nor **re-apply** a teammate's already-pushed fix — check
  `git log -5 --oneline` + office claims first.
- **Do not run `npm install --omit=dev` in this shared checkout.** It removes the server's `tsc`/`tsx` and
  breaks the next build; repair a partial install with `npm install --prefix server`, then typecheck + build.
- **A real bug** gets its own conventional commit, pathspec-staged, pushed (not vota) — and you deploy server
  changes yourself via the atomic hub restart when your code isn't in the running `dist` (step 1 answers that).

## Related
- Office harvest gotchas: `.claude/rules/office-bridge.md`
- Shared-checkout deploy without peers: project memory `shared-checkout-concurrent-edits`
