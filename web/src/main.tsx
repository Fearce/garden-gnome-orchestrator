import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The console's three typefaces ship in the bundle (@fontsource = the same faces the old Google
// Fonts link served, as woff2 Vite hashes into dist). A LAN-first, offline-tolerant console must
// not phone a CDN for its identity — `test:themes` fails if an external font link comes back.
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "@fontsource/inter-tight/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";

// The Appearance typeface options (web/src/lib/font.ts). Same rule as above: bundled, never a CDN.
// Only the @font-face declarations are eager; a browser fetches a woff2 when something on screen is
// actually set in that face, so an owner on the default pays the CSS and none of the font bytes.
import "@fontsource-variable/geist";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/fira-code";
import "@fontsource-variable/source-code-pro";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";
// Every rule in here is behind [data-font…]/[data-font-mono…]/[data-font-display…], which the
// default option of each channel never sets, so a console that never chose a typeface matches
// nothing in this file.
import "./fonts.css";
// Every rule in here is scoped behind [data-theme="nocturne"], so importing it changes nothing for a
// console on Classic. Order matters only for ties, and it is loaded after styles.css deliberately.
import "./themes/nocturne.css";
import { App } from "./App.js";
import { init, useStore } from "./store.js";
import { applyTheme } from "./lib/theme.js";
import { applyFonts } from "./lib/font.js";
import { startVersionWatch } from "./lib/version.js";
import { startUpdateWatch } from "./lib/update.js";

// index.html's inline script has normally painted the theme already; this reconciles <html> with the
// value the store actually parsed, so a stored theme the boot script doesn't recognise still applies.
applyTheme(useStore.getState().theme);
applyFonts(useStore.getState().uiFont, useStore.getState().monoFont, useStore.getState().displayFont);

void init();
startVersionWatch();
startUpdateWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
