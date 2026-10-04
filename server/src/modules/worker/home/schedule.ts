import { setTimeout as sleep } from "node:timers/promises";
import { HttpError } from "../router.js";
import type { VacuumDevice } from "./config.js";
import type { HaAutomation, HomeAssistantBridge, ScheduleTargets } from "./homeAssistant.js";

/**
 * A vacuum's cleaning schedule, as two Home Assistant automations: an auto-start that runs it once the battery is
 * full inside a daily window, and a quiet-hours guard that docks it whenever it cleans outside that window. Home
 * Assistant stays the only place the schedule runs and is stored. GGO manages an automation only when it is
 * exactly the shape GGO writes; anything else that acts on the vacuum is listed with an on/off switch and never
 * rewritten, so a save cannot drop a condition or step the owner added in Home Assistant.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const AUTO_START_RECHECK = "/30";
const QUIET_GUARD_RECHECK = "/5";
const DEFAULT_WINDOW = { start: "09:00", end: "22:00" };
const DEFAULT_BATTERY = 99;
/** Home Assistant answers a config write before its reload finishes, so a new automation appears a moment later. */
const RELOAD_WAIT_MS = 10_000;
const RELOAD_POLL_MS = 400;

export interface ScheduleInput {
  start: string;
  end: string;
  autoStart: { enabled: boolean; batteryPercent: number; days: Weekday[] };
  quietGuard: { enabled: boolean };
}

export interface RuleView {
  automationId: string;
  entityId: string;
  name: string;
  enabled: boolean;
  lastTriggered: string | null;
}

export interface AutoStartView extends RuleView {
  start: string;
  end: string;
  batteryPercent: number;
  /** The battery sensor it watches, kept on every rewrite. */
  batteryEntityId: string;
  days: Weekday[];
}

export interface QuietGuardView extends RuleView {
  /** The cleaning window, i.e. the guard's quiet hours turned around: it docks the vacuum from `end` until `start`. */
  start: string;
  end: string;
  /** The button it presses to dock, kept on every rewrite; null when it docks through return_to_base. */
  dockEntityId: string | null;
}

export interface OtherRuleView extends RuleView {
  /** What it does to the vacuum, so the edit dialog can warn before a second rule of the same kind is created. */
  acts: "starts" | "docks" | "other";
}

export interface ScheduleView {
  supported: true;
  vacuumEntityId: string;
  autoStart: AutoStartView | null;
  quietGuard: QuietGuardView | null;
  /** Automations that mention this vacuum but are not GGO's shape; GGO only switches them on or off. */
  others: OtherRuleView[];
  /** The values the edit form starts from. */
  defaults: { start: string; end: string; batteryPercent: number; days: Weekday[] };
  /** Why an auto-start cannot be created (no battery sensor); null when it can, or one exists. */
  autoStartBlocked: string | null;
}

export async function readSchedule(bridge: HomeAssistantBridge, device: VacuumDevice): Promise<ScheduleView> {
  const targets = await bridge.scheduleTargets(device);
  return scheduleView(targets, await bridge.automationsFor(targets.vacuum));
}

/** Writes only the automations whose schedule changed, then switches each on or off as asked. */
export async function saveSchedule(bridge: HomeAssistantBridge, device: VacuumDevice, input: ScheduleInput): Promise<ScheduleView> {
  const targets = await bridge.scheduleTargets(device);
  const current = scheduleView(targets, await bridge.automationsFor(targets.vacuum));
  const autoStart = current.autoStart;
  const guard = current.quietGuard;

  const pending: { id: string; enabled: boolean }[] = [];
  if (autoStart || input.autoStart.enabled) {
    const id = autoStart?.automationId ?? ggoAutomationId(targets.vacuum, "auto_start");
    const battery = autoStart?.batteryEntityId ?? targets.battery;
    if (!battery) throw new HttpError(409, current.autoStartBlocked ?? "Home Assistant has no battery sensor for this vacuum");
    if (!autoStart || autoStartChanged(autoStart, input)) await bridge.saveAutomation(id, buildAutoStart(id, device.name, { ...targets, battery }, input), !autoStart);
    pending.push({ id, enabled: input.autoStart.enabled });
  }
  if (guard || input.quietGuard.enabled) {
    const id = guard?.automationId ?? ggoAutomationId(targets.vacuum, "quiet_hours_guard");
    const dock = guard ? guard.dockEntityId : targets.dock;
    if (!guard || guard.start !== input.start || guard.end !== input.end) await bridge.saveAutomation(id, buildQuietGuard(id, device.name, { ...targets, dock }, input), !guard);
    pending.push({ id, enabled: input.quietGuard.enabled });
  }
  await applyEnabled(bridge, targets.vacuum, pending);
  return readSchedule(bridge, device);
}

