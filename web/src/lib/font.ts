// The console's typefaces, chosen in Settings → Appearance and stored per browser beside the theme.
//
// Same load-bearing rule as the themes, for the same reason: **"Theme default" sets no attribute at
// all.** `styles.css` declares --font-sans / --font-mono, so leaving <html> unmarked is what
// guarantees a console that never chose a face is byte-for-byte the console it was. Every option
// other than the default lives in `web/src/fonts.css`, where every rule is scoped behind
// `[data-font="…"]` / `[data-font-mono="…"]`, and `test:fonts` fails the suite if one escapes.
//
// Two independent choices, because they answer different questions. The INTERFACE face drives
// --font-sans (task titles, briefs, prose, buttons: the chrome). The MONOSPACE face drives
// --font-mono (transcripts, tool output, the editor, every measurement in the top bar). Picking a
// serif for the interface must never turn a diff proportional, which is why the mono areas read
// their own token and are only ever changed by their own picker.

/** The interface face. `default` is the absence of an attribute, per the note above. */
export type FontId = "default" | "system" | "geist" | "plex-sans" | "source-serif" | "space-grotesk" | "jetbrains";

/** The code/transcript face. `default` is the absence of an attribute. */
export type MonoFontId = "default" | "system" | "plex-mono" | "fira-code" | "source-code";

export const DEFAULT_FONT: FontId = "default";
export const DEFAULT_MONO_FONT: MonoFontId = "default";

/** What the picker prints beside a specimen, and how the option is filed. */
export type FontCategory = "Sans" | "Serif" | "Mono" | "System";

export interface FontMeta<Id extends string> {
  id: Id;
  name: string;
  category: FontCategory;
  /** One line under the name: what this face is for, not what it looks like. */
  note: string;
  /** The exact stack the option installs, and the stack the picker's specimen renders in. */
  stack: string;
}

/**
 * The stacks are written once here and once in `fonts.css`, because the picker has to paint a
 * specimen in a face that is not the active one. A tile that copies the *look* of the option it
 * sells is the thing that drifts, so both sides name the same stack and `test:fonts` compares them.
 */
export const UI_FONTS: readonly FontMeta<FontId>[] = [
  {
    id: "default",
    name: "Theme default",
    category: "Sans",
    note: "Whatever the active theme was drawn in, Inter Tight today. Changes nothing.",
    stack: '"Inter Tight", system-ui, -apple-system, sans-serif',
  },
  {
    id: "system",
    name: "System UI",
    category: "System",
    note: "This machine's own interface face. Nothing to download, and the console reads as native.",
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  {
    id: "geist",
    name: "Geist",
    category: "Sans",
    note: "Neutral and tightly spaced. Holds a long task title at a small size better than most.",
    stack: '"Geist Variable", "Geist", system-ui, sans-serif',
  },
  {
    id: "plex-sans",
    name: "IBM Plex Sans",
    category: "Sans",
    note: "Humanist and a shade wider, with real letter shapes. Pairs with IBM Plex Mono below.",
    stack: '"IBM Plex Sans Variable", "IBM Plex Sans", system-ui, sans-serif',
  },
  {
    id: "source-serif",
    name: "Source Serif 4",
    category: "Serif",
    note: "A reading serif that survives 13px. Turns briefs and feed prose into a document.",
    stack: '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif',
  },
  {
    id: "space-grotesk",
    name: "Space Grotesk",
    category: "Sans",
    note: "Squared off and mechanical. The console stops looking like every other dashboard.",
    stack: '"Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif',
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    category: "Mono",
    note: "The whole console in the terminal face it already uses for measurements. Deliberate, and not for everyone.",
    stack: '"JetBrains Mono", ui-monospace, monospace',
  },
];

export const MONO_FONTS: readonly FontMeta<MonoFontId>[] = [
  {
    id: "default",
    name: "Theme default",
    category: "Mono",
    note: "JetBrains Mono, the face the console ships in. Changes nothing.",
    stack: '"JetBrains Mono", ui-monospace, "Cascadia Code", monospace',
  },
  {
    id: "system",
    name: "System mono",
    category: "System",
    note: "Cascadia Code, SF Mono, whatever this machine calls its terminal face. Nothing to download.",
    stack: 'ui-monospace, "Cascadia Code", Consolas, "SF Mono", monospace',
  },
  {
    id: "plex-mono",
    name: "IBM Plex Mono",
    category: "Mono",
    note: "Warmer and less engineered. Long tool output reads less like a wall.",
    stack: '"IBM Plex Mono", ui-monospace, monospace',
  },
  {
    id: "fira-code",
    name: "Fira Code",
    category: "Mono",
    note: "Programming ligatures: => and !== and >= become single marks in diffs and the editor.",
    stack: '"Fira Code Variable", "Fira Code", ui-monospace, monospace',
  },
  {
    id: "source-code",
    name: "Source Code Pro",
    category: "Mono",
    note: "Open apertures and an unambiguous 0/O/1/l. The quiet workhorse.",
    stack: '"Source Code Pro Variable", "Source Code Pro", ui-monospace, monospace',
  },
];

const UI_IDS: readonly string[] = UI_FONTS.map((f) => f.id);
const MONO_IDS: readonly string[] = MONO_FONTS.map((f) => f.id);

export const isFontId = (v: unknown): v is FontId => typeof v === "string" && UI_IDS.includes(v);
export const isMonoFontId = (v: unknown): v is MonoFontId => typeof v === "string" && MONO_IDS.includes(v);

/**
 * Put the chosen faces on the document. The attribute is what `fonts.css` selects on; the default
 * REMOVES it rather than writing "default", so the console falls back to the theme's own tokens
 * instead of to a rule that restates them.
 *
 * Swapping a face reflows the whole console, so there is deliberately no cross-fade here: a
 * transition on a metric change is a smear, not a fade. The theme's colour cross-fade is the
 * opposite case and keeps its animation.
 */
export function applyFonts(ui: FontId, mono: MonoFontId): void {
  const root = document.documentElement;
  if (ui === DEFAULT_FONT) delete root.dataset.font;
  else root.dataset.font = ui;
  if (mono === DEFAULT_MONO_FONT) delete root.dataset.fontMono;
  else root.dataset.fontMono = mono;
}
