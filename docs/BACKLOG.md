# Backlog

Reported problems and planned work that nobody has picked up yet. Each entry records **what was
reported and what evidence already exists**, so the task that picks it up starts from that evidence
instead of re-diagnosing from scratch. An entry is not a diagnosis: where the cause is unknown, it
lists the open possibilities rather than guessing.

Settled "should we adopt / replace X?" questions live in [`DECISIONS.md`](DECISIONS.md), not here.

When you pick an entry up, link your task/commit under it. When it's fixed, delete the entry in the
same commit as the fix. Git history keeps the record.

---

## In progress














- **Script Hub organization: surface the tag-audit CSV as a deliverable** (2026-10-07). The `all`-tag filter
  collision is fixed; the audit CSV exists in the main checkout's `server/data/`, but its refused card has no accepted replacement.

- **QA: independently verify prepaid credit fallback and existing-balance-only safety** (2026-10-07, Codex QA).



- **QA: finish clean-checkout guidance for editing reviewers and independently verify popup prevention** (2026-10-07, Codex QA).

- **Bound browser-lab Windows port-cleanup waits** (2026-10-06, Fennel Shutter).

## Shipped, awaiting live proof

- **Nightly runtime, provider currency and latency sweep** (2026-10-08, Saffron Wicket).
  Provider SDK/CLI updates are live; indexed inbox activity, unchanged tool-digest caching and reused Git status are committed and compiled but await the next permitted server restart. Full sweep 14/16; gates 240/244 with all four failures repaired and passing focused reruns; types/builds, inbox/browser, Electron 59/59 and both-theme focus checks pass. Historical HTTPS secret remediation remains blocked; capacity and oversized Codex input findings are recorded below. No second restart was performed after automatic resume.


- **QA: preserve AUTO repo scope and searchable-picker keyboard choices** (2026-10-07, Codex QA; task 547b354c).
  Reproduced and fixed quoted paths with spaces, omitted missing paths, overlapping multi-project names and
  ambiguous follow-ups; fixed stale search rows, empty-list focus, filtered multi-selection submission and
  truncated repo paths on phones.
  AUTO/routing/README/privacy gates 8/8, direct privacy tree scan, all types/builds and desktop/narrow/phone browser
  91/91 pass. The gate-runner identity regression is fixed by peer commit 7ea9613b.
  Live source process restarted after integration; web bundle and four screenshot-card downloads match.
  Independent review remains; source-mode deployment identity is tracked under Ready.
  Claude QA round 2 (Thimble Quill): the picker had no way out short of a pick or the 20-minute timeout
  (none after a restart). Added **Don't send**, which answers with no path, so nothing dispatches.
  Lab 95/95 including the decline path; auto-repo gate, types, web build, README claims and privacy pass.


- **Explicit Claude cloud requests never silently launch locally** (2026-10-07, Thimblewick; task 10379cdb).
  Live c0cb1279 hosted review returned findings; both balance chips verified beneath names. Review reproduced a local Resume escape; server control guard is committed/compiled, while the web guard is published. Cloud regressions, auto-review 214/214 and desktop/phone 70/70 pass; live UI controls verified. Follow-up guard 8228cf7e is integrated/pushed. Owner chose to keep the server guard staged for the next restart; live API refusal proof follows activation.



- **QA: stabilize supervisor duplicate-boot retry verification under load** (838f708a, 2026-10-07, Codex QA).
  Full suite 237/239 before repair; supervisor now 12/12 standalone and passes with affinity/revival/fallback (4/4 gates), types/builds/browser/privacy pass. Fixture tree reaped; independent review remains.

- **QA: distinguish throttled cloud-credit reads from rejected profile tokens** (2026-10-07, Codex QA).
  HTTP 429 regression preserves unknown credits and waits for refresh; HTTP 401 still requests a login. Cloud/reset gates, types/build and desktop/phone 62/62 pass; refreshed matching local login restores both live balance chips and guide serves. Deployed d15fe425; independent QA remains.


