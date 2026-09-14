import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAppBundle } from "../src/app";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jrepo-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findAppBundle", () => {
  test("prefers JSLAB_E2E_APP, then the single .app in the channel build folder", () => {
    expect(findAppBundle("canary", { JSLAB_E2E_APP: "/copies/JSLab-canary.app" }, root)).toBe(
      "/copies/JSLab-canary.app",
    );
    mkdirSync(join(root, "apps/desktop/build/dev-macos-arm64/JSLab-dev.app"), { recursive: true });
    expect(findAppBundle("dev", {}, root)).toBe(join(root, "apps/desktop/build/dev-macos-arm64/JSLab-dev.app"));
  });

  test("explains how to build when no bundle exists", () => {
    expect(() => findAppBundle("dev", {}, root)).toThrow(/hutch run build:dev/);
  });
});
