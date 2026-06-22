import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Stamped into the bundle so the UI can show which build is live (spot a fresh deploy at a glance).
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
).version as string;
const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "nogit";
  }
})();
const buildTime = new Date().toISOString();

export default defineConfig({
  // Relative asset URLs so the built console works both at an origin root (the local deck's
  // https://localhost:4319/ iframe) AND under a path prefix when reverse-proxied through the
  // Zero-Trust deck (https://example.com/orchestrator/). API/WS urls are made
  // mount-aware separately in lib/base.ts (they live in JS, not asset tags).
  base: "./",
  plugins: [react()],
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
    emptyOutDir: true,
  },
});
