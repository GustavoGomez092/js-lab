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
