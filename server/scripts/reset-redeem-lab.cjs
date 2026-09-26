// Drive the banked-reset redeem ("↻1" on a subscription chip → confirm → the provider's own redeem call)
// in a real browser, against fake providers, so no real reset is ever spent.
//
//   npm run reset-redeem-lab --prefix server
//   npm run reset-redeem-lab --prefix server -- --keep       (leave the instance + fixtures behind)
//
// Use it for any change to Accounts.tsx's ResetCreditBadge, the `resetCredit.redeem` command,
// `AccountManager.redeemResetCredit`, `claimClaudeReset` or `redeemCodexResetCredit`.
//
// Why a lab and not only the unit gate: the thing that can silently break is the WIRING, a badge
// that renders but sends nothing, a confirm that is skipped, a command the hub drops, a result that
// never settles the button. `test:reset-credits` proves the parsers and the claim request; this
// proves a click spends exactly one reset, a cancel spends none, and a refusal says why.
//
// Why it can't spend anything real:
//  - Claude: PROFILE_USAGE_URL and PROFILE_CLAIM_BASE_URL point at a fixture server in THIS process,
//    and both subscriptions get bogus profile tokens explicitly, so a real `ACCOUNT_<n>_PROFILE_TOKEN`
//    in server/.env never reaches even the fixture.
//  - Codex: CODEX_BIN_JS is a fake `app-server` written below, with its own temp CODEX_HOME and a fake
//    ChatGPT login as its source, and CODEX_WAKE=off so no turn is ever started.
//  - Its own compiled server (`.reset-redeem-lab-dist`) and web bundle (`.lab-web-dist`), a temp
//    DATA_DIR, and an alt port: the live console's dist is never touched.
//
// PRIOR-ART-OK: this is a browser lab; the only line-splitting below is the fake app-server's JSON-RPC
// reader, not a text edit.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4351;
const BASE = `http://127.0.0.1:${PORT}`;
const ORG = "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a9e7f10";
const CLAUDE_GRANT = "grant_lab_1";
const CODEX_CREDIT = "RateLimitResetCredit_lab_1";

// ---- the isolated build --------------------------------------------------------------------------

/** Compile the CURRENT server source without touching live `dist` (see code-nav-lab for why it must be
 *  a direct child of the server root). */
function compileIsolatedServer() {
  const buildDir = path.join(SERVER_ROOT, ".reset-redeem-lab-dist");
  fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", buildDir], {
    cwd: SERVER_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  return path.join(buildDir, "index.js");
}

// ---- fake Claude profile API ---------------------------------------------------------------------

/**
 * The two endpoints GGO calls for a Claude subscription's banked resets. `personal` has one reset the
 * claim spends; `secondary` has one that Claude refuses (`not_limited`), which must leave it banked.
 * Each subscription is told apart by its bogus profile token.
 */
