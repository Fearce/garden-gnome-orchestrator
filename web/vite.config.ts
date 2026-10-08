import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Stamped into the bundle so the UI can show which build is live (spot a fresh deploy at a glance).
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
).version as string;
const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "nogit";
  }
})();
const buildTime = new Date().toISOString();
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
let compressionTargets: string[] = [];

export default defineConfig({
  // Relative asset URLs so the built console works both at an origin root (the local
  // https://localhost:4319/ iframe) AND under a path prefix when reverse-proxied behind a
  // hostname (e.g. https://example.com/orchestrator/). API/WS urls are made
  // mount-aware separately in lib/base.ts (they live in JS, not asset tags).
  base: "./",
  plugins: [react(), {
    name: "precompress-web-assets",
    apply: "build",
    writeBundle(options, bundle) {
      compressionTargets = Object.values(bundle)
        .filter((file) => /\.(?:js|css|html|svg|json)$/.test(file.fileName))
        .map((file) => resolve(options.dir!, file.fileName));
    },
    async closeBundle() {
      // Compress once at build time, never on the server's request/event loop. Include lazy chunks
      // and workers too; fonts/images already have their own compression. Four jobs bound build RAM.
      // Vite finalizes HTML after the bundle hooks. Read the emitted files once those hooks finish,
      // otherwise compressed HTML can retain the previous build's asset hash.
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let target; (target = compressionTargets[next++]);) {
          const bytes = readFileSync(target);
          if (bytes.length < 1024) {
            await Promise.all([rm(target + ".br", { force: true }), rm(target + ".gz", { force: true })]);
            continue;
          }
          const [br, gz] = await Promise.all([
            brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
            gzipAsync(bytes, { level: 6 }),
          ]);
          await Promise.all([
            br.length < bytes.length ? writeFile(target + ".br", br) : rm(target + ".br", { force: true }),
            gz.length < bytes.length ? writeFile(target + ".gz", gz) : rm(target + ".gz", { force: true }),
          ]);
        }
      }));
    },
  }],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD_SHA__: JSON.stringify(gitSha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  server: {
    port: 4318,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4317", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // Production serves this directory during rebuilds. Keep the previous entry and hashed
    // chunks available if a build is interrupted, and for clients still using the old entry.
    // Disposable lab builds explicitly opt into --emptyOutDir instead.
    emptyOutDir: false,
  },
});
