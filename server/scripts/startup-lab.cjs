// Real transport + browser regression checks against an isolated instance. No production writes.
// Build the server/web first (GGO_LAB_ENTRY and GGO_LAB_WEB_DIST support isolated builds).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
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
    // Real large-history snapshot; review rows cannot launch agents. Only the local browser receives
    // synthetic stream events below, so the lab consumes no provider quota or live owner work.
    const db = new Database(path.join(dataDir, 'orchestrator.sqlite'));
    const insert = db.prepare("INSERT INTO threads(id,title,state,workspace,brief,raw_prompt,created_at,updated_at,closed_at,closed_prev_state) VALUES(?,?,?,?, 'fixture','fixture',?,?,?,'done')");
    db.transaction(() => {
      for (let i = 0; i < 1400; i++) insert.run(`load-task-${i}`, `Load task ${i}`, i < 1300 ? 'review' : 'closed', path.resolve(__dirname, '../..'), Date.now() - i, Date.now() - i, i < 1300 ? null : Date.now());
    })();
    db.prepare("INSERT INTO cowork_sessions(id,name,workspace,state,created_at,updated_at) VALUES('load-cowork','Load conversation',?,'idle',?,?)")
      .run(path.resolve(__dirname, '../..'), Date.now(), Date.now());
    db.close();
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
        window.__detailRenders = 0;
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberRoot: (_id, root) => {
            const detail = document.querySelector('.detail');
            if (!detail) return;
            const visit = (fiber) => {
              if (fiber.stateNode === detail) {
                let owner = fiber.return;
                while (owner && owner.tag !== 0) owner = owner.return;
                if (owner && (owner.flags & 1)) window.__detailRenders++;
                return;
              }
              for (let child = fiber.child; child; child = child.sibling) visit(child);
            };
            visit(root.current);
          },
          onCommitFiberUnmount: () => {},
        };
        window.__startupSockets = [];
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) { super(...args); window.__startupSockets.push(this); }
        };
      });
      await page.goto(BASE + '/');
      await page.waitForSelector('.accounts .acct', { state: "attached" });
      await page.waitForTimeout(400);
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].hello, 1, 'one initial snapshot');
      assert.ok(!sockets[0].commands.includes('snapshot.request'), 'no duplicate startup request');
      assert.match(await page.evaluate(() => window.__startupSockets[0].extensions), /permessage-deflate/);
      assert.ok(!requested.some(url => /\/(?:CoWork|ScheduledTasks|OperatorNotes|SupervisorPanel|CodeEditor|editor\.api)-/.test(url)), 'unused views stay off the startup path');
      await page.waitForSelector('.changes-chip');
      await page.waitForTimeout(300);
      assert.ok(!sockets[0].commands.includes('thread.git'), 'mounting a large board never eagerly loads full Git drawers');
      await page.locator('[data-thread-id="load-task-0"]').click({position:{x:14,y:10}});
      await page.waitForSelector('.detail');
      await page.waitForTimeout(300);
      const background = await page.evaluate(async () => {
        const emit = (event) => window.__startupSockets[0].onmessage({data:JSON.stringify(event)});
        // Warm background feeds and let the selected task finish mounting before the measured burst.
        emit({type:'agent.text',threadId:'load-task-20',runId:'load-run-20',role:'implementor',messageId:'warm',text:'background'});
        await new Promise(resolve => setTimeout(resolve,100));
        window.__detailRenders = 0;
        const started = performance.now();
        for (let burst = 0; burst < 20; burst++) {
          for (let agent = 20; agent < 32; agent++) {
            emit({type:'agent.delta',threadId:`load-task-${agent}`,runId:`load-run-${agent}`,role:'implementor',text:' token'});
            emit({type:'agent.text',threadId:`load-task-${agent}`,runId:`load-run-${agent}`,role:'implementor',messageId:`text-${burst}-${agent}`,text:`background ${burst}`});
          }
          await new Promise(resolve => setTimeout(resolve,10));
        }
        await new Promise(resolve => setTimeout(resolve,100));
        return {renders:window.__detailRenders,ms:Math.round(performance.now()-started)};
      });
      assert.equal(background.renders, 0, '12 background agents must not render the open transcript');
      await page.evaluate(() => window.__startupSockets[0].onmessage({data:JSON.stringify({type:'agent.delta',threadId:'load-task-0',runId:'selected-run',role:'implementor',text:'Selected stream stays live'})}));
      await page.waitForFunction(() => document.querySelector('.detail').textContent.includes('Selected stream stays live'));
      assert.ok(await page.evaluate(() => window.__detailRenders > 0), 'the render counter detects an actual selected-task update');
      await page.locator('.detail .task-close').click();
      await page.waitForSelector('.detail', {state:'detached'});
      const chip = page.locator('[data-thread-id="load-task-0"] .changes-chip');
      await chip.focus();
      await page.waitForFunction(() => window.__startupSockets[0].readyState === WebSocket.OPEN);
      await page.waitForTimeout(100);
      assert.ok(sockets[0].commands.includes('thread.git'), 'keyboard approach still prefetches the requested drawer');
      await chip.click();
      await page.waitForSelector('.git-panel');
      await page.locator('.git-panel .git-close').click();
      console.log(`PASS: 1,400 tasks / 12 background agents: ${background.renders} transcript renders over 480 events (${background.ms}ms); selected streaming and Git drawer work`);
      await page.locator('.closed-toggle').click();
      assert.equal(await page.locator('.closed-card').count(), 30, 'expanding Closed mounts one bounded page');
      await page.locator('.closed-pager button').last().click();
      assert.match(await page.locator('.closed-pager').textContent(), /31–60 of 100/);
      await page.locator('.closed-pager button').last().click();
      await page.locator('.closed-pager button').last().click();
      assert.equal(await page.locator('.closed-card').count(), 10, 'the final page remains reachable');
      await page.locator('.closed-pager button').first().click();
      assert.equal(await page.locator('.closed-card').count(), 30, 'previous page works');
      await page.locator('.closed-toggle').click();
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
      await page.waitForSelector('.accounts .acct', { state: "attached" });
      assert.equal(new URL(page.url()).pathname, '/orchestrator/');
      assert.match(await page.evaluate(() => window.__startupSockets[0].url), /\/orchestrator\/ws$/);
      assert.match(await page.evaluate(() => window.__startupSockets[0].extensions), /permessage-deflate/);
      if (mobile) await page.setViewportSize({width:1600,height:1000});
      // Co-work is a board card/popup now; the retained component keeps unsent drafts on reopen.
      await page.locator('.cowork-card-open').click();
      await page.waitForSelector('.cowork-popup');
      await page.locator('.cowork-popup textarea').fill('Keep this conversation draft');
      await page.locator('.cowork-close').click();
      await page.waitForSelector('.cowork-popup', {state:'detached'});
      await page.locator('.cowork-card-open').click();
      assert.equal(await page.locator('.cowork-popup textarea').inputValue(), 'Keep this conversation draft');
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