function startClaudeFixture() {
  const state = { personal: { left: 1, claims: [] }, secondary: { left: 1, claims: [] } };
  const who = (req) => (String(req.headers.authorization).endsWith("lab-profile-secondary") ? "secondary" : "personal");
  const server = http.createServer((req, res) => {
    const sub = state[who(req)];
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url.startsWith("/usage")) {
      return reply(200, {
        organization: { uuid: ORG },
        cedar_ember: {
          eligible: true,
          next_grant_id: CLAUDE_GRANT,
          grants: sub.left > 0
            ? [{ id: CLAUDE_GRANT, label: "Full reset", resets_total: 1, resets_left: sub.left, ends_at: new Date(Date.now() + 9 * 86_400_000).toISOString(), paused: false, usable_now: true, use_requires_limit: true }]
            : [],
        },
      });
    }
    const claim = /^\/api\/organizations\/([^/]+)\/reset_rate_limits$/.exec(req.url);
    if (req.method === "POST" && claim) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        sub.claims.push({ org: claim[1], body });
        if (sub === state.secondary) return reply(200, { result: "not_limited", reason: "not_limited", resets_left: sub.left });
        sub.left = 0;
        reply(200, { result: "reset", resets_left: 0, cleared: ["five_hour"] });
      });
      return;
    }
    reply(404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---- fake Codex app-server -----------------------------------------------------------------------

/** A stand-in for `codex app-server`: newline-delimited JSON-RPC on stdio, answering exactly the three
 *  requests GGO makes. Its state (whether the credit was spent, and every consume it received) lives in
 *  a file, because each GGO call spawns a fresh process. */
const FAKE_CODEX = `
const fs = require("node:fs");
const file = process.env.RESET_LAB_CODEX_STATE;
const load = () => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (s) => fs.writeFileSync(file, JSON.stringify(s));
if (process.argv[2] !== "app-server") process.exit(2);
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const s = load();
    const now = Math.floor(Date.now() / 1000);
    if (msg.method === "initialize") out({ id: msg.id, result: {} });
    else if (msg.method === "account/rateLimits/read") {
      const capped = !s.consumed;
      out({ id: msg.id, result: {
        rateLimits: {
          primary: { usedPercent: capped ? 100 : 0, resetsAt: now + 3 * 3600, windowDurationMins: 300 },
          secondary: { usedPercent: 40, resetsAt: now + 4 * 86400, windowDurationMins: 10080 },
          planType: "plus", rateLimitReachedType: capped ? "primary" : null, spendControlReached: false,
        },
        rateLimitResetCredits: s.consumed
          ? { availableCount: 0, credits: [] }
          : { availableCount: 1, credits: [{ id: "${CODEX_CREDIT}", resetType: "codexRateLimits", status: "available", grantedAt: now - 86400, expiresAt: now + 20 * 86400, title: "Full reset" }] },
      } });
    } else if (msg.method === "account/rateLimitResetCredit/consume") {
      s.consumes.push(msg.params);
      const outcome = s.consumed ? "noCredit" : "reset";
      s.consumed = true;
      save(s);
      out({ id: msg.id, result: { outcome } });
    }
  }
});
`;

function writeCodexFixture(base) {
  const dir = path.join(base, "codex");
  fs.mkdirSync(path.join(dir, "source-home"), { recursive: true });
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  const bin = path.join(dir, "fake-codex.js");
  fs.writeFileSync(bin, FAKE_CODEX);
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ consumed: false, consumes: [] }));
  // A ChatGPT-shaped login so the Codex chip is "configured"; the fake never reads it.
  fs.writeFileSync(path.join(dir, "source-home", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "lab" } }));
  return { bin, stateFile, sourceHome: path.join(dir, "source-home"), home: path.join(dir, "home"), read: () => JSON.parse(fs.readFileSync(stateFile, "utf8")) };
}

// ---- the drive -----------------------------------------------------------------------------------

const check = createChecks();

const badge = (chip) => `${chip} button.reset-credit`;
const CODEX_CHIP = ".accounts .acct.codex";
const claudeChip = (label) => `.accounts .acct:not(.codex):has(.acct-label:text-is("${label}"))`;

/** Click the badge and answer its confirm; returns the confirm's text. */
async function clickAndAnswer(page, selector, accept) {
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void (accept ? d.accept() : d.dismiss());
  });
  await page.click(selector);
  await page.waitForTimeout(800);
  return asked;
}

/** The notice banner the redeem's result lands in (NoticeBanner.tsx), not the Token Safety box. */
const NOTICE = ".notice-banner:not(.token-safety)";

async function noticeText(page) {
  await page.waitForSelector(NOTICE, { timeout: 45_000 });
  return (await page.textContent(NOTICE))?.replace(/\s+/g, " ").trim() ?? "";
}

async function dismissNotice(page) {
  await page.click(`${NOTICE} .notice-x`);
  await page.waitForSelector(NOTICE, { state: "detached", timeout: 10_000 });
}

