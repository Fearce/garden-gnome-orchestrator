// @ts-check
"use strict";

/**
 * The connection screen. Every action goes through `window.ggoConnect` (desktop/src/preload.ts); the
 * main process owns the state and pushes a fresh view whenever it changes.
 *
 * @typedef {import("../src/contract").ConnectionView} ConnectionView
 * @typedef {{ label: string, run: () => unknown, primary?: boolean }} Action
 */

/** @type {any} */
const api = /** @type {any} */ (window).ggoConnect;

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {ConnectionView | null} */
let view = null;
let ticker = 0;

/** @param {ConnectionView} v */
function canStart(v) {
  return v.local && !!v.checkout && v.checkoutPort === null && v.nodeFound && !v.conflict;
}

/** This address on the port the checkout's server is configured for. @param {ConnectionView} v @param {number} port */
function onPort(v, port) {
  const url = new URL(v.server);
  url.port = String(port);
  return url.href;
}

/** @param {ConnectionView} v @returns {{ title: string, lead: string, progress: boolean, actions: Action[], note: string }} */
function describe(v) {
  const host = new URL(v.server).host;
  const start = { label: "Start GGO", primary: true, run: () => api.startServer() };
  const retry = { label: "Try again", run: () => api.retry() };
  const choose = { label: "Choose GGO folder…", run: () => api.chooseCheckout() };
  const startNote = "A server started here keeps running after you close this window, so your agents keep working.";
  switch (v.phase) {
    case "connecting":
      return { title: "Connecting", lead: `Looking for GGO at ${host}.`, progress: true, actions: [], note: "" };
    case "starting":
      return {
        title: "Starting GGO",
        lead: `Waiting for the server to answer — ${elapsed(v.since)}.`,
        progress: true,
        actions: v.logPath ? [{ label: "Open server log", run: () => api.openLog() }] : [],
        note: startNote,
      };
    case "browser-sign-in":
      return {
        title: "Finish signing in in your browser",
        lead: "GGO opens here as soon as Google sign-in completes. Your browser may ask to open GG Orchestrator.",
        progress: true,
        actions: [{ label: "Back to sign-in", run: () => api.back() }],
        note: "",
      };
    case "crashed":
      return { title: "This window stopped", lead: "Your tasks are unaffected; they run on the server.", progress: false, actions: [{ label: "Reload", primary: true, run: () => api.retry() }], note: "" };
    case "lost":
    case "offline": {
      const lost = v.phase === "lost";
      const title = lost ? "Lost the connection" : v.local ? "GGO isn't running" : "Can't reach GGO";
      const lead = lost
        ? "Reconnecting on its own — you'll land back where you were."
        : v.local
          ? `Nothing is answering at ${host}.`
          : `Nothing is answering at ${host}. Check the address and that the server is up.`;
      /** @type {Action[]} */
      const actions = [];
      let note = "";
      if (canStart(v)) {
        actions.push(start);
        note = startNote;
      } else if (v.local && !v.conflict && v.checkout && v.checkoutPort !== null) {
        const port = v.checkoutPort;
        actions.push({ label: `Use port ${port}`, primary: true, run: () => api.setServer(onPort(v, port)) });
        note = `Your GGO folder is set to port ${port} (PORT in server/.env), so a server started from it would never answer at ${host}.`;
      } else if (v.local && !v.conflict && !v.checkout) {
        actions.push(choose);
        note = "Choose your GG Orchestrator folder so this app can start it, or run npm run serve in it yourself.";
      } else if (v.local && !v.conflict && !v.nodeFound) {
        note = "Install Node.js 22 or newer so this app can start GGO, or run npm run serve in your GGO folder.";
      }
      actions.push(retry);
      return { title, lead, progress: false, actions, note };
    }
    default:
      return { title: "GG Orchestrator", lead: "", progress: false, actions: [], note: "" };
  }
}

/** @param {number} since */
function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** @param {ConnectionView} v */
function render(v) {
  view = v;
  const d = describe(v);
  el("title").textContent = d.title;
  el("lead").textContent = d.lead;
  el("progress").hidden = !d.progress;
  el("detail").hidden = !v.detail;
  el("detail").textContent = v.detail ?? "";
  el("note").hidden = !d.note;
  el("note").textContent = d.note;
  el("server-url").textContent = v.server;
  const actions = el("actions");
  actions.replaceChildren(
    ...d.actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.primary ? "btn primary" : "btn";
      button.textContent = action.label;
      button.addEventListener("click", () => void action.run());
      return button;
    }),
  );
  if (v.retryAt) {
    const countdown = document.createElement("span");
    countdown.className = "retry";
    countdown.id = "retry";
    actions.append(countdown);
  }
  tick();
}

/** Refresh the clocks (retry countdown, starting timer) without rebuilding the buttons. */
function tick() {
  if (!view) return;
  const countdown = document.getElementById("retry");
  if (countdown && view.retryAt) {
    const seconds = Math.max(0, Math.ceil((view.retryAt - Date.now()) / 1000));
    countdown.textContent = seconds > 0 ? `Trying again in ${seconds}s` : "Trying again…";
  }
  if (view.phase === "starting") el("lead").textContent = describe(view).lead;
}

function wireServerForm() {
  const form = /** @type {HTMLFormElement} */ (el("server-form"));
  const input = /** @type {HTMLInputElement} */ (el("server-input"));
  const error = el("server-error");
  const toggle = (/** @type {boolean} */ editing) => {
    form.hidden = !editing;
    el("server-row").hidden = editing;
    error.hidden = true;
    if (editing) {
      input.value = view ? view.server : "";
      input.focus();
      input.select();
    }
  };
  el("change-server").addEventListener("click", () => toggle(true));
  el("cancel-server").addEventListener("click", () => toggle(false));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.setServer(input.value);
    if (result && result.ok) return toggle(false);
    error.textContent = (result && result.error) || "That address didn't work.";
    error.hidden = false;
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggle(false);
  });
}

wireServerForm();
api.onView(render);
void api.state().then((/** @type {ConnectionView | null} */ v) => v && render(v));
ticker = window.setInterval(tick, 500);
window.addEventListener("beforeunload", () => window.clearInterval(ticker));
