import { describe, expect, mock, test } from "bun:test";
import { createWebRunnerHandlers } from "../../src/main/rpc/web-runner-handlers";

function setup() {
  const received: { tabId: string; raw: unknown }[] = [];
  const ready: string[] = [];
  const exited: string[] = [];
  const deps = {
    webviews: {
      receive: mock((tabId: string, raw: unknown) => void received.push({ tabId, raw })),
      ready: mock((tabId: string) => void ready.push(tabId)),
      exit: mock((tabId: string) => void exited.push(tabId)),
    },
    log: mock(() => {}),
  };
  return { deps, received, ready, exited, handlers: createWebRunnerHandlers(deps) };
}

describe("web runner handlers", () => {
  test("webRunner.message routes a valid payload to the matching tab's webview", () => {
    const { handlers, received } = setup();
    const envelope = { seq: 1, message: { type: "ready" } };
    handlers.messages["webRunner.message"]({ tabId: "t1", raw: envelope });
    expect(received).toEqual([{ tabId: "t1", raw: envelope }]);
  });

  test("an invalid payload is logged and dropped, never routed", () => {
    const { handlers, deps, received } = setup();
    handlers.messages["webRunner.message"]({ tabId: "", raw: { seq: 1, message: {} } });
    expect(received).toEqual([]);
    expect(deps.log).toHaveBeenCalled();
  });

  /**
   * Task 9a moved this group onto `@jslab/rpc-schema`'s shared `tabId` rule. The hand-rolled parser it replaced
   * only checked "a non-empty string", so a tab id with path separators was routed happily -- harmless for the
   * map lookup it feeds today, but every other tabId payload in the app is held to the path-safe rule (spec §18)
   * precisely so no future consumer has to rediscover that this one wasn't.
   */
  test("a tab id that isn't path-safe is rejected, like every other tabId payload", () => {
    const { handlers, deps, received } = setup();
    handlers.messages["webRunner.message"]({ tabId: "../escape", raw: { seq: 1, message: {} } });
    expect(received).toEqual([]);
    expect(deps.log).toHaveBeenCalled();
  });

  test("webRunner.ready tells the source that tab's page is ready for script", () => {
    const { handlers, ready } = setup();
    handlers.messages["webRunner.ready"]({ tabId: "t1" });
    expect(ready).toEqual(["t1"]);
  });

  test("webRunner.exit tells the source that tab's webview is gone", () => {
    const { handlers, exited } = setup();
    handlers.messages["webRunner.exit"]({ tabId: "t1" });
    expect(exited).toEqual(["t1"]);
  });

  test("a malformed ready or exit is dropped, not routed", () => {
    const { handlers, deps, ready, exited } = setup();
    handlers.messages["webRunner.ready"]({ tabId: "" });
    handlers.messages["webRunner.exit"]({});
    expect(ready).toEqual([]);
    expect(exited).toEqual([]);
    expect(deps.log).toHaveBeenCalledTimes(2);
  });
});
