import { describe, expect, mock, test } from "bun:test";
import { flushBeforeQuit } from "../src/main/quit";
import { startupNotices } from "../src/main/startup-notices";
import { strings } from "../src/main/strings";

describe("startup notices (spec §20, final review M7 and I4)", () => {
  test("recovery, newer-version and skipped-tab notices say what happened", () => {
    expect(
      startupNotices({
        settings: {
          recovered: "defaults",
          newerVersion: null,
          primary: "corrupt",
          corruptCopy: "settings.corrupt-200.json",
        },
        session: {
          recovered: "backup",
          newerVersion: 3,
          droppedTabs: ["x", "y"],
          primary: "corrupt",
          corruptCopy: null,
        },
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
        settings: { recovered: "none", newerVersion: null, primary: "ok", corruptCopy: null },
        session: { recovered: "none", newerVersion: null, droppedTabs: [], primary: "missing", corruptCopy: null },
      }),
    ).toEqual([]);
  });

  test("a missing file restored from its backup says it was missing; a corrupt one names this launch's copy (FA-m4)", () => {
    expect(
      startupNotices({
        settings: { recovered: "backup", newerVersion: null, primary: "missing", corruptCopy: null },
        session: {
          recovered: "backup",
          newerVersion: null,
          droppedTabs: [],
          primary: "corrupt",
          corruptCopy: "session.corrupt-5.json",
        },
      }),
    ).toEqual([
      { id: "settingsRecovered", message: "Settings were restored from the backup because settings.json was missing." },
      {
        id: "sessionRecovered",
        message:
          "Your tabs were restored from the backup because session.json was unreadable. A copy was saved as session.corrupt-5.json",
      },
    ]);
    expect(
      startupNotices({
        settings: { recovered: "none", newerVersion: null, primary: "ok", corruptCopy: null },
        session: { recovered: "backup", newerVersion: null, droppedTabs: [], primary: "missing", corruptCopy: null },
      }),
    ).toEqual([
      { id: "sessionRecovered", message: "Your tabs were restored from the backup because session.json was missing." },
    ]);
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
    expect(log.mock.calls[0]?.[0]).toBe(strings.log.quitFlushFailed);
    const started = Date.now();
    expect(await flushBeforeQuit(() => new Promise<void>(() => {}), log, 20)).toBe("timedOut");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log.mock.calls[1]?.[0]).toBe(strings.log.quitFlushTimedOut(20));
  });
});
