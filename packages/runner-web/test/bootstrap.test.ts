import { afterEach, expect, test } from "bun:test";
import type { HostToWebMessage, RawRunEvent, WebToHostMessage } from "@jslab/rpc-schema";
import { startRunnerWeb } from "../src/bootstrap";

// A blob-URL dynamic import (the only portable way to run an ES module from a string in both a browser and Bun's
// module loader) always executes against the real global scope, not an object passed around as data - so, unlike
// handles.test.ts and host-bridge.test.ts, these tests run the bootstrap against the real `globalThis` and only
// stub the handful of properties that stand in for the host (`addEventListener` is replaced with a capturing spy
// because Bun, unlike a browser, never actually dispatches "error"/"unhandledrejection" to it for a real uncaught
// exception - confirmed by hand before writing this file). Everything is restored in `afterEach`.

/** `map.get(key)`, creating and storing an empty set first if there wasn't one. */
function bucket<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

const restore: Array<() => void> = [];
afterEach(() => {
  for (const fn of restore.splice(0)) fn();
});

function runner(heartbeatMs = 50) {
  const g = globalThis as unknown as Record<string, unknown>;
  const sent: WebToHostMessage[] = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  g.__electrobunSendToHost = (value: unknown) => sent.push((value as { message: WebToHostMessage }).message);
  g.addEventListener = (type: string, cb: (event: unknown) => void) => {
    bucket(listeners, type).add(cb);
  };
  g.removeEventListener = (type: string, cb: (event: unknown) => void) => {
    listeners.get(type)?.delete(cb);
  };

  // biome-ignore lint/suspicious/noExplicitAny: startRunnerWeb's option type is the real, wider RunnerWebGlobal
  const handle = startRunnerWeb({ global: g as any, heartbeatMs });
  restore.push(() => {
    handle.dispose();
    delete g.__electrobunSendToHost;
  });

  let seq = 0;
  const send = (message: HostToWebMessage) => (g.__jslabHostMessage as (m: unknown) => void)({ seq: ++seq, message });
  const dispatch = (type: string, event: unknown) => {
    for (const cb of listeners.get(type) ?? []) cb(event);
  };
  const until = async (predicate: (m: WebToHostMessage) => boolean, timeoutMs = 2000) => {
    const started = Date.now();
    while (!sent.some(predicate)) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out; received ${JSON.stringify(sent)}`);
      await Bun.sleep(2);
    }
  };
  const events = (): RawRunEvent[] => sent.flatMap((m) => (m.type === "events" ? m.events : []));
  const run = (code: string, runId = "run-1") => send({ type: "run", runId, code, settings: { maxEntries: 100 } });
  return { sent, send, dispatch, until, events, run };
}

test("reports ready and sends heartbeats", async () => {
  const r = runner(20);
  expect(r.sent[0]).toEqual({ type: "ready" });
  await r.until((m) => m.type === "heartbeat");
});

test("runs an entry, streams console output and results, and reaches idle", async () => {
  const r = runner();
  r.run('console.log("hi", 1);\n__jl.log(2, 40 + 2);\nexport {};\n');
  await r.until((m) => m.type === "state" && m.state === "idle");
  const events = r.events();
  expect(events.find((e) => e.kind === "console")).toMatchObject({
    level: "log",
    at: { line: 1 },
    args: [
      { t: "string", v: "hi" },
      { t: "number", v: "1" },
    ],
  });
  expect(events.find((e) => e.kind === "result")).toMatchObject({ line: 2, value: { t: "number", v: "42" } });
});

test("reports a runtime error from window error and an unhandledrejection", async () => {
  const r = runner();
  r.run('__jl.log(1, "start");\n');
  await r.until((m) => m.type === "state" && m.state === "idle");
  r.dispatch("error", { error: new TypeError("boom") });
  r.dispatch("unhandledrejection", { reason: new RangeError("nope") });
  await r.until(
    (m) => m.type === "events" && m.events.some((e) => e.kind === "error" && e.phase === "unhandledRejection"),
  );
  const errors = r.events().filter((e) => e.kind === "error");
  expect(errors).toEqual([
    expect.objectContaining({ phase: "runtime", name: "TypeError", message: "boom" }),
    expect.objectContaining({ phase: "unhandledRejection", name: "RangeError", message: "nope" }),
  ]);
});

test("stop disposes active handles, and no output crosses the bridge afterwards", async () => {
  const r = runner();
  r.run("setInterval(() => {}, 10);\n");
  await r.until((m) => m.type === "state" && m.state === "settled");
  r.send({ type: "stop" });
  await r.until((m) => m.type === "state" && m.state === "stopped");
  expect([...r.sent].reverse().find((m) => m.type === "state")).toMatchObject({ state: "stopped", activeHandles: 0 });
  const stoppedAt = r.sent.length;
  await Bun.sleep(80);
  expect(r.sent.slice(stoppedAt).filter((m) => m.type === "events")).toEqual([]);
});

test("answers expand requests for deep values", async () => {
  const r = runner();
  r.run("__jl.log(1, { a: { b: { c: { d: 1 } } } });\n");
  await r.until((m) => m.type === "state" && m.state === "idle");
  const handle = /"t":"handle","handle":"(h\d+)"/.exec(JSON.stringify(r.events()))?.[1];
  expect(handle).toBeDefined();
  r.send({ type: "expand", reqId: 7, handleId: handle ?? "" });
  await r.until((m) => m.type === "expanded");
  expect(r.sent.find((m) => m.type === "expanded")).toMatchObject({
    reqId: 7,
    value: { t: "object", props: [[{ k: "d" }, { t: "number", v: "1" }]] },
  });
});
