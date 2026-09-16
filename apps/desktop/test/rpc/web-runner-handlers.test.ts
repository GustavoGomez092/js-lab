import { describe, expect, mock, test } from "bun:test";
import { createWebRunnerHandlers } from "../../src/main/rpc/web-runner-handlers";

function setup() {
  const received: { tabId: string; raw: unknown }[] = [];
  const deps = {
    webviews: { receive: mock((tabId: string, raw: unknown) => void received.push({ tabId, raw })) },
    log: mock(() => {}),
  };
  return { deps, received, handlers: createWebRunnerHandlers(deps) };
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
});
