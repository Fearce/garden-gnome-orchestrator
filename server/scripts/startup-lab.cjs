// Real transport + browser regression checks against an isolated instance. No production writes.
// Build the server/web first (GGO_LAB_ENTRY and GGO_LAB_WEB_DIST support isolated builds).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { boot, killInstance, authPassword, loadChromium, requireBuild } = require('./lab-harness.cjs');
const PORT = 4491;
const BASE = `http://127.0.0.1:${PORT}`;

function rawGet(url, encoding) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'accept-encoding': encoding } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggo-startup-'));
  let browser;
  try {
    await boot({ dataDir, port: PORT, env: { ACCOUNT_1_ID:'acct1', ACCOUNT_1_LABEL:'test' } });
    const shell = await rawGet(BASE + '/', 'identity');
    const entry = shell.body.toString().match(/src="([^\"]*\/assets\/index-[^\"]+\.js)"/)[1];
    for (const url of [BASE + '/', new URL(entry, BASE + '/').href, BASE + '/nested/route']) {
      const plain = await rawGet(url, 'identity');
      assert.equal(plain.status, 200);
      for (const encoding of ['br', 'gzip']) {
        const packed = await rawGet(url, encoding);
        assert.equal(packed.status, 200);
        assert.equal(packed.headers['content-encoding'], encoding);
        assert.match(packed.headers.vary, /accept-encoding/i);
        assert.equal(packed.headers['content-type'], plain.headers['content-type']);
        const decode = encoding === 'br' ? zlib.brotliDecompressSync : zlib.gunzipSync;
        assert.deepEqual(decode(packed.body), plain.body, 'compressed bytes round-trip exactly');
        assert.ok(packed.body.length < plain.body.length * 0.6, 'compression materially reduces transfer');
        assert.match(packed.headers['cache-control'], url.includes('/assets/') ? /immutable/ : /no-cache/);
      }
    }
    console.log('PASS: Brotli/gzip/identity, MIME types, cache headers and SPA fallback');
    browser = await loadChromium().launch({ headless:true });
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport:mobile ? {width:390,height:844} : {width:1600,height:1000}, isMobile:mobile,hasTouch:mobile });
      assert.ok((await context.request.post(BASE + '/api/login', {data:{password:authPassword()}})).ok());
      const page = await context.newPage();
      const errors = [];
      const requested = [];
      const sockets = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => requested.push(r.url()));
      page.on('websocket', ws => {
        const record = { hello:0, commands:[] };
        sockets.push(record);
        ws.on('framereceived', ({payload}) => { if (JSON.parse(String(payload)).type === 'hello') record.hello++; });
        ws.on('framesent', ({payload}) => record.commands.push(JSON.parse(String(payload)).type));
      });
      await page.addInitScript(() => {
        window.__startupSockets = [];
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) { super(...args); window.__startupSockets.push(this); }
        };
      });
      await page.goto(BASE + '/');
      await page.waitForSelector('.accounts .acct');
      await page.waitForTimeout(400);
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].hello, 1, 'one initial snapshot');
      assert.ok(!sockets[0].commands.includes('snapshot.request'), 'no duplicate startup request');
      assert.match(await page.evaluate(() => window.__startupSockets[0].extensions), /permessage-deflate/);
      assert.ok(!requested.some(url => /\/(?:CoWork|ScheduledTasks|OperatorNotes|SupervisorPanel|CodeEditor|editor\.api)-/.test(url)), 'unused views stay off the startup path');
      if (mobile) {
        assert.equal(await page.locator('.rail').count(), 0, 'hidden Director is not rendered on initial phone load');
        await page.getByRole('button', {name:'Director',exact:true}).click();
        const composer = page.locator('.rail textarea').first();
        await composer.fill('Keep this unsent draft');
        await page.getByRole('button', {name:'Tasks',exact:true}).click();
        await page.getByRole('button', {name:'Director',exact:true}).click();
        assert.equal(await composer.inputValue(), 'Keep this unsent draft', 'pane changes preserve draft');
        await page.setViewportSize({width:1600,height:1000});
        await page.waitForSelector('.rail');
        assert.equal(await composer.inputValue(), 'Keep this unsent draft', 'resizing preserves draft');
      }
      // Reconnect uses the same implicit hello, then an explicit resync still works.
      await page.evaluate(() => window.__startupSockets[0].close());
      await page.waitForFunction(() => window.__startupSockets.length === 2 && window.__startupSockets[1].readyState === WebSocket.OPEN);
      await page.waitForTimeout(400);
      assert.equal(sockets[1].hello, 1);
      assert.ok(!sockets[1].commands.includes('snapshot.request'));
      await page.evaluate(() => window.__startupSockets[1].send(JSON.stringify({type:'snapshot.request'})));
      await page.waitForTimeout(400);
      assert.equal(sockets[1].hello, 2, 'explicit resync still returns a snapshot');
      assert.deepEqual(errors, []);
      await page.goto(BASE + '/orchestrator');
      await page.waitForSelector('.accounts .acct');
      assert.equal(new URL(page.url()).pathname, '/orchestrator/');
      assert.match(await page.evaluate(() => window.__startupSockets[0].url), /\/orchestrator\/ws$/);
      assert.match(await page.evaluate(() => window.__startupSockets[0].extensions), /permessage-deflate/);
      if (mobile) await page.setViewportSize({width:1600,height:1000});
      // Once the Co-work chunk has loaded, leaving its tab must retain the same desk instance.
      await page.locator('.board-tabs .bt-cowork').click();
      await page.waitForSelector('.cowork-shell');
      await page.evaluate(() => { window.__coworkDesk = document.querySelector('.cowork-shell'); });
      await page.locator('.board-tabs .bt-tasks').click();
      assert.equal(await page.locator('.cowork-shell').count(), 1);
      assert.equal(await page.locator('.cowork-shell').isVisible(), false);
      await page.locator('.board-tabs .bt-cowork').click();
      assert.ok(await page.evaluate(() => window.__coworkDesk === document.querySelector('.cowork-shell')));
      await context.close();
      console.log(`PASS: ${mobile ? 'phone' : 'desktop'} startup, lazy views, compression, reconnect and resync`);
    }
  } finally {
    if (browser) await browser.close();
    killInstance(PORT);
    // mkdtemp produced this exact isolated directory; never remove a caller-provided DATA_DIR.
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dataDir, {recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
