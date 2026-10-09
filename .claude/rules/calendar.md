---
paths:
  - "server/src/calendar/**"
  - "server/src/tests/calendar.test.ts"
  - "server/scripts/calendar-lab.cjs"
  - "server/src/orchestrator/reminderDelivery.ts"
  - "web/src/components/calendar/**"
  - "web/src/lib/calendar*.ts"
---

# The Calendar (the traps, not the tour)

Read before touching `server/src/calendar/`, the `calendar_*` / `schedule_skips` tables, the
`/api/calendar/*` routes or the Calendar board tab. Gate: `npm run test:calendar --prefix server`
(about 90 checks, all synthetic). Browser check: `npm run calendar-lab --prefix server`. It runs in
America/New_York against the box's zone, over New York's DST change. Run it on an isolated build:
`npx tsc -p tsconfig.json --outDir .calendar-lab-dist`, then set `GGO_LAB_ENTRY=.calendar-lab-dist/index.js`.
For concurrent runs, set `GGO_CALENDAR_LAB_PORT` to a free HTTP port and leave that port + 2 free for TLS.

## What lives where

- **Three kinds, one view.** Events are `calendar_events` (+ `calendar_event_exceptions`). Reminders are
  scheduler rows with an empty prompt. Scheduled tasks are scheduler rows with a prompt. The calendar
  adds no second scheduler: it **projects** schedules as occurrences (`scheduleOccurrences.ts`, via
  `cron.forEachRun`, slot for slot with `nextRun`) and never creates a job by being looked at. A day
  with more than 12 runs collapses into one item (`DENSE_PER_DAY`). Both step LOCAL minutes, which at
  fall-back jump back to the repeated hour's first instance; each therefore checks its lower bound
  (`nextRun` once answered a past instant there, which made the scheduler fire twice).
- **A plain event sends nothing and starts nothing.** Only an event with `reminders` produces output:
  `CalendarService.tick` (every 30s) derives due reminders from the events themselves and sends them
  through `deliverReminder`. That is the same path as scheduler reminders: a Discord DM, retries,
  and the note list as fallback.
- **Several reminders per event, plus the owner's defaults.** `calendar_events.reminders` is a JSON
  list (≤ `MAX_REMINDERS` = 5, deduped, longest lead first; NULL = none). The column was `reminder`
  (one object) before 2026-10-04: `db.ts` renames it on boot and `parseReminders` still reads an old
  single object as a list of one. The defaults are kv `calendar.default_reminders`
  (`{reminderLeads: minutes[], allDayTime: "HH:MM"}`; code default: none) and travel in
  `range.defaults`. A **create** that omits `reminders` gets them server-side; an explicit `[]` means
  none; edits never re-apply them, and changing the defaults never touches existing events. An all-day
  event gets each lead as whole days before (floored, capped at 28) at `allDayTime`. The web mirrors
  this in `calendarEdit.defaultReminders`; keep the two in step.
- **No stale notifications, by construction.** Nothing is queued per event. A reminder is "sent" only
  when `calendar_reminder_log` claims `(event_id, occurrence, remind_at)`. Moving or deleting an event
  changes what the tick derives, so the old instant is never due. A moved event whose reminder time
  changed is reminded again at its new time, which is intended. A series split re-keys the old
  series' claims onto the new series (`moveReminderLog`), so a split does not resend reminders
  already sent. Don't add a "pending reminders" table: it is exactly what would go stale.
- **Retries re-read.** A failed DM is retried in-process (`REMINDER_RETRY_MS`). Before each retry
  `deliverReminder` calls the caller's `current()`: `CalendarService.stillDue` returns null once the
  event, the occurrence or its reminder instant is gone, else the current title/text. The scheduler's
  `remind` does the same from the schedule row. The note-list fallback posted on the first failure stays.
- **What went off is listed, not queued.** Every real reminder delivery (event or schedule; never the
  "Send test reminder") writes one `fired_reminders` row via `ReminderChannel.fired`
  (`calendar/firedReminders.ts`), and `deliverReminder` updates its `delivery`
  (sending/sent/retrying/failed/withdrawn/interrupted) as the DM goes. Startup reconciles interrupted
  sends and retries without resending: Discord delivery is unconfirmed, and Notes preserves the reminder.
  Unseen rows are the Calendar tab's number;
  the Calendar's "Went off" panel lists them (auto-opens when the number rises) and "Show" jumps to the
  occurrence and marks it seen. The socket carries only `reminders.fired {unseen}`; titles/text come
  from `GET /api/calendar/fired`, acknowledged through `POST /api/calendar/fired/seen` (`{ids?}`, none
  = all). It is history of what already fired (kept 90 days / 200 rows), so it is not the "pending
  reminders table" warned against above: a deleted event's fired row stays.
