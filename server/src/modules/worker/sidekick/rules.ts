import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { writeAtomic } from "../configStore.js";
import { HttpError } from "../router.js";

/**
 * Edits to the Sidekick tray app's own settings file. The app watches that file and reloads a replaced copy,
 * so a save here changes the live launch engine. Every write names the revision it was based on; a file that
 * changed underneath the editor (the tray app, a hand edit) is refused rather than overwritten.
 */

const MAX_RULES = 100;
const MAX_COMPANIONS = 50;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Doc = Record<string, unknown>;

export function revisionForText(text: string | null): string | null {
  return text === null ? null : createHash("sha256").update(text, "utf8").digest("hex");
}

export function pick(raw: unknown, pascal: string, camel: string): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Doc;
  return record[pascal] ?? record[camel];
}

export interface SettingsDocument {
  text: string | null;
  revision: string | null;
  document: Doc;
  rules: Doc[];
}

export async function readSettingsDocument(settingsPath: string): Promise<SettingsDocument> {
  let text: string | null = null;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text === null) return { text, revision: null, document: { Version: 1, Rules: [] }, rules: [] };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new HttpError(409, `Sidekick's settings file is not valid JSON: ${(error as Error).message}`, { code: "invalid_settings" });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new HttpError(409, "Sidekick's settings file must contain an object.", { code: "invalid_settings" });
  const rules = pick(document, "Rules", "rules") ?? [];
  if (!Array.isArray(rules)) throw new HttpError(409, "Sidekick's Rules setting must be a list.", { code: "invalid_settings" });
  if (rules.length > MAX_RULES) throw new HttpError(409, `Sidekick has more than ${MAX_RULES} tasks; refusing to rewrite it.`, { code: "invalid_settings" });
  return { text, revision: revisionForText(text), document: document as Doc, rules: rules as Doc[] };
}

export type RuleOperation = { type: "create" } | { type: "update"; id: string } | { type: "delete"; id: string };

export async function mutateRules(settingsPath: string, operation: RuleOperation, body: unknown): Promise<{ revision: string | null; ruleId: string }> {
  const request = asObject(body, "The request");
  const current = await readSettingsDocument(settingsPath);
  requireRevision(request, current.revision);
  validateExistingRuleIds(current.rules);

  const rules = [...current.rules];
  let index = -1;
  if (operation.type !== "create") {
    const id = guidValue(operation.id, "Task id");
    index = rules.findIndex((rule) => String(pick(rule, "Id", "id") ?? "").toLowerCase() === id);
    if (index < 0) throw new HttpError(404, "That Sidekick task no longer exists.", { code: "rule_not_found" });
  }

  let stored: Doc;
  if (operation.type === "create") {
    if (rules.length >= MAX_RULES) throw invalid(`Sidekick can have at most ${MAX_RULES} tasks.`);
    stored = storedRule(request.rule, null, null);
    if (rules.some((rule) => String(pick(rule, "Id", "id") ?? "").toLowerCase() === stored.Id)) throw invalid("Task ids must be unique.");
    rules.push(stored);
  } else if (operation.type === "update") {
    stored = storedRule(request.rule, rules[index]!, operation.id);
    rules[index] = stored;
  } else {
    stored = rules.splice(index, 1)[0]!;
  }

  const output: Doc = { ...current.document };
  deleteKnownKeys(output, ["Version", "Rules"]);
  output.Version = integerValue(pick(current.document, "Version", "version"), "Settings version", 1, 1_000_000, 1);
  output.Rules = rules;
  const text = `${JSON.stringify(output, null, 2)}\n`;
  await writeAtomic(settingsPath, text);
  return { revision: revisionForText(text), ruleId: String(pick(stored, "Id", "id")).toLowerCase() };
}

function storedRule(input: unknown, existing: Doc | null, forcedId: string | null): Doc {
  const raw = asObject(input, "The task");
  const id = forcedId ? guidValue(forcedId, "Task id") : guidValue(pick(raw, "Id", "id"), "Task id", true);
  const suppliedId = pick(raw, "Id", "id");
  if (forcedId && suppliedId && guidValue(suppliedId, "Task id") !== id) throw invalid("The task id in the address and form do not match.");

  const triggerProcess = requiredText(pick(raw, "TriggerProcess", "triggerProcess"), "Trigger process", 260);
  if (/[\\/]/.test(triggerProcess)) throw invalid("Trigger process must be an image name such as Example.exe, not a file path.");

  const companionsInput = pick(raw, "Companions", "companions");
  if (!Array.isArray(companionsInput)) throw invalid("Companions must be a list.");
  if (companionsInput.length > MAX_COMPANIONS) throw invalid(`A task can have at most ${MAX_COMPANIONS} companions.`);

  const prior = existingById(pick(existing, "Companions", "companions"));
  const companionIds = new Set<string>();
  const companions = companionsInput.map((companion) => {
    const supplied = String(pick(companion, "Id", "id") ?? "").toLowerCase();
    const stored = storedCompanion(companion, prior.get(supplied) ?? null);
    if (companionIds.has(stored.Id as string)) throw invalid("Companion ids must be unique within a task.");
    companionIds.add(stored.Id as string);
    return stored;
  });

  const result: Doc = { ...(existing ?? {}) };
  deleteKnownKeys(result, ["Id", "Name", "Enabled", "TriggerProcess", "DebounceSeconds", "CloseCompanionsOnExit", "Companions"]);
  Object.assign(result, {
    Id: id,
    Name: requiredText(pick(raw, "Name", "name"), "Task name", 120),
    Enabled: booleanValue(pick(raw, "Enabled", "enabled"), "Enabled", true),
    TriggerProcess: triggerProcess,
    DebounceSeconds: integerValue(pick(raw, "DebounceSeconds", "debounceSeconds"), "Debounce", 0, 3600, 30),
    CloseCompanionsOnExit: booleanValue(pick(raw, "CloseCompanionsOnExit", "closeCompanionsOnExit"), "Stop-on-close", false),
    Companions: companions,
  });
  return result;
}

