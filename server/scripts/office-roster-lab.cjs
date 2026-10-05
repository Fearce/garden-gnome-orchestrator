// Exercise synthetic presence in the served console without writing to the live server.
// Run: node server/scripts/office-roster-lab.cjs
const assert = require("node:assert/strict");
const { loadChromium, authPassword } = require("./lab-harness.cjs");
const BASE = process.env.GGO_ROSTER_BASE || "http://127.0.0.1:4317";
const workspace = "C:/workspaces/roster-project";
const room = "repo:c:/workspaces/roster-project";

async function main() {
  const browser = await loadChromium().launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const login = await context.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    assert.ok(login.ok(), "authenticated browser");
    let socket, fixture;
    await context.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
      socket = ws;
      const server = ws.connectToServer();
      server.onMessage((raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "hello") return;
        const at = Date.now();
        const threads = Array.from({ length: 8 }, (_, i) => ({ id: `roster-${i}`, title: `Roster task ${i} ${"long title ".repeat(10)}`, workspace, state: "building", brief: "Synthetic roster check", rawPrompt: "Synthetic roster check", createdAt: at, updatedAt: at }));
        fixture = { ...event, threads, runs: threads.map((t, i) => ({ id: `run-${i}`, threadId: t.id, role: "implementor", model: "gpt-6.1-sol", state: i === 0 ? "starting" : "running", startedAt: at })), chat: [], chatRooms: [], findings: [], questions: [], director: [], goals: [], coworkSessions: [], notes: [], nameOverrides: Object.fromEntries(threads.map((t, i) => [`${t.id}::implementor`, `Gnome ${i}`])), onlineOffice: { ...event.onlineOffice, joined: true, state: "online", directors: [], sharedRepos: [{ repoKey: "example.com/team/project", repoLabel: "team/project", workspaces: [workspace] }], remoteAgents: [{ key: "peer", name: "Fern", role: "qa", title: "Remote review", repoKey: "example.com/team/project", instanceId: "peer-box", instanceName: "Peer box" }] } };
        ws.send(JSON.stringify(fixture));
        fixture.chat = Array.from({ length: 12 }, (_, i) => ({ id: `roster-chat-${i}`, room, scope: "project", role: "implementor", kind: "chat", body: `Synthetic conversation line ${i}\nMore chatter to verify reclaimed space.`, createdAt: at + i }));
      });
      // Do not forward commands: even opening chat and task history uses the socket.
      ws.onMessage((raw) => {
        const command = JSON.parse(String(raw));
        if (command.type === "chat.history") ws.send(JSON.stringify({ type: "chat.history", room: command.room, messages: fixture.chat.filter((message) => message.room === command.room), hasMore: false }));
      });
    });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.locator(`[data-office-room="${room}"]`).first().click();
    await page.waitForSelector(".office-roster-list");
    assert.match(await page.locator(".office-roster-summary").innerText(), /9 gnomes working here/);
    assert.equal(await page.locator(".office-roster-list li").count(), 9);
    assert.match(await page.locator(".office-roster-list").innerText(), /Starting/);
    assert.match(await page.locator(".office-roster-list").innerText(), /Fern/);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const layout = await page.locator(".office-panel").evaluate((el) => {
        const box = el.getBoundingClientRect();
        const list = el.querySelector(".office-roster-list");
        const composer = el.querySelector(".office-composer").getBoundingClientRect();
        return { left: box.left, right: box.right, bottom: box.bottom, overflow: el.scrollWidth > el.clientWidth, scrollable: list.scrollHeight > list.clientHeight, composerBottom: composer.bottom };
      });
      assert.ok(layout.left >= 0 && layout.right <= width && layout.bottom <= 700 && !layout.overflow, `${width}px: dialog fits viewport`);
      assert.ok(layout.scrollable && layout.composerBottom <= 700, `${width}px: all names scroll while composer stays visible`);
      const expandedChat = await page.locator(".office-msgs").evaluate((el) => el.clientHeight);
      await page.getByRole("button", { name: "Hide roster", exact: true }).click();
      assert.ok(!await page.locator(".office-roster-list").isVisible(), `${width}px: Hide roster hides names`);
      assert.match(await page.locator(".office-roster-summary").innerText(), /9 gnomes working here/, "collapsed count stays visible");
      assert.equal(await page.locator(".office-roster-toggle").getAttribute("aria-expanded"), "false");
      const collapsedChat = await page.locator(".office-msgs").evaluate((el) => el.clientHeight);
      assert.ok(collapsedChat > expandedChat + 80, `${width}px: collapsing restores chat space (${expandedChat} -> ${collapsedChat})`);
      await page.getByRole("button", { name: "Show roster", exact: true }).click();
      assert.ok(await page.locator(".office-roster-list").isVisible());
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Hide roster", exact: true }).click();
    await page.locator(".office-panel .close-x").click();
    await page.locator(`[data-office-room="${room}"]`).first().click();
    assert.ok(await page.getByRole("button", { name: "Show roster", exact: true }).isVisible(), "reopening remembers collapsed roster");
    await page.reload();
    await page.locator(`[data-office-room="${room}"]`).first().click();
    assert.ok(await page.getByRole("button", { name: "Show roster", exact: true }).isVisible(), "reloading remembers collapsed roster");
    await page.getByRole("button", { name: "Show roster", exact: true }).click();
    await page.locator("button.office-roster-member").first().click();
    await page.waitForSelector(".office-panel", { state: "detached" });
    await page.waitForSelector(".detail");
    assert.match(await page.locator(".detail").innerText(), /Roster task 0/);
    await page.setViewportSize({ width: 1280, height: 800 });
    // Update presence through the same event handler as real socket snapshots.
    for (const run of fixture.runs) socket.send(JSON.stringify({ type: "run.upsert", run: { ...run, state: "done", endedAt: Date.now() } }));
    socket.send(JSON.stringify({ type: "office.online", office: { ...fixture.onlineOffice, remoteAgents: [] } }));
    await page.locator(".office-director").first().click();
    await page.waitForFunction(() => document.querySelector(".office-roster-summary")?.textContent.includes("0 gnomes working here"));
    assert.ok(await page.locator(".office-roster-empty").isVisible());
    console.log("Office roster browser passed: mixed presence, desktop/320px scrolling and reclaimed chat space, hide/show accessibility and persistence, task navigation, and live empty-state update.");
    await context.close();
    const live = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    assert.ok((await live.request.post(`${BASE}/api/login`, { data: { password: authPassword() } })).ok());
    const livePage = await live.newPage();
    await livePage.goto(BASE);
    await livePage.locator(".accounts .acct").first().waitFor({ state: "attached" });
    await livePage.locator(".office-director").click();
    await livePage.waitForSelector(".office-roster-summary");
    const summary = await livePage.locator(".office-roster-summary strong").innerText();
    assert.equal(Number(summary.match(/^\d+/)[0]), await livePage.locator(".office-roster-list li").count(), "live count matches actual roster");
    await livePage.getByRole("button", { name: "Hide roster", exact: true }).click();
    assert.equal(await livePage.locator(".office-roster-toggle").getAttribute("aria-expanded"), "false", "live console supports hiding the roster");
    assert.ok(await livePage.locator(".office-roster-summary strong").isVisible(), "live count stays visible when hidden");
    assert.ok(await livePage.locator(".office-composer textarea").isVisible());
    console.log("Live console passed: deployed roster renders and hides, count remains visible, and composer is visible.");
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
