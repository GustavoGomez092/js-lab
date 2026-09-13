const bundles = [
  "bun build ../../packages/runner-bun/src/bootstrap.ts --target bun --outfile dist/runner/bootstrap.js",
  "bun build src/main/transform/transform-worker.ts --target bun --outfile dist/workers/transform-worker.js",
].join(" && ");

export default {
  packageManager: "bun",
  // M0-S1: pin Electrobun exactly; without this, `hutch electrobun sync` floats on the stable channel.
  electrobun: { version: "2.0.1" },
  scripts: {
    "build:ui": "bun run --cwd ../ui build",
    "build:bundles": bundles,
    dev: "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun dev",
    build:
      "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun build --env=canary",
  },
};
