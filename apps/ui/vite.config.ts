import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "../desktop/.hutch/devkit/api/config/electrobun-vite";

// The UI is built into the desktop app's dist folder; electrobun.config.ts copies it into views/mainview.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: electrobunViteAliases(resolve(import.meta.dirname, "../desktop/.hutch/devkit")) },
  root: "src",
  base: "./",
  worker: { format: "es" },
  build: {
    outDir: "../../desktop/dist/mainview",
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
