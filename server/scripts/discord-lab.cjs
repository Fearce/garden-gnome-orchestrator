// Drive the "Phone notifications" settings surface in a real browser, headlessly, without touching prod
// — the toggle's round-trip, the user- and channel-ID sanitize, the write-only bot token, the Send-test reply,
// and the "DM the director" toggle with its live gateway status.
//
//   npm run discord-lab --prefix server
//   npm run discord-lab --prefix server -- --keep
//
// Why a lab and not a bundle grep: every value here is a real round-trip the client only reads back from
// the server's broadcast, and the one claim that matters most — the raw bot token NEVER reaches the
// browser — is invisible to a typecheck and to `test:discord-notify` alike. Prod is off-limits to click
// (.claude/rules/verify-a-ui-change-shipped.md), so this boots its OWN instance on :4347 against a temp
// DATA_DIR and clicks freely.
//
// It is safe against the owner's real channel BY CONSTRUCTION: the instance is booted with a junk token
// and channel id, and the lab types junk of its own, so the one Send-test click reaches Discord with
// credentials that cannot authenticate — a 401, which is exactly the failure path being asserted. The DM
// inbox likewise opens a real Discord gateway session with that junk token and must report Discord's
// refusal (close 4004). Never seed this lab with a working token: the button posts for real.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4347;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

// Deliberately unusable. The env values are what `config.discord` falls back to, and this box carries a
// MACHINE-wide DISCORD_BOT_TOKEN for a real bot — an empty string would not shadow it (Windows drops
// empty-value env vars, so dotenv would then load server/.env's real one), hence a junk value, not "".
const LAB_ENV = { DISCORD_BOT_TOKEN: "lab-not-a-real-token", DISCORD_CHANNEL_ID: "lab-no-channel", DISCORD_USER_ID: "lab-no-user" };
const TYPED_TOKEN = "lab.secret.token.WXYZ";
const GROUP = '.settings-group:has(.settings-group-label:text-is("Phone notifications"))';
const TOGGLE = 'button.switch[aria-label="Post to Discord"]';
const INBOX_TOGGLE = 'button.switch[aria-label="DM the director"]';
const INBOX_STATUS = `${GROUP} .discord-inbox-status`;

async function openSettings(browser) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Wait for the socket's `hello`, not for the shell to mount: the panel renders neutral defaults until
  // that frame lands, so a toggle reads "off" and a stored token reads "absent" on a busy box — which is
  // indistinguishable from the feature being broken. The account chips are hello-only, so they are the signal.
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  await page.click('[data-settings-category="voice-alerts"]');
  return page;
}

/** Wait for the SERVER to have persisted a kv row. The controls are optimistic, so re-reading the DOM
 *  proves nothing and reloading straight after races the write; the instance's own row is the claim. */
async function waitForPersisted(dataDir, key, want, timeoutMs = 15_000) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const db = new Database(file, { readonly: true });
    last = db.prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value ?? null;
    db.close();
    if (want === undefined ? last !== null : last === want) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

// The group's two text fields, in render order: the DM recipient first, the channel second.
const USER_FIELD = `${GROUP} input.text-input >> nth=0`;
const CHANNEL_FIELD = `${GROUP} input.text-input >> nth=1`;

/** Type into one of the group's text fields and commit it the way the operator does (Enter blurs → commit). */
async function setField(page, selector, value) {
  const input = page.locator(selector);
  await input.fill(value);
  await input.press("Enter");
}

/** Poll the inbox's status line until it contains `want` — it changes only on the server's broadcast. */
async function waitForStatus(page, want, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await page.locator(INBOX_STATUS).innerText();
    if (text.includes(want)) return text;
    await page.waitForTimeout(250);
  }
  return text;
}

