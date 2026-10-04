// Lab for the Calendar board area (`npm run calendar-lab`).
//
// `test:calendar` proves the zone maths, recurrence, scoped edits, reminder claims and the HTTP API; this
// drives what it cannot: every view in a real browser, creating from a date cell, editing one occurrence
// of a series, drag rescheduling on the month grid and the time grid, the type/state/search filters,
// skipping one run of a schedule, the default-reminders dialog prefilling a new event's reminders
// (all-day and timed), persistence across a reload, and an event reminder that comes due
// reaching the owner through the live 30-second tick. The instance has no Discord bot token, so the DM is
// refused and the reminder has to land on the note list. No event or reminder may start a task.
//
// The browser runs in America/New_York while the instance keeps the box's own zone, so the view zone and
// the server zone differ on purpose, and the March 2027 fixture spans New York's DST change (14 March).
// Every title is synthetic. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir, isVoiceBridgeNoise } = require("./lab-harness.cjs");

// Concurrent calendar reviews need separate HTTP/TLS port pairs (TLS is PORT + 2).
const PORT = Number(process.env.GGO_CALENDAR_LAB_PORT ?? 4581);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65533) throw new Error("GGO_CALENDAR_LAB_PORT must be an integer from 1 to 65533.");
const ZONE = "America/New_York";
const check = createChecks();

const TASK_ONCE = "Synthetic deploy check";
const TASK_PAUSED = "Synthetic weekly audit";
const REMINDER_DAILY = "Synthetic water plants";
const LUNCH = "Synthetic team lunch";
const STANDUP = "Synthetic standup";
const PROBE = "Synthetic reminder probe";
const PROBE_NOTES = "Synthetic probe notes 4711";
const NEW_REMINDER = "Synthetic library books";
const DEFAULTED = "Synthetic dentist check";

function readDb(dataDir, sql, ...args) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

