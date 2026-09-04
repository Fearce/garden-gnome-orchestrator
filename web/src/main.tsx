import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
