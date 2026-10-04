import assert from "node:assert/strict";
import { test } from "node:test";
import { deepLinkFromArgv, isTicket, parseDeepLink } from "../deepLink";
import { classifyNavigation, classifyWindowOpen, isAppPage, permissionAllowed } from "../navigationPolicy";
import { consoleUrl, isLocalServer, isServerPage, normalizeServerUrl, redeemUrl } from "../serverUrl";
import { parseTitleBarStyle } from "../titleBarStyle";

const LOCAL = "http://127.0.0.1:4317/";
const MOUNTED = "https://example.com/orchestrator/";
const THREAD = "61111111-1111-4111-8111-111111111111";
const TICKET = "A".repeat(43);

test("server addresses are normalised to one base URL or refused", () => {
  assert.equal(normalizeServerUrl("127.0.0.1:4317"), LOCAL);
  assert.equal(normalizeServerUrl("  https://example.com/orchestrator?x=1#y "), MOUNTED);
  assert.equal(normalizeServerUrl("http://localhost:4317"), "http://localhost:4317/");
  assert.equal(normalizeServerUrl("http://alex:secret@example.com/"), null, "credentials never live in the address");
  assert.equal(normalizeServerUrl("file:///C:/"), null);
  assert.equal(normalizeServerUrl("javascript:alert(1)"), null);
  assert.equal(normalizeServerUrl(""), null);
});

test("only loopback counts as a server this app may start", () => {
  assert.equal(isLocalServer(LOCAL), true);
  assert.equal(isLocalServer("http://localhost:4317/"), true);
  assert.equal(isLocalServer("http://[::1]:4317/"), true);
  assert.equal(isLocalServer("http://192.0.2.10:4317/"), false);
  assert.equal(isLocalServer(MOUNTED), false);
});

test("a console page is same-origin and inside the mount", () => {
  assert.equal(isServerPage("https://example.com/orchestrator/api/me", MOUNTED), true);
  assert.equal(isServerPage("https://example.com/orchestrator-evil/", MOUNTED), false);
  assert.equal(isServerPage("https://example.com/", MOUNTED), false);
  assert.equal(isServerPage("https://example.com.evil.example/orchestrator/", MOUNTED), false);
  assert.equal(isServerPage("http://example.com/orchestrator/", MOUNTED), false, "a scheme downgrade is another origin");
  assert.equal(isServerPage("not a url", MOUNTED), false);
});

test("console and redeem links carry only a valid thread", () => {
  assert.equal(consoleUrl(MOUNTED, THREAD), `${MOUNTED}?thread=${THREAD}`);
  assert.equal(consoleUrl(MOUNTED, "x\"><script>"), MOUNTED);
  assert.equal(redeemUrl(MOUNTED, TICKET, THREAD), `${MOUNTED}api/desktop/redeem?ticket=${TICKET}&thread=${THREAD}`);
  assert.equal(redeemUrl(LOCAL, TICKET), `${LOCAL}api/desktop/redeem?ticket=${TICKET}`);
});

test("deep links are parsed strictly: one bad part drops the whole link", () => {
  assert.deepEqual(parseDeepLink(`ggo://open?thread=${THREAD}&ticket=${TICKET}`), { kind: "open", thread: THREAD, ticket: TICKET });
  assert.deepEqual(parseDeepLink("ggo://open"), { kind: "open", thread: null, ticket: null });
  assert.deepEqual(parseDeepLink(`ggo://auth?ticket=${TICKET}`), { kind: "auth", ticket: TICKET });
  assert.deepEqual(parseDeepLink(`ggo:///open/?thread=${THREAD}`), { kind: "open", thread: THREAD, ticket: null }, "Windows may pass a path-form link");
  assert.equal(parseDeepLink("ggo://auth"), null, "auth without a ticket means nothing");
  assert.equal(parseDeepLink("ggo://open?ticket=short"), null);
  assert.equal(parseDeepLink("ggo://open?thread=../../etc"), null);
  assert.equal(parseDeepLink("ggo://delete-everything"), null);
  assert.equal(parseDeepLink(`https://example.com/?ticket=${TICKET}`), null);
  assert.equal(parseDeepLink("::::"), null);
  assert.equal(isTicket(TICKET), true);
  assert.equal(isTicket(`${TICKET}=`), false);
  assert.equal(isTicket(42), false);
});

