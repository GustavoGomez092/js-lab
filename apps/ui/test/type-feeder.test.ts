import { describe, expect, mock, test } from "bun:test";
import type { LocalTypesResult, PackageTypesResult, TypeFile } from "@jslab/rpc-schema";
import { createTypeFeeder, importSpecifiers } from "../src/editor/type-feeder";
import type { TimerApi } from "../src/state/auto-run";

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
    feeder.invalidatePackages();
    expect(packages.size).toBe(0);
    feeder.schedule("t1", 'import { z } from "zod";', false);
    await fire();
    expect(requestPackages).toHaveBeenCalledTimes(4);
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
    const feeder = createTypeFeeder({
      requestPackages: async () => [result("untyped", { files: [], hasTypes: false, typesPackage: "@types/untyped" })],
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
      timers,
    });
    feeder.schedule("t1", 'import u from "untyped";', false);
    await fire();
    expect([...feeder.untyped()]).toEqual([["untyped", "@types/untyped"]]);
  });
});