/** Poll a field until the server's broadcast has replaced the optimistic value with `want`. */
async function waitForField(page, selector, want) {
  const field = page.locator(selector);
  let shown = "";
  for (let i = 0; i < 40 && shown !== want; i++) {
    shown = await field.inputValue();
    if (shown !== want) await page.waitForTimeout(250);
  }
  return shown;
}

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-lab-"));
  const keep = process.argv.includes("--keep");
  console.log(`discord-lab — ${BASE} (data ${dataDir})`);

  try {
    await boot({ dataDir, port: PORT, env: LAB_ENV });
    const browser = await loadChromium().launch();
    try {
      const page = await openSettings(browser);
      check("the Phone notifications group renders", (await page.locator(`${GROUP}`).count()) === 1);
      check("it is OFF for a fresh instance", (await page.getAttribute(TOGGLE, "aria-checked")) === "false", await page.getAttribute(TOGGLE, "aria-checked"));

      // Send test must not be offerable before it can work — the click would only ever produce an error.
      const sendTest = page.locator(`${GROUP} .sub-btn:text-is("Send test")`);
      check("Send test is disabled with no channel yet", await sendTest.isDisabled());
      check("DM the director is ON for a fresh instance", (await page.getAttribute(INBOX_TOGGLE, "aria-checked")) === "true");
      const waiting = await waitForStatus(page, "Waiting for your Discord user ID");
      check("…and says it waits for a user ID before listening", waiting.includes("Waiting for your Discord user ID"), waiting);

      // The channel field takes what Discord's UI actually gives you. A pasted channel LINK is the common
      // paste, and storing it verbatim is a 404 on every notice, so the server keeps only the digits.
      await setField(page, CHANNEL_FIELD, "https://discord.com/channels/300000000000000003/200000000000000002");
      const channel = await waitForPersisted(dataDir, "setting_discord_channel_id", "200000000000000002");
      check("a pasted channel link stores the CHANNEL, not the guild", channel === "200000000000000002", String(channel));
      // The field is optimistic — it holds the pasted LINK until the server's broadcast replaces it with
      // what was actually kept. Waiting on the kv row is not the same instant, so wait on the correction
      // itself: the operator must not be left looking at a value the server didn't store.
      // NB: poll the LOCATOR, never `page.waitForFunction` — GROUP carries `:text-is()`, a Playwright-only
      // pseudo-class, so a `document.querySelector(GROUP)` inside the page throws SyntaxError and a
      // `.catch(() => false)` around it reports a healthy field as broken.
      const shown = await waitForField(page, CHANNEL_FIELD, "200000000000000002");
      check("…and the field is corrected to what was kept", shown === "200000000000000002", shown);

      // A user id moves every notice to the owner's DMs; a pasted `<@!id>` mention keeps only the id.
      await setField(page, USER_FIELD, "<@!100000000000000001>");
      const user = await waitForPersisted(dataDir, "setting_discord_user_id", "100000000000000001");
      check("a pasted user mention stores the bare user id", user === "100000000000000001", String(user));
      const userShown = await waitForField(page, USER_FIELD, "100000000000000001");
      check("…and the field is corrected to what was kept", userShown === "100000000000000001", userShown);
      check("the channel field says it is unused while DMs are on", (await page.locator(GROUP).innerText()).includes("Unused while your user ID is set"));

      // The write-only token: typed here, stored server-side, and never sent back to any client.
      const tokenInput = page.locator(`${GROUP} .key-input input`);
      check("the token field is masked by default", (await tokenInput.getAttribute("type")) === "password");
      await tokenInput.fill(TYPED_TOKEN);
      await page.locator(`${GROUP} .sub-btn.primary`).click();
      check("the typed token reaches the server", (await waitForPersisted(dataDir, "discord_bot_token", TYPED_TOKEN)) === TYPED_TOKEN);
      await page.waitForSelector(`${GROUP} .sub-btn:text-is("Remove")`, { timeout: 10_000 });
      check("the field clears itself after saving", (await tokenInput.inputValue()) === "");
      check("the stored token shows as its last 4 only", (await page.locator(`${GROUP} .sub-field .sub-msg.dim`).innerText()).includes("WXYZ"));
      check("the raw token is nowhere in the page", !(await page.content()).includes(TYPED_TOKEN));

      // The click that proves the whole wire: WS command → server → Discord → WS reply → rendered result.
      check("Send test is enabled once token + channel exist", await sendTest.isEnabled());
      await sendTest.click();
      await page.waitForSelector(`${GROUP} .sub-msg.bad`, { timeout: 30_000 });
      const message = await page.locator(`${GROUP} .sub-msg.bad`).innerText();
      check("a junk token is reported as Discord rejecting it", message.includes("401"), message);

      await page.click(TOGGLE);
      check("turning it on persists", (await waitForPersisted(dataDir, "setting_discord_notify", "1")) === "1");

      // Token + user id are set, so the inbox opened a real gateway session with the junk token.
      const refused = await waitForStatus(page, "rejected the bot token");
      check("the DM inbox reports Discord refusing a bad token", refused.includes("rejected the bot token"), refused);
      await page.click(INBOX_TOGGLE);
      check("turning DM the director off persists", (await waitForPersisted(dataDir, "setting_discord_inbox", "0")) === "0");
      const off = await waitForStatus(page, "Off.");
      check("…and the status says Off", off === "Off.", off);

      const shot = path.join(shotDir(dataDir), "phone-notifications.png");
      await page.locator(GROUP).screenshot({ path: shot });
      console.log(`  screenshot: ${shot}`);
      await page.close();

      // A reload proves the state is the SERVER's, not the client store's — including that a stored token
      // still reads as present when the browser has never been told what it is.
      const second = await openSettings(browser);
      check("the toggle survives a reload", (await second.getAttribute(TOGGLE, "aria-checked")) === "true", await second.getAttribute(TOGGLE, "aria-checked"));
      check("the channel survives a reload", (await second.locator(CHANNEL_FIELD).inputValue()) === "200000000000000002");
      check("the user id survives a reload", (await second.locator(USER_FIELD).inputValue()) === "100000000000000001");
      check("DM the director stays off after a reload", (await second.getAttribute(INBOX_TOGGLE, "aria-checked")) === "false");
      check("the stored token is still known to be there", (await second.locator(`${GROUP} .sub-btn:text-is("Remove")`).count()) === 1);
      check("…and is still not in the page", !(await second.content()).includes(TYPED_TOKEN));

      await second.locator(`${GROUP} .sub-btn:text-is("Remove")`).click();
      check("Remove clears the stored token", (await waitForPersisted(dataDir, "discord_bot_token", "")) === "");
      await second.close();
    } finally {
      await browser.close();
    }
    return check.summary();
  } finally {
    killInstance(PORT);
    if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`kept ${dataDir}`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(1);
  },
);