- **Spread concurrent agent launches across available subscriptions** (2026-10-07, Fernspanner).
  Twelve live-handle launches balance 6/6; routing, auto-model, capacity, reset-burn, types/build, README and privacy pass. Server activation awaits the next permitted restart; this task resumed after a restart and forbids another.

- **QA: recheck subscription eligibility immediately before cloud session creation** (2026-10-07, Codex QA).
  Reproduced and fixed a create after subscription disablement; final guard covers changed login/identity, reset caps and unusable credits. Nine focused gates, types/builds, desktop/phone 62/62 and guide HTTP 200 pass; independent QA remains.

- **QA: honor revoked cloud opt-in at the session launch boundary** (2026-10-07, Codex QA).
  Regression reproduced a launch after revocation; final account/repository checks now prevent it. Nine focused gates, types/builds, 62 desktop/phone checks and live controls/guide serving verified; independent QA remains.

- **Automatic Claude cloud subtasks after subscription caps** (d342c944, 2026-10-07, Thimblewick).
  Live build d342c944; production policy enables both subscriptions for this repository (browser-verified, chips $221.35/$248.79). Isolated hosted runs consumed promotional funds; awaits the first production cap-triggered `cloudWork` subtask.

- **QA: handle unreadable cloud credits and clarify session handoff** (3cd69764, 2026-10-07, Bramble Gauge).
  Null-response crash reproduced and fixed; seven focused gates, all types/builds and desktop/phone cloud lab 52/52 pass. Live chips show both balances beneath names. Independent QA and the new automatic cloud-subtask directive remain.

- **Stop repeated QA instruction lifecycle spam** (9b240512, 2026-10-07, Reedspindle).
  Pushed; live web hides existing noise and authenticated bundle bytes match the build. Injection 186/186, browser 28/28, feed regressions/types/builds/README/privacy pass. Silent QA delivery and batched restart notices await the next permitted server restart; this session's restart-resume instruction forbids another restart.

- **Allow prepaid subscription credits only after included usage is exhausted** (6d3c3d24, 2026-10-07, Pebble Sprocket).
  Credit contracts, provider fallback, token-freeze 95/95, account/Codex usage, desktop/phone 9/9, types/builds, README 72/72 and privacy pass; local opt-ins saved ON. Server activation awaits the next permitted restart; this task's restart-resume instruction forbids another restart. First-start identity/balance regression passes; startup billing reads now follow the identity probe.

- **Add effort selection to the Task model dialog** (2026-10-06, Bramble Dial).
  Model-supported tiers and durable next-start effort; integration 59/59, desktop/phone browser 27/27, types/builds/README/privacy pass. Server deployment pending: restart-resume instruction prohibits another restart.




- **QA: make unread Surveillance alerts conspicuous and verify module readiness** (2026-10-06, Codex QA).
  Pulsating desktop and narrow alerts; notification browser 30/30, viewer 28/28, complete modules, types/builds/README/privacy pass. Independent review required.

- **QA: keep module startup polling within the idle window** (f4e3260b, 2026-10-06, Codex QA).
  Native startup liveness and idle countdown from readiness resolve the tracked module idle-start failure; module gate 36 worker checks plus follow-ups, motion browser 18/18, viewer 28/28, live 4/4, types/builds/privacy/README pass. Independent review required.

- **QA: preserve rapid per-camera notification changes** (2026-10-06, Mosswick).
  Serialized camera updates; motion browser 18/18, viewer 28/28, types/builds/README/privacy pass. Module suite retains tracked Home idle-start failure; independent review required.

- **QA: preserve held tab drags on touchscreens** (2026-10-05, Brindle Cog).
  Separate mouse/touch sensors fix native pointercancel; board-head-lab 54/54, gates 230/230, types/builds/privacy pass. Independent review required.

