import { JsonFile } from "./configStore.js";
import { readHubSettings } from "./hubClient.js";
import { HttpError } from "./router.js";

/**
 * Where a module's settings came from, so the Settings view can say whether the Deck's were carried over.
 * `deck-unreachable` is never written to disk: nothing listened where Script Hub should be, so the module
 * runs on an empty setup that is saved (as `new`) only once the owner changes something.
 */
export type ConfigOrigin = "dashboard-deck" | "new" | "deck-unreachable";

export interface StoredConfig<T> {
  version: 1;
  origin: ConfigOrigin;
  importedAt: number | null;
  value: T;
}

/**
 * Loads a module's config, importing the Dashboard Deck's copy on first use. While the Deck cannot be read
 * nothing is written, so the import is tried again next time instead of being lost to an empty file. A hub
 * that answers badly (an error or a timeout) blocks the start; a machine with no Script Hub at all starts on
 * an unsaved empty setup. `fromDeck` returns null when the Deck held nothing for this module.
 */
export async function loadOrImport<T>(options: {
  file: JsonFile<StoredConfig<T>>;
  hubUrl: string;
  sections: string[];
  fromDeck: (sections: Record<string, unknown>) => T | null;
  empty: () => T;
  log: (line: string) => void;
}): Promise<StoredConfig<T>> {
  const stored = await options.file.read();
  if (stored?.version === 1) return stored;
  const imported = await importFromDeck(options);
  if (imported.origin === "deck-unreachable") {
    options.log(`no Script Hub is listening, so there were no Dashboard Deck settings to import (${options.sections.join(", ")}); starting empty and unsaved`);
    return imported;
  }
  await options.file.write(imported);
  if (imported.origin === "dashboard-deck") options.log(`imported settings from the Dashboard Deck (${options.sections.join(", ")})`);
  return imported;
}

/** A failed read throws; only a reachable Deck with nothing to carry over yields an empty config. */
export async function importFromDeck<T>(options: {
  hubUrl: string;
  sections: string[];
  fromDeck: (sections: Record<string, unknown>) => T | null;
  empty: () => T;
}): Promise<StoredConfig<T>> {
  const sections: Record<string, unknown> = {};
  // Refuse to expose editable defaults while the old settings cannot be read. Saving those defaults
  // would create config.json and permanently prevent the next start from importing the owner's setup.
  try {
    for (const section of options.sections) sections[section] = await readHubSettings<unknown>(options.hubUrl, section);
  } catch (error) {
    if (error instanceof HttpError && error.extra.hubAbsent === true) return { version: 1, origin: "deck-unreachable", importedAt: null, value: options.empty() };
    throw error;
  }
  const value = options.fromDeck(sections);
  return value === null
    ? { version: 1, origin: "new", importedAt: null, value: options.empty() }
    : { version: 1, origin: "dashboard-deck", importedAt: Date.now(), value };
}

/** The config to write after the owner's own change; an unsaved hub-less setup becomes a real one. */
export function withValue<T>(stored: StoredConfig<T>, value: T): StoredConfig<T> {
  return { ...stored, origin: stored.origin === "deck-unreachable" ? "new" : stored.origin, value };
}
