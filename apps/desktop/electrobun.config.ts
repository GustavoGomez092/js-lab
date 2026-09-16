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
      // Task 10 fix round 1 (I3): the `browser-node` polyfills vendor MIT/ISC/BSD-3-Clause third-party source
      // (packages/runner-web/src/polyfills/vendor/*.js) as text constants baked into Main's compiled output --
      // shipping the notices file in the repo is not what makes that a correct binary redistribution; it has to
      // land inside the bundle too. Not verified against an actual packaged build (out of scope: no app builds
      // for this task) -- if Electrobun's `copy` step does not accept a source path outside `apps/desktop`,
      // this needs a build-scoped copy of the file instead; flagging in the report.
      "../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
} satisfies ElectrobunConfig;