async function drive(page, shots, claude, codex) {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });

  console.log("\nCODEX: the ↻1 badge redeems the banked full reset, only after a confirm");
  await page.waitForSelector(badge(CODEX_CHIP), { timeout: 60_000 });
  check("the Codex chip's ↻1 is a button", (await page.textContent(badge(CODEX_CHIP)))?.trim() === "↻1");
  const asked = await clickAndAnswer(page, badge(CODEX_CHIP), false);
  check("clicking asks before redeeming", /Redeem your banked full reset on Codex now\?/.test(asked), asked);
  check("the question says it cannot be undone", /cannot be undone/.test(asked), asked);
  await page.waitForTimeout(1_500);
  check("cancelling redeems nothing", codex.read().consumes.length === 0, JSON.stringify(codex.read()));
  check("and the badge is still there", await page.isVisible(badge(CODEX_CHIP)));

  await clickAndAnswer(page, badge(CODEX_CHIP), true);
  const codexNotice = await noticeText(page);
  check("confirming redeems exactly one credit", codex.read().consumes.length === 1, JSON.stringify(codex.read().consumes));
  const consume = codex.read().consumes[0] ?? {};
  check("naming the credit the read reported", consume.creditId === CODEX_CREDIT, JSON.stringify(consume));
  check("with a fresh idempotency key", /^[0-9a-f-]{36}$/.test(consume.idempotencyKey ?? ""), JSON.stringify(consume));
  check("the owner is told it worked", /Banked reset used/i.test(codexNotice) && /Codex limits refilled/.test(codexNotice), codexNotice);
  await page.waitForSelector(badge(CODEX_CHIP), { state: "detached", timeout: 45_000 }).catch(() => {});
  check("the badge is gone once the credit is spent", (await page.$(badge(CODEX_CHIP))) === null);
  await page.screenshot({ path: path.join(shots, "reset-redeem-codex.png") });
  await dismissNotice(page);

  console.log("\nCLAUDE: a subscription's banked reset is claimed through its profile token");
  await page.waitForSelector(badge(claudeChip("personal")), { timeout: 60_000 });
  const claudeAsked = await clickAndAnswer(page, badge(claudeChip("personal")), true);
  check("it asks first here too", /Redeem your banked full reset on personal now\?/.test(claudeAsked), claudeAsked);
  const claudeNotice = await noticeText(page);
  const claim = claude.state.personal.claims[0];
  check("one claim reached Claude's reset endpoint", claude.state.personal.claims.length === 1, JSON.stringify(claude.state.personal.claims));
  check("against the subscription's organization", claim?.org === ORG, JSON.stringify(claim));
  check(
    "for the next grant, under the cedar_ember programme, with a fresh request id",
    claim?.body?.program === "cedar_ember" && claim?.body?.grant_id === CLAUDE_GRANT && /^[0-9a-f-]{36}$/.test(claim?.body?.request_id ?? ""),
    JSON.stringify(claim?.body),
  );
  check("the owner is told it worked", /Banked reset used/i.test(claudeNotice) && /personal: Limits refilled/.test(claudeNotice), claudeNotice);
  await page.waitForSelector(badge(claudeChip("personal")), { state: "detached", timeout: 45_000 }).catch(() => {});
  check("its badge is gone once spent", (await page.$(badge(claudeChip("personal")))) === null);
  await dismissNotice(page);

  console.log("\nREFUSAL: a reset Claude will not spend yet stays banked, and the owner is told why");
  await page.waitForSelector(badge(claudeChip("secondary")), { timeout: 60_000 });
  await clickAndAnswer(page, badge(claudeChip("secondary")), true);
  const refusal = await noticeText(page);
  check("the claim was attempted", claude.state.secondary.claims.length === 1, JSON.stringify(claude.state.secondary.claims));
  check("the owner reads Claude's reason", /Reset not used/i.test(refusal) && /only lets you use this reset once you have hit a limit/.test(refusal), refusal);
  await page.waitForTimeout(2_000);
  check("the badge is still there, ready for later", await page.isVisible(badge(claudeChip("secondary"))));
  check("and clickable again", await page.isEnabled(badge(claudeChip("secondary"))));
  await page.screenshot({ path: path.join(shots, "reset-redeem-refused.png") });

  check("no console errors during the whole drive", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`\n  screenshots: ${shots}`);
}

// ---- run -----------------------------------------------------------------------------------------

(async () => {
  const keep = process.argv.includes("--keep");
  const entry = compileIsolatedServer();
  requireBuild(entry);
  requireFreshWebBuild();
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-redeem-lab-"));
  const codex = writeCodexFixture(dataDir);
  const claude = await startClaudeFixture();
  const shots = shotDir(dataDir);

  let browser;
  try {
    await boot({
      dataDir,
      port: PORT,
      entry,
      env: {
        ACCOUNT_1_ID: "acct1",
        ACCOUNT_1_LABEL: "personal",
        ACCOUNT_2_ID: "acct2",
        ACCOUNT_2_LABEL: "secondary",
        ACCOUNT_1_PROFILE_TOKEN: "lab-profile-personal",
        ACCOUNT_2_PROFILE_TOKEN: "lab-profile-secondary",
        PROFILE_USAGE_URL: `${claude.url}/usage`,
        PROFILE_CLAIM_BASE_URL: claude.url,
        CODEX_BIN_JS: codex.bin,
        CODEX_HOME_DIR: codex.home,
        CODEX_SOURCE_HOME: codex.sourceHome,
        CODEX_WAKE: "off",
        OPENAI_API_KEY: "",
        RESET_LAB_CODEX_STATE: codex.stateFile,
      },
    });
    browser = await loadChromium().launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await drive(page, shots, claude, codex);
  } finally {
    if (browser) await browser.close().catch(() => {});
    claude.server.close();
    if (!keep) {
      killInstance(PORT);
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  process.exit(check.summary());
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