async function poll(fn, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const eventRow = (dataDir, title) => readDb(dataDir, "SELECT * FROM calendar_events WHERE title = ?", title)[0] ?? null;
const scheduleRow = (dataDir, title) => readDb(dataDir, "SELECT * FROM scheduled_tasks WHERE title = ?", title)[0] ?? null;
const threadCount = (dataDir) => readDb(dataDir, "SELECT COUNT(*) AS n FROM threads")[0].n;

/** Three schedules the calendar has to show: a run-once task, a paused weekly task, a weekday reminder.
 *  Seeded with no next_run_at, which the scheduler arms on boot. */
function seedSchedules(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO scheduled_tasks (id, title, workspace, prompt, reminder, cron, enabled, run_once, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("lab-task-once", TASK_ONCE, dataDir, "Synthetic prompt that must never run", null, "0 10 9 3 *", 1, 1, now, now);
  insert.run("lab-task-paused", TASK_PAUSED, dataDir, "Synthetic paused prompt", null, "0 7 * * 1", 0, 0, now, now);
  insert.run("lab-reminder-daily", REMINDER_DAILY, "", "", "Synthetic reminder text", "0 8 * * 1-5", 1, 0, now, now);
  db.close();
}

/** Wall-clock date and time in the browser's zone, `minutes` from now. */
function wallIn(minutes) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(Date.now() + minutes * 60_000)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const cell = (page, date) => page.locator(`.cal-day[data-date="${date}"]`);
const item = (scope, title) => scope.locator(`.cal-item:has(.cal-item-title:text-is("${title}"))`);
const modal = (page) => page.locator(".cal-modal");

async function closeModal(page) {
  await page.keyboard.press("Escape");
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
}

async function jump(page, date) {
  await page.fill(".cal-jump", date);
}

async function setView(page, label) {
  await page.click(`.cal-mode:text-is("${label}")`);
}

/** Click a month cell's empty lower edge, below any chips. */
async function clickCellSpace(page, date) {
  const box = await cell(page, date).boundingBox();
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 6);
  await modal(page).waitFor({ timeout: 10000 });
}

async function monthAndNavigation(page, dataDir) {
  const today = wallIn(0).date;
  const todayCell = await page.locator(".cal-day.today").getAttribute("data-date");
  check("month view marks today in the browser's zone", todayCell === today, `${todayCell} vs ${today}`);
  const zone = await page.textContent(".cal-zone");
  check("the zone label names the view zone and the differing server zone", zone.includes(ZONE) && zone.includes("server"), zone);

  const currentMonth = await page.textContent(".cal-title");
  await page.click('button[aria-label="Previous month"]');
  check("Today remains enabled in another month, even when today is in its padding", await page.locator('.cal-nav button:text-is("Today")').isEnabled());
  await page.click('.cal-nav button:text-is("Today")');
  check("Today returns to the current month", await page.textContent(".cal-title") === currentMonth);

  await jump(page, "2027-03-10");
  check("the date jump moves the month", (await page.textContent(".cal-title")).includes("March 2027"));
  await page.click('button[aria-label="Next month"]');
  check("Next moves a month on", (await page.textContent(".cal-title")).includes("April 2027"));
  await page.click('button[aria-label="Previous month"]');

  const onceChip = item(cell(page, "2027-03-09"), TASK_ONCE);
  await onceChip.waitFor({ timeout: 15000 }).catch(() => {});
  check("a run-once scheduled task shows on its date as a task", (await onceChip.count()) === 1 && /k-task/.test(await onceChip.getAttribute("class")));
  const paused = item(cell(page, "2027-03-08"), TASK_PAUSED);
  check("a paused weekly task shows each Monday as paused", (await paused.count()) === 1 && /s-paused/.test(await paused.getAttribute("class")));
  check("…and not on a Tuesday", (await item(cell(page, "2027-03-09"), TASK_PAUSED).count()) === 0);
  const water = item(cell(page, "2027-03-10"), REMINDER_DAILY);
  check("a weekday reminder shows on a Wednesday as a reminder", (await water.count()) === 1 && /k-reminder/.test(await water.getAttribute("class")));
  check("…and not on a Saturday", (await item(cell(page, "2027-03-13"), REMINDER_DAILY).count()) === 0);
  check("looking at schedules created no events", readDb(dataDir, "SELECT COUNT(*) AS n FROM calendar_events")[0].n === 0);
}

async function createLunch(page, dataDir) {
  await clickCellSpace(page, "2027-03-17");
  check("a date click opens the new-event form for that date", (await page.inputValue('input[aria-label="Start date"]')) === "2027-03-17");
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', LUNCH);
  await page.uncheck('.cal-modal label:has-text("All day") input');
  await page.fill('input[aria-label="Start time"]', "12:30");
  check("moving the start keeps the length", (await page.inputValue('input[aria-label="End time"]')) === "13:30");
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  await item(cell(page, "2027-03-17"), LUNCH).waitFor({ timeout: 10000 });
  const row = eventRow(dataDir, LUNCH);
  check(
    "the event is stored as wall-clock time in the browser's zone",
    row?.start_at === "2027-03-17T12:30" && row?.end_at === "2027-03-17T13:30" && row?.time_zone === ZONE && row?.all_day === 0 && row?.reminders === null,
    JSON.stringify(row),
  );
}

async function createStandup(page, dataDir) {
  await clickCellSpace(page, "2027-03-08");
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', STANDUP);
  await page.uncheck('.cal-modal label:has-text("All day") input');
  await page.fill('input[aria-label="End time"]', "09:30");
  await page.selectOption('.cal-modal select[aria-label="Repeat"]', "weekly");
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  const row = await poll(() => eventRow(dataDir, STANDUP));
  const rule = row?.recurrence ? JSON.parse(row.recurrence) : null;
  check("a weekly event stores its rule", rule?.freq === "weekly" && JSON.stringify(rule?.weekdays) === "[1]", row?.recurrence);
  check("the series shows every Monday", (await item(cell(page, "2027-03-22"), STANDUP).count()) === 1 && (await item(cell(page, "2027-03-29"), STANDUP).count()) === 1);
}

async function weekViewAcrossDst(page, shots) {
  await setView(page, "Week");
  await jump(page, "2027-03-08");
  const before = await page.locator(`.cal-tg-col[data-date="2027-03-08"] .cal-block:has-text("${STANDUP}") .cal-item-time`).textContent();
  await jump(page, "2027-03-15");
  const after = await page.locator(`.cal-tg-col[data-date="2027-03-15"] .cal-block:has-text("${STANDUP}") .cal-item-time`).textContent();
  check("a 09:00 series stays at 09:00 across New York's DST change", before === "09:00" && after === "09:00", `${before} / ${after}`);
  const nowLine = await page.locator(".cal-now").count();
  check("no now line on a week without today", nowLine === 0);
  await page.screenshot({ path: path.join(shots, "calendar-week.png") });
}

async function editOneOccurrence(page, dataDir) {
  await page.click(`.cal-tg-col[data-date="2027-03-15"] .cal-block:has-text("${STANDUP}")`);
  await page.click('.cal-modal button:text-is("Edit")');
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', `${STANDUP} (room B)`);
  await page.fill('input[aria-label="Start time"]', "10:00");
  await page.click('.cal-modal button:text-is("Only this event")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  const id = eventRow(dataDir, STANDUP)?.id;
  const exception = await poll(() => readDb(dataDir, "SELECT * FROM calendar_event_exceptions WHERE event_id = ?", id)[0]);
  check(
    "editing one occurrence stores an exception for that date only",
    exception?.occurrence === "2027-03-15" && exception?.title === `${STANDUP} (room B)` && exception?.start_at === "2027-03-15T10:00",
    JSON.stringify(exception),
  );
  const edited = page.locator(`.cal-tg-col[data-date="2027-03-15"] .cal-block:has-text("room B")`);
  await edited.waitFor({ timeout: 10000 });
  check("the edited occurrence moved to 10:00 and is marked edited", (await edited.locator(".cal-item-time").textContent()) === "10:00" && /edited/.test(await edited.getAttribute("class")));
  await jump(page, "2027-03-22");
  const next = await page.locator(`.cal-tg-col[data-date="2027-03-22"] .cal-block:has-text("${STANDUP}")`).textContent();
  check("the next occurrence keeps the series' title", !next.includes("room B"), next);
}

async function dragOnMonth(page, dataDir) {
  await setView(page, "Month");
  await jump(page, "2027-03-17");
  await item(cell(page, "2027-03-17"), LUNCH).dragTo(cell(page, "2027-03-19"), { targetPosition: { x: 30, y: 90 } });
  const row = await poll(() => {
    const r = eventRow(dataDir, LUNCH);
    return r?.start_at === "2027-03-19T12:30" ? r : null;
  });
  check("dragging an event to another day keeps its time", row?.end_at === "2027-03-19T13:30", JSON.stringify(eventRow(dataDir, LUNCH)));

  const before = scheduleRow(dataDir, TASK_ONCE).next_run_at;
  await item(cell(page, "2027-03-09"), TASK_ONCE).dragTo(cell(page, "2027-03-11"), { targetPosition: { x: 30, y: 90 } });
  const after = await poll(() => {
    const s = scheduleRow(dataDir, TASK_ONCE);
    return s.next_run_at !== before ? s : null;
  });
  check("dragging a run-once task moves its run by the same days", after?.next_run_at === before + 2 * 86_400_000 && after?.run_once === 1, JSON.stringify(after));
}

async function dragOnTimeGrid(page, dataDir, shots) {
  await setView(page, "Day");
  await jump(page, "2027-03-19");
  await page.locator(".cal-tg-scroll").evaluate((el) => (el.scrollTop = 12 * 46));
  const block = page.locator(`.cal-block:has-text("${LUNCH}")`);
  const box = await block.boundingBox();
  const column = page.locator('.cal-tg-col[data-date="2027-03-19"]');
  // Grabbed at its vertical centre (30 minutes into the hour block), dropped 15:30 down the column: 15:00.
  await block.dragTo(column, { sourcePosition: { x: 10, y: box.height / 2 }, targetPosition: { x: 40, y: 15.5 * 46 } });
  const row = await poll(() => {
    const r = eventRow(dataDir, LUNCH);
    return r?.start_at === "2027-03-19T15:00" ? r : null;
  });
  check("dragging on the day grid moves the time in 15-minute steps", row?.end_at === "2027-03-19T16:00", JSON.stringify(eventRow(dataDir, LUNCH)));
  await page.screenshot({ path: path.join(shots, "calendar-day.png") });
}

async function filters(page, shots) {
  await setView(page, "Month");
  await jump(page, "2027-03-10");
  const visible = (sel) => page.locator(`.cal-month ${sel}`).count();
  check("all three kinds show by default", (await visible(".cal-item.k-event")) > 0 && (await visible(".cal-item.k-task")) > 0 && (await visible(".cal-item.k-reminder")) > 0);
  await page.click('.cal-kind-toggle:has-text("Events")');
  check("the Events toggle hides events only", (await visible(".cal-item.k-event")) === 0 && (await visible(".cal-item.k-reminder")) > 0);
  await page.click('.cal-kind-toggle:has-text("Events")');
  await page.fill('input[aria-label="Search calendar titles"]', "lunch");
  const titles = await page.locator(".cal-month .cal-item-title").allTextContents();
  check("search keeps only matching titles", titles.length > 0 && titles.every((t) => t === LUNCH), JSON.stringify(titles));
  await page.fill('input[aria-label="Search calendar titles"]', "");
  await page.selectOption('select[aria-label="Filter by state"]', "inactive");
  const states = await page.locator(".cal-month .cal-item").evaluateAll((els) => els.map((e) => e.className));
  check("the state filter keeps only paused and skipped runs", states.length > 0 && states.every((c) => /s-paused|s-skipped/.test(c)), JSON.stringify(states.slice(0, 3)));
  await page.selectOption('select[aria-label="Filter by state"]', "all");
  await page.screenshot({ path: path.join(shots, "calendar-month.png") });
}

async function skipAndRestoreRun(page, dataDir) {
  await item(cell(page, "2027-03-10"), REMINDER_DAILY).click();
  await page.click('.cal-modal button:text-is("Skip this run")');
  const skip = await poll(() => readDb(dataDir, "SELECT * FROM schedule_skips WHERE schedule_id = 'lab-reminder-daily'")[0]);
  check("skipping one run stores a skip for that slot", !!skip, JSON.stringify(skip));
  const fresh = await page.waitForSelector('.cal-modal button:text-is("Restore this run")', { timeout: 10000 }).then(() => true, () => false);
  check("the open details switch to the skipped run at once", fresh);
  await closeModal(page);
  const chip = item(cell(page, "2027-03-10"), REMINDER_DAILY);
  await page.waitForFunction(() => !!document.querySelector('.cal-day[data-date="2027-03-10"] .cal-item.s-skipped'), null, { timeout: 10000 }).catch(() => {});
  check("the skipped run is drawn as skipped", /s-skipped/.test(await chip.getAttribute("class")));
  check("…and the next day's run is untouched", /s-upcoming/.test(await item(cell(page, "2027-03-11"), REMINDER_DAILY).getAttribute("class")));
  await chip.click();
  await page.click('.cal-modal button:text-is("Restore this run")');
  const gone = await poll(() => readDb(dataDir, "SELECT COUNT(*) AS n FROM schedule_skips")[0].n === 0);
  check("restoring the run removes the skip", gone);
  await closeModal(page);
}

async function agendaAndKeyboard(page, shots) {
  await setView(page, "Agenda");
  await jump(page, "2027-03-08");
  const days = await page.locator(".cal-agenda-day").count();
  check("agenda lists the days that have something on them", days > 5, String(days));
  check("agenda rows say what kind each item is", (await page.locator('.cal-agenda-kind:text-is("Event")').count()) > 0);
  await page.screenshot({ path: path.join(shots, "calendar-agenda.png") });

  // Shortcuts are ignored while typing, and the date jump still has focus.
  await page.focus(".cal-mode.on");
  await page.keyboard.press("m");
  await page.waitForSelector(".cal-month", { timeout: 10000 });
  check("the M key switches to month view", (await page.getAttribute('.cal-mode:text-is("Month")', "aria-checked")) === "true");
  await page.focus('.cal-day[data-date="2027-03-08"]');
  await page.keyboard.press("ArrowRight");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-date"));
  check("arrow keys move focus across days", focused === "2027-03-09", focused);
  await page.keyboard.press("Enter");
  await modal(page).waitFor({ timeout: 10000 });
  check("Enter on a day opens the new form for it", (await page.inputValue('input[aria-label="Start date"]')) === "2027-03-09");
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', "Synthetic keyboard draft");
  await page.focus('.cal-modal button:text-is("Create event")');
  await page.keyboard.press("Tab");
  check("Tab from the last modal control wraps to Close", await page.locator('.cal-modal button[aria-label="Close"]').evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Shift+Tab");
  check("Shift+Tab from Close wraps to the last modal control", await page.locator('.cal-modal button:text-is("Create event")').evaluate((el) => el === document.activeElement));
  await closeModal(page);
}

async function recurrenceRegressions(page, dataDir) {
  await setView(page, "Month");
  await jump(page, "2027-03-14");
  await clickCellSpace(page, "2027-03-14");
  const title = "Synthetic DST crossing";
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', title);
  await page.uncheck('.cal-modal label:has-text("All day") input');
  await page.fill('input[aria-label="Start time"]', "01:30");
  await page.fill('input[aria-label="End time"]', "03:30");
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached" });
  await item(cell(page, "2027-03-14"), title).click();
  check("the DST-crossing event details keep the entered end time", (await page.textContent('.cal-details-list')).includes("01:30 – 03:30"));
  await closeModal(page);

  await jump(page, "2027-04-05");
  await clickCellSpace(page, "2027-04-05");
  const repeating = "Synthetic shifted weekly lesson";
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', repeating);
  await page.selectOption('.cal-modal select[aria-label="Repeat"]', "weekly");
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached" });
  await item(cell(page, "2027-04-12"), repeating).click();
  await page.click('.cal-modal button:text-is("Edit")');
  await page.fill('input[aria-label="Start date"]', "2027-04-13");
  await page.click('.cal-modal button:text-is("This and following")');
  await modal(page).waitFor({ state: "detached" });
  await item(cell(page, "2027-04-13"), repeating).waitFor();
  check("moving following in the form shifts the weekly rule", readDb(dataDir, "SELECT recurrence FROM calendar_events WHERE title = ? AND start_at = '2027-04-13'", repeating).some((r) => JSON.stringify(JSON.parse(r.recurrence).weekdays) === "[2]"));
  check("the moved series shows only on the new weekday", await item(cell(page, "2027-04-20"), repeating).count() === 1 && await item(cell(page, "2027-04-19"), repeating).count() === 0);
  await jump(page, "2027-03-19");
}

async function deletes(page, dataDir) {
  await jump(page, "2027-03-19");
  await item(cell(page, "2027-03-19"), LUNCH).click();
  await page.click('.cal-modal button:text-is("Delete…")');
  await page.click('.cal-modal .cal-confirm button:text-is("Delete")');
  check("deleting an event removes the row", !!(await poll(() => eventRow(dataDir, LUNCH) === null)));
  await item(cell(page, "2027-03-19"), LUNCH).waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  check("…and its chip", (await item(cell(page, "2027-03-19"), LUNCH).count()) === 0);

  await item(cell(page, "2027-03-22"), STANDUP).click();
  await page.click('.cal-modal button:text-is("Delete…")');
  await page.click('.cal-modal .cal-confirm button:text-is("This and following")');
  const rule = await poll(() => {
    const r = eventRow(dataDir, STANDUP);
    const parsed = r?.recurrence ? JSON.parse(r.recurrence) : null;
    return parsed?.until ? parsed : null;
  });
  check("deleting this and following ends the series the day before", rule?.until === "2027-03-21", JSON.stringify(rule));
  await page.waitForFunction(() => !document.querySelector('.cal-day[data-date="2027-03-29"] .cal-item'), null, { timeout: 10000 }).catch(() => {});
  check("…so later Mondays are clear", (await item(cell(page, "2027-03-29"), STANDUP).count()) === 0);
  check("…and the earlier edited occurrence is kept", (await cell(page, "2027-03-15").locator('.cal-item:has-text("room B")').count()) === 1);
}

async function reminderDelivery(page, dataDir) {
  await page.click('.cal-nav button:text-is("Today")');
  await page.click(".cal-new");
  await modal(page).waitFor({ timeout: 10000 });
  const start = wallIn(10);
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', PROBE);
  if (await page.isChecked('.cal-modal label:has-text("All day") input')) await page.uncheck('.cal-modal label:has-text("All day") input');
  await page.fill('input[aria-label="Start date"]', start.date);
  await page.fill('input[aria-label="Start time"]', start.time);
  check("with no defaults a new event starts without reminders", (await page.locator('.cal-modal select[aria-label^="Reminder "]').count()) === 0);
  await page.click('.cal-modal button:has-text("Add reminder")');
  await page.selectOption('.cal-modal select[aria-label="Reminder 1"]', "b:15");
  await page.fill(".cal-modal textarea", PROBE_NOTES);
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  const event = await poll(() => eventRow(dataDir, PROBE));
  check("the probe event saved with a 15-minute reminder", event && JSON.stringify(JSON.parse(event.reminders)) === '[{"kind":"before","minutes":15}]', JSON.stringify(event));

  // Due five minutes ago, the event still ahead: the next tick (every 30s) must send it once.
  const notes = () => readDb(dataDir, "SELECT body, thread_title FROM operator_notes").filter((n) => n.body.includes(PROBE_NOTES));
  const first = await poll(() => (notes().length ? notes() : null), 45000);
  check("a due event reminder reaches the note list when Discord refuses it", first?.length === 1, JSON.stringify(first));
  check("…naming the event", !!first?.[0]?.body.includes(PROBE), JSON.stringify(first));
  const claims = readDb(dataDir, "SELECT COUNT(*) AS n FROM calendar_reminder_log WHERE event_id = ?", event.id)[0].n;
  check("…and the occurrence is claimed so it is never sent twice", claims === 1, String(claims));
  await new Promise((r) => setTimeout(r, 35000));
  check("a later tick does not send it again", notes().length === 1, String(notes().length));
}

async function createReminderSchedule(page, dataDir) {
  const tomorrow = wallIn(24 * 60).date;
  await page.click(".cal-new");
  await modal(page).waitFor({ timeout: 10000 });
  await page.click('.cal-tab:has-text("Reminder")');
  await page.fill('.cal-modal input[placeholder="e.g. Renew passport"]', NEW_REMINDER);
  await page.fill(".cal-modal textarea", "Synthetic: return the books");
  await page.fill('input[aria-label="Reminder date"]', tomorrow);
  await page.fill('input[aria-label="Reminder time"]', "10:00");
  await page.click('.cal-modal button:text-is("Create reminder")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  const row = await poll(() => scheduleRow(dataDir, NEW_REMINDER));
  check("the Reminder tab makes a reminder-only schedule", row?.prompt === "" && row?.workspace === "" && row?.run_once === 1 && row?.enabled === 1, JSON.stringify(row));
  const at = new Date(row?.next_run_at ?? 0);
  const wall = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  check("…firing at 10:00 in the browser's zone", wall === "10:00", wall);
  await setView(page, "Month");
  await jump(page, tomorrow);
  await item(cell(page, tomorrow), NEW_REMINDER).waitFor({ timeout: 10000 });
  check("…and it shows on the calendar as a reminder", /k-reminder/.test(await item(cell(page, tomorrow), NEW_REMINDER).getAttribute("class")));
}

async function defaultReminders(page, dataDir, shots) {
  await page.click('.cal-toolbar button:has-text("Default reminders")');
  await modal(page).waitFor({ timeout: 10000 });
  await page.click('.cal-modal button:has-text("Add reminder")');
  await page.click('.cal-modal button:has-text("Add reminder")');
  const lead = async (n) => [await page.inputValue(`input[aria-label="Default reminder ${n}"]`), await page.inputValue(`select[aria-label="Default reminder ${n} unit"]`)];
  check("the defaults form suggests a week, then a day", JSON.stringify([await lead(1), await lead(2)]) === '[["1","10080"],["1","1440"]]', JSON.stringify([await lead(1), await lead(2)]));
  await page.screenshot({ path: path.join(shots, "calendar-default-reminders.png") });
  await page.click('.cal-modal button:text-is("Save defaults")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  const stored = await poll(() => readDb(dataDir, "SELECT value FROM kv WHERE key = 'calendar.default_reminders'")[0]?.value);
  check("the defaults are stored", stored === '{"reminderLeads":[10080,1440],"allDayTime":"09:00"}', stored);

  await setView(page, "Month");
  await jump(page, "2027-03-25");
  await page.waitForSelector('.cal-day[data-date="2027-03-25"]', { timeout: 10000 });
  await clickCellSpace(page, "2027-03-25");
  const chosen = async () => [await page.inputValue('.cal-modal select[aria-label="Reminder 1"]'), await page.inputValue('.cal-modal select[aria-label="Reminder 2"]')];
  check("a new all-day event starts with the defaults as days before", JSON.stringify(await chosen()) === '["d:7:09:00","d:1:09:00"]', JSON.stringify(await chosen()));
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', DEFAULTED);
  await page.uncheck('.cal-modal label:has-text("All day") input');
  check("…and as a week and a day before once it has a time", JSON.stringify(await chosen()) === '["b:10080","b:1440"]', JSON.stringify(await chosen()));
  await page.screenshot({ path: path.join(shots, "calendar-event-reminders.png") });
  await page.click('.cal-modal button[aria-label="Remove reminder 2"]');
  check("removing a reminder leaves the other", (await page.locator('.cal-modal select[aria-label^="Reminder "]').count()) === 1);
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached", timeout: 10000 });
  const row = await poll(() => eventRow(dataDir, DEFAULTED));
  check("the event saves the reminders the form showed", row?.reminders === '[{"kind":"before","minutes":10080}]', JSON.stringify(row));
  await item(cell(page, "2027-03-25"), DEFAULTED).click();
  await modal(page).waitFor({ timeout: 10000 });
  const shown = await modal(page).textContent();
  check("the details list the reminder", shown.includes("1 week before"), shown);
  await closeModal(page);
}

async function persistence(page) {
  await page.click('.cal-kind-toggle:has-text("Scheduled tasks")');
  await setView(page, "Week");
  await page.reload({ timeout: 45000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
  await page.click(".board-tab.bt-calendar");
  await page.waitForSelector(".cal-timegrid", { timeout: 15000 });
  check("the chosen view survives a reload", (await page.getAttribute('.cal-mode:text-is("Week")', "aria-checked")) === "true");
  check("the type filter survives a reload", (await page.getAttribute('.cal-kind-toggle:has-text("Scheduled tasks")', "aria-pressed")) === "false");
  await page.click('.cal-kind-toggle:has-text("Scheduled tasks")');
  await jump(page, "2027-03-15");
  const exception = await page.locator('.cal-tg-col[data-date="2027-03-15"] .cal-block:has-text("room B")').waitFor({ timeout: 10000 }).then(() => true, () => false);
  await jump(page, "2027-03-08");
  const series = await page.locator(`.cal-tg-col[data-date="2027-03-08"] .cal-block:has-text("${STANDUP}")`).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("events and their exceptions survive a reload", exception && series);
}

async function narrowLayout(browser, cookies, shots) {
  const ctx = await browser.newContext({ viewport: { width: 700, height: 900 }, timezoneId: ZONE, locale: "en-GB" });
  try {
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await page.selectOption('select[aria-label="Board area"]', "calendar").catch(() => page.click(".board-tab.bt-calendar"));
    await page.waitForSelector(".cal-view", { timeout: 15000 });
    await page.click('.cal-mode:text-is("Month")');
    await page.fill(".cal-jump", "2027-03-10");
    await page.waitForSelector(".cal-month .cal-item", { timeout: 10000 });
    const overflow = await page.evaluate(() => {
      const view = document.querySelector(".cal-view");
      return view.scrollWidth - view.clientWidth;
    });
    check("the month view fits a narrow board without sideways scrolling", overflow <= 1, String(overflow));
    await page.screenshot({ path: path.join(shots, "calendar-narrow.png") });
  } finally {
    await ctx.close();
  }
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-lab-"));
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT });
  child.kill();
  killInstance(PORT);
  await new Promise((r) => setTimeout(r, 1500));
  seedSchedules(dataDir);
  child = await boot({ dataDir, port: PORT });
  let code = 1;
  let browser;
  try {
    const shots = shotDir(dataDir);
    const chromium = loadChromium();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, timezoneId: ZONE, locale: "en-GB" });
    const page = await ctx.newPage();
    // Hold the first range: creation must wait for saved defaults and the server's zone.
    let releaseRange;
    let rangeRequested;
    const heldRange = new Promise((resolve) => { releaseRange = resolve; });
    const initialRequest = new Promise((resolve) => { rangeRequested = resolve; });
    let firstRange = true;
    await page.route(/\/api\/calendar\/range\?/, async (route) => {
      if (!firstRange) return route.continue();
      firstRange = false;
      rangeRequested();
      await heldRange;
      const response = await route.fetch();
      const body = await response.json();
      body.defaults = { reminderLeads: [10080, 1440], allDayTime: "09:00" };
      await route.fulfill({ response, json: body });
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !isVoiceBridgeNoise(m) && errors.push(m.text()));
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    const unauth = await fetch(`http://127.0.0.1:${PORT}/api/calendar/range?from=2027-03-01&to=2027-03-31&tz=UTC`);
    check("the calendar API refuses a request without a session", unauth.status === 401, String(unauth.status));
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await page.click(".board-tab.bt-calendar");
    await page.waitForSelector(".cal-month", { timeout: 15000 });
    await page.waitForSelector(".cal-day.today", { timeout: 15000 });
    await initialRequest;
    check("New waits for saved defaults on the first load", await page.locator(".cal-new").isDisabled());
    check("default settings cannot overwrite unloaded settings", await page.locator('.cal-toolbar button:has-text("Default reminders")').isDisabled());
    await page.locator(".cal-view").dispatchEvent("keydown", { key: "n", bubbles: true });
    check("the new-item shortcut also waits for the first range", await modal(page).count() === 0);
    check("date cells wait for the first range", await page.locator(".cal-body").evaluate((el) => el.inert));
    releaseRange();
    await page.waitForFunction(() => !document.querySelector(".cal-new").disabled);
    await page.click(".cal-new");
    check("the first create form receives the loaded reminder defaults", JSON.stringify(await page.locator('.cal-modal select[aria-label^="Reminder "]').evaluateAll((es) => es.map((e) => e.value))) === '["d:7:09:00","d:1:09:00"]');
    await closeModal(page);

    await monthAndNavigation(page, dataDir);
    await createLunch(page, dataDir);
    await createStandup(page, dataDir);
    await weekViewAcrossDst(page, shots);
    await editOneOccurrence(page, dataDir);
    await dragOnMonth(page, dataDir);
    await dragOnTimeGrid(page, dataDir, shots);
    await filters(page, shots);
    await skipAndRestoreRun(page, dataDir);
    await agendaAndKeyboard(page, shots);
    await recurrenceRegressions(page, dataDir);
    await deletes(page, dataDir);
    await reminderDelivery(page, dataDir);
    await createReminderSchedule(page, dataDir);
    await defaultReminders(page, dataDir, shots);
    await persistence(page);

    check("no event or reminder started a task", threadCount(dataDir) === 0, String(threadCount(dataDir)));
    check("the page logged no errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    const cookies = await ctx.cookies();
    await ctx.close();
    await narrowLayout(browser, cookies, shots);
    code = check.summary();
  } catch (e) {
    console.error(e);
    check.summary();
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    killInstance(PORT);
    if (!process.argv.includes("--keep")) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    } else console.log(`kept ${dataDir}`);
  }
  process.exit(code);
})();
