import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAppBundle, launchApp } from "../src/app";
import { isAlive } from "../src/process";
import { waitFor } from "../src/wait";

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

describe("launchApp teardown (FA-I2)", () => {
  test.skipIf(process.platform !== "darwin")(
    "a launch that never becomes ready kills its launcher, the launcher's children and the reported Main PID",
    async () => {
      // A stand-in app: its launcher records its own PID, leaves a child running, starts a "Main" that is reparented
      // away from the launcher (as the canary's self-extraction does) and reports its PID like Main does under
      // JSLAB_E2E=1. It never creates jslab.sock. The "Main" runs a copy of sleep from this launch's data folder.
      const appPath = join(root, "Fake.app");
      const launcher = join(appPath, "Contents", "MacOS", "launcher");
      mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
      // Canary teardown gap (item 4): launchApp now refuses to spawn an unextracted bundle, so this fake bundle
      // needs the self-extraction markers to stay a valid launch target for this pre-existing FA-I2 test.
      writeFileSync(join(appPath, "Contents", "MacOS", "bun"), "", { mode: 0o755 });
      writeFileSync(join(appPath, "Contents", "Resources", "main.js"), "");
      writeFileSync(
        launcher,
        [
          "#!/bin/sh",
          'UD="$JSLAB_USER_DATA"',
          'echo $$ > "$UD/launcher.pid"',
          'cp /bin/sleep "$UD/jl-main"',
          '( "$UD/jl-main" 30 & echo $! > "$UD/e2e-main.pid" )',
          "sleep 30 &",
          'echo $! > "$UD/child.pid"',
          "wait",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const userData = join(root, "ud");
      mkdirSync(userData);
      const pidFiles = ["launcher.pid", "child.pid", "e2e-main.pid"];
      const recorded = () =>
        pidFiles.flatMap((file) =>
          existsSync(join(userData, file)) ? [Number(readFileSync(join(userData, file), "utf8").trim())] : [],
        );

      const previousApp = process.env.JSLAB_E2E_APP;
      process.env.JSLAB_E2E_APP = appPath;
      try {
        await expect(launchApp({ userData, readyTimeoutMs: 1_000 })).rejects.toThrow("jslab.sock did not appear");
        expect(recorded()).toHaveLength(3);
        await waitFor(() => recorded().every((pid) => !isAlive(pid)) || null, {
          timeoutMs: 5_000,
          message: `launch processes survived: ${recorded().filter(isAlive).join(", ")}`,
        });
      } finally {
        if (previousApp === undefined) delete process.env.JSLAB_E2E_APP;
        else process.env.JSLAB_E2E_APP = previousApp;
        // Only the PIDs this test's own fake launch recorded.
        for (const pid of recorded()) {
          if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
        }
      }
    },
    20_000,
  );

  test.skipIf(process.platform !== "darwin")(
    "an unextracted bundle (no Contents/MacOS/bun or Contents/Resources/main.js) is refused before spawning (R-M2-FINAL-8 A)",
    async () => {
      // A canary copy that hasn't self-extracted yet is "only a launcher plus .tar.zst" (M0 report). If launched, the
      // self-extractor relaunches the real app outside the harness's process tree, so it can never be torn down.
      // launchApp must refuse before Bun.spawn, so nothing is ever started.
      const appPath = join(root, "Unextracted.app");
      const launcher = join(appPath, "Contents", "MacOS", "launcher");
      mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
      writeFileSync(
        launcher,
        ["#!/bin/sh", 'UD="$JSLAB_USER_DATA"', 'echo $$ > "$UD/launcher.pid"', "sleep 30", ""].join("\n"),
        { mode: 0o755 },
      );
      const userData = join(root, "ud-unextracted");
      mkdirSync(userData);

      const previousApp = process.env.JSLAB_E2E_APP;
      process.env.JSLAB_E2E_APP = appPath;
      try {
        await expect(launchApp({ userData, readyTimeoutMs: 1_000 })).rejects.toThrow(/hasn't self-extracted/);
        // Nothing was spawned: no launcher.pid was ever written.
        expect(existsSync(join(userData, "launcher.pid"))).toBe(false);
      } finally {
        if (previousApp === undefined) delete process.env.JSLAB_E2E_APP;
        else process.env.JSLAB_E2E_APP = previousApp;
      }
    },
    10_000,
  );
});
