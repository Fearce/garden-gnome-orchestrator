// Browser-only activity fixtures on an isolated console; never starts an agent or sends a chat.
// GGO_LAB_WEB_DIST=.lab-web-dist npm run director-rest-lab --prefix server -- --shots data/director-rest-shots
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require('./lab-harness.cjs');
const PORT = 4533;
const BASE = `http://127.0.0.1:${PORT}`;
const BEDTIME = 8 * 60 * 60 * 1000;

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'director-rest-lab-'));
  const shots = shotDir(dataDir);
  try {
    await boot({ dataDir, port: PORT });
    const browser = await loadChromium().launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 900 }, deviceScaleFactor: 2 });
      await context.addInitScript(() => localStorage.setItem('ggo:beta-gnomes', '1'));
      const now = Date.now();
      const office = { enabled: true, joined: true, state: 'online', url: '', instanceName: 'Home', error: null,
        connectedAt: now, sharedRepos: [], remoteAgents: [], directors: [
          { instanceId: 'north', instanceName: 'North studio', name: 'Nova', agents: 3, busy: false, since: now },
          { instanceId: 'south', instanceName: 'South studio', name: 'Sage', agents: 0, busy: false, since: now },
        ] };
      let socket, hello;
      const sent = [];
      await context.routeWebSocket('**/ws', client => {
        socket = client;
        const server = client.connectToServer();
        client.onMessage(raw => {
          const msg = JSON.parse(String(raw)); sent.push(msg);
          if (msg.type === 'chat.history') client.send(JSON.stringify({ type: 'chat.history', room: msg.room, messages: [], hasMore: false }));
        });
        server.onMessage(raw => {
          const msg = JSON.parse(String(raw));
          if (msg.type !== 'hello') return;
          hello = { ...msg, threads: [], runs: [], findings: [], questions: [], director: [], directorStatus: null,
            directorBusy: false, directorIdleSince: now - 3600000, chat: [], chatRooms: [], goals: [], schedules: [],
            coworkSessions: [], onlineOffice: office, settings: { ...msg.settings, directorName: 'Merlin' } };
          client.send(JSON.stringify(hello));
        });
      });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({ time: now });
      const login = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
      await page.goto(BASE);
      const owner = page.locator('.beta-workstation[data-agent-id="director"]');
      const north = page.locator('.beta-workstation[data-agent-id="visiting-director:north"]');
      await owner.locator('[data-rest="chair"]').waitFor();
      check('idle owner sits in a chair', await owner.getAttribute('data-rest') === 'chair');
      check('remote director sits despite three active workers', await north.getAttribute('data-rest') === 'chair');
      check('idle directors share a table', await page.locator('.beta-directors-table').count() >= 1);
      check('seated directors have no walking animation', await page.locator('.beta-workstation[data-rest]').evaluateAll(els => els.every(el => !el.getAnimations().length)));
      const headerHeight = await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().height);
      await page.locator('.beta-workshop').screenshot({ path: path.join(shots, 'chairs.png') });

      const boundaryStart = await page.evaluate(() => Date.now());
      socket.send(JSON.stringify({ type: 'director.busy', busy: false, idleSince: boundaryStart - BEDTIME + 1000 }));
      await page.waitForTimeout(50);
      await page.clock.fastForward(500);
      check('just under eight hours still means chair', await owner.getAttribute('data-rest') === 'chair');
      await page.clock.fastForward(1000);
      await owner.locator('[data-rest="sleep"]').waitFor();
      check('eight-hour deadline puts owner in bed without another event', await owner.getAttribute('data-rest') === 'sleep');
      check('bed and dreams are visible', await owner.locator('.beta-rest-bed').isVisible() && await owner.locator('.beta-sleep-dream').isVisible());
      check('sleeping owner stops walking', await owner.evaluate(el => !el.getAnimations().length));
      check('other directors stay seated', await north.getAttribute('data-rest') === 'chair');
      check('bedtime adds no header height', await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().height) === headerHeight);
      await page.locator('.beta-workshop').screenshot({ path: path.join(shots, 'bedtime.png') });
      await owner.click();
      await page.locator('.office-panel').waitFor();
      check('sleeping director still opens its chat', sent.some(m => m.type === 'chat.history' && m.room === 'directors'));
      await page.locator('.office-panel').getByRole('button', { name: 'Close', exact: true }).click();

      socket.send(JSON.stringify({ type: 'director.busy', busy: true, idleSince: null }));
      await page.waitForFunction(() => !document.querySelector('[data-agent-id="director"]').hasAttribute('data-rest'));
      check('own work wakes the director and restores work animation', await owner.getAttribute('data-working') === 'true' && await owner.locator('.beta-tool-director').isVisible());
      socket.send(JSON.stringify({ type: 'office.online', office: { ...office, directors: office.directors.map(d => ({ ...d, busy: true })) } }));
      await page.waitForFunction(() => [...document.querySelectorAll('.beta-visitor')].every(el => el.dataset.working === 'true'));
      check('remote directors leave the table for their own work', await page.locator('.beta-directors-table').count() === 0 && await north.getAttribute('data-rest') === null);
      await page.locator('.beta-workshop').screenshot({ path: path.join(shots, 'working.png') });

      socket.send(JSON.stringify({ type: 'director.busy', busy: false, idleSince: now + 1500 }));
      await owner.locator('[data-rest="chair"]').waitFor();
      check('finishing work starts back in the chair', await owner.getAttribute('data-rest') === 'chair');
      socket.send(JSON.stringify({ ...hello, directorIdleSince: now - BEDTIME - 1, onlineOffice: { ...office, directors: office.directors.map(({busy,...legacy}) => legacy) } }));
      await owner.locator('[data-rest="sleep"]').waitFor();
      check('reconnect restores overnight sleep from server time', await owner.getAttribute('data-rest') === 'sleep');
      check('legacy remote presence rests instead of inventing work', await north.getAttribute('data-rest') === 'chair');
      for (const width of [900,1440,390]) {
        await page.setViewportSize({ width, height: 900 });
        check(`${width}px: same 48px gnome lane without page overflow`, await page.evaluate(() => document.querySelector('.office-beta').getBoundingClientRect().height === 48 && document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(shots, `rest-${width}.png`) });
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      check('reduced motion leaves furniture and poses without animation', await page.locator('.beta-workshop').evaluate(el => !el.getAnimations({ subtree: true }).length));
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByRole('button', { name: 'Pause workshop animations' }).click();
      check('pause also stops sleeping dreams', await page.locator('.beta-workshop').evaluate(el => el.getAnimations({ subtree: true }).every(a => a.playState === 'paused')));
      check('no browser errors', errors.length === 0, errors.join(' | '));
      console.log(`Screenshots: ${shots}`);
      await context.close();
    } finally { await browser.close(); }
    return check.summary();
  } finally {
    killInstance(PORT);
    const resolved = path.resolve(dataDir), temp = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(temp) && path.basename(resolved).startsWith('director-rest-lab-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().then(code => process.exit(code), error => { console.error(error); killInstance(PORT); process.exit(1); });