- **QA: require the actual browser-to-desktop navigation and its issued ticket** (2026-10-05, Codex QA; task 70393577).
  e464439f fixes a fail-open assertion; lab 59/59 before rebase, 57/59 after (two shutdown timeouts). Full gates 228/229; module timing reruns passed then failed again. Thirteen cards serve; distribution/evidence delivery and native close remain open. Independent review required.

- **QA: independently verify desktop shutdown, packaging and deliverable access** (2026-10-05, Codex QA; 80fd126f, task 70393577).
  Electron/browser lab 59/59, free gates 229/229, shutdown/probe regressions 6/6; native window exits in 459/276 ms and preserves the backend. Ten cards download correctly; distribution and eleven retained evidence files still need delivery. Independent review required.

- **QA: keep automated desktop windows off the primary monitor and repeat clean-exit verification** (2026-10-04, Codex QA; task 70393577).
  Electron/browser lab 59/59, gates 229/229, types/builds/privacy and Windows packaging pass. Packaged windows close in 626/332 ms; live browser task/settings/calendar pass. Independent review and distribution delivery remain required.
- **QA: harden desktop settings, checkout selection, download names and load-probe cleanup** (2026-10-04, Moss Gauge).
  Desktop units 19/19 and new real-window regressions pass; application types/builds, Windows packaging and privacy pass. Clean-exit lab failures and distribution delivery remain under Ready.

## Ready (priority order)

1. **Recover Codex tasks rejected by the turn/start input-size limit** (2026-10-08, Saffron Wicket; task d79fb231): nightly probe found six parked tasks with `input_too_large`, limit 1,048,576 characters; one rejected 1,194,397 after 121 minutes while its saved brief was only 8,084 characters. Trace accumulated provider input and add bounded, history-preserving recovery; an oversized fresh kickoff must not loop or silently truncate owner instructions.

1. **Define a separate packed-reference lock recovery policy** (2026-10-07, Flax Thorpe; task 6973a43e): a proven orphan was manually audited and archived with unchanged reference hashes after queued commits and rebases reported `packed-refs.lock`. Automatic recovery intentionally covers only `index.lock`; retain conservative ownership and reference-preservation checks for any extension.

1. **Provide verifiable deployment identity for supervised source-mode launches** (2026-10-07, Codex QA):
   `npm run deploy --prefix server` restarted the live supervised `tsx src/index.ts` process after AUTO repo
   integration, and the web bundle matches the build. `deploy --verify` still exits 1 because source mode
   intentionally reports no build stamp. Support source identity without treating a dist stamp as proof
   of what a source process loaded. AUTO repo QA verified process creation after the changed source files.

1. **Bound repository pre-commit history scans and reconcile old shared-index doctrine** (2026-10-07, Codex; task 6973a43e): observed a repository guard scanning 2,908 commits on every commit and instructions requiring peer authors plus autostash; its own commit helper also needs automatic queue adoption. GGO now supplies a shared transaction command; narrow history lookup without weakening stale-reversal detection.

1. **Identify the process that removed production console assets** (2026-10-07, Codex Recovery): live index referenced missing JavaScript with only compressed remnants left; restored build boots and production rebuilds now retain old assets, but the deleting process is unproven. Also define bounded pruning of retained assets without breaking open clients.

1. **Remove remote proxy metadata as a local-auth trust boundary** (2026-10-07, Codex): a loopback proxy that strips every forwarding header cannot be distinguished from a direct local caller on the current single listener; use a separate listener or authenticated proxy protocol before supporting such proxies. Security sweep report records the assumption.

