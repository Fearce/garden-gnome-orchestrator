import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDevice } from "../modules/worker/home/config.js";
import { HomeAssistantBridge } from "../modules/worker/home/homeAssistant.js";
import { normalizeScheduleInput, readSchedule, saveSchedule, setRuleEnabled, type ScheduleInput } from "../modules/worker/home/schedule.js";
import { HttpError } from "../modules/worker/router.js";

const VACUUM = "vacuum.sample_vacuum";
const BATTERY = "sensor.sample_vacuum_battery_level";
const DOCK = "button.sample_vacuum_start_charge";

interface FakeAutomation { entityId: string; on: boolean; lastTriggered: string | null; config: Record<string, unknown> }

/** The owner's two hand-written automations, in the shape Home Assistant's config API returns them. */
function ownerAutomations(): Map<string, FakeAutomation> {
  return new Map([
    ["sample_auto_start", { entityId: "automation.sample_auto_start", on: true, lastTriggered: "2026-01-05T08:00:00+00:00", config: {
      id: "sample_auto_start", alias: "Vacuum auto-start", description: "Written by hand.",
      triggers: [{ trigger: "numeric_state", entity_id: BATTERY, above: 98.9 }, { trigger: "time", at: "09:00:00" }, { trigger: "time_pattern", minutes: "/30" }],
      conditions: [{ condition: "numeric_state", entity_id: BATTERY, above: 98.9 }, { condition: "time", after: "09:00:00", before: "22:00:00" }, { condition: "state", entity_id: VACUUM, state: "docked" }],
      actions: [{ action: "vacuum.start", target: { entity_id: VACUUM } }], mode: "single",
    } }],
    ["sample_quiet_guard", { entityId: "automation.sample_quiet_guard", on: true, lastTriggered: null, config: {
      id: "sample_quiet_guard", alias: "Vacuum quiet hours",
      triggers: [{ trigger: "state", entity_id: VACUUM, to: "cleaning" }, { trigger: "time", at: "22:00:00" }, { trigger: "homeassistant", event: "start" }, { trigger: "time_pattern", minutes: "/5" }],
      conditions: [{ condition: "state", entity_id: VACUUM, state: "cleaning" }, { condition: "time", after: "22:00:00", before: "09:00:00" }],
      actions: [{ action: "vacuum.stop", target: { entity_id: VACUUM } }, { delay: { seconds: 5 } }, { action: "button.press", target: { entity_id: DOCK } }], mode: "single",
    } }],
    ["sample_other_vacuum", { entityId: "automation.sample_other_vacuum", on: true, lastTriggered: null, config: {
      id: "sample_other_vacuum", alias: "Second vacuum", triggers: [], conditions: [], actions: [{ action: "vacuum.start", target: { entity_id: `${VACUUM}_2` } }],
    } }],
    ["sample_unrelated", { entityId: "automation.sample_unrelated", on: true, lastTriggered: null, config: {
      id: "sample_unrelated", alias: "Porch light", triggers: [], conditions: [], actions: [{ action: "light.turn_on", target: { entity_id: "light.porch" } }],
    } }],
  ]);
}

