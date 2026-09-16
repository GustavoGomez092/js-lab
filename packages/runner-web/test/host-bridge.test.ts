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

test("a duplicate or an out-of-order (lower) sequence number is dropped", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // accepted: the successor of 0
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // duplicate: not the successor of 1
  g.__jslabHostMessage({ seq: 2, message: { type: "stop" } }); // accepted: the successor of 1
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // stale/reordered: not the successor of 2
  expect(received).toEqual([{ type: "stop" }, { type: "stop" }]);
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

test("dispose stops delivering further inbound messages, but the hook itself stays installed", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  const bridge = createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } });
  bridge.dispose();
  expect(typeof g.__jslabHostMessage).toBe("function"); // fix round 2, NEW-1: non-configurable, never removed
  g.__jslabHostMessage({ seq: 2, message: { type: "stop" } }); // delivered to the hook, but a no-op after dispose
  expect(received).toEqual([{ type: "stop" }]);
});

// Fix round 1, I1: `typeof seq === "number"` alone let NaN and ±Infinity through the guard.
test("rejects a NaN or an Infinite sequence number", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: Number.NaN, message: { type: "stop" } });
  g.__jslabHostMessage({ seq: Number.POSITIVE_INFINITY, message: { type: "stop" } });
  g.__jslabHostMessage({ seq: Number.NEGATIVE_INFINITY, message: { type: "stop" } });
  expect(received).toEqual([]);
});

test("rejects a negative, zero, or non-integer sequence number", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: -1, message: { type: "stop" } });
  g.__jslabHostMessage({ seq: 0, message: { type: "stop" } });
  g.__jslabHostMessage({ seq: 1.5, message: { type: "stop" } });
  expect(received).toEqual([]);
});

// The important case: a NaN passes `x <= lastInboundSeq` for every later x (every comparison against NaN is
// false), so if it were ever accepted as `lastInboundSeq`, replay protection would be permanently disabled. A
// rejected NaN must leave `lastInboundSeq` untouched, so a genuine duplicate right after it is still caught.
test("a rejected NaN attempt does not disable replay protection: a genuine duplicate is still rejected afterward", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: Number.NaN, message: { type: "stop" } }); // rejected, must not become lastInboundSeq
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // accepted
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // duplicate: must still be rejected
  expect(received).toEqual([{ type: "stop" }]);
});

// Fix round 2, NEW-1: I1's ">" rule still let a legal-but-wrong seq (Number.MAX_SAFE_INTEGER is a real, safe
// integer, unlike NaN/Infinity) jump `lastInboundSeq` arbitrarily far ahead, after which every real message would
// compare `<=` and be dropped forever. The fix requires the exact successor, so a huge value is rejected the same
// way a duplicate is, and — the critical property — rejecting it must not move the counter at all.
test("a huge-but-legal sequence number is rejected and leaves the counter untouched, so the genuine next message still arrives", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  // Distinct message shapes, not two "stop"s: under the old ">" rule the forged message is wrongly *accepted* as
  // message 1 (any positive number is greater than 0) and the genuine one is then wrongly *rejected* as message 2
  // (1 <= Number.MAX_SAFE_INTEGER) — same final array length, different content, so this must check content.
  g.__jslabHostMessage({ seq: Number.MAX_SAFE_INTEGER, message: { type: "stop" } }); // forged: not the successor of 0
  g.__jslabHostMessage({ seq: 1, message: { type: "expand", reqId: 1, handleId: "h1" } }); // genuine: seq 1
  expect(received).toEqual([{ type: "expand", reqId: 1, handleId: "h1" }]);
});

test("a gap in the sequence (skipping a number) is rejected", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } }); // accepted
  g.__jslabHostMessage({ seq: 3, message: { type: "stop" } }); // gap: skips 2, not the successor of 1
  expect(received).toEqual([{ type: "stop" }]); // only the first
});

test("the entry point cannot be reassigned or deleted by page code", () => {
  const { g } = sandbox();
  createHostBridge(() => {}, g);
  expect(() => {
    g.__jslabHostMessage = () => {};
  }).toThrow();
  expect(() => {
    delete g.__jslabHostMessage;
  }).toThrow();
});
