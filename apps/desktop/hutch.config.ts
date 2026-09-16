const bundles = [
  "bun build ../../packages/runner-bun/src/bootstrap.ts --target bun --outfile dist/runner/bootstrap.js",
  // M4 §5.12: the web runner, in the one form `executeJavascript` can evaluate -- a classic script, since that
  // call is not a module context. `--target browser` because it lands in a WKWebView page, not a Bun process.
  // Deliberately no `--format`: these scripts run inside Hutch's Cottontail shell (see the note above), whose
  // `build` command rejects the flag outright ("unsupported cottontail build option"). It isn't needed -- the
  // default browser output is self-contained, with no top-level `import`/`export` and no `import.meta`, which
  // `packages/runner-web/test/web-entry.test.ts` pins so a future dependency can't quietly reintroduce any.
  // `dist/runner` is already shipped by electrobun.config.ts's `"dist/runner": "runner"` rule.
  "bun build ../../packages/runner-web/src/web-entry.ts --target browser --outfile dist/runner/web-bootstrap.js",
  "bun build src/main/transform/transform-worker.ts --target bun --outfile dist/workers/transform-worker.js",
].join(" && ");

export default {
  packageManager: "bun",
  // M0-S1: pin Electrobun exactly; without this, `hutch electrobun sync` floats on the stable channel.
  electrobun: { version: "2.0.1" },
  scripts: {
    // R-M1-12: inside Hutch's Cottontail shell, `bun` resolves to Hutch's pinned Cottontail 0.5.0 runtime, not
    // real Bun -- Cottontail's `run`/`x` only resolve "installed entrypoints or Cottontail commands" and cannot
    // run a foreign package's `package.json` script or its `--cwd` flag (verified empirically: `bun run --cwd
    // ../ui build` and `bun x vite build` both fail with "not an installed entrypoint or Cottontail command").
    // `bunx` is a separate real-Bun binary (not shadowed by Cottontail), so it works unchanged.
    "build:ui": "cd ../ui && bunx vite build",
    "build:bundles": bundles,
    "build:dev":
      "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun build --env=dev",
    dev: "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun dev",
    build:
      "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun build --env=canary",
  },
};
