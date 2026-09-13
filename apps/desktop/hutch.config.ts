const bundles = [
  "bun build ../../packages/runner-bun/src/bootstrap.ts --target bun --outfile dist/runner/bootstrap.js",
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
    dev: "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun dev",
    build:
      "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun build --env=canary",
  },
};
