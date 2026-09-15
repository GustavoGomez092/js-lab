import { describe, expect, test } from "bun:test";
import { installActionsFor, runtimeMissingPackage } from "../src/editor/install-assist";
import { strings } from "../src/strings";

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
  });
});
