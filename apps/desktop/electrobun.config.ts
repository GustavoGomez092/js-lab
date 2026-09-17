import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "JSLab",
    identifier: "dev.jslab.app",
    version: "0.0.1",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main/index.ts" },
    copy: {
      "dist/mainview": "views/mainview",
      "dist/mainview/runner-web": "views/runner-web",
      "dist/runner": "runner",
      "dist/workers": "workers",
      // Spec §16.1: the `jslab` binary ships at Resources/app/bin/jslab, which is what the install symlink points
      // at. `bun build --compile` runs from the repo root under real Bun (`bun run build:cli`) and stages the
      // binary here, because Hutch's Cottontail shell rejects build flags it doesn't know — see hutch.config.ts.
      "dist/bin": "bin",
      // Task 10 fix round 2 (B1): the `browser-node` polyfills vendor MIT/ISC/BSD-3-Clause third-party source
      // (packages/runner-web/src/polyfills/vendor/*.js) as text constants baked into Main's compiled output --
      // shipping the notices file in the repo is not what makes that a correct binary redistribution; it has to
      // land inside the bundle too. The key here is project(apps/desktop)-relative, matching every other entry
      // in this block and the type documentation's own contract ("Key is a project source path"); it used to
      // point at "../../THIRD-PARTY-NOTICES.md" directly (escaping the project root, the one path shape this
      // same config block rejects for every other path-ish field, with no way to confirm in this environment
      // whether that would error or silently skip -- the copy implementation isn't among Electrobun 2.0.1's
      // readable files). `hutch.config.ts`'s `build:bundles` now stages the real file into `dist/` first, so
      // this key never has to leave the project directory.
      "dist/THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
} satisfies ElectrobunConfig;
