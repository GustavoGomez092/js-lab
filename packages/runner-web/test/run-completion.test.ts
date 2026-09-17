import { expect, test } from "bun:test";
import type { WebToHostMessage } from "@jslab/rpc-schema";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

/**
 * Task 9b: a run must ALWAYS reach a terminal state, even when reporting its failure is itself what fails.
 *
 * This is the shape of the bug that blocked M4. `packages/serializer`'s `jsonBytes` used Node's `Buffer`, which a
 * webview does not have, so the first `console.log` of every browser-mode run threw `ReferenceError` inside the
 * user's own code. That rejected `startRun`'s `await import(blobURL)` -- and then `pushError`, encoding the
 * rejection, threw the *same* error again, propagating out of `startRun` before it could send `settled`/`idle`.
 * The host saw `evaluating`, then nothing: no events, no error, no terminal state, forever. The `Buffer` cause is
 * fixed at its root, but "the error reporter threw" must never again be able to lose the terminal state, because
 * that is what turned a loud, ordinary runtime error into an invisible hang.
 *
 * A fake global is enough: the thrown value comes from the imported module itself, so nothing here needs the run's
 * console or the real global scope.
 */
function fakeGlobal(sent: WebToHostMessage[]): RunnerWebGlobal {
  return {
    setTimeout: setTimeout as unknown as RunnerWebGlobal["setTimeout"],
    clearTimeout: clearTimeout as unknown as RunnerWebGlobal["clearTimeout"],
    setInterval: (() => 0) as unknown as RunnerWebGlobal["setInterval"],
    clearInterval: (() => {}) as unknown as RunnerWebGlobal["clearInterval"],
    addEventListener: () => {},
    removeEventListener: () => {},
    console: {},
    fetch: (() => Promise.reject(new Error("unused"))) as unknown as RunnerWebGlobal["fetch"],
    __electrobunSendToHost: (value: unknown) => sent.push((value as { message: WebToHostMessage }).message),
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in global, exactly as handles.test.ts builds one
  } as any;
}

async function runToCompletion(code: string): Promise<WebToHostMessage[]> {
  const sent: WebToHostMessage[] = [];
  const g = fakeGlobal(sent);
  const handle = startRunnerWeb({ global: g, heartbeatMs: 10_000 });
  try {
    (g.__jslabHostMessage as (m: unknown) => void)({
      seq: 1,
      message: { type: "run", runId: "run-1", code, settings: { maxEntries: 100 } },
    });
    const deadline = Date.now() + 2000;
    while (!sent.some((m) => m.type === "state" && m.state !== "evaluating")) {
      if (Date.now() > deadline) throw new Error(`no terminal state; received ${JSON.stringify(sent)}`);
      await Bun.sleep(2);
    }
    return sent;
  } finally {
    handle.dispose();
  }
}

test("a run whose code throws still reaches a terminal state", async () => {
  const sent = await runToCompletion('throw new Error("plain boom");\n');
  expect(sent.filter((m) => m.type === "state").at(-1)).toMatchObject({ state: "idle" });
});

/**
 * The load-bearing case. `pushError` reads `error.stack` to build its event, so a value whose `stack` getter throws
 * makes the error reporter itself throw -- reproducing, without depending on `Buffer`, exactly the failure mode that
 * swallowed the terminal state. Before the fix this test hangs at `evaluating` and times out above.
 */
test("a run still reaches a terminal state when reporting its own failure throws", async () => {
  const sent = await runToCompletion(
    'const e = new Error("hostile");\nObject.defineProperty(e, "stack", { get() { throw new Error("stack is hostile"); } });\nthrow e;\n',
  );
  expect(sent.filter((m) => m.type === "state").at(-1)).toMatchObject({ state: "idle" });
});

test("an ordinary run that completes reports idle", async () => {
  const sent = await runToCompletion("globalThis.__jslabRunCompletionProbe = 1;\n");
  expect(sent.filter((m) => m.type === "state").at(-1)).toMatchObject({ state: "idle" });
});

/**
 * Final review, finding B. `startRun` wraps its own `pushError` call in a try/catch with a last-resort event, but
 * the global `error` / `unhandledrejection` listeners called it bare. `pushError` reads `error.stack` and encodes
 * the value, and both can throw on a hostile one -- so the listener itself threw, and the error was never pushed,
 * never flushed and never reported. This is the same family as the shipped `jsonBytes`/`Buffer` defect the tests
 * above pin: an error path that throws while reporting an error.
 *
 * `fakeGlobal`'s `addEventListener` is a no-op, so the listener path is unreachable through it -- this fixture
 * records the listeners and dispatches to them the way a page's event loop would.
 */
function listenerGlobal(sent: WebToHostMessage[]): {
  g: RunnerWebGlobal;
  dispatch(type: string, event: unknown): void;
} {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const g = {
    ...(fakeGlobal(sent) as unknown as Record<string, unknown>),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: () => {},
  } as unknown as RunnerWebGlobal;
  return {
    g,
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

/** A value whose `stack` getter throws: what makes the error reporter itself throw. */
function hostileError(): Error {
  const error = new Error("hostile");
  Object.defineProperty(error, "stack", {
    get() {
      throw new Error("stack is hostile");
    },
  });
  return error;
}

/** Starts a run and waits for it to reach a terminal state, so `run` exists when the listener fires. */
async function startIdleRun(g: RunnerWebGlobal, sent: WebToHostMessage[]): Promise<void> {
  (g.__jslabHostMessage as (m: unknown) => void)({
    seq: 1,
    message: {
      type: "run",
      runId: "run-1",
      code: "globalThis.__jslabListenerProbe = 1;\n",
      settings: { maxEntries: 100 },
    },
  });
  const deadline = Date.now() + 2000;
  while (!sent.some((m) => m.type === "state" && m.state !== "evaluating")) {
    if (Date.now() > deadline) throw new Error(`no terminal state; received ${JSON.stringify(sent)}`);
    await Bun.sleep(2);
  }
}

test("a hostile value reaching the error listener is reported instead of throwing out of the listener", async () => {
  const sent: WebToHostMessage[] = [];
  const { g, dispatch } = listenerGlobal(sent);
  const handle = startRunnerWeb({ global: g, heartbeatMs: 10_000 });
  try {
    await startIdleRun(g, sent);
    sent.length = 0;

    // Before the fix this throws `stack is hostile` straight out of the listener.
    expect(() => dispatch("error", { error: hostileError() })).not.toThrow();

    const deadline = Date.now() + 2000;
    while (!sent.some((m) => m.type === "events" && m.events.some((e) => e.kind === "error"))) {
      if (Date.now() > deadline) throw new Error(`no error event reported; received ${JSON.stringify(sent)}`);
      await Bun.sleep(2);
    }
  } finally {
    handle.dispose();
  }
});

test("a hostile rejection reaching the unhandledrejection listener is reported instead of throwing", async () => {
  const sent: WebToHostMessage[] = [];
  const { g, dispatch } = listenerGlobal(sent);
  const handle = startRunnerWeb({ global: g, heartbeatMs: 10_000 });
  try {
    await startIdleRun(g, sent);
    sent.length = 0;

    expect(() => dispatch("unhandledrejection", { reason: hostileError() })).not.toThrow();

    const deadline = Date.now() + 2000;
    while (!sent.some((m) => m.type === "events" && m.events.some((e) => e.kind === "error"))) {
      if (Date.now() > deadline) throw new Error(`no error event reported; received ${JSON.stringify(sent)}`);
      await Bun.sleep(2);
    }
  } finally {
    handle.dispose();
  }
});