test("a launched link is found among the process arguments", () => {
  assert.equal(deepLinkFromArgv(["GG Orchestrator.exe", "--flag", "GGO://open"]), "GGO://open");
  assert.equal(deepLinkFromArgv(["electron.exe", "."]), null);
});

test("navigation stays on the console; everything else leaves for the browser or is refused", () => {
  assert.equal(classifyNavigation(`${LOCAL}?thread=${THREAD}`, LOCAL), "allow");
  assert.equal(classifyNavigation("ggo-app://shell/connect.html", LOCAL), "allow");
  assert.equal(classifyNavigation(`${LOCAL}api/auth/google`, LOCAL), "browser-sign-in");
  assert.equal(classifyNavigation(`${MOUNTED}api/auth/google?select=1`, MOUNTED), "browser-sign-in");
  assert.equal(classifyNavigation("https://accounts.google.com/o/oauth2/v2/auth", LOCAL), "external");
  assert.equal(classifyNavigation("mailto:alex@example.com", LOCAL), "external");
  assert.equal(classifyNavigation("file:///C:/Windows/", LOCAL), "deny");
  assert.equal(classifyNavigation("javascript:alert(1)", LOCAL), "deny");
  assert.equal(classifyNavigation("ggo-app://other/connect.html", LOCAL), "deny");
  assert.equal(isAppPage("ggo-app://shell/connect.html"), true);
  assert.equal(isAppPage(`${LOCAL}`), false);
});

test("new windows: console pages open as children, other web links externally, the rest nowhere", () => {
  assert.equal(classifyWindowOpen(`${LOCAL}api/deliverables/1/view`, LOCAL), "child");
  assert.equal(classifyWindowOpen("https://example.com/docs", LOCAL), "external");
  assert.equal(classifyWindowOpen("ms-settings:privacy", LOCAL), "deny");
  assert.equal(classifyWindowOpen("ggo-app://shell/connect.html", LOCAL), "deny");
});

test("only the console's own origin gets the three permissions it uses", () => {
  assert.equal(permissionAllowed("notifications", "http://127.0.0.1:4317/", LOCAL), true);
  assert.equal(permissionAllowed("clipboard-sanitized-write", "https://example.com", MOUNTED), true);
  assert.equal(permissionAllowed("fullscreen", "http://127.0.0.1:4317", LOCAL), true);
  assert.equal(permissionAllowed("media", "http://127.0.0.1:4317/", LOCAL), false);
  assert.equal(permissionAllowed("geolocation", "http://127.0.0.1:4317/", LOCAL), false);
  assert.equal(permissionAllowed("notifications", "https://example.net/", LOCAL), false);
});

test("the title bar takes only colours and a height the OS API accepts", () => {
  const style = { background: "rgb(21, 23, 31)", symbol: "#a6abb8", height: 52 };
  assert.deepEqual(parseTitleBarStyle(style), style);
  assert.equal(parseTitleBarStyle({ ...style, background: "oklch(0.2 0.01 264)" }), null);
  assert.equal(parseTitleBarStyle({ ...style, background: "rgb(256, 0, 0)" }), null);
  assert.equal(parseTitleBarStyle({ ...style, symbol: "red; injected" }), null);
  assert.equal(parseTitleBarStyle({ ...style, height: 400 }), null);
  assert.equal(parseTitleBarStyle({ ...style, height: 40.5 }), null);
  assert.equal(parseTitleBarStyle(null), null);
  assert.equal(parseTitleBarStyle("rgb(0, 0, 0)"), null);
});