1. **Resolve Electron clean-exit verification before accepting the desktop app** (2026-10-04, Moss Gauge): desktop lab 52/55; three 20-second app-exit timeouts, and packaged-window-close verification timed out at 15 seconds. Live HTTP/WS load probe completed without a desktop-open regression.
2. **Surface the desktop distribution and all retained validation artifacts** (2026-10-04, Moss Gauge): installer and retained screenshots/metrics have no deliverable cards; existing eight cards serve. Installer exceeds the 25 MB serving cap and needs a supported delivery path.
1. **Investigate console smoke served/local bundle mismatch and browser shutdown timeout**: 2026-10-03 probe reports ws=live with no console errors, served index-C8zofTVy.js versus local index-BHXtYnz4.js, and browser shutdown exceeded 5000ms; authenticated HTTP bundle verification passed earlier in the same task.
4. **Stabilize the dispatch-latency gate's saturated-pool ordering assertion** (2026-10-05, Codex QA): full gates scored 228/229 with blocker0 finishing before dispatch under concurrent load; two focused reruns passed 8/8. Evidence: test:dispatch-latency, section C; unrelated to module workers.
5. **Recheck production SQLite tool-message read stalls with the existing server-stalls task** (2026-10-05, Codex QA; owning task 913d9247): build 332a87c4's idle and module-load monitor windows both contained the same 14,851 ms stall, attributed to ToolCallDigest.readAfter/toolCallsAfter (SQLite held 9.7s). The isolated module lab recorded zero stalls; this is outside the module migration's repair scope.

6. **Stabilize module idle-exit verification under concurrent gate load** (2026-10-05, Codex QA): test:modules crashed when its 1,200 ms idle worker exited during startup; full gates 228/229, direct and focused gate reruns passed all module checks. Module integration task owns the follow-up.

7. **Recover the staged GGO deployment after its refused restart** (2026-10-05, Codex QA): deploy built/staged e464439f but live remains 2f5d8db1 with four differing runtime inputs; health reports an unreachable Script Hub and a pending retry. Hub status returned a stale process snapshot whose refresh was still running. Verify a fresh listener/build after recovery.

8. **Find why `addMessage` INSERTs hold the event loop 1–3.8 s** (2026-10-05, Lanternroot): crash.log 01:28–01:33Z on build 57414a66 blocks every minute on `INSERT INTO messages` (worst 3.8s; 4–12 slow statements/min). A 30 s `/api/health` baseline with no memory traffic still peaked at 0.4–0.8 s; memory's own index lives in a worker on a separate file.

9. **Stabilize Windows integration-fixture cleanup after the worktree sweep update** (2026-10-06, Thistlewatt): post-restart full gates fail test:restart-revival (temporary workspace rmdir EBUSY) and test:manual-deployment (temporary SQLite unlink EBUSY); functional assertions preceding cleanup pass. Evidence: server/data/gates-live/188-test-restart-revival.log and 141-test-manual-deployment.log.

10. **Restore Git drawer untracked files in baseline fallback** (2026-10-06, Thistlewatt): full test:git passes 75 checks but fails both null/invalid-baseline assertions: README appears while the untracked task note is missing (expected 2 files, actual 1). Evidence: server/data/gates-live/204-test-git.log.

11. **Stabilize Surveillance legacy recording restart verification** (2026-10-06, Bramble Lens): two test:modules runs failed at modules.test.ts:859/862 after legacy armed recording restart (active=false, then worker readiness exceeded 20s); motion browser 47/47 passed, no worker code changed.

12. **Profile throttled phone startup and reduce the initial history payload** (2026-10-06, Mosswhistle).
  Live build 4545d296 sends a 2.3 MB hello; phone cold/warm readiness is 14.0/8.3 s at 4x CPU and 80 ms network latency despite no errors/overflow. Evidence: server/data/optimization-evidence/startup-after.json; the isolated 1,400-task streaming lab passes.

14. **Clear residual Graphify and desktop build dependency advisories** (2026-10-07, Codex): production Graphify transitive dependencies retain 7 moderate / 4 low advisories; the desktop development tree retains 8 moderate through Electron Builder. Recheck compatible upstream fixes without breaking the bundled CLI.

15. **Investigate intermittent slow live Patch notes loading** (2026-10-07, Bramblewick).
  During concurrent security/credit verification, the live panel waited over 60s and an authenticated API probe timed out; a repeat API read returned 200/150 entries and real-history live folding passed. Isolated history lab passed 42/42.

