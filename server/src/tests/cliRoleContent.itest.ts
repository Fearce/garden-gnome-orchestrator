/** Exercise the real role launch boundary with fake processes: no model calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cli-role-content-"));
process.env.DATA_DIR = root;
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const db = new Db(":memory:");
const accounts = { onUsageRefresh() {}, effectiveUtilization: () => null, soonestResetAt: () => null, hasHeadroom: () => true, setPingInterval() {}, applyEnabled() {}, applyWeeklySafetyPct() {}, setSpreadUsage() {}, setProviderRuntime: async () => {} };
// Access process-spawning seams only; runRole builds the real launch and recovery prompts.
const manager = new ThreadManager(db, new EventHub(), new FileMemoryService(root), accounts as any) as any;
manager.wireRun = () => {};
manager.officeCheckIn = () => {};
manager.ensureGroup = () => {};
manager.roleSessionModelDrifted = () => false;
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } };
const brief = "Review the inbox implementation.";
const requirements = "Verify quiet delivery and report actual defects.";
const blocks = [{ type: "text", text: brief }, image, { type: "text", text: requirements }];
function verify(content: unknown, label: string) {
  assert.ok(Array.isArray(content), `${label}: preserves structured content`);
  assert.ok(content.some(block => JSON.stringify(block) === JSON.stringify(image)), `${label}: preserves attachment`);
  const text = content.filter(block => block?.type === "text").map(block => block.text).join("\n");
  assert.ok(text.includes(brief) && text.includes(requirements), `${label}: preserves actual QA brief`);
  assert.ok(text.includes("Direct gnome messages"), `${label}: includes inbox guidance`);
  assert.ok(!text.includes("[object Object]"), `${label}: never coerces blocks`);
}
try {
  for (const provider of ["codex", "grok"]) for (const resume of [undefined, "fixture-session"]) {
    let started: unknown;
    let recovery: unknown;
    manager.createRoleAgent = (_provider: string, create: () => any) => {
      const agent = create();
      recovery = agent.cfg.freshFallback;
      agent.start = (content: unknown) => { started = content; };
      agent.result = async () => ({ type: "result", subtype: "success", isError: false, structuredOutput: { summary: "verified" } });
      agent.stop = async () => {};
      return agent;
    };
    const thread = db.createThread({ title: "Structured QA fixture", workspace: root, rawPrompt: "Review", brief: "Review" });
    await manager.runRole(thread, "qa", blocks, () => ({ model: "unused", systemPrompt: "Review the repository." }), resume, { forcedProvider: provider });
    verify(started, `${provider} ${resume ? "resumed" : "fresh"} launch`);
    if (resume) verify(recovery, `${provider} fresh-session recovery`);
  }
  console.log("PASS Codex/Grok fresh, resumed and recovery QA content preserves text, images and inbox guidance");
} finally {
  clearInterval(manager.capSupervisor);
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
}
