import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.js";
import { RunHubDemo } from "./components/RunHubDemo.js";
import { GitChangesDemo } from "./components/GitChangesDemo.js";
import { init } from "./store.js";
import { startVersionWatch } from "./lib/version.js";
import { startUpdateWatch } from "./lib/update.js";

// The design previews each live on their own hash route (#run-hub, #git-changes). They're fully
// self-contained, mock-data prototypes — mounting one INSTEAD of the app means it never boots the store or
// WebSocket, so it cannot read or touch a single real task. Everything else loads the real console as before.
const demoRoute = (): "run-hub" | "git-changes" | null => {
  if (/^#\/?run-hub\b/.test(location.hash)) return "run-hub";
  if (/^#\/?git-changes\b/.test(location.hash)) return "git-changes";
  return null;
};
const initialDemo = demoRoute();

// Crossing a demo boundary swaps between entirely different mount paths (one boots the store, one doesn't),
// so a plain re-render can't switch cleanly — reload to re-run this entrypoint. Only fires when the active
// route actually changes, so ordinary in-app hash use (if any) is untouched.
window.addEventListener("hashchange", () => {
  if (demoRoute() !== initialDemo) location.reload();
});

const root = createRoot(document.getElementById("root")!);
if (initialDemo === "run-hub") {
  root.render(
    <StrictMode>
      <RunHubDemo />
    </StrictMode>,
  );
} else if (initialDemo === "git-changes") {
  root.render(
    <StrictMode>
      <GitChangesDemo />
    </StrictMode>,
  );
} else {
  void init();
  startVersionWatch();
  startUpdateWatch();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
