const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadChromium, authPassword, boot, killInstance, requireBuild, requireFreshWebBuild } = require('./lab-harness.cjs');
const PORT = 4487;
const BASE = `http://127.0.0.1:${PORT}`;
let checks = 0;
function check(label, value) { assert.ok(value, label); checks++; console.log(`PASS ${label}`); }
(async () => {
  requireBuild(); requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-notifications-lab-'));
  let child, browser, timer;
  try {
    killInstance(PORT); child = await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.__pings = 0;
      const Original = window.AudioContext;
      window.AudioContext = class extends Original {
        createOscillator() { window.__pings++; return super.createOscillator(); }
      };
    });
    const camera = { id: 'a', name: 'Porch', vendor: '', modelPreset: '', location: '', previewStrategy: 'snapshot', snapshotUrl: '', gridSpan: 6, previewHeight: 0, refreshMs: 5000, notificationsEnabled: false, uiCollapsed: false, privacyMode: null };
    const recording = { mode: 'off', schedule: { days: [1], start: '09:00', end: '17:00' }, segmentMinutes: 15, retentionDays: 0, maxGbPerCamera: 0 };
    let config = { origin: 'new', ffmpegFound: true, recordingRoot: '', recording, cameras: [camera, { ...camera, id: 'b', name: 'Kitchen' }] };
    let running = true, writes = 0, ticketCalls = 0, delaySaves = false, failNextSave = false;
    await page.route('**/api/modules/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      let json;
      if (pathname.endsWith('/api/config')) {
        if (request.method() === 'PUT') {
          if (delaySaves) await new Promise(resolve => setTimeout(resolve, 400));
          if (failNextSave) { failNextSave = false; await route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } }); return; }
          config = { ...config, ...request.postDataJSON() }; writes++;
        }
        json = config;
      } else if (pathname.endsWith('/api/recording')) json = { ...recording, cameras: [], active: false };
      else if (pathname.endsWith('/ticket')) { ticketCalls++; json = { ticket: 'synthetic' }; }
      else if (pathname.endsWith('/service/stop')) { running = false; json = { state: 'stopped' }; }
      else if (pathname.endsWith('/service/start')) { running = true; json = { state: 'running' }; }
      else if (pathname.endsWith('/service')) json = { module: 'surveillance', state: running ? 'running' : 'stopped', pid: null, stale: false, busy: null, rssBytes: 0 };
      else if (pathname.endsWith('/api/presets')) json = { presets: [] };
      else throw new Error(`Unexpected request: ${pathname}`);
      await route.fulfill({ json });
    });
    const pictures = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 320, 240);
      const still = c.toDataURL('image/jpeg').split(',')[1];
      ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 100, 240);
      return { still, moving: c.toDataURL('image/jpeg').split(',')[1] };
    });
    let sockets = 0, active = 0;
    const feeds = new Set();
    let movement = { a: false, b: false };
    await page.routeWebSocket('**/api/modules/surveillance/stream**', socket => {
      sockets++; active++; feeds.add(socket);
      socket.onClose(() => { active--; feeds.delete(socket); });
    });
    timer = setInterval(() => {
      for (const socket of feeds) for (const id of ['a', 'b']) {
        const header = Buffer.from(JSON.stringify({ id, at: Date.now() }));
        const len = Buffer.alloc(2); len.writeUInt16BE(header.length);
        socket.send(Buffer.concat([len, header, Buffer.from(movement[id] ? pictures.moving : pictures.still, 'base64')]));
      }
    }, 250);
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(BASE); await page.waitForSelector('.accounts .acct', { state: 'attached' });
    await page.click('[aria-label="Open settings"]'); await page.click('[data-settings-category="interface"]');
    await page.click('[role="switch"][aria-label="Surveillance tab"]'); await page.click('[aria-label="Close settings"]');
    await page.click('.bt-surveillance'); await page.waitForSelector('.sv-open-camera img');
    const toggle = name => page.getByRole('button', { name: `Motion notifications for ${name}`, exact: true });
    check('notifications default off for both cameras', await toggle('Porch').getAttribute('aria-pressed') === 'false' && await toggle('Kitchen').getAttribute('aria-pressed') === 'false');
    await toggle('Porch').click(); await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Porch"]').getAttribute('aria-pressed') === 'true');
    check('camera toggle persists independently', writes === 1 && config.cameras[0].notificationsEnabled && !config.cameras[1].notificationsEnabled);
    await page.waitForTimeout(700);
    check('live grid and monitoring share one socket', sockets === 1 && active === 1);
    await page.click('.bt-tasks'); await page.waitForTimeout(300);
    const pings = await page.evaluate(() => window.__pings);
    movement.b = true; await page.waitForTimeout(600);
    check('disabled kitchen movement produces no badge or ping', await page.locator('.bt-surveillance .board-tab-count').count() === 0 && await page.evaluate(() => window.__pings) === pings);
    movement.a = true;
    await page.waitForFunction(() => document.querySelector('.bt-surveillance .board-tab-count')?.textContent === '1');
    check('enabled camera movement increments inactive tab', await page.locator('.bt-surveillance .board-tab-count').textContent() === '1');
    const pulse = locator => locator.evaluate(el => ({
      animation: getComputedStyle(el).animationName,
      running: el.getAnimations().some(a => a.playState === 'running'),
      border: parseFloat(getComputedStyle(el).borderTopWidth),
      badgeSize: parseFloat(getComputedStyle(el.querySelector('.board-tab-count')).fontSize),
    }));
    const desktopPulse = await pulse(page.locator('.bt-surveillance'));
    check('unread desktop tab has a prominent running pulse', desktopPulse.animation === 'surveillance-alert-pulse' && desktopPulse.running && desktopPulse.border >= 2 && desktopPulse.badgeSize >= 13);
    const firstShadow = await page.locator('.bt-surveillance').evaluate(el => getComputedStyle(el).boxShadow);
    await page.waitForTimeout(300);
    check('desktop pulse visibly changes the highlight over time', await page.locator('.bt-surveillance').evaluate(el => getComputedStyle(el).boxShadow) !== firstShadow);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await pulse(page.locator('.bt-surveillance'));
    check('reduced motion keeps the prominent border and count without animation', reduced.animation === 'none' && !reduced.running && reduced.border >= 2 && reduced.badgeSize >= 13);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check('motion plays the ping independently of task bell preference', await page.evaluate(() => window.__pings) === pings + 2);
    movement.a = false; await page.waitForTimeout(400); movement.a = true; await page.waitForTimeout(500);
    check('cooldown prevents notification spam', await page.locator('.bt-surveillance .board-tab-count').textContent() === '1');
    await page.reload(); await page.waitForSelector('.accounts .acct', { state: 'attached' });
    await page.waitForSelector('.bt-surveillance .board-tab-count');
    check('unread count survives reload', await page.locator('.bt-surveillance .board-tab-count').textContent() === '1');
    for (const width of [768, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const alert = page.locator('.board-motion-alert');
      check(`unread motion is visible beside the current area at ${width}px`, await alert.isVisible() && await page.locator('[aria-label="Board area"]').inputValue() === 'tasks' && await alert.locator('.board-tab-count').textContent() === '1');
      const animation = await pulse(alert);
      check(`motion button pulses and fits the screen at ${width}px`, animation.running && animation.animation === 'surveillance-alert-pulse' && await alert.evaluate(el => {
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height >= 44;
      }));
    }
    await page.locator('.board-motion-alert').click();
    await page.waitForSelector('[aria-label="Motion notifications for Porch"]');
    check('narrow motion button opens Surveillance and dismisses its alert', await page.locator('[aria-label="Board area"]').inputValue() === 'surveillance' && await page.locator('.board-motion-alert').count() === 0 && await page.locator('.surveillance-alert').count() === 0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('[aria-label="Motion notifications for Porch"]');
    check('enabled preference survives reload', await toggle('Porch').getAttribute('aria-pressed') === 'true');
    await page.setViewportSize({ width: 320, height: 700 });
    check('notification controls fit narrow camera tiles', await page.locator('.sv-tile-head button').evaluateAll(buttons => buttons.every(button => {
      const r = button.getBoundingClientRect(), tile = button.closest('.sv-tile').getBoundingClientRect();
      return r.left >= tile.left && r.right <= tile.right && r.right <= innerWidth;
    })));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('.bt-tasks');
    check('opening Surveillance clears unread count', await page.locator('.bt-surveillance .board-tab-count').count() === 0);
    await page.click('.bt-surveillance'); await toggle('Kitchen').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Kitchen"]').getAttribute('aria-pressed') === 'true');
    await page.click('.bt-tasks'); await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(700);
    movement.b = false;
    await page.waitForFunction(() => document.querySelector('.board-motion-alert .board-tab-count')?.textContent === '1');
    check('new motion arrives as a visible pulsating alert on a narrow screen', await page.locator('.board-motion-alert').isVisible() && (await pulse(page.locator('.board-motion-alert'))).running);
    movement.a = false;
    await page.waitForFunction(() => document.querySelector('.board-motion-alert .board-tab-count')?.textContent === '2');
    check('independent camera notifications accumulate in the narrow alert count', await page.locator('.board-motion-alert .board-tab-count').textContent() === '2');
    await page.setViewportSize({ width: 1440, height: 900 });
    check('accumulated notifications remain prominent when returning to desktop', await page.locator('.bt-surveillance .board-tab-count').textContent() === '2' && (await pulse(page.locator('.bt-surveillance'))).running);
    await page.click('.bt-surveillance'); await page.waitForSelector('[aria-label="Motion notifications for Kitchen"]');
    check('opening the desktop alert stops the pulse and clears accumulated notifications', await page.locator('.surveillance-alert').count() === 0);
    await toggle('Kitchen').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Kitchen"]').getAttribute('aria-pressed') === 'false');
    await toggle('Porch').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Porch"]').getAttribute('aria-pressed') === 'false');
    await page.click('.bt-tasks'); await page.waitForTimeout(400);
    check('turning last camera off releases socket outside live view', active === 0);
    await page.click('.bt-surveillance'); await toggle('Porch').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Porch"]').getAttribute('aria-pressed') === 'true');
    delaySaves = true;
    const clickBoth = () => page.evaluate(() => {
      document.querySelector('[aria-label="Motion notifications for Porch"]').click();
      document.querySelector('[aria-label="Motion notifications for Kitchen"]').click();
    });
    await clickBoth();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Kitchen"]').getAttribute('aria-pressed') === 'true');
    check('rapid camera toggles preserve both independent changes', !config.cameras[0].notificationsEnabled && config.cameras[1].notificationsEnabled);
    const beforeDouble = writes;
    await page.evaluate(() => {
      const button = document.querySelector('[aria-label="Motion notifications for Kitchen"]');
      button.click(); button.click();
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Kitchen"]').getAttribute('aria-pressed') === 'false');
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Kitchen"]').getAttribute('aria-pressed') === 'true');
    check('two rapid clicks on one camera restore its original setting', writes === beforeDouble + 2 && config.cameras[1].notificationsEnabled);
    failNextSave = true;
    await clickBoth();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Kitchen"]').getAttribute('aria-pressed') === 'false');
    check('a failed save preserves its setting and subsequent camera updates still save', !config.cameras[0].notificationsEnabled && !config.cameras[1].notificationsEnabled);
    check('failed notification save is shown to the owner', await page.getByRole('alert').filter({ hasText: 'Synthetic save failure' }).count() === 1);
    delaySaves = false;
    await toggle('Porch').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Motion notifications for Porch"]').getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.waitForTimeout(6000);
    const stoppedTickets = ticketCalls;
    await page.waitForTimeout(1200);
    check('explicit Stop remains stopped with notification monitoring enabled', !running && active === 0 && ticketCalls === stoppedTickets);
    check('no browser exceptions', errors.length === 0);
    console.log(`${checks}/${checks} motion notification browser checks passed`);
  } finally {
    clearInterval(timer); if (browser) await browser.close(); if (child) child.kill(); killInstance(PORT);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
