import { afterEach, expect, test } from "bun:test";
import { type TransformOptions, type TransformResult, transform } from "@jslab/transform";
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
