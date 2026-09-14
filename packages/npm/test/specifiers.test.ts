import { describe, expect, test } from "bun:test";
import { packageNameFromSpecifier, parseInstallSpec, typesPackageName } from "../src/specifiers";

describe("specifiers (spec §11.4)", () => {
  test("derives the package name from bare import specifiers", () => {
    expect(
      ["zod", "zod/v4", "@a/b", "@a/b/c/d.js", "lodash.merge", "react-dom/client"].map(packageNameFromSpecifier),
    ).toEqual(["zod", "zod", "@a/b", "@a/b", "lodash.merge", "react-dom"]);
  });

  test("ignores relative, absolute, subpath-import, URL, bun and Node built-in specifiers", () => {
    expect(
      [
        "./x",
        "../x",
        "/abs",
        "#internal",
        "node:fs",
        "bun:test",
        "bun",
        "fs",
        "fs/promises",
        "https://x/y.js",
        "@",
        "@a",
        "Zod",
      ].map(packageNameFromSpecifier),
    ).toEqual([null, null, null, null, null, null, null, null, null, null, null, null, null]);
  });

  test("parses install specs: registry names with ranges, git, tarball and path specs", () => {
    expect(parseInstallSpec("zod@^4")).toEqual({ kind: "registry", name: "zod", range: "^4", raw: "zod@^4" });
    expect(parseInstallSpec("@scope/name@latest")).toEqual({
      kind: "registry",
      name: "@scope/name",
      range: "latest",
      raw: "@scope/name@latest",
    });
    expect(parseInstallSpec(" zod ")).toEqual({ kind: "registry", name: "zod", range: null, raw: "zod" });
    expect(parseInstallSpec("git+ssh://git@github.com/a/b.git")?.kind).toBe("git");
    expect(parseInstallSpec("user/repo#main")?.kind).toBe("git");
    expect(parseInstallSpec("https://registry.test/x/-/x-1.0.0.tgz")?.kind).toBe("tarball");
    expect(parseInstallSpec("file:../local")?.kind).toBe("path");
    expect(["", "-g", "a b", "Zod@1"].map(parseInstallSpec)).toEqual([null, null, null, null]);
  });

  test("names the @types package for a package", () => {
    expect(["zod", "@scope/x", "@types/node"].map(typesPackageName)).toEqual(["@types/zod", "@types/scope__x", null]);
  });
});
