/* labContextGuard: refuse to let a lab run two browser contexts at once.
 *
 * Why this exists, twice over. `screensaver-lab.cjs` closed its main context only on the `--video`
 * path, because closing a context is what flushes a Playwright recording. Without the flag the
 * context leaked, so every later step ran beside a SECOND console that kept going idle, raising its
 * own full-screen scene and running its own rAF loop in the background. The lab then failed 2 runs
 * in 3, at two DIFFERENT steps, with nothing to show but `Timeout 120000ms exceeded`. The fix for
 * that missed two more contexts in the same file, and the follow-up audit is what found them: a
 * leaked context is invisible at the site that leaks it and only misbehaves somewhere else.
 *
 * That is the shape this guard exists for. It is not a style rule. A lab measures what a console
 * does when nothing is happening to it, so a second live console is not a tidiness problem, it is
 * another participant in the measurement: it holds a socket open, it runs timers, it goes idle on
 * its own schedule, and on a busy box it competes for the CPU the assertion is timing against.
 *
 * The guard is armed by requiring `loadChromium` from `lab-harness.cjs`, so every lab gets it with
 * no edit of its own. It deliberately does NOT cover `web/scripts`' sweep probes, which open one
 * default context via `browser.newPage()` and run against prod.
 *
 * A lab that genuinely needs two consoles at once (two machines talking to one relay, say) opts out
 * with `allowConcurrentContexts()` or `GGO_LAB_ALLOW_CONCURRENT_CONTEXTS=1`. Opting out is a claim
 * that the overlap is the point; leaking one is never that.
 */

const GUARDED = Symbol.for("ggo.labContextGuard");

/** Set by a lab that means to hold two consoles open at once. */
let allowed = process.env.GGO_LAB_ALLOW_CONCURRENT_CONTEXTS === "1";

function allowConcurrentContexts(on = true) {
  allowed = on;
}

/** The CALLER's frame in a creation stack, so the error names the context that is still open rather
 *  than the one that tripped over it. Playwright's own frames and this module's are noise; anything
 *  else is the lab. Matching on `scripts/*.cjs` instead was too narrow and named nothing at all when
 *  the caller lived anywhere else. */
function creationSite(stack) {
  const frames = String(stack || "").split("\n").slice(1);
  const own = frames.find((f) => !/node_modules|labContextGuard\.cjs|[\s(]node:/.test(f));
  return (own || frames[0] || "unknown").trim().replace(/^at\s+/, "");
}

/**
 * Wrap a Playwright `chromium` so every browser it launches refuses a second live context.
 *
 * Methods are replaced as OWN properties and invoked with `apply(this, …)`, never rebound onto a
 * copy: Playwright's objects carry private fields, and a wrapper object with the wrong receiver
 * fails in ways far more confusing than the bug being prevented.
 */
function guardConcurrentContexts(chromium) {
  if (chromium[GUARDED]) return chromium;
  const launch = chromium.launch;

  chromium.launch = async function (...args) {
    const browser = await launch.apply(this, args);
    const newContext = browser.newContext;
    const newPage = browser.newPage;
    /** Contexts created through this browser and not yet closed, by creation site. */
    const live = new Map();
    /** `browser.newPage()` creates its context by calling the PUBLIC `newContext`, so without this
     *  the guard fires on a lab that simply opens two pages on the default context. That is a
     *  different thing from the leak this exists for, and several labs do it on purpose, so the
     *  nested call is exempt. The cost is honest and worth stating: a lab holding two `newPage`
     *  pages open is not watched. The defect that bit held a CONTEXT variable and forgot to close
     *  it, which is what this sees. */
    let insideNewPage = 0;

    browser.newPage = async function (...options) {
      insideNewPage++;
      try {
        return await newPage.apply(this, options);
      } finally {
        insideNewPage--;
      }
    };

    browser.newContext = async function (...options) {
      if (!allowed && !insideNewPage && live.size > 0) {
        const open = [...live.values()].join("\n    ");
        throw new Error(
          [
            "a second browser context was opened while one is still live.",
            `  opening here: ${creationSite(new Error().stack)}`,
            `  still open:\n    ${open}`,
            "",
            "  Close the earlier context before opening the next one. A leaked console keeps a socket,",
            "  its timers and its own idle clock running, which shows up as a flake in a LATER step",
            "  rather than here. If two live consoles are genuinely the point, call",
            "  allowConcurrentContexts() from lab-harness.cjs first.",
          ].join("\n"),
        );
      }
      const nested = insideNewPage > 0;
      const context = await newContext.apply(this, options);
      // Exempt from firing and exempt from being tracked, so the rule stays one sentence: the guard
      // watches the contexts a lab created ON PURPOSE. Tracking a `newPage` context here would make
      // an ordinary `newPage()` then `newContext()` lab throw for a reason nobody could act on.
      if (!nested) {
        live.set(context, creationSite(new Error().stack));
        context.on("close", () => live.delete(context));
      }
      return context;
    };
    return browser;
  };

  chromium[GUARDED] = true;
  return chromium;
}

module.exports = { guardConcurrentContexts, allowConcurrentContexts };
