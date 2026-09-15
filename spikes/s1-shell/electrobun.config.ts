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
  // S5 spike: patch CFBundleDocumentTypes into the .app's Info.plist before
  // signing. Wired to both hooks (see scripts/patch-plist.ts for why):
  // `postBuild` patches the real, not-yet-compressed .app, which is what
  // actually matters on macOS; `postWrap` (docs: "after wrapper assembled,
  // before final packaging/signing") only reaches the self-extracting
  // installer stub by the time it fires, so it's kept as a harmless extra.
  scripts: {
    postBuild: "./scripts/patch-plist.ts",
    postWrap: "./scripts/patch-plist.ts",
  },
} satisfies ElectrobunConfig;
