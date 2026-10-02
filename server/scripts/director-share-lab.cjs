// Director sharing, end to end, in real browsers: a throwaway relay, TWO throwaway consoles (a donor and
// a recipient) and a fake OpenAI-compatible provider. Never prod, never the real office, never a real key.
//
//   npm run director-share-lab --prefix server
//   npm run director-share-lab --prefix server -- --shots <dir>
//
// What only this can show: the owner opts a subscription in from Settings, the recipient discovers it in
// its own Settings, picks it, and a real Director turn travels recipient -> relay -> donor -> provider and
// back, attributed to the donor; a deadline edit reaches the recipient; Stop sharing cancels a call that is
// already running at the provider; a live share expires on the donor's own clock; and a deadline that
// passes while the donor is DOWN is applied when it boots. The donor's key is a lab string, the provider
// is a local HTTP server, and the recipient's own (bogus) Claude tokens are never used.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const { WebSocket } = require("ws");
// Always exercise the owner authentication boundary, including on worktrees without a local .env.
process.env.AUTH_PASSWORD ||= "director-share-lab-only-password";
const { SERVER_ROOT, loadChromium, allowConcurrentContexts, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const DONOR_PORT = 4561; // HTTPS on 4563
const RECIPIENT_PORT = 4565; // HTTPS on 4567
const RELAY_PORT = 4569;
const PROVIDER_PORT = 4571;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const JOIN_CODE = "lab-join-code-not-a-real-secret";
const DONOR_KEY = "sk-lab-donor-key-never-real-0000000000";
const MODEL = "gpt-lab-mini";
const REPLY = "Hello from the donor's shared Director.";
const NAV_TIMEOUT = 60_000;

// ---- the fake provider ----------------------------------------------------------------------------------

/** OpenAI-compatible enough for the donor: `/v1/models` and `/v1/chat/completions`. A message containing
 *  HOLD is held open until the donor aborts it, which is how Stop-in-flight is observed from outside. */
function startProvider() {
  const state = { calls: [], aborted: 0, held: 0, models: [MODEL], holdModels: false, modelReplies: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        const reply = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [...state.models.map((id) => ({ id })), { id: "text-embedding-lab" }] }));
        };
        if (state.holdModels) state.modelReplies.push(reply);
        else reply();
        return;
      }
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body || "{}");
      const call = { auth: req.headers.authorization, model: parsed.model, format: parsed.response_format?.type, maxTokens: parsed.max_completion_tokens, messages: parsed.messages ?? [] };
      state.calls.push(call);
      const last = call.messages.at(-1)?.content ?? "";
      if (/HOLD/.test(last)) {
        state.held++;
        res.on("close", () => {
          if (!res.writableEnded) state.aborted++;
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ kind: "reply", message: REPLY }) } }],
        usage: { prompt_tokens: 900, completion_tokens: 20 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(PROVIDER_PORT, "127.0.0.1", () => resolve({ server, state })));
}

// ---- relay and consoles ---------------------------------------------------------------------------------

async function bootRelay(dataDir) {
  const child = spawn("npx", ["tsx", path.join(SERVER_ROOT, "..", "relay", "src", "index.ts")], {
    cwd: SERVER_ROOT,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PORT: String(RELAY_PORT), DATA_DIR: dataDir, JOIN_CODE, ADMIN_TOKEN: "lab-admin-token-not-production", OFFICE_NAME: "Share Lab" },
  });
  const log = fs.createWriteStream(path.join(dataDir, "relay.log"));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`${RELAY}/api/health`)).ok) return child;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`relay never came up; see ${path.join(dataDir, "relay.log")}`);
}

/** Rows written while the instance is DOWN (the server keeps kv in memory while it runs). */
function seedKv(dataDir, rows) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const put = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(rows)) put.run(k, v);
  db.close();
}

function readKv(dataDir, key) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  db.close();
  return row ? row.value : null;
}

function directorMessages(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const rows = db.prepare("SELECT role, content FROM director_messages ORDER BY created_at ASC").all();
  db.close();
  return rows;
}

async function waitFor(fn, timeoutMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
}

/** A joined office membership: the relay's device token, seeded so both consoles connect at boot. */
async function officeMembership(name) {
  const res = await fetch(`${RELAY}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: JOIN_CODE, name }) });
  const { token } = await res.json();
  return { online_office_enabled: "1", online_office_url: RELAY, online_office_name: name, online_office_token: token };
}

/** First boot creates the schema; then the lab seeds while it is down and boots for real. */
async function prepareConsole({ dataDir, port, env, seed }) {
  await boot({ dataDir, port, env });
  killInstance(port);
  await new Promise((r) => setTimeout(r, 1500));
  seedKv(dataDir, seed);
  return boot({ dataDir, port, env });
}

async function openConsole(browser, port, viewport = { width: 1440, height: 950 }) {
  const context = await browser.newContext({ viewport, ...(viewport.width < 600 ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${port}/`, { timeout: NAV_TIMEOUT });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
  return { context, page };
}

