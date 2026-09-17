import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type LocalTypesResult,
  localTypesParamsSchema,
  MAX_LOCAL_SPECIFIERS_PER_REQUEST,
  MAX_PACKAGE_NAME_CHARS,
  MAX_PACKAGES_PER_REQUEST,
  type PackageTypesResult,
  packageTypesParamsSchema,
  type TypeFile,
} from "@jslab/rpc-schema";
import { createTypeFeeder, importSpecifiers } from "../src/editor/type-feeder";
import type { TimerApi } from "../src/state/auto-run";

/** A promise plus its own resolve/reject, for tests that need to control response ordering (Task 23 fix round 2). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: TimerApi = {
    setTimeout: (callback) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  return {
    timers,
    fire: async () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
      await Bun.sleep(5);
    },
  };
}

const result = (name: string, patch: Partial<PackageTypesResult> = {}): PackageTypesResult => ({
  name,
  files: [{ path: `file:///node_modules/${name}/index.d.ts`, content: "" }],
  dependencies: [],
  typesPackage: null,
  hasTypes: true,
  truncated: false,
  ...patch,
});

function fakeEnvironment() {
  const packages = new Map<string, readonly TypeFile[]>();
  const local = new Map<string, readonly TypeFile[]>();
  return {
    packages,
    local,
    environment: {
      setPackageFiles: (name: string, files: readonly TypeFile[]) => void packages.set(name, files),
      clearPackages: () => packages.clear(),
      setLocalFiles: (tabId: string, files: readonly TypeFile[]) => void local.set(tabId, files),
      clearLocal: (tabId?: string) => (tabId === undefined ? local.clear() : void local.delete(tabId)),
    },
  };
}

/** Like `fakeEnvironment`, but also records every mutator call, in order (Task 23 fix round 2, I-1). */
function fakeEnvironmentWithLog() {
  const packages = new Map<string, readonly TypeFile[]>();
  const calls: string[] = [];
  return {
    calls,
    environment: {
      setPackageFiles: (name: string, files: readonly TypeFile[]) => {
        packages.set(name, files);
        calls.push(`setPackageFiles:${name}`);
      },
      clearPackages: () => {
        packages.clear();
        calls.push("clearPackages");
      },
      setLocalFiles: () => {},
      clearLocal: () => {},
    },
  };
}

