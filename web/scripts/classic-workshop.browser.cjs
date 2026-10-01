/* Authenticated UI regression for the "Workshop header for classic gnomes" preference.
 * Fixtures stay in this browser's WebSocket; no tasks are dispatched and no mutation reaches the office.
 * node web/scripts/classic-workshop.browser.cjs [http://127.0.0.1:4317]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadChromium } = require('../../server/scripts/findPlaywright.cjs');
const base = process.argv[2] || 'http://127.0.0.1:4317';
const output = path.resolve(__dirname, '../../_classic-workshop');
const at = Date.now();
const workspace = 'C:\\workshop';
const otherWorkspace = 'C:\\garden';
const roles = ['planner', 'implementor', 'qa', 'researcher', 'reader', 'reviewer', 'implementor', 'qa'];
const names = ['Otto', 'Bram', 'Pippa', 'Fern', 'Lumi', 'Sage', 'Milo', 'Iris'];
const threads = roles.map((role, i) => ({ id: `classic-fixture-${i}`, title: ['Sketch the next adventure', 'Build the garden workshop', 'Inspect the new release', 'Explore new possibilities'][i % 4], state: role === 'qa' ? 'qa' : 'implementing', workspace: i < 5 ? workspace : otherWorkspace, brief: 'Browser-only visual fixture', rawPrompt: 'Browser-only visual fixture', createdAt: at, updatedAt: at, priority: 0 }));
const runs = roles.map((role, i) => ({ id: `classic-run-${i}`, threadId: threads[i].id, role, state: 'running', model: 'gpt-6.1-sol', accountId: null, startedAt: at + i }));
const onlineOffice = { enabled: true, joined: true, state: 'online', url: '', instanceName: 'Here', error: null, connectedAt: at, sharedRepos: [{ repoKey: 'workshop', repoLabel: 'Workshop', workspaces: [workspace] }], remoteAgents: [{ key: 'visitor', name: 'Juniper', role: 'qa', title: 'Check the shared project', repoKey: 'workshop', repoLabel: 'Workshop', instanceId: 'remote-1', instanceName: 'North studio' }], directors: [] };
const CLASSIC = 'ggo:classic-workshop';
const BETA = 'ggo:beta-gnomes';

/** Flip a browser-local flag the way another tab would, so the storage listener is what reacts. */
const setFlag = (page, key, on) => page.evaluate(([k, v]) => { localStorage.setItem(k, v); window.dispatchEvent(new StorageEvent('storage', { key: k })); }, [key, on ? '1' : '0']);
const art = (page) => page.locator('.beta-workshop').getAttribute('data-art');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await loadChromium().launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const env = fs.readFileSync(path.resolve(__dirname, '../../server/.env'), 'utf8');
    const password = env.match(/^AUTH_PASSWORD=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
    const login = await context.request.post(`${base}/api/login`, { data: { password } });
    assert.equal(login.ok(), true, `Login failed (${login.status()})`);
    let currentSocket;
    let hello;
    await context.routeWebSocket('**/ws', (socket) => {
      currentSocket = socket;
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'chat.history') socket.send(JSON.stringify({ type: 'chat.history', room: msg.room, messages: [], hasMore: false }));
      });
      server.onMessage((raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'hello') return;
        hello = { ...msg, threads, runs, findings: [], questions: [], director: [], chat: [], chatRooms: [], schedules: [], goals: [], notes: [], coworkSessions: [], onlineOffice, nameOverrides: Object.fromEntries(roles.map((role, i) => [`${threads[i].id}::${role}`, names[i]])), settings: { ...msg.settings, directorName: 'Merlin' }, directorStatus: null, directorBusy: true, directorIdleSince: null };
        socket.send(JSON.stringify(hello));
      });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const artRequests = []; page.on('request', (r) => { if (r.url().includes('workshop-cast')) artRequests.push(r.url()); });
    await page.goto(base);
    await page.evaluate(([a, b]) => { localStorage.removeItem(a); localStorage.removeItem(b); }, [CLASSIC, BETA]);
    await page.reload();

    // Default for an existing user: the classic strip, untouched.
    await page.locator('.office-strip .office-huddle').first().waitFor();
    assert.equal(await page.locator('.beta-workshop').count(), 0, 'Default must keep the classic strip');
    const classicHeight = await page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().height);
    await page.locator('.topbar').screenshot({ path: path.join(output, 'off-classic-strip.png') });

    // The toggle sits directly beside "Beta gnomes" in the "A little more magic" group.
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const general = page.locator('[data-settings-panel="general"]');
    const magic = general.locator('.beta-gnomes-setting');
    const toggle = magic.getByRole('switch', { name: 'Workshop header for classic gnomes', exact: true });
    await toggle.waitFor();
    assert.equal(await magic.getByRole('switch', { name: 'Beta gnomes', exact: true }).count(), 1, 'Both toggles share the magic group');
    assert.equal(await toggle.isChecked(), false, 'Default off');
    await toggle.click();
    await page.locator('.beta-workshop[data-art="classic"]').waitFor();
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), CLASSIC), '1');
    assert.notEqual(await page.evaluate((k) => localStorage.getItem(k), BETA), '1', 'Must not switch on beta gnomes');
    await magic.screenshot({ path: path.join(output, 'settings-toggle.png') });
    await page.keyboard.press('Escape');

    // Persistence across reload, with the original vector art and no beta texture.
    await page.reload();
    await page.locator('.beta-workshop[data-art="classic"] .beta-workstation[data-office-room="repo:c:/workshop"]').first().waitFor();
    assert.equal(await page.locator('.beta-gnome').count(), 0, 'Classic header must not mount beta artwork');
    assert.equal(artRequests.length, 0, 'Classic header must not fetch the beta atlas');
    const stations = await page.locator('.beta-workstation').count();
    assert.equal(await page.locator('.beta-workstation .beta-character .classic-workshop-gnome > .gnome > svg').count(), stations, 'Every seat shows the original gnome');
    assert.equal(await page.locator('.beta-destination').count(), stations, 'Every seat is labeled with its destination');
    assert.equal(await page.locator('.beta-workshop').evaluate((el) => el.getBoundingClientRect().height), 48, 'Workshop is exactly one gnome high');
    const workshopHeight = await page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().height);
    assert(workshopHeight <= classicHeight + 16, `Must not add header rows (${classicHeight}px classic, ${workshopHeight}px workshop)`);
    // Same population rule as beta: as many seats as the lane fits (156px each, up to seven).
    const stageWidth = await page.locator('.beta-workshop-stage').evaluate((el) => el.clientWidth);
    assert.equal(stations, Math.max(1, Math.min(7, Math.floor(stageWidth / 156))), `Lane of ${stageWidth}px is filled (${stations} seats)`);
    // Each seat's home sits in its own equal share of the lane, so the cast covers the whole header.
    const outOfShare = await page.locator('.beta-workshop-stage').evaluate((stage) => {
      const seats = [...stage.querySelectorAll('.beta-workstation')];
      const share = stage.clientWidth / seats.length;
      return seats.filter((s, i) => { const home = parseFloat(s.style.left); return home < share * i || home >= share * (i + 1); }).length;
    });
    assert.equal(outOfShare, 0, 'Every seat stands in its own share of the header');
    await page.locator('.topbar').screenshot({ path: path.join(output, 'classic-workshop-desktop.png') });

    // Real travel and a rendezvous on the shared timeline, plus the classic walk and tool work.
    await page.locator('.beta-workshop').evaluate((el) => {
      window.classicTimelines = el.getAnimations({ subtree: true }).map((animation) => ({ animation, time: animation.currentTime }));
    });
    const names_ = await page.locator('.beta-workshop').evaluate((el) => [...new Set(el.getAnimations({ subtree: true }).map((a) => a.animationName))]);
    for (const name of ['beta-journey', 'beta-facing', 'beta-walk-bob', 'classic-waddle', 'classic-tool-work']) assert(names_.includes(name), `Missing ${name} animation (${names_.join(', ')})`);
    const atPhase = (fraction) => page.locator('.beta-workshop').evaluate((el, f) => {
      for (const { animation } of window.classicTimelines) { const t = animation.effect.getTiming(); animation.currentTime = t.delay + Number(t.duration) * f; }
    }, fraction);
    const partner = page.locator('.beta-workstation[data-partner]').first();
    assert.equal(await partner.count(), 1, 'Same-repo teammates pair up');
    await atPhase(0); const start = (await partner.boundingBox()).x;
    await atPhase(0.35);
    const meet = (await partner.boundingBox()).x;
    assert(Math.abs(meet - start) >= 15, `Gnome walks toward its teammate (${Math.abs(meet - start)}px)`);
    const gap = await partner.evaluate((el) => {
      const other = [...document.querySelectorAll('.beta-workstation')].find((o) => o.dataset.agentId === el.dataset.partner);
      return Math.abs(other.getBoundingClientRect().x - el.getBoundingClientRect().x);
    });
    assert(Math.abs(gap - 34) < 2, `Partners meet shoulder to shoulder (${gap}px)`);
    assert(Number(await page.locator('.beta-shared-project').first().evaluate((el) => getComputedStyle(el).opacity)) > 0.9, 'Shared sheet appears at the rendezvous');
    const toolSwing = await page.locator('.beta-workstation[data-working="true"] .gnome-prop').first().evaluate((el) => getComputedStyle(el).rotate);
    assert.notEqual(toolSwing, 'none', 'A working classic gnome swings its tool during shared work');
    await page.locator('.topbar').screenshot({ path: path.join(output, 'classic-workshop-cooperation.png') });
    await atPhase(0.14);
    await page.locator('.topbar').screenshot({ path: path.join(output, 'classic-workshop-walking.png') });
    await page.evaluate(() => { for (const { animation, time } of window.classicTimelines) animation.currentTime = time; delete window.classicTimelines; });

    // Seats still route to their rooms; the roster lists everyone in the classic art.
    await page.getByRole('button', { name: /Show all .* workshop gnomes/ }).click();
    assert.equal(await page.locator('.beta-workshop-roster > button .gnome > svg').count(), await page.locator('.beta-workshop-roster > button').count());
    await page.getByRole('button', { name: 'Close workshop crew' }).click();
    await page.locator('.beta-workstation[data-office-room="repo:c:/workshop"]').first().click();
    await page.locator('.office-panel').waitFor();
    await page.locator('.office-panel').getByRole('button', { name: 'Close', exact: true }).click();

    // Pause control and reduced motion use the shared workshop rules.
    await page.getByRole('button', { name: 'Pause workshop animations' }).click();
    assert((await page.locator('.beta-workshop').evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.playState))).every((s) => s === 'paused'), 'Pause stops every classic animation');
    await page.getByRole('button', { name: 'Resume workshop animations' }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.beta-workshop').evaluate((el) => el.getAnimations({ subtree: true }).length), 0, 'Reduced motion stills the classic workshop');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Independence from beta gnomes: beta art wins while on, classic returns when beta goes off.
    await setFlag(page, BETA, true);
    await page.waitForFunction(() => document.querySelector('.beta-workshop')?.dataset.art === 'beta');
    assert((await page.locator('.beta-gnome').count()) > 0, 'Beta gnomes take over the workshop');
    await setFlag(page, CLASSIC, false);
    assert.equal(await art(page), 'beta', 'Beta keeps its workshop with the classic toggle off');
    await setFlag(page, CLASSIC, true);
    await setFlag(page, BETA, false);
    await page.waitForFunction(() => document.querySelector('.beta-workshop')?.dataset.art === 'classic');
    assert.equal(await page.locator('.beta-gnome').count(), 0);

    // Varying gnome counts: a quiet office keeps the director, a single task adds one walker.
    for (const [count, expected] of [[0, 1], [1, 2]]) {
      currentSocket.send(JSON.stringify({ ...hello, threads: threads.slice(0, count), runs: runs.slice(0, count), onlineOffice: { ...onlineOffice, remoteAgents: [] } }));
      await page.waitForFunction((n) => document.querySelectorAll('.beta-workstation').length === n, expected);
      assert.equal(await page.locator('.office-beta').evaluate((el) => el.getBoundingClientRect().height), 48, `Lane height with ${count} tasks`);
      await page.locator('.topbar').screenshot({ path: path.join(output, `classic-workshop-${count}-tasks.png`) });
    }
    // An idle director rests like its beta self: a chair at first, the bed after eight hours off duty.
    const restingDirector = '.beta-workstation[data-agent-id="director"]';
    for (const [rest, idleFor] of [['chair', 60_000], ['sleep', 9 * 60 * 60 * 1000]]) {
      currentSocket.send(JSON.stringify({ ...hello, directorBusy: false, directorIdleSince: Date.now() - idleFor }));
      await page.locator(`${restingDirector}[data-rest="${rest}"] .classic-workshop-gnome[data-rest="${rest}"] .gnome > svg`).waitFor();
      assert.equal(await page.locator(`${restingDirector} .beta-rest-${rest === 'chair' ? 'chair' : 'bed'}`).count(), 1, `Classic director has the beta ${rest} furniture`);
      assert.deepEqual(await page.locator(restingDirector).evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.animationName).filter((n) => n !== 'beta-dream')), [], `A ${rest} director does not walk or work`);
      assert.equal(await page.locator('.beta-gnome').count(), 0);
      await page.locator(restingDirector).screenshot({ path: path.join(output, `classic-director-${rest}.png`) });
    }
    currentSocket.send(JSON.stringify(hello));
    await page.waitForFunction(() => document.querySelectorAll('.beta-workstation').length > 2 && !document.querySelector('.beta-workstation[data-rest]'));

    // Header controls stay usable at every width; the lane never overflows or grows.
    for (const width of [360, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Page overflows at ${width}px`);
      assert.equal(await page.locator('.office-beta').evaluate((el) => el.getBoundingClientRect().height), 48, `Extra vertical space at ${width}px`);
      const seats = await page.locator('.beta-workstation').count();
      assert(seats >= 1, `At least one gnome at ${width}px`);
      const blocked = await page.evaluate(() => {
        const lane = document.querySelector('.beta-workshop').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.topbar button, .topbar a, .topbar [role="button"]')]
          .filter((el) => !el.closest('.beta-workshop') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        return controls.flatMap((el) => {
          const b = el.getBoundingClientRect();
          if (b.width < 2 || b.height < 2) return [];
          const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          const overlaps = b.x < lane.right && b.right > lane.x && b.y < lane.bottom && b.bottom > lane.y;
          return hit && (el.contains(hit) || hit.contains(el)) && !overlaps ? [] : [el.getAttribute('aria-label') || el.className || el.textContent.trim().slice(0, 20)];
        });
      });
      assert.deepEqual(blocked, [], `Header controls obstructed at ${width}px`);
      const clipped = await page.locator('.beta-workstation').evaluateAll((els) => {
        const cast = els[0]?.closest('.beta-workshop-cast')?.getBoundingClientRect();
        return els.filter((el) => { const b = el.getBoundingClientRect(); return b.x < cast.x - 0.5 || b.right > cast.right + 0.5; }).length;
      });
      assert.equal(clipped, 0, `Gnomes clipped at the lane edge at ${width}px`);
      await page.screenshot({ path: path.join(output, `classic-workshop-${width}.png`), clip: { x: 0, y: 0, width, height: 120 } });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    const second = await context.newPage();
    await second.goto(base); await second.locator('.beta-workshop[data-art="classic"]').waitFor();
    // Cross-tab rollback: turning it off in one tab restores the classic strip in the other.
    await setFlag(page, CLASSIC, false);
    await page.locator('.office-strip').waitFor();
    await second.locator('.office-strip').waitFor();
    await page.reload(); await page.locator('.office-strip .office-huddle').first().waitFor();
    assert.equal(await page.locator('.beta-workshop').count(), 0, 'Off restores the existing strip after reload');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', checks: ['default off keeps strip', 'toggle beside Beta gnomes', 'persistence across reload', 'original art, no atlas', '48px lane, no added rows', 'header populated across its width', 'walk, rendezvous, shared sheet, tool work', 'roster and room routing', 'pause and reduced motion', 'independent of beta gnomes both ways', '360-1920px: no overflow, no clipping, controls usable', 'cross-tab rollback', 'no page errors'], evidence: output }, null, 2));
    await context.close();
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
