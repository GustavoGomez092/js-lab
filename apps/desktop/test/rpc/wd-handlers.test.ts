import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, type TabState } from "@jslab/shared";
import { createWorkingDirectoryHandlers } from "../../src/main/rpc/wd-handlers";

function setup(options: { picked?: string | null; directories?: string[] } = {}) {
  const session = defaultSession(() => createTab({ id: "t1" }));
  const changed: { tabId: string; tab: TabState }[] = [];
  const calls: string[] = [];
  const deps = {
    session: {
      session,
      setWorkingDirectory: mock((tabId: string, path: string | null) => {
        const tab = session.tabs[tabId];
        if (!tab) return null;
        const next = { ...tab, workingDirectory: path };
        session.tabs[tabId] = next;
        return next;
      }),
    },
    pickFolder: mock(async (_options: { startingFolder: string }) => options.picked ?? null),
    isDirectory: async (path: string) => (options.directories ?? []).includes(path),
    documentsDir: "/docs",
    spares: {
      invalidate: mock((tabId: string) => void calls.push(`invalidate:${tabId}`)),
      setActiveTab: mock((tabId: string) => void calls.push(`warm:${tabId}`)),
    },
    types: { invalidate: mock(() => void calls.push("types")) },
    send: { changed: (payload: { tabId: string; tab: TabState }) => void changed.push(payload) },
    log: mock(() => {}),
  };
  return { deps, changed, calls, session, handlers: createWorkingDirectoryHandlers(deps) };
}

const settle = () => Bun.sleep(5);

describe("working directory handlers (spec §12.2)", () => {
  test("wd.pick sets a picked folder, recycles the tab's spare, invalidates types and reports the tab", async () => {
    const { handlers, deps, changed, calls } = setup({ picked: "/work/api", directories: ["/work/api"] });
    handlers.messages["wd.pick"]({ tabId: "t1" });
    await settle();
    expect(deps.pickFolder).toHaveBeenCalledWith({ startingFolder: "/docs" });
    expect(changed.map((entry) => [entry.tabId, entry.tab.workingDirectory])).toEqual([["t1", "/work/api"]]);
    expect(calls).toEqual(["invalidate:t1", "warm:t1", "types"]);
  });

  test("the picker starts in the tab's existing WD; a cancelled or non-directory pick changes nothing", async () => {
    const { handlers, deps, changed, session } = setup({ picked: "/not-a-dir", directories: ["/work/api"] });
    (session.tabs.t1 as TabState).workingDirectory = "/work/api";
    handlers.messages["wd.pick"]({ tabId: "t1" });
    await settle();
    expect(deps.pickFolder).toHaveBeenCalledWith({ startingFolder: "/work/api" });
    expect(deps.session.setWorkingDirectory).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
    handlers.messages["wd.pick"]({ tabId: "../x" });
    await settle();
    expect(deps.pickFolder).toHaveBeenCalledTimes(1);
  });

  test("wd.clear clears the WD and reports it", async () => {
    const { handlers, changed, session } = setup();
    (session.tabs.t1 as TabState).workingDirectory = "/work/api";
    handlers.messages["wd.clear"]({ tabId: "t1" });
    await settle();
    expect(changed.map((entry) => entry.tab.workingDirectory)).toEqual([null]);
  });
});
