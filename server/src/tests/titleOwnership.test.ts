import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";

const dir = mkdtempSync(join(tmpdir(), "gg-title-owner-"));
const path = join(dir, "orchestrator.sqlite");

try {
  let db = new Db(path);
  const thread = db.createThread({ title: "Initial title", workspace: dir, rawPrompt: "A task" });

  assert.equal(db.retitleThreadAutomatically(thread.id, "Automatic title")?.title, "Automatic title");
  assert.equal(db.renameThreadByOwner(thread.id, "Anydesk failure")?.title, "Anydesk failure");
  assert.equal(db.retitleThreadAutomatically(thread.id, "Late automatic title"), null);
  assert.equal(db.getThread(thread.id)?.title, "Anydesk failure");

  // An owner submission of the existing title still claims it; a later pencil edit can replace it.
  const second = db.createThread({ title: "Keep this title", workspace: dir, rawPrompt: "Another task" });
  assert.equal(db.renameThreadByOwner(second.id, "Keep this title")?.title, "Keep this title");
  assert.equal(db.retitleThreadAutomatically(second.id, "Late suggestion"), null);
  assert.equal(db.renameThreadByOwner(thread.id, "Owner changed it again")?.title, "Owner changed it again");
  db.raw.close();

  db = new Db(path);
  assert.equal(db.retitleThreadAutomatically(thread.id, "Suggestion after restart"), null);
  assert.equal(db.getThread(thread.id)?.title, "Owner changed it again");
  assert.equal(db.getThread(second.id)?.title, "Keep this title");
  db.raw.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("titleOwnership: owner edits block late and post-restart automatic retitles");