- **"I got no reminder DM" triage:** the DM goes out only when `supervisorDiscordReady()` holds:
  `kv` rows `setting_discord_notify = '1'`, `discord_bot_token`, and `setting_discord_user_id` or
  `setting_discord_channel_id` (the settings table is `kv`, not `settings`). Then read that reminder's
  `delivery`/`deliveryNote` from `GET /api/calendar/fired`. For a live proof, create an event a few
  minutes out with a `before` reminder, poll that route until `delivery` leaves `sending`, then delete
  the event and mark the row seen. That sends a real DM.
- **All-day fired dates stay civil.** `fired_reminders.starts_on` snapshots the effective all-day
  start date, including moved exceptions. The panel and Show use it before `starts_at`; converting
  midnight to the browser zone can otherwise move the event to the previous day. Legacy null dates
  may be backfilled only from an exact occurrence/start instant saved no later than the fire.
- **Claims outlive the event.** `calendar_reminder_log` is pruned at 400 days, not sooner: an all-day
  event up to a year long stays remindable for its whole span, and a pruned claim would send again.
- **"Saved after it started" is per occurrence.** `reminderDue` suppresses an occurrence the owner
  saved after it had started and passed its reminder time, using `EventInstance.savedAt` =
  max(series `updated_at`, the exception's own `updated_at`). Never bump the series' `updated_at` on
  an occurrence edit: it would swallow every other occurrence's due reminder.
- **Wall clock + zone, never epochs, for events.** `start_at`/`end_at` are `YYYY-MM-DD` (all-day,
  end **inclusive**) or `YYYY-MM-DDTHH:MM` (end **exclusive**), plus an IANA `time_zone`.
  `wallToEpoch` puts a time in the spring-forward gap forward, and takes the FIRST of a repeated
  fall-back time. Store epochs and a weekly 09:00 drifts an hour twice a year.
- **The view zone is the browser's** (`browserTimeZone()`). The server zone is where cron fires.
  Reminder crons are built in the server zone from the instant the owner picked
  (`reminderCron`), and the filter bar says so when the zones differ. Never hardcode a zone.

## Series edits

- An exception is keyed by the **original** occurrence date, even after it is moved. "This and
  following" splits the series: the old one gets `until = date - 1` and the new one starts on the
  date. Cancelled occurrences on or after the split carry over to the new series. One-off edits
  there are superseded by the new series' values. "All events" applies the
  occurrence's *delta* to the series start (`seriesSpanFromOccurrenceEdit`), not the occurrence's
  absolute time.
- The repeat, the reminders and the zone are series-only. The form disables "Only this event" when
  any of them changed. The server refuses them on `scope: "occurrence"` too.
- One run of a schedule: **skip** inserts `schedule_skips(schedule_id, slot_at)`, and the
  scheduler tick consumes the row instead of firing. **Move one run** of a recurring schedule = a
  skip + a run-once copy. **Move every run** rewrites the cron (`shiftCron`). A run-once schedule
  just gets its cron rewritten. Moving a paused run keeps it paused (including the run-once copy).
  Moving "this and following" rotates an inherited weekly rule before normalization, so the old
  weekdays do not survive as extra occurrences. `deleteScheduledTask` drops its skips.

## Privacy (the repo is public)

- Event titles, notes, dates, exceptions and reminder text live **only** in
  `server/data/orchestrator.sqlite` (gitignored). Tests and the lab use synthetic titles only. Never
  add a fixture, screenshot or deliverable built from the live DB.
- The WS event `calendar.changed` carries no content, only a timestamp. Clients refetch
  `/api/calendar/range` over authenticated REST. Routes reject cross-site requests through
  `isCrossSiteRequest` (`server/src/crossSite.ts`). It trusts `Sec-Fetch-Site`, never Origin vs Host:
  the deck's `/orchestrator/` proxy rewrites Host, so that comparison refused every create, edit and
  delete made through it (2026-10-04). Route errors never echo the submitted body (not even an unknown zone name). Activity-log
  lines name an event by id (`Calendar reminder (event ab12cd34)`), never by title, and the scheduler
  names a reminder-only schedule by id too (`Scheduled reminder ab12cd34`). The scheduler's own
  `schedules` WS broadcast still carries reminder titles and text: the console needs them, and the
  socket is owner-authenticated.
