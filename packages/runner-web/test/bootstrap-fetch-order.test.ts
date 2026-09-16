import { expect, test } from "bun:test";
import type { RunnerWebGlobal } from "../src/bootstrap";
import { startRunnerWeb } from "../src/bootstrap";
import type { FetchHostEvent, FetchTransport, ProxiedRequest } from "../src/fetch-proxy";

// Task 13: enforces the install order `bootstrap.ts` documents (installFetchProxy before installHandleTracking) --
// a comment alone cannot catch a regression here, since getting it backwards is silent (no error, no crash): the
// symptom is only that a `browser-node` fetch's handle never gets tracked, so it never keeps a run "active" and an
// abort never reaches `HandleTracker.disposeAll()`. This file proves the CORRECT order through exactly that
// mechanism -- see the test below for why `dispose()` aborting an in-flight fetch is the observable evidence.
//
// A fake global, not `globalThis` (unlike bootstrap.test.ts): this file never starts a real run (no blob-URL
// dynamic import), it only calls the wrapped `g.fetch` directly, so nothing here needs the real global scope.

/** `map.get(key)`, creating and storing an empty set first if there wasn't one. */
function bucket<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function fakeGlobal(): RunnerWebGlobal {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    setTimeout: setTimeout as unknown as RunnerWebGlobal["setTimeout"],
    clearTimeout: clearTimeout as unknown as RunnerWebGlobal["clearTimeout"],
    setInterval: setInterval as unknown as RunnerWebGlobal["setInterval"],
    clearInterval: clearInterval as unknown as RunnerWebGlobal["clearInterval"],
    addEventListener: (type: string, cb: (event: unknown) => void) => bucket(listeners, type).add(cb),
    removeEventListener: (type: string, cb: (event: unknown) => void) => listeners.get(type)?.delete(cb),
    // `installConsole` (installed after this file's fake `g.console`) only ever *adds* methods via
    // `Object.assign`, so an empty object is a complete-enough starting point.
    console: {},
    // `installFetchProxy`'s own "native" fallback, for a `data:`/`blob:` url this file's test never exercises.
    fetch: (() => Promise.reject(new Error("no native fetch in this fake"))) as unknown as RunnerWebGlobal["fetch"],
  } as unknown as RunnerWebGlobal;
}

/** A transport that records every `request`/`abort` call and never itself replies -- this file only needs to prove
 *  which calls happen, not drive a real streamed response. */
function fakeTransport(): FetchTransport & { requested: { id: number; request: ProxiedRequest }[]; aborted: number[] } {
  const requested: { id: number; request: ProxiedRequest }[] = [];
  const aborted: number[] = [];
  return {
    requested,
    aborted,
    request(id, request) {
      requested.push({ id, request });
    },
    abort(id) {
      aborted.push(id);
    },
    onEvent(_listener: (event: FetchHostEvent) => void) {
      return () => {};
    },
  };
}

test("installFetchProxy runs before installHandleTracking: disposing the runner aborts an in-flight browser-node fetch", async () => {
  const g = fakeGlobal();
  const transport = fakeTransport();
  const handle = startRunnerWeb({ global: g, runtime: "browser-node", fetchTransport: transport });

  // Fired and left pending on purpose: the transport never sends a `head`/`end`/`error`, so this promise never
  // settles on its own -- the only way it can ever be released is through `dispose()`'s handle-tracking cleanup,
  // which is exactly what this test drives below (and which is expected to reject it with an AbortError).
  void (g.fetch as typeof fetch)("https://example.com/").catch(() => {});
  // `fetch-proxy.ts`'s own `g.fetch` is `async` and awaits `request.arrayBuffer()` before calling
  // `transport.request`, so the call reaches the transport one microtask later, not synchronously.
  await Promise.resolve();
  await Promise.resolve();
  expect(transport.requested).toHaveLength(1);

  // The only observable proof of the correct order (see this file's header comment): `installHandleTracking`
  // wraps whichever `fetch` it finds installed when it runs. In the correct order, that's the proxy's own fetch,
  // so the pending request became a tracked handle -- `dispose()` -> `tracker.disposeAll()` -> that handle's own
  // disposer aborts the synthetic `AbortController` `handles.ts` merged into the call, which the proxy forwards
  // to the transport. Reversed, `installFetchProxy` would have overwritten `g.fetch` with its own function
  // *after* handle-tracking already wrapped the old one, so this fetch was never tracked at all, and `dispose()`
  // would find nothing to abort -- `transport.aborted` would stay empty (this is the failure this test catches;
  // see the task report for the red run with the install calls swapped).
  handle.dispose();
  expect(transport.aborted).toEqual([1]);
});

test("installFetchProxy is a no-op for the browser runtime -- installHandleTracking still wraps the page's own fetch", () => {
  const g = fakeGlobal();
  const nativeFetch = g.fetch;
  const transport = fakeTransport();
  startRunnerWeb({ global: g, runtime: "browser", fetchTransport: transport });

  // Never called for "browser" (spec §5.12: true browser semantics, CORS enforced, is the point) -- proven by
  // calling `g.fetch` and seeing the transport untouched, while `g.fetch` itself is still a *different* function
  // from the raw native one, because `installHandleTracking` wraps it regardless of runtime.
  expect(g.fetch).not.toBe(nativeFetch);
  void (g.fetch as typeof fetch)("https://example.com/").catch(() => {});
  expect(transport.requested).toEqual([]);
});
