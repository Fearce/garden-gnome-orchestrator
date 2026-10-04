import { pick, revisionForText } from "./rules.js";

/**
 * What the Sidekick tab shows: the tray app's rules, whether each trigger and companion is up, and the tail
 * of its log. I/O is injected so the whole build is testable without a filesystem, tasklist or socket.
 */

export interface LogEntry {
  time: string | null;
  level: string;
  message: string;
}

export interface Companion {
  id: string | null;
  name: string;
  exePath: string | null;
  arguments: string | null;
  workingDirectory: string | null;
  hubId: string | null;
  alreadyRunningProcess: string | null;
  alreadyRunningPort: number | null;
}

export interface Rule {
  id: string | null;
  name: string;
  enabled: boolean;
  triggerProcess: string;
  debounceSeconds: number;
  closeCompanionsOnExit: boolean;
  companions: Companion[];
}

export interface SidekickPaths {
  exe: string | null;
  settings: string;
  log: string;
  startupShortcut: string;
  logLines: number;
}

export interface SidekickIo {
  readText(path: string): Promise<string | null>;
  /** The end of a file that only grows (the log), so a long-lived log is never read whole. */
  readTail(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  mtime(path: string): Promise<Date | null>;
  runningImageNames(): Promise<string[]>;
  portIsListening(port: number): Promise<boolean | null>;
}

/** Mirrors the tray app's matcher: case-insensitive, `.exe` optional on either side, `*` and `?` wildcards. */
export function matchesProcessName(pattern: string | null | undefined, imageName: string | null | undefined): boolean {
  if (!pattern || !imageName) return false;
  const p = stripExe(pattern.trim());
  const name = stripExe(imageName.trim());
  if (!p) return false;
  if (!/[*?]/.test(p)) return p.toLowerCase() === name.toLowerCase();
  const source = `^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`;
  return new RegExp(source, "i").test(name);
}

function stripExe(value: string): string {
  return /\.exe$/i.test(value) ? value.slice(0, -4) : value;
}

function anyProcessMatches(pattern: string | null, imageNames: string[]): boolean | null {
  if (!pattern) return null;
  return imageNames.some((name) => matchesProcessName(pattern, name));
}

/**
 * `2026-01-02 20:53:01 [INFO] message`. The time separator follows the machine's culture (a dot on some
 * locales), so both are accepted; an unparsed line is a continuation of the entry above it.
 */
export function parseLogLines(text: string | null, limit = 60): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = raw.match(/^(\d{4}-\d{2}-\d{2} \d{2}[:.]\d{2}[:.]\d{2}) \[(\w+)\] ([\s\S]*)$/);
    if (match) entries.push({ time: match[1]!, level: match[2]!.toLowerCase(), message: match[3]! });
    else if (entries.length) entries[entries.length - 1]!.message += `\n${raw}`;
    else entries.push({ time: null, level: "info", message: raw });
  }
  return entries.slice(-limit);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeCompanion(raw: unknown): Companion {
  const port = Number(pick(raw, "AlreadyRunningPort", "alreadyRunningPort"));
  return {
    id: textOrNull(pick(raw, "Id", "id")),
    name: String(pick(raw, "Name", "name") ?? "").trim(),
    exePath: textOrNull(pick(raw, "ExePath", "exePath")),
    arguments: textOrNull(pick(raw, "Arguments", "arguments")),
    workingDirectory: textOrNull(pick(raw, "WorkingDirectory", "workingDirectory")),
    hubId: textOrNull(pick(raw, "HubId", "hubId")),
    alreadyRunningProcess: textOrNull(pick(raw, "AlreadyRunningProcess", "alreadyRunningProcess")),
    alreadyRunningPort: Number.isInteger(port) && port > 0 ? port : null,
  };
}

function normalizeRule(raw: unknown): Rule {
  const companions = pick(raw, "Companions", "companions");
  return {
    id: textOrNull(pick(raw, "Id", "id")),
    name: String(pick(raw, "Name", "name") ?? "").trim(),
    enabled: pick(raw, "Enabled", "enabled") !== false,
    triggerProcess: String(pick(raw, "TriggerProcess", "triggerProcess") ?? "").trim(),
    debounceSeconds: Number(pick(raw, "DebounceSeconds", "debounceSeconds") ?? 0) || 0,
    closeCompanionsOnExit: pick(raw, "CloseCompanionsOnExit", "closeCompanionsOnExit") === true,
    companions: Array.isArray(companions) ? companions.map(normalizeCompanion) : [],
  };
}

/** The tray app writes PascalCase and reads either casing, and a hand-edited file is allowed; so is this. */
export function parseSettings(text: string): { version: number; defaultDebounceSeconds: number; rules: Rule[] } {
  const doc = JSON.parse(text) as unknown;
  const rules = pick(doc, "Rules", "rules");
  const app = pick(doc, "App", "app");
  const debounce = Number(pick(app, "DefaultDebounceSeconds", "defaultDebounceSeconds") ?? 30);
  return {
    version: Number(pick(doc, "Version", "version") ?? 1) || 1,
    defaultDebounceSeconds: Number.isInteger(debounce) && debounce >= 0 && debounce <= 3600 ? debounce : 30,
    rules: Array.isArray(rules) ? rules.map(normalizeRule) : [],
  };
}

export async function buildSidekickState(paths: SidekickPaths, io: SidekickIo) {
  const settingsText = await io.readText(paths.settings);
  let settings: ReturnType<typeof parseSettings> = { version: 1, defaultDebounceSeconds: 30, rules: [] };
  let settingsError: string | null = null;
  if (settingsText !== null) {
    try {
      settings = parseSettings(settingsText);
    } catch (error) {
      settingsError = (error as Error).message;
    }
  }
  const imageNames = await io.runningImageNames();
  const exeName = paths.exe ? paths.exe.split(/[\\/]/).pop() ?? null : null;
  const rules = await Promise.all(
    settings.rules.map(async (rule) => ({
      ...rule,
      triggerRunning: anyProcessMatches(rule.triggerProcess, imageNames),
      companions: await Promise.all(rule.companions.map(async (companion) => ({ ...companion, running: await companionIsUp(companion, imageNames, io) }))),
    })),
  );
  const logText = await io.readTail(paths.log);
  return {
    generatedAt: new Date().toISOString(),
    installed: paths.exe ? await io.exists(paths.exe) : false,
    exePath: paths.exe,
    running: exeName ? anyProcessMatches(exeName, imageNames) === true : false,
    startOnLogin: await io.exists(paths.startupShortcut),
    settingsPath: paths.settings,
    configured: settingsText !== null,
    settingsRevision: revisionForText(settingsText),
    settingsError,
    defaultDebounceSeconds: settings.defaultDebounceSeconds,
    rules,
    log: { path: paths.log, updatedAt: (await io.mtime(paths.log))?.toISOString() ?? null, entries: parseLogLines(logText, paths.logLines) },
  };
}

/** The engine's own two probes, in its order: a named process, then a listening port. Null: neither declared. */
async function companionIsUp(companion: Companion, imageNames: string[], io: SidekickIo): Promise<boolean | null> {
  const byName = anyProcessMatches(companion.alreadyRunningProcess, imageNames);
  if (byName === true) return true;
  if (companion.alreadyRunningPort) {
    const byPort = await io.portIsListening(companion.alreadyRunningPort);
    if (byPort !== null) return byPort;
  }
  return byName;
}