/** Unknown keys on an existing rule or companion are kept, so a newer tray app's fields survive an edit here. */
function storedCompanion(input: unknown, existing: Doc | null): Doc {
  const raw = asObject(input, "Each companion");
  const id = guidValue(pick(raw, "Id", "id"), "Companion id", true);
  const hubId = optionalText(pick(raw, "HubId", "hubId"), "Script Hub id", 160);
  const exePath = optionalText(pick(raw, "ExePath", "exePath"), "Program path", 2048);
  if (!hubId && !exePath) throw invalid("Each companion needs a Script Hub id or a direct program path.");
  const fallback = hubId || (exePath ? win32.basename(exePath, win32.extname(exePath)) : "");
  const name = requiredText(pick(raw, "Name", "name") || fallback, "Companion name", 120);
  const result: Doc = { ...(existing ?? {}) };
  deleteKnownKeys(result, ["Id", "Name", "ExePath", "Arguments", "WorkingDirectory", "HubId", "AlreadyRunningProcess", "AlreadyRunningPort"]);
  Object.assign(result, {
    Id: id,
    Name: name,
    ExePath: exePath,
    Arguments: optionalText(pick(raw, "Arguments", "arguments"), `Arguments for “${name}”`, 4096),
    WorkingDirectory: optionalText(pick(raw, "WorkingDirectory", "workingDirectory"), `Working folder for “${name}”`, 2048),
    HubId: hubId,
    AlreadyRunningProcess: optionalText(pick(raw, "AlreadyRunningProcess", "alreadyRunningProcess"), `Already-running process for “${name}”`, 260),
    AlreadyRunningPort: integerValue(pick(raw, "AlreadyRunningPort", "alreadyRunningPort"), `Already-running port for “${name}”`, 1, 65535, null),
  });
  return result;
}

function requireRevision(body: Doc, currentRevision: string | null): void {
  if (!Object.prototype.hasOwnProperty.call(body, "revision")) throw new HttpError(428, "Reload Sidekick before saving this task.", { code: "revision_required" });
  const expected = body.revision === null ? null : String(body.revision || "");
  if (expected !== currentRevision) {
    throw new HttpError(409, "Sidekick tasks changed after this editor was opened. Reload and review the newer version before saving.", { code: "stale_config", currentRevision });
  }
}

function validateExistingRuleIds(rules: Doc[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    const id = guidValue(pick(rule, "Id", "id"), "Existing task id");
    if (ids.has(id)) throw new HttpError(409, "Sidekick's task ids are not unique.", { code: "invalid_settings" });
    ids.add(id);
  }
}

function existingById(items: unknown): Map<string, Doc> {
  const result = new Map<string, Doc>();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(pick(item, "Id", "id") ?? "").toLowerCase();
    if (id) result.set(id, item as Doc);
  }
  return result;
}

function deleteKnownKeys(target: Doc, names: string[]): void {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const key of Object.keys(target)) if (wanted.has(key.toLowerCase())) delete target[key];
}

function asObject(value: unknown, label: string): Doc {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Doc;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const result = optionalText(value, label, maxLength);
  if (!result) throw invalid(`${label} is required.`);
  return result;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw invalid(`${label} must be text.`);
  const result = value.trim();
  if (!result) return null;
  if (result.length > maxLength) throw invalid(`${label} must be ${maxLength} characters or fewer.`);
  if (result.includes("\0")) throw invalid(`${label} contains an invalid character.`);
  return result;
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid(`${label} must be on or off.`);
  return value;
}

function integerValue<T extends number | null>(value: unknown, label: string, min: number, max: number, fallback: T): number | T {
  if (value === null || value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw invalid(`${label} must be a whole number from ${min} to ${max}.`);
  return result;
}

function guidValue(value: unknown, label: string, create = false): string {
  if ((value === null || value === undefined || value === "") && create) return randomUUID();
  if (typeof value !== "string" || !GUID_RE.test(value.trim())) throw invalid(`${label} is not a valid id.`);
  return value.trim().toLowerCase();
}

function invalid(message: string): HttpError {
  return new HttpError(400, message, { code: "invalid_rule" });
}
