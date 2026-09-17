import { describe, expect, test } from "bun:test";
import type { CommandId } from "@jslab/shared";
import { createUiDispatch } from "../../src/main/cli/ui-dispatch";

function setup(startOpen: boolean) {
  const sent: { command: CommandId; args?: unknown }[] = [];
  let opened = startOpen;
  let openCalls = 0;
  const dispatch = createUiDispatch({
    isOpen: () => opened,
    open: () => {
      opened = true;
      openCalls += 1;
    },
    send: (message) => sent.push(message),
  });
  return {
    dispatch,
    sent,
    openCalls: () => openCalls,
    close: () => (opened = false),
    reopen: () => (opened = true),
  };
}

describe("createUiDispatch", () => {
  test("holds a command until the view reports ready, then sends it once", () => {
    const { dispatch, sent } = setup(true);
    dispatch.dispatch("run.start");
    expect(sent).toEqual([]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("sends straight through once the view is ready", () => {
    const { dispatch, sent } = setup(true);
    dispatch.markReady();
    dispatch.dispatch("run.start");
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("reopens a closed window and delivers the command after it boots", () => {
    const { dispatch, sent, openCalls } = setup(false);
    dispatch.dispatch("run.start");
    expect(openCalls()).toBe(1);
    expect(sent).toEqual([]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("a closing window stops the ready state, so the next view's command queues again", () => {
    const { dispatch, sent, close, reopen } = setup(true);
    dispatch.markReady();
    close();
    dispatch.markClosed();
    // The reopen (Dock, or `e2e.reopen`) makes the window open again, but the view it builds has not reported ready
    // yet. Asserting only while the window is closed would pass with `markClosed` doing nothing at all, because
    // `isOpen()` alone already holds the command back -- it is this step that makes the stale ready flag visible.
    reopen();
    dispatch.dispatch("run.start");
    expect(sent).toEqual([]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("the queue is bounded, so a window that never boots can't grow it without limit", () => {
    const sent: { command: CommandId }[] = [];
    const dispatch = createUiDispatch({
      isOpen: () => true,
      open: () => {},
      send: (m) => sent.push(m),
      maxPending: 2,
    });
    for (let index = 0; index < 5; index++) dispatch.dispatch("run.start");
    dispatch.markReady();
    expect(sent).toHaveLength(2);
  });

  test("carries args when a command has them", () => {
    const { dispatch, sent } = setup(true);
    dispatch.markReady();
    dispatch.dispatch("theme.select", { themeId: "nord" });
    expect(sent).toEqual([{ command: "theme.select", args: { themeId: "nord" } }]);
  });
});
