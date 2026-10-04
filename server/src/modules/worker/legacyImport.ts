import { JsonFile } from "./configStore.js";
import { readHubSettings } from "./hubClient.js";

/** Where a module's settings came from, so the Settings view can say whether the Deck's were carried over. */
export type ConfigOrigin = "dashboard-deck" | "new";

export interface StoredConfig<T> {
  version: 1;
  origin: ConfigOrigin;
  importedAt: number | null;
  value: T;
}

/**
 * Loads a module's config, importing the Dashboard Deck's copy on first use. While the Deck cannot be read
 * (Script Hub down) nothing is written, so the import is tried again next time instead of being lost to an
 * empty file. `fromDeck` returns null when the Deck held nothing for this module.
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
  if (imported) {
    await options.file.write(imported);
    if (imported.origin === "dashboard-deck") options.log(`imported settings from the Dashboard Deck (${options.sections.join(", ")})`);
    return imported;
  }
  return { version: 1, origin: "new", importedAt: null, value: options.empty() };
}

/** Null while the hub cannot be reached. A reachable Deck with nothing to carry over yields an empty config. */
export async function importFromDeck<T>(options: {
  hubUrl: string;
  sections: string[];
  fromDeck: (sections: Record<string, unknown>) => T | null;
  empty: () => T;
}): Promise<StoredConfig<T> | null> {
  const sections: Record<string, unknown> = {};
  try {
    for (const section of options.sections) sections[section] = await readHubSettings<unknown>(options.hubUrl, section);
  } catch {
    return null;
  }
  const value = options.fromDeck(sections);
  return value === null
    ? { version: 1, origin: "new", importedAt: null, value: options.empty() }
    : { version: 1, origin: "dashboard-deck", importedAt: Date.now(), value };
}
