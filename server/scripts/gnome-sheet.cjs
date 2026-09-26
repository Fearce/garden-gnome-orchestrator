// Renders every role gnome before (a git ref) and after (the working tree) side by side, so a change to
// web/src/components/Gnome.tsx can be judged by eye at chip size and zoomed in, with no instance to boot.
// It compiles the real component with esbuild and renders it with react-dom/server, so helpers and
// fragments render exactly as the console draws them.
// PRIOR-ART-OK: read-only preview; it writes only temp files and a PNG, and edits no text.
//
//   node scripts/gnome-sheet.cjs [--ref HEAD] [--bg #15171c] [--sizes 15,30,120] [--out <png>]
//
// Try --bg #f4f1ea for a light background. The PNG path is printed; nothing in the repo is written.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");
const { loadChromium } = require("./lab-harness.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const WEB = path.join(REPO, "web");
const ROLES = ["director", "planner", "researcher", "implementor", "qa", "reader", "reviewer", "coworker"];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Copy the `ref` version of Gnome.tsx next to the web modules it imports, so both versions compile alike. */
function stageOldGnome(work, ref) {
  for (const dir of ["components", "lib"]) fs.mkdirSync(path.join(work, "old", dir), { recursive: true });
  fs.writeFileSync(path.join(work, "old/components/Gnome.tsx"), execFileSync("git", ["show", `${ref}:web/src/components/Gnome.tsx`], { cwd: REPO }));
  fs.copyFileSync(path.join(WEB, "src/lib/format.ts"), path.join(work, "old/lib/format.ts"));
  fs.writeFileSync(path.join(work, "old/types.ts"), "export type GnomeRole = string;\n");
}

function renderRows(work, sizes) {
  const entry = path.join(work, "entry.tsx");
  fs.writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server";
import { Gnome as Old } from "./old/components/Gnome.tsx";
import { Gnome as New } from ${JSON.stringify(path.join(WEB, "src/components/Gnome.tsx"))};
const cell = (G: any, role: string) => ${JSON.stringify(sizes)}.map((s) => renderToStaticMarkup(<G role={role} size={s} />)).join(" ");
export const rows = ${JSON.stringify(ROLES)}.map((r) => "<tr><th>" + r + "</th><td>" + cell(Old, r) + "</td><td>" + cell(New, r) + "</td></tr>").join("");
`);
  const outfile = path.join(work, "bundle.cjs");
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, jsx: "automatic", nodePaths: [path.join(WEB, "node_modules")], logLevel: "error" });
  return require(outfile).rows;
}

(async () => {
  const ref = arg("ref", "HEAD");
  const bg = arg("bg", "#15171c");
  const sizes = arg("sizes", "15,30,120").split(",").map(Number);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gnome-sheet-"));
  const out = path.resolve(arg("out", path.join(work, "gnomes.png")));
  stageOldGnome(work, ref);
  const rows = renderRows(work, sizes);
  const vars = fs.readFileSync(path.join(WEB, "src/styles.css"), "utf8").match(/:root\s*\{[\s\S]*?\}/)[0];
  const html = path.join(work, "gnomes.html");
  fs.writeFileSync(html, `<!doctype html><style>${vars} body{background:${bg};color:#999;font:13px sans-serif;margin:16px} td{padding:6px 14px;vertical-align:bottom} th{text-align:left}</style><table><tr><th></th><th>${ref}</th><th>working tree</th></tr>${rows}</table>`);
  const browser = await loadChromium().launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(pathToFileURL(html).href);
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
