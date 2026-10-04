// Assemble dist/static: the connection screen, the app icon (the console's own favicon, so the two never
// drift) and the three Inter Tight weights the screen uses (bundled: the screen shows when no server is up).
const fs = require("node:fs");
const path = require("node:path");

const desktop = path.resolve(__dirname, "..");
const out = path.join(desktop, "dist", "static");
const fontFiles = path.join(desktop, "node_modules", "@fontsource", "inter-tight", "files");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });
for (const name of fs.readdirSync(path.join(desktop, "static"))) {
  fs.copyFileSync(path.join(desktop, "static", name), path.join(out, name));
}
fs.copyFileSync(path.join(desktop, "..", "web", "public", "gnome-mark.png"), path.join(out, "icon.png"));
for (const weight of [400, 500, 600]) {
  fs.copyFileSync(path.join(fontFiles, `inter-tight-latin-${weight}-normal.woff2`), path.join(out, "fonts", `inter-tight-${weight}.woff2`));
}
