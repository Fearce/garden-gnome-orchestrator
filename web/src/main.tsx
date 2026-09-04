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
import "./styles.css";
// Every rule in here is scoped behind [data-theme="nocturne"], so importing it changes nothing for a
// console on Classic. Order matters only for ties, and it is loaded after styles.css deliberately.
import "./themes/nocturne.css";
import { App } from "./App.js";
import { init, useStore } from "./store.js";
import { applyTheme } from "./lib/theme.js";
import { startVersionWatch } from "./lib/version.js";
import { startUpdateWatch } from "./lib/update.js";

// index.html's inline script has normally painted the theme already; this reconciles <html> with the
// value the store actually parsed, so a stored theme the boot script doesn't recognise still applies.
applyTheme(useStore.getState().theme);

void init();
startVersionWatch();
startUpdateWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
