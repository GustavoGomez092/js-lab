import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TypeFile } from "@jslab/rpc-schema";
import type { Runtime } from "@jslab/shared";
import {
  compilerOptionsFor,
  createTsEnvironment,
  diagnosticsOptionsFor,
  libFor,
  packsFor,
  type RuntimePack,
  type TsDefaultsLike,
} from "../src/editor/ts-environment";
import { collectTypeLibPack, resolvePackageDir, TYPE_LIB_PACKS } from "../vite-plugins/type-libs-plugin";
import { workerDiagnostics } from "./ts-worker";

function fakeDefaults() {
  const calls: string[] = [];
  const state: { options?: Record<string, unknown>; diagnostics?: Record<string, unknown>; libs: string[] } = {
    libs: [],
  };
  const defaults: TsDefaultsLike = {
    setCompilerOptions: (options) => {
      calls.push("options");
      state.options = options;
    },
    setDiagnosticsOptions: (options) => {
      calls.push("diagnostics");
      state.diagnostics = options;
    },
    setExtraLibs: (libs) => {
      calls.push("libs");
      state.libs = libs.map((lib) => lib.filePath ?? "");
    },
  };
  return { defaults, calls, state };
}

const packFile = (pack: RuntimePack): TypeFile => ({
  path: `file:///node_modules/${pack}-pack/index.d.ts`,
  content: "",
});

/** A full lib file name such as `lib.dom.iterable.d.ts` (the backslash is built, not typed: R-M3-T20-ESC-1). */
const BACKSLASH = String.fromCharCode(92);
const LIB_FILE_NAME = new RegExp(`^lib${BACKSLASH}.[a-z0-9.]+${BACKSLASH}.d${BACKSLASH}.ts$`);