16. **Migrate remaining major package updates against feature contracts** (2026-10-07, Brindlewick).
  Compatible server/web/relay/desktop updates are applied; Graphify 0.19 removes the officeparser dependency used by the bundled PDF parser contract. SQLite 13, TypeScript 7, dotenv 18, React Markdown 10 and Monaco 0.57 need their own migration checks.

17. **Measure the remaining task-start delay beyond board loading** (2026-10-07, Brindlewick).
  Typical first CLI output remains 18-40 s. Restart-wave cold toolCallsAfter reads held SQLite for 1.8-2.3 s; fresh startup must be distinguished from steady state. The read-only probe-tool-digest.cjs demonstrates watermark scans; index experiments are restricted to memory fixtures. Steady desktop cold/warm readiness is 0.9/0.9 s; throttled phone 8.9/4.9 s.

18. **Handle SQLite writer contention without crashing streamed-agent handlers** (2026-10-07, Brindlewick).
  An attempted online index rebuild caused an uncaught database-is-locked error in addMessage and a supervised restart. The transaction rolled back, the original index remains and seven tasks resumed. Never rebuild the live index; investigate bounded write retries and scheduled offline maintenance.


19. **Stabilize worktree-sweep timing verification under concurrent gate load** (2026-10-07, Codex QA).
  Full suite resolves 300 tasks in 5,199 ms against a 5,000 ms assertion; the serial rerun passes. Verify lookup counts independently of scheduler timing. Evidence: restart-affinity worktree's server/data/gates-last.log.

## Blocked / waiting

- **Choose an eligible NVIDIA free-pool model** (2026-10-08, Saffron Wicket): live refresh marks the saved `openai/gpt-oss-120b` choice as no longer verified free and sends no inference request. Settings must select another verified free model; preserve the explicit owner choice until changed.

- **Verify Claude prepaid funds before enabling credit-backed dispatch** (2026-10-07, Pebble Sprocket).
  Read-only provider checks found one expired profile credential and one zero prepaid balance with usage credits disabled. Requires matching current credentials and prepaid subscription funds with auto-reload off; API Console balances are separate.

- **Purge cached private-project reference from PR #10** (owner action: include old PR body in the GitHub Support request).
  QA redacted the live body and verified https://github.com/Fearce/garden-gnome-orchestrator/pull/10; legitimate contributor attribution remains intact.

- **Rewrite published history to remove personal details the tree no longer carries** (owner action: filter-repo + force-push master, delete five stale remote branches, GitHub Support for PR refs/caches, coordinate the published fork rewrite).
  Corrected kit (surfaced as a deliverable) in the main checkout's gitignored `_privacy-remediation` folder: fresh public mirror dry-run 2026-10-04 reduced 2,751 matches (including exposed PFX passphrase) to 0; public fork still has 211 matches; nothing force-pushed.
- **Rotate the local HTTPS PFX passphrase** (owner action): it is a weak dictionary word, and `npm run audit:secrets --prefix server` finds that word in four reachable published commits (value withheld), so treat it as exposed: set a random passphrase, re-encrypt the PFX and update `server/.env`.

## Open

No open entries.

## Done (newest first; keep the last 20)

- 2026-10-07 **Preserve QA kickoffs and deliver chat context on scheduled inputs** (f89a70cc, d36b176e, 521c3d00, c61ef063, Moss Quill with Toggle Thistle): deployed and verified live build c61ef063; resumed agent input contains unread direct mail and recent office/team chat. Production mounted browser sees quiet self-test mail, owner viewing preserves unread, five handled self-checks explicitly acknowledged. Inbox 28/28, actual Codex/Grok fresh/resumed/recovery launch regressions, provider fallback, server/web builds, README 74/74 and privacy pass. No mail-triggered wake or automatic acknowledgement.

