/* Authenticated UI regression. Fixtures stay in this browser's WebSocket; no tasks are dispatched.
 * node web/scripts/beta-gnomes.browser.cjs [http://127.0.0.1:4317]
 * :4317 serves master's build. For uncommitted web code, run `npx vite --port 4391 --strictPort` in web/
 * (it proxies /api and /ws to :4317) and pass http://127.0.0.1:4391.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadChromium } = require('../../server/scripts/findPlaywright.cjs');
const base = process.argv[2] || 'http://127.0.0.1:4317';
const output = path.resolve(__dirname, '../../_beta-gnomes');
const at = Date.now();
const workspace = 'C:\\workshop';
const room = 'repo:c:/workshop';
const roles = ['planner', 'implementor', 'qa', 'researcher', 'reader', 'reviewer', 'implementor', 'qa', 'planner'];
const names = ['Otto', 'Bram', 'Pippa', 'Fern', 'Lumi', 'Sage', 'Milo', 'Iris', 'Wren'];
const threads = roles.map((role, i) => ({ id: `beta-fixture-${i}`, title: ['Sketch the next adventure', 'Build the garden workshop', 'Inspect the new release', 'Explore new possibilities', 'Read the field notes', 'Review the craftsmanship'][i % 6], state: role === 'qa' ? 'qa' : 'implementing', workspace, brief: 'Browser-only visual fixture', rawPrompt: 'Browser-only visual fixture', createdAt: at, updatedAt: at, priority: 0 }));
const runs = roles.map((role, i) => ({ id: `beta-run-${i}`, threadId: threads[i].id, role, state: 'running', model: 'gpt-6.1-sol', accountId: null, startedAt: at }));
const onlineOffice = { enabled: true, joined: true, state: 'online', url: '', instanceName: 'Here', error: null, connectedAt: at, sharedRepos: [{repoKey:'workshop',repoLabel:'Workshop',workspaces:[workspace]}], remoteAgents: [{ key: 'visitor', name: 'Juniper', role: 'qa', title: 'Check the shared project', repoKey: 'workshop', repoLabel: 'Workshop', instanceId: 'remote-1', instanceName: 'North studio' }], directors: [{instanceId:'remote-2',instanceName:'Moonlight office',name:'Nova',agents:0,since:at}] };

(async () => {
  fs.mkdirSync(output, {recursive:true});
  const browser = await loadChromium().launch({headless:true});
  try {
    // Leave room for the visitor/pair assertions; compact widths are exercised below.
    const context = await browser.newContext({viewport:{width:1920,height:1000}});
    const env = fs.readFileSync(path.resolve(__dirname, '../../server/.env'),'utf8');
    const password = env.match(/^AUTH_PASSWORD=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g,'');
    const login = await context.request.post(`${base}/api/login`,{data:{password}});
    assert.equal(login.ok(),true,`Login failed (${login.status()})`);
    let currentSocket;
    let hello;
    const sent = [];
    await context.routeWebSocket('**/ws', socket => {
      currentSocket = socket;
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const msg=JSON.parse(String(raw)); sent.push(msg);
        // No browser action can send a mutation into the real office.
        if (msg.type === 'chat.history') socket.send(JSON.stringify({type:'chat.history',room:msg.room,messages:[],hasMore:false}));
      });
      server.onMessage(raw => {
        const msg=JSON.parse(String(raw));
        if(msg.type !== 'hello') return;
        hello={...msg,threads,runs,findings:[],questions:[],director:[],chat:[],chatRooms:[],schedules:[],goals:[],notes:[],coworkSessions:[],onlineOffice,nameOverrides:Object.fromEntries(roles.map((role,i)=>[`${threads[i].id}::${role}`,names[i]])),settings:{...msg.settings,directorName:'Merlin'},directorStatus:null,directorBusy:true,directorIdleSince:null};
        socket.send(JSON.stringify(hello));
      });
    });
    const page = await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const artRequests=[]; page.on('request',r=>{if(r.url().includes('workshop-cast'))artRequests.push(r.url());});
    await page.goto(base);
    await page.locator('.office-strip').waitFor();
    await page.locator('.office-huddle').first().waitFor();
    const classicHeight = await page.locator('.topbar').evaluate(el=>el.getBoundingClientRect().height);
    assert.equal(await page.locator('.beta-workshop').count(),0);
    assert.equal(artRequests.length,0,'Off mode must not fetch the atlas');
    await page.getByRole('button',{name:'Open settings',exact:true}).click();
    const general=page.locator('[data-settings-panel="general"]');
    const switchControl=general.getByRole('switch',{name:'Beta gnomes',exact:true});
    await switchControl.waitFor();
    assert.equal(await switchControl.isChecked(),false);
    await switchControl.click();
    await page.locator('.beta-workshop').waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('ggo:beta-gnomes')),'1');
    await page.screenshot({path:path.join(output,'general.png')});
    await page.keyboard.press('Escape');
    await page.reload();
    await page.locator('.beta-workshop').waitFor();
    await page.locator('.beta-workstation[data-office-room="repo:c:/workshop"]').first().waitFor();
    assert.equal(await page.locator('.beta-workshop').evaluate(el=>el.getBoundingClientRect().height),48,'Workshop must be exactly one gnome high');
    const betaHeight=await page.locator('.topbar').evaluate(el=>el.getBoundingClientRect().height);
    assert(betaHeight <= classicHeight + 16,`Beta must not add header rows or padding (${classicHeight}px classic, ${betaHeight}px beta)`);
    await page.screenshot({path:path.join(output,'workshop-desktop.png')});
    const portrait=await page.locator('.director-avatar .beta-gnome').boundingBox();
    const directorTitle=await page.locator('.rail-head-title').boundingBox();
    assert.equal(portrait.width,44,'Director should have a larger portrait');
    assert(directorTitle.x>=portrait.x+portrait.width,'Director text should sit to the right of its portrait');
    await page.locator('.rail-head').screenshot({path:path.join(output,'director-larger.png')});
    assert.equal(await page.locator('.beta-destination').count(),await page.locator('.beta-workstation').count());
    assert.match(await page.locator('.beta-workstation[data-office-room="repo:c:/workshop"] .beta-destination').first().innerText(),/workshop/);
    assert.match(await page.locator('.beta-visitor .beta-destination').first().innerText(),/North studio|Moonlight office/);
    assert((await page.locator('.beta-workstation').count())<=7,'Crowd must be bounded');
    assert((await page.locator('.beta-visitor').count())>=1,'Visitors must have reserved places when space permits');
    const visitorPartner = await page.locator('.beta-visitor').first().getAttribute('data-partner');
    assert(visitorPartner?.startsWith('beta-fixture-'), 'A remote teammate pairs with a local worker even in a crowded repo');
    // Verify actual travel and a synchronized rendezvous, not merely that CSS is animating.
    const movement=await page.locator('.beta-workstation[data-partner]').first().evaluate(el=>{
      const animation=el.getAnimations().find(a=>a.animationName==='beta-journey');
      const timing=animation.effect.getTiming(); const previous=animation.currentTime;
      animation.currentTime=timing.delay; const start=el.getBoundingClientRect().x;
      animation.currentTime=timing.delay+Number(timing.duration)*.3; const meet=el.getBoundingClientRect().x;
      animation.currentTime=previous; return Math.abs(meet-start);
    });
    assert(movement>=15,`Gnome must walk visibly toward its teammate (${movement}px)`);
    assert((await page.locator('.beta-shared-project').count())>0,'Teammates need a shared work object');
    await page.locator('.beta-workshop').evaluate(el=>{
      window.betaTestTimelines=el.getAnimations({subtree:true}).map(animation=>({animation,time:animation.currentTime}));
      for(const {animation} of window.betaTestTimelines){const timing=animation.effect.getTiming();animation.currentTime=timing.delay+Number(timing.duration)*.35;}
    });
    const meeting=await page.locator('.beta-workstation[data-partner]').first().evaluate(el=>{
      const partner=[...document.querySelectorAll('.beta-workstation')].find(other=>other.dataset.agentId===el.dataset.partner);
      return Math.abs(partner.getBoundingClientRect().x-el.getBoundingClientRect().x);
    });
    assert(Math.abs(meeting-34)<2,`Partners must meet shoulder to shoulder (${meeting}px)`);
    assert(Number(await page.locator('.beta-shared-project').first().evaluate(el=>getComputedStyle(el).opacity))>.9,'Shared sheet must appear during the rendezvous');
    await page.locator('.beta-workshop').screenshot({path:path.join(output,'workshop-cooperation.png')});
    await page.evaluate(()=>{for(const {animation,time} of window.betaTestTimelines)animation.currentTime=time;delete window.betaTestTimelines;});
    await page.getByRole('button',{name:/Show all .* workshop gnomes/}).click();
    assert.equal(await page.locator('.beta-workshop-roster > button').count(),11);
    assert.match(await page.locator('.beta-destination-path').allTextContents().then(xs=>xs.join('\n')),/C:\\workshop/);
    await page.getByRole('button',{name:'Close workshop crew'}).click();
    const fresh={id:'beta-message',room,scope:'project',kind:'chat',body:'The new build is ready for a careful inspection.',role:'qa',senderName:'Juniper',remoteInstance:'North studio',createdAt:Date.now()};
    currentSocket.send(JSON.stringify({type:'chat.message',message:fresh}));
    await page.locator('.beta-workshop-message.has-message').waitFor();
    assert.match(await page.locator('.beta-workshop-message').innerText(),/Juniper · North studio/);
    await page.locator('.beta-workshop').screenshot({path:path.join(output,'workshop-closeup.png')});
    await page.locator('.beta-workstation[data-office-room="repo:c:/workshop"]').first().click();
    await page.locator('.office-panel').waitFor();
    assert.equal(sent.some(m=>m.type==='chat.history' && m.room===room),true,'Seat must open its project room');
    await page.locator('.office-panel').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Pause workshop animations'}).click();
    const states=await page.locator('.beta-workshop').evaluate(el=>el.getAnimations({subtree:true}).map(a=>a.playState));
    assert(states.every(s=>s==='paused'),'Pause control must pause all workshop animations');
    await page.getByRole('button',{name:'Resume workshop animations'}).click();
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.beta-workshop').evaluate(el=>el.getAnimations({subtree:true}).length),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('.beta-workshop').evaluate(el=>{el.style.transform='translateY(-3000px)';});
    await page.waitForFunction(()=>document.querySelector('.beta-workshop')?.dataset.paused==='true');
    assert((await page.locator('.beta-workshop').evaluate(el=>el.getAnimations({subtree:true}).map(a=>a.playState))).every(s=>s==='paused'));
    await page.locator('.beta-workshop').evaluate(el=>{el.style.transform='';});
    await page.waitForFunction(()=>document.querySelector('.beta-workshop')?.dataset.paused==='false');
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    assert((await page.locator('.beta-workshop').evaluate(el=>el.getAnimations({subtree:true}).map(a=>a.playState))).every(s=>s==='paused'));
    await page.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});
    // Reproduce a local worktree + a different local repo separating its remote QA teammate.
    // Unrelated remote workers arrive first; online directors must not take any of their places.
    const teamThreads = [
      {...threads[0], workspace:'C:\\workshop.worktrees\\feature', homeWorkspace:workspace},
      {...threads[1], workspace:'C:\\garden'},
    ];
    const teamOffice = {...onlineOffice,
      directors: [onlineOffice.directors[0], {...onlineOffice.directors[0], instanceId:'busy-director', busy:true}],
      remoteAgents: [
        {...onlineOffice.remoteAgents[0], key:'other-repo', repoKey:'other', repoLabel:'Garden elsewhere'},
        onlineOffice.remoteAgents[0],
      ],
    };
    for (const artwork of ['beta','classic']) {
      await page.evaluate((art) => {
        for (const [key,value] of [['ggo:classic-workshop',art==='classic'?'1':'0'],['ggo:beta-gnomes',art==='beta'?'1':'0']]) {
          localStorage.setItem(key,value); window.dispatchEvent(new StorageEvent('storage',{key}));
        }
      }, artwork);
      for (const busy of [true,false]) {
        currentSocket.send(JSON.stringify({...hello,threads:teamThreads,runs:runs.slice(0,2),onlineOffice:teamOffice,directorBusy:busy,directorIdleSince:busy?null:Date.now()}));
        await page.waitForFunction(({art,busy}) => document.querySelector('.beta-workshop')?.dataset.art===art && document.querySelector('.beta-workshop')?.getAttribute('aria-label')===`Workshop: ${busy?5:4} at work, 2 online` && document.querySelector('[data-agent-id="director"]')?.dataset.working===String(busy), {art:artwork,busy});
        for (const width of [1280,1440,1920]) {
          await page.setViewportSize({width,height:900});
          await page.waitForTimeout(150); // ResizeObserver must finish choosing this viewport's cast.
          assert.equal(await page.locator('[data-agent-id^="visiting-director:"], .beta-directors-table').count(),0,'No remote director or table in the lane');
          assert.equal(await page.locator('.beta-workshop').evaluate(el=>el.getBoundingClientRect().height),48,'Still one gnome high');
          const capacity=await page.locator('.beta-workshop-stage').evaluate(el=>Math.floor(el.clientWidth/156));
          if(capacity<3) continue; // Owner + two partners cannot fit; the crew roster remains available.
          const local = page.locator(`[data-agent-id="${threads[0].id}"]`);
          const remote = page.locator('[data-agent-id="remote-1:visitor"]');
          await remote.waitFor();
          await page.waitForFunction((id)=>document.querySelector(`[data-agent-id="${id}"]`)?.dataset.partner==='remote-1:visitor',threads[0].id);
          assert.equal(await remote.getAttribute('data-partner'),threads[0].id,`${artwork}/${width}: mutual cross-office partners`);
          assert.equal(await remote.getAttribute('data-office-room'),room,'Remote worker routes to the local project room');
          assert.match(await remote.locator('.beta-destination').innerText(),/workshop\s+↗ North studio/);
          await page.locator('.beta-workshop').evaluate(el=>{
            for (const animation of el.getAnimations({subtree:true})) {const t=animation.effect.getTiming(); animation.currentTime=t.delay+Number(t.duration)*.35;}
          });
          const a=await local.boundingBox(),b=await remote.boundingBox();
          assert(Math.abs(Math.abs(a.x-b.x)-34)<2,`${artwork}/${width}: remote and local meet shoulder to shoulder`);
          await page.locator('.topbar').screenshot({path:path.join(output,`cross-office-${artwork}-${busy?'busy':'idle'}-${width}.png`)});
        }
      }
      await page.getByRole('button',{name:/Show all .* workshop gnomes/}).click();
      assert.equal(await page.locator('.beta-workshop-roster > button').count(),5,'Roster counts only owner and workers');
      await page.getByRole('button',{name:'Close workshop crew'}).click();
      sent.length = 0;
      await page.locator('[data-agent-id="remote-1:visitor"]').click();
      await page.locator('.office-panel').waitFor();
      assert(sent.some(m=>m.type==='chat.history' && m.room===room),'Remote teammate opens shared chat');
      await page.locator('.office-panel').getByRole('button',{name:'Close',exact:true}).click();
    }
    await page.evaluate(()=>{
      for(const [key,value] of [['ggo:classic-workshop','0'],['ggo:beta-gnomes','1']]) {localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key}));}
    });
    currentSocket.send(JSON.stringify(hello));
    await page.locator('.beta-workshop[data-art="beta"]').waitFor();
    for(const width of [390,768,1440,1920]) {
      await page.setViewportSize({width,height:900});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      assert.equal(overflow,false,`Page overflows at ${width}px`);
      const sceneWidth=await page.locator('.beta-workshop').evaluate(el=>el.clientWidth);
      assert(sceneWidth>=65,`Workshop squeezed to ${sceneWidth}px at ${width}px`);
      assert.equal(await page.locator('.office-beta').evaluate(el=>el.getBoundingClientRect().height),48,`Extra vertical space at ${width}px`);
      await page.screenshot({path:path.join(output,`workshop-${width}.png`)});
    }
    // Measure the running scene (not a claimed universal frame-rate guarantee).
    const cdp=await context.newCDPSession(page); await cdp.send('Performance.enable');
    const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const before=await metrics();
    const frames=await page.evaluate(()=>new Promise(resolve=>{const intervals=[];let previous=performance.now();const start=previous;function frame(now){intervals.push(now-previous);previous=now;if(now-start<1500)requestAnimationFrame(frame);else resolve(intervals.slice(1));}requestAnimationFrame(frame);}));
    const after=await metrics(); frames.sort((a,b)=>a-b);
    const performance={sampleMs:Math.round((after.Timestamp-before.Timestamp)*1000),mainThreadMs:Math.round((after.TaskDuration-before.TaskDuration)*1000),frameIntervalP95Ms:Math.round(frames[Math.floor(frames.length*.95)]),animations:await page.locator('.beta-workshop').evaluate(el=>el.getAnimations({subtree:true}).length)};
    fs.writeFileSync(path.join(output,'performance.json'),JSON.stringify(performance,null,2));
    currentSocket.send(JSON.stringify({type:'office.online',office:{...onlineOffice,state:'off'}}));
    await page.waitForFunction(()=>document.querySelectorAll('.beta-visitor').length===0);
    // A message in an idle office still expires; no active worker interval can hide the bug.
    currentSocket.send(JSON.stringify({...hello,threads:[],runs:[],directorBusy:false,directorIdleSince:Date.now(),onlineOffice:{...onlineOffice,remoteAgents:[]},chat:[{...fresh,id:'idle-message',room:'directors',scope:'directors',createdAt:Date.now()-14_000}]}));
    await page.locator('.beta-workshop-message.has-message').waitFor();
    await page.locator('.beta-workshop-message.has-message').waitFor({state:'detached',timeout:4000});
    // Clicking the chatter dismisses it at once; the ↗ still opens its chat.
    const directorsMessage=(id)=>({...fresh,id,room:'directors',scope:'directors',createdAt:Date.now()});
    currentSocket.send(JSON.stringify({type:'chat.message',message:directorsMessage('dismiss-me')}));
    await page.locator('.beta-message-dismiss').click({timeout:3000});
    await page.locator('.beta-workshop-message').waitFor({state:'detached',timeout:1000});
    await page.waitForTimeout(50);
    currentSocket.send(JSON.stringify({type:'chat.message',message:directorsMessage('open-me')}));
    await page.locator('.beta-workshop-message.has-message').waitFor();
    await page.locator('.beta-workshop-message').screenshot({path:path.join(output,'chatter-card.png')});
    sent.length=0;
    await page.getByRole('button',{name:'Open this chat',exact:true}).click();
    await page.locator('.office-panel').waitFor();
    assert(sent.some(m=>m.type==='chat.history' && m.room==='directors'),'↗ opens the message room');
    assert.equal(await page.locator('.beta-workshop-message').count(),0,'Opening the chat also clears the chatter');
    await page.locator('.office-panel').getByRole('button',{name:'Close',exact:true}).click();
    // Cross-tab preference and live rollback.
    const second = await context.newPage(); await second.goto(base); await second.locator('.beta-workshop').waitFor();
    await page.evaluate(()=>localStorage.setItem('ggo:beta-gnomes','0'));
    await second.locator('.office-strip').waitFor();
    await page.reload(); await page.locator('.office-strip').waitFor();
    assert.equal(await page.locator('.beta-gnome').count(),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',checks:['default off/no atlas request','General toggle','persistence','larger director and shifted text','visible destination labels and full folder paths','48px lane/no added header rows','visible walking and shared projects','bounded crowd and online visitors','messages and room navigation','pause/reduced motion','hidden tab and offscreen pause','390/768/1440/1920 layout','offline visitors removed','idle bubble expiry','click dismisses chatter','chatter ↗ opens chat','cross-tab rollback','no browser errors'],performance,atlasRequests:artRequests.length,evidence:output},null,2));
    await context.close();
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