describe("per-runtime TypeScript environment (spec §6.1)", () => {
  test("compiler options follow the runtime and the decorator mode", () => {
    expect(compilerOptionsFor("bun", "2023-11")).toMatchObject({
      lib: ["lib.esnext.d.ts"],
      experimentalDecorators: false,
      moduleDetection: 3,
      moduleResolution: 100,
      jsx: 4,
    });
    expect(compilerOptionsFor("browser-node", "legacy")).toMatchObject({
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      experimentalDecorators: true,
    });
    expect(compilerOptionsFor("browser", "none").lib).toEqual([
      "lib.esnext.d.ts",
      "lib.dom.d.ts",
      "lib.dom.iterable.d.ts",
    ]);
    // Never tsconfig short names: Monaco's worker reads each entry as a lib file name (PR #1).
    expect(
      (["bun", "browser-node", "browser"] as const).flatMap(libFor).every((name) => LIB_FILE_NAME.test(name)),
    ).toBe(true);
    expect([packsFor("bun"), packsFor("browser-node"), packsFor("browser")]).toEqual([["bun", "node"], ["node"], []]);
  });

  test("editor.linting turns validation and suggestion diagnostics off, and 1375/1378 are always ignored", () => {
    expect(diagnosticsOptionsFor(true)).toEqual({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: false,
      diagnosticCodesToIgnore: [1375, 1378],
    });
    // noSuggestionDiagnostics also follows `linting`: Monaco's worker gates suggestion-only markers (for example
    // TS6133, "declared but never read") behind this flag separately from noSemanticValidation, so without it
    // Linting off would leave suggestion diagnostics on screen (Task 21 fix round 1, found via M-4(a)).
    expect(diagnosticsOptionsFor(false)).toEqual({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
      diagnosticCodesToIgnore: [1375, 1378],
    });
  });

  test("applies options and packs to both defaults, re-applies on a runtime switch, and does nothing when nothing changed", async () => {
    const ts1 = fakeDefaults();
    const js1 = fakeDefaults();
    const loaded: RuntimePack[] = [];
    const env = createTsEnvironment({
      defaults: [ts1.defaults, js1.defaults],
      loadPack: async (pack) => {
        loaded.push(pack);
        return [packFile(pack)];
      },
    });
    await env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: true });
    expect(ts1.state.libs).toEqual([
      "file:///node_modules/bun-pack/index.d.ts",
      "file:///node_modules/node-pack/index.d.ts",
    ]);
    expect(js1.state.options?.lib).toEqual(["lib.esnext.d.ts"]);
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    expect(ts1.state.libs).toEqual([]);
    expect(ts1.state.options?.lib).toEqual(["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]);
    const before = ts1.calls.length;
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    expect(ts1.calls.length).toBe(before);
    await env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: false });
    expect(ts1.state.diagnostics?.noSemanticValidation).toBe(true);
    expect(loaded).toEqual(["bun", "node"]);
  });

  test("package files persist across tabs, local files follow the shown tab", async () => {
    const { defaults, state } = fakeDefaults();
    const env = createTsEnvironment({ defaults: [defaults], loadPack: async () => [] });
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    env.setPackageFiles("zod", [{ path: "file:///node_modules/zod/index.d.cts", content: "x" }]);
    env.setLocalFiles("a", [{ path: "file:///tab/util.ts", content: "a" }]);
    env.setLocalFiles("b", [{ path: "file:///tab/other.ts", content: "b" }]);
    expect(state.libs).toEqual(["file:///node_modules/zod/index.d.cts", "file:///tab/util.ts"]);
    expect(env.hasPackage("zod")).toBe(true);
    await env.apply({ tabId: "b", runtime: "browser", decorators: "2023-11", linting: true });
    expect(state.libs).toEqual(["file:///node_modules/zod/index.d.cts", "file:///tab/other.ts"]);
    env.clearPackages();
    expect([state.libs, env.hasPackage("zod")]).toEqual([["file:///tab/other.ts"], false]);
  });

  test("a slow pack load never applies a runtime the user already left", async () => {
    const { defaults, state } = fakeDefaults();
    let releaseBun: () => void = () => {};
    const env = createTsEnvironment({
      defaults: [defaults],
      loadPack: (pack) =>
        pack === "bun"
          ? new Promise((resolve) => {
              releaseBun = () => resolve([packFile("bun")]);
            })
          : Promise.resolve([packFile(pack)]),
    });
    const slow = env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: true });
    await env.apply({ tabId: "a", runtime: "browser-node", decorators: "2023-11", linting: true });
    releaseBun();
    await slow;
    expect(state.libs).toEqual(["file:///node_modules/node-pack/index.d.ts"]);
    expect(state.options?.lib).toEqual(["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]);
  });

  test("extra libs are sent only when the shown tab's set changes", async () => {
    const { defaults, calls, state } = fakeDefaults();
    const libCalls = () => calls.filter((call) => call === "libs").length;
    const env = createTsEnvironment({ defaults: [defaults], loadPack: async () => [] });
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    const start = libCalls();

    env.setLocalFiles("b", [{ path: "file:///tab/b.ts", content: "b" }]);
    expect(libCalls()).toBe(start);
    env.clearLocal("missing");
    expect(libCalls()).toBe(start);
    env.setLocalFiles("a", [{ path: "file:///tab/a.ts", content: "a" }]);
    const afterA = libCalls();
    env.setLocalFiles("a", [{ path: "file:///tab/a.ts", content: "a" }]);
    expect(libCalls()).toBe(afterA);
    env.clearLocal("b");
    expect(libCalls()).toBe(afterA);
    env.setPackageFiles("p", [{ path: "file:///node_modules/p/index.d.ts", content: "p" }]);
    const afterPackage = libCalls();
    env.setPackageFiles("p", [{ path: "file:///node_modules/p/index.d.ts", content: "p" }]);
    expect(libCalls()).toBe(afterPackage);

    env.setLocalFiles("a", [{ path: "file:///tab/a.ts", content: "changed" }]);
    expect(libCalls()).toBe(afterPackage + 1);
    env.clearLocal("a");
    expect(libCalls()).toBe(afterPackage + 2);
    expect(state.libs).toEqual(["file:///node_modules/p/index.d.ts"]);
  });

  test("a failed pack load still applies options and other libs, rejects, and a later apply retries", async () => {
    const { defaults, calls, state } = fakeDefaults();
    let failing = true;
    const env = createTsEnvironment({
      defaults: [defaults],
      loadPack: async (pack) => {
        if (failing) throw new Error(`the ${pack} pack failed to load`);
        return [packFile(pack)];
      },
    });
    const bunState = { tabId: "a", runtime: "bun", decorators: "2023-11", linting: true } as const;
    await expect(env.apply(bunState)).rejects.toThrow("failed to load");
    expect(calls).toContain("options");
    expect(calls).toContain("diagnostics");
    expect(state.options?.lib).toEqual(["lib.esnext.d.ts"]);

    const libCalls = () => calls.filter((call) => call === "libs").length;
    const before = libCalls();
    env.setLocalFiles("a", [{ path: "file:///tab/util.ts", content: "u" }]);
    expect(libCalls()).toBe(before + 1);
    expect(state.libs).toEqual(["file:///tab/util.ts"]);

    failing = false;
    await env.apply({ ...bunState });
    expect(env.libPaths()).toEqual([
      "file:///node_modules/bun-pack/index.d.ts",
      "file:///node_modules/node-pack/index.d.ts",
      "file:///tab/util.ts",
    ]);
  });

  test("extra libs are deduplicated by path, with packages over packs and local over packages", async () => {
    const sent: { content: string; filePath?: string }[][] = [];
    const defaults: TsDefaultsLike = {
      setCompilerOptions: () => {},
      setDiagnosticsOptions: () => {},
      setExtraLibs: (libs) => {
        sent.push(libs);
      },
    };
    const globals = "file:///node_modules/@types/node/globals.d.ts";
    const env = createTsEnvironment({
      defaults: [defaults],
      loadPack: async () => [{ path: globals, content: "pack" }],
    });
    await env.apply({ tabId: "a", runtime: "browser-node", decorators: "2023-11", linting: true });
    env.setPackageFiles("@types/node", [{ path: globals, content: "pkg" }]);
    expect(sent.at(-1)?.filter((lib) => lib.filePath === globals)).toEqual([{ content: "pkg", filePath: globals }]);
    expect(env.libPaths()).toEqual([globals]);
    env.setLocalFiles("a", [{ path: globals, content: "local" }]);
    expect(sent.at(-1)?.filter((lib) => lib.filePath === globals)).toEqual([{ content: "local", filePath: globals }]);
    expect(new Set(env.libPaths()).size).toBe(env.libPaths().length);
  });

  test("dispose stops a pending apply and later updates from touching the defaults (Task 21 fix round 1, M-2)", async () => {
    const { defaults, calls } = fakeDefaults();
    let releaseBun: () => void = () => {};
    const env = createTsEnvironment({
      defaults: [defaults],
      loadPack: (pack) =>
        pack === "bun"
          ? new Promise((resolve) => {
              releaseBun = () => resolve([packFile("bun")]);
            })
          : Promise.resolve([packFile(pack)]),
    });
    const pending = env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: true });
    const before = calls.length;
    env.dispose();

    releaseBun();
    await expect(pending).resolves.toBeUndefined();
    expect(calls.length).toBe(before);

    env.setLocalFiles("a", [{ path: "file:///tab/util.ts", content: "u" }]);
    expect(calls.length).toBe(before);
    expect(env.libPaths()).toEqual([]);
  });

  test("Monaco's TypeScriptWorker: console, setTimeout and URL resolve in every runtime, and runtime globals are scoped (R-M2-BUG-1)", async () => {
    const uiRoot = join(import.meta.dir, "..");
    const packs: Record<RuntimePack, TypeFile[]> = {
      node: collectTypeLibPack(TYPE_LIB_PACKS.node.map((name) => ({ name, dir: resolvePackageDir(name, uiRoot) }))),
      bun: collectTypeLibPack(TYPE_LIB_PACKS.bun.map((name) => ({ name, dir: resolvePackageDir(name, uiRoot) }))),
    };
    const code = [
      'console.log(typeof setTimeout, new URL("https://example.test/").host);',
      "const platform: string = process.platform;",
      "Bun.version;",
      "document.title;",
      "export {};",
    ].join(String.fromCharCode(10));
    const flagged = async (runtime: Runtime) => {
      const diagnostics = await workerDiagnostics({
        code,
        compilerOptions: compilerOptionsFor(runtime, "2023-11"),
        extraLibs: packsFor(runtime).flatMap((pack) => packs[pack]),
      });
      // "Cannot find name 'x'" and its variants (TS2304, TS2584, TS2580, TS2867, TS2868) all quote the name.
      return ["console", "setTimeout", "URL", "process", "Bun", "document"].filter((name) =>
        diagnostics.some((diagnostic) => diagnostic.message.includes(`'${name}'`)),
      );
    };
    expect(await flagged("bun")).toEqual(["document"]);
    expect(await flagged("browser-node")).toEqual(["Bun"]);
    expect(await flagged("browser")).toEqual(["process", "Bun"]);
  }, 120_000);
});