- 2026-10-07 **Document queued publication and remote-writer limits** (Flax Thorpe; task 6973a43e): README describes reviewed remote commits, checked script exit codes and one fetch/merge/push lease. Guidance matches the successful publication transaction in d0fb68c0; documentation only.

- 2026-10-07 **Serialize concurrent Git writes and recover proven interrupted index locks** (f3ce9c45, Flax Thorpe; task 6973a43e): pushed; live build 895076a0 activates ten-minute FIFO admission. Observed 80 peer commits, eight pending tickets draining and three automatic orphan recoveries with unchanged index hashes, including two after restart. Hook scans and legacy-helper queue adoption remain in Ready.

- 2026-10-07 **Repair inbox requests beneath the console mount** (7c57dd9d, Moss Quill): production browser at the proxied /orchestrator/ mount loaded the directory and exact quiet self-check mail; viewing preserved prior unread. Mounted desktop/root phone browser and CLI 30/30, inbox integration 23/23, web typecheck and build pass.

- 2026-10-07 **Scheduled hours for the Token safety limit** (8e7c5267, Tock Thistlewick): owner chose the Token safety limit, not the goal burn-rate guard. Settings > Usage & limits has an M T W T F S S strip, start/end times, an explicit IANA zone and live on/off status with the next change. Live GGO (restarted 17:56 on HEAD) persists Mon-Fri 08:00-16:00 Europe/Copenhagen with the 90% limit; production browser shows "Suspended now. Applies again Thu 08:00." at 1440 and 390px. Schedule 35/35, token-freeze 112/112 (Test M), schedule UI, schedule lab 27/27, token-safety lab 23/23, conservation 29/29, server+web types, README 74/74 and privacy pass. QA shortened the "Only during set hours" hint (711c04fb); the schedule lab passes 29/29 and six screenshot cards serve from the task worktree. Production runs from source under `supervise.cjs`, so `deploy --verify` has no build stamp to read; `npm run health` confirms no `server/src` file changed since the process started and that `web/dist` matches HEAD. The gate runner's `gates@localhost` identity no longer makes "gates" a private word in the privacy guard.

- 2026-10-07 **Restore inbox access on CLI resume and bound browser failures** (895076a0, Moss Quill): pushed and deployed; live resumed CLI capability works. Inbox 23/23, vanilla 23/23, browser/CLI 30/30 pass, including missing endpoint and 15-second send timeout with draft recovery.
- 2026-10-07 **Direct gnome chat and quiet inbox** (eae8261c, 895076a0, Moss Quill): live build 895076a0; scoped self-check message 1 sent, read in the production browser and explicitly acknowledged, while owner inspection preserved unread status. Types/builds, office regressions, README 74/74 and privacy pass; direct mail is local and never wakes agents.



- 2026-10-07 **Keep restart-interrupted sessions on their previous provider, including promoted reads and admission parks** (cd78bbaf, aac45dca, Codex): live build d15fe425 contains both fixes; production restart retained the exact Codex/Sol session. Affinity 19/19, token-freeze, types/builds, README 74/74 and privacy pass. Completed full sweep 235/239; QA-budget 161/161, Default 23/23 and doc-path 18/18 pass after fixture/build repairs. Supervisor timing remains intermittent (standalone 12/12, serial subset 11/12), tracked in Ready.

- 2026-10-07 **Stop inherited QA after a registration-only follow-up** (Moss Quill): live task settled done with durable QA-off; Script Hub reports the app running. Task-role controls 38/38, README 74/74 and privacy pass; README explains inherited routing and task overrides.

- 2026-10-07 **Route agent questions through GGO chips and resume on answers** (41945c65, 01f33516, Codex QA): pushed and integrated; deployment verification confirms live build 4995ab97 contains the bridge. Twelve desktop/phone Codex/Grok browser flows prove chips, durable answers, held completion and same-session continuation; types, builds and focused regression gates pass.

