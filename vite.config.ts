import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Only the frontend sources should trigger an HMR/reload. Critically: the IDE
// edits files in the OPEN WORKSPACE, which in dev is this very project — and a
// Vite reload on every save would blink the webview and drop the user's open
// file. So watch `./src` (+ html/config) and ignore everything else (workspace
// files, `src-tauri`, deps). The shipped app has no dev server, so this is a
// dev-only concern.
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const WATCH_KEEP = new Set([
  PROJECT_ROOT,
  path.join(PROJECT_ROOT, "index.html"),
  path.join(PROJECT_ROOT, "vite.config.ts"),
]);

function isIgnoredByWatcher(file: string): boolean {
  const p = path.resolve(file);
  if (WATCH_KEEP.has(p)) return false;
  if (p === SRC_DIR || p.startsWith(SRC_DIR + path.sep)) return false;
  return true;
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Tauri-tailored options, applied in `tauri dev` / `tauri build`.
  // 1. Don't let Vite obscure Rust errors.
  clearScreen: false,
  // 2. Tauri expects a fixed port and fails if it is unavailable.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. Watch only the frontend sources — never the open workspace's files
      //    (else the IDE's own saves would reload the webview). Covers the Rust
      //    side too, since `src-tauri` isn't under `./src`.
      ignored: isIgnoredByWatcher,
    },
  },
}));
