import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileOpened } from "@jslab/rpc-schema";
import { type CommandId, createTab, type TabState } from "@jslab/shared";
import { createOpenService } from "../../src/main/cli/open-service";
import { createUiDispatch } from "../../src/main/cli/ui-dispatch";
import { SessionStore } from "../../src/main/services/session-store";

/**
 * The CLI's `--run` gate spans three files that no per-file test sees together: `open-service.ts` decides which tab
 * the request is about, `index.ts` decides whether `file.opened` is pushed at all, and `ui-dispatch.ts` decides when
 * `run.start` reaches the view. Each is correct alone; the bug lived in the seam. So this suite wires the REAL
 * `SessionStore`, the REAL open service and the REAL dispatch together with `index.ts`'s own wiring, and asserts on
 * the one thing that decides what actually executes: the session's `activeTabId` at the moment `run.start` flushes.
 */

let dir = "";
let stores: SessionStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-cli-focus-"));
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((store) => store.flush()));
  await rm(dir, { recursive: true, force: true });
});

const openStore = async () => {
  const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t0" }), delayMs: 10 });
  stores.push(store);
  return store;
};

/**
 * `index.ts`'s wiring, reproduced literally: `announce` is skipped while the window is closed (index.ts:574),
 * `present` reopens the window and then queues `run.start` (index.ts:576-581), and the dispatch is the same
 * `createUiDispatch` the app builds at index.ts:240-244.
 */
function wire(session: SessionStore, files: Record<string, string>, windowOpen: boolean) {
  let isOpen = windowOpen;
  const events: string[] = [];
  const sent: { command: CommandId; args?: unknown }[] = [];
  const pushed: FileOpened[] = [];
  const renamed: { tabId: string; tab: TabState }[] = [];

  const cliDispatch = createUiDispatch({
    isOpen: () => isOpen,
    open: () => {
      isOpen = true;
    },
    send: (message) => {
      events.push(`send:${message.command}`);
      sent.push(message);
    },
  });

  const openTabs = createOpenService({
    session,
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    defaults: () => ({ language: "typescript", runtime: "bun" }),
    announce: (payload) => {
      // index.ts:574 -- a closed window gets no `file.opened`, so nothing carries `focusTabId` to the UI.
      if (isOpen) {
        events.push("file.opened");
        pushed.push(payload);
      }
    },
    updated: (payload) => {
      // index.ts -- guarded exactly like `file.opened`: a closed window gets no push and bootstraps from the
      // session it joins instead.
      if (isOpen) {
        events.push("tab.updated");
        renamed.push(payload);
      }
    },
    present: ({ run }) => {
      isOpen = true;
      if (run) {
        events.push("dispatch:run.start");
        cliDispatch.dispatch("run.start");
      }
    },
    log: () => {},
  });

  return { openTabs, cliDispatch, events, sent, pushed, renamed };
}

describe("the CLI --run gate across open-service, index wiring and ui-dispatch", () => {
  test("--run on an already-open file runs THAT tab, not whatever was active, with the window closed", async () => {
    const store = await openStore();
    const tabA = await store.createTab({ filePath: "/w/a.ts", content: "A" });
    const tabB = await store.createTab({ filePath: "/w/b.ts", content: "B" });
    // `createTab` activates, so the last tab created is the active one: the user is "on" tab B.
    expect(store.session.activeTabId).toBe(tabB.id);

    const w = wire(store, { "/w/a.ts": "A" }, false);
    expect(await w.openTabs({ files: ["/w/a.ts"], run: true })).toEqual({ tabIds: [tabA.id] });

    // The window was closed, so `file.opened` -- the only carrier of `focusTabId`, and the only thing the UI's
    // `handleOpened` honours (file-flows.ts:143) -- never went out.
    expect(w.pushed).toEqual([]);

    // `present()` reopened the window; the fresh view's first heartbeat flushes the queued command.
    w.cliDispatch.markReady();
    expect(w.sent).toEqual([{ command: "run.start" }]);

    // `run.start` executes the ACTIVE tab, so this is the assertion that decides whether the user's code or
    // somebody else's ran. Before the fix this was tab B: `jslab --run a.ts` silently ran b.ts.
    expect(store.session.activeTabId).toBe(tabA.id);
  });

  test("a mix of an already-open file and a new one activates the already-open one, matching the UI", async () => {
    const store = await openStore();
    const tabA = await store.createTab({ filePath: "/w/a.ts", content: "A" });

    const w = wire(store, { "/w/a.ts": "A", "/w/new.ts": "N" }, false);
    await w.openTabs({ files: ["/w/a.ts", "/w/new.ts"], run: true });

    // `handleOpened` activates the last CREATED tab and then `focusTabId`, so `focusTabId` is what the UI ends on
    // (file-flows.ts:142-143). Main must agree, or the closed-window run picks the other tab.
    w.cliDispatch.markReady();
    expect(w.sent).toEqual([{ command: "run.start" }]);
    expect(store.session.activeTabId).toBe(tabA.id);
  });

  test("with no already-open file, the newly created tab stays the one that runs", async () => {
    const store = await openStore();
    await store.createTab({ filePath: "/w/b.ts", content: "B" });

    const w = wire(store, { "/w/new.ts": "N" }, false);
    const { tabIds } = await w.openTabs({ files: ["/w/new.ts"], run: true });
    expect(tabIds).toHaveLength(1);
    const [newTabId] = tabIds as [string];

    w.cliDispatch.markReady();
    expect(store.session.activeTabId).toBe(newTabId);
  });

  test("the window-open path still pushes file.opened before the queued run command", async () => {
    const store = await openStore();
    const tabA = await store.createTab({ filePath: "/w/a.ts", content: "A" });
    await store.createTab({ filePath: "/w/b.ts", content: "B" });

    const w = wire(store, { "/w/a.ts": "A" }, true);
    w.cliDispatch.markReady(); // an open window whose view has already reported ready

    await w.openTabs({ files: ["/w/a.ts"], run: true });

    // The ordering the review asked be left undisturbed: the UI learns which tab to focus BEFORE it is told to run.
    expect(w.events).toEqual(["file.opened", "dispatch:run.start", "send:run.start"]);
    expect(w.pushed[0]?.focusTabId).toBe(tabA.id);
    expect(store.session.activeTabId).toBe(tabA.id);
  });

  test("--title on an already-open file renames it in the REAL session AND tells the UI (M5c F3)", async () => {
    const store = await openStore();
    const tabA = await store.createTab({ filePath: "/w/a.ts", content: "A" });
    expect(store.session.tabs[tabA.id]?.title).not.toBe("renamed-by-cli");

    const w = wire(store, { "/w/a.ts": "A" }, true);
    await w.openTabs({ files: ["/w/a.ts"], title: "renamed-by-cli" });

    // The real `SessionStore.patchTab` applied the rename...
    expect(store.session.tabs[tabA.id]).toMatchObject({ title: "renamed-by-cli", titleIsCustom: true });
    // ...and `file.opened` cannot be what tells the UI: an already-open file creates no tab, so it announces none.
    expect(w.pushed[0]?.tabs).toEqual([]);
    // `tab.updated` is the only carrier, and it goes out before the announcement.
    expect(w.events).toEqual(["tab.updated", "file.opened"]);
    expect(w.renamed).toEqual([
      { tabId: tabA.id, tab: expect.objectContaining({ title: "renamed-by-cli", titleIsCustom: true }) },
    ]);
  });
});
