// Browser regression for phone file providers whose handle needs the picker to stay selected.
// The provider lifetime is emulated; image sniffing, reading and the mounted composer are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { boot, killInstance, authPassword, loadChromium, requireBuild } = require('./lab-harness.cjs');
const PORT = 4491;
const BASE = `http://127.0.0.1:${PORT}`;
const screenshot = { name:'Screenshot.png', mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggo-mobile-attachment-'));
  let browser;
  try {
    await boot({ dataDir, port:PORT, env:{ ACCOUNT_1_ID:'acct1', ACCOUNT_1_LABEL:'test' } });
    const db = new Database(path.join(dataDir, 'orchestrator.sqlite'));
    const now = Date.now();
    db.prepare("INSERT INTO threads (id,title,state,workspace,brief,raw_prompt,created_at,updated_at) VALUES (?,?, 'review',?,?,?,?,?)")
      .run('picker-fixture', 'Screenshot picker fixture', dataDir, 'inert fixture', 'inert fixture', now, now);
    db.close();
    browser = await loadChromium().launch({ headless:true });
    const context = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    assert.ok((await context.request.post(BASE + '/api/login', { data:{password:authPassword()} })).ok());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const owners = new WeakMap();
      window.__pickerReads = [];
      window.__blobFallbacks = 0;
      document.addEventListener('change', event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
        for (const file of input.files) owners.set(file, input);
        if (window.__clearTooEarly) setTimeout(() => { input.value = ''; }, 0);
      }, true);
      const read = FileReader.prototype.readAsDataURL;
      const readBlob = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function() {
        const owner = owners.get(this);
        if (owner) {
          if (!Array.from(owner.files).includes(this)) return Promise.reject(new DOMException('Provider handle released', 'NotReadableError'));
          window.__blobFallbacks++;
        }
        return readBlob.call(this);
      };
      FileReader.prototype.readAsDataURL = function(file) {
        setTimeout(() => {
          const owner = owners.get(file);
          const retained = !owner || Array.from(owner.files).includes(file);
          window.__pickerReads.push(retained);
          if (retained && !window.__failFileReader) read.call(this, file);
          else {
            Object.defineProperty(this, 'error', { value:new DOMException('Provider handle released', 'NotReadableError') });
            this.dispatchEvent(new ProgressEvent('error'));
          }
        }, 80);
      };
    });
    await page.goto(BASE + '/');
    await page.waitForSelector('.accounts .acct');
    await page.locator('.card').filter({hasText:'Screenshot picker fixture'}).click();
    const expand = page.locator('.detail .mobile-inject-toggle');
    if (await expand.isVisible()) await expand.click();
    const picker = page.locator('.detail .attach-btn');
    const thumbs = page.locator('.detail .composer-thumbs .thumb');
    const input = page.locator('.detail input[type=file]');
    async function pick(files) {
      const chosen = page.waitForEvent('filechooser');
      await picker.click();
      await (await chosen).setFiles(files);
      await page.waitForFunction(() => document.querySelector('.detail .attach-btn')?.getAttribute('aria-busy') === 'false');
    }
    // Negative control: releasing the selection before the provider read reproduces the banner.
    await page.evaluate(() => { window.__clearTooEarly = true; });
    await pick(screenshot);
    assert.equal(await thumbs.count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__pickerReads), [false]);
    assert.ok(await page.getByText("1 file couldn't be read", {exact:false}).isVisible());
    await page.evaluate(() => { window.__clearTooEarly = false; window.__pickerReads = []; });

    await pick(screenshot);
    assert.equal(await thumbs.count(), 1);
    assert.equal(await input.inputValue(), '', 'selection clears only after all reads');
    assert.ok(await thumbs.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
    await thumbs.getByRole('button', {name:'Remove image'}).click();
    await pick(screenshot);
    assert.equal(await thumbs.count(), 1, 'the same screenshot can be picked again');
    await thumbs.getByRole('button', {name:'Remove image'}).click();
    await pick([screenshot, {...screenshot,name:'Screenshot-2.png',mimeType:'application/octet-stream'}]);
    assert.equal(await thumbs.count(), 2, 'batch and generic mobile MIME types work');
    assert.deepEqual(await page.evaluate(() => window.__pickerReads), [true,true,true,true]);
    await page.evaluate(() => { window.__failFileReader = true; });
    await pick({...screenshot,name:'Read-fallback.png'});
    assert.equal(await thumbs.count(), 3, 'Blob read recovers a failed FileReader');
    assert.equal(await page.evaluate(() => window.__blobFallbacks), 1);
    assert.ok((await thumbs.last().locator('img').getAttribute('src')).endsWith(screenshot.buffer.toString('base64')), 'fallback preserves every source byte');
    assert.deepEqual(errors, []);
    console.log('PASS: mobile paperclip, delayed provider, same-file retry, batch and byte-based image detection');
    await context.close();
  } finally {
    if (browser) await browser.close();
    killInstance(PORT);
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dataDir, {recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
