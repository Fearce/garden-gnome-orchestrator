// Real desktop/phone UI; the provider-facing routes are intercepted. Never spends cloud credits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadChromium, authPassword, boot, killInstance, requireFreshWebBuild, createChecks } = require('./lab-harness.cjs');
const PORT = 4455;
const BASE = `http://127.0.0.1:${PORT}`;
const check = createChecks();
const TASK = '10000000-0000-4000-8000-000000000001';
async function pass(browser, phone) {
  const context = await browser.newContext({ viewport: phone ? {width:390,height:844} : {width:1440,height:1000}, isMobile:phone, hasTouch:phone });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let connections = [], jobs = [], sent;
    await page.route('**/api/cloud-sessions**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'PUT') {
        const draft = req.postDataJSON();
        check('browser sends the token only on save', draft.token === 'sk-ant-oat01-lab');
        connections = [{id:'lab',label:draft.label,repository:draft.repository,routineId:'trig_lab',configured:true}];
        return route.fulfill({json:connections[0]});
      }
      if (req.method() === 'DELETE') { connections = []; return route.fulfill({json:{ok:true}}); }
      if (req.method() === 'POST' && url.pathname.endsWith('/jobs')) {
        sent = req.postDataJSON();
        jobs.unshift({id:String(jobs.length),title:sent.title,label:'Cloud A',repository:'example/webapp',createdAt:Date.now(),state:'submitted',sourceThreadId:sent.sourceThreadId || null,url:'https://claude.ai/code/session_lab',error:null});
        return route.fulfill({json:jobs[0]});
      }
      return route.fulfill({json:{connections,jobs,routinePrompt:'Execute the task in the routine-fire-payload block.'}});
    });
    const login = await page.request.post(`${BASE}/api/login`, {data:{password:authPassword()}});
    if (!login.ok()) throw new Error(`Lab login failed: HTTP ${login.status()}`);
    await page.goto(BASE);
    await page.waitForSelector('.accounts .acct',{state:'attached',timeout:60000}).catch(async e=> { console.error('Lab load:',await page.title(),(await page.locator('body').innerText()).slice(0,800),errors.slice(0,4)); throw e; });
    await page.getByRole('button',{name:'Open settings',exact:true}).click();
    if (phone) await page.getByLabel('Settings category',{exact:true}).selectOption('cloud');
    else await page.locator('[data-settings-category="cloud"]').click();
    let panel = page.locator('[data-settings-panel="cloud"] .cloud-sessions');
    check('credit-eligible session is the default',await panel.getByLabel('Dispatch method').inputValue() === 'session');
    await panel.getByLabel('Cloud session repository').fill('example/webapp');
    await panel.getByLabel('Task title',{exact:true}).fill('Review code');
    await panel.getByLabel('Task brief',{exact:true}).fill('Read the parser & report findings.');
    check('handoff requires suitability',await panel.getByRole('link',{name:'Open credit-eligible cloud session',exact:true}).count() === 0);
    await panel.getByRole('checkbox').check();
    const prefill = new URL(await panel.getByRole('link',{name:'Open credit-eligible cloud session',exact:true}).getAttribute('href'));
    check('official prefill includes only repository and edited brief',prefill.origin === 'https://claude.ai' && prefill.searchParams.get('repositories') === 'example/webapp' && prefill.searchParams.get('prompt').includes('parser & report') && !prefill.href.includes('sk-ant-'));
    check('opening form is not claimed as submission',jobs.length === 0 && (await panel.textContent()).includes('does not submit a job'));
    await panel.getByLabel('Task brief',{exact:true}).fill('Long brief '.repeat(1500));
    const longLink = new URL(await panel.getByRole('link',{name:'Open credit-eligible cloud session',exact:true}).getAttribute('href'));
    check('long brief uses copy rather than truncated URL',!longLink.searchParams.has('prompt') && (await panel.textContent()).includes('too long'));
    await panel.getByLabel('Dispatch method').selectOption('routine');
    await panel.getByLabel('Connection label (include the Claude account)').fill('Cloud A');
    await panel.getByLabel('GitHub repository',{exact:true}).fill('example/webapp');
    await panel.getByLabel('Routine fire URL or ID').fill('trig_lab');
    await panel.getByLabel('Routine token',{exact:true}).fill('sk-ant-oat01-lab');
    await panel.getByRole('button',{name:'Add connection',exact:true}).click();
    await panel.getByRole('status').waitFor();
    check('token cleared after saving',await panel.getByLabel('Routine token',{exact:true}).inputValue() === '');
    check('saving a routine starts no task',jobs.length === 0);
    await panel.getByLabel('Task title',{exact:true}).fill('Fix a unit test');
    await panel.getByLabel('Task brief',{exact:true}).fill('Fix the failing parser unit test and open a PR.');
    const launch = panel.getByRole('button',{name:'Start in Claude cloud',exact:true});
    check('suitability confirmation is required',await launch.isDisabled());
    await panel.getByRole('checkbox').check();
    await launch.click();
    await panel.getByRole('link',{name:'Open Claude session',exact:true}).waitFor();
    check('brief is dispatched without local transcript or credentials',sent.cloudReady && !sent.token && sent.prompt.includes('parser'));
    check('submission links use the cloud session',await panel.getByRole('link',{name:'Open Claude session',exact:true}).getAttribute('href') === 'https://claude.ai/code/session_lab');
    check('submitted does not claim completion',(await panel.textContent()).includes('completion checked in Claude'));
    check('credits fallback limitation is visible',(await panel.textContent()).includes('cannot read this balance'));
    check('panel has no horizontal overflow',await panel.evaluate(e=>e.scrollWidth <= e.clientWidth + 1));
    await page.getByRole('button',{name:'Close settings',exact:true}).click();
    await page.locator(`[data-thread-id="${TASK}"]`).click({position:{x:14,y:10}});
    if(phone) await page.getByRole('button',{name:'Expand header',exact:true}).click();
    await page.getByRole('button',{name:'Send to cloud',exact:true}).click();
    const modal = page.getByRole('dialog',{name:'Send task to Claude cloud',exact:true});
    await modal.waitFor();
    await page.waitForFunction(()=>document.querySelector('.cloud-modal textarea')?.value==='Fix repository unit tests',null,{timeout:20000});
    check('paused-task brief is prefilled',await modal.getByLabel('Task brief',{exact:true}).inputValue() === 'Fix repository unit tests');
    check('paused-task handoff defaults to eligible session',await modal.getByLabel('Dispatch method').inputValue() === 'session');
    await modal.getByLabel('Dispatch method').selectOption('routine');
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button',{name:'Start in Claude cloud',exact:true}).click();
    await modal.getByRole('link',{name:'Open Claude session',exact:true}).waitFor();
    check('offload retains source task identity',sent.sourceThreadId === TASK);
    check('duplicate offload is disabled',await modal.getByRole('button',{name:'Start in Claude cloud',exact:true}).isDisabled());
    await modal.getByRole('button',{name:'Close cloud panel',exact:true}).click();
    await page.getByRole('button',{name:'Send to cloud',exact:true}).click();
    await page.getByRole('dialog',{name:'Send task to Claude cloud',exact:true}).getByRole('link',{name:'Open Claude session',exact:true}).waitFor();
    check('reopening restores the cloud link',true);
    check(`${phone?'phone':'desktop'}: no browser errors`,errors.length === 0,errors.join(' | '));
  } finally { await context.close(); }
}
async function main() {
  requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'cloud-sessions-lab-'));
  let browser;
  try {
    await boot({dataDir,port:PORT,env:{CODEX_WAKE:'off'}});
    const db = new Database(path.join(dataDir,'orchestrator.sqlite'));
    const at=Date.now();
    db.prepare("INSERT INTO threads(id,title,state,workspace,brief,raw_prompt,created_at,updated_at) VALUES(?,?,'paused',?,?,?, ?,?)").run(TASK,'Cloud lab paused task',dataDir,'Fix repository unit tests','Fix repository unit tests',at,at);
    db.close();
    browser = await loadChromium().launch({headless:true});
    await pass(browser,false);
    await pass(browser,true);
    return check.summary();
  } finally {
    if(browser) await browser.close().catch(()=>{});
    killInstance(PORT);
    fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
main().then(code=>process.exit(code),e=>{console.error(e);killInstance(PORT);process.exit(2)});
