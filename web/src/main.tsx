import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.js";
import { RunHubDemo } from "./components/RunHubDemo.js";
import { init } from "./store.js";
import { startVersionWatch } from "./lib/version.js";
import { startUpdateWatch } from "./lib/update.js";

// The Run Hub design preview lives on its own hash route (#run-hub). It's a fully self-contained,
// mock-data prototype — mounting it INSTEAD of the app means it never boots the store or WebSocket, so
// it cannot read or touch a single real task. Everything else loads the real console exactly as before.
const runHubHash = (): boolean => /^#\/?run-hub\b/.test(location.hash);
const isRunHubDemo = runHubHash();

// Crossing the #run-hub boundary swaps between two entirely different mount paths (one boots the store,
// one doesn't), so a plain re-render can't switch cleanly — reload to re-run this entrypoint. Only fires
// when the boundary is actually crossed, so ordinary in-app hash use (if any) is untouched.
window.addEventListener("hashchange", () => {
  if (runHubHash() !== isRunHubDemo) location.reload();
});

const root = createRoot(document.getElementById("root")!);
if (isRunHubDemo) {
  root.render(
    <StrictMode>
      <RunHubDemo />
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
