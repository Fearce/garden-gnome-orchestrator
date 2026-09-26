// The emission-time deliverable check: the same verdict the /api/deliverable/:id route gives, plus
// the refusal text the posting agent reads.
// Run: npx tsx src/tests/deliverablePath.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DELIVERABLE_BYTES, deliverableRefusal, resolveDeliverable } from "../orchestrator/deliverablePath.js";

const root = mkdtempSync(join(tmpdir(), "deliverable-path-"));
const workspace = join(root, "ws");
const outside = join(root, "elsewhere");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(workspace, "docs", "report.md"), "# report");
writeFileSync(join(outside, "shot.png"), "png");

function refused(path: string) {
  const res = resolveDeliverable(workspace, path);
  assert.equal(res.ok, false, `${path} should be refused`);
  if (res.ok) throw new Error("unreachable");
  return { res, text: deliverableRefusal(workspace, path, res) };
}

try {
  // Absolute and workspace-relative paths inside the workspace both serve.
  for (const path of [join(workspace, "docs", "report.md"), "docs/report.md"]) {
    const res = resolveDeliverable(workspace, path);
    assert.ok(res.ok, `${path} should serve`);
    assert.equal(res.size, "# report".length);
  }

  // A file outside the workspace is the 403 the owner saw as a broken image. The file here sits in
  // the OS temp dir, like an agent's scratchpad, so the message names that case.
  {
    const { res, text } = refused(join(outside, "shot.png"));
    assert.equal(res.status, 403);
    assert.match(text, /NOT recorded/);
    assert.match(text, /outside this task's workspace/);
    assert.match(text, /temp\/scratch folder/);
    assert.match(text, /Copy the file into the workspace/);
  }

  // `..` cannot climb out.
  assert.equal(refused("../elsewhere/shot.png").res.status, 403);

  // The workspace itself is not a file to serve.
  assert.equal(refused(workspace).res.status, 403);

  // Missing file: a relative path gets the "resolves against the workspace" hint, an absolute one does not.
  {
    const rel = refused("docs/missing.md");
    assert.equal(rel.res.status, 404);
    assert.match(rel.text, /resolves against the task workspace/);
    const abs = refused(join(workspace, "missing.md"));
    assert.equal(abs.res.status, 404);
    assert.doesNotMatch(abs.text, /resolves against/);
  }

  // A directory inside the workspace.
  {
    const { res, text } = refused("docs");
    assert.equal(res.status, 404);
    assert.match(text, /directory, not a file/);
  }

  // Over the serving cap.
  {
    const big = join(workspace, "big.bin");
    writeFileSync(big, Buffer.alloc(MAX_DELIVERABLE_BYTES + 1));
    const { res, text } = refused(big);
    assert.equal(res.status, 413);
    assert.match(text, /25 MB serving cap/);
  }

  console.log("deliverablePath: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
