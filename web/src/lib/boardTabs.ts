import type { BoardView, ModuleView } from "../types.js";

export interface BoardTab {
  view: BoardView;
  label: string;
  title: string;
  /** An opt-in tab: hidden until switched on in Settings, the reverse of the hide list. */
  optional?: true;
}

/** Every board area, in tab order. The desktop tab strip, the narrow-board area select, the phone's
 *  "All areas" menu and the Settings visibility toggles all read this one list. */
export const BOARD_TABS: readonly BoardTab[] = [
  { view: "tasks", label: "Tasks", title: "Back to the task board" },
  { view: "ide", label: "IDE", title: "Edit workspace files and manage Git" },
  { view: "remote", label: "Remote control", title: "See and control this PC" },
  { view: "notes", label: "Notes", title: "Branches, PRs and reminders waiting on you" },
  { view: "calendar", label: "Calendar", title: "Your events, reminders and scheduled tasks by day, week and month" },
  { view: "schedules", label: "Scheduled Tasks", title: "View and manage scheduled tasks" },
  { view: "goals", label: "Goals", title: "Goal-directed tasks: standing objectives the director keeps working on until they are met" },
  { view: "supervisor", label: "Supervisor", title: "The Director Supervisor watchdog: its state, budget and recent checks/actions" },
  { view: "patchnotes", label: "Patch notes", title: "What changed in GGO: new features, fixes and what the next update brings" },
  { view: "scripthub", label: "Script Hub", title: "Start, stop and watch the scripts Script Hub supervises", optional: true },
  { view: "surveillance", label: "Surveillance", title: "Live camera previews, recording and camera settings", optional: true },
  { view: "home", label: "Home", title: "Robot vacuum control through Home Assistant or local miIO", optional: true },
  { view: "sidekick", label: "Sidekick", title: "The companion launcher: which programs start alongside which", optional: true },
];

export const MODULE_VIEWS: readonly ModuleView[] = ["scripthub", "surveillance", "home", "sidekick"];

export const isModuleView = (view: unknown): view is ModuleView => typeof view === "string" && (MODULE_VIEWS as readonly string[]).includes(view);

/** A persisted list of switched-on optional tabs, minus anything that is not one. */
export const sanitizeShownModules = (raw: unknown): ModuleView[] => (Array.isArray(raw) ? MODULE_VIEWS.filter((view) => raw.includes(view)) : []);

/** Tasks is the board's home: every "back to the board" link and the hidden-tab fallback land there. */
export const isHideableTab = (view: BoardView): boolean => view !== "tasks" && !isModuleView(view);

const HIDEABLE_VIEWS = new Set<string>(BOARD_TABS.filter((tab) => isHideableTab(tab.view)).map((tab) => tab.view));

/** A persisted hidden-tab list, minus anything that is not a hideable view (Tasks, a retired tab). */
export const sanitizeHiddenTabs = (raw: unknown): BoardView[] =>
  Array.isArray(raw) ? BOARD_TABS.map((tab) => tab.view).filter((view) => HIDEABLE_VIEWS.has(view) && raw.includes(view)) : [];

/** The tabs this browser shows. Remote control exists only once it is set up; a hidden tab is left
 *  out unless it is the one open right now, so a link that opens it still has a heading to show. An
 *  optional tab shows only once switched on. */
export function visibleBoardTabs(hidden: readonly BoardView[], remoteEnabled: boolean, current: BoardView, shownModules: readonly ModuleView[]): BoardTab[] {
  return BOARD_TABS.filter((tab) => {
    if (tab.view === "remote" && !remoteEnabled) return false;
    if (tab.view === current) return true;
    return isModuleView(tab.view) ? shownModules.includes(tab.view) : !hidden.includes(tab.view);
  });
}
