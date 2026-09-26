// Read-only live startup measurements. Never clicks or sends a user/agent command.
// npm run probe:startup
// ORCH_URL can include a proxy mount; PERF_OUT overrides the JSON report path.
// PERF_ALLOW_LOCAL_CERT=1 permits the local dashboard's development TLS certificate.
// Phone emulation: 390x844 touch, 4x CPU slowdown, 80ms latency, 10 Mbps download.
const fs = require('node:fs');
const path = require('node:path');
const { loadChromium, authPassword } = require('../../server/scripts/lab-harness.cjs');
const password = process.env.ORCH_PASSWORD || authPassword();
(async () => {
  const browser = await loadChromium().launch({ headless: true });
  const results = [];
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? {width:390,height:844} : {width:1600,height:1000}, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors:process.env.PERF_ALLOW_LOCAL_CERT === '1' });
      const base = (process.env.ORCH_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
      const login = await context.request.post(base + '/api/login', { data: { password } });
      if (!login.ok()) throw new Error('Login failed ' + login.status());
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      if (mobile) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {offline:false,latency:80,downloadThroughput:1250000,uploadThroughput:625000});
        await cdp.send('Emulation.setCPUThrottlingRate', { rate:4 });
      }
      await page.addInitScript(() => {
        window.__perf = { longTasks: [], hello: [] };
        new PerformanceObserver(list => list.getEntries().forEach(e => window.__perf.longTasks.push({start:e.startTime,ms:e.duration}))).observe({type:'longtask',buffered:true});
        const WS = window.WebSocket;
        window.WebSocket = class extends WS {
          constructor(...args) { super(...args); this.addEventListener('message', e => { if (typeof e.data === 'string' && e.data.includes('"type":"hello"')) window.__perf.hello.push({at:performance.now(),bytes:e.data.length}); }); }
        };
      });
      const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      for (const cache of ['cold','warm']) {
        await page.goto(base+'/', {waitUntil:'load',timeout:60000});
        await page.waitForSelector('.accounts .acct', {timeout:60000});
        const ready = await page.evaluate(()=>performance.now());
        await page.waitForTimeout(1500);
        const data = await page.evaluate(() => {
          const nav=performance.getEntriesByType('navigation')[0];
          const resources=performance.getEntriesByType('resource');
          return {ttfb:Math.round(nav.responseStart),dcl:Math.round(nav.domContentLoadedEventEnd),paints:performance.getEntriesByType('paint').map(e=>({name:e.name,ms:Math.round(e.startTime)})),bytes:resources.reduce((n,e)=>n+e.transferSize,nav.transferSize),resources:resources.map(e=>({name:e.name.split('/').pop(),bytes:e.encodedBodySize,transfer:e.transferSize,ms:Math.round(e.duration)})).sort((a,b)=>b.bytes-a.bytes).slice(0,15),...window.__perf,dom:document.querySelectorAll('*').length,overflow:document.documentElement.scrollWidth>innerWidth};
        });
        const row={mobile,cache,ready:Math.round(ready),...data,errors:[...errors]};
        results.push(row);
        console.log(JSON.stringify({mobile,cache,ready:row.ready,ttfb:row.ttfb,paints:row.paints,httpTransferBytes:row.bytes,hello:row.hello,longTasks:row.longTasks.length,errors:row.errors,overflow:row.overflow}));
        if (errors.length || data.overflow) process.exitCode=1;
      }
      await context.close();
    }
  } finally { await browser.close(); }
  const out = process.env.PERF_OUT || path.resolve(__dirname,'../../server/data/startup-last.json');
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out, JSON.stringify(results,null,2));
  console.log('Report: ' + out);
})().catch(e=>{console.error(e);process.exitCode=1;});