/** Switches one automation acting on this vacuum on or off; any other automation is refused. */
export async function setRuleEnabled(bridge: HomeAssistantBridge, device: VacuumDevice, entityId: string, enabled: boolean): Promise<ScheduleView> {
  const targets = await bridge.scheduleTargets(device);
  const automations = await bridge.automationsFor(targets.vacuum);
  if (!automations.some((automation) => automation.entityId === entityId)) throw new HttpError(404, `${entityId} is not an automation of ${device.name}`);
  await bridge.setAutomationEnabled(entityId, enabled);
  return readSchedule(bridge, device);
}

export function normalizeScheduleInput(raw: unknown): ScheduleInput {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const autoStart = (input.autoStart && typeof input.autoStart === "object" ? input.autoStart : {}) as Record<string, unknown>;
  const quietGuard = (input.quietGuard && typeof input.quietGuard === "object" ? input.quietGuard : {}) as Record<string, unknown>;
  const start = clock(input.start);
  const end = clock(input.end);
  if (!start || !end) throw new HttpError(400, "The cleaning window needs a start and an end time (HH:MM)");
  if (start === end) throw new HttpError(400, "The cleaning window must end at a different time than it starts");
  const battery = Math.round(Number(autoStart.batteryPercent));
  if (!Number.isFinite(battery) || battery < 20 || battery > 100) throw new HttpError(400, "The start battery level must be between 20 and 100 %");
  const days = Array.isArray(autoStart.days) ? WEEKDAYS.filter((day) => (autoStart.days as unknown[]).includes(day)) : [...WEEKDAYS];
  if (!days.length) throw new HttpError(400, "Choose at least one day for the auto-start");
  // Home Assistant checks a weekday against the calendar day, so after midnight it would test the next day's choice.
  if (days.length < WEEKDAYS.length && end < start) throw new HttpError(400, "A window that runs past midnight needs every day chosen");
  return { start, end, autoStart: { enabled: autoStart.enabled === true, batteryPercent: battery, days }, quietGuard: { enabled: quietGuard.enabled === true } };
}

export function scheduleView(targets: ScheduleTargets, automations: HaAutomation[]): ScheduleView {
  const starts = automations.filter((automation) => startsVacuum(automation.config, targets.vacuum));
  const docks = automations.filter((automation) => !starts.includes(automation) && docksVacuum(automation.config, targets.vacuum));
  const autoStart = managed(starts.map((automation) => parseAutoStart(automation, targets)), targets.vacuum, "auto_start");
  const quietGuard = managed(docks.map((automation) => parseQuietGuard(automation, targets)), targets.vacuum, "quiet_hours_guard");
  const others = automations
    .filter((automation) => automation.id !== autoStart?.automationId && automation.id !== quietGuard?.automationId)
    .map((automation): OtherRuleView => ({ ...ruleView(automation), acts: starts.includes(automation) ? "starts" : docks.includes(automation) ? "docks" : "other" }));
  const window = autoStart ?? quietGuard;
  return {
    supported: true,
    vacuumEntityId: targets.vacuum,
    autoStart,
    quietGuard,
    others,
    defaults: {
      start: window?.start ?? DEFAULT_WINDOW.start,
      end: window?.end ?? DEFAULT_WINDOW.end,
      batteryPercent: autoStart?.batteryPercent ?? DEFAULT_BATTERY,
      days: autoStart?.days ?? [...WEEKDAYS],
    },
    autoStartBlocked: autoStart || targets.battery ? null : "Home Assistant has no battery sensor for this vacuum, so GGO cannot build an auto-start for it",
  };
}

