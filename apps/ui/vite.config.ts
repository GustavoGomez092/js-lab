import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "../desktop/.hutch/devkit/api/config/electrobun-vite";

// monaco-vim 0.4.2 does CommonJS deep imports (`monaco-editor/esm/vs/editor/editor.api` and
// `.../common/commands/shiftCommand`) that predate monaco-editor 0.56.0's package.json `exports` map. That map's
// `"./*": "./esm/vs/*.js"` wildcard doubles the `esm/vs` prefix for a request already spelled `esm/vs/...`, so
// Node/Vite can't resolve it through `exports` at all; alias the two literal specifiers straight to their files.
const monacoRoot = resolve(import.meta.dirname, "node_modules/monaco-editor/esm/vs");

// The UI is built into the desktop app's dist folder; electrobun.config.ts copies it into views/mainview.
export default defineConfig({
  plugins: [react()],
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
  },
  server: { port: 5173, strictPort: true },
});
