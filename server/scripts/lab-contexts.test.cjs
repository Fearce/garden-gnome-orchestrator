/* Gate for `labContextGuard.cjs`: prove it DETECTS a leaked browser context before trusting it to
 * stay quiet on a correct lab. Same discipline as `db-size.test.cjs` and `hot-paths`. A checker
 * nobody has watched go red is a decoration.
 *
 * It drives the exported function with a fake Playwright, so the gate is free, needs no browser, and
 * cannot drift from the predicate the labs actually run (the trap in `change-a-sweep-check.md`: a
 * hand-copied classifier passes while the real one rots).
 */

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { guardConcurrentContexts, allowConcurrentContexts } = require("./labContextGuard.cjs");

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${label}\n      ${e.message.split("\n")[0]}`);
  }
}

/** A context is an EventEmitter that reports its own `close`, which is the only signal Playwright
 *  gives for "this one is gone" (there is no public `isClosed()` on BrowserContext). */
function fakeContext() {
  const ctx = new EventEmitter();
  ctx.close = async () => ctx.emit("close");
  return ctx;
}

/** A `chromium` whose real methods live on the PROTOTYPE and read a private-ish field off `this`.
 *  That shape is the point: the guard must replace methods as own properties and `apply` them with
 *  the original receiver, or Playwright's own private fields throw. A fake with plain own-property
 *  methods would pass even for a wrapper that rebinds `this`, and prove nothing. */
function fakeChromium() {
  class Browser {
    constructor(owner) {
      this.owner = owner;
    }
    async newContext() {
      assert.equal(this.owner, "real", "newContext lost its receiver");
      return fakeContext();
    }
    /** Real Playwright builds a page's context by calling the PUBLIC `newContext`, which is exactly
     *  how the first version of this guard blocked every lab that opens two pages. The fake has to
     *  reproduce that delegation or the exemption below is never actually exercised. */
    async newPage() {
      assert.equal(this.owner, "real", "newPage lost its receiver");
      const ctx = await this.newContext();
      return { context: ctx };
    }
  }
  class Chromium {
    constructor() {
      this.owner = "real";
    }
    async launch() {
      assert.equal(this.owner, "real", "launch lost its receiver");
      return new Browser(this.owner);
    }
  }
  return new Chromium();
}

async function main() {
  console.log("lab context guard");

  // 1. One context on its own is the ordinary lab, and must stay silent.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    let threw = null;
    try {
      await browser.newContext();
    } catch (e) {
      threw = e;
    }
    check("one context is allowed", () => assert.equal(threw, null));
  }

  // 2. THE DEFECT. This is the shape screensaver-lab shipped: open, never close, open again.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    await browser.newContext();
    let threw = null;
    try {
      await browser.newContext();
    } catch (e) {
      threw = e;
    }
    check("a second context while one is live is refused", () => assert.ok(threw, "expected a throw"));
    check("the refusal names the context that is still open", () =>
      assert.match(String(threw && threw.message), /still open/),
    );
    check("the refusal says how to fix it", () =>
      assert.match(String(threw && threw.message), /Close the earlier context/),
    );
  }

  // 3. Close-then-open is the correct sequential lab (supervisor-lab, tablet-lab, ide-lab).
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    const first = await browser.newContext();
    await first.close();
    let threw = null;
    try {
      await browser.newContext();
    } catch (e) {
      threw = e;
    }
    check("closing before the next one is allowed", () => assert.equal(threw, null));
  }

  // 4. Many, closed each time, over a loop: the per-width phone passes.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    let threw = null;
    try {
      for (let i = 0; i < 5; i++) {
        const ctx = await browser.newContext();
        await ctx.close();
      }
    } catch (e) {
      threw = e;
    }
    check("a loop that closes each pass never trips", () => assert.equal(threw, null));
  }

  // 5. Two browsers are independent: one lab's console must not count against another's.
  {
    const chromium = guardConcurrentContexts(fakeChromium());
    const a = await chromium.launch();
    const b = await chromium.launch();
    await a.newContext();
    let threw = null;
    try {
      await b.newContext();
    } catch (e) {
      threw = e;
    }
    check("a second BROWSER gets its own budget", () => assert.equal(threw, null));
  }

  // 6. The opt-out, for a lab that means to hold two consoles at once.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    allowConcurrentContexts(true);
    let threw = null;
    try {
      await browser.newContext();
      await browser.newContext();
    } catch (e) {
      threw = e;
    } finally {
      allowConcurrentContexts(false);
    }
    check("allowConcurrentContexts() opts out deliberately", () => assert.equal(threw, null));
  }

  // 7. And the opt-out must not be sticky, or one lab's exemption silences every later check.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    await browser.newContext();
    let threw = null;
    try {
      await browser.newContext();
    } catch (e) {
      threw = e;
    }
    check("the opt-out does not leak into the next run", () => assert.ok(threw, "expected a throw"));
  }

  // 8. `browser.newPage()` twice is the default-context lab (chip-lab, code-nav-lab, office-lab).
  //    It reaches the same public `newContext`, so an unexempted guard reds every one of them.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    let threw = null;
    try {
      await browser.newPage();
      await browser.newPage();
    } catch (e) {
      threw = e;
    }
    check("newPage() twice is not mistaken for a leak", () => assert.equal(threw, null));
  }

  // 9. And a page's context must not be TRACKED either, or the next explicit context throws for a
  //    reason the lab author cannot act on.
  {
    const browser = await guardConcurrentContexts(fakeChromium()).launch();
    let threw = null;
    try {
      await browser.newPage();
      await browser.newContext();
    } catch (e) {
      threw = e;
    }
    check("a page's context does not count against an explicit one", () => assert.equal(threw, null));
  }

  // 10. Wrapping twice must not stack two guards on one object.
  {
    const chromium = fakeChromium();
    const once = guardConcurrentContexts(chromium);
    const twice = guardConcurrentContexts(chromium);
    check("guarding is idempotent", () => assert.equal(once, twice));
  }

  console.log(failures === 0 ? "\nlab context guard passed." : `\n${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
