import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSystemFonts, SystemFontsService } from "../../src/main/platform/system-fonts";
import { createFontHandlers } from "../../src/main/rpc/font-handlers";

const PROFILER_OUTPUT = JSON.stringify({
  SPFontsDataType: [
    {
      _name: "SFNSMono.ttf",
      typefaces: [
        { family: "SF Mono", fixed_pitch: "yes" },
        { family: "SF Mono", fixed_pitch: "yes" },
      ],
    },
    { _name: "Avenir.ttc", typefaces: [{ family: "Avenir", fixed_pitch: "no" }] },
    { _name: "Monaco.ttf", typefaces: [{ family: "Monaco", fixed_pitch: true }] },
    { _name: "IBMPlexMono-Regular.ttf", typefaces: [{ family: "IBM Plex Mono" }] },
    { _name: ".SFNS.ttf", typefaces: [{ family: ".SF NS" }] },
    { _name: "Helvetica Neue.ttc" },
  ],
});

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-fonts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("system fonts", () => {
  test("parses families, detects monospace fonts and drops hidden faces", () => {
    expect(parseSystemFonts(PROFILER_OUTPUT)).toEqual({
      monospace: ["IBM Plex Mono", "Monaco", "SF Mono"],
      other: ["Avenir", "Helvetica Neue"],
    });
    expect(parseSystemFonts("{not json")).toEqual({ monospace: [], other: [] });
  });

  test("a fresh cache is served without running system_profiler", async () => {
    const cacheFile = join(dir, "cache", "system-fonts.json");
    const run = mock(async () => PROFILER_OUTPUT);
    const service = new SystemFontsService({ cacheFile, run, now: () => 1000, log: () => {} });
    await service.refresh();
    const fresh = new SystemFontsService({ cacheFile, run, now: () => 2000, log: () => {} });
    expect(await fresh.list()).toEqual({ fonts: parseSystemFonts(PROFILER_OUTPUT), refreshing: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("stale or missing caches refresh in the background; failures keep the old list; refreshes are shared", async () => {
    const cacheFile = join(dir, "cache", "system-fonts.json");
    await Bun.write(cacheFile, JSON.stringify({ at: 0, fonts: { monospace: ["Old Mono"], other: [] } }));
    let release: (value: string) => void = () => {};
    const run = mock(() => new Promise<string>((resolve) => (release = resolve)));
    const log = mock(() => {});
    const service = new SystemFontsService({ cacheFile, run, now: () => 8 * 24 * 3600 * 1000, log });
    expect(await service.list()).toEqual({ fonts: { monospace: ["Old Mono"], other: [] }, refreshing: true });
    const again = service.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    release(PROFILER_OUTPUT);
    expect((await again)?.monospace).toContain("SF Mono");
    expect(JSON.parse(await readFile(cacheFile, "utf8")).fonts.other).toEqual(["Avenir", "Helvetica Neue"]);

    const failing = new SystemFontsService({
      cacheFile,
      run: async () => {
        throw new Error("system_profiler timed out");
      },
      now: () => 99 * 24 * 3600 * 1000,
      log,
    });
    expect(await failing.refresh()).toBeNull();
    expect((await failing.list()).fonts?.monospace).toContain("SF Mono");
    // list() started another background refresh for the stale cache. Await that shared promise, so nothing logs
    // after afterEach removes the folder (review M8).
    expect(await failing.refresh()).toBeNull();
    expect(log).toHaveBeenCalled();

    const missing = new SystemFontsService({
      cacheFile: join(dir, "none.json"),
      run: async () => PROFILER_OUTPUT,
      log,
    });
    expect(await missing.list()).toEqual({ fonts: null, refreshing: true });
    // Await the refresh list() started, so its cache write lands before cleanup.
    expect((await missing.refresh())?.monospace).toContain("SF Mono");
  });

  test("fonts.list answers from the service", async () => {
    await writeFile(join(dir, "c.json"), JSON.stringify({ at: 5, fonts: { monospace: ["A Mono"], other: ["B"] } }));
    const service = new SystemFontsService({
      cacheFile: join(dir, "c.json"),
      run: async () => "{}",
      now: () => 6,
      log: () => {},
    });
    const handlers = createFontHandlers({ fonts: service, log: () => {} });
    expect(await handlers.requests["fonts.list"]({})).toEqual({
      fonts: { monospace: ["A Mono"], other: ["B"] },
      refreshing: false,
    });
  });
});
