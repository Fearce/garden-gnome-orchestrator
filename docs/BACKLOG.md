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

_(none: claim from Ready)_

## Shipped, awaiting live proof

- **Move director action buttons beside For / With and hide them when expanded** (2026-10-06, Bramble Pixel).
  Browser placement/disclosure/editor 22/22; phone 44/44, all typechecks, server/web builds, README 70/70 and privacy pass; live web rebuild pending.

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

1. **Resolve high-severity production dependency advisories** (2026-10-05, Codex implementor): restart sweep audit:deps reports critical=0, high=5, moderate=12, low=3; dependency names and compatible fixed versions are in server/data/quality-sweep-last.log.
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

## Blocked / waiting

- **Purge cached private-project reference from PR #10** (owner action: include old PR body in the GitHub Support request).
  QA redacted the live body and verified https://github.com/Fearce/garden-gnome-orchestrator/pull/10; legitimate contributor attribution remains intact.

- **Rewrite published history to remove personal details the tree no longer carries** (owner action: filter-repo + force-push master, delete five stale remote branches, GitHub Support for PR refs/caches, coordinate the published fork rewrite).
  Corrected kit (surfaced as a deliverable) in the main checkout's gitignored `_privacy-remediation` folder: fresh public mirror dry-run 2026-10-04 reduced 2,751 matches (including exposed PFX passphrase) to 0; public fork still has 211 matches; nothing force-pushed.
- **Rotate the local HTTPS PFX passphrase** (owner action): it is a weak dictionary word, and `npm run audit:secrets --prefix server` finds that word in four reachable published commits (value withheld), so treat it as exposed: set a random passphrase, re-encrypt the PFX and update `server/.env`.

## Open

No open entries.

## Done (newest first; keep the last 20)

- 2026-10-06 **Make unread Surveillance alerts throb so they cannot be missed** (Ember Gantry): fill and glow pulse dark to bright red (OKLab, no purple drift), count badge swells; motion browser 32/32 compares trough and peak frames on desktop, 768px and 320px; board-head 54/54, themes, README 70/70, privacy pass.
- 2026-10-06 **Keep ordinary task resumes scoped after server restarts** (Thistlewatt): restart guidance now requires live-build and task-specific verification; full sweeps remain required for health/quality tasks. Doc-path probe and privacy checks pass; documentation only.

- 2026-10-06 **Per-camera Surveillance motion notifications, ping and unread tab count** (74f6de90, Moss Lantern): pushed and live controls/current worker verified with recording preserved; motion browser 14/14, viewer 28/28, types/build/privacy/README pass. Module suite retains tracked Home idle-start failure.
- 2026-10-06 **Restore ended-day patch-note summaries across page boundaries** (b0910387, Thistlewatt): live browser shows Sunday October 4 summary covering all 58 operator-facing changes automatically; deployed bundle bytes match. Patch-note lab 31/31, patch-note gate, types, builds, README 70/70 and privacy pass.

