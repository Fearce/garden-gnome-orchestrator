/**
 * Gate — an image too big for the API never reaches it (`attachments.ts`, `web/src/lib/attachments.tsx`).
 *
 * Background: the console capped a pasted image at 5MB of FILE, but what is stored and sent is base64,
 * which is 4/3 of that. So every picture between 3.75MB and 5MB passed the check and produced a payload
 * the API refuses outright — not a degraded request but a dead run: "Image base64 size (5.2MB) exceeds
 * API limit (5MB)" killed a $8.04 / 40-turn implementor mid-work on 2026-08-26, and four images already
 * stored (5.02–5.56MB of base64, every one from a raw file inside that 3.75–5MB dead zone) are the same
 * failure waiting for a resume to carry them. Two guards: the console stops making them, and the last
 * point before the wire stops sending them — because the stored four predate the first guard entirely.
 *
 * WHAT IS REAL: the shipped `contentWithImages` and the console's own threshold arithmetic. No DB, no
 * agents, no network, no quota.
 *
 * Scenarios:
 *   A. THRESHOLD — the console's file cap is the size that ENCODES to the API's cap, and the historical
 *                  dead-zone sizes now fail it while an ordinary screenshot still passes.
 *   B. DROP      — an oversized block is left out of the content sent to the model, and the ones beside
 *                  it still go.
 *   C. TOLD      — the omission is stated in the text, so the picture reads as missing rather than as an
 *                  instruction pointing at nothing.
 *   D. UNCHANGED — an image-free prompt is still the bare string it always was, and a legal image is
 *                  passed through untouched.
 *
 * Run:  npm run test:image-limit   (from server/)   — or:  npx tsx src/tests/imageLimit.test.ts
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { contentWithImages, toImageBlock, MAX_IMAGE_BASE64_BYTES } = await import("../attachments.js");

/** The console's thresholds, read out of the SHIPPED file rather than restated here. Restating them
 *  would leave this gate green through exactly the regression it exists to catch — the bug was a
 *  constant set to the wrong quantity, so a copy of the right quantity proves nothing. Both right-hand
 *  sides are evaluated, not string-matched, so reformatting them is not a failure. */
const consoleSource = readFileSync(fileURLToPath(new URL("../../../web/src/lib/attachments.tsx", import.meta.url)), "utf8");

function consoleLimits(): { base64Cap: number; fileCap: number; sourceCap: number } {
  const src = consoleSource;
  const rhs = (name: string): string => {
    const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(src);
    if (!m?.[1]) throw new Error(`${name} is gone from web/src/lib/attachments.tsx — this gate reads it`);
    return m[1];
  };
  const base64Cap = Number(new Function(`return (${rhs("MAX_IMAGE_BASE64_BYTES")});`)());
  const fileCap = Number(new Function("MAX_IMAGE_BASE64_BYTES", `return (${rhs("MAX_IMAGE_BYTES")});`)(base64Cap));
  const sourceCap = Number(new Function(`return (${rhs("MAX_IMAGE_SOURCE_BYTES")});`)());
  return { base64Cap, fileCap, sourceCap };
}

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** An attachment whose base64 payload is exactly `n` characters — the quantity the API measures. */
const imageOf = (n: number, name = "shot.png") =>
  ({ name, mediaType: "image/png" as const, dataBase64: "A".repeat(n) });

/** What `readAsDataURL` produces for a file of `bytes`: 4 characters per 3 bytes, padded, no newlines. */
const base64LengthOf = (bytes: number): number => 4 * Math.ceil(bytes / 3);

const textOf = (content: string | unknown[]): string =>
  typeof content === "string" ? content : String((content[0] as { text: string }).text);
const blocksIn = (content: string | unknown[]): unknown[] => (typeof content === "string" ? [] : content.slice(1));

// ---- A. threshold ------------------------------------------------------------------------------------
console.log("\nA. threshold — the console's file cap is the one that encodes to the API's cap");
{
  const { base64Cap, fileCap: MAX_IMAGE_BYTES, sourceCap } = consoleLimits();
  check(
    "the console and the server agree on the API's limit",
    base64Cap === MAX_IMAGE_BASE64_BYTES,
    `console ${base64Cap} vs server ${MAX_IMAGE_BASE64_BYTES}`,
  );

  check(
    "a file at the cap encodes to exactly the API's cap, not past it",
    base64LengthOf(MAX_IMAGE_BYTES) === MAX_IMAGE_BASE64_BYTES,
    `${base64LengthOf(MAX_IMAGE_BYTES)} vs ${MAX_IMAGE_BASE64_BYTES}`,
  );
  check("...and one byte more encodes past it", base64LengthOf(MAX_IMAGE_BYTES + 1) > MAX_IMAGE_BASE64_BYTES);

  // The four images actually in the database when this was found, by the raw file size each came from.
  // These are no longer REFUSED — the console re-encodes them (scenario E) — but they may never be sent
  // through untouched, which is the property that killed the run.
  for (const mib of [3.77, 3.83, 3.87, 4.17]) {
    const bytes = Math.round(mib * 1024 * 1024);
    check(
      `a ${mib}MB file — which the old 5MB file cap allowed — can never be sent as-is`,
      bytes > MAX_IMAGE_BYTES && base64LengthOf(bytes) > MAX_IMAGE_BASE64_BYTES,
    );
  }
  // …without taking the ordinary case with it: a full-screen PNG screenshot is well under a megabyte.
  const ordinary = Math.round(0.9 * 1024 * 1024);
  check("an ordinary screenshot still passes", ordinary <= MAX_IMAGE_BYTES && base64LengthOf(ordinary) <= MAX_IMAGE_BASE64_BYTES);

  // The operator's own ceiling is a separate quantity from the API's, and is meant to be generous:
  // "theres no reason to limit it to just 3.8mb" (2026-09-11). What must NOT happen is the two being
  // conflated again — a bigger pick is fine precisely because it is re-encoded before it is sent.
  check("a picked file may be far larger than what the API accepts", sourceCap >= 8 * MAX_IMAGE_BYTES, `${sourceCap} vs ${MAX_IMAGE_BYTES}`);
  check(
    "...and a 12MB phone photo is accepted for resizing rather than refused",
    Math.round(12 * 1024 * 1024) <= sourceCap,
  );
}

