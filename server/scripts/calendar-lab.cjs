// Lab for the Calendar board area (`npm run calendar-lab`).
//
// `test:calendar` proves the zone maths, recurrence, scoped edits, reminder claims and the HTTP API; this
// drives what it cannot: every view in a real browser, creating from a date cell, editing one occurrence
// of a series, drag rescheduling on the month grid and the time grid, the type/state/search filters,
// skipping one run of a schedule, the default-reminders dialog prefilling a new event's reminders
// (all-day and timed), persistence across a reload, and an event reminder that comes due
// reaching the owner through the live 30-second tick. The instance has no Discord bot token, so the DM is
// refused and the reminder has to land on the note list. That reminder then raises the Calendar tab's
// number, and the tab's list has to show which reminder it was. No event or reminder may start a task.
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
  const target = cell(page, date);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  // Locator clicks scroll and wait until the loading/inert calendar accepts input. An open reminder
  // panel can put a lower week below the viewport; a raw mouse coordinate would miss that cell.
  await target.click({ position: { x: box.width - 8, y: box.height - 6 } });
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

async function startOnlyEvent(page, dataDir) {
  const title = "Synthetic start-only concert";
  await setView(page, "Month");
  await jump(page, "2027-03-10");
  await clickCellSpace(page, "2027-03-22");
  await page.fill('.cal-modal input[placeholder="e.g. Dentist"]', title);
  await page.uncheck('.cal-modal label:has-text("All day") input');
  await page.fill('input[aria-label="Start time"]', "18:30");
  await page.uncheck('.cal-modal label:has-text("End time known") input');
  check("an unspecified end hides the end fields", await page.locator('input[aria-label="End time"]').count() === 0);
  await page.click('.cal-modal button:text-is("Create event")');
  await modal(page).waitFor({ state: "detached" });
  const saved = await poll(() => eventRow(dataDir, title));
  check("the form saves a start-only event without a duration", saved?.start_at === "2027-03-22T18:30" && saved?.end_at === saved?.start_at);
  await item(cell(page, "2027-03-22"), title).click();
  check("the details say the end is unspecified", (await modal(page).textContent()).includes("Not specified"));
  await page.click('.cal-modal button:text-is("Edit")');
  check("editing keeps the end unspecified", !(await page.isChecked('.cal-modal label:has-text("End time known") input')));
  await page.fill('input[aria-label="Start time"]', "19:00");
  await page.click('.cal-modal button:text-is("Save changes")');
  await modal(page).waitFor({ state: "detached" });
  const moved = eventRow(dataDir, title);
  check("editing the start does not invent an end", moved?.start_at === "2027-03-22T19:00" && moved?.end_at === moved?.start_at);
  await page.reload();
  await page.waitForSelector(".accounts .acct", { state: "attached" });
  await page.click(".board-tab.bt-calendar");
  await jump(page, "2027-03-22");
  await item(cell(page, "2027-03-22"), title).click();
  check("the unspecified end survives a browser reload", (await modal(page).textContent()).includes("Not specified"));
  await closeModal(page);
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

/** The reminder that just went off: the Calendar tab counts it, and opening the tab shows which reminder
 *  raised the number, what it said and that Discord refused it, with a way to jump to the event. */
async function firedReminderCount(page, shots) {
  const panel = page.locator(".cal-fired");
  const row = panel.locator(`.cal-fired-row.new:has(.cal-fired-name:text-is("${PROBE}"))`);
  await row.waitFor({ timeout: 10000 });
  check("a reminder going off opens the list of reminders that went off", await panel.isVisible());
  await page.click(".board-tab.bt-tasks");
  const count = page.locator(".board-tab.bt-calendar .board-tab-count");
  await count.waitFor({ timeout: 10000 });
  check("the Calendar tab shows a number for it", (await count.textContent()) === "1", await count.textContent());
  await page.click(".board-tab.bt-calendar");
  await row.waitFor({ timeout: 10000 });
  check("opening the tab shows the reminder that raised the number", await row.locator(".cal-fired-new").isVisible());
  check("…with its text", (await row.locator(".cal-fired-text").textContent()).includes(PROBE_NOTES));
  check("…and that Discord did not get it", /on Notes/.test(await row.locator(".cal-fired-delivery").textContent()), await row.locator(".cal-fired-delivery").textContent());
  await page.screenshot({ path: path.join(shots, "calendar-fired.png") });
  await row.locator('button:text-is("Show")').click();
  await modal(page).waitFor({ timeout: 10000 });
  check("Show opens the event the reminder was about", (await modal(page).locator(".cal-details-title").textContent()) === PROBE);
  await closeModal(page);
  await page.locator(".cal-fired-toggle .board-tab-count").waitFor({ state: "detached", timeout: 10000 });
  check("showing it marks it seen, so the tab's number goes", (await page.locator(".board-tab.bt-calendar .board-tab-count").count()) === 0);
  // The socket's count can clear the badge a moment before the acknowledgement reply restyles the row.
  const seenRow = panel.locator(`.cal-fired-row:not(.new):has(.cal-fired-name:text-is("${PROBE}"))`);
  await seenRow.waitFor({ timeout: 5000 }).catch(() => {});
  check("…and it stays listed, no longer new", (await seenRow.count()) === 1);
  await panel.locator('button[aria-label="Hide reminders that went off"]').click();
  check("the list can be hidden", (await panel.count()) === 0);
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

/** Send an owner command over a second authenticated socket while the Calendar stays open. */
async function scheduleCommand(page, command) {
  await page.evaluate((cmd) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Schedule command timed out: ${cmd.type}`)); }, 10000);
    socket.onerror = () => { clearTimeout(timer); reject(new Error("Schedule command socket failed")); };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "hello") socket.send(JSON.stringify(cmd));
      if (message.type === "schedules") {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    };
  }), command);
}

async function fireSchedule(page, dataDir, id) {
  const previous = readDb(dataDir, "SELECT id FROM fired_reminders WHERE ref_id = ? ORDER BY rowid DESC LIMIT 1", id)[0]?.id;
  await scheduleCommand(page, { type: "schedule.run", id });
  const fired = await poll(() => {
    const row = readDb(dataDir, "SELECT * FROM fired_reminders WHERE ref_id = ? ORDER BY rowid DESC LIMIT 1", id)[0];
    return row?.id !== previous ? row : null;
  });
  if (!fired) throw new Error("The reminder-only schedule did not fire");
  return fired;
}

async function waitReminderCount(page, expected, selector = ".cal-fired-toggle .board-tab-count") {
  await page.waitForFunction(({ count, target }) => Number(document.querySelector(target)?.textContent ?? 0) === count, { count: expected, target: selector }, { timeout: 10000 });
}

async function clearFiredReminders(page) {
  await page.request.post(`http://127.0.0.1:${PORT}/api/calendar/fired/seen`, { data: {} });
  await waitReminderCount(page, 0);
  await page.waitForFunction(() => document.querySelectorAll(".cal-fired-row.new").length === 0, null, { timeout: 10000 });
}

/** All-day dates are civil dates, including an occurrence moved away from its series date. */
async function firedAllDayDates(page, dataDir, shots) {
  await clearFiredReminders(page);
  for (const { moved, legacy } of [{ moved: false, legacy: false }, { moved: true, legacy: false }, { moved: true, legacy: true }]) {
    const title = `Synthetic cross-zone all-day${moved ? " moved" : ""}${legacy ? " legacy" : ""}`;
    const response = await page.request.post(`http://127.0.0.1:${PORT}/api/calendar/events`, { data: {
      title, notes: null, allDay: true, start: "2027-03-10", end: "2027-03-10",
      timeZone: "Europe/Berlin", reminders: [],
      recurrence: moved ? { freq: "daily", interval: 1, count: 2 } : null,
    } });
    if (!response.ok()) throw new Error(`All-day fixture create failed: ${response.status()}`);
    const { event } = await response.json();
    const day = moved ? "2027-03-11" : "2027-03-10";
    if (moved) {
      const edit = await page.request.patch(`http://127.0.0.1:${PORT}/api/calendar/events/${event.id}`, {
        data: { scope: "occurrence", occurrenceDate: "2027-03-10", changes: { start: day, end: day } },
      });
      if (!edit.ok()) throw new Error(`All-day fixture move failed: ${edit.status()}`);
    }
    // Seed a completed fire; the Calendar gate separately proves real ticks save these fields.
    // A civil midnight in Berlin is the previous date in the New York browser.
    const startsAt = Date.parse(`${moved ? "2027-03-10" : "2027-03-09"}T23:00:00Z`);
    const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
    try {
      const civilColumn = db.prepare("PRAGMA table_info(fired_reminders)").all().some((c) => c.name === "starts_on");
      db.prepare(`INSERT INTO fired_reminders
        (id, source, ref_id, occurrence, starts_at, title, text, due_at, fired_at, delivery${civilColumn ? ", starts_on" : ""})
        VALUES (?, 'event', ?, '2027-03-10', ?, ?, ?, ?, ?, 'failed'${civilColumn ? ", ?" : ""})`)
        .run(`lab-all-day-${moved}-${legacy}`, event.id, startsAt, title, `Synthetic all-day reminder for ${day}`, startsAt, Date.now(), ...(civilColumn ? [legacy ? null : day] : []));
    } finally { db.close(); }
    await page.waitForTimeout(2200); // The hello cache must expire after the direct fixture write.
    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await page.click(".board-tab.bt-calendar");
    await setView(page, "Day");
    await jump(page, "2027-03-15");
    const row = page.locator(`.cal-fired-row.new:has(.cal-fired-name:text-is("${title}"))`);
    await row.waitFor({ timeout: 10000 });
    const meta = await row.locator(".cal-fired-meta").textContent();
    if (!moved) await page.screenshot({ path: path.join(shots, "calendar-all-day-fired.png") });
    check(`an all-day${moved ? " moved occurrence" : " event"}${legacy ? " from older history" : ""} reminder names its civil date`,
      /all day/.test(meta) && new RegExp(`for .*${moved ? "11" : "10"} Mar`).test(meta), meta);
    await row.locator('button:text-is("Show")').click();
    const opened = await modal(page).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check(`Show opens the cross-zone all-day${moved ? " moved occurrence" : " event"}${legacy ? " from older history" : ""} in Day view`,
      opened && await modal(page).locator(".cal-details-title").textContent() === title,
      opened ? title : await page.locator(".cal-error").allTextContents());
    check("the all-day reminder jumps to its calendar date, not the previous browser date", await page.inputValue(".cal-jump") === day, await page.inputValue(".cal-jump"));
    if (opened) await closeModal(page);
    await clearFiredReminders(page);
  }
  await setView(page, "Month");
}

/** Reminder text is a message, even when it contains a URL longer than the Notes link limit. */
async function longLinkReminderFallback(page, dataDir) {
  const title = "Synthetic long-link reminder";
  await scheduleCommand(page, { type: "schedule.create", title, workspace: "", prompt: "", reminder: `https://example.com/${"x".repeat(650)}`, cron: "0 0 1 1 *", runOnce: true });
  const schedule = await poll(() => scheduleRow(dataDir, title));
  if (!schedule) throw new Error("The long-link reminder could not be created");
  await fireSchedule(page, dataDir, schedule.id);
  const note = await poll(() => readDb(dataDir, "SELECT body, url FROM operator_notes WHERE body LIKE ?", `%${title}%`)[0]);
  check("a Discord failure preserves reminder text with a long URL on Notes", !!note?.body.includes("https://example.com/") && note.url == null, JSON.stringify(note));
  await scheduleCommand(page, { type: "schedule.delete", id: schedule.id });
  await clearFiredReminders(page);
}

/** A fired standalone schedule has no future slot when switched off; older runs also remain showable. */
async function firedScheduleTargets(page, dataDir) {
  const schedule = scheduleRow(dataDir, NEW_REMINDER);
  await fireSchedule(page, dataDir, schedule.id);
  await scheduleCommand(page, { type: "schedule.update", id: schedule.id, patch: { enabled: false } });
  const panel = page.locator(".cal-fired");
  const fresh = panel.locator(`.cal-fired-row.new:has(.cal-fired-name:text-is("${NEW_REMINDER}"))`);
  await fresh.waitFor({ timeout: 10000 });
  await fresh.locator('button:text-is("Show")').click();
  const opened = await modal(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("Show opens an executed standalone reminder with no remaining slot", opened && await modal(page).locator(".cal-details-title").textContent() === NEW_REMINDER, await page.locator(".cal-statusline").textContent());
  if (opened) await closeModal(page);
  await waitReminderCount(page, 0);

  await fireSchedule(page, dataDir, schedule.id);
  await fresh.waitFor({ timeout: 10000 });
  const older = panel.locator(`.cal-fired-row:not(.new):has(.cal-fired-name:text-is("${NEW_REMINDER}"))`).first();
  await older.locator('button:text-is("Show")').click();
  const oldOpened = await modal(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("Show also opens an older reminder after the schedule fired again", oldOpened && await modal(page).locator(".cal-details-title").textContent() === NEW_REMINDER, await page.locator(".cal-statusline").textContent());
  if (oldOpened) await closeModal(page);
  await clearFiredReminders(page);
}

/** Delayed REST replies must not erase a newer reminder delivered over the live socket. */
async function firedReminderRaces(page, dataDir) {
  const id = scheduleRow(dataDir, NEW_REMINDER).id;
  await page.click(".board-tab.bt-tasks");
  let releaseHello;
  let helloCaptured;
  let helloFinished;
  const heldHello = new Promise((resolve) => { releaseHello = resolve; });
  const capturedHello = new Promise((resolve) => { helloCaptured = resolve; });
  const finishedHello = new Promise((resolve) => { helloFinished = resolve; });
  let firstHelloRead = true;
  const firedPath = /\/api\/calendar\/fired$/;
  const holdHello = async (route) => {
    if (!firstHelloRead) return route.continue();
    firstHelloRead = false;
    const response = await route.fetch();
    const body = await response.json();
    helloCaptured(body);
    await heldHello;
    await route.fulfill({ response, json: body });
    helloFinished();
  };
  await page.route(firedPath, holdHello);
  await page.reload();
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
  const staleHello = await capturedHello;
  check("the held reconnect count starts with no unseen reminders", staleHello.unseen === 0, String(staleHello.unseen));
  await fireSchedule(page, dataDir, id);
  await waitReminderCount(page, 1, ".board-tab.bt-calendar .board-tab-count");
  releaseHello();
  await finishedHello;
  await page.waitForTimeout(250);
  check("a delayed reconnect read cannot erase a newer Calendar badge", await page.evaluate(() => document.querySelector(".board-tab.bt-calendar .board-tab-count")?.textContent) === "1");
  await page.unroute(firedPath, holdHello);
  await page.click(".board-tab.bt-calendar");
  await page.locator(".cal-fired-row.new").waitFor({ timeout: 10000 });
  await clearFiredReminders(page);

  await fireSchedule(page, dataDir, id);
  await page.locator(".cal-fired-row.new").waitFor({ timeout: 10000 });
  let releaseSeen;
  let seenCaptured;
  let seenFinished;
  const heldSeen = new Promise((resolve) => { releaseSeen = resolve; });
  const capturedSeen = new Promise((resolve) => { seenCaptured = resolve; });
  const finishedSeen = new Promise((resolve) => { seenFinished = resolve; });
  const seenPath = /\/api\/calendar\/fired\/seen$/;
  const holdSeenReply = async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    seenCaptured(body);
    await heldSeen;
    await route.fulfill({ response, json: body });
    seenFinished();
  };
  await page.route(seenPath, holdSeenReply);
  await page.locator('.cal-fired-row.new button:text-is("Mark seen")').click();
  const staleSeen = await capturedSeen;
  check("the held acknowledgement reply precedes the next reminder", staleSeen.unseen === 0, String(staleSeen.unseen));
  const next = await fireSchedule(page, dataDir, id);
  await waitReminderCount(page, 1);
  releaseSeen();
  await finishedSeen;
  await page.waitForTimeout(250);
  check("a delayed Mark seen reply cannot erase a reminder that just fired", await page.evaluate(() => document.querySelector(".cal-fired-toggle .board-tab-count")?.textContent) === "1");
  check("the reminder that arrived during acknowledgement stays new", readDb(dataDir, "SELECT seen_at FROM fired_reminders WHERE id = ?", next.id)[0]?.seen_at == null && await page.locator(".cal-fired-row.new").count() === 1);
  await page.unroute(seenPath, holdSeenReply);
  await clearFiredReminders(page);

  const first = await fireSchedule(page, dataDir, id);
  const second = await fireSchedule(page, dataDir, id);
  await waitReminderCount(page, 2);
  await page.waitForFunction(() => document.querySelectorAll(".cal-fired-row.new").length === 2);
  let releaseAll;
  let allCaptured;
  let allFinished;
  const heldAll = new Promise((resolve) => { releaseAll = resolve; });
  const capturedAll = new Promise((resolve) => { allCaptured = resolve; });
  const finishedAll = new Promise((resolve) => { allFinished = resolve; });
  const holdAllRequest = async (route) => {
    allCaptured(route.request().postDataJSON());
    await heldAll;
    const response = await route.fetch();
    await route.fulfill({ response });
    allFinished();
  };
  await page.route(seenPath, holdAllRequest);
  await page.locator('.cal-fired button:text-is("Mark all seen")').click();
  const acknowledgement = await capturedAll;
  const newest = await fireSchedule(page, dataDir, id);
  await waitReminderCount(page, 3);
  releaseAll();
  await finishedAll;
  await page.waitForTimeout(250);
  const states = readDb(dataDir, "SELECT id, seen_at FROM fired_reminders WHERE id IN (?, ?, ?)", first.id, second.id, newest.id);
  check("Mark all seen acknowledges only the reminders displayed when clicked", states.filter((r) => r.seen_at != null).length === 2 && states.find((r) => r.id === newest.id)?.seen_at == null, JSON.stringify({ request: acknowledgement, states }));
  check("a reminder arriving while Mark all seen is pending keeps its badge and new row", await page.evaluate(() => document.querySelector(".cal-fired-toggle .board-tab-count")?.textContent) === "1" && await page.locator(".cal-fired-row.new").count() === 1);
  await page.unroute(seenPath, holdAllRequest);
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
  await page.waitForFunction(() => !document.querySelector(".cal-body").inert);
  const separatedWeeks = await page.locator(".cal-month-week").evaluateAll((weeks) => {
    const boxes = weeks.map((week) => week.getBoundingClientRect());
    return boxes.every((box, i) => !i || box.top >= boxes[i - 1].bottom - 1);
  });
  check("month weeks do not overlap while the reminder panel is open", separatedWeeks);
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

async function phoneFiredReminderLayout(browser, cookies, shots) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: ZONE, locale: "en-GB" });
  try {
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    // The lab has no Discord token, so provide the longer retry status as a presentation fixture.
    await page.route(/\/api\/calendar\/fired$/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const reminder of body.reminders) if (!reminder.seenAt) reminder.delivery = "retrying";
      await route.fulfill({ response, json: body });
    });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await page.selectOption('select[aria-label="Board area"]', "calendar").catch(() => page.click(".board-tab.bt-calendar"));
    const fresh = page.locator(".cal-fired-row.new");
    await fresh.waitFor({ timeout: 15000 });
    check("the phone reminder shows the full Discord retry status", await fresh.locator(".cal-fired-delivery").textContent() === "Discord failed, retrying · on Notes");
    const fits = await fresh.evaluate((row) => {
      const panel = row.closest(".cal-fired");
      const bounds = panel.getBoundingClientRect();
      return {
        overflow: panel.scrollWidth - panel.clientWidth,
        inside: [...row.querySelectorAll(".cal-fired-delivery, .cal-fired-actions button")].every((el) => {
          const box = el.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        }),
      };
    });
    check("a phone reminder fits its Discord status and both actions without sideways scrolling", fits.overflow <= 1 && fits.inside, JSON.stringify(fits));
    check("a phone reminder keeps Show and Mark seen available", await fresh.locator('button:text-is("Show")').isVisible() && await fresh.locator('button:text-is("Mark seen")').isVisible());
    await page.screenshot({ path: path.join(shots, "calendar-phone-fired.png") });
  } finally {
    await ctx.close();
  }
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-lab-"));
  const env = { DISCORD_BOT_TOKEN: "", DISCORD_USER_ID: "", DISCORD_CHANNEL_ID: "" };
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT, env });
  child.kill();
  killInstance(PORT);
  await new Promise((r) => setTimeout(r, 1500));
  seedSchedules(dataDir);
  child = await boot({ dataDir, port: PORT, env });
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
    // Read the reminder rows once the form has rendered them, and say what it showed if they differ.
    const reminderValues = () => page.locator('.cal-modal select[aria-label^="Reminder "]').evaluateAll((es) => JSON.stringify(es.map((e) => e.value)));
    await page.waitForFunction(() => document.querySelectorAll('.cal-modal select[aria-label^="Reminder "]').length >= 2, null, { timeout: 5000 }).catch(() => {});
    const firstDefaults = await reminderValues();
    check("the first create form receives the loaded reminder defaults", firstDefaults === '["d:7:09:00","d:1:09:00"]', firstDefaults);
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
    await startOnlyEvent(page, dataDir);
    await deletes(page, dataDir);
    await reminderDelivery(page, dataDir);
    await firedReminderCount(page, shots);
    await createReminderSchedule(page, dataDir);
    await longLinkReminderFallback(page, dataDir);
    await firedAllDayDates(page, dataDir, shots);
    await firedScheduleTargets(page, dataDir);
    await firedReminderRaces(page, dataDir);
    await defaultReminders(page, dataDir, shots);
    await persistence(page);

    check("no event or reminder started a task", threadCount(dataDir) === 0, String(threadCount(dataDir)));
    check("the page logged no errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    const cookies = await ctx.cookies();
    await ctx.close();
    await narrowLayout(browser, cookies, shots);
    await phoneFiredReminderLayout(browser, cookies, shots);
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
