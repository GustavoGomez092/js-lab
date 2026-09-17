import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HostToWebMessage, RawRunEvent, WebToHostMessage } from "@jslab/rpc-schema";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

// A blob-URL dynamic import (the only portable way to run an ES module from a string in both a browser and Bun's
// module loader) always executes against the real global scope, not an object passed around as data - so, unlike
// handles.test.ts and host-bridge.test.ts, this file runs the bootstrap against the real `globalThis`.
//
// Fix round 1 (C1): `__jl` is installed non-configurable in production, matching the Bun runner exactly, so a run
// can never delete or replace it. That means `startRunnerWeb` can only be called ONCE against a given global for
// the lifetime of that object (a second `Object.defineProperty` on an already-non-configurable property throws) -
// exactly how a real page is only ever bootstrapped once, and how a real Bun runner process only ever installs
// `__jl` once before it exits. So this file creates exactly ONE instance in `beforeAll`, shared by every test, and
// resets *run* state between tests (via a "dispose" host message, which every test but the first sends first) -
// never the bootstrap instance itself. `addEventListener`/`removeEventListener` are replaced with a capturing spy
// once, for the same reason (Bun, unlike a browser, never actually dispatches "error"/"unhandledrejection" to the
// real one for a real uncaught exception - confirmed by hand before writing this file).

/** `map.get(key)`, creating and storing an empty set first if there wasn't one. */
function bucket<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

const g = globalThis as unknown as Record<string, unknown>;
const listeners = new Map<string, Set<(event: unknown) => void>>();
let sent: WebToHostMessage[] = [];
let outboundSeq = 0;

g.__electrobunSendToHost = (value: unknown) => sent.push((value as { message: WebToHostMessage }).message);
g.addEventListener = (type: string, cb: (event: unknown) => void) => {
  bucket(listeners, type).add(cb);
};
g.removeEventListener = (type: string, cb: (event: unknown) => void) => {
  listeners.get(type)?.delete(cb);
};

let handle: { dispose(): void };
beforeAll(() => {
  handle = startRunnerWeb({ global: g as unknown as RunnerWebGlobal, heartbeatMs: 20 });
});
afterAll(() => {
  handle.dispose();
  delete g.__electrobunSendToHost;
  delete g.addEventListener;
  delete g.removeEventListener;
});

const sendHost = (message: HostToWebMessage) =>
  (g.__jslabHostMessage as (m: unknown) => void)({ seq: ++outboundSeq, message });
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

/** Resets the shared instance's *run* state (idempotent, even before any run has ever started) and starts a fresh
 * one with a clean `sent` capture - every test but the first uses this instead of a fresh `startRunnerWeb` call. */
function beginRun(code: string, runId: string) {
  sendHost({ type: "dispose" });
  sent = [];
  sendHost({ type: "run", runId, code, settings: { maxEntries: 100 } });
}

// Fix round 2, NEW-2: this must stay the first test in the file. `sent[0]` is only the initial `ready` message
// while nothing has called `beginRun()` yet (every test below this one does, and `beginRun()` resets `sent`).
// bun:test runs a file's tests in declaration order, so this holds today; if that ever stopped being true, this
// assertion would fail loudly (sent[0] would be something else, or the array would be empty) rather than pass
// falsely, which is why no extra guard was added here.
test("reports ready and sends heartbeats", async () => {
  expect(sent[0]).toEqual({ type: "ready" });
  await until((m) => m.type === "heartbeat");
});

test("runs an entry, streams console output and results, and reaches idle", async () => {
  beginRun('console.log("hi", 1);\n__jl.log(2, 40 + 2);\nexport {};\n', "run-2");
  await until((m) => m.type === "state" && m.state === "idle");
  const evs = events();
  expect(evs.find((e) => e.kind === "console")).toMatchObject({
    level: "log",
    at: { line: 1 },
    args: [
      { t: "string", v: "hi" },
      { t: "number", v: "1" },
    ],
  });
  expect(evs.find((e) => e.kind === "result")).toMatchObject({ line: 2, value: { t: "number", v: "42" } });
});

