import { expect, test } from "bun:test";
import type { HostToWebMessage } from "@jslab/rpc-schema";
import { createHostBridge } from "../src/host-bridge";

// biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
function sandbox(): { g: any; sent: unknown[] } {
  const sent: unknown[] = [];
  const g = { __electrobunSendToHost: (value: unknown) => sent.push(value) };
  return { g, sent };
}

test("send wraps messages with a monotonically increasing sequence number", () => {
  const { g, sent } = sandbox();
  const bridge = createHostBridge(() => {}, g);
  bridge.send({ type: "ready" });
  bridge.send({ type: "heartbeat" });
  bridge.send({ type: "heartbeat" });
  expect(sent).toEqual([
    { seq: 1, message: { type: "ready" } },
    { seq: 2, message: { type: "heartbeat" } },
    { seq: 3, message: { type: "heartbeat" } },
  ]);
});

test("installs the inbound hook and delivers messages to the handler, in order", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } });
  g.__jslabHostMessage({ seq: 2, message: { type: "expand", reqId: 7, handleId: "h1" } });
  expect(received).toEqual([{ type: "stop" }, { type: "expand", reqId: 7, handleId: "h1" }]);
});

test("an inbound message whose sequence number does not increase is dropped (stale, duplicate or reordered)", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: 2, message: { type: "stop" } });
  g.__jslabHostMessage({ seq: 2, message: { type: "stop" } }); // duplicate delivery of the same call
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // arrived out of order
  expect(received).toEqual([{ type: "stop" }]);
});

test("a malformed inbound payload is ignored rather than throwing", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  expect(() => g.__jslabHostMessage(null)).not.toThrow();
  expect(() => g.__jslabHostMessage("not an object")).not.toThrow();
  expect(() => g.__jslabHostMessage({ message: { type: "stop" } })).not.toThrow(); // no seq
  expect(received).toEqual([]);
});

test("dispose removes the inbound hook", () => {
  const { g } = sandbox();
  const bridge = createHostBridge(() => {}, g);
  expect(typeof g.__jslabHostMessage).toBe("function");
  bridge.dispose();
  expect(g.__jslabHostMessage).toBeUndefined();
});