- 2026-10-07 **Offload eligible tasks to Claude cloud and show both subscription credit balances** (3471a225, 50813f1c, Thimblewick): live build 4995ab97; provider-verified matching profile logins and authenticated desktop/phone browsers show both balances beneath names. Eligible read-only smoke consumed $0.46 promotional credit; cloud lab 48/48, account/reset/cloud tests, types/builds, README 74/74 and privacy pass. Profile tokens require renewal after expiry.

- 2026-10-07 **Restore blank console and retain assets during production rebuilds** (Codex Recovery): live direct/proxy entry assets match disk with JavaScript MIME; browser renders sign-in, and a subsequent production rebuild preserves the previous entry bundle. README 74/74 and privacy pass; backend stayed running.

- 2026-10-07 **Nightly quality, provider currency and task responsiveness sweep** (7306a850, Brindlewick): pushed and deployed; 235/235 gates, types/builds, desktop 19/19, README 73/73 and privacy pass. Live lazy snapshots retain 1,425 tasks with a 62% smaller index and 30 visible summaries in 27 ms; 1,400-task desktop/phone lab passes. Current toolchains and model families verified. Cold SQL/CLI delays, writer contention, major migrations and published-secret remediation remain tracked above. The performance gate now verifies that refused live-index CLI arguments never open SQLite.

- 2026-10-07 **Restore authenticated public reverse-proxy access after security hardening** (1d74f651, Bramblebolt): pushed and deployed; live mounted sign-in, authenticated health and public-origin WebSocket hello pass, signed-out deploy 401 and foreign origin 403; public edge still requires its access gate. Auth regressions, Google tunnel browser 19/19, desktop/tablet prefix browser, types/builds, README 73/73 and privacy pass.
  Follow-up: the prefix-proxy lab now submits the visible password form and receives hello without a reload on desktop and tablet; both pass.

- 2026-10-07 **Edit Script Hub registry entries from the UI** (Codex): 39/39 desktop/phone browser checks, registry conflict/validation regressions, focused API 3/3, types/builds, README 72/72 and privacy pass; live editor, unchanged-entry save and matching served bundle verified. All 289 entries remain tagged (29 personal, 260 agent-managed); worker refreshed without restarting GGO.

- 2026-10-07 **Collapse Patch notes days into browsable summaries** (16e241c7, Bramblewick): pushed and web built; real-history live browser confirms folded defaults, individual toggles and Hide all days; served bundle matches local bytes. Desktop keyboard and phone touch folding verified. Browser 42/42, patch-notes gate, types/builds, README 72/72 and privacy pass.

- 2026-10-07 **Full GGO security sweep and production dependency remediation** (48a71407, a93f23ac, Codex): committed, pushed and deployed; live local/proxied/cross-site checks returned 200/401/403, focused browser and auth tests passed, production audit has 0 critical/high. Residual risks are tracked above and in [the report](security-sweep-2026-10-07.md).

- 2026-10-07 **Make Hide Done include pinned completed tasks** (3d86d439, Juniper Thimble): pin regressions, desktop/touch browser 27/27, types/builds, README 72/72 and privacy pass; authenticated live bundle matches local bytes and includes the new behavior. Live smoke retains the tracked browser-shutdown timeout.

- 2026-10-07 **Audit Script Hub management and pre-tag every entry, using tags only** (08ac3d65, Copperfen Quill): 289 entries tagged, 29 personal/260 agent-managed, 22 tags; live API/browser and durable metadata pass, hidden choices and supervision preserved. Focused API 3/3, browser 27/27, types/builds/README/privacy pass; broad modules retain tracked Home idle-start timeout.

- 2026-10-06 **Prevented worktree PowerShell popups and enforced clean committed checkouts** (b3919727, Thistlecrank): live build verified; three deployed process scans returned data with no popup events; cleanup, CLI kickoff, office, goals, types and README/privacy checks passed. Peer changes were preserved in separate commits; Claude/Codex global rules and generated prompts now prioritize clean checkouts.