async function openSharingSettings(page) {
  if (!(await page.locator('[role="dialog"][aria-label="Settings"]').count())) {
    await page.click('[aria-label="Open settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  }
  const mobile = page.locator('.settings-mobile-nav select[aria-label="Settings category"]');
  if (await mobile.isVisible().catch(() => false)) await mobile.selectOption("director-sharing");
  else await page.click('[data-settings-category="director-sharing"]');
  await page.waitForSelector('.dshare', { state: "visible", timeout: 20_000 });
}

async function closeSettings(page) {
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 10_000 });
}

async function sendToDirector(page, text) {
  await page.fill('.rail textarea[aria-label="Message"]', text);
  await page.click('.rail button.composer-send');
}

/** A datetime-local value `ms` from now, in the browser's zone, rounded UP to the next whole minute. */
async function localDeadline(page, msFromNow) {
  return page.evaluate((ms) => {
    const t = Math.ceil((Date.now() + ms) / 60_000) * 60_000;
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return { value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`, at: t };
  }, msFromNow);
}

const shares = (dataDir) => JSON.parse(readKv(dataDir, "director_shares_v1") || "{}");

async function unauthenticatedSocketRejected(port) {
  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`)).json();
  if (me.authed !== false) return false;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let received = false;
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 10_000);
    ws.on("message", () => { received = true; });
    ws.on("error", () => {});
    // Fastify can close before the upgrade finishes, so ws reports 1006 instead of the 4401 frame.
    ws.on("close", (code) => { clearTimeout(timer); resolve((code === 4401 || code === 1006) && !received); });
  });
}

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const check = createChecks();
  const donorDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshare-donor-"));
  const recipientDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshare-recipient-"));
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshare-relay-"));
  const shots = shotDir(donorDir);
  console.log(`director-share-lab: donor :${DONOR_PORT}, recipient :${RECIPIENT_PORT}, relay :${RELAY_PORT}, provider :${PROVIDER_PORT}`);

  const donorEnv = { DIRECTOR_SHARE_OPENAI_BASE_URL: `http://127.0.0.1:${PROVIDER_PORT}/v1`, OWNER_NAME: "Dana", REMOTE_ACCESS: "0" };
  const recipientEnv = { OWNER_NAME: "Rowan", REMOTE_ACCESS: "0" };
  let relayProc = null;
  let provider = null;
  let browser = null;
  try {
    provider = await startProvider();
    relayProc = await bootRelay(relayDir);
    await prepareConsole({ dataDir: donorDir, port: DONOR_PORT, env: donorEnv, seed: { openai_api_key: DONOR_KEY, ...(await officeMembership("Donor tower")) } });
    await prepareConsole({ dataDir: recipientDir, port: RECIPIENT_PORT, env: recipientEnv, seed: await officeMembership("Recipient laptop") });

    check("an unauthenticated donor socket cannot read or change sharing settings", await unauthenticatedSocketRejected(DONOR_PORT));
    check("an unauthenticated recipient socket cannot select shared capacity", await unauthenticatedSocketRejected(RECIPIENT_PORT));

    const chromium = loadChromium();
    browser = await chromium.launch();
    allowConcurrentContexts(browser, 3);
    const donor = await openConsole(browser, DONOR_PORT);
    const recipient = await openConsole(browser, RECIPIENT_PORT);
    const dp = donor.page;
    const rp = recipient.page;

    console.log("\n=== donor: the settings panel ===\n");
    await openSharingSettings(dp);
    await dp.waitForSelector('.dshare-row[data-subscription="openai-api"]', { timeout: 30_000 });
    const openaiRow = dp.locator('.dshare-row[data-subscription="openai-api"]');
    check("the OpenAI API key is listed and Private by default", (await openaiRow.locator(".share-chip").innerText()).trim().toLowerCase() === "private");
    const claudeRow = dp.locator('.dshare-row[data-subscription^="claude:"]').first();
    check("a Claude plan is listed as not shareable, with no controls", (await claudeRow.count()) === 1 && /Cannot be shared/.test(await claudeRow.innerText()) && (await claudeRow.locator("button, input, select").count()) === 0);
    await waitFor(async () => (await openaiRow.locator("select").first().inputValue()) === MODEL, 30_000);
    check("the model picker lists the key's chat models", (await openaiRow.locator("select").first().inputValue()) === MODEL);
    check("the deadline names its timezone", /Share until \(.+\)/i.test(await openaiRow.locator(".office-field", { hasText: "Share until" }).innerText()));
    await waitFor(() => readKv(donorDir, "online_office_token") && dp.evaluate(() => !document.querySelector(".dshare-warn")), 30_000);
    const past = await localDeadline(dp, -5 * 60_000);
    await openaiRow.locator('input[type="datetime-local"]').fill(past.value);
    check("a past deadline disables Share and says why", (await openaiRow.locator('button:text-is("Share")').isDisabled()) && /future/.test(await openaiRow.locator(".dshare-hint").innerText()));
    const first = await localDeadline(dp, 2 * 60 * 60_000);
    await openaiRow.locator('input[type="datetime-local"]').fill(first.value);
    await openaiRow.locator('button:text-is("Share")').click();
    const live = await waitFor(() => shares(donorDir)["openai-api"]?.status === "shared" && shares(donorDir)["openai-api"], 20_000);
    check("Share persists the opt-in on the donor", !!live, readKv(donorDir, "director_shares_v1"));
    check("the deadline is stored as the exact instant picked", live && live.expiresAt === first.at, `${live?.expiresAt} vs ${first.at}`);
    await waitFor(async () => /shared/i.test(await openaiRow.locator(".share-chip").innerText()), 10_000);
    check("the chip turns Shared", /shared/i.test(await openaiRow.locator(".share-chip").innerText()));
    await dp.screenshot({ path: path.join(shots, "donor-shared.png") });

    console.log("\n=== recipient: discover, select, converse ===\n");
    await openSharingSettings(rp);
    const offer = rp.locator(".dshare-offer").first();
    await offer.waitFor({ timeout: 40_000 });
    check("the recipient discovers the offer with donor attribution", /Donor tower/.test(await offer.innerText()) && new RegExp(MODEL).test(await offer.innerText()));
    await offer.locator('button:has-text("Use as my Director")').click();
    await rp.waitForSelector(".dshare-current", { timeout: 15_000 });
    check("the selection is explicit and shown", /Using .*Director/.test(await rp.locator(".dshare-current").innerText()));
    await rp.screenshot({ path: path.join(shots, "recipient-selected.png") });
    await closeSettings(rp);
    await rp.waitForSelector(".shared-director-strip", { timeout: 10_000 });
    check("the Director header names the donor", /Shared by/.test(await rp.locator(".shared-director-strip").innerText()));
    check("the runtime label says shared", /shared by/i.test(await rp.locator(".rail-head-title").innerText()));

    await sendToDirector(rp, "Hi, who is answering me today?");
    const replied = await waitFor(() => directorMessages(recipientDir).some((m) => m.role === "director" && m.content === REPLY), 60_000);
    check("a real Director round trip completes on the shared capacity", !!replied, JSON.stringify(directorMessages(recipientDir).slice(-3)));
    await rp.waitForSelector(`text=${REPLY}`, { timeout: 15_000 }).catch(() => {});
    check("the reply is shown in the recipient's chat", (await rp.locator(`text=${REPLY}`).count()) > 0);
    const call = provider.state.calls[0];
    check("the provider saw the donor's key, on the donor's host", call?.auth === `Bearer ${DONOR_KEY}`);
    check("the donor fixed JSON output and the output cap", call?.format === "json_object" && call?.maxTokens === 4096 && call?.model === MODEL);
    check("the recipient's message reached the provider", call?.messages.some((m) => m.content.includes("who is answering me today")));
    const recipientDb = fs.readFileSync(path.join(recipientDir, "orchestrator.sqlite"));
    check("the donor's key never reached the recipient's database", !recipientDb.includes(Buffer.from(DONOR_KEY)));
    await rp.screenshot({ path: path.join(shots, "recipient-director-reply.png") });
    const usage = await waitFor(() => (shares(donorDir)["openai-api"]?.usage?.requests ?? 0) >= 1 && shares(donorDir)["openai-api"].usage, 15_000);
    check("the donor accounts the request and tokens", usage && usage.inputTokens === 900 && usage.outputTokens === 20, JSON.stringify(usage));
    check("the donor sees who used it", usage && Object.values(usage.recipients).some((r) => r.requests >= 1));

    console.log("\n=== donor edits the deadline ===\n");
    const later = await localDeadline(dp, 3 * 60 * 60_000);
    await openaiRow.locator('input[type="datetime-local"]').fill(later.value);
    await openaiRow.locator('button:has-text("Save changes")').click();
    const moved = await waitFor(() => shares(donorDir)["openai-api"]?.expiresAt === later.at, 15_000);
    check("the edited deadline is stored", !!moved);
    const followed = await waitFor(() => JSON.parse(readKv(recipientDir, "director_shared_selection_v1") || "{}").expiresAt === later.at, 40_000);
    check("the recipient's selection follows the new deadline", !!followed);
    check("the share id is unchanged by an edit", shares(donorDir)["openai-api"].shareId === live.shareId);

    console.log("\n=== Stop sharing while a call is running ===\n");
    await sendToDirector(rp, "Please think about this one for a while. HOLD");
    await waitFor(() => provider.state.held >= 1, 40_000);
    check("the held call reached the provider", provider.state.held >= 1);
    await openaiRow.locator('button:has-text("Stop sharing")').click();
    await waitFor(() => shares(donorDir)["openai-api"]?.status === "stopped", 15_000);
    check("Stop sharing ends the share", shares(donorDir)["openai-api"]?.status === "stopped");
    await waitFor(() => provider.state.aborted >= 1, 15_000);
    check("the running provider call was cancelled", provider.state.aborted >= 1);
    const stopNote = await waitFor(() => directorMessages(recipientDir).find((m) => m.role === "director" && /stopped sharing/.test(m.content)), 30_000);
    check("the recipient is told the donor stopped, with no fallback", !!stopNote && /Nothing was sent to your own subscriptions/.test(stopNote.content), JSON.stringify(directorMessages(recipientDir).slice(-2)));
    await waitFor(async () => /No longer shared|Donor offline/i.test(await rp.locator(".shared-director-strip").innerText()), 30_000);
    check("the recipient header shows it is no longer shared", /No longer shared/i.test(await rp.locator(".shared-director-strip").innerText()));
    check("the donor row is Private again", !!await waitFor(async () => /private/i.test(await openaiRow.locator(".share-chip").innerText()), 15_000));
    await rp.screenshot({ path: path.join(shots, "recipient-after-stop.png") });

    console.log("\n=== re-sharing validates the provider's current model list ===\n");
    provider.state.holdModels = true;
    await dp.reload();
    await dp.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
    await openSharingSettings(dp);
    await waitFor(() => provider.state.modelReplies.length > 0, 15_000);
    check("a previous model cannot enable Share while the picker is loading", /Loading models/.test(await openaiRow.locator("select").first().innerText()) && await openaiRow.locator('button:text-is("Share")').isDisabled());
    provider.state.models = ["gpt-lab-replacement"];
    provider.state.holdModels = false;
    provider.state.modelReplies.splice(0).forEach((reply) => reply());
    check("a removed model is replaced with one the provider currently lists", !!await waitFor(async () => (await openaiRow.locator("select").first().inputValue()) === "gpt-lab-replacement", 15_000));
    provider.state.models = [];
    await dp.reload();
    await dp.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
    await openSharingSettings(dp);
    await openaiRow.locator("select").first().getByText("No models listed", { exact: true }).waitFor({ state: "attached", timeout: 15_000 });
    check("no eligible models keeps Share disabled despite the previous share", await openaiRow.locator('button:text-is("Share")').isDisabled());
    provider.state.models = [MODEL];
    await dp.reload();
    await dp.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
    await openSharingSettings(dp);
    check("a confirmed available model enables a fresh opt-in", !!await waitFor(async () => (await openaiRow.locator("select").first().inputValue()) === MODEL && await openaiRow.locator('button:text-is("Share")').isEnabled(), 15_000));

    console.log("\n=== a live share expires on the donor's clock ===\n");
    const soon = await localDeadline(dp, 70_000);
    await openaiRow.locator('input[type="datetime-local"]').fill(soon.value);
    await openaiRow.locator('button:text-is("Share")').click();
    const fresh = await waitFor(() => shares(donorDir)["openai-api"]?.status === "shared" && shares(donorDir)["openai-api"], 15_000);
    check("sharing again mints a new share id", fresh && fresh.shareId !== live.shareId);
    await openSharingSettings(rp);
    const freshOffer = rp.locator(`.dshare-offer[data-share="${fresh.shareId}"]`);
    await freshOffer.waitFor({ timeout: 40_000 });
    await freshOffer.locator('button:has-text("Use as my Director")').click();
    await waitFor(() => JSON.parse(readKv(recipientDir, "director_shared_selection_v1") || "{}").shareId === fresh.shareId, 15_000);
    const callsBefore = provider.state.calls.length;
    console.log(`  (waiting ${Math.round((soon.at - Date.now()) / 1000)}s for the deadline)`);
    await waitFor(() => Date.now() > soon.at + 2_000, 200_000, 1_000);
    const expired = await waitFor(() => shares(donorDir)["openai-api"]?.status === "expired", 20_000);
    check("the share expires at its deadline with nobody touching it", !!expired && shares(donorDir)["openai-api"].endedAt === soon.at);
    await waitFor(async () => /expired/i.test(await openaiRow.locator(".share-chip").innerText()), 15_000);
    check("the donor's chip reads Expired", /expired/i.test(await openaiRow.locator(".share-chip").innerText()));
    check("the expired offer is gone from the recipient's list", await waitFor(async () => (await freshOffer.count()) === 0, 30_000));
    await closeSettings(rp);
    await sendToDirector(rp, "Are you still there?");
    const expiredNote = await waitFor(() => directorMessages(recipientDir).find((m) => m.role === "director" && /expired/.test(m.content) && /Nothing was sent/.test(m.content)), 30_000);
    check("a turn after expiry is refused with the reason", !!expiredNote, JSON.stringify(directorMessages(recipientDir).slice(-2)));
    check("no provider call was made after the deadline", provider.state.calls.length === callsBefore);
    check("an expired share cannot be edited back to life", (await openaiRow.locator('button:has-text("Save changes")').count()) === 0);
    await dp.screenshot({ path: path.join(shots, "donor-expired.png") });

    console.log("\n=== a deadline that passes while the donor is down ===\n");
    const third = await localDeadline(dp, 2 * 60 * 60_000);
    await openaiRow.locator('input[type="datetime-local"]').fill(third.value);
    await openaiRow.locator('button:text-is("Share")').click();
    const beforeDown = await waitFor(() => shares(donorDir)["openai-api"]?.status === "shared" && shares(donorDir)["openai-api"], 15_000);
    check("shared again for the downtime check", !!beforeDown);
    await donor.context.close();
    killInstance(DONOR_PORT);
    await new Promise((r) => setTimeout(r, 2_000));
    // The server is down when the deadline passes: move the stored deadline into the past while it is off.
    const record = shares(donorDir);
    record["openai-api"].expiresAt = Date.now() - 60_000;
    seedKv(donorDir, { director_shares_v1: JSON.stringify(record) });
    await boot({ dataDir: donorDir, port: DONOR_PORT, env: donorEnv });
    const afterBoot = await waitFor(() => shares(donorDir)["openai-api"]?.status === "expired", 20_000);
    check("the missed deadline is applied when the donor boots", !!afterBoot);
    const donor2 = await openConsole(browser, DONOR_PORT);
    await openSharingSettings(donor2.page);
    const row2 = donor2.page.locator('.dshare-row[data-subscription="openai-api"]');
    await row2.waitFor({ timeout: 20_000 });
    check("after the downtime the row reads Expired", /expired/i.test(await row2.locator(".share-chip").innerText()));
    await openSharingSettings(rp);
    check("nothing is offered to the recipient after the downtime", await waitFor(async () => (await rp.locator(`.dshare-offer[data-share="${beforeDown.shareId}"]`).count()) === 0, 30_000));

    console.log("\n=== phone width ===\n");
    const phone = await openConsole(browser, RECIPIENT_PORT, { width: 390, height: 844 });
    await openSharingSettings(phone.page);
    const overflow = await phone.page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]');
      const panels = [...document.querySelectorAll(".dshare")].filter((el) => el.getClientRects().length);
      return { dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : -1, wide: panels.filter((p) => p.scrollWidth > p.clientWidth + 1).length, shown: panels.length };
    });
    check("the panel fits a phone with nothing sideways", overflow.shown > 0 && overflow.dialog <= 1 && overflow.wide === 0, JSON.stringify(overflow));
    await phone.page.screenshot({ path: path.join(shots, "recipient-phone.png"), fullPage: true });
    await phone.context.close();
    await donor2.context.close();
    await recipient.context.close();
  } finally {
    await browser?.close().catch(() => {});
    killInstance(DONOR_PORT);
    killInstance(RECIPIENT_PORT);
    killInstance(RELAY_PORT);
    relayProc?.kill();
    provider?.server.close();
  }
  console.log(`\nscreenshots: ${shots}`);
  process.exit(check.summary());
}

main().catch((e) => {
  console.error(e);
  killInstance(DONOR_PORT);
  killInstance(RECIPIENT_PORT);
  killInstance(RELAY_PORT);
  process.exit(1);
});