let automations = ownerAutomations();
/** Real Home Assistant answers a config write before it reloads; a new automation's state appears later. */
let reloadDelayMs = 0;
const loadedAt = new Map<string, number>();
const writes: string[] = [];
const switches: string[] = [];

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = req.url ?? "";
  const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url === "/auth/token") return json({ access_token: "sample-access-token", expires_in: 1800 });
  if (url === "/api/states") {
    return json([
      { entity_id: VACUUM, state: "docked", attributes: {} },
      ...[...automations.entries()].filter(([id]) => (loadedAt.get(id) ?? 0) <= Date.now()).map(([id, a]) => ({ entity_id: a.entityId, state: a.on ? "on" : "off", attributes: { id, friendly_name: a.config.alias, last_triggered: a.lastTriggered } })),
      { entity_id: "automation.yaml_only", state: "on", attributes: { friendly_name: "Has no config id" } },
    ]);
  }
  const config = /^\/api\/config\/automation\/config\/([^/]+)$/.exec(url);
  if (config) {
    const id = decodeURIComponent(config[1]!);
    if (req.method === "GET") return automations.has(id) ? json(automations.get(id)!.config) : json({ message: "Resource not found" }, 404);
    writes.push(id);
    const existing = automations.get(id);
    if (!existing) loadedAt.set(id, Date.now() + reloadDelayMs);
    automations.set(id, { entityId: existing?.entityId ?? `automation.${id}`, on: existing?.on ?? true, lastTriggered: existing?.lastTriggered ?? null, config: JSON.parse(body) });
    return json({ result: "ok" });
  }
  const service = /^\/api\/services\/automation\/(turn_on|turn_off)$/.exec(url);
  if (service) {
    const entityId = (JSON.parse(body) as { entity_id: string }).entity_id;
    switches.push(`${entityId}:${service[1]}`);
    for (const automation of automations.values()) if (automation.entityId === entityId) automation.on = service[1] === "turn_on";
    return json([]);
  }
  json({ message: "unexpected" }, 500);
});