test("reports a runtime error from window error and an unhandledrejection", async () => {
  beginRun('__jl.log(1, "start");\n', "run-3");
  await until((m) => m.type === "state" && m.state === "idle");
  dispatch("error", { error: new TypeError("boom") });
  dispatch("unhandledrejection", { reason: new RangeError("nope") });
  await until(
    (m) => m.type === "events" && m.events.some((e) => e.kind === "error" && e.phase === "unhandledRejection"),
  );
  const errors = events().filter((e) => e.kind === "error");
  expect(errors).toEqual([
    expect.objectContaining({ phase: "runtime", name: "TypeError", message: "boom" }),
    expect.objectContaining({ phase: "unhandledRejection", name: "RangeError", message: "nope" }),
  ]);
});

test("stop disposes active handles, and no output crosses the bridge afterwards", async () => {
  beginRun("setInterval(() => {}, 10);\n", "run-4");
  await until((m) => m.type === "state" && m.state === "settled");
  sendHost({ type: "stop" });
  await until((m) => m.type === "state" && m.state === "stopped");
  expect([...sent].reverse().find((m) => m.type === "state")).toMatchObject({ state: "stopped", activeHandles: 0 });
  const stoppedAt = sent.length;
  await Bun.sleep(80);
  expect(sent.slice(stoppedAt).filter((m) => m.type === "events")).toEqual([]);
});

test("answers expand requests for deep values", async () => {
  beginRun("__jl.log(1, { a: { b: { c: { d: 1 } } } });\n", "run-5");
  await until((m) => m.type === "state" && m.state === "idle");
  const handleId = /"t":"handle","handle":"(h\d+)"/.exec(JSON.stringify(events()))?.[1];
  expect(handleId).toBeDefined();
  sendHost({ type: "expand", reqId: 7, handleId: handleId ?? "" });
  await until((m) => m.type === "expanded");
  expect(sent.find((m) => m.type === "expanded")).toMatchObject({
    reqId: 7,
    value: { t: "object", props: [[{ k: "d" }, { t: "number", v: "1" }]] },
  });
});

// OU-02: the web runner's own hop, the mirror of the Bun runner's. Task B's `web-adapter.test.ts` addition pins
// the message Main puts on the webview transport; this pins that the page actually honours its `offset`.
test("an expand request's offset reaches the encoder, and each page agrees with the remainder it advertises", async () => {
  type ArrayPage = {
    items: [number, { t: string; v: string }][];
    length: number;
    from?: number;
    more?: number;
    next?: number;
  };
  /** A 12,000-entry array cannot fit one page, so its first page always carries both `more` and `next`. */
  type PagedArray = ArrayPage & { more: number; next: number };
  const TOTAL = 12_000;
  beginRun(`__jl.log(1, Array.from({ length: ${TOTAL} }, (_, i) => i));`, "run-10");
  await until((m) => m.type === "state" && m.state === "idle", 15_000);

  const eager = (events().find((e) => e.kind === "result") as unknown as { value: ArrayPage & { handle: string } })
    .value;
  expect(typeof eager.handle).toBe("string");
  expect(eager.length).toBe(TOTAL);

  const expandAt = async (reqId: number, offset?: number): Promise<ArrayPage> => {
    sendHost({ type: "expand", reqId, handleId: eager.handle, ...(offset === undefined ? {} : { offset }) });
    await until((m) => m.type === "expanded" && m.reqId === reqId, 15_000);
    const reply = sent.find((m) => m.type === "expanded" && m.reqId === reqId);
    return (reply as unknown as { value: ArrayPage }).value;
  };

  const first = (await expandAt(11)) as PagedArray;
  expect(first.from).toBeUndefined();
  expect(first.items[0]?.[0]).toBe(0);
  // The page and its advertised remainder must describe the same edge. The cast asserts nothing at runtime --
  // were `more`/`next` actually absent, these comparisons would be against NaN and fail.
  expect(first.items.at(-1)?.[0]).toBe(first.next - 1);
  expect(first.items.length).toBe(first.next);
  expect(first.items.length + first.more).toBe(TOTAL);

  const second = await expandAt(12, first.next);
  expect(second.from).toBe(first.next);
  expect(second.items[0]?.[0]).toBe(first.next);
  expect(second.items.at(-1)).toEqual([TOTAL - 1, { t: "number", v: String(TOTAL - 1) }]);
  expect(second.items.length + (second.more ?? 0)).toBe(TOTAL - (second.from ?? 0));
  expect(second.more).toBeUndefined();
});

