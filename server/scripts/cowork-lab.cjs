#!/usr/bin/env node
// Lab for the Co-work QoL surfaces (`npm run cowork-lab`). It drives them in a real browser against a
// THROWAWAY instance, because four of the claims are about layout and lifecycle rather than markup:
//
//   1. THE TRANSCRIPT STICKS, AND STOPS STICKING. Auto-scroll to the live end, a "jump to latest" pill
//      the moment the owner scrolls up, and the position remembered per session. `scrollTop` is real
//      layout, so no SSR gate can see it.
//   2. TOOL NOISE IS ACTUALLY FOLDED. The grouping has a unit gate, but "the transcript reads as
//      conversation" is a claim about what is ON SCREEN. This counts the visible rows.
//   3. CLOSING THE POPUP MID-TURN COSTS NOTHING. Esc out, type to the director, reopen the card: same
//      scroll position, same expanded burst, same draft. That round trip IS the workstream.
//   4. THE BOARD CARD IS REAL AND STEERS. It sits in the task lanes as a Co-work card, opens the
//      conversation as a popup over the board (Esc, ✕ or the backdrop close it), and its
//      queue/inject/interrupt controls reach the same command path the composer uses.
//
// The instance is isolated (own PORT + DATA_DIR, bogus account tokens), so nothing here touches the
// owner's data or quota. Seeded rows only; no agent is ever spawned.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadChromium,
  authPassword,
  requireBuild,
  boot,
  killInstance,
  createChecks,
  shotDir,
} = require("./lab-harness.cjs");

const PORT = 5417;
const SESSION = "lab-cowork-session";
const IDLE_SESSION = "lab-cowork-idle";
const TURN = "lab-cowork-turn";
const keep = process.argv.includes("--keep");
const shotsArg = process.argv.indexOf("--shots");
const shotsDir = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

/** A conversation with enough tool traffic that folding it is visibly the point. */
function seed(dataDir, workspace) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const session = db.prepare(
    `INSERT INTO cowork_sessions (id, name, auto_named, workspace, state, requested_provider, requested_model,
       provider, model, effort, account, agent_session_id, active_turn_id, error, created_at, updated_at)
     VALUES (?,?,0,?,?,NULL,NULL,'claude','claude-opus-5-5','high','primary','provider-session',?,NULL,?,?)`,
  );
  session.run(SESSION, "Pair on the responsive shell", workspace, "running", TURN, now - 1_800_000, now - 2_000);
  session.run(IDLE_SESSION, "Earlier exploration", workspace, "idle", null, now - 3_600_000, now - 600_000);

  db.prepare(
    `INSERT INTO cowork_turns (id, session_id, state, provider, model, effort, account, agent_session_id,
       error, cost_usd, num_turns, started_at, ended_at)
     VALUES (?,?,?,'claude','claude-opus-5-5','high','primary','provider-session',NULL,0.42,14,?,NULL)`,
  ).run(TURN, SESSION, "running", now - 135_000);

  const message = db.prepare(
    `INSERT INTO cowork_messages (id, session_id, turn_id, role, kind, content, attachments, meta, partial, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'[]',?,0,?,?)`,
  );
  let seq = 0;
  const at = () => now - 600_000 + (seq += 1) * 900;
  const add = (id, role, kind, content, meta) => {
    const t = at();
    message.run(id, SESSION, TURN, role, kind, content, meta ? JSON.stringify(meta) : null, t, t);
  };

  // A long conversation, so the transcript genuinely scrolls and "jump to latest" has somewhere to go.
  for (let i = 0; i < 8; i++) {
    add(`u${i}`, "user", "text", `Owner instruction ${i + 1}: tighten the layout and keep it verified.`);
    add(`r${i}`, "coworker", "text", `Reply ${i + 1}. Adjusted the shell and re-ran the check.`);
    // A burst of consecutive calls: exactly what used to fill the panel with one box each.
    for (let j = 0; j < 6; j++) {
      const id = `t${i}-${j}`;
      add(`tool-${id}`, "coworker", "tool", "Bash", { id, name: "Bash", input: { command: `npm run check -- --pass ${j}` } });
      add(`res-${id}`, "coworker", "tool_result", `check ${j} ok\nno errors reported`, { id, isError: false });
    }
  }
  // The idle session gets its own short history: promotion is refused on a RUNNING session, so the
  // hand-off has to be exercised on one that has settled.
  const idleAt = now - 700_000;
  message.run("idle-u", IDLE_SESSION, null, "user", "text", "Work out how the responsive shell should behave.", null, idleAt, idleAt);
  message.run("idle-r", IDLE_SESSION, null, "coworker", "text", "Explored it: the grid needs one breakpoint.", null, idleAt + 1_000, idleAt + 1_000);
  db.close();
}

