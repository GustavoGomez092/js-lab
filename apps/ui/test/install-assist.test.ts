import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  installActionsFor,
  registerInstallAssist,
  runtimeMissingPackage,
  runtimeMissingRelative,
} from "../src/editor/install-assist";
import { strings } from "../src/strings";

/**
 * A minimal `monaco` fake: just enough of `editor.registerCommand` and `languages.registerCodeActionProvider` for
 * `registerInstallAssist` to run, with a `provideCodeActions` helper that drives the captured provider directly
 * (Task 23 fix round 2, M-8).
 */
function fakeMonaco() {
  type Provider = {
    provideCodeActions(
      model: unknown,
      range: unknown,
      context: { markers: unknown[] },
    ): { actions: { title: string; isPreferred: boolean; diagnostics: unknown[] }[]; dispose(): void };
  };
  let provider: Provider | null = null;
  const monaco = {
    editor: {
      registerCommand: () => ({ dispose: () => {} }),
    },
    languages: {
      registerCodeActionProvider: (_selector: unknown, p: Provider) => {
        provider = p;
        return { dispose: () => {} };
      },
    },
  } as unknown as typeof Monaco;
  return {
    monaco,
    provideCodeActions: (markers: unknown[]) => provider?.provideCodeActions(null, null, { markers }).actions ?? [],
  };
}

describe("install assist (spec §6.3, §11.4)", () => {
  test("2307 markers offer the package, or its @types package when it is installed without types", () => {
    const markers = [
      { code: "2307", message: "Cannot find module 'zod' or its corresponding type declarations." },
      { code: 2307, message: "Cannot find module '@acme/tool/register' or its corresponding type declarations." },
      { code: "2307", message: "Cannot find module 'untyped' or its corresponding type declarations." },
      { code: "2307", message: "Cannot find module './local' or its corresponding type declarations." },
      { code: "2307", message: "Cannot find module 'node:fs' or its corresponding type declarations." },
      { code: "2322", message: "Type 'string' is not assignable to type 'number'." },
    ];
    expect(installActionsFor(markers, new Map([["untyped", "@types/untyped"]]))).toEqual([
      { title: strings.install.package("zod"), spec: "zod" },
      { title: strings.install.package("@acme/tool"), spec: "@acme/tool" },
      { title: strings.install.types("@types/untyped"), spec: "@types/untyped" },
    ]);
  });

  test("reads the package from Bun's runtime module-not-found errors", () => {
    expect(runtimeMissingPackage("Cannot find package 'zod' from '/data/runs/t1/entry-1.mjs'")).toBe("zod");
    expect(runtimeMissingPackage("Cannot find module '@acme/tool/x' from '/p'")).toBe("@acme/tool");
    expect(runtimeMissingPackage("Cannot find module './local' from '/p'")).toBeNull();
    expect(runtimeMissingPackage("x is not defined")).toBeNull();
    // R24-4: the relative specifier a Bun runtime module-not-found error names, and the package/relative
    // split stays mutually exclusive so the Install and Set buttons never both show for one row.
    expect(runtimeMissingRelative("Cannot find module './local' from '/p'")).toBe("./local");
    expect(runtimeMissingRelative("Cannot find module '../lib/x' from '/p'")).toBe("../lib/x");
    expect(runtimeMissingRelative("Cannot find package 'zod' from '/data/runs/t1/entry-1.mjs'")).toBeNull();
    expect(runtimeMissingRelative("x is not defined")).toBeNull();
  });

  test("each install action carries only its own marker, and only a single action is preferred", () => {
    const { monaco, provideCodeActions } = fakeMonaco();
    registerInstallAssist(monaco, { untyped: () => new Map(), install: () => {} });

    const markerA = { code: 2307, message: "Cannot find module 'zod' or its corresponding type declarations." };
    const markerB = {
      code: 2307,
      message: "Cannot find module '@acme/tool' or its corresponding type declarations.",
    };
    const markerC = { code: 2322, message: "Type 'string' is not assignable to type 'number'." };

    const twoActions = provideCodeActions([markerA, markerB, markerC]);
    expect(twoActions.map((action) => action.diagnostics)).toEqual([[markerA], [markerB]]);
    expect(twoActions.every((action) => action.isPreferred === false)).toBe(true);

    const oneAction = provideCodeActions([markerA]);
    expect(
      oneAction.map((action) => ({
        title: action.title,
        isPreferred: action.isPreferred,
        diagnostics: action.diagnostics,
      })),
    ).toEqual([{ title: strings.install.package("zod"), isPreferred: true, diagnostics: [markerA] }]);
  });
});
