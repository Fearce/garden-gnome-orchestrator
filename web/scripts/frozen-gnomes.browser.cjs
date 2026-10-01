/* Frozen header workers: browser-only fixtures; outgoing mutations never reach the real office.
 * node web/scripts/frozen-gnomes.browser.cjs [http://127.0.0.1:4317]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadChromium } = require('../../server/scripts/findPlaywright.cjs');
const base = process.argv[2] || 'http://127.0.0.1:4317';
const output = path.resolve(__dirname, '../../_beta-gnomes/ice');
const now = Date.now();
const workspace = 'C:\\workshop';
const room = 'repo:c:/workshop';
const cap = (role) => `⏳ Auto-resume pending — all compatible capacity is currently capped for ${role} (${role} stage). Next compatible capacity: in 1h. It will retry automatically.`;
const task = (id, state, error) => ({ id, title: id, state, error, workspace, createdAt: now, updatedAt: now });
const threads = [
  task('frozen-impl', 'review', cap('implementor')),
  {...task('frozen-qa', 'review', cap('QA')), workspace:'C:\\workshop.worktrees\\qa', homeWorkspace:workspace},
  task('human-review', 'review', 'Ready for your review'),
  task('manual-pause', 'paused', cap('planner')),
  task('closed-task', 'closed', cap('researcher')),
  task('active-worker', 'implementing', null),
];
const activeRun = {id:'live-run', threadId:'active-worker', role:'implementor', state:'running', model:'gpt-6.1-sol', startedAt:now};
const onlineOffice = {enabled:true, joined:true, state:'online', url:'', instanceName:'Here', error:null, connectedAt:now,
  sharedRepos:[{repoKey:'workshop', repoLabel:'Workshop', workspaces:[workspace]}],
  remoteAgents:[{key:'visitor', name:'Juniper', role:'qa', title:'Check our project', repoKey:'workshop', repoLabel:'Workshop', instanceId:'north', instanceName:'North studio'}],
  directors:[{instanceId:'north', instanceName:'North studio', name:'Nova', busy:false, agents:1, since:now}]};

(async () => {
  fs.mkdirSync(output, {recursive:true});
  const password = fs.readFileSync(path.resolve(__dirname,'../../server/.env'),'utf8').match(/^AUTH_PASSWORD=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g,'');
  const browser = await loadChromium().launch();
  try {
    for (const mode of ['beta','classic','strip']) {
      const context = await browser.newContext({viewport:{width:1920,height:900},deviceScaleFactor:2});
      await context.addInitScript((mode) => {
        localStorage.setItem('ggo:beta-gnomes',mode==='beta'?'1':'0');
        localStorage.setItem('ggo:classic-workshop',mode==='classic'?'1':'0');
      }, mode);
      assert((await context.request.post(`${base}/api/login`,{data:{password}})).ok());
      let socket, hello;
      const sent=[];
      await context.routeWebSocket('**/ws', client => {
        socket=client;
        const server=client.connectToServer();
        client.onMessage(raw => {
          const msg=JSON.parse(String(raw)); sent.push(msg);
          if(msg.type==='chat.history') client.send(JSON.stringify({type:'chat.history',room:msg.room,messages:[],hasMore:false}));
        });
        server.onMessage(raw => {
          const msg=JSON.parse(String(raw)); if(msg.type!=='hello') return;
          hello={...msg,threads,runs:[activeRun],findings:[],questions:[],director:[],chat:[],chatRooms:[],goals:[],schedules:[],notes:[],coworkSessions:[],onlineOffice,
            directorBusy:false,directorIdleSince:now,settings:{...msg.settings,directorName:'Merlin'},
            nameOverrides:{'frozen-impl::implementor':'Frosty builder','frozen-qa::qa':'Frosty QA'}};
          client.send(JSON.stringify(hello));
        });
      });
      const page=await context.newPage(), errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base);
      const frozen=page.locator('.office [data-frozen="true"]');
      await frozen.first().waitFor();
      assert.equal(await frozen.count(),2,`${mode}: only real capacity parks freeze`);
      assert.equal(await frozen.locator('.gnome-ice').count(),2,`${mode}: both workers are encased`);
      assert.equal(await frozen.evaluateAll(els=>els.flatMap(el=>el.getAnimations({subtree:true})).length),0,`${mode}: nothing walks or works inside the ice`);
      assert.match(await frozen.first().getAttribute('title'),/Next compatible capacity: in 1h/);
      assert.match(await frozen.nth(1).innerText(),/workshop/,'Worktree retains its home project label');
      assert.equal(await page.locator('[data-agent-id^="visiting-director:"], .beta-directors-table').count(),0);
      const height=await page.locator('.topbar').evaluate(el=>el.getBoundingClientRect().height);
      if(mode!=='strip') {
        assert.equal(await page.locator('[data-agent-id="active-worker"]').getAttribute('data-partner'),'north:visitor','Frozen colleagues must not separate working partners');
        assert.equal(await frozen.locator('[data-partner]').count(),0);
        if(mode==='beta') assert.equal(await page.locator('[data-agent-id="frozen-qa"] .beta-gnome').getAttribute('data-role'),'qa','Frozen QA keeps the QA hat');
        await page.getByRole('button',{name:/Show all .* workshop gnomes/}).click();
        assert.equal(await page.locator('.beta-workshop-roster [data-frozen="true"]').count(),2);
        await page.getByRole('button',{name:'Close workshop crew'}).click();
      }
      await page.locator('.office').screenshot({path:path.join(output,`${mode}-frozen.png`)});
      await frozen.first().click();
      await page.locator('.office-panel').waitFor();
      assert(sent.some(m=>m.type==='chat.history'&&m.room===room),'Ice remains a project chat shortcut');
      await page.locator('.office-panel').getByRole('button',{name:'Close',exact:true}).click();
      // A run can arrive before the thread clears its cap marker: never draw the worker twice.
      const resumed={id:'qa-resumed',threadId:'frozen-qa',role:'qa',state:'running',model:'gpt-6.1-sol',startedAt:now+1};
      socket.send(JSON.stringify({type:'run.upsert',run:resumed}));
      await page.waitForFunction(()=>document.querySelectorAll('.office [data-frozen="true"]').length===1);
      socket.send(JSON.stringify({type:'thread.upsert',thread:{...threads[1],state:'qa',error:null}}));
      if(mode!=='strip') {
        const thawed=page.locator('[data-agent-id="frozen-qa"]');
        assert.equal(await thawed.count(),1,'Thawed gnome appears exactly once');
        assert.equal(await thawed.getAttribute('data-working'),'true');
        assert.equal(await thawed.locator('.gnome-ice').count(),0);
      }
      assert.equal(await page.locator('.topbar').evaluate(el=>el.getBoundingClientRect().height),height,'Thaw adds no header height');
      socket.send(JSON.stringify({type:'thread.upsert',thread:threads[1]}));
      socket.send(JSON.stringify({type:'run.upsert',run:{...resumed,state:'error',endedAt:now+2}}));
      await page.waitForFunction(()=>document.querySelectorAll('.office [data-frozen="true"]').length===2);
      if(mode!=='strip') {
        for(const width of [390,900,1440]) {
          await page.setViewportSize({width,height:900}); await page.waitForTimeout(150);
          assert.equal(await page.locator('.office-beta').evaluate(el=>el.getBoundingClientRect().height),48);
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${mode}/${width}: no page overflow`);
          await page.getByRole('button',{name:/Show all .* workshop gnomes/}).click();
          assert.equal(await page.locator('.beta-workshop-roster [data-frozen="true"] .gnome-ice').count(),2,'Crowded frozen workers remain reachable');
          await page.getByRole('button',{name:'Close workshop crew'}).click();
        }
        await page.setViewportSize({width:1920,height:900});
        // An entirely capped crew remains in the header, even though there are no active runs.
        socket.send(JSON.stringify({...hello,threads:threads.slice(0,2),runs:[],onlineOffice:{...onlineOffice,remoteAgents:[]}}));
        await page.waitForFunction(()=>document.querySelectorAll('.beta-workstation').length===3);
        assert.equal(await frozen.count(),2);
        await page.locator('.office').screenshot({path:path.join(output,`${mode}-all-frozen.png`)});
        await page.emulateMedia({reducedMotion:'reduce'});
        assert.equal(await frozen.evaluateAll(els=>els.flatMap(el=>el.getAnimations({subtree:true})).length),0);
      }
      socket.send(JSON.stringify({type:'thread.upsert',thread:{...threads[0],state:'paused'}}));
      socket.send(JSON.stringify({type:'thread.upsert',thread:{...threads[1],state:'closed'}}));
      await page.waitForFunction(()=>document.querySelectorAll('.office [data-frozen="true"]').length===0);
      assert.deepEqual(errors,[]);
      console.log(`PASS ${mode}: capacity parks only, still ice, role/project identity, shared partners, chat, thaw/re-freeze, compact layout, pause/close`);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(`Screenshots: ${output}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