// Fix round 1, I2: the expand registry must be scoped to the run, not to the bootstrap instance - a handle id
// captured in one run must never resolve in a later one.
test("a handle id from one run is not resolvable in a later run", async () => {
  beginRun("__jl.log(1, { a: { b: { c: { d: 1 } } } });\n", "run-6a");
  await until((m) => m.type === "state" && m.state === "idle");
  const staleHandleId = /"t":"handle","handle":"(h\d+)"/.exec(JSON.stringify(events()))?.[1];
  expect(staleHandleId).toBeDefined();

  beginRun("__jl.log(1, 1);\n", "run-6b");
  await until((m) => m.type === "state" && m.state === "idle");
  sendHost({ type: "expand", reqId: 9, handleId: staleHandleId ?? "" });
  await until((m) => m.type === "expanded");
  expect(sent.find((m) => m.type === "expanded")).toMatchObject({ reqId: 9, value: null });
});

// Fix round 1, C1 attack test: user code deleting the global `__jl` must throw (configurable: false), and
// auto-logging must keep working for the rest of the run afterward.
test("user code cannot delete or replace __jl, and auto-logging survives the attempt", async () => {
  beginRun(
    [
      "let deleteThrew = false;",
      "try { delete globalThis.__jl; } catch { deleteThrew = true; }",
      "let assignThrew = false;",
      'try { globalThis.__jl = { log: () => "pwned" }; } catch { assignThrew = true; }',
      "__jl.log(1, deleteThrew);",
      "__jl.log(2, assignThrew);",
      '__jl.log(3, "still reporting");',
      "export {};",
    ].join("\n"),
    "run-7",
  );
  await until((m) => m.type === "state" && m.state === "idle");
  const results = events().filter((e) => e.kind === "result");
  expect(results).toEqual([
    expect.objectContaining({ line: 1, value: { t: "boolean", v: true } }),
    expect.objectContaining({ line: 2, value: { t: "boolean", v: true } }),
    expect.objectContaining({ line: 3, value: { t: "string", v: "still reporting" } }),
  ]);
});

// Fix round 1, I3: the `.then()` rejection branch of watchPromise (the accepted Bun.peek divergence) had no test.
test("a rejected promise logged through __jl produces a promiseSettled event carrying the rejection", async () => {
  beginRun('__jl.log(1, Promise.reject(new Error("nope")));\nexport {};\n', "run-8");
  await until((m) => m.type === "events" && m.events.some((e) => e.kind === "promiseSettled"));
  const settled = events().find((e) => e.kind === "promiseSettled");
  expect(settled).toMatchObject({ value: { t: "error", name: "Error", message: "nope" } });
});

// Task 9d: `installConsole` returned nothing, so its `counts`, `timers` and group depth lived for the page's
// lifetime. That matters here precisely because of an invariant this milestone deliberately built: a webview host
// is never unmounted between runs (Task 8), so the page really does persist. An unmatched console.group() left
// every later run indented, and count/time labels carried across runs.
test("console group depth, counts and timers do not leak into the next run", async () => {
  beginRun('console.group("g");\nconsole.count("c");\nconsole.time("t");\nexport {};\n', "run-9a");
  await until((m) => m.type === "state" && m.state === "idle");

  beginRun('console.log("after");\nconsole.count("c");\nconsole.timeEnd("t");\nexport {};\n', "run-9b");
  await until((m) => m.type === "state" && m.state === "idle");
  const evs = events();
  // Not still indented by the previous run's unmatched group().
  expect(evs.find((e) => e.kind === "console" && e.level === "log")).toMatchObject({ groupDepth: 0 });
  // Counting restarts rather than continuing the previous run's tally.
  expect(evs.find((e) => e.kind === "console" && e.level === "count")).toMatchObject({
    args: [{ t: "string", v: "c: 1" }],
  });
  // The previous run's timer is gone, so ending it here reports the "does not exist" warning instead of a duration.
  expect(evs.find((e) => e.kind === "console" && e.level === "warn")).toMatchObject({
    args: [{ t: "string", v: "Timer 't' does not exist" }],
  });
});
