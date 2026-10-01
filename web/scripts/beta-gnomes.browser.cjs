/* Authenticated UI regression. Fixtures stay in this browser's WebSocket; no tasks are dispatched.
 * node web/scripts/beta-gnomes.browser.cjs [http://127.0.0.1:4317]
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
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
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
        hello={...msg,threads,runs,findings:[],questions:[],director:[],chat:[],chatRooms:[],schedules:[],goals:[],notes:[],coworkSessions:[],onlineOffice,nameOverrides:Object.fromEntries(roles.map((role,i)=>[`${threads[i].id}::${role}`,names[i]])),settings:{...msg.settings,directorName:'Merlin'},directorStatus:null};
        socket.send(JSON.stringify(hello));
      });
    });
    const page = await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const artRequests=[]; page.on('request',r=>{if(r.url().includes('workshop-cast'))artRequests.push(r.url());});
    await page.goto(base);
    await page.locator('.office-strip').waitFor();
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
    await page.locator('.beta-workstation-name').filter({hasText:'Bram'}).waitFor();
    await page.screenshot({path:path.join(output,'workshop-desktop.png')});
    assert.equal(await page.locator('.beta-workstation').count(),7,'Crowd must be bounded');
    assert.equal(await page.locator('.beta-visitor').count(),2,'Visitors must have reserved places');
    await page.getByRole('button',{name:/Show all .* workshop gnomes/}).click();
    assert.equal(await page.locator('.beta-workshop-roster > button').count(),12);
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
    for(const width of [390,768,1920]) {
      await page.setViewportSize({width,height:900});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      assert.equal(overflow,false,`Page overflows at ${width}px`);
      const sceneWidth=await page.locator('.beta-workshop').evaluate(el=>el.clientWidth);
      assert(sceneWidth>=300,`Workshop squeezed to ${sceneWidth}px at ${width}px`);
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
    currentSocket.send(JSON.stringify({...hello,threads:[],runs:[],onlineOffice:{...onlineOffice,remoteAgents:[]},chat:[{...fresh,id:'idle-message',room:'directors',scope:'directors',createdAt:Date.now()-14_000}]}));
    await page.locator('.beta-workshop-message.has-message').waitFor();
    await page.locator('.beta-workshop-message.has-message').waitFor({state:'detached',timeout:4000});
    // Cross-tab preference and live rollback.
    const second = await context.newPage(); await second.goto(base); await second.locator('.beta-workshop').waitFor();
    await page.evaluate(()=>localStorage.setItem('ggo:beta-gnomes','0'));
    await second.locator('.office-strip').waitFor();
    await page.reload(); await page.locator('.office-strip').waitFor();
    assert.equal(await page.locator('.beta-gnome').count(),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',checks:['default off/no atlas request','General toggle','persistence','bounded crowd and online visitors','messages and room navigation','pause/reduced motion','hidden tab and offscreen pause','390/768/1440/1920 layout','offline visitors removed','idle bubble expiry','cross-tab rollback','no browser errors'],performance,atlasRequests:artRequests.length,evidence:output},null,2));
    await context.close();
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