// ---- E. re-encode ------------------------------------------------------------------------------------
// Raising the pick ceiling WITHOUT a re-encode is the original $8 dead run with a bigger number, so the
// structure that makes the bigger number safe is what is pinned here: an oversized pick must route into
// the shrink path, and every payload that path produces must be measured against the API's own cap.
console.log("\nE. re-encode — an oversized pick is resized, and the resized payload is checked");
{
  const attachFn = /async function fileToAttachment\(([\s\S]*?)\n}/.exec(consoleSource)?.[1] ?? "";
  check("fileToAttachment is still the single entry point", attachFn.length > 0);
  check(
    "a pick past the operator ceiling is refused outright",
    /f\.size > MAX_IMAGE_SOURCE_BYTES\)\s*return "size"/.test(attachFn),
    attachFn,
  );
  check(
    "a pick past the API's own cap is re-encoded, never read straight through",
    /f\.size > MAX_IMAGE_BYTES\)\s*return \(await shrinkImage\(f\)\)/.test(attachFn),
    attachFn,
  );

  const shrinkFn = /async function shrinkImage\(([\s\S]*?)\n}/.exec(consoleSource)?.[1] ?? "";
  check("shrinkImage exists", shrinkFn.length > 0);
  check(
    "...and only returns a payload that fits the API's cap",
    /dataBase64\.length <= MAX_IMAGE_BASE64_BYTES/.test(shrinkFn),
    shrinkFn,
  );
  check("...else it reports failure rather than attaching something oversized", /return null;\s*$/.test(shrinkFn.trim()));
}

// ---- B. drop -----------------------------------------------------------------------------------------
console.log("\nB. drop — an oversized block never reaches the model, the ones beside it do");
{
  const big = toImageBlock(imageOf(MAX_IMAGE_BASE64_BYTES + 1, "huge.png"));
  const small = toImageBlock(imageOf(1000, "fine.png"));

  const only = contentWithImages("look at this", [big]);
  check("the oversized block is dropped", blocksIn(only).length === 0, JSON.stringify(blocksIn(only).length));
  check("...leaving a bare string, since nothing sendable is left", typeof only === "string");

  const mixed = contentWithImages("look at these", [small, big, small]);
  check("the legal blocks beside it still go", blocksIn(mixed).length === 2, String(blocksIn(mixed).length));

  const atLimit = contentWithImages("exactly at the line", [toImageBlock(imageOf(MAX_IMAGE_BASE64_BYTES))]);
  check("a block exactly AT the limit is still sent — the API rejects what exceeds it", blocksIn(atLimit).length === 1);
}

// ---- C. told -----------------------------------------------------------------------------------------
console.log("\nC. told — the omission is stated, not silent");
{
  const one = textOf(contentWithImages("describe the screenshot", [toImageBlock(imageOf(MAX_IMAGE_BASE64_BYTES + 1))]));
  check("the prompt still carries the operator's own words", one.includes("describe the screenshot"));
  check("...and says an image was left out", /left out/i.test(one), one);
  check("...naming the limit as the reason", one.includes("per-image limit"), one);
  check("...in the singular for one image", /1 attached image was/.test(one), one);

  const two = textOf(
    contentWithImages("compare them", [
      toImageBlock(imageOf(MAX_IMAGE_BASE64_BYTES + 1)),
      toImageBlock(imageOf(MAX_IMAGE_BASE64_BYTES + 1)),
    ]),
  );
  check("...and the plural for two", /2 attached images were/.test(two), two);
}

// ---- D. unchanged ------------------------------------------------------------------------------------
console.log("\nD. unchanged — the paths that were already fine are byte-identical");
{
  const bare = contentWithImages("no pictures here", []);
  check("an image-free prompt is still the bare string", bare === "no pictures here", JSON.stringify(bare));

  const legal = imageOf(2048, "ok.png");
  const content = contentWithImages("with a picture", [toImageBlock(legal)]);
  check("a legal prompt is still [text, ...blocks]", Array.isArray(content) && content.length === 2);
  check("...with the text untouched — no note where nothing was dropped", textOf(content) === "with a picture", textOf(content));
  const sent = blocksIn(content)[0] as { source: { data: string; media_type: string } };
  check("...and the block's bytes passed through unchanged", sent.source.data === legal.dataBase64 && sent.source.media_type === "image/png");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