- 2026-10-05 **Re-orderable board tabs: drag in the header, move in Settings** (Tabwhittle): board-head-lab 45/45 (drag Surveillance to #2, reload, Settings move/reset, narrow select), live console check on :4317, gates 230/230.
- 2026-10-05 **QA: bound Surveillance pan to the fitted camera picture** (Codex QA): 28/28 browser checks keep the real picture in bounds at both pan extremes, after rotation, new frame dimensions and zoom-out; web types/build, module regressions, README and privacy pass. Independent QA required.

- 2026-10-05 **Open Surveillance camera pictures fullscreen with digital pan and zoom** (Mosswick): 20/20 isolated browser checks cover native fullscreen, phone fallback, wheel/pinch/keyboard zoom, drag pan, reset, focus and continuing frames on one socket; types, module gate, README 70/70 and privacy pass. Web built for deployment; authenticated live entry serves the exact updated Surveillance bundle.

- 2026-10-05 **Show office chat gnome counts, names and activity indicators** (16abc9bf; Widdershank Pebbletail): live Hide/Show roster keeps the count visible and remembers the browser choice. Desktop/320px browser checks prove reclaimed chatter space, reopen/reload persistence, task navigation and live updates; gating 57/57 plus roster regressions, types/build, README 70/70 and privacy pass. Original office/relay lab 53/53.

- 2026-10-05 **A Codex QA verdict quoting `DELIVERABLE:` no longer parks the task as "QA could not complete"** (dfe93a08, Lanternroot): live build 68588b8c carries the `"`-in-path refusal (`server/dist/agents/officeBridge.js`); `test:office-bridge` replays the verdict that broke task 6b9aab39 and parses it. Full gates 230/230.
- 2026-10-05 **Recheck Windows process-enumeration timeout under gate load** (Lanternroot): a tasklist overrun with no earlier list no longer 503s Sidekick's whole state; liveness reads unknown (`processListError`, power disabled) while rules and the editor keep working. Unit check of the unreadable list, `test:modules` 35/35, browser check 8/8 on the live tab.
- 2026-10-05 **Replace Ollama memory with Haiku and Luna and build RAG memory into GGO** (..2cbe8718, Lanternroot; QA fixes 2e01c75f, acd38bfe, ebb90b79, 2cbe8718; claude-setup b867df3, cd7f875): live build 2cbe8718 (`--verify` matches HEAD); live Settings shows 1319 memories, 8743 passages, every card current, extraction idle, and a Haiku recall in 1.0 s. All 1310 pre-task memories present (0 missing); 29 bad auto-extractions trashed after source fixes. Eval R@1/R@2/MRR 0.894/0.925/0.909 (pgvector 0.519/0.644/0.630), off-topic 1/25, trigger audit 530/530. Evidence report, live screenshots and the 10 raw eval files are deliverable cards on the task. Ollama STAYS_DOWN.
- 2026-10-05 **Show ChatGPT credits in the Codex chip when the plan has no 5-hour window** (2f5d8db1, b57220c9, Codex implementor): pushed and live build verified without another restart; authenticated browser confirms the credit row and retained weekly meter. Credit reader 34/34, four-width chip lab, synthetic balance rerun, README 69/69, typechecks and privacy pass; README updated and public fixtures use synthetic balances. The restart sweep's process-enumeration timeout is tracked under Ready. Follow-up: chip-lab now asserts the balance, label and replacement of 5h while preserving weekly usage; browser pass and four mutation rejections verified.
- 2026-10-05 **Show and edit vacuum cleaning schedules in Home** (1ee269ff, Dustpan Wren): pushed to master; live Home API adopts the existing 09:00–22:00/99% pair, desktop editor and phone card pass with automation/Home/recording files unchanged. Module gate, 12 schedule regressions, 10 browser checks, types/builds, README and privacy pass; custom automation fields and occupied ids are preserved.

- 2026-10-05 **QA: report stalled Script Hub bodies as unavailable-service timeouts** (332a87c4, Codex QA): pushed and live build verified; 35 module checks plus Home response/visibility checks, 229/229 gates, builds/types/privacy and 70/70 browser checks pass. Stalls return 504 and interrupted bodies 503 with hubDown; cancellation and recovery remain correct. Lab HTTP/WS/owner-message p95 idle-to-load: 5.3/6.6/53.2 to 3.4/3.2/67.9 ms, zero stalls. Independent review required.
- 2026-10-05 **Owner report: cameras stuck on "Waiting for a picture..." and Home Assistant not answering** (Ferrule Juniper): live build 38078a69 showed 5/5 pictures on direct HTTP/HTTPS, the Deck proxy and LAN HTTPS; a foreign-Origin handshake through the Deck upgraded and streamed while a cross-site one got 403. The stopped `homeassistant_xiaomi` container was started from the Home tab's own Start (answered in 20s, vacuum live) and its restart policy, drifted to `no`, was restored to the compose file's `unless-stopped`.
- 2026-10-05 **QA: wait for Home's page-wide probe before checking outage controls** (Codex QA): modules-lab 74/74, live direct/proxy desktop/phone 24/24, three authenticated report downloads, preserved configs and recording; types, isolated builds, privacy and README pass. Full gates 228/229; dispatch-latency passed two focused reruns, with its load-sensitive assertion tracked under Ready.
- 2026-10-04 **Independent module deployment QA** (a6eba134, 38078a69; Codex QA): 74/74 isolated and 13/13 live proxy/browser checks, preserved local configurations and recording, authenticated report downloads; all 229 gates covered green after the Calendar task's 28a0706f repair. Includes the Deck-proxy camera socket and explicit Home Assistant Start (d8481ca2), serialized Sidekick rule saves (e9ce82a3) and explicit Stop that holds with the tab open (58e13ef5), all live in 38078a69. Evidence: docs/reports/local-service-modules-independent-qa-2026-10-04.md.
- 2026-10-04 **Auto-burn subscriptions within 24 hours of weekly reset** (1a3e8dba, Moss Spark): pushed to master and live build verified; authenticated live hello reports autoBurn=false and the served entry matches dist with the new control. Browser lab 21/21; routing/Codex/boundary regression, burn/model/goal/Director gates, typechecks/build, README and privacy checks pass.

- 2026-10-04 **Optional Electron desktop app with Open in desktop / Open in web handoff** (8521a443..c2283ee4, Quillhatch): server live as 5712fdf2; the packaged Windows app reached the live server's sign-in in 928 ms with the bridge and no Node in the renderer; desktop lab 51/51; live load probe under 7 implementing agents moved no HTTP/WS percentile (/api/me p95 6.0 to 6.5 ms, WS ping p95 1.4 to 2.6 ms); live web portal check passed.
- 2026-10-04 **QA: Surveillance 24/7 and scheduled recording (off by default), recording options, recordings browser, hub-less start** (07ebac86..24dfe20f, Ferrule Juniper): live build 24dfe20f carried the owner's running 5-camera recording over as 24/7. 14/14 live desktop and phone checks covered the mode shown, the options dialog, a real segment played in 113ms, a 206 MP4 download, a traversal refused with 400, and the recording left untouched. Isolated lab 58/58; 228/228 gates; module gate 32 checks, including the legacy-recording carry-over.
