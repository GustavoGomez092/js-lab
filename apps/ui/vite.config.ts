import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { electrobunViteAliases } from "../desktop/.hutch/devkit/api/config/electrobun-vite";
import { jslabTypeLibs } from "./vite-plugins/type-libs-plugin";

// monaco-vim 0.4.2 does CommonJS deep imports (`monaco-editor/esm/vs/editor/editor.api` and
// `.../common/commands/shiftCommand`) that predate monaco-editor 0.56.0's package.json `exports` map. That map's
// `"./*": "./esm/vs/*.js"` wildcard doubles the `esm/vs` prefix for a request already spelled `esm/vs/...`, so
// Node/Vite can't resolve it through `exports` at all; alias the two literal specifiers straight to their files.
const monacoRoot = resolve(import.meta.dirname, "node_modules/monaco-editor/esm/vs");

// The runner-web page (packages/runner-web/index.html, spec §5.12) is the single on-disk source for the page a
// browser-mode tab's `<electrobun-webview>` loads. It lives outside this project's Vite `root` ("src"), and
// Vite's HTML output naming always uses the entry's path relative to `root` -- an entry outside `root` resolves
// to a relative path containing ".." and Rollup refuses to emit a file at that name. This plugin gives the page a
// virtual module id inside `root` (so the relative path Vite computes is clean, "runner-web/index.html") and
// serves the real file's on-disk content for it, so `packages/runner-web/index.html` stays the only copy.
const runnerWebSource = resolve(import.meta.dirname, "../../packages/runner-web/index.html");
const runnerWebEntry = resolve(import.meta.dirname, "src/runner-web/index.html");

function runnerWebEntryPlugin(): Plugin {
  return {
    name: "jslab-runner-web-entry",
    resolveId(id) {
      return id === runnerWebEntry ? id : null;
    },
    load(id) {
      return id === runnerWebEntry ? readFileSync(runnerWebSource, "utf8") : null;
    },
  };
}

// The UI is built into the desktop app's dist folder; electrobun.config.ts copies it into views/mainview.
export default defineConfig({
  plugins: [react(), jslabTypeLibs(), runnerWebEntryPlugin()],
  resolve: {
    alias: [
      ...electrobunViteAliases(resolve(import.meta.dirname, "../desktop/.hutch/devkit")),
      {
        find: /^monaco-editor\/esm\/vs\/editor\/editor\.api$/,
        replacement: resolve(monacoRoot, "editor/editor.api.js"),
      },
      {
        find: /^monaco-editor\/esm\/vs\/editor\/common\/commands\/shiftCommand$/,
        replacement: resolve(monacoRoot, "editor/common/commands/shiftCommand.js"),
      },
    ],
  },
  root: "src",
  base: "./",
  worker: { format: "es" },
  build: {
    outDir: "../../desktop/dist/mainview",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
        settings: resolve(import.meta.dirname, "src/settings.html"),
        "runner-web": runnerWebEntry,
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
