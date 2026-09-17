import { describe, expect, mock, test } from "bun:test";
import { MAIN_REQUEST_NAMES, type MainRequests } from "@jslab/rpc-schema";
import { maxRequestTimeFor } from "../src/rpc-timeouts";

/**
 * B2. `rpc-timeouts.ts` is thoroughly tested, but nothing tested that `rpc.ts` actually USES it.
 *
 * `createRpcApi` is referenced only by `main.tsx`, so no test ever constructed it: deleting
 * `requestOptions("app.bootstrap")` from its `bootstrap` call site left the whole UI suite green, and the
 * branch's central guarantee -- "a bound is never decided at a call site" -- was enforced by review alone. That
 * is exactly how the 10 s default silently reattached to `app.bootstrap` in the first place, which is the
 * failure the degrading bootstrap (and, downstream of it, B1) exists to survive.
 *
 * This drives the real `createRpcApi` against a recording stand-in for Electrobun's request proxy and asserts
 * the bound each call site actually passed. It lives in `isolated/` because `mock.module` is process-wide (the
 * same reason `app.test.tsx` does).
 *
 * Scope, honestly: this observes the OPTIONS a call site passed, not the literal string handed to
 * `requestOptions`. A mis-name is caught whenever it changes the resulting bound -- which is every mis-name that
 * matters -- but swapping one `small` request's name for another `small` one is invisible here, and the
 * classification table itself is what `test/rpc-timeouts.test.ts` pins.
 */

type RecordedCall = { method: string; params: unknown; options: unknown };
const calls: RecordedCall[] = [];

mock.module("electrobun/view", () => {
  const request = new Proxy(
    {},
    {
      get: (_target, method: string) => (params: unknown, options?: unknown) => {
        calls.push({ method, params, options });
        // Shapes the few `.then(reply => reply.x)` call sites in rpc.ts destructure.
        return Promise.resolve({ packages: [], variables: {} });
      },
    },
  );
  const send = new Proxy({}, { get: () => () => {} });
  // A constructor function rather than a class: `rpc.ts` does `new Electroview({ rpc })`, so this must be
  // constructible, while a class whose only member is `defineRPC` trips biome's noStaticOnlyClass.
  function Electroview() {
    // The real one wires the view to the RPC; nothing here needs an instance.
  }
  Electroview.defineRPC = () => ({ request, send });
  return { Electroview };
});

const { createRpcApi } = await import("../src/rpc");

/** Every `MainRequests` method the main window's API actually calls; `settings.get` belongs to the Settings window. */
const MAIN_WINDOW_REQUESTS = MAIN_REQUEST_NAMES.filter((name) => name !== "settings.get");

async function callEveryRequest() {
  const api = createRpcApi();
  await api.bootstrap();
  await api.startRun({
    tabId: "t1",
    code: "1 + 1",
    language: "typescript",
    logpoints: [],
    reason: "manual",
    runtime: "bun",
  });
  await api.expand({ tabId: "t1", runId: crypto.randomUUID(), handleId: "h1" });
  await api.createTab({});
  await api.closeTab("t1");
  await api.reopenTab();
  await api.updateSettings({});
  await api.saveFile("t1", "content");
  await api.npmList(true);
  await api.npmSearch("zod");
  await api.packageTypes("t1", ["zod"]);
  await api.localTypes("t1", ["./a.ts"]);
  await api.getEnv();
  await api.saveEnv({});
}

describe("rpc.ts request wiring (B2)", () => {
  test("every request the main window makes passes the bound rpc-timeouts decided for it", async () => {
    calls.length = 0;
    await callEveryRequest();

    // Not one call site may be left to Electrobun's constructor-level default.
    const unbounded = calls.filter((call) => call.options === undefined).map((call) => call.method);
    expect(unbounded).toEqual([]);

    for (const call of calls) {
      expect({ method: call.method, options: call.options }).toEqual({
        method: call.method,
        options: { maxRequestTime: maxRequestTimeFor(call.method as keyof MainRequests) },
      });
    }
  });

  /**
   * The completeness half. Without it, a call site could be "fixed" by deleting the request altogether, and a
   * newly added request that forgets its options is only caught if someone remembers to call it above.
   */
  test("every main-window request is exercised, and only those", async () => {
    calls.length = 0;
    await callEveryRequest();

    expect([...new Set(calls.map((call) => call.method))].sort()).toEqual([...MAIN_WINDOW_REQUESTS].sort());
  });
});
