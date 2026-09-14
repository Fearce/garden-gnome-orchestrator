// Drive the PHONE recovery path for a stale lazy chunk — the crash the owner reported twice:
// "clicking the git icon on phone crashes the Web page", and the same for the IDE.
//
//   npm run mobile-chunk-lab --prefix server
//   npm run mobile-chunk-lab --prefix server -- --keep              leave the instance up to poke at
//   npm run mobile-chunk-lab --prefix server -- --shots data/mobile-chunk-shots
//   npm run mobile-chunk-lab --prefix server -- --no-fault          negative control: MUST go red
//
// The bug: web/dist is rebuilt constantly here (every deploy, plus the auto-build watcher), and Vite
// names each chunk by content hash, so a rebuild DELETES the filenames a long-lived tab is still
// holding. A phone tab survives backgrounded for days with its old module graph in memory and its
// `/api/version` poll suspended, so the first tap on Git or the IDE fires a dynamic import for a
// chunk that no longer exists. That rejection reaches React with no boundary above it, React
// unmounts the whole tree, and the page goes white — exactly what the owner sees. Desktop rarely
// hits it because the tab is reloaded often enough to stay on the current bundle.
//
// Why this lab and not the unit gate: `test:lazy-chunks-ui` greps the JSX for `LazyChunkBoundary`.
// That proves the element is written down, not that a 404 is caught, not that the one-shot reload
// fires, and not that a SECOND failure degrades to a card instead of a reload loop — which is the
// part a phone would suffer worst. So this drives a real touch context against a throwaway instance
// and 404s the chunk itself.
//
// Vacuous-pass protection: every assertion here is POSITIVE evidence. The recovery card only exists
// in the boundary's error state, so seeing it proves the boundary ran; and the run fails outright if
// the intercepted 404 never actually fired, which is the one way this could pass while testing
// nothing. `--no-fault` is the standing negative control for that claim — it runs the identical
// script with the 404 never armed, and every stale-tab check has to go RED. It exists because the
// honest revert-check (delete the boundary, rebuild) cannot be done on this box: the running server
// polls web/ every 5s and rebuilds web/dist from source, so a reverted file is a live deploy of a
// crashing console to the owner's phone.
//
// Why it can't disturb anything: temp DATA_DIR (prod's sqlite is never opened, and an empty thread
// table means the on-boot auto-resume has nothing to revive), bogus account tokens (the boot ping can
// neither burn quota nor start a real 5h window), alt port, killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadChromium,
  authPassword,
  requireBuild,
  requireFreshWebBuild,
  boot,
  killInstance,
  createChecks,
  shotDir,
} = require("./lab-harness.cjs");

// Clear of every sibling lab's port AND of each one's `port + 2` HTTPS listener (4327/4331/4337/
// 4341/4347/4351/4353/4361/4371/4373/4381/4383/4385/4391/4397/4401/4477/4497/5317/5417).
const PORT = 4405;
const BASE = `http://127.0.0.1:${PORT}`;

// The iPhone pair's width. The crash is not width-dependent — it is a module-graph failure — so one
// realistic phone is enough here; `phone-lab` owns the 320–430 geometry sweep.
const VIEWPORT = { width: 390, height: 844 };

const check = createChecks();

/**
 * Serve every asset the boot already pulled, and 404 anything new once armed.
 *
 * That split is what makes a stale tab reproducible: the entry chunk and its static imports are in
 * the baseline, so the app still BOOTS (and still boots after the recovery reload), while a chunk
 * first requested by a tap is exactly the file a rebuild would have deleted. Recording stops once
 * the console is up, or opening a surface once would whitelist its chunk for the rest of the run.
 */
async function installStaleChunkRoute(page, state) {
  await page.route("**/assets/*.js", async (route) => {
    const url = route.request().url();
    if (state.recording) state.baseline.add(url);
    if (!state.armed || state.baseline.has(url)) return route.continue();
    state.refused.push(url);
    return route.fulfill({ status: 404, contentType: "text/plain", body: "chunk gone" });
  });
}

/** A console that has really finished booting: the shell plus a hello-only surface. */
async function waitForConsole(page) {
  await page.waitForSelector(".topbar", { timeout: 20_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
}

/** Load the console with the boot's own assets whitelisted, leaving the route disarmed. */
async function freshLoad(page, state) {
  state.armed = false;
  state.recording = true;
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await waitForConsole(page);
  state.recording = false;
}

/** Wait for the boundary to refresh the tab on its own, counting real main-frame navigations rather
 *  than guessing from a timer — a fixed sleep would report a slow box as a missing reload. */
async function waitForSelfReload(state, from, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && state.navigations === from) await new Promise((r) => setTimeout(r, 200));
  return state.navigations > from;
}

/** The app is alive when its shell is still mounted — a React tree that unmounted leaves #root empty,
 *  which is the white page the owner reported. */
async function appAlive(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    return !!root && root.childElementCount > 0 && !!document.querySelector(".topbar");
  });
}

async function openIdeView(page) {
  await page.selectOption('select[aria-label="All areas"]', "ide");
}

// ---- the three phases --------------------------------------------------------------------------

