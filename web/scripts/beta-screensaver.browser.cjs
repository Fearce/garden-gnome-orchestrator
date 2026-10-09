/* Browser-only fixture: no task/chat mutations reach the live server.
 * node web/scripts/beta-screensaver.browser.cjs [http://127.0.0.1:4317]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadChromium } = require('../../server/scripts/findPlaywright.cjs');
const base = process.argv[2] || 'http://127.0.0.1:4317';
const output = path.resolve(__dirname, '../../_beta-gnomes');
const at = Date.now();
const roles = ['implementor', 'qa', 'planner', 'researcher', 'reviewer', 'reader'];
let threads = roles.map((role, i) => ({ id:`scaffold-${i}`, title:`${role} at the workshop`, state:['implementing','qa','planning','researching','reviewing','queued'][i], workspace:'C:\\workshop', brief:'Local browser fixture', createdAt:at, updatedAt:at, priority:0 }));
let runs = roles.map((role, i) => ({ id:`scaffold-run-${i}`, threadId:threads[i].id, role, state:i === 5 ? 'done' : 'running', model:'gpt-6.1-sol', startedAt:at - 120_000 }));

(async () => {
  fs.mkdirSync(output, {recursive:true});
  const browser = await loadChromium().launch({headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1600,height:1000}});
    const env = fs.readFileSync(path.resolve(__dirname, '../../server/.env'),'utf8');
    const password = env.match(/^AUTH_PASSWORD=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g,'');
    const login = await context.request.post(`${base}/api/login`,{data:{password}});
    assert(login.ok(),`Login failed (${login.status()})`);
    let socket, hello;
    await context.routeWebSocket(/\/ws(?:\?|$)/, client => {
      socket = client;
      const server = client.connectToServer();
      client.onMessage(() => {});
      server.onMessage(raw => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'hello') return;
        hello = {...msg,threads,runs,findings:[],questions:[],director:[],chat:[],chatRooms:[],schedules:[],goals:[],notes:[],coworkSessions:[],directorStatus:null,onlineOffice:{enabled:false,joined:false,state:'off',url:'',instanceName:'Here',error:null,connectedAt:null,sharedRepos:[],remoteAgents:[],directors:[]}};
        client.send(JSON.stringify(hello));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // Advance only wall time; CSS and rAF continue at their real speed.
    await page.addInitScript(() => {
      const now = Date.now; window.scaffoldTime = 0;
      Date.now = () => now() + window.scaffoldTime;
    });
    const errors=[], atlasRequests=[];
    page.on('pageerror',e => errors.push(e.message));
    page.on('request',r => { if(r.url().includes('workshop-cast')) atlasRequests.push(r.url()); });
    await page.goto(base);
    await page.locator('.office-strip').waitFor();
    await page.locator('.office-huddle').first().waitFor();
    await page.waitForTimeout(700); // Let initial board layout/scroll events settle before going idle.
    await page.evaluate(() => { window.scaffoldTime += 360_000; });
    await page.locator('.gs-root').waitFor();
    assert.equal(await page.locator('.gs-worker').count(),6);
    assert.equal(await page.locator('.gs-beta-rig').count(),0);
    assert.equal(atlasRequests.length,0,'Classic screensaver must not fetch beta artwork');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.locator('.gs-root').waitFor({state:'detached'});
    await page.getByRole('button',{name:'Open settings',exact:true}).click();
    await page.getByRole('switch',{name:'Beta gnomes',exact:true}).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.scaffoldTime += 360_000; });
    await page.locator('.gs-beta-rig').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.gs-working').length === 5);
    assert.equal(await page.locator('.gs-beta-rig').count(),6);
    assert.deepEqual((await page.locator('.gs-beta-rig').evaluateAll(els=>els.map(el=>el.dataset.role))).sort(),[...roles].sort());
    const clips = await page.locator('.gs-beta-rig clipPath').evaluateAll(els=>els.map(el=>el.id));
    assert.equal(new Set(clips).size,clips.length,'Each worker must have independent clip IDs');
    assert.equal(new Set(await page.locator('.gs-beta-rig image').evaluateAll(els=>els.map(el=>el.getAttribute('href')))).size,1,'Every role must reuse one shared atlas');
    await page.waitForFunction(() => [...document.images].every(img=>img.complete));
    await page.screenshot({path:path.join(output,'screensaver-desktop.png')});
    const arm = page.locator('.gs-working .gs-arm').first();
    const first = await arm.evaluate(el=>getComputedStyle(el).transform);
    await page.waitForTimeout(190);
    assert.notEqual(await arm.evaluate(el=>getComputedStyle(el).transform),first,'The beta worker must swing its tool');
    // Magnify one real rig for review, then restore the actual scene geometry.
    await page.locator('.gs-rig').first().evaluate(el=>{el.style.width='384px';});
    await page.screenshot({path:path.join(output,'screensaver-rig.png'),clip:await page.locator('.gs-rig').first().boundingBox()});
    await page.locator('.gs-rig').first().evaluate(el=>{el.style.width='';});
    const anchor = await page.locator('.gs-lean').first().evaluate(el=>{window.scaffoldAnchor=el;return true;});
    assert(anchor);
    await page.evaluate(() => { localStorage.setItem('ggo:beta-gnomes','0'); window.dispatchEvent(new StorageEvent('storage',{key:'ggo:beta-gnomes'})); });
    await page.locator('.gs-beta-rig').waitFor({state:'detached'});
    assert(await page.locator('.gs-lean').first().evaluate(el=>el===window.scaffoldAnchor),'Live rollback must preserve the rope anchor');
    await page.evaluate(() => { localStorage.setItem('ggo:beta-gnomes','1'); window.dispatchEvent(new StorageEvent('storage',{key:'ggo:beta-gnomes'})); });
    await page.locator('.gs-beta-rig').first().waitFor();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(() => document.querySelector('.gs-root').getAnimations({subtree:true}).filter(a=>a.playState==='running' && a.effect.getTiming().iterations===Infinity).length===0);
    await page.screenshot({path:path.join(output,'screensaver-reduced-motion.png')});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.gs-root').dataset.paused === 'true');
    assert((await page.locator('.gs-root').evaluate(el=>el.getAnimations({subtree:true}).map(a=>a.playState))).every(s=>s!=='running'),'Hidden scene must stop animating');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.gs-root').dataset.paused === 'false');
    // A role handoff updates the texture even when both roles use a pickaxe.
    runs = runs.map((r,i) => i===5 ? {...r,role:'researcher'} : r);
    socket.send(JSON.stringify({...hello,threads,runs}));
    await page.waitForFunction(() => !document.querySelector('.gs-beta-rig[data-role="reader"]'));
    assert.equal(await page.locator('.gs-beta-rig[data-role="researcher"]').count(),2);
    threads = threads.map((t,i)=> i===0 ? {...t,state:'failed',updatedAt:Date.now()+720_000} : i===1 ? {...t,state:'done',updatedAt:Date.now()+720_000} : t);
    runs = runs.map((r,i)=> i<2 ? {...r,state:'done',endedAt:at+720_000} : r);
    socket.send(JSON.stringify({...hello,threads,runs}));
    await page.locator('.gs-failed .gs-beta-rig').waitFor();
    assert.equal(await page.locator('.gs-failed .gs-tool').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    await page.locator('.gs-done .gs-beta-rig').waitFor();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.gs-root')).opacity)>.99);
    await page.waitForTimeout(1500); // Let the released tool land before the evidence frame.
    await page.screenshot({path:path.join(output,'screensaver-task-states.png')});
    for(const width of [390,768,1440]) {
      await page.setViewportSize({width,height:844});
      await page.waitForFunction(() => document.querySelector('.gs-root').classList.contains('gs-phone') === (innerWidth<=760));
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.gs-root')).opacity)>.99);
      assert((await page.locator('.gs-beta-rig').count())>0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert(await page.locator('.gs-card').evaluateAll(els=>els.every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})),'Every task card must fit inside the viewport');
      await page.screenshot({path:path.join(output,`screensaver-${width}.png`)});
    }
    await page.keyboard.press('Escape');
    await page.locator('.gs-root').waitFor({state:'detached'});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',checks:['default off/no art fetch','General toggle applies to screensaver','six role textures share atlas','independent clip IDs','tool movement','live rollback preserves rope','reduced motion','hidden tab pause','same-tool role handoff','failed/done poses','phone/tablet layout','dismissal','no browser errors'],atlasRequests:atlasRequests.length,evidence:output},null,2));
    await context.close();
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
