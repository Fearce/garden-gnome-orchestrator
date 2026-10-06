// Verify director composer placement and disclosure in an authenticated throwaway browser.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, killInstance, loadChromium, authPassword, requireBuild, requireFreshWebBuild } = require('./lab-harness.cjs');
const PORT = 4581;
(async () => {
  requireBuild(); requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'director-actions-lab-'));
  let browser;
  let checks = 0;
  const check = (ok, label) => { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); };
  try {
    await boot({dataDir, port: PORT});
    browser = await loadChromium().launch();
    const page = await browser.newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, {data: {password: authPassword()}});
    for (const width of [1440, 1024, 900]) {
      await page.setViewportSize({width, height: 900});
      await page.goto(`http://127.0.0.1:${PORT}`);
      await page.locator('.accounts .acct').first().waitFor({state:'attached'});
      if (width === 1440) {
        const handle = await page.locator('.rail-resize').boundingBox();
        await page.mouse.move(handle.x + handle.width/2, handle.y + 40);
        await page.mouse.down();
        await page.mouse.move(510, handle.y + 40, {steps: 12});
        await page.mouse.up();
      }
      const actions = page.locator('.composer-director-actions');
      await actions.waitFor({state:'visible'});
      check(await page.locator('.rail-head .agent-toggle').count() === 0, `${width}: header actions moved`);
      check(await actions.locator('button').count() === 4, `${width}: all four composer actions present`);
      check(await page.evaluate(() => {
        const a = document.querySelector('.composer-director-actions').getBoundingClientRect();
        const r = document.querySelector('.rail').getBoundingClientRect();
        const t = document.querySelector('.composer textarea').getBoundingClientRect();
        return a.left >= r.left && a.right <= r.right && a.top >= r.top && a.bottom <= t.top && a.bottom < innerHeight;
      }), `${width}: actions inside rail above message field`);
      if (width === 1440) {
        check(await page.evaluate(() => {
          const a = document.querySelector('.composer-director-actions').getBoundingClientRect();
          const w = document.querySelector('.composer-taskmode').getBoundingClientRect();
          return a.left >= w.right && Math.abs(a.top-w.top) < 2;
        }), 'wide rail: actions beside For / With');
      }
      const qa = actions.locator('button', {hasText: 'QA'});
      const pressed = await qa.getAttribute('aria-pressed');
      await page.getByRole('button', {name:'Expand Work', exact:true}).click();
      check(!await actions.isVisible(), `${width}: expanded work hides actions`);
      check(await page.getByRole('combobox', {name:'Work window', exact:true}).isVisible(), `${width}: work controls usable`);
      await page.getByRole('button', {name:'Collapse Work', exact:true}).click();
      check(await actions.isVisible() && await qa.getAttribute('aria-pressed') === pressed, `${width}: collapse restores actions and state`);
      await actions.locator('.directives-toggle').click();
      await page.locator('.directives-modal').waitFor();
      check(await page.locator('.directives-modal textarea').isVisible(), `${width}: relocated directives opens editor`);
      await page.locator('.directives-modal').getByRole('button', {name:'Close', exact:true}).click();
    }
    console.log(`${checks}/${checks} browser checks passed`);
  } finally {
    if (browser) await browser.close();
    killInstance(PORT);
  }
})().catch(e => {console.error(e); killInstance(PORT); process.exitCode=1;});


