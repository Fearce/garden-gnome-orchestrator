import assert from "node:assert/strict";
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

console.log("Markdown link scheme checks passed.");