/** Phase 1: on a CURRENT bundle both surfaces must simply work on a phone. Without this the later
 *  phases could pass over a console where Git and the IDE never open at all. */
async function control(page, state) {
  await freshLoad(page, state);
  await page.click('[aria-label="Open Git"]');
  await page.waitForSelector(".gc-window", { timeout: 25_000 });
  check("current bundle: the Git console opens on a phone", true);

  await freshLoad(page, state);
  await openIdeView(page);
  await page.waitForSelector(".ide", { timeout: 25_000 });
  check("current bundle: the IDE opens on a phone", true);
}

/**
 * The stale tab, for one surface. The first failure must refresh the tab onto the current bundle;
 * the second must stop refreshing and say so, because a phone that reload-loops is worse than one
 * that crashed. `open` is retried after the refresh only when the reload did not already restore the
 * surface from persisted view state — either way the card is what has to appear.
 */
async function staleChunk(page, state, { label, open, card, wants }) {
  await freshLoad(page, state);
  state.armed = !process.argv.includes("--no-fault");

  const navsBefore = state.navigations;
  await open();
  const reloaded = await waitForSelfReload(state, navsBefore);
  await waitForConsole(page);
  check(`stale ${label} chunk: the tab refreshed itself onto the current bundle`, reloaded, `navigations ${navsBefore} -> ${state.navigations}`);
  check(`stale ${label} chunk: the refresh did not leave a white page`, await appAlive(page));
  // Report the rest rather than driving on: with no recovery to observe, the surface is simply open,
  // and a second `open()` would time out against its own scrim — a stack where the failing assertion
  // belongs. This is the shape `--no-fault` takes, so it has to stay readable.
  if (!reloaded) {
    for (const rest of ["a second failure shows the recovery card", "the card offers a refresh", "the console behind it is still mounted", "it refreshes at most once, never in a loop"]) {
      check(`stale ${label} chunk: ${rest}`, false, "no self-refresh happened, so the recovery path never ran");
    }
    return;
  }

  const navsAfterReload = state.navigations;
  if (!(await page.isVisible(card))) await open();
  await page.waitForSelector(card, { state: "visible", timeout: 20_000 });
  const text = (await page.textContent(card)) || "";
  check(`stale ${label} chunk: a second failure shows the recovery card`, wants.test(text), text.slice(0, 120));
  check(`stale ${label} chunk: the card offers a refresh`, await page.isVisible(`${card} button:has-text("Refresh")`));
  check(`stale ${label} chunk: the console behind it is still mounted`, await appAlive(page));

  await new Promise((r) => setTimeout(r, 3000));
  check(`stale ${label} chunk: it refreshes at most once, never in a loop`, state.navigations === navsAfterReload, `${state.navigations - navsAfterReload} extra reload(s)`);
}

async function rmWithRetry(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 19) return void console.log(`\n  (temp dir left behind — ${e.code}: ${dir})`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

(async () => {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-chunk-lab-"));
  const shots = shotDir(dataDir);
  let browser;
  try {
    await boot({ dataDir, port: PORT, env: { ACCOUNT_1_ID: "acct1", ACCOUNT_1_LABEL: "personal" } });
    browser = await loadChromium().launch();
    const state = { armed: false, recording: false, baseline: new Set(), refused: [], navigations: 0 };

    // Each phase gets its OWN context: the board view and the open Git console survive a reload in
    // web storage, so a phase inheriting the previous one's storage starts on the surface it is about
    // to test. Sequential, never concurrent — `labContextGuard` refuses a second live context.
    const phase = async (title, body) => {
      // hasTouch/isMobile are CONTEXT options — a viewport alone leaves Chromium on a fine pointer,
      // so every coarse-pointer rule the phone actually gets would go unmeasured.
      const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
      const page = await ctx.newPage();
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame()) state.navigations++;
      });
      await installStaleChunkRoute(page, state);
      await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      console.log(`\n════ ${VIEWPORT.width}×${VIEWPORT.height}, touch — ${title}`);
      try {
        await body(page);
      } finally {
        await ctx.close();
      }
    };

    await phase("a current bundle", (page) => control(page, state));
    await phase("a stale tab: the Git console's chunk was rebuilt away", async (page) => {
      await staleChunk(page, state, {
        label: "Git",
        open: () => page.click('[aria-label="Open Git"]'),
        card: ".modal-load-error",
        wants: /Git console did not load/i,
      });
      await page.screenshot({ path: path.join(shots, "git-chunk-recovery.png") });
    });
    await phase("a stale tab: the IDE's chunk was rebuilt away", async (page) => {
      await staleChunk(page, state, {
        label: "IDE",
        open: () => openIdeView(page),
        card: ".ide-load-error",
        wants: /IDE did not load/i,
      });
      await page.screenshot({ path: path.join(shots, "ide-chunk-recovery.png") });
    });
    // The one way everything above could be green while proving nothing.
    check("the stale-chunk 404 actually fired", state.refused.length >= 2, `${state.refused.length} refused request(s)`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep) {
      killInstance(PORT);
      await rmWithRetry(dataDir);
    } else {
      console.log(`\n  instance: ${BASE}  (data: ${dataDir})`);
    }
  }
  process.exit(check.summary());
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
