import type { ElectrobunConfig } from "electrobun";

export default {
  app: { name: "JSLab Spike", identifier: "dev.jslab.spike", version: "0.0.1" },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      runner: "runner",
      "webview-probe": "views/webview-probe",
      // Only src/bun/index.ts is bundled (to app/bun/index.js); Bun's bundler does not
      // emit `new Worker(new URL("./worker.ts", import.meta.url))` targets, so ship the
      // TS source beside the bundle for Bun to run directly.
      "src/bun/worker.ts": "bun/worker.ts",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
