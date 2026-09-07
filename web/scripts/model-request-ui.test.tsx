import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelRequest, Thread } from "../src/types.js";

// The repo's browser build uses Vite's automatic JSX runtime. The standalone tsx gate is launched
// from the server package and may compile imported web JSX in classic mode, so provide that runtime
// explicitly and import the component only afterward.
Object.assign(globalThis, {
  React,
  document: {
    baseURI: "http://localhost/",
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});
const { ModelRequestStatus, requestedModelMatches } = await import("../src/components/ModelRequestStatus.js");
const { TaskModelPicker, taskModelTargets } = await import("../src/components/TaskModelPicker.js");
const { useStore } = await import("../src/store.js");

const request: ModelRequest = {
  requested: "GPT Spark",
  provider: "codex",
  model: "gpt-5.3-codex-spark",
  strict: true,
};

assert.equal(requestedModelMatches(request, "GPT-5.3-Codex-Spark"), true, "normalized runtime ids must match the pin");
assert.equal(requestedModelMatches(request, "gpt-5.6-sol"), false, "Sol must be visibly different from Spark");
assert.equal(requestedModelMatches({ ...request, model: null }, "gpt-5.6-sol"), null, "an unresolved pin has no false match verdict");
const laterRequest = { ...request, selectedAt: 2_000 };
assert.equal(requestedModelMatches(laterRequest, "gpt-5.6-sol", 1_000), null, "a run completed before the owner retargeted is not a mismatch");
assert.equal(requestedModelMatches(laterRequest, "gpt-5.6-sol", 3_000), false, "a wrong run started after the pin remains a visible invariant failure");

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

const compactMismatch = render({ request, actualModel: "gpt-5.6-sol", compact: true });
assert.match(compactMismatch, /model-pin-badge mismatch/);
assert.match(compactMismatch, /Mismatch · GPT-5\.3 Codex Spark ≠ GPT-5\.6 Sol/);

const pendingRetarget = render({ request: laterRequest, actualModel: "gpt-5.6-sol", actualStartedAt: 1_000 });
assert.match(pendingRetarget, /waiting to start/, "a newly selected pin is explicit about waiting for its first run");
assert.doesNotMatch(pendingRetarget, /Mismatch/, "the model used before retargeting is not blamed on the new pin");
assert.match(pendingRetarget, /data-actual-model=""/, "a pre-pin runtime is not presented as the pin's actual model");

const initial = useStore.getInitialState();
Object.assign(initial, {
  settings: {
    ...initial.settings,
    codexEnabled: true,
    codexModels: ["gpt-5.6-sol", request.model!],
  },
});
const targets = taskModelTargets(initial.settings, request);
assert.deepEqual(targets.find((target) => target.provider === "codex")?.models, ["gpt-5.6-sol", request.model!], "the task picker exposes exact models without dropping the current pin");

const thread: Thread = {
  id: "task-model-picker",
  title: "Choose exact model",
  state: "paused",
  workspace: "test-workspace",
  modelRequest: request,
  createdAt: 1,
  updatedAt: 2,
};
const picker = renderToStaticMarkup(React.createElement(TaskModelPicker, { thread, active: false }));
assert.match(picker, /aria-label="Choose task provider and model"/, "the detail footer has an accessible model button");
assert.match(picker, /data-task-model="gpt-5\.3-codex-spark"/, "the tiny button carries the task's current exact pin");
assert.match(picker, /task-model-trigger pinned/, "a strict task pin is visible even while the picker is closed");

const unresolvedPicker = renderToStaticMarkup(React.createElement(TaskModelPicker, {
  thread: { ...thread, modelRequest: { requested: "GPT Future", provider: null, model: null, strict: true } },
  active: false,
}));
assert.match(unresolvedPicker, /Task model: Unresolved · GPT Future/, "an unresolved strict request is never mislabeled as Auto routing");
assert.match(unresolvedPicker, /task-model-trigger pinned/, "an unresolved strict constraint stays visible on the closed trigger");

console.log("Model-request UI gate passed — exact picker, requested, matching, retargeted, mismatch, waiting, unresolved, and mobile card states are explicit.");
