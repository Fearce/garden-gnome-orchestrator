// The console's look, chosen in Settings → Appearance and stored per browser.
//
// The load-bearing rule: **Classic sets no attribute at all.** `styles.css` is the Classic theme, so
// leaving `<html>` unmarked is what guarantees nobody on Classic sees a single pixel move. Every other
// theme lives in its own stylesheet where every rule is scoped behind `[data-theme="<id>"]`, and
// `test:themes` fails the suite if one of those rules ever escapes that scope.

export type ThemeId = "classic" | "nocturne";

/** Classic is the default, and the default is what "no attribute on <html>" means. */
export const DEFAULT_THEME: ThemeId = "classic";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  /** One line under the name in the picker. */
  tagline: string;
  /** What actually changes, for the owner deciding whether to switch. */
  description: string;
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "classic",
    name: "Classic",
    tagline: "The original console",
    description:
      "Cool slate under a warm amber accent, Inter Tight throughout, tight geometry. Unchanged — picking it restores the console exactly as it has always looked.",
  },
  {
    id: "nocturne",
    name: "Nocturne",
    tagline: "Midnight ink, cold light, editorial type",
    description:
      "A deeper near-black board lit by pale cyan instead of amber. Task, panel and dialog titles switch to Instrument Serif, surfaces gain a lifted edge and softer corners, and panels, dialogs and menus move — a slide, a rise — instead of appearing.",
  },
];

const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && THEME_IDS.includes(v);

/** How long `.theme-transition` stays on <html>; must outlast the cross-fade declared in styles.css. */
const CROSS_FADE_MS = 320;
let crossFadeTimer: number | undefined;

/**
 * Put `theme` on the document. `animate` is for the owner's own click in the Appearance tab — it
 * cross-fades colours instead of snapping between two palettes. The boot path never animates: the
 * inline script in `index.html` has already set the attribute before first paint, and re-applying it
 * here with a transition would fade a page that is already correct.
 */
export function applyTheme(theme: ThemeId, animate = false): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme || (theme === DEFAULT_THEME && !root.dataset.theme)) return;

  if (animate) {
    root.classList.add("theme-transition");
    window.clearTimeout(crossFadeTimer);
    crossFadeTimer = window.setTimeout(() => root.classList.remove("theme-transition"), CROSS_FADE_MS);
  }

  if (theme === DEFAULT_THEME) delete root.dataset.theme;
  else root.dataset.theme = theme;
}
