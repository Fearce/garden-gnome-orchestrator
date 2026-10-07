// Real CLI parsers -> question storage/events -> browser chips -> same-session continuation.
// Provider processes are replaced at runTurn; no model calls or production data are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot } = require('./lab-harness.cjs');
const PORT = 4457;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const entry = path.resolve(__dirname, '..', process.env.GGO_LAB_ENTRY || 'dist/index.js');
  const load = file => import(pathToFileURL(path.join(path.dirname(entry), file)).href);
  const [{ CodexAgentRun }, { GrokAgentRun }, { ThreadManager }, { Db }, { EventHub }] = await Promise.all([
    load('agents/codexRunner.js'), load('agents/grokRunner.js'), load('orchestrator/threadManager.js'),
    load('db/db.js'), load('events.js'),
  ]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-questions-browser-'));
  const db = new Db(path.join(dataDir, 'questions.sqlite'));
  const hub = new EventHub();
  const manager = Object.assign(Object.create(ThreadManager.prototype), {
    db, hub, pendingQuestions: new Map(), awaitingPrev: new Map(),
    notifyOwner() {}, touchThread() {},
    setState(id, state) { db.updateThread(id, { state }); },
  });
  let child, browser;
  try {
    child = await boot({ dataDir, port: PORT, env: { CODEX_WAKE: 'off' } });
    browser = await loadChromium().launch({ headless: true });
    for (const phone of [false, true]) for (const provider of ['codex', 'grok']) {
      const context = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: phone, hasTouch: phone,
      });
      let unsubscribe = () => {};
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const thread = db.createThread({ title: 'Question chip browser fixture', workspace: dataDir, rawPrompt: 'Check the selected source' });
        db.updateThread(thread.id, { state: 'implementing' });
        let ready;
        const hello = new Promise(resolve => { ready = resolve; });
        await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
          const upstream = socket.connectToServer();
          upstream.onMessage(message => {
            const event = JSON.parse(String(message));
            if (event.type === 'hello') {
              Object.assign(event, { threads: [db.getThread(thread.id)], runs: [], questions: [], findings: [] });
              unsubscribe = hub.subscribe(value => socket.send(JSON.stringify(value)));
              ready();
            }
            socket.send(JSON.stringify(event));
          });
          socket.onMessage(message => {
            const event = JSON.parse(String(message));
            if (event.type === 'question.answer') manager.answerOwnerQuestion(event.questionId, event.answer);
            else upstream.send(message);
          });
        });
        assert.equal((await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } })).ok(), true);
        await page.goto(BASE);
        let helloTimer;
        try {
          await Promise.race([hello, new Promise((_, reject) => {
            helloTimer = setTimeout(() => reject(new Error('Console WebSocket hello did not arrive')), 30_000);
          })]);
        } finally { clearTimeout(helloTimer); }
        for (const kind of ['single', 'multi', 'free']) {
          const question = {
            header: 'Source', question: 'Which source should this task use?',
            options: kind === 'free' ? [] : [{ label: 'Cloud', description: 'Cloud session credits' }, { label: 'API' }],
            multiSelect: kind === 'multi',
          };
          const run = db.createRun({ threadId: thread.id, role: 'implementor', model: 'fixture-model' });
          const cfg = { cwd: dataDir, effort: 'high', onAskUser: input => manager.askUser({ ...input, threadId: thread.id, runId: run.id }) };
          const agent = provider === 'codex'
            ? new CodexAgentRun({ ...cfg, model: 'gpt-6.1-sol', apiKey: '' })
            : new GrokAgentRun({ ...cfg, model: 'grok-4.7' });
          const resumes = [];
          let results = 0;
          agent.sessionId = `fixture-${provider}`;
          agent.turnActive = true;
          agent.sawTerminal = true;
          agent.pendingTerminalResult = { subtype: 'success', isError: false, result: 'Question asked' };
          agent.runTurn = async (prompt, resume) => { resumes.push({ prompt, resume }); };
          agent.onEvent(event => { if (event.type === 'result') results++; });
          const marker = `ASK_USER: ${JSON.stringify(question)}`;
          if (provider === 'codex') agent.handleEvent({ type: 'item.completed', item: { type: 'agent_message', text: marker } });
          else agent.textBuf = marker;
          const closed = agent.onTurnClose(0);
          const modal = page.locator('.modal').filter({ has: page.locator('.q-question') });
          await modal.waitFor({ state: 'visible' });
          assert.equal(db.getThread(thread.id).state, 'awaiting_user');
          assert.equal(results, 0);
          assert.equal(resumes.length, 0);
          assert.equal(await modal.locator('.chip').textContent(), 'Source');
          assert.match(await modal.locator('.q-context').textContent(), /Question chip browser fixture/);
          assert.equal(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
          const q = db.listOpenQuestions().find(value => value.threadId === thread.id);
          assert.equal(q.runId, run.id);
          let expected;
          if (kind === 'single') {
            await modal.getByRole('button', { name: 'Cloud Cloud session credits', exact: true }).click();
            expected = 'Cloud';
          } else if (kind === 'multi') {
            await modal.getByRole('button', { name: 'Cloud Cloud session credits', exact: true }).click();
            await modal.getByRole('button', { name: 'API', exact: true }).click();
            assert.equal(resumes.length, 0, 'selection alone must not answer');
            await modal.getByRole('button', { name: 'Submit', exact: true }).click();
            expected = 'Cloud, API';
          } else {
            await modal.getByPlaceholder('Type your answer…', { exact: true }).fill('Use the test account');
            await modal.getByRole('button', { name: 'Submit', exact: true }).click();
            expected = 'Use the test account';
          }
          await modal.waitFor({ state: 'detached' });
          await closed;
          assert.equal(db.getQuestion(q.id).answer, expected);
          assert.equal(db.getThread(thread.id).state, 'implementing');
          assert.equal(resumes.length, 1);
          assert.equal(resumes[0].resume, agent.sessionId);
          assert.ok(resumes[0].prompt.includes(expected));
          assert.equal(results, 0, 'answer continuation owns completion');
          await agent.stop();
          console.log(`PASS ${phone ? 'phone' : 'desktop'} ${provider} ${kind}: chip, durable answer, held completion and session resume`);
        }
        assert.deepEqual(errors, []);
      } finally { unsubscribe(); await context.close(); }
    }
    console.log('12 browser question flows passed.');
  } finally {
    for (const q of db.listOpenQuestions()) manager.resolveQuestion(q.id, '(test cleanup)');
    db.raw.close();
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      let timer;
      try {
        const exited = await Promise.race([closed.then(() => true), new Promise(resolve => {
          timer = setTimeout(() => resolve(false), 5_000);
        })]);
        if (!exited) {
          if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          else child.kill('SIGKILL');
          await closed;
        }
      } finally { clearTimeout(timer); }
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
