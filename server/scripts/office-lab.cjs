// Drive the "Online office" settings surface in a real browser, headlessly, against a THROWAWAY
// orchestrator AND a throwaway relay — never prod, never the real office.
//
//   npm run office-lab --prefix server
//   npm run office-lab --prefix server -- --keep
//
// Why a lab and not a bundle grep: joining is a real three-hop round-trip (click → office.join → the
// relay's HTTP join → a WebSocket → the office.online broadcast the panel reads back), and the roster is
// rendered ONLY from what another machine reports. A typecheck is silent about every one of those hops.
// So this boots its own relay on :4359 with a known join code, its own console on :4347 against a temp
// DATA_DIR, joins for real, then connects a SECOND fake instance to the relay and checks that its agent
// shows up in the panel and in the top-bar strip. Bogus account tokens (via lab-harness) keep the boot
// ping from starting a real 5h window; both processes are killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const WebSocket = require("ws");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4347;
const RELAY_PORT = 4359; // NOT 4349: the console's own HTTPS listener is PORT+2, and a collision there makes the join hit TLS with a plain HTTP request
const BASE = `http://127.0.0.1:${PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const JOIN_CODE = "lab-join-code-not-a-real-secret";
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s
const LAB_REPO = "C:/lab/card-marker"; // a workspace the seeded cross-machine room belongs to
const LAB_REPO_LEAF = "card-marker";
const LONG_SOL_BODY =
  "Do both, but serialize them: give deliberate auto-play/replay sessions priority, triage and fix reproducible " +
  "Bobfish Live reports between games, and let the idle manager suspend training whenever Hearthstone or real input " +
  "is active and resume it after 10 idle minutes. This preserves fresh evidence without sacrificing unused hours.\n\n" +
  "Files: `src/bobfish/search.py`, `tests/test_search.py` — Ångström / 東京 / ✅\n" +
  `Payload beyond the old bridge and relay bounds: ${"lossless-".repeat(560)}\nEND-OF-SOL-MESSAGE`;

/** Boot the relay straight from `relay/src` with the server's own tsx — no build step, and the relay
 *  has exactly one dependency, so there is nothing else to install. */
async function bootRelay(dataDir) {
  const child = spawn("npx", ["tsx", path.join(SERVER_ROOT, "..", "relay", "src", "index.ts")], {
    cwd: SERVER_ROOT,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(RELAY_PORT),
      DATA_DIR: dataDir,
      JOIN_CODE,
      ADMIN_TOKEN: "lab-admin-token-not-production",
      OFFICE_NAME: "Lab Office",
    },
  });
  const log = fs.createWriteStream(path.join(dataDir, "relay.log"));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`${RELAY}/api/health`)).ok) return child;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`relay never came up — see ${path.join(dataDir, "relay.log")}`);
}

/** A second orchestrator, faked: join over HTTP, connect, and advertise one agent. This is the OTHER
 *  machine — the thing the whole feature exists to make visible. */
async function joinAsPeer(name, agent) {
  const res = await fetch(`${RELAY}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: JOIN_CODE, name }),
  });
  const { token } = await res.json();
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws`, { headers: { authorization: `Bearer ${token}`, "x-office-instance": name } });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ t: "presence", agents: [agent] }));
  return ws;
}

/** Seed a project room holding a conversation that came from ANOTHER machine, with no local task having
 *  spoken in it — the exact shape of a real cross-machine room before your own agent replies, and the one
 *  that used to be unreachable: the chatroom tab was gated on local participants only, so a room whose
 *  whole conversation is remote never got a tab and the owner saw nothing. */
function seedRemoteConversation(dataDir, workspace) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const room = `repo:${workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`;
  const add = db.prepare(
    `INSERT INTO chat_messages(id, room, scope, workspace, thread_id, run_id, role, kind, body, sender_name, remote_instance, created_at)
     VALUES(@id, @room, 'project', @workspace, NULL, NULL, @role, @kind, @body, @senderName, @remoteInstance, @createdAt)`,
  );
  const at = Date.now() - 60_000;
  add.run({
    id: "lab-remote-join", room, workspace, role: "system", kind: "system",
    body: "🌐 Sif (implementor) on \"Rewrite the card exporter\" from Mikkel's laptop joined Fearce/card-marker from another machine — coordinate here.",
    senderName: null, remoteInstance: "Mikkel's laptop", createdAt: at,
  });
  add.run({
    id: "lab-remote-chat", room, workspace, role: "implementor", kind: "chat",
    body: "I'm holding exporter.ts and its tests — leave those to me.",
    senderName: "Sif @ Mikkel's laptop", remoteInstance: "Mikkel's laptop", createdAt: at + 1000,
  });
  add.run({
    id: "lab-long-sol", room, workspace, role: "implementor", kind: "chat",
    body: LONG_SOL_BODY,
    senderName: "Sol @ Mikkel's laptop", remoteInstance: "Mikkel's laptop", createdAt: at + 2000,
  });
  db.close();
  return room;
}

/** Wait for the SERVER to own a kv value. The panel updates from the broadcast, so asserting on the DOM
 *  alone can pass against a client that never persisted anything. */
async function waitForKv(dataDir, key, want, timeoutMs = 20_000) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const db = new Database(file, { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    db.close();
    last = row ? row.value : null;
    if (want === "any" ? !!last : last === want) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

async function openOfficeSettings(browser) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  // The rendered copy affordance is the strongest assertion that the component received the COMPLETE
  // raw body (not merely that a visible prefix happened to include our first sentinel).
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.__officeCopied = text; } },
    });
  });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Wait for the socket's `hello`, not for the shell: the whole office panel renders neutral "off"
  // defaults until that frame lands, which is indistinguishable from a broken feature.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  return page;
}

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-lab-"));
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-lab-relay-"));
  const keep = process.argv.includes("--keep");
  console.log(`office-lab — console ${BASE}, relay ${RELAY} (data ${dataDir})`);

  let relayProc = null;
  let peer = null;
  try {
    relayProc = await bootRelay(relayDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      const page = await openOfficeSettings(browser);
      check("the Online office group renders", (await page.locator('.settings-group-label:text-is("Online office")').count()) === 1);
      check("a fresh console shows the JOIN form, not a status card", (await page.locator(".office-join").count()) === 1);

      // A wrong code must be refused visibly, and must not join.
      await page.fill('.office-join .office-field:has-text("Relay address") input', RELAY);
      await page.fill('.office-join .office-field:has-text("Join code") input', "definitely-wrong");
      await page.fill('.office-join .office-field:has-text("This machine") input', "Lab tower");
      await page.click('.office-join button:has-text("Join office")');
      await page.waitForSelector(".notice-banner, .office-join", { timeout: 10_000 });
      await page.waitForTimeout(1500);
      check("a wrong join code does not join", (await page.locator(".office-join").count()) === 1);
      check("…and nothing is persisted", (await waitForKv(dataDir, "online_office_token", "any", 1500)) === null);

      // The real thing.
      await page.fill('.office-join .office-field:has-text("Join code") input', JOIN_CODE);
      await page.click('.office-join button:has-text("Join office")');
      const token = await waitForKv(dataDir, "online_office_token", "any");
      check("joining persists a device token", !!token, await page.locator(".office-error").allInnerTexts().then((t) => t.join(" | ") || "(no error shown)"));
      await page.waitForSelector(".office-joined", { timeout: 20_000 });
      check("the panel switches to the status card", (await page.locator(".office-joined").count()) === 1);
      await page.waitForSelector(".office-dot.online", { timeout: 20_000 });
      check("…and reports itself connected", (await page.locator(".office-state").innerText()) === "Connected", await page.locator(".office-state").innerText());

      // Another machine appears.
      peer = await joinAsPeer("Mikkel's laptop", {
        key: "t-peer::implementor",
        name: "Sif",
        role: "implementor",
        title: "Rewrite the card exporter",
        repoKey: "github.com/fearce/card-marker",
        repoLabel: "Fearce/card-marker",
      });
      await page.waitForSelector(".office-roster-row", { timeout: 20_000 });
      // `.office-roster-who` is CSS-uppercased, so the DOM reads MIKKEL'S LAPTOP — compare case-insensitively.
      const rosterText = await page.locator(".office-roster").innerText();
      check("the remote machine is listed by name", rosterText.toLowerCase().includes("mikkel's laptop"), rosterText);
      check("…with its agent and repo", rosterText.includes("Sif") && rosterText.includes("Fearce/card-marker"), rosterText);

      // The top-bar strip is the at-a-glance surface; it must show the remote machine too.
      await page.keyboard.press("Escape");
      await page.waitForSelector(".office-remote", { timeout: 20_000 });
      check("the top-bar strip shows a remote-machine cluster", (await page.locator(".office-remote").count()) === 1);
      check("…tagged with the machine's name", (await page.locator(".office-remote-tag").innerText()) === "Mikkel's laptop");

      const shot = path.join(dataDir, "online-office.png");
      await page.screenshot({ path: shot });
      console.log(`  screenshot: ${shot}`);

      // The conversation itself has to be REACHABLE, which is the half a roster can't show: a room whose
      // only participants are on another machine has no local task in it, and the chatroom tab used to be
      // gated on exactly that count — so the cross-machine talk happened where the owner could not see it.
      const room = seedRemoteConversation(dataDir, LAB_REPO);
      await page.reload({ timeout: NAV_TIMEOUT });
      await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
      await page.click(".office-strip .office-director");
      await page.waitForSelector(".office-panel", { timeout: 20_000 });
      const tabs = await page.locator(".office-tab").allInnerTexts();
      check("a room whose whole conversation is remote still gets a chatroom tab", tabs.some((t) => t.includes(LAB_REPO_LEAF)), JSON.stringify(tabs));
      check("…counting the remote machine as a participant, not a bare 0", tabs.some((t) => t.includes(LAB_REPO_LEAF) && /\b1\b/.test(t)), JSON.stringify(tabs));

      await page.click(`.office-tab:has-text("${LAB_REPO_LEAF}")`);
      await page.waitForSelector(".office-msg", { timeout: 20_000 });
      check("…and opening it shows the remote agent's line", (await page.locator(".office-msgs").innerText()).includes("holding exporter.ts"));
      check("…attributed to the agent AND its machine", (await page.locator(".office-msg-role").first().innerText()).includes("Mikkel's laptop"));
      check("…marked as having crossed the internet", (await page.locator(".office-msg.remote .office-msg-remote").count()) === 2);

      const longMessage = page.locator('[data-message-id="lab-long-sol"]');
      await longMessage.waitFor({ state: "visible", timeout: 20_000 });
      check("the complete long Sol message renders through its final sentinel", (await longMessage.innerText()).includes("END-OF-SOL-MESSAGE"));
      check("…with multiline Unicode and Markdown content", (await longMessage.innerText()).includes("Ångström / 東京 / ✅") && (await longMessage.locator("code").first().innerText()) === "src/bobfish/search.py");
      await longMessage.locator(".office-msg-copy").click();
      const copied = await page.evaluate(() => window.__officeCopied);
      check("the copy affordance returns the exact untruncated body", copied === LONG_SOL_BODY, `copied=${String(copied).length}, want=${LONG_SOL_BODY.length}`);
      const desktopBody = await longMessage.locator(".office-msg-body").evaluate((el) => {
        const s = getComputedStyle(el);
        return { overflow: s.overflow, maxHeight: s.maxHeight, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
      });
      check("desktop uses wrapping with no body clamp/hidden overflow", desktopBody.maxHeight === "none" && desktopBody.overflow === "visible" && desktopBody.scrollWidth <= desktopBody.clientWidth + 1, JSON.stringify(desktopBody));

      // The same already-open dialog at the narrowest supported phone width: the room itself scrolls,
      // while each body remains fully laid out and horizontally contained.
      await page.setViewportSize({ width: 320, height: 700 });
      const mobile = await page.locator(".office-panel").evaluate((panel) => {
        const box = panel.getBoundingClientRect();
        const body = panel.querySelector('[data-message-id="lab-long-sol"] .office-msg-body');
        const copy = panel.querySelector('[data-message-id="lab-long-sol"] .office-msg-copy');
        return {
          panel: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          body: body ? { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, overflow: getComputedStyle(body).overflow } : null,
          copy: copy ? { width: copy.getBoundingClientRect().width, height: copy.getBoundingClientRect().height } : null,
        };
      });
      check("320px: the Office dialog stays inside the viewport", mobile.panel.left >= 0 && mobile.panel.right <= 320 && mobile.panel.top >= 0 && mobile.panel.bottom <= 700, JSON.stringify(mobile.panel));
      check("320px: the complete body wraps instead of clipping sideways", !!mobile.body && mobile.body.scrollWidth <= mobile.body.clientWidth + 1 && mobile.body.overflow === "visible", JSON.stringify(mobile.body));
      check("320px: Copy remains a touch-sized accessible control", !!mobile.copy && mobile.copy.width >= 44 && mobile.copy.height >= 36, JSON.stringify(mobile.copy));

      // A reload creates a fresh WebSocket and then merges chat.history. The durable id must still map
      // to exactly one bubble, never a hello/history duplicate.
      await page.setViewportSize({ width: 1500, height: 950 });
      await page.reload({ timeout: NAV_TIMEOUT });
      await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
      await page.click(".office-strip .office-director");
      await page.waitForSelector(".office-panel", { timeout: 20_000 });
      await page.click(`.office-tab:has-text("${LAB_REPO_LEAF}")`);
      await page.waitForSelector('[data-message-id="lab-long-sol"]', { timeout: 20_000 });
      check("reload/reconnect keeps exactly one copy of the long message", (await page.locator('[data-message-id="lab-long-sol"]').count()) === 1);

      const roomShot = path.join(dataDir, "cross-machine-room.png");
      await page.screenshot({ path: roomShot });
      console.log(`  screenshot: ${roomShot}`);
      // The office panel has no Escape handler — its scrim covers the whole app, so it must be closed
      // properly or every later click lands on the scrim instead of the control it names.
      await page.click(".office-panel .close-x");
      await page.waitForSelector(".office-panel", { state: "detached", timeout: 10_000 });

      // Leaving must forget the token — otherwise "Leave" is cosmetic.
      await page.click('[aria-label="Open settings"]');
      await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
      await page.click('.office-joined button:has-text("Leave")');
      const after = await waitForKv(dataDir, "online_office_token", "");
      check("leaving forgets the device token", after === "", String(after));
      await page.waitForSelector(".office-join", { timeout: 20_000 });
      check("…and the join form comes back", (await page.locator(".office-join").count()) === 1);

      await page.close();
    } finally {
      await browser.close();
    }
  } finally {
    try {
      peer?.terminate();
    } catch {
      /* already gone */
    }
    if (!keep) {
      killInstance(PORT);
      killInstance(RELAY_PORT);
      relayProc?.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(relayDir, { recursive: true, force: true });
    } else {
      console.log(`  --keep: console on ${BASE}, relay on ${RELAY}; kill with the port owners.`);
    }
  }
  process.exit(check.summary());
}

main().catch((e) => {
  console.error(e);
  killInstance(PORT);
  killInstance(RELAY_PORT);
  process.exit(1);
});