export function buildAutoStart(id: string, deviceName: string, targets: ScheduleTargets & { battery: string }, input: ScheduleInput): Record<string, unknown> {
  const { start, end } = input;
  const percent = input.autoStart.batteryPercent;
  const everyDay = input.autoStart.days.length === WEEKDAYS.length;
  const above = Math.round((percent - 0.1) * 10) / 10;
  return {
    id,
    alias: `${deviceName}: auto-start on full battery (${start}-${end}${everyDay ? "" : `, ${daysLabel(input.autoStart.days)}`})`,
    description:
      `Starts ${deviceName} once its battery reaches ${percent}% while it is docked, only between ${start} and ${end}` +
      `${everyDay ? "" : ` on ${daysLabel(input.autoStart.days)}`}. A re-check every 30 minutes means a Home Assistant restart or a missed battery update never leaves a full battery idle. Managed from GGO's Home tab.`,
    triggers: [
      { trigger: "numeric_state", entity_id: targets.battery, above },
      { trigger: "time", at: `${start}:00` },
      { trigger: "time_pattern", minutes: AUTO_START_RECHECK },
    ],
    conditions: [
      { condition: "numeric_state", entity_id: targets.battery, above },
      { condition: "time", after: `${start}:00`, before: `${end}:00`, ...(everyDay ? {} : { weekday: input.autoStart.days }) },
      { condition: "state", entity_id: targets.vacuum, state: "docked" },
    ],
    actions: [{ action: "vacuum.start", target: { entity_id: targets.vacuum } }],
    mode: "single",
  };
}

export function buildQuietGuard(id: string, deviceName: string, targets: ScheduleTargets, input: ScheduleInput): Record<string, unknown> {
  const { start, end } = input;
  // The G1 docks reliably only through its own "start charge" button; return_to_base is the fallback.
  const dockActions = targets.dock
    ? [{ action: "vacuum.stop", target: { entity_id: targets.vacuum } }, { delay: { seconds: 5 } }, { action: "button.press", target: { entity_id: targets.dock } }]
    : [{ action: "vacuum.return_to_base", target: { entity_id: targets.vacuum } }];
  return {
    id,
    alias: `${deviceName}: quiet hours guard (no cleaning ${end}-${start})`,
    description: `Sends ${deviceName} back to its dock whenever it is cleaning between ${end} and ${start}, whatever started it: a run still going at ${end}, its own resume after recharging, an app schedule or a manual start. Managed from GGO's Home tab.`,
    triggers: [
      { trigger: "state", entity_id: targets.vacuum, to: "cleaning" },
      { trigger: "time", at: `${end}:00` },
      { trigger: "homeassistant", event: "start" },
      { trigger: "time_pattern", minutes: QUIET_GUARD_RECHECK },
    ],
    conditions: [
      { condition: "state", entity_id: targets.vacuum, state: "cleaning" },
      { condition: "time", after: `${end}:00`, before: `${start}:00` },
    ],
    actions: dockActions,
    mode: "single",
  };
}

/** GGO's own automation first, then the first one of GGO's shape; one of any other shape is never managed. */
function managed<T extends RuleView>(candidates: (T | null)[], vacuum: string, role: string): T | null {
  const fitting = candidates.filter((candidate): candidate is T => candidate !== null);
  return fitting.find((candidate) => candidate.automationId === ggoAutomationId(vacuum, role)) ?? fitting[0] ?? null;
}

/** The auto-start's fields, or null unless rebuilding it from them reproduces the automation exactly. */
function parseAutoStart(automation: HaAutomation, targets: ScheduleTargets): AutoStartView | null {
  const conditions = list(automation.config, "conditions", "condition");
  const time = conditions.find((c) => c.condition === "time");
  const battery = conditions.find((c) => c.condition === "numeric_state");
  const start = clock(time?.after);
  const end = clock(time?.before);
  const batteryEntityId = typeof battery?.entity_id === "string" ? battery.entity_id.toLowerCase() : null;
  if (!start || !end || !batteryEntityId || typeof battery?.above !== "number" || !isBatterySensor(batteryEntityId, targets)) return null;
  const weekday = time?.weekday;
  const days = weekday === undefined ? [...WEEKDAYS] : WEEKDAYS.filter((day) => (Array.isArray(weekday) ? weekday : [weekday]).includes(day));
  if (!days.length) return null;
  const view: AutoStartView = { ...ruleView(automation), start, end, batteryPercent: Math.floor(battery.above) + 1, batteryEntityId, days };
  const input = { start, end, autoStart: { enabled: true, batteryPercent: view.batteryPercent, days }, quietGuard: { enabled: true } };
  return sameRule(automation.config, buildAutoStart(automation.id, "", { ...targets, battery: batteryEntityId }, input)) ? view : null;
}

function parseQuietGuard(automation: HaAutomation, targets: ScheduleTargets): QuietGuardView | null {
  const time = list(automation.config, "conditions", "condition").find((c) => c.condition === "time");
  const start = clock(time?.before);
  const end = clock(time?.after);
  if (!start || !end) return null;
  const press = actions(automation.config).find((step) => serviceOf(step) === "button.press");
  const dockEntityId = press ? targetsOf(press)[0] ?? null : null;
  const input = { start, end, autoStart: { enabled: true, batteryPercent: DEFAULT_BATTERY, days: [...WEEKDAYS] }, quietGuard: { enabled: true } };
  if (!sameRule(automation.config, buildQuietGuard(automation.id, "", { ...targets, dock: dockEntityId }, input))) return null;
  return { ...ruleView(automation), start, end, dockEntityId };
}

