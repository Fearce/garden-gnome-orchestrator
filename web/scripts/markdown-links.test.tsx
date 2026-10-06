import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown.js";

for (const scheme of ["javascript:", "JaVaScRiPt:", "data:", "vbscript:", "file:", "//evil.example/"]) {
  const html = renderToStaticMarkup(<Markdown text={`[click](${scheme}alert)`} />);
  assert.ok(!html.includes("<a "), `${scheme} must not become a clickable link`);
  assert.ok(html.includes("click"), "the label remains readable");
}

for (const target of ["https://example.com/path", "http://example.com/", "mailto:alex@example.com", "/api/deliverable/123", "./README.md", "#details"]) {
  const html = renderToStaticMarkup(<Markdown text={`[open](${target})`} />);
  assert.ok(html.includes("<a "), `${target} should remain clickable`);
}

if (process.argv.includes("--browser")) {
  const require = createRequire(import.meta.url);
  type Page = {
    setContent(html: string): Promise<void>;
    locator(selector: string): { count(): Promise<number>; getAttribute(name: string): Promise<string | null> };
  };
  type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
  const { loadChromium } = require("../../server/scripts/lab-harness.cjs") as {
    loadChromium: () => { launch(): Promise<Browser> };
  };
  const browser = await loadChromium().launch();
  try {
    const page = await browser.newPage();
    await page.setContent(renderToStaticMarkup(<Markdown text="[unsafe](javascript:alert) [safe](https://example.com/)" />));
    assert.equal(await page.locator("a").count(), 1, "Chromium sees no clickable unsafe link");
    assert.equal(await page.locator("a").getAttribute("href"), "https://example.com/");
  } finally {
    await browser.close();
  }
}

console.log("Markdown link scheme checks passed.");
