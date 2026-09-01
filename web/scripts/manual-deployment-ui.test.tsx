import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManualDeploymentSummary } from "../src/types.js";

Object.assign(globalThis, { React });
const { ManualDeploymentBadge, ManualDeploymentHandoff } = await import("../src/components/ManualDeploymentStatus.js");

const deployment: ManualDeploymentSummary = {
  status: "verified",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  environment: "production",
  instructions: "Run the approved release workflow for this commit.",
  verifiedAt: 10,
  invalidReason: null,
};

const badge = renderToStaticMarkup(React.createElement(ManualDeploymentBadge, { deployment }));
assert.match(badge, /Deploy pending/);
assert.match(badge, /Complete in GGO/);
assert.match(badge, /manual deployment to production remains pending/i);

const handoff = renderToStaticMarkup(React.createElement(ManualDeploymentHandoff, { deployment }));
assert.match(handoff, /Complete in GGO/);
assert.match(handoff, /Manual deployment to <strong>production<\/strong> remains pending/);
assert.match(handoff, /0123456789ab/);
assert.match(handoff, /Run the approved release workflow/);

const declared = renderToStaticMarkup(React.createElement(ManualDeploymentHandoff, { deployment: { ...deployment, status: "declared" } }));
const invalidated = renderToStaticMarkup(React.createElement(ManualDeploymentBadge, { deployment: { ...deployment, status: "invalidated" } }));
assert.equal(declared, "", "unverified evidence must not look complete");
assert.equal(invalidated, "", "invalidated evidence must not show a deploy-pending terminal badge");

console.log("Manual-deployment UI gate passed - verified handoffs are complete but visibly pending external deployment.");
