import type { BoardView, ModuleView } from "../types.js";

export interface BoardTab {
  view: BoardView;
  label: string;
  title: string;
  /** An opt-in tab: hidden until switched on in Settings, the reverse of the hide list. */
  optional?: true;
}

/** Every board area, in the built-in tab order; orderedBoardTabs applies the owner's own order. The
 *  desktop tab strip, the narrow-board area select, the phone's "All areas" menu and the Settings
 *  visibility toggles all read this one list. */
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
export function visibleBoardTabs(hidden: readonly BoardView[], remoteEnabled: boolean, current: BoardView, shownModules: readonly ModuleView[], order: readonly BoardView[] = []): BoardTab[] {
  return orderedBoardTabs(order).filter((tab) => {
    if (tab.view === "remote" && !remoteEnabled) return false;
    if (tab.view === current) return true;
    return isModuleView(tab.view) ? shownModules.includes(tab.view) : !hidden.includes(tab.view);
  });
}

const TAB_BY_VIEW = new Map<string, BoardTab>(BOARD_TABS.map((tab) => [tab.view, tab]));

/** A persisted tab order, minus unknown and repeated entries. It may name only some tabs. */
export const sanitizeTabOrder = (raw: unknown): BoardView[] =>
  Array.isArray(raw) ? raw.filter((view, i): view is BoardView => typeof view === "string" && TAB_BY_VIEW.has(view) && raw.indexOf(view) === i) : [];

/** Every tab in the owner's order: the saved ones first, then any it never mentions (a tab added in a
 *  later release) in their built-in order, so no saved order can lose a tab. */
export function orderedBoardTabs(order: readonly BoardView[]): BoardTab[] {
  const saved = sanitizeTabOrder(order).map((view) => TAB_BY_VIEW.get(view)!);
  return [...saved, ...BOARD_TABS.filter((tab) => !saved.includes(tab))];
}

/** The full tab order after `view` is dropped onto `target`'s place. Moving within the whole list,
 *  not just the visible strip, keeps a hidden tab where it was. */
export function moveBoardTab(order: readonly BoardView[], view: BoardView, target: BoardView): BoardView[] {
  const views = orderedBoardTabs(order).map((tab) => tab.view);
  const from = views.indexOf(view);
  const to = views.indexOf(target);
  if (from < 0 || to < 0 || from === to) return views;
  views.splice(to, 0, ...views.splice(from, 1));
  return views;
}
