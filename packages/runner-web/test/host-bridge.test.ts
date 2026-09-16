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

// Task 9d: `isHostToWeb` checked only that `message` was a non-null object -- its own comment called it "a cheap
// shape check only". So `{type: "run"}` with none of a run's fields was accepted, advanced `lastInboundSeq`, and
// then threw in the bootstrap the moment it read `message.settings.maxEntries`. Task 13's `const _never: never`
// guard cannot cover this: that is compile-time exhaustiveness over an already-typed union, while this payload
// crosses a JSON boundary untyped. The two defences are complementary.
test("a message whose fields are missing is rejected, and does not advance the sequence", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  g.__jslabHostMessage({ seq: 1, message: { type: "run" } }); // the exact payload from the finding
  // Had the malformed one been accepted it would have taken seq 1, and this genuine message would be dropped as a
  // duplicate -- so this asserts both halves at once: it was rejected, and the counter never moved.
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } });
  expect(received).toEqual([{ type: "stop" }]);
});

test("each variant is validated field by field, not just by its type tag", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  const rejected: unknown[] = [
    { type: "nonsense" },
    {},
    { type: "run", runId: 1, code: "x", settings: { maxEntries: 10 } }, // runId not a string
    { type: "run", runId: "r", code: "x", settings: {} }, // maxEntries missing
    { type: "run", runId: "r", code: "x" }, // settings missing
    { type: "run", runId: "r", code: "x", settings: { maxEntries: 10 }, muted: "yes" }, // muted not a boolean
    { type: "mute" }, // muted missing
    { type: "expand", reqId: "1", handleId: "h" }, // reqId not a number
    { type: "expand", reqId: 1 }, // handleId missing
    { type: "fetchChunk", id: 1 }, // data missing
    { type: "fetchHead", id: 1, status: 200, statusText: "OK", headers: "nope", url: "u" }, // headers not pairs
    { type: "fetchHead", id: 1, status: 200, statusText: "OK", headers: [["a"]], url: "u" }, // not a pair
    { type: "fetchError", id: 1 }, // message missing
    { type: "nodeResult" }, // id missing
    { type: "nodeError", id: 1, name: "Error" }, // message missing
    { type: "nodeStdout", id: 1 }, // data missing
    { type: "nodeExit", id: 1, code: "0", signal: null }, // code neither a number nor null
  ];
  for (const message of rejected) g.__jslabHostMessage({ seq: 1, message });
  expect(received).toEqual([]);
  // Not one of them moved the counter, so the genuine first message still arrives.
  g.__jslabHostMessage({ seq: 1, message: { type: "stop" } });
  expect(received).toEqual([{ type: "stop" }]);
});

// The other half of the contract: validation that rejects something legitimate would silently wedge a real run,
// so every variant the host actually sends must still get through untouched.
test("every well-formed variant is still accepted and delivered unchanged", () => {
  const { g } = sandbox();
  const received: HostToWebMessage[] = [];
  createHostBridge((message) => received.push(message), g);
  const accepted: HostToWebMessage[] = [
    { type: "run", runId: "r1", code: "1", settings: { maxEntries: 10 } },
    { type: "run", runId: "r2", code: "1", settings: { maxEntries: 10 }, muted: true },
    { type: "stop" },
    { type: "expand", reqId: 3, handleId: "h1" },
    { type: "dispose" },
    { type: "mute", muted: false },
    { type: "fetchHead", id: 1, status: 200, statusText: "OK", headers: [["a", "b"]], url: "https://example.test" },
    { type: "fetchChunk", id: 1, data: "abc" },
    { type: "fetchEnd", id: 1 },
    { type: "fetchError", id: 1, message: "boom" },
    // Task 11's bridged Node replies. Leaving these out of the validator did not surface as an error: Main ran the
    // call and sent the reply, the page rejected it as unrecognised, and because a rejected message must not
    // advance the sequence counter the promise never settled and every later host message was wedged out of
    // sequence. Measured end to end in a built app before the fix.
    { type: "nodeResult", id: 1, value: { ok: true } },
    { type: "nodeResult", id: 2, value: null },
    { type: "nodeError", id: 3, name: "Error", message: "boom" },
    { type: "nodeError", id: 4, name: "Error", message: "boom", code: "ENOENT" },
    { type: "nodeStdout", id: 5, data: "out" },
    { type: "nodeStderr", id: 6, data: "err" },
    { type: "nodeExit", id: 7, code: 0, signal: null },
    { type: "nodeExit", id: 8, code: null, signal: "SIGKILL" },
  ];
  for (const [i, message] of accepted.entries()) g.__jslabHostMessage({ seq: i + 1, message });
  expect(received).toEqual(accepted);
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
