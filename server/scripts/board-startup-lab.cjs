// Real-browser acceptance of the compact board index and visible-page summary loading.
// npm run build (root), then node server/scripts/board-startup-lab.cjs
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SERVER_ROOT, boot, killInstance, loadChromium, authPassword } = require('./lab-harness.cjs');
const DATA_DIR = path.join(SERVER_ROOT, 'data', 'board-startup-lab');
const PORT = 4496;
const BASE = `http://127.0.0.1:${PORT}`;
const TOTAL = 1400;

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { Db } = await import(pathToFileURL(path.join(SERVER_ROOT, 'dist/db/db.js')).href);
  const db = new Db(path.join(DATA_DIR, 'orchestrator.sqlite'));
  db.raw.transaction(() => {
    db.raw.prepare('DELETE FROM threads').run();
    const insert = db.raw.prepare(`INSERT INTO threads(id,title,state,workspace,brief,raw_prompt,latest_message_preview,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < TOTAL; i++) insert.run(`startup-task-${i}`, `Task ${i}`, i === 0 ? 'review' : 'done',
      SERVER_ROOT, `Brief ${i} `.repeat(40), `Prompt ${i}`, `Finished ${i} `.repeat(20), TOTAL - i, TOTAL - i);
  })();
  const fullSummaryBytes = Buffer.byteLength(JSON.stringify(db.listThreadSummaries()));
  db.raw.close();
  let child;
  let browser;
  const results = [];
  try {
    child = await boot({ dataDir: DATA_DIR, port: PORT, env: { CAP_RETRY_MS: '0', ACCOUNT_PING_MS: '3600000', FAST_ACCOUNT_PING_MS: '3600000' } });
    browser = await loadChromium().launch({ headless: true });
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1600, height: 1000 }, isMobile: mobile, hasTouch: mobile });
      const auth = await context.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      if (!auth.ok()) throw new Error(`login ${auth.status()}`);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('director_view', JSON.stringify({ showCompleted: true }));
        window.__boardStartup = { hellos: [], summaryRequests: [], summaryReplies: [] };
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
              const data = JSON.parse(event.data);
              if (data.type === 'hello') window.__boardStartup.hellos.push({ bytes: event.data.length, threadBytes: JSON.stringify(data.threads).length, tasks: data.threads.length,
                deferred: data.threads.filter(thread => thread.summaryDeferred).length });
              if (data.type === 'thread.summaries') window.__boardStartup.summaryReplies.push(data.threadIds);
            });
          }
          send(raw) {
            const command = JSON.parse(raw);
            if (command.type === 'thread.summaries') window.__boardStartup.summaryRequests.push(command.threadIds);
            return super.send(raw);
          }
        };
      });
      await page.goto(`${BASE}/`, { timeout: 60000 });
      await page.waitForSelector('[data-thread-id="startup-task-0"]', { timeout: 30000 });
      await page.waitForFunction(() => window.__boardStartup.summaryReplies.length > 0);
      const first = await page.evaluate(() => window.__boardStartup);
      if (first.hellos[0]?.tasks !== TOTAL || first.hellos[0]?.deferred !== TOTAL - 1) throw new Error('compact hello lost tasks or failed to defer old cards');
      if (first.hellos[0].threadBytes >= fullSummaryBytes * 0.6) throw new Error('compact index did not materially reduce startup bytes');
      if (first.summaryRequests.flat().length > 15 || first.summaryRequests.flat().includes('startup-task-30')) throw new Error('startup fetched invisible history');
      await page.waitForFunction(() => document.querySelector('[data-thread-id="startup-task-1"]')?.textContent.includes('Brief 1'));
      const pager = page.locator('.pager').first();
      await pager.locator('button').last().click();
      await page.waitForSelector('[data-thread-id="startup-task-15"]');
      await page.waitForFunction(() => document.querySelector('[data-thread-id="startup-task-15"]')?.textContent.includes('Brief 15'));
      const after = await page.evaluate(() => window.__boardStartup);
      if (after.summaryRequests.flat().length > 30) throw new Error('paging fetched more than two visible pages');
      await page.locator('[data-thread-id="startup-task-15"]').click();
      await page.waitForSelector('.detail');
      if (!await page.locator('.detail').textContent().then(text => text.includes('Task 15'))) throw new Error('old task did not open');
      if (errors.length) throw new Error(errors.join('; '));
      results.push({ mobile, fullSummaryBytes, hello: first.hellos[0], requestedCards: after.summaryRequests.flat().length, pagingAndOpen: 'passed', errors });
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    if (child) await killInstance(PORT);
  }
  const report = path.join(DATA_DIR, 'results.json');
  fs.writeFileSync(report, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  console.log(`Evidence: ${report}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
