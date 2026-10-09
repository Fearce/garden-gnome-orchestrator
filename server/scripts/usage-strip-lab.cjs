// Verify visible desktop burn/reset metrics, minimal added board height, and the compact popover.
// Runs against a throwaway instance with bogus tokens; never touches live tasks.
// npm run usage-strip-lab --prefix server -- --shots data/usage-strip-lab-shots
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require('./lab-harness.cjs');
const PORT = 4523;
const BASE = `http://127.0.0.1:${PORT}`;
const TOGGLE = '.accounts-toggle';
const laidOut = (page, selector) => page.locator(selector).evaluateAll(els => els.some(el => { const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; }));

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-strip-lab-'));
  const keep = process.argv.includes('--keep');
  const shots = shotDir(dataDir);
  console.log(`usage-strip-lab — ${BASE}`);
  try {
    await boot({dataDir, port:PORT});
    const browser = await loadChromium().launch();
    try {
      const context = await browser.newContext({viewport:{width:1440,height:900}});
      await context.addInitScript(() => {
        localStorage.setItem('orch-usage-hidden','1');
        localStorage.setItem('ggo:beta-gnomes','1');
      });
      const at = Date.now();
      const threads = ['implementor','qa','planner','researcher'].map((role,i) => ({id:`usage-fixture-${i}`,title:`${role} at work`,state:'implementing',workspace:'C:\\workshop',brief:'Browser fixture',createdAt:at,updatedAt:at}));
      const runs = threads.map((t,i)=>({id:`usage-run-${i}`,threadId:t.id,role:['implementor','qa','planner','researcher'][i],state:'running',model:'gpt-6.1-sol',startedAt:at}));
      const usage = {fiveHour:34,sevenDay:72,fiveHourReset:at+2*3600000,sevenDayReset:at+3*86400000,updatedAt:at};
      const accounts = ['personal','secondary'].map((label,i)=>({id:`fixture-${i}`,label,...usage,active:i===0,rateLimited:false,stale:i===1,resetCredits:i===0?{available:1,pending:0}:undefined}));
      await context.routeWebSocket(/\/ws(?:\?|$)/, socket => {
        const server = socket.connectToServer();
        socket.onMessage(()=>{}); // No UI action can dispatch a task or redeem a reset.
        server.onMessage(raw=>{
          const msg=JSON.parse(String(raw));
          if(msg.type==='hello') socket.send(JSON.stringify({...msg,accounts,codexUsage:usage,zaiUsage:{...usage,plan:'Lite'},grokUsage:{sevenDay:54,sevenDayReset:usage.sevenDayReset,monthlyUsed:1400,monthlyLimit:15000,monthlyReset:at+12*86400000,plan:'SuperGrok',updatedAt:at},settings:{...msg.settings,codexEnabled:true,codexChatgptLogin:true,grokEnabled:true,grokSignedIn:true,zaiEnabled:true,zaiKeyPresent:true},threads,runs,questions:[],findings:[],director:[],chat:[],chatRooms:[],goals:[],schedules:[],coworkSessions:[],directorStatus:null}));
        });
      });
      const page = await context.newPage();
      const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      const login=await page.request.post(`${BASE}/api/login`,{data:{password:authPassword()}});
      if(!login.ok()) throw new Error(`Login failed (${login.status()})`);
      await page.goto(BASE,{timeout:45000});
      await page.locator('.accounts .acct').first().waitFor();
      await page.locator('.beta-workstation[data-working="true"]').first().waitFor();
      for(const width of [900,1100,1280,1440,1920,2560]) {
        await page.setViewportSize({width,height:900});
        await page.waitForTimeout(150);
        const geometry=await page.evaluate(()=>{
          const rect=selector=>document.querySelector(selector).getBoundingClientRect();
          const accounts=rect('.accounts'),office=rect('.office'),tabs=rect('.board-head'),board=rect('.board');
          const positions=()=>['.topbar','.workbench','.rail','.board-head','.card'].map(s=>document.querySelector(s)?.getBoundingClientRect().top);
          const before=positions();
          document.querySelector('.board-usage').style.display='none';
          const without=positions();
          document.querySelector('.board-usage').style.display='';
          const chips=[...document.querySelectorAll('.accounts .acct')].map(el=>el.getBoundingClientRect());
          const metrics=[...document.querySelectorAll('.accounts .meter-b, .accounts .meter-r')];
          const metricsVisible=metrics.length===20&&metrics.every(el=>{
            const r=el.getBoundingClientRect(),chip=el.closest('.acct').getBoundingClientRect(),css=getComputedStyle(el);
            return r.width>0&&r.height>0&&css.visibility==='visible'&&el.textContent.trim().length>0&&el.scrollWidth<=el.clientWidth+1&&r.top>=chip.top&&r.bottom<=chip.bottom&&r.left>=chip.left&&r.right<=chip.right;
          });
          const tracks=[...document.querySelectorAll('.accounts .meter-track')].map(el=>el.getBoundingClientRect().width);
          const strip=document.querySelector('.accounts');
          const reachable=[...strip.children].every(el=>{
            strip.scrollLeft=el.offsetLeft-strip.offsetLeft;
            const r=el.getBoundingClientRect();
            return r.left>=accounts.left-1&&r.right<=accounts.right+1;
          });
          strip.scrollLeft=0;
          return {height:accounts.height,officeWidth:office.width,below:accounts.top>=office.bottom-1,withinPadding:accounts.top>=board.top&&accounts.bottom<=tabs.top,shellFixed:before.slice(0,3).every((v,i)=>v===without[i]),tabsShift:before[3]-without[3],cardsShift:before[4]-without[4],metricsVisible,noScroll:strip.scrollWidth<=strip.clientWidth+1,shortBars:tracks.length===10&&tracks.every(w=>w>=12&&w<=20),reachable,compact:chips.length===5&&chips.every(r=>r.height<=26.1),pageFits:document.documentElement.scrollWidth<=innerWidth};
        });
        check(`${width}px: usage fits between gnomes and tabs`,geometry.below&&geometry.withinPadding,JSON.stringify(geometry));
        check(`${width}px: header and director stay fixed; tabs/cards move only 10px`,geometry.shellFixed&&Math.abs(geometry.tabsShift-10)<.1&&Math.abs(geometry.cardsShift-10)<.1,JSON.stringify(geometry));
        check(`${width}px: burn pace and reset times are visible and unclipped`,geometry.metricsVisible,JSON.stringify(geometry));
        check(`${width}px: five compact two-line chips with short bars are reachable`,geometry.compact&&geometry.shortBars&&geometry.reachable,JSON.stringify(geometry));
        if(width>=1440) check(`${width}px: all five chips fit without horizontal scrolling`,geometry.noScroll,JSON.stringify(geometry));
        check(`${width}px: gnomes retain their own space`,geometry.officeWidth>=80&&geometry.pageFits,JSON.stringify(geometry));
        check(`${width}px: no desktop usage toggle`,await page.locator(TOGGLE).count()===0);
        await page.screenshot({path:path.join(shots,`desktop-${width}.png`)});
      }
      check('banked reset stays available',await page.locator('.board-usage button.reset-credit').isVisible());
      check('meter hover retains reset, idle and burn details',await page.locator('.board-usage .meter').first().evaluate(el=>/resets in/.test(el.title)&&/burn/.test(el.title)&&el.getAttribute('aria-label')===el.title));
      check('legacy hidden preference is ignored on desktop',await laidOut(page,'.accounts'));
      await page.reload({timeout:45000});
      await page.locator('.accounts .acct').first().waitFor();
      check('usage stays visible after reload',await laidOut(page,'.accounts'));
      await page.emulateMedia({colorScheme:'dark'});
      await page.evaluate(()=>document.documentElement.setAttribute('data-theme','nocturne'));
      check('Nocturne keeps compact usage',await page.locator('.acct').evaluateAll(els=>els.every(el=>el.getBoundingClientRect().height<=26.1)));
      await page.evaluate(()=>document.documentElement.removeAttribute('data-theme'));
      for(const width of [390,800]) {
        await page.setViewportSize({width,height:844});
        await page.locator(TOGGLE).waitFor();
        check(`${width}px: compact usage starts closed`,!(await laidOut(page,'.accounts')));
        await page.click(TOGGLE);
        await page.locator('.accounts.phone-open').waitFor();
        check(`${width}px: gauge opens the unchanged popover`,await laidOut(page,'.accounts.phone-open .acct'));
        await page.screenshot({path:path.join(shots,`compact-${width}.png`)});
        await page.click('.accounts-scrim',{position:{x:10,y:820}});
        await page.locator('.accounts-scrim').waitFor({state:'detached'});
        check(`${width}px: scrim closes the popover`,!(await laidOut(page,'.accounts')));
      }
      await page.setViewportSize({width:1920,height:1000});
      await page.locator('.accounts .acct').first().waitFor();
      check('returning to desktop restores the permanent row',await laidOut(page,'.accounts'));
      await page.click('[aria-label="Toggle top bar detail"]');
      await page.locator('.topbar.focus').waitFor();
      check('focus mode still hides ambient header details',await page.locator('.accounts, .office').count()===0);
      check('focus mode adds no empty usage spacing',await page.locator('.board-usage').evaluate(el=>el.getBoundingClientRect().height===0));
      await page.click('[aria-label="Toggle top bar detail"]');
      await page.locator('.accounts .acct').first().waitFor();
      check('leaving focus mode restores usage and gnomes',await laidOut(page,'.office'));
      check('no browser errors',errors.length===0,errors.join(' | '));
      console.log(`Screenshots: ${shots}`);
      await context.close();
    } finally { await browser.close(); }
    return check.summary();
  } finally {
    killInstance(PORT);
    const resolved=path.resolve(dataDir);
    const tempRoot=path.resolve(os.tmpdir())+path.sep;
    if(!keep && resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('usage-strip-lab-')) fs.rmSync(resolved,{recursive:true,force:true});
  }
}
main().then(code=>process.exit(code),err=>{console.error(err);killInstance(PORT);process.exit(1);});