describe("type feeder (spec §6.2)", () => {
  test("finds bare packages and relative specifiers in static, dynamic, require and side-effect imports", () => {
    expect(
      importSpecifiers(
        [
          'import { z } from "zod";',
          'import "@acme/tool/register";',
          'const lodash = require("lodash/fp");',
          'const util = await import("./util");',
          'export * from "../shared/types.js";',
          'import fs from "node:fs";',
          'import path from "path";',
        ].join("\n"),
      ),
    ).toEqual({ packages: ["@acme/tool", "lodash", "zod"], relative: ["../shared/types.js", "./util"] });
  });

  test("requests each package once after the delay, registers its files and follows its dependencies", async () => {
    const { timers, fire } = manualTimers();
    const { packages, environment } = fakeEnvironment();
    const requestPackages = mock(async (_tabId: string, names: string[]) =>
      names.map((name) => (name === "zod" ? result("zod", { dependencies: ["zod-core"] }) : result(name))),
    );
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
      timers,
    });
    feeder.schedule("t1", 'import { z } from "zod";', false);
    feeder.schedule("t1", 'import { z } from "zod";\nimport x from "zod";', false);
    expect(requestPackages).not.toHaveBeenCalled();
    await fire();
    expect(requestPackages.mock.calls).toEqual([
      ["t1", ["zod"]],
      ["t1", ["zod-core"]],
    ]);
    expect([...packages.keys()]).toEqual(["zod", "zod-core"]);
    feeder.schedule("t1", 'import { z } from "zod";', false);
    await fire();
    expect(requestPackages).toHaveBeenCalledTimes(2);
    // Task 23 fix round 2, I-1 "replace, don't clear first": invalidatePackages() no longer clears the environment
    // synchronously — the old types stay until a replacement result arrives, so the editor never briefly shows
    // false "Cannot find module" markers.
    feeder.invalidatePackages();
    expect([...packages.keys()]).toEqual(["zod", "zod-core"]);
    feeder.schedule("t1", 'import { z } from "zod";', false);
    await fire();
    expect(requestPackages).toHaveBeenCalledTimes(4);
    expect([...packages.keys()]).toEqual(["zod", "zod-core"]);
  });

  test("with a working directory, relative imports are fed as local files and their packages requested", async () => {
    const { timers, fire } = manualTimers();
    const { packages, local, environment } = fakeEnvironment();
    const requestLocal = mock(
      async (_tabId: string, _specifiers: string[]): Promise<LocalTypesResult> => ({
        files: [{ path: "file:///tab/util.ts", content: "export const a = 1;" }],
        packages: ["zod"],
        truncated: false,
      }),
    );
    const feeder = createTypeFeeder({
      requestPackages: async (_t, names) => names.map((name) => result(name)),
      requestLocal,
      environment,
      timers,
    });
    feeder.schedule("t1", 'import { a } from "./util";', true);
    await fire();
    expect(requestLocal.mock.calls).toEqual([["t1", ["./util"]]]);
    expect(local.get("t1")?.map((file) => file.path)).toEqual(["file:///tab/util.ts"]);
    expect([...packages.keys()]).toEqual(["zod"]);
    feeder.schedule("t1", 'import { a } from "./util";', false);
    await fire();
    expect(local.has("t1")).toBe(false);
  });

  test("remembers installed packages without types and the @types package to offer", async () => {
    const { timers, fire } = manualTimers();
    const { environment } = fakeEnvironment();
    const log = mock((_message: string, _detail?: unknown) => {});
    const feeder = createTypeFeeder({
      requestPackages: async () => [
        result("untyped", { files: [], hasTypes: false, typesPackage: "@types/untyped", truncated: true }),
      ],
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
      timers,
      log,
    });
    feeder.schedule("t1", 'import u from "untyped";', false);
    await fire();
    expect([...feeder.untyped()]).toEqual([["untyped", "@types/untyped"]]);
    // N-3: a truncated package-types result is logged, so partial types don't disappear silently.
    expect(log).toHaveBeenCalledWith("type results truncated", { tabId: "t1", name: "untyped" });
  });

  test("invalidating packages keeps the old types until replacement results arrive", async () => {
    const { calls, environment } = fakeEnvironmentWithLog();
    environment.setPackageFiles("zod", [{ path: "file:///node_modules/zod/index.d.ts", content: "" }]);
    calls.length = 0;

    const first = deferred<PackageTypesResult[]>();
    const requestPackages = mock(() => first.promise);
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
    });

    feeder.invalidatePackages();
    expect(calls).toEqual([]);

    feeder.schedule("t1", 'import { z } from "zod";', false, { immediate: true });
    await Bun.sleep(1);
    first.resolve([result("zod")]);
    await Bun.sleep(5);
    expect(calls).toEqual(["clearPackages", "setPackageFiles:zod"]);

    // A second case: the new generation's request has nothing to apply — still exactly one clearPackages.
    calls.length = 0;
    feeder.invalidatePackages();
    feeder.schedule("t2", "const x = 1;", false, { immediate: true });
    await Bun.sleep(5);
    expect(calls).toEqual(["clearPackages"]);
  });

  test("a stale local-types response never overwrites a newer one", async () => {
    const { packages, local, environment } = fakeEnvironment();
    const a = deferred<LocalTypesResult>();
    const b = deferred<LocalTypesResult>();
    let call = 0;
    const requestLocal = mock(() => (call++ === 0 ? a.promise : b.promise));
    const feeder = createTypeFeeder({
      requestPackages: async (_tabId, names) => names.map((name) => result(name)),
      requestLocal,
      environment,
    });

    feeder.schedule("t1", 'import { a } from "./util";', true, { immediate: true });
    await Bun.sleep(1);
    feeder.invalidateLocal("t1");
    feeder.schedule("t1", 'import { a } from "./util";', true, { immediate: true });
    await Bun.sleep(1);

    b.resolve({ files: [{ path: "file:///b/util.ts", content: "" }], packages: ["zod-b"], truncated: false });
    await Bun.sleep(5);
    a.resolve({ files: [{ path: "file:///a/util.ts", content: "" }], packages: ["zod-a"], truncated: false });
    await Bun.sleep(5);

    expect(local.get("t1")?.map((file) => file.path)).toEqual(["file:///b/util.ts"]);
    expect(packages.has("zod-b")).toBe(true);
    expect(packages.has("zod-a")).toBe(false);
  });

  test("more than 50 chased dependencies are all requested", async () => {
    const { environment } = fakeEnvironment();
    const eightyDeps = Array.from({ length: 80 }, (_, index) => `dep-${index}`);
    const requestPackages = mock(async (_tabId: string, names: string[]) =>
      names.map((name) => (name === "root" ? result("root", { dependencies: eightyDeps }) : result(name))),
    );
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
    });
    feeder.schedule("t1", 'import x from "root";', false, { immediate: true });
    await Bun.sleep(20);
    const chunkCalls = requestPackages.mock.calls.filter((call) => (call[1] as string[])[0] !== "root");
    expect(chunkCalls.map((call) => (call[1] as string[]).length)).toEqual([50, 30]);
    const requestedNames = new Set(chunkCalls.flatMap((call) => call[1] as string[]));
    expect(requestedNames.size).toBe(80);
    for (const dep of eightyDeps) expect(requestedNames.has(dep)).toBe(true);
  });

  test("the import scan stays fast on long blank runs", () => {
    const NL = String.fromCharCode(10);
    const code = `import a from 'a';${NL}${NL.repeat(100_000)}import b from 'b';`;
    const start = performance.now();
    const specifiers = importSpecifiers(code);
    const elapsed = performance.now() - start;
    expect(specifiers.packages).toEqual(["a", "b"]);
    expect(elapsed).toBeLessThan(500);
  });

  test("forgetting a tab cancels its pending feed and clears its local files", async () => {
    const { timers, fire } = manualTimers();
    const { local, environment } = fakeEnvironment();
    const requestPackages = mock(async (_tabId: string, names: string[]) => names.map((name) => result(name)));
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
      timers,
    });
    environment.setLocalFiles("t1", [{ path: "file:///t1/util.ts", content: "" }]);
    expect(local.has("t1")).toBe(true);

    feeder.schedule("t1", 'import { z } from "zod";', false);
    feeder.forget("t1");
    await fire();
    expect(requestPackages).not.toHaveBeenCalled();
    expect(local.has("t1")).toBe(false);
  });

  test("dispose stops an in-flight dependency chase", async () => {
    const { packages, environment } = fakeEnvironment();
    const first = deferred<PackageTypesResult[]>();
    const requestPackages = mock(() => first.promise);
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
    });
    feeder.schedule("t1", 'import x from "root";', false, { immediate: true });
    await Bun.sleep(1);
    feeder.dispose();
    first.resolve([result("root", { dependencies: ["child"] })]);
    await Bun.sleep(10);
    expect(requestPackages).toHaveBeenCalledTimes(1);
    expect(packages.size).toBe(0);
  });

  test("a stale failure keeps newer marks, and over-long names are never requested", async () => {
    const { environment } = fakeEnvironment();
    const first = deferred<PackageTypesResult[]>();
    let callCount = 0;
    const requestPackages = mock((_tabId: string, names: string[]) => {
      callCount++;
      if (callCount === 1) return first.promise;
      return Promise.resolve(names.map((name) => result(name)));
    });
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
    });

    // Generation N: request "zod", still pending.
    feeder.schedule("t1", 'import { z } from "zod";', false, { immediate: true });
    await Bun.sleep(1);

    // Invalidate to generation N+1, and re-request the same name — current-generation, succeeds.
    feeder.invalidatePackages();
    feeder.schedule("t1", 'import { z } from "zod";', false, { immediate: true });
    await Bun.sleep(5);

    // Generation N's stale request now rejects.
    first.reject(new Error("stale failure"));
    await Bun.sleep(5);

    // The next feed for "zod" doesn't request it again — it's still marked from generation N+1's success.
    feeder.schedule("t1", 'import { z } from "zod";', false, { immediate: true });
    await Bun.sleep(5);
    expect(callCount).toBe(2);

    // A too-long name is never requested.
    const longName = "a".repeat(MAX_PACKAGE_NAME_CHARS + 1);
    feeder.schedule("t1", `import x from "${longName}";`, false, { immediate: true });
    await Bun.sleep(5);
    const allNames = requestPackages.mock.calls.flatMap((call) => call[1] as string[]);
    expect(allNames).not.toContain(longName);
  });
});

