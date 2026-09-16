import { expect, test } from "bun:test";
import { HandleTracker, handleCountAction, installHandleTracking } from "../src/handles";

// biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
function sandbox(): { tracker: HandleTracker; g: any } {
  const tracker = new HandleTracker(() => {});
  const g = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    fetch,
    WebSocket,
    Bun: { serve: Bun.serve },
  };
  installHandleTracking(tracker, g);
  return { tracker, g };
}

function webSocketServer() {
  return Bun.serve({
    port: 0,
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 })),
    websocket: { message: () => {} },
  });
}

test("a WebSocket is tracked from construction until it closes", async () => {
  const server = webSocketServer();
  try {
    const { tracker, g } = sandbox();
    const socket = new g.WebSocket(`ws://127.0.0.1:${server.port}/`);
    expect(socket).toBeInstanceOf(WebSocket);
    expect(tracker.count).toBe(1);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.close();
    await closed;
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("disposeAll closes tracked WebSockets", async () => {
  const server = webSocketServer();
  try {
    const { tracker, g } = sandbox();
    const socket = new g.WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    tracker.disposeAll();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("a WebSocket that fails to connect is no longer tracked", async () => {
  const { tracker, g } = sandbox();
  // Port 1 refuses connections, so the socket errors and closes without ever opening.
  const socket = new g.WebSocket("ws://127.0.0.1:1/");
  expect(tracker.count).toBe(1);
  await new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  expect(tracker.count).toBe(0);
});

test("a timeout is tracked until it fires", async () => {
  const { tracker, g } = sandbox();
  g.setTimeout(() => {}, 5);
  expect(tracker.count).toBe(1);
  await Bun.sleep(30);
  expect(tracker.count).toBe(0);
});

test("clearTimeout stops tracking", () => {
  const { tracker, g } = sandbox();
  const id = g.setTimeout(() => {}, 1000);
  g.clearTimeout(id);
  expect(tracker.count).toBe(0);
});

test("an interval is tracked until cleared", () => {
  const { tracker, g } = sandbox();
  const id = g.setInterval(() => {}, 1000);
  expect(tracker.count).toBe(1);
  g.clearInterval(id);
  expect(tracker.count).toBe(0);
});

test("disposeAll stops tracked intervals", async () => {
  const { tracker, g } = sandbox();
  let ticks = 0;
  g.setInterval(() => ticks++, 5);
  await Bun.sleep(30);
  tracker.disposeAll();
  const after = ticks;
  await Bun.sleep(30);
  expect(ticks).toBe(after);
  expect(tracker.count).toBe(0);
});

test("fetch is tracked until it settles", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(20);
      return new Response("ok");
    },
  });
  try {
    const { tracker, g } = sandbox();
    const pending = g.fetch(`http://localhost:${server.port}/`);
    expect(tracker.count).toBe(1);
    expect(await (await pending).text()).toBe("ok");
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("Bun.serve servers are tracked until stopped", () => {
  const { tracker, g } = sandbox();
  const server = g.Bun.serve({ port: 0, fetch: () => new Response("ok") });
  expect(tracker.count).toBe(1);
  server.stop(true);
  expect(tracker.count).toBe(0);
});

test("adding the same key twice counts once and notifies on change", () => {
  const counts: number[] = [];
  const tracker = new HandleTracker((count) => counts.push(count));
  const key = {};
  tracker.add(key, () => {});
  tracker.add(key, () => {});
  tracker.remove(key);
  expect(counts).toEqual([1, 0]);
});

test("a child process that fails to spawn is no longer tracked", async () => {
  const tracker = new HandleTracker(() => {});
  const g = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    fetch,
    Bun: { serve: Bun.serve },
  };
  installHandleTracking(tracker, g);

  let errorFired = false;
  // biome-ignore lint/suspicious/noExplicitAny: test variable
  let child: any;
  const errorPromise = new Promise<void>((resolve) => {
    // Accessing child_process through require like handles.ts does
    const cp = require("node:child_process");
    child = cp.spawn("jslab-definitely-missing-binary-xyz", []);
    child.once("error", () => {
      errorFired = true;
      resolve();
    });
  });

  // Verify the wrapper doesn't add an error listener (only user's listener)
  expect(child.listenerCount("error")).toBe(1);

  await errorPromise;
  expect(errorFired).toBe(true);
  await Bun.sleep(10);
  expect(tracker.count).toBe(0);
});

test("handleCountAction disposes new handles after a stop or a caught process.exit, and tracks idle/settled otherwise", () => {
  const cases: Array<[Parameters<typeof handleCountAction>[0], boolean, number, ReturnType<typeof handleCountAction>]> =
    [
      ["evaluating", true, 1, "dispose"],
      ["settled", true, 2, "dispose"],
      ["stopped", false, 1, "dispose"],
      ["evaluating", false, 1, null],
      ["settled", false, 0, "idle"],
      ["idle", false, 1, "settled"],
      ["stopped", false, 0, null],
      ["evaluating", true, 0, null],
    ];
  for (const [state, exiting, count, expected] of cases) {
    expect(handleCountAction(state, exiting, count)).toBe(expected);
  }
});
