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

- **Serialize Git transactions for concurrent agents and preserve reviewed peer work** (661b5fc2, 2026-10-07, Codex; task 6973a43e).
  Eight live same-checkout tasks confirm repeated locks/manual commit windows; 27 queue checks, CLI kickoff, types/build and privacy pass. Real rebase/fast-forward integrated both commits; activation and first agent commit through the queue remain pending. Owner stopped further test expansion to prioritize live observation.

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
- 2026-10-06 **Reverify optimization after the server restart** (Mosswhistle): live build b3919727 matches runtime sources; fresh desktop/phone 1,400-task lab passes with zero transcript renders over 480 background events. Live startup has no errors/overflow: desktop cold/warm 1.1/0.5 s, throttled phone 12.8/8.2 s; 2.3 MB hello and console-smoke shutdown timeout remain tracked above.

- 2026-10-06 **Optimize console responsiveness under concurrent agent load and a large history** (4545d296, Mosswhistle): pushed to master and live build verified; desktop/phone 1,400-task lab holds the open transcript at zero renders over 480 background events, closed history pages 30 entries, compact Git reads share resolution and defer drawers, and the tool-message partial index preserves rows while reducing snapshot reads from 192 to 51 ms. Live bundle matches, 15 cards render and five cameras keep recording in the same worker. Broad sweep failures and throttled startup follow-ups remain under Ready / Blocked.

- 2026-10-06 **Identify triggering cameras in Surveillance alerts and recent motion history** (Bramble Lens): motion browser 47/47, viewer 28/28, types/build/README/privacy pass; live bundle matches and camera name, settings shortcut and phone history verified. Module legacy recording restart failures tracked under Ready.

- 2026-10-06 **Add per-camera motion sensitivity to reduce false Surveillance notifications** (2d48cc69, Fernspindle): pushed to master and live build verified; live selector and current worker config confirmed with camera settings and recording mode preserved. Motion browser 38/38, modules 37 plus follow-ups, detector regressions, types/builds/README/privacy pass.

- 2026-10-06 **Move director actions beside For / With and hide them while expanded** (dc695797, Bramble Pixel): live browser sees all four controls above the message field and served bundle bytes match; desktop lab 22/22, phone 44/44, types/builds/README/privacy pass.

- 2026-10-06 **Make unread Surveillance alerts throb so they cannot be missed** (Ember Gantry): fill and glow pulse dark to bright red (OKLab, no purple drift), count badge swells; motion browser 32/32 compares trough and peak frames on desktop, 768px and 320px; board-head 54/54, themes, README 70/70, privacy pass.
- 2026-10-06 **Keep ordinary task resumes scoped after server restarts** (Thistlewatt): restart guidance now requires live-build and task-specific verification; full sweeps remain required for health/quality tasks. Doc-path probe and privacy checks pass; documentation only.