/**
 * F3: `type-feeder.ts` used to re-declare `MAX_PACKAGES_PER_REQUEST` (50), `MAX_PACKAGE_NAME_CHARS` (214) and the
 * `types.local` cap (200) as bare literals mirroring `@jslab/rpc-schema`'s inline `.max(...)` values. They agreed
 * only by luck: the schema never exported them, so the UI *couldn't* import them. On drift Main answers with
 * InvalidPayloadError, and `requestPackages`/`feed` only `deps.log?.(...)` the rejection -- so autocomplete and
 * type hints would stop appearing with nothing user-visible. The schema now exports the limits and the UI imports
 * the same ones, matching `packages/shared/src/env-vars.ts`.
 *
 * The first test fails if a duplicate literal is re-introduced; the rest fail if the UI ever chunks or truncates
 * to a different number than the schema actually enforces.
 */
describe("type-feeder request limits are the schema's, not copies (F3)", () => {
  const source = readFileSync(new URL("../src/editor/type-feeder.ts", import.meta.url), "utf8");

  test("the UI imports the three limits and re-declares none of them", () => {
    // A re-introduced `export const MAX_PACKAGES_PER_REQUEST = 50` (or any other value) fails here.
    for (const name of ["MAX_PACKAGES_PER_REQUEST", "MAX_PACKAGE_NAME_CHARS", "MAX_LOCAL_SPECIFIERS_PER_REQUEST"]) {
      expect(source).not.toMatch(new RegExp(`const\\s+${name}\\s*=`));
      expect(source).toContain(name);
    }
    // ...and they come from the package that enforces them.
    const importBlock = source.slice(0, source.indexOf('from "@jslab/rpc-schema"'));
    expect(importBlock).toContain("MAX_PACKAGES_PER_REQUEST");
    expect(importBlock).toContain("MAX_PACKAGE_NAME_CHARS");
    expect(importBlock).toContain("MAX_LOCAL_SPECIFIERS_PER_REQUEST");
  });

  test("types.package is chunked at the schema's limit, and every chunk validates against it", async () => {
    const names = Array.from({ length: MAX_PACKAGES_PER_REQUEST + 1 }, (_, i) => `pkg${i}`);
    const { environment } = fakeEnvironment();
    const requestPackages = mock(async (_tabId: string, chunk: string[]) => chunk.map((name) => result(name)));
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
    });
    feeder.schedule("t1", names.map((name) => `import x from "${name}";`).join("\n"), false, { immediate: true });
    await Bun.sleep(20);
    const chunks = requestPackages.mock.calls.map((call) => call[1] as string[]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([MAX_PACKAGES_PER_REQUEST, 1]);
    for (const packages of chunks) {
      expect(packageTypesParamsSchema.safeParse({ tabId: "t1", packages }).success).toBe(true);
    }
  });

  test("types.local is truncated to the schema's limit, and what is sent validates against it", async () => {
    const relative = Array.from({ length: MAX_LOCAL_SPECIFIERS_PER_REQUEST + 5 }, (_, i) => `./m${i}`);
    const { environment } = fakeEnvironment();
    const requestLocal = mock(
      async (_tabId: string, _specifiers: string[]): Promise<LocalTypesResult> => ({
        files: [],
        packages: [],
        truncated: false,
      }),
    );
    const feeder = createTypeFeeder({
      requestPackages: async () => [],
      requestLocal,
      environment,
    });
    feeder.schedule("t1", relative.map((spec) => `import y from "${spec}";`).join("\n"), true, { immediate: true });
    await Bun.sleep(20);
    const specifiers = requestLocal.mock.calls[0]?.[1] ?? [];
    expect(specifiers).toHaveLength(MAX_LOCAL_SPECIFIERS_PER_REQUEST);
    expect(localTypesParamsSchema.safeParse({ tabId: "t1", specifiers }).success).toBe(true);
  });

  test("a name exactly at the schema's length limit is still requested", async () => {
    const atLimit = "a".repeat(MAX_PACKAGE_NAME_CHARS);
    const { environment } = fakeEnvironment();
    const requestPackages = mock(async (_tabId: string, chunk: string[]) => chunk.map((name) => result(name)));
    const feeder = createTypeFeeder({
      requestPackages,
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
    });
    feeder.schedule("t1", `import x from "${atLimit}";`, false, { immediate: true });
    await Bun.sleep(20);
    expect(requestPackages.mock.calls.flatMap((call) => call[1] as string[])).toContain(atLimit);
    expect(packageTypesParamsSchema.safeParse({ tabId: "t1", packages: [atLimit] }).success).toBe(true);
  });
});