/** Opens a session the way the owner does: its card in the task lanes. */
async function openCowork(page, name) {
  await page.click(`.lanes .cowork-card:has-text("${name}") .cowork-card-open`);
  await page.waitForSelector(".cowork-popup .cowork-transcript", { timeout: 15000 });
}

async function popupClosed(page) {
  await page.waitForSelector(".cowork-popup", { state: "detached", timeout: 10000 });
  return (await page.locator(".cowork-popup").count()) === 0;
}

async function transcriptState(page) {
  return page.evaluate(() => {
    const node = document.querySelector(".cowork-transcript");
    if (!node) return null;
    return {
      top: Math.round(node.scrollTop),
      atBottom: node.scrollHeight - node.scrollTop - node.clientHeight < 8,
      bursts: node.querySelectorAll(".cowork-tools").length,
      openBursts: node.querySelectorAll(".cowork-tools.open").length,
      toolRows: node.querySelectorAll(".cowork-tool-row").length,
      messages: node.querySelectorAll("article.cowork-message").length,
      undelivered: node.querySelectorAll(".cowork-message.pending .delivery-failed").length,
    };
  });
}

/** The director composer, whichever shell class this build uses for the rail. */
async function directorBox(page) {
  for (const selector of [".rail textarea", ".director textarea", ".rail-wrap textarea"]) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return `${selector} >> nth=0`;
  }
  return ".rail textarea";
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-lab-"));
  const shots = shotDir(shotsDir ?? dataDir);
  const workspace = path.resolve(__dirname, "..", "..");
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  // Seed after boot (which creates the schema) but BEFORE the browser connects: the console reads this
  // collection off the `hello` frame, so a row written mid-session would need a reconnect to appear.
  seed(dataDir, workspace);
  const check = createChecks();
  let code = 1;
  let browser;
  try {
    const chromium = loadChromium();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1560, height: 960 } });
    const page = await ctx.newPage();
    // Reproduce a new web bundle talking to the old process while deployment waits for agents.
    let closeMode = "supported";
    let closeCommands = 0;
    await page.routeWebSocket("**/ws", (ws) => {
      const server = ws.connectToServer();
      server.onMessage((raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "hello" && closeMode === "unsupported") delete event.coworkCloseSupported;
        ws.send(JSON.stringify(event));
      });
      ws.onMessage((raw) => {
        const command = JSON.parse(raw.toString());
        if (command.type === "cowork.close" || command.type === "cowork.restore") {
          closeCommands++;
          if (closeMode === "rejected") {
            ws.send(JSON.stringify({ type: "cowork.action", action: command.type.split(".")[1], sessionId: command.sessionId,
              ok: false, error: "Stop the running turn before closing this session.", result: { ok: false } }));
            return;
          }
        }
        server.send(raw);
      });
    });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 });

    // ---- 4a. the card is IN the task lanes, as its own kind of card -------------------------------
    await page.waitForSelector(".lanes .cowork-card", { timeout: 15000 });
    check("there is no separate Co-work tab to switch to", (await page.locator('.board-tab:has-text("Co-work")').count()) === 0);
    const cardText = (await page.textContent(".lanes .cowork-card")) ?? "";
    check("a live session gets a card in the task lanes", cardText.includes("Pair on the responsive shell"), cardText.slice(0, 120));
    check("the card is labelled Co-work", cardText.includes("Co-work"), cardText.slice(0, 160));
    check("the card carries the Co-worker gnome", (await page.locator(".lanes .cowork-card .gnome").count()) === 2);
    const stripe = await page.evaluate(() => {
      const card = document.querySelector(".lanes .cowork-card");
      const probe = document.createElement("span");
      probe.style.color = "var(--role-coworker)";
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { got: getComputedStyle(card, "::before").backgroundColor, want };
    });
    check("the card's stripe is the Co-worker's own colour", stripe.got === stripe.want, JSON.stringify(stripe));
    check("the card names its repo", cardText.includes("garden-gnome-orchestrator"), cardText.slice(0, 160));
    check("the card shows the live state", cardText.includes("working"), cardText.slice(0, 160));
    check("a new session can be started from the board", await page.isVisible('.board-head button:has-text("New Co-work")'));
    const clock = (await page.textContent(".lanes .cowork-card .cowork-card-clock")) ?? "";
    check("the card runs an elapsed clock off the live turn", /\d/.test(clock), clock);
    // The newest CONVERSATIONAL line, not the newest row: six tool calls followed the last reply, and
    // "ran Bash" is not what the owner left the session doing.
    check("the card carries the last conversational line", cardText.includes("Reply 8"), cardText.slice(0, 220));
    check("tool traffic never becomes the card snippet", !cardText.includes("npm run check"), cardText.slice(0, 220));
    check("an idle session from today is on the board too", (await page.locator(".lanes .cowork-card").count()) === 2);
    await page.screenshot({ path: path.join(shots, "01-board-cards.png") });

    // ---- 4b. steering straight from the card ------------------------------------------------------
    await page.click('.lanes .cowork-card:has-text("Pair on the responsive shell") button:text-is("Steer")');
    await page.waitForSelector(".cowork-card-steer textarea", { timeout: 10000 });
    const modes = await page.locator(".cowork-card-steer .cowork-card-actions button").allTextContents();
    check("the card offers queue / inject / interrupt", ["Queue", "Inject", "Interrupt"].every((m) => modes.includes(m)), modes.join(","));
    check("steering stays disabled until there is a direction", await page.isDisabled('.cowork-card-steer button:text-is("Inject")'));
    await page.fill(".cowork-card-steer textarea", "Also check the phone layout.");
    check("typing a direction enables the steering controls", await page.isEnabled('.cowork-card-steer button:text-is("Inject")'));
    await page.screenshot({ path: path.join(shots, "02-card-steering.png") });
    await page.click('.cowork-card-steer button:text-is("Inject")');
    // The seeded turn has no live agent behind it, so the server refuses delivery. What is proven here
    // is that the card reaches the SAME command path the composer uses, not that a phantom agent
    // accepted the direction.
    await page.waitForSelector(".cowork-card-steer", { state: "detached", timeout: 10000 });
    check("the card returns to its resting controls after sending", await page.isVisible('.lanes .cowork-card button:text-is("Steer")'));

    // ---- 4c. the popup opens OVER the board and closes three ways ---------------------------------
    await openCowork(page, "Pair on the responsive shell");
    check("the conversation opens as a popup dialog", await page.isVisible('.cowork-popup[role="dialog"]'));
    check("the task board is still there behind it", await page.isVisible(".lanes"));
    await page.keyboard.press("Escape");
    check("Esc closes the popup", await popupClosed(page));
    await openCowork(page, "Pair on the responsive shell");
    await page.click(".cowork-close");
    check("the ✕ closes the popup", await popupClosed(page));
    await openCowork(page, "Pair on the responsive shell");
    await page.mouse.click(8, 480);
    check("a click on the backdrop closes the popup", await popupClosed(page));
    await openCowork(page, "Pair on the responsive shell");
    await page.click(".cowork-title-button");
    await page.waitForSelector(".cowork-rename-input", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Esc in the rename box cancels the rename, not the conversation", await page.isVisible(".cowork-popup") && !(await page.isVisible(".cowork-rename-input")));

    // ---- 1 + 2. the folded, sticky transcript -----------------------------------------------------
    await page.waitForTimeout(900);
    const opened = await transcriptState(page);
    check("opening a session lands at the live end of the conversation", !!opened?.atBottom, JSON.stringify(opened));
    check("consecutive tool calls fold into one burst each", opened?.bursts === 8, JSON.stringify(opened));
    check("nothing is expanded on arrival, so it reads as conversation", opened?.openBursts === 0 && opened?.toolRows === 0, JSON.stringify(opened));
    check("the conversation itself is fully present", opened?.messages === 16, JSON.stringify(opened));
    // The seeded turn has no live agent, so the card's direction could not be delivered. It stays
    // visible AS undelivered rather than vanishing, which is the same ledger the composer uses.
    check("a direction the server could not deliver stays visible and marked", opened?.undelivered === 1, JSON.stringify(opened));
    const burstLabel = (await page.textContent(".cowork-tools-label")) ?? "";
    check("a folded burst says how long it worked and how much it did", /worked .+ 6 calls/.test(burstLabel), burstLabel);
    check("no jump pill while following the stream", !(await page.isVisible(".cowork-jump")));
    await page.screenshot({ path: path.join(shots, "03-folded-transcript.png") });

    // The LAST burst: it is the one on screen, and clicking a row scrolled far above the viewport is a
    // pointer-interception failure about layout, not about the fold.
    const burst = page.locator(".cowork-tools").last();
    await burst.locator(".cowork-tools-head").click();
    await page.waitForSelector(".cowork-tools.open .cowork-tool-row", { timeout: 10000 });
    const expanded = await transcriptState(page);
    check("opening a burst lists its calls one row each", expanded?.toolRows === 6, JSON.stringify(expanded));
    const row = (await burst.locator(".cowork-tool-row").first().textContent()) ?? "";
    check("each row says what the call did and what came back", row.includes("npm run check") && row.includes("check 0 ok"), row);
    await burst.locator(".cowork-tool-row").first().click();
    await page.waitForSelector(".cowork-tool-detail pre", { timeout: 10000 });
    check("a row opens to the full input and output", ((await page.textContent(".cowork-tool-detail")) ?? "").includes("no errors reported"));
    await page.screenshot({ path: path.join(shots, "04-expanded-burst.png") });

    // ---- 1b. scrolling up stops the stick and offers the way back ---------------------------------
    await page.evaluate(() => { document.querySelector(".cowork-transcript").scrollTop = 200; });
    await page.waitForSelector(".cowork-jump", { timeout: 10000 });
    check("scrolling up reveals the jump-to-latest pill", await page.isVisible(".cowork-jump"));
    const scrolled = await transcriptState(page);
    check("and the view stays where the owner put it", scrolled?.top === 200 && !scrolled.atBottom, JSON.stringify(scrolled));
    await page.screenshot({ path: path.join(shots, "05-jump-pill.png") });

    // ---- 3. close mid-turn, use the rest of the console, come back --------------------------------
    await page.fill(".cowork-composer textarea", "Draft that must survive a trip to the board.");
    await page.keyboard.press("Escape");
    check("closing mid-turn puts the popup away", await popupClosed(page));
    check("the task board is fully usable again", await page.isVisible(".lanes .cowork-card"));
    const box = await directorBox(page);
    check("the director rail is reachable while the turn runs", await page.isVisible(box));
    await page.fill(box, "Director stays reachable mid-turn.");
    check("and the director composer accepts typing", ((await page.inputValue(box)) ?? "").includes("Director stays reachable"));
    await page.screenshot({ path: path.join(shots, "06-board-while-live.png") });

    await openCowork(page, "Pair on the responsive shell");
    await page.waitForTimeout(700);
    const returned = await transcriptState(page);
    check("returning keeps the scroll position the owner chose", returned?.top === 200 && !returned.atBottom, JSON.stringify(returned));
    check("returning keeps the burst the owner expanded", returned?.openBursts === 1 && returned.toolRows === 6, JSON.stringify(returned));
    check("returning keeps the draft", ((await page.inputValue(".cowork-composer textarea")) ?? "").includes("Draft that must survive"));
    check("the jump pill is still offered on return", await page.isVisible(".cowork-jump"));
    await page.click(".cowork-jump");
    await page.waitForTimeout(900);
    const jumped = await transcriptState(page);
    check("the pill returns to the live end", !!jumped?.atBottom, JSON.stringify(jumped));
    check("and hides itself once there", !(await page.isVisible(".cowork-jump")));
    await page.screenshot({ path: path.join(shots, "07-returned.png") });

    // ---- the two hand-offs ------------------------------------------------------------------------
    await page.click('.cowork-chat-head button:has-text("Summary")');
    await page.waitForSelector(".cowork-summary-modal", { timeout: 10000 });
    await page.waitForTimeout(500);
    const summary = (await page.textContent(".cowork-summary-body")) ?? "";
    check("the session trail opens on demand", summary.includes("Session summary"), summary.slice(0, 160));
    check("the trail reports what the conversation touched", summary.includes("Files changed") && summary.includes("Commits"), summary.slice(0, 300));
    check("the trail carries what the owner asked", summary.includes("Owner instruction"), summary.slice(0, 300));
    await page.screenshot({ path: path.join(shots, "08-session-trail.png") });
    await page.click('.cowork-summary-modal button:text-is("Close")');
    await page.waitForSelector(".cowork-summary-modal", { state: "detached", timeout: 10000 });

    // Promotion is refused while a turn is live, so the brief can never describe unsettled work.
    check(
      "a running session cannot be promoted",
      await page.isDisabled('.cowork-chat-head button:has-text("Promote to task")'),
    );
    await page.keyboard.press("Escape");
    await popupClosed(page);
    await openCowork(page, "Earlier exploration");
    await page.waitForTimeout(600);
    await page.click('.cowork-chat-head button:has-text("Promote to task")');
    await page.waitForSelector(".cowork-promote-modal", { timeout: 10000 });
    check(
      "promote prefills the objective from the conversation",
      ((await page.inputValue(".cowork-promote-modal textarea")) ?? "").includes("responsive shell should behave"),
      await page.inputValue(".cowork-promote-modal textarea"),
    );
    await page.fill(".cowork-promote-modal textarea", "Ship the responsive Co-work shell");
    await page.screenshot({ path: path.join(shots, "09-promote.png") });
    await page.click('.cowork-promote-modal button:text-is("Create task")');
    await page.waitForSelector(".cowork-promote-done", { timeout: 25000 });
    check("promoting dispatches a real task", await page.isVisible('.cowork-promote-modal button:text-is("Open the task")'));
    await page.screenshot({ path: path.join(shots, "10-promoted.png") });
    await page.click('.cowork-promote-modal button:text-is("Open the task")');
    await page.waitForSelector(".detail", { timeout: 25000 });
    const detail = (await page.textContent(".detail")) ?? "";
    check("the promoted task opens as an ordinary task", detail.includes("Ship the responsive Co-work shell"), detail.slice(0, 200));
    check("opening the task put the conversation away", (await page.locator(".cowork-popup").count()) === 0);
    check("the conversation itself is untouched by the promotion", await page.isVisible('.lanes .cowork-card:has-text("Earlier exploration")'));
    await page.screenshot({ path: path.join(shots, "11-promoted-task.png") });

    // ---- 5. a Co-work card follows the board's rules: close, restore, drag -------------------------
    if (await page.isVisible(".detail")) await page.click('.detail-title-actions .close-x[aria-label="Close"]');
    check("a live session offers no ✕, like a running task", (await page.locator('.lanes .cowork-card:has-text("Pair on the responsive shell") .card-dismiss').count()) === 0);
    await page.hover('.lanes .cowork-card:has-text("Earlier exploration")');
    await page.click('.lanes .cowork-card:has-text("Earlier exploration") .card-dismiss');
    await page.waitForSelector('.lanes .cowork-card:has-text("Earlier exploration")', { state: "detached", timeout: 10000 });
    check("the ✕ closes an idle session off the board", true);
    check("without opening its conversation", (await page.locator(".cowork-popup").count()) === 0);
    if (!(await page.isVisible(".closed-list"))) await page.click(".closed-toggle");
    await page.waitForSelector('.closed-list .closed-card:has-text("Earlier exploration")', { timeout: 10000 });
    check("it waits in the Closed list beside closed tasks", await page.isVisible('.closed-list .closed-card:has-text("Earlier exploration") button:text-is("Restore")'));
    await page.screenshot({ path: path.join(shots, "12-closed-session.png") });
    await page.click('.closed-list .closed-card:has-text("Earlier exploration") button:text-is("Restore")');
    await page.waitForSelector('.lanes .cowork-card:has-text("Earlier exploration")', { timeout: 10000 });
    check("Restore puts it back on the board", true);

    // Drag-to-reorder is a view setting; turn it on the way the Settings toggle stores it. Under drag the
    // board still groups by the sort's primary key, and every card here shares one repo, so the "Project"
    // sort leaves the order to the drag alone (a created-at sort never ties, so it would override any drag).
    await page.evaluate(() => {
      const raw = localStorage.getItem("director_settings");
      localStorage.setItem("director_settings", JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), taskDragAndDrop: true, taskSort: "workspace" }));
    });
    await page.reload();
    await page.waitForSelector(".lanes .cowork-card.draggable", { timeout: 20000 });
    const order = () => page.$$eval(".lanes > *", (cards) => cards.map((card) => (card.textContent ?? "").slice(0, 40)));
    const before = await order();
    const cards = page.locator(".lanes > *");
    const from = await page.locator('.lanes .cowork-card:has-text("Pair on the responsive shell")').boundingBox();
    const to = await cards.last().boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + 30);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + 40, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const after = await order();
    check("a Co-work card drags to a new place among the tasks", after[after.length - 1].includes("Pair on the responsive shell") && before.join() !== after.join(), JSON.stringify({ before, after }));
    const saved = await page.evaluate(() => localStorage.getItem("orch-task-order") ?? "");
    check("and its place is saved in the same order as the tasks", saved.includes(`cowork:${"lab-cowork-session"}`), saved);
    await page.reload();
    await page.waitForSelector(".lanes .cowork-card", { timeout: 20000 });
    const reloaded = await order();
    check("the order survives a reload", reloaded.join() === after.join(), JSON.stringify(reloaded));
    await page.screenshot({ path: path.join(shots, "13-dragged.png") });

    const idleCard = '.lanes .cowork-card:has-text("Earlier exploration")';
    const closedCard = '.closed-list .closed-card:has-text("Earlier exploration")';
    closeMode = "unsupported";
    await page.reload();
    await page.waitForSelector(`${idleCard}.draggable`);
    const commandsBefore = closeCommands;
    await page.click(`${idleCard} .card-dismiss`);
    await page.waitForSelector(`${idleCard} [role="alert"]`);
    check("an older server explains why close is unavailable on the card", (await page.textContent(`${idleCard} [role="alert"]`)).includes("waiting for the server update"));
    check("an unsupported close is not silently sent or hidden locally", closeCommands === commandsBefore && await page.isVisible(idleCard));
    check("the close error does not require opening the popup", await popupClosed(page));

    closeMode = "rejected";
    await page.reload();
    await page.waitForSelector(`${idleCard}.draggable`);
    await page.click(`${idleCard} .card-dismiss`);
    await page.waitForSelector(`${idleCard} [role="alert"]`);
    check("a server refusal appears on the card with drag enabled", (await page.textContent(`${idleCard} [role="alert"]`)).includes("Stop the running turn"));

    closeMode = "supported";
    await page.click(`${idleCard} .card-dismiss`);
    await page.waitForSelector(idleCard, { state: "detached" });
    check("close works with drag enabled after retry", await popupClosed(page));
    await page.reload();
    await page.waitForSelector(".lanes .cowork-card");
    if (!(await page.isVisible(".closed-list"))) await page.click(".closed-toggle");
    await page.waitForSelector(closedCard);
    check("the closed session stays closed after reload", (await page.locator(idleCard).count()) === 0);
    closeMode = "rejected";
    await page.click(`${closedCard} button:text-is("Restore")`);
    await page.waitForSelector(`${closedCard} [role="alert"]`);
    check("restore failures are visible in the Closed list", await page.isVisible(`${closedCard} [role="alert"]`));
    closeMode = "supported";
    await page.click(`${closedCard} button:text-is("Restore")`);
    await page.waitForSelector(`${idleCard}.draggable`);
    check("restore succeeds on retry without losing the conversation", !(await page.isVisible(`${idleCard} [role="alert"]`)));

    check("no console errors anywhere in the run", errors.length === 0, errors.slice(0, 3).join(" | "));
    console.log(`\nscreenshots: ${shots}`);
    code = check.summary();
  } catch (error) {
    console.error(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep) {
      killInstance(PORT);
      try { child.kill(); } catch { /* already gone */ }
      if (!shotsDir) fs.rmSync(dataDir, { recursive: true, force: true });
    } else {
      console.log(`instance kept on :${PORT} (DATA_DIR ${dataDir})`);
    }
  }
  process.exit(code);
})();
