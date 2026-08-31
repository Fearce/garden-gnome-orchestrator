import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelRequest } from "../src/types.js";

// The repo's browser build uses Vite's automatic JSX runtime. The standalone tsx gate is launched
// from the server package and may compile imported web JSX in classic mode, so provide that runtime
// explicitly and import the component only afterward.
Object.assign(globalThis, { React });
const { ModelRequestStatus, requestedModelMatches } = await import("../src/components/ModelRequestStatus.js");

const request: ModelRequest = {
  requested: "GPT Spark",
  provider: "codex",
  model: "gpt-5.3-codex-spark",
  strict: true,
};

assert.equal(requestedModelMatches(request, "GPT-5.3-Codex-Spark"), true, "normalized runtime ids must match the pin");
assert.equal(requestedModelMatches(request, "gpt-5.6-sol"), false, "Sol must be visibly different from Spark");
assert.equal(requestedModelMatches({ ...request, model: null }, "gpt-5.6-sol"), null, "an unresolved pin has no false match verdict");

const render = (props: Parameters<typeof ModelRequestStatus>[0]): string =>
  renderToStaticMarkup(React.createElement(ModelRequestStatus, props));

const matching = render({ request, actualModel: "gpt-5.3-codex-spark" });
assert.match(matching, /Requested model/);
assert.match(matching, /actual GPT-5\.3 Codex Spark/);
assert.match(matching, /data-requested-model="gpt-5\.3-codex-spark"/);
assert.match(matching, /data-actual-model="gpt-5\.3-codex-spark"/);
assert.doesNotMatch(matching, /Mismatch/);

const mismatch = render({ request, actualModel: "gpt-5.6-sol" });
assert.match(mismatch, /model-request-status mismatch/);
assert.match(mismatch, /actual GPT-5\.6 Sol/);
assert.match(mismatch, /Mismatch — stopped/);

const waiting = render({ request });
assert.match(waiting, /waiting to start/);

const unresolved = render({ request: { ...request, requested: "GPT Future", model: null } });
assert.match(unresolved, /model-request-status unresolved/);
assert.match(unresolved, /unresolved — blocked/);

const compact = render({ request, actualModel: "gpt-5.3-codex-spark", compact: true });
assert.match(compact, /model-pin-badge pinned/);
assert.match(compact, /Pin · GPT-5\.3 Codex Spark/);

console.log("Model-request UI gate passed — requested, matching, mismatch, waiting, unresolved, and mobile card states are explicit.");
