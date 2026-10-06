// Exercise prepaid switches through the real UI, WebSocket, SQLite and an isolated restart.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {loadChromium,authPassword,requireBuild,boot,killInstance,createChecks,waitForPersisted} = require("./lab-harness.cjs");
const port=6151, base=`http://127.0.0.1:${port}`, check=createChecks();
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"credit-spending-lab-"));
async function open(page) {
 const r=await page.request.post(`${base}/api/login`,{data:{password:authPassword()}});
 if(!r.ok())throw Error(`Login HTTP ${r.status()}`);
 await page.goto(base);
 await page.click('[aria-label="Open settings"]');
 await page.waitForFunction(() => [...document.querySelectorAll('[data-settings-category="subscriptions"], .settings-mobile-nav select[aria-label="Settings category"]')].some(el => el.getBoundingClientRect().width > 0));
 const rail=page.locator('[data-settings-category="subscriptions"]');
 if(await rail.isVisible())await rail.click();
 else await page.selectOption('.settings-mobile-nav select[aria-label="Settings category"]',"subscriptions");
}
(async()=>{
 requireBuild();killInstance(port);let browser;
 try {
 await boot({dataDir:dir,port});browser=await loadChromium().launch();
 const ctx=await browser.newContext({viewport:{width:1440,height:900}}), page=await ctx.newPage();
 await open(page);
 const switches=page.getByRole("switch",{name:/Allow credits to be spent for/});
 check("one switch per Claude subscription and Codex",await switches.count()===3);
 for(let i=0;i<3;i++)check(`switch ${i+1} defaults off`,await switches.nth(i).getAttribute("aria-checked")==="false");
 const codex=page.getByRole("switch",{name:"Allow credits to be spent for codex",exact:true});
 await codex.click();
 const stored=await waitForPersisted(dir,"setting_allow_credit_spending");
 check("Codex switch crosses WebSocket and persists",JSON.parse(stored).codex===true);
 await page.reload();await page.click('[aria-label="Open settings"]');await page.click('[data-settings-category="subscriptions"]');
 check("switch survives page reload",await codex.getAttribute("aria-checked")==="true");
 await ctx.close();killInstance(port);await boot({dataDir:dir,port});
 const phone=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}), mobile=await phone.newPage();
 await open(mobile);
 const m=mobile.getByRole("switch",{name:"Allow credits to be spent for codex",exact:true});
 check("switch survives server restart on phone",await m.getAttribute("aria-checked")==="true");
 await m.click();
 const deadline=Date.now()+15000;let off=false;
 while(Date.now()<deadline){const value=await waitForPersisted(dir,"setting_allow_credit_spending");if(JSON.parse(value).codex===false){off=true;break;}await new Promise(r=>setTimeout(r,100));}
 check("phone can turn credit fallback off durably",off);
 check("Claude prerequisite is explained",await mobile.getByText(/Prepaid balance and auto-reload status have not been verified/).count()===2);
 await phone.close();process.exitCode=check.summary();
 } finally {if(browser)await browser.close();killInstance(port);try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}}
})().catch(e=>{console.error(e);killInstance(port);process.exitCode=1});
