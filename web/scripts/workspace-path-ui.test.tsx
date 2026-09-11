/** UI gate for the clickable workspace chip: it must be a real button with the open affordance, it
 *  must keep the parent/leaf split the board scans by, clicking it must not fall through to the card
 *  underneath, and a refused open must surface as a notice rather than a dead click. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// base.ts resolves the app's mounted path at module load, and the store registers one visibility
// listener at import. Supply both DOM values this SSR gate needs before importing the component;
// effects never run during renderToStaticMarkup.
Object.defineProperty(globalThis, "document", {
  value: { baseURI: "http://localhost/", addEventListener: () => {} },
  configurable: true,
});
const { WorkspacePath, openWorkspace, splitWorkspace } = await import("../src/components/WorkspacePath.js");
const { useStore } = await import("../src/store.js");

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const WS = "C:\\Users\\Mikkel\\projects";

console.log("\nA. path split");
check("a Windows path splits into a dimmed parent and a bright leaf", JSON.stringify(splitWorkspace(WS)) === JSON.stringify({ parent: "C:\\Users\\Mikkel", leaf: "\\projects" }));
check("a POSIX path splits the same way", JSON.stringify(splitWorkspace("/home/mikkel/projects")) === JSON.stringify({ parent: "/home/mikkel", leaf: "/projects" }));
check("a trailing separator never produces an empty leaf", splitWorkspace(WS + "\\").leaf === "\\projects");
check("a bare drive root is all leaf", JSON.stringify(splitWorkspace("C:")) === JSON.stringify({ parent: "", leaf: "C:" }));

console.log("\nB. the chip on a board card");
const chip = renderToStaticMarkup(<WorkspacePath path={WS} />);
check("it renders as a button, so keyboard and screen readers get the action", chip.startsWith("<button") && chip.includes('type="button"'));
check("it keeps the ws-path class the card styling hangs on", chip.includes('class="ws-path"'));
check("the tooltip states the action and still shows the full path", chip.includes("Open in File Explorer") && chip.includes("C:\\Users\\Mikkel\\projects"));
check("it carries an accessible name naming the folder", chip.includes('aria-label="Open C:\\Users\\Mikkel\\projects in File Explorer"'));
check("the parent path is rendered dim and separate from the leaf", chip.includes('class="ws-parent">C:\\Users\\Mikkel</span>') && chip.includes('class="ws-leaf">\\projects</span>'));
check("the folder icon is decorative, not an extra stop for a screen reader", chip.includes('class="ws-ico"') && chip.includes('aria-hidden="true"'));

console.log("\nC. the detail-panel variant");
const meta = renderToStaticMarkup(<WorkspacePath path={WS} variant="meta" />);
check("the meta variant is the same button with the flatter class", meta.startsWith("<button") && meta.includes('class="ws-path ws-path-meta"'));
check("the meta variant offers the same action", meta.includes("Open in File Explorer"));

// Stubbed from here on: section D's click really does fire the reveal request, and against the real
// fetch it fails into nothing and lands its notice mid-section-E, under whichever assertion happens
// to be running when the connection finally gives up.
const requests: { url: string; body: unknown }[] = [];
const stubFetch = (status: number, payload: unknown) => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) as unknown });
    return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
  }) as typeof fetch;
};
stubFetch(200, { ok: true });

console.log("\nD. no click-through to the card");
// The board card is one big click target AND a dnd-kit drag source, so the chip has to swallow both
// events. renderToStaticMarkup drops handlers, so assert on the element the component itself builds
// (WorkspacePath is hook-free, so calling it directly is an ordinary function call).
const element = WorkspacePath({ path: WS }) as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>;
let armedDrag = true;
let openedPanel = true;
element.props.onPointerDown?.({ stopPropagation: () => (armedDrag = false) } as React.PointerEvent<HTMLButtonElement>);
element.props.onClick?.({ stopPropagation: () => (openedPanel = false) } as React.MouseEvent<HTMLButtonElement>);
check("pressing the chip does not arm the card's drag", !armedDrag);
check("clicking the chip does not also open the task detail panel", !openedPanel);

console.log("\nE. a refused open becomes a visible notice");
// Section D's click left one request in flight; drain it so its outcome can't be read as this one's.
await new Promise((resolve) => setTimeout(resolve, 0));
requests.length = 0;
useStore.setState({ notice: null });
await openWorkspace(WS);
check("a successful open posts the path to the reveal endpoint", requests.length === 1 && requests[0]!.url.endsWith("/api/fs/reveal") && JSON.stringify(requests[0]!.body) === JSON.stringify({ path: WS }));
check("a successful open shows no notice", useStore.getState().notice === null);

stubFetch(404, { error: "That folder no longer exists on this machine." });
await openWorkspace(WS);
const missingNotice = useStore.getState().notice;
check("a deleted workspace surfaces the server's reason", missingNotice?.message === "That folder no longer exists on this machine.");
check("the notice names the folder that failed", missingNotice?.title === "Couldn't open " + WS);
check("the notice is a warning, not silent info", missingNotice?.level === "warn");

useStore.setState({ notice: null });
globalThis.fetch = (async () => {
  throw new TypeError("network down");
}) as typeof fetch;
await openWorkspace(WS);
check("an unreachable server still tells the user the folder wasn't opened", (useStore.getState().notice?.message ?? "").includes("didn't answer"));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