const root = await mkdtemp(join(tmpdir(), "ggo-ha-schedule-"));
let failures = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  automations = ownerAutomations();
  reloadDelayMs = 0;
  loadedAt.clear();
  writes.length = 0;
  switches.length = 0;
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}\n`, error);
  }
}

const input = (patch: Omit<Partial<ScheduleInput>, "autoStart"> & { autoStart?: Partial<ScheduleInput["autoStart"]> } = {}): ScheduleInput => ({
  start: "09:00",
  end: "22:00",
  ...patch,
  autoStart: { enabled: true, batteryPercent: 99, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], ...patch.autoStart },
  quietGuard: patch.quietGuard ?? { enabled: true },
});

try {
  await mkdir(join(root, ".storage"));
  await writeFile(join(root, ".storage", "auth"), JSON.stringify({ data: {
    users: [{ id: "sample-owner", is_owner: true }],
    refresh_tokens: [{ token: "sample-refresh-token", user_id: "sample-owner", token_type: "normal" }],
  } }));
  await writeFile(join(root, ".storage", "core.entity_registry"), JSON.stringify({ data: { entities: [
    { entity_id: VACUUM, device_id: "sample-device" },
    { entity_id: BATTERY, device_id: "sample-device" },
    { entity_id: DOCK, device_id: "sample-device" },
  ] } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bridge = new HomeAssistantBridge(url, root);
  const device = normalizeDevice({ id: "sample", name: "Hall vacuum", platform: "home-assistant", homeAssistantEntityId: VACUUM });

  await test("schedule: the owner's existing auto-start and quiet-hours guard are read as one editable window", async () => {
    const view = await readSchedule(bridge, device);
    assert.equal(view.autoStart?.automationId, "sample_auto_start");
    assert.deepEqual([view.autoStart?.start, view.autoStart?.end, view.autoStart?.batteryPercent, view.autoStart?.days.length], ["09:00", "22:00", 99, 7]);
    assert.equal(view.autoStart?.lastTriggered, "2026-01-05T08:00:00+00:00");
    assert.deepEqual([view.quietGuard?.automationId, view.quietGuard?.start, view.quietGuard?.end, view.quietGuard?.dockEntityId], ["sample_quiet_guard", "09:00", "22:00", DOCK]);
    assert.deepEqual(view.others, [], "an automation that never mentions the vacuum is not listed");
    assert.deepEqual(view.defaults, { start: "09:00", end: "22:00", batteryPercent: 99, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
  });

  await test("schedule: a changed window rewrites both automations in place, keeping their ids, sensor and dock button", async () => {
    const view = await saveSchedule(bridge, device, input({ start: "08:30", end: "21:00", autoStart: { batteryPercent: 95, days: ["mon", "tue", "wed", "thu", "fri"] } }));
    assert.deepEqual(writes.sort(), ["sample_auto_start", "sample_quiet_guard"]);
    const start = automations.get("sample_auto_start")!.config as { triggers: Record<string, unknown>[]; conditions: Record<string, unknown>[]; alias: string };
    assert.deepEqual(start.conditions[1], { condition: "time", after: "08:30:00", before: "21:00:00", weekday: ["mon", "tue", "wed", "thu", "fri"] });
    assert.deepEqual(start.triggers[0], { trigger: "numeric_state", entity_id: BATTERY, above: 94.9 });
    assert.deepEqual(start.triggers[1], { trigger: "time", at: "08:30:00" });
    assert.match(start.alias, /08:30-21:00, weekdays/);
    const guard = automations.get("sample_quiet_guard")!.config as { conditions: Record<string, unknown>[]; actions: Record<string, unknown>[] };
    assert.deepEqual(guard.conditions[1], { condition: "time", after: "21:00:00", before: "08:30:00" });
    assert.deepEqual(guard.actions[2], { action: "button.press", target: { entity_id: DOCK } });
    assert.deepEqual([view.autoStart?.start, view.autoStart?.batteryPercent, view.autoStart?.days.length, view.quietGuard?.end], ["08:30", 95, 5, "21:00"]);
    assert.deepEqual(switches, [], "both stay on, so nothing is switched");
  });

  await test("schedule: switching a rule off with the same times writes no config, only turns it off", async () => {
    const view = await saveSchedule(bridge, device, input({ autoStart: { enabled: false } }));
    assert.deepEqual(writes, []);
    assert.deepEqual(switches, ["automation.sample_auto_start:turn_off"]);
    assert.equal(view.autoStart?.enabled, false);
    assert.equal(view.quietGuard?.enabled, true);
    assert.equal(automations.get("sample_auto_start")!.config.description, "Written by hand.", "an untouched automation keeps its own wording");
  });

  await test("schedule: with no automations, saving creates GGO's own pair, and a rule left off is not created at all", async () => {
    automations = new Map();
    const view = await saveSchedule(bridge, device, input({ quietGuard: { enabled: false } }));
    assert.deepEqual(writes, ["ggo_sample_vacuum_auto_start"]);
    assert.equal(view.autoStart?.automationId, "ggo_sample_vacuum_auto_start");
    assert.equal(view.quietGuard, null);
    const again = await saveSchedule(bridge, device, input());
    assert.equal(again.quietGuard?.automationId, "ggo_sample_vacuum_quiet_hours_guard");
    assert.deepEqual([again.quietGuard?.start, again.quietGuard?.end, again.quietGuard?.dockEntityId], ["09:00", "22:00", DOCK]);
  });

  await test("schedule: an automation reshaped in Home Assistant is listed, never managed, and a save leaves it untouched", async () => {
    const start = automations.get("sample_auto_start")!;
    start.config = { ...start.config, conditions: [...(start.config.conditions as unknown[]), { condition: "state", entity_id: "person.alex", state: "not_home" }] };
    const view = await readSchedule(bridge, device);
    assert.equal(view.autoStart, null);
    assert.deepEqual(view.others.map((rule) => [rule.automationId, rule.acts]), [["sample_auto_start", "starts"]]);
    assert.equal(view.defaults.start, "09:00", "the guard still supplies the window");
    await saveSchedule(bridge, device, input({ start: "10:00" }));
    assert.deepEqual(writes.sort(), ["ggo_sample_vacuum_auto_start", "sample_quiet_guard"]);
    assert.equal((start.config.conditions as unknown[]).length, 4, "the owner's presence condition survives");
    const off = await setRuleEnabled(bridge, device, "automation.sample_auto_start", false);
    assert.equal(off.others.find((rule) => rule.automationId === "sample_auto_start")?.enabled, false);
    assert.equal(off.autoStart?.automationId, "ggo_sample_vacuum_auto_start", "GGO's own rule takes the managed slot");
  });

  await test("schedule: extra top-level settings keep an automation outside GGO's editor", async () => {
    automations.get("sample_auto_start")!.config.initial_state = false;
    const view = await readSchedule(bridge, device);
    assert.equal(view.autoStart, null);
    assert.equal(view.others[0]?.automationId, "sample_auto_start");
    await saveSchedule(bridge, device, input());
    assert.equal(automations.get("sample_auto_start")!.config.initial_state, false);
    assert.deepEqual(writes, ["ggo_sample_vacuum_auto_start"]);
  });

  await test("schedule: creating a rule refuses an occupied id even when its config does not name the vacuum", async () => {
    automations.delete("sample_auto_start");
    const custom = automations.get("sample_unrelated")!;
    automations.set("ggo_sample_vacuum_auto_start", custom);
    await assert.rejects(saveSchedule(bridge, device, input()), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal(automations.get("ggo_sample_vacuum_auto_start"), custom);
    assert.deepEqual(writes, []);
    assert.deepEqual(switches, []);
  });

  await test("schedule: a numeric condition on another sensor is not mistaken for the battery", async () => {
    const start = automations.get("sample_auto_start")!;
    const swap = (steps: unknown) => (steps as Record<string, unknown>[]).map((step) => (step.entity_id === BATTERY ? { ...step, entity_id: "sensor.hall_humidity" } : step));
    start.config = { ...start.config, triggers: swap(start.config.triggers), conditions: swap(start.config.conditions) };
    const view = await readSchedule(bridge, device);
    assert.equal(view.autoStart, null);
    assert.equal(view.others[0]?.automationId, "sample_auto_start");
  });

  await test("schedule: another vacuum's automations are not this vacuum's, even when its id starts the same", async () => {
    const view = await readSchedule(bridge, device);
    assert.ok(!view.others.some((rule) => rule.automationId === "sample_other_vacuum"));
    await assert.rejects(setRuleEnabled(bridge, device, "automation.sample_other_vacuum", false), (error: unknown) => error instanceof HttpError && error.status === 404);
  });

  await test("schedule: a save waits for Home Assistant to load new automations before switching rules", async () => {
    automations.delete("sample_auto_start");
    reloadDelayMs = 900;
    const view = await saveSchedule(bridge, device, input({ quietGuard: { enabled: false } }));
    assert.equal(view.autoStart?.automationId, "ggo_sample_vacuum_auto_start");
    assert.equal(view.quietGuard?.enabled, false);
    assert.deepEqual(switches, ["automation.sample_quiet_guard:turn_off"]);
  });

  await test("schedule: switching refuses an automation that does not act on this vacuum", async () => {
    await assert.rejects(setRuleEnabled(bridge, device, "automation.sample_unrelated", false), (error: unknown) => error instanceof HttpError && error.status === 404);
    assert.deepEqual(switches, []);
  });

  await test("schedule: input is validated before anything reaches Home Assistant", () => {
    const bad = (raw: unknown, pattern: RegExp) => assert.throws(() => normalizeScheduleInput(raw), (error: unknown) => error instanceof HttpError && error.status === 400 && pattern.test(error.message));
    bad({ start: "9", end: "22:00", autoStart: { batteryPercent: 99 } }, /start and an end/);
    bad({ start: "09:00", end: "09:00", autoStart: { batteryPercent: 99 } }, /different time/);
    bad({ start: "09:00", end: "22:00", autoStart: { batteryPercent: 5 } }, /between 20 and 100/);
    bad({ start: "09:00", end: "22:00", autoStart: { batteryPercent: 99, days: [] } }, /at least one day/);
    bad({ start: "22:00", end: "02:00", autoStart: { batteryPercent: 99, days: ["mon"] } }, /past midnight/);
    const ok = normalizeScheduleInput({ start: "9:05:00", end: "21:00", autoStart: { enabled: true, batteryPercent: "80", days: ["sun", "mon", "nope"] }, quietGuard: { enabled: "yes" } });
    assert.deepEqual(ok, { start: "09:05", end: "21:00", autoStart: { enabled: true, batteryPercent: 80, days: ["mon", "sun"] }, quietGuard: { enabled: false } });
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
if (failures) {
  console.error(`${failures} schedule test(s) failed`);
  process.exit(1);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    req.on("end", () => resolve(text));
  });
}
