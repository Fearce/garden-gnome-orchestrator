import type { BoardView } from "../types.js";

export interface BoardTab {
  view: BoardView;
  label: string;
  title: string;
}

/** Every board area, in tab order. The desktop tab strip, the narrow-board area select, the phone's
 *  "All areas" menu and the Settings visibility toggles all read this one list. */
export const BOARD_TABS: readonly BoardTab[] = [
  { view: "tasks", label: "Tasks", title: "Back to the task board" },
  { view: "ide", label: "IDE", title: "Edit workspace files and manage Git" },
  { view: "remote", label: "Remote control", title: "See and control this PC" },
  { view: "notes", label: "Notes", title: "Branches, PRs and reminders waiting on you" },
  { view: "schedules", label: "Scheduled Tasks", title: "View and manage scheduled tasks" },
  { view: "goals", label: "Goals", title: "Goal-directed tasks: standing objectives the director keeps working on until they are met" },
  { view: "supervisor", label: "Supervisor", title: "The Director Supervisor watchdog: its state, budget and recent checks/actions" },
  { view: "patchnotes", label: "Patch notes", title: "What changed in GGO: new features, fixes and what the next update brings" },
];

/** Tasks is the board's home: every "back to the board" link and the hidden-tab fallback land there. */
export const isHideableTab = (view: BoardView): boolean => view !== "tasks";

const HIDEABLE_VIEWS = new Set<string>(BOARD_TABS.filter((tab) => isHideableTab(tab.view)).map((tab) => tab.view));

/** A persisted hidden-tab list, minus anything that is not a hideable view (Tasks, a retired tab). */
export const sanitizeHiddenTabs = (raw: unknown): BoardView[] =>
  Array.isArray(raw) ? BOARD_TABS.map((tab) => tab.view).filter((view) => HIDEABLE_VIEWS.has(view) && raw.includes(view)) : [];

/** The tabs this browser shows. Remote control exists only once it is set up; a hidden tab is left
 *  out unless it is the one open right now, so a link that opens it still has a heading to show. */
export function visibleBoardTabs(hidden: readonly BoardView[], remoteEnabled: boolean, current: BoardView): BoardTab[] {
  return BOARD_TABS.filter((tab) => (tab.view !== "remote" || remoteEnabled) && (tab.view === current || !hidden.includes(tab.view)));
}
