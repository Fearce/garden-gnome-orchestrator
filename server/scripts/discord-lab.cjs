// Drive the "Phone notifications" settings surface in a real browser, headlessly, without touching prod
// — the toggle's round-trip, the channel-ID sanitize, the write-only bot token, and the Send-test reply.
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
// credentials that cannot authenticate — a 401, which is exactly the failure path being asserted. Never
// seed this lab with a working token: the button posts for real.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4347;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

// Deliberately unusable. The env values are what `config.discord` falls back to, and this box carries a
// MACHINE-wide DISCORD_BOT_TOKEN for a real bot — an empty string would not shadow it (Windows drops
// empty-value env vars, so dotenv would then load server/.env's real one), hence a junk value, not "".
const LAB_ENV = { DISCORD_BOT_TOKEN: "lab-not-a-real-token", DISCORD_CHANNEL_ID: "lab-no-channel" };
const TYPED_TOKEN = "lab.secret.token.WXYZ";
const GROUP = '.settings-group:has(.settings-group-label:text-is("Phone notifications"))';
const TOGGLE = 'button.switch[aria-label="Post to Discord"]';

async function openSettings(browser) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Wait for the socket's `hello`, not for the shell to mount: the panel renders neutral defaults until
  // that frame lands, so a toggle reads "off" and a stored token reads "absent" on a busy box — which is
  // indistinguishable from the feature being broken. The account chips are hello-only, so they are the signal.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
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

/** Type into the group's channel field and commit it the way the operator does (Enter blurs → commit). */
async function setChannel(page, value) {
  const input = page.locator(`${GROUP} input.text-input`);
  await input.fill(value);
  await input.press("Enter");
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

      // The channel field takes what Discord's UI actually gives you. A pasted channel LINK is the common
      // paste, and storing it verbatim is a 404 on every notice, so the server keeps only the digits.
      await setChannel(page, "https://discord.com/channels/1422860693161381909/1542104062156079144");
      const channel = await waitForPersisted(dataDir, "setting_discord_channel_id", "1542104062156079144");
      check("a pasted channel link stores the CHANNEL, not the guild", channel === "1542104062156079144", String(channel));
      // The field is optimistic — it holds the pasted LINK until the server's broadcast replaces it with
      // what was actually kept. Waiting on the kv row is not the same instant, so wait on the correction
      // itself: the operator must not be left looking at a value the server didn't store.
      // NB: poll the LOCATOR, never `page.waitForFunction` — GROUP carries `:text-is()`, a Playwright-only
      // pseudo-class, so a `document.querySelector(GROUP)` inside the page throws SyntaxError and a
      // `.catch(() => false)` around it reports a healthy field as broken.
      const field = page.locator(`${GROUP} input.text-input`);
      let shown = "";
      for (let i = 0; i < 40 && shown !== "1542104062156079144"; i++) {
        shown = await field.inputValue();
        if (shown !== "1542104062156079144") await page.waitForTimeout(250);
      }
      check("…and the field is corrected to what was kept", shown === "1542104062156079144", shown);

      // The write-only token: typed here, stored server-side, and never sent back to any client.
      const tokenInput = page.locator(`${GROUP} .key-input input`);
      check("the token field is masked by default", (await tokenInput.getAttribute("type")) === "password");
      await tokenInput.fill(TYPED_TOKEN);
      await page.locator(`${GROUP} .sub-btn.primary`).click();
      check("the typed token reaches the server", (await waitForPersisted(dataDir, "discord_bot_token", TYPED_TOKEN)) === TYPED_TOKEN);
      await page.waitForSelector(`${GROUP} .sub-btn:text-is("Remove")`, { timeout: 10_000 });
      check("the field clears itself after saving", (await tokenInput.inputValue()) === "");
      check("the stored token shows as its last 4 only", (await page.locator(`${GROUP} .sub-msg.dim`).innerText()).includes("WXYZ"));
      check("the raw token is nowhere in the page", !(await page.content()).includes(TYPED_TOKEN));

      // The click that proves the whole wire: WS command → server → Discord → WS reply → rendered result.
      check("Send test is enabled once token + channel exist", await sendTest.isEnabled());
      await sendTest.click();
      await page.waitForSelector(`${GROUP} .sub-msg.bad`, { timeout: 30_000 });
      const message = await page.locator(`${GROUP} .sub-msg.bad`).innerText();
      check("a junk token is reported as Discord rejecting it", message.includes("401"), message);

      await page.click(TOGGLE);
      check("turning it on persists", (await waitForPersisted(dataDir, "setting_discord_notify", "1")) === "1");

      const shot = path.join(dataDir, "phone-notifications.png");
      await page.locator(GROUP).screenshot({ path: shot });
      console.log(`  screenshot: ${shot}`);
      await page.close();

      // A reload proves the state is the SERVER's, not the client store's — including that a stored token
      // still reads as present when the browser has never been told what it is.
      const second = await openSettings(browser);
      check("the toggle survives a reload", (await second.getAttribute(TOGGLE, "aria-checked")) === "true", await second.getAttribute(TOGGLE, "aria-checked"));
      check("the channel survives a reload", (await second.locator(`${GROUP} input.text-input`).inputValue()) === "1542104062156079144");
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
