// The console's typefaces, chosen in Settings → Appearance and stored per browser beside the theme.
//
// Same load-bearing rule as the themes, for the same reason: **"Theme default" sets no attribute at
// all.** `styles.css` declares --font-sans / --font-mono and faces the heading tier itself, so
// leaving <html> unmarked is what guarantees a console that never chose a face is byte-for-byte the
// console it was. Every option other than the default lives in `web/src/fonts.css`, where every rule
// is scoped behind `[data-font="…"]` / `[data-font-mono="…"]` / `[data-font-display…]`, and
// `test:fonts` fails the suite if one escapes.
//
// Three independent choices, because they answer different questions. The INTERFACE face drives
// --font-sans (briefs, prose, buttons: the chrome). The MONOSPACE face drives --font-mono
// (transcripts, tool output, the editor, every measurement in the top bar). Picking a serif for the
// interface must never turn a diff proportional, which is why the mono areas read their own token
// and are only ever changed by their own picker.
//
// The DISPLAY face drives --font-display: the handful of elements that NAME something. The masthead
// in the top bar, a task card's header, the section and lane headings, the detail panel's title and
// the dialog titles. Those are the ones neither of the other two pickers could reach, because the
// masthead is hard-set in mono as chrome and a theme restates the whole tier with its own scale and
// weights. This channel out-specifies both, and like them it is inert until the owner picks a face.

/** The interface face. `default` is the absence of an attribute, per the note above. */
export type FontId = "default" | "system" | "geist" | "plex-sans" | "source-serif" | "space-grotesk" | "jetbrains";

/** The code/transcript face. `default` is the absence of an attribute. */
export type MonoFontId = "default" | "system" | "plex-mono" | "fira-code" | "source-code";

/** The heading face: the masthead, card headers, section titles. `default` is the absence of an
 *  attribute, so the tier keeps whatever the theme and the interface face already gave it. */
export type DisplayFontId =
  | "default"
  | "geist"
  | "instrument-sans"
  | "space-grotesk"
  | "bricolage"
  | "instrument-serif"
  | "source-serif"
  | "jetbrains";

export const DEFAULT_FONT: FontId = "default";
export const DEFAULT_MONO_FONT: MonoFontId = "default";
export const DEFAULT_DISPLAY_FONT: DisplayFontId = "default";

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

/**
 * The heading faces. Shorter than the interface list on purpose: this tier is six words on a card
 * header and two in the masthead, so it can carry a face with an opinion. That is also why the
 * list leans display rather than text, and why there is no "System UI" row (a machine's default UI
 * face is the one thing that never reads as a chosen identity).
 *
 * "Theme default" advertises the INTERFACE token, because that is the token every theme now faces
 * this tier with: no theme may hand the owner a serif they never picked (`test:fonts` section 10).
 * It is still not uniform under the default, since the masthead is mono chrome and each theme sets
 * its own heading scale and weights, so the row's note says what the default really is rather than
 * letting one specimen imply the console is uniform here already. Choosing any other row is exactly
 * what makes it uniform.
 */
export const DISPLAY_FONTS: readonly FontMeta<DisplayFontId>[] = [
  {
    id: "default",
    name: "Theme default",
    category: "Sans",
    note: "The theme's own heading scale and weights, in the interface face. Serif is a pick below, never a default. Changes nothing.",
    stack: '"Inter Tight", system-ui, -apple-system, sans-serif',
  },
  {
    id: "geist",
    name: "Geist",
    category: "Sans",
    note: "Neutral, tight, modern. The safe choice: it names things without commenting on them.",
    stack: '"Geist Variable", "Geist", system-ui, sans-serif',
  },
  {
    id: "instrument-sans",
    name: "Instrument Sans",
    category: "Sans",
    note: "A crisp grotesque with a little warmth. The companion to Instrument Serif further down.",
    stack: '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif',
  },
  {
    id: "space-grotesk",
    name: "Space Grotesk",
    category: "Sans",
    note: "Squared counters and flat terminals. Headings read as engineered, the body stays normal.",
    stack: '"Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif',
  },
  {
    id: "bricolage",
    name: "Bricolage Grotesque",
    category: "Sans",
    note: "The characterful one: uneven widths and a cut-in g. Drawn for headlines, odd as body text.",
    stack: '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif',
  },
  {
    id: "instrument-serif",
    name: "Instrument Serif",
    category: "Serif",
    note: "Nocturne's own display serif, on any theme. High contrast, and it wants the size it gets here.",
    stack: '"Instrument Serif", Georgia, serif',
  },
  {
    id: "source-serif",
    name: "Source Serif 4",
    category: "Serif",
    note: "A quieter serif than the one above. Headings read as a document rather than a masthead.",
    stack: '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif',
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    category: "Mono",
    note: "The top bar's own terminal face, extended over every heading. The console as one machine.",
    stack: '"JetBrains Mono", ui-monospace, monospace',
  },
];

const UI_IDS: readonly string[] = UI_FONTS.map((f) => f.id);
const MONO_IDS: readonly string[] = MONO_FONTS.map((f) => f.id);
const DISPLAY_IDS: readonly string[] = DISPLAY_FONTS.map((f) => f.id);

export const isFontId = (v: unknown): v is FontId => typeof v === "string" && UI_IDS.includes(v);
export const isMonoFontId = (v: unknown): v is MonoFontId => typeof v === "string" && MONO_IDS.includes(v);
export const isDisplayFontId = (v: unknown): v is DisplayFontId =>
  typeof v === "string" && DISPLAY_IDS.includes(v);

/**
 * Put the chosen faces on the document. The attribute is what `fonts.css` selects on; the default
 * REMOVES it rather than writing "default", so the console falls back to the theme's own tokens
 * instead of to a rule that restates them.
 *
 * Swapping a face reflows the whole console, so there is deliberately no cross-fade here: a
 * transition on a metric change is a smear, not a fade. The theme's colour cross-fade is the
 * opposite case and keeps its animation.
 */
export function applyFonts(ui: FontId, mono: MonoFontId, display: DisplayFontId): void {
  const root = document.documentElement;
  if (ui === DEFAULT_FONT) delete root.dataset.font;
  else root.dataset.font = ui;
  if (mono === DEFAULT_MONO_FONT) delete root.dataset.fontMono;
  else root.dataset.fontMono = mono;
  if (display === DEFAULT_DISPLAY_FONT) delete root.dataset.fontDisplay;
  else root.dataset.fontDisplay = display;
}