function isBatterySensor(entityId: string, targets: ScheduleTargets): boolean {
  return targets.battery ? entityId === targets.battery : /battery/.test(entityId);
}

/** Same triggers, conditions, actions and mode; the alias and description are GGO's to rewrite. */
function sameRule(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  if (Object.keys(actual).some((key) => !["id", "alias", "description", "triggers", "conditions", "actions", "mode"].includes(key))) return false;
  return ["triggers", "conditions", "actions", "mode"].every((key) => canonical(actual[key]) === canonical(expected[key]));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(typeof value === "string" ? value.toLowerCase() : value) ?? "undefined";
}

function ruleView(automation: HaAutomation): RuleView {
  return { automationId: automation.id, entityId: automation.entityId, name: automation.name, enabled: automation.enabled, lastTriggered: automation.lastTriggered };
}

function startsVacuum(config: Record<string, unknown>, vacuum: string): boolean {
  return actions(config).some((step) => serviceOf(step) === "vacuum.start" && targetsOf(step).includes(vacuum));
}

function docksVacuum(config: Record<string, unknown>, vacuum: string): boolean {
  return actions(config).some((step) => ["vacuum.stop", "vacuum.return_to_base"].includes(serviceOf(step)) && targetsOf(step).includes(vacuum));
}

function autoStartChanged(current: AutoStartView, input: ScheduleInput): boolean {
  return current.start !== input.start || current.end !== input.end || current.batteryPercent !== input.autoStart.batteryPercent || current.days.join() !== input.autoStart.days.join();
}

/** Switches rules once Home Assistant has loaded every one just written; it reloads after answering the write. */
async function applyEnabled(bridge: HomeAssistantBridge, vacuum: string, pending: { id: string; enabled: boolean }[]): Promise<void> {
  if (!pending.length) return;
  const deadline = Date.now() + RELOAD_WAIT_MS;
  let loaded = new Map<string, HaAutomation>();
  for (;;) {
    loaded = new Map((await bridge.automationsFor(vacuum)).map((automation) => [automation.id, automation]));
    const missing = pending.filter((rule) => !loaded.has(rule.id));
    if (!missing.length) break;
    if (Date.now() >= deadline) throw new HttpError(504, `Home Assistant saved ${missing.map((rule) => rule.id).join(" and ")} but had not loaded it after ${RELOAD_WAIT_MS / 1000}s; reopen the tab to see it`);
    await sleep(RELOAD_POLL_MS);
  }
  for (const rule of pending) {
    const automation = loaded.get(rule.id)!;
    if (automation.enabled !== rule.enabled) await bridge.setAutomationEnabled(automation.entityId, rule.enabled);
  }
}

function ggoAutomationId(vacuum: string, role: string): string {
  return `ggo_${vacuum.replace(/^vacuum\./, "").replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${role}`;
}

function daysLabel(days: Weekday[]): string {
  if (days.length === 5 && !days.includes("sat") && !days.includes("sun")) return "weekdays";
  if (days.length === 2 && days.includes("sat") && days.includes("sun")) return "weekends";
  return days.map((day) => day[0]!.toUpperCase() + day.slice(1)).join(", ");
}

type Step = Record<string, unknown>;

function list(config: Record<string, unknown>, key: string, legacyKey: string): Step[] {
  const value = config[key] ?? config[legacyKey];
  return (Array.isArray(value) ? value : value ? [value] : []).filter((step): step is Step => Boolean(step) && typeof step === "object");
}

function actions(config: Record<string, unknown>): Step[] {
  return list(config, "actions", "action");
}

function serviceOf(step: Step): string {
  const name = step.action ?? step.service;
  return typeof name === "string" ? name.toLowerCase() : "";
}

function targetsOf(step: Step): string[] {
  const target = (step.target && typeof step.target === "object" ? step.target : {}) as Step;
  const data = (step.data && typeof step.data === "object" ? step.data : {}) as Step;
  return [target.entity_id, step.entity_id, data.entity_id].flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
}

/** "09:00", "09:00:00" or "9:00" as "09:00"; anything else is null. */
function clock(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim()) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? `${String(hours).padStart(2, "0")}:${match[2]}` : null;
}
