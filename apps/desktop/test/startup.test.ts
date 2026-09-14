import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushBeforeQuit } from "../src/main/quit";
import { latestCorruptCopy, startupNotices } from "../src/main/startup-notices";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-startup-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startup notices (spec §20, final review M7 and I4)", () => {
  test("recovery, newer-version and skipped-tab notices say what happened", () => {
    writeFileSync(join(dir, "settings.corrupt-100.json"), "{");
    writeFileSync(join(dir, "settings.corrupt-200.json"), "{");
    expect(latestCorruptCopy(dir, "settings")).toBe("settings.corrupt-200.json");
    expect(latestCorruptCopy(dir, "session")).toBeNull();
    expect(
      startupNotices({
        settings: { recovered: "defaults", newerVersion: null },
        session: { recovered: "backup", newerVersion: 3, droppedTabs: ["x", "y"] },
        corruptCopies: { settings: "settings.corrupt-200.json", session: null },
      }),
    ).toEqual([
      {
        id: "settingsRecovered",
        message: "Settings were reset because the file was unreadable. A copy was saved as settings.corrupt-200.json",
      },
      {
        id: "sessionRecovered",
        message: "Your tabs were restored from the backup because session.json was unreadable.",
      },
      {
        id: "sessionNewer",
        message:
          "session.json was written by a newer version of JSLab (version 3). Tab changes in this window won't be saved to it.",
      },
      {
        id: "tabsDropped",
        message: "2 tabs in session.json couldn't be read and were skipped. Their buffer files were kept.",
      },
    ]);
    expect(
      startupNotices({
        settings: { recovered: "none", newerVersion: null },
        session: { recovered: "none", newerVersion: null, droppedTabs: [] },
        corruptCopies: { settings: null, session: null },
      }),
    ).toEqual([]);
  });
});

describe("flushBeforeQuit (final review T14)", () => {
  test("waits for the flush, logs a failure, and quits anyway after the timeout", async () => {
    const log = mock((_message: string, _detail?: unknown) => {});
    expect(await flushBeforeQuit(async () => {}, log)).toBe("flushed");
    expect(
      await flushBeforeQuit(async () => {
        throw new Error("disk full");
      }, log),
    ).toBe("failed");
    expect(log.mock.calls[0]?.[0]).toBe("session flush failed at quit");
    const started = Date.now();
    expect(await flushBeforeQuit(() => new Promise<void>(() => {}), log, 20)).toBe("timedOut");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log.mock.calls[1]?.[0]).toBe("session flush did not finish within 20 ms; quitting anyway");
  });
});
