/** The optional local-service modules GGO can host. Each runs in its own worker process, started on first
 *  use, so a camera, a device or a slow Script Hub can never stall the console's event loop. The ids double
 *  as the board-view names in the web app and as folder names under `<dataDir>/modules/`. */
export const MODULE_IDS = ["scripthub", "surveillance", "home", "sidekick"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const MODULE_LABELS: Record<ModuleId, string> = {
  scripthub: "Script Hub",
  surveillance: "Surveillance",
  home: "Home Automation",
  sidekick: "Sidekick",
};

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}
