/**
 * The measurement drivers for the §23 budgets this harness covers.
 *
 * Discipline every driver here follows:
 * - warm up before measuring, so a cold JIT or a cold filesystem cache is never what gets reported;
 * - return a distribution (the raw samples) and let `core.ts` take percentiles, never a single sample;
 * - run strictly sequentially (`main.ts` awaits each in turn) -- two timing drivers in flight would measure
 *   contention instead of the thing;
 * - use the app's real machinery (the real worker host, the real spare pool, a real Bun runner, the real bundler
 *   and the real on-disk vendor cache) rather than a stand-in, so the number describes the app and not the harness.
 *
 * A driver whose prerequisites are missing returns `{ skip }` rather than a number.
 */

import { existsSync } from "node:fs";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunEvent } from "@jslab/rpc-schema";
import { type TransformOptions, transform } from "@jslab/transform";
import { bundleAppForWeb, bundleVendorForWeb, joinVendorAndApp } from "../src/main/bundling/bundler";
import { hashBunLock, VendorCache, vendorCacheKey } from "../src/main/bundling/vendor-cache";
import { BunRunnerProcess } from "../src/main/runs/bun-runner-process";
import { RunCoordinator } from "../src/main/runs/run-coordinator";
import { SparePool } from "../src/main/runs/spare-pool";
import { WorkerTransformHost } from "../src/main/transform/transform-host";

const NL = String.fromCharCode(10);
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export type DriverResult = { samples: number[] } | { skip: string };

/** A TS file of `lines` lines with no imports: half declarations, half expression statements (what Auto Log logs). */
export function tsFixture(lines: number): string {
  const out: string[] = [`let acc = 0;`];
  for (let i = 0; out.length < lines - 1; i++) {
    out.push(i % 2 === 0 ? `const v${i}: number = ${i} + 1;` : `acc += v${i - 1};`);
  }
  out.push(`acc;`);
  return out.slice(0, lines).join(NL);
}

function runnerEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" };
}

/**
 * Transform 500-line TS, through a real transform worker, warm.
 *
 * The source is varied per sample so nothing downstream can serve a cached answer; the worker itself is reused
 * across samples, which is exactly what "warm worker" means.
 */
export async function measureTransform(): Promise<DriverResult> {
  const host = new WorkerTransformHost();
  try {
    const base = tsFixture(500);
    const options: TransformOptions = {
      language: "typescript",
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      logpoints: [],
    };
    for (let i = 0; i < 25; i++) await host.transform(`${base}${NL}const warm${i} = ${i};`, options);
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const source = `${base}${NL}const s${i} = ${i};`;
      const started = performance.now();
      const result = await host.transform(source, options);
      samples.push(performance.now() - started);
      if (!result.ok) return { skip: `the transform failed: ${JSON.stringify(result.diagnostics).slice(0, 200)}` };
    }
    return { samples };
  } finally {
    host.dispose();
  }
}

/**
 * How long the replacement spare takes to become ready after one is taken.
 *
 * `SparePool.take()` re-warms the active tab's spare itself; the factory below times that replacement's own
 * `BunRunnerProcess.start()`, from spawn to the runner's `ready` IPC message.
 */
