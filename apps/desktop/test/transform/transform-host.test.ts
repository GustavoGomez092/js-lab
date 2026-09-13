import { afterEach, expect, test } from "bun:test";
import type { TransformOptions, TransformResult } from "@jslab/transform";
import { transform } from "@jslab/transform";
import { CachingTransformHost, type TransformHost, WorkerTransformHost } from "../../src/main/transform/transform-host";

const options: TransformOptions = {
  language: "typescript",
  autoLog: true,
  loopProtection: true,
  loopProtectionMaxIterations: 2000,
  logpoints: [],
};

const hosts: TransformHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

test("the worker host produces the same result as a direct transform", async () => {
  const host = new WorkerTransformHost();
  hosts.push(host);
  const source = "const a: number = 1;\na + 1";
  expect(await host.transform(source, options)).toEqual(transform(source, options));
});

test("concurrent worker requests resolve to their own results", async () => {
  const host = new WorkerTransformHost();
  hosts.push(host);
  const results = await Promise.all(["1", "2", "3"].map((n) => host.transform(`${n} + 0`, options)));
  expect(results.map((r) => (r.ok ? r.code.match(/__jl\.log\(1, (\d)/)?.[1] : null))).toEqual(["1", "2", "3"]);
});

test("dispose rejects pending requests", async () => {
  const host = new WorkerTransformHost();
  const pending = host.transform("1", options);
  host.dispose();
  await expect(pending).rejects.toThrow("disposed");
});

function countingHost() {
  let calls = 0;
  const inner: TransformHost = {
    transform: async (source, opts): Promise<TransformResult> => {
      calls++;
      return transform(source, opts);
    },
    dispose: () => {},
  };
  return { inner, calls: () => calls };
}

test("the caching host reuses results for identical input", async () => {
  const { inner, calls } = countingHost();
  const host = new CachingTransformHost(inner);
  await host.transform("1", options);
  await host.transform("1", options);
  await host.transform("1", { ...options, autoLog: false });
  expect(calls()).toBe(2);
});

test("the caching host evicts the least recently used entry", async () => {
  const { inner, calls } = countingHost();
  const host = new CachingTransformHost(inner, 2);
  await host.transform("1", options);
  await host.transform("2", options);
  await host.transform("1", options);
  await host.transform("3", options);
  await host.transform("1", options);
  expect(calls()).toBe(3);
  await host.transform("2", options);
  expect(calls()).toBe(4);
});

test("recreates the worker after it exits", async () => {
  const host = new WorkerTransformHost(new URL("./fixtures/exit-worker.ts", import.meta.url).href);
  hosts.push(host);
  await expect(host.transform("__exit__", options)).rejects.toThrow();
  const result = await host.transform("1 + 1", options);
  expect(result.ok).toBe(true);
});

test("rejects transforms after dispose", async () => {
  const host = new WorkerTransformHost();
  hosts.push(host);
  host.dispose();
  await expect(host.transform("1", options)).rejects.toThrow("Transform host disposed");
});

test("a late failure does not evict a newer entry for the same key", async () => {
  let calls = 0;
  let rejectFirst: ((error: Error) => void) | undefined;
  let resolveSecond: ((value: TransformResult) => void) | undefined;
  let resolveThird: ((value: TransformResult) => void) | undefined;

  const inner: TransformHost = {
    transform: async () => {
      calls++;
      if (calls === 1) {
        return new Promise<TransformResult>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      if (calls === 2) {
        return new Promise<TransformResult>((resolve) => {
          resolveSecond = resolve;
        });
      }
      return new Promise<TransformResult>((resolve) => {
        resolveThird = resolve;
      });
    },
    dispose: () => {},
  };

  const host = new CachingTransformHost(inner, 1);

  // Call A, which stays pending as p1
  const p1 = host.transform("key", options);

  // Call B, which evicts A
  const p2 = host.transform("other", options);

  // Call A again: the inner count increases and entry for key is re-cached
  host.transform("key", options);
  expect(calls).toBe(3);

  // Resolve the "other" promise
  resolveSecond?.({
    ok: true,
    code: "other",
    map: { version: 3, sources: [], names: [], mappings: "" },
    diagnostics: [],
  });
  await p2;

  // Reject the first "key" promise, and let microtasks flush
  rejectFirst?.(new Error("first failed"));
  try {
    await p1;
  } catch {
    // Expected to reject
  }
  await Bun.sleep(0);

  // Call A a third time and assert inner.transform was NOT called again
  const p4 = host.transform("key", options);
  expect(calls).toBe(3); // Still 3, not 4

  // Resolve the pending promise
  resolveThird?.({
    ok: true,
    code: "key",
    map: { version: 3, sources: [], names: [], mappings: "" },
    diagnostics: [],
  });
  const result = await p4;
  expect(result.ok).toBe(true);
});