export async function measureSpare(): Promise<DriverResult> {
  let bootstrap: string;
  try {
    bootstrap = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);
  } catch (error) {
    return { skip: `the Bun runner bootstrap could not be resolved: ${String(error).slice(0, 120)}` };
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-bench-spare-")));
  const startDurations: number[] = [];
  const pool = new SparePool(
    async (config) => {
      const started = performance.now();
      const runner = await BunRunnerProcess.start(config);
      startDurations.push(performance.now() - started);
      return runner;
    },
    () => ({ bunPath: process.execPath, bootstrapPath: bootstrap, cwd: dir, env: runnerEnv() }),
  );
  try {
    // Warm-up: the very first spawn on a machine pays for page cache and code signing checks the rest do not.
    pool.setActiveTab("t1");
    for (let i = 0; i < 3; i++) {
      const warm = await pool.take("t1");
      warm.kill();
      await Bun.sleep(300);
    }
    startDurations.length = 0;
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const taken = await pool.take("t1");
      const before = startDurations.length;
      // take() kicked off the replacement; wait for that spawn to report ready, then read its own duration.
      const deadline = Date.now() + 10_000;
      while (startDurations.length === before && Date.now() < deadline) await Bun.sleep(2);
      taken.kill();
      const measured = startDurations[startDurations.length - 1];
      if (startDurations.length === before || measured === undefined) {
        return { skip: "the spare pool did not re-warm within 10 s" };
      }
      samples.push(measured);
      await Bun.sleep(50);
    }
    return { samples };
  } finally {
    pool.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Keystroke -> first result, Main-side: RunCoordinator.start() until the first `result` event. */
export async function measureKeystroke(): Promise<DriverResult> {
  let bootstrap: string;
  try {
    bootstrap = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);
  } catch (error) {
    return { skip: `the Bun runner bootstrap could not be resolved: ${String(error).slice(0, 120)}` };
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-bench-keystroke-")));
  const spares = new SparePool(
    (config) => BunRunnerProcess.start(config),
    () => ({ bunPath: process.execPath, bootstrapPath: bootstrap, cwd: dir, env: runnerEnv() }),
  );
  let firstResultAt: number | null = null;
  const coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares,
    runsDir: join(dir, "runs"),
    settings: () => ({
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      maxEntries: 1000,
      unresponsiveTimeoutMs: 5000,
    }),
    onEvents: (_tabId: string, _runId: string, events: RunEvent[]) => {
      if (firstResultAt === null && events.some((event) => event.kind === "result")) {
        firstResultAt = performance.now();
      }
    },
    onState: () => {},
    onDiagnostics: () => {},
    runLock: { add: () => {}, remove: () => {} },
  });
  try {
    spares.setActiveTab("t1");
    await Bun.sleep(800);
    const samples: number[] = [];
    // 3 warm-up runs, then 25 measured. A pause between runs lets the pool finish re-warming, as a user editing
    // would: without it this would measure spare-starvation rather than the edit-to-result path.
    for (let i = 0; i < 28; i++) {
      firstResultAt = null;
      const code = `${tsFixture(49)}${NL}const marker${i} = ${i};`;
      const started = performance.now();
      coordinator.start({ tabId: "t1", code, language: "typescript", logpoints: [] });
      const deadline = Date.now() + 15_000;
      while (firstResultAt === null && Date.now() < deadline) await Bun.sleep(1);
      if (firstResultAt === null) return { skip: "a run produced no result event within 15 s" };
      if (i >= 3) samples.push(firstResultAt - started);
      await Bun.sleep(400);
    }
    return { samples };
  } finally {
    coordinator.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Builds a real, self-contained `node_modules` holding React.
 *
 * A copy is necessary, not incidental: `resolveBareSpecifier` requires `realpath(resolved)` to sit inside
 * `dirname(packagesNodeModules)/node_modules`, and this repo installs with Bun's isolated linker, where every
 * package in a workspace's `node_modules` is a symlink into a shared store outside it. Pointing the bundler at
 * `apps/ui/node_modules` therefore fails to resolve react at all (measured). React's own store directory holds
 * react, react-dom and scheduler side by side, which is exactly the shape a real packages folder has, so it is
 * copied with symlinks dereferenced.
 */
async function buildReactPackages(): Promise<{ dir: string } | { skip: string }> {
  let reactDomRoot: string;
  try {
    reactDomRoot = await realpath(Bun.resolveSync("react-dom", join(REPO_ROOT, "apps", "ui")));
  } catch (error) {
    return { skip: `react-dom is not installed in apps/ui: ${String(error).slice(0, 120)}` };
  }
  // .../node_modules/react-dom/<entry file> -> the node_modules holding react-dom and its siblings.
  let storeNodeModules = dirname(reactDomRoot);
  while (storeNodeModules !== dirname(storeNodeModules) && !storeNodeModules.endsWith("node_modules")) {
    storeNodeModules = dirname(storeNodeModules);
  }
  if (!storeNodeModules.endsWith("node_modules") || !existsSync(join(storeNodeModules, "react"))) {
    return { skip: `could not locate a node_modules holding react beside react-dom (looked at ${storeNodeModules})` };
  }
  const base = await realpath(await mkdtemp(join(tmpdir(), "jslab-bench-pkgs-")));
  const dir = join(base, "node_modules");
  await cp(storeNodeModules, dir, { recursive: true, dereference: true });
  return { dir };
}

/**
 * A browser-runtime re-run whose React vendor chunk is already cached: transform + app bundle + a real vendor
 * cache disk read + join, which is all of the Main-side work such a re-run does.
 */
export async function measureBrowserRerun(): Promise<DriverResult> {
  const packages = await buildReactPackages();
  if ("skip" in packages) return packages;
  const work = await realpath(await mkdtemp(join(tmpdir(), "jslab-bench-web-")));
  const cache = new VendorCache({ cacheDir: join(work, "vendor-cache") });
  const entry = join(work, "entry.js");
  const source = (n: number) =>
    [`import React from "react";`, `const el = React.createElement("div", null, "${n}");`, `el;`].join(NL);

  try {
    await writeFile(entry, source(0));
    const app = await bundleAppForWeb({
      entry,
      runtime: "browser",
      workingDirectory: null,
      packagesNodeModules: packages.dir,
      dataDir: work,
    });
    if ("error" in app) return { skip: `the app bundle failed: ${app.error.message.slice(0, 160)}` };

    // Populate the cache once, exactly as web-adapter.ts does, so the measured runs are genuine cache hits.
    const lockText = await Bun.file(join(REPO_ROOT, "bun.lock")).text();
    const key = vendorCacheKey(hashBunLock(lockText), app.imports, "browser", null);
    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser",
      workingDirectory: null,
      packagesNodeModules: packages.dir,
      dataDir: work,
    });
    if ("error" in vendor) return { skip: `the vendor bundle failed: ${vendor.error.message.slice(0, 160)}` };
    await cache.set(key, { code: vendor.code, map: vendor.map }, vendor.closure);
    if ((await cache.get(key)) === null) return { skip: "the vendor chunk did not survive a cache round trip" };

    const options: TransformOptions = {
      language: "typescript",
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      logpoints: [],
    };
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const code = source(i);
      const started = performance.now();
      const transformed = transform(code, options);
      if (!transformed.ok) return { skip: "the transform failed" };
      await writeFile(entry, transformed.code);
      const rebuilt = await bundleAppForWeb({
        entry,
        runtime: "browser",
        workingDirectory: null,
        packagesNodeModules: packages.dir,
        dataDir: work,
      });
      if ("error" in rebuilt) return { skip: `a re-run app bundle failed: ${rebuilt.error.message.slice(0, 160)}` };
      const cached = await cache.get(key);
      if (cached === null) return { skip: "the vendor cache missed on a re-run" };
      joinVendorAndApp(cached.code, rebuilt.code);
      const elapsed = performance.now() - started;
      // The first 5 are warm-up (cold page cache for a 1 MB chunk); the rest are measured.
      if (i >= 5) samples.push(elapsed);
    }
    return { samples };
  } finally {
    await cache.waitIdle();
    await rm(work, { recursive: true, force: true });
    await rm(dirname(packages.dir), { recursive: true, force: true });
  }
}

export const DRIVERS: Record<string, () => Promise<DriverResult>> = {
  transform: measureTransform,
  spare: measureSpare,
  keystroke: measureKeystroke,
  browserRerun: measureBrowserRerun,
};
