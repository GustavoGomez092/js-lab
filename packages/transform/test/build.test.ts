import { describe, expect, test } from "bun:test";
import { DEFAULT_BUILD_OPTIONS } from "../src/build";
import { transform } from "../src/transform";
import type { BuildOptions } from "../src/types";
import { baseOptions, runInstrumented } from "./helpers";

const build = (patch: Partial<BuildOptions> = {}): BuildOptions => ({ ...DEFAULT_BUILD_OPTIONS, ...patch });
const last = async (source: string, patch: Partial<BuildOptions> = {}) =>
  (await runInstrumented(source, { build: build(patch) })).calls.at(-1)?.value;
const compiles = (source: string, patch: Partial<BuildOptions> = {}) =>
  transform(source, { ...baseOptions, autoLog: false, loopProtection: false, build: build(patch) }).ok;

describe("Build settings (spec §8, LB-05, LB-07)", () => {
  test("2023-11 decorators are the default and run", async () => {
    const source = [
      "const tenfold = (value: any, _context: ClassMethodDecoratorContext) =>",
      "  function (this: unknown, ...args: any[]) { return value.apply(this, args) * 10; };",
      "class A { @tenfold m() { return 4; } }",
      "new A().m()",
    ].join("\n");
    expect(await last(source)).toBe(40);
  });

  test("legacy decorators run TypeScript-style (LB-07)", async () => {
    const source = [
      "function sealed(ctor: Function) { (ctor as any).sealedFlag = true; }",
      "function double(_target: any, _key: string, descriptor: PropertyDescriptor) {",
      "  const original = descriptor.value;",
      "  descriptor.value = function (...args: any[]) { return original.apply(this, args) * 2; };",
      "  return descriptor;",
      "}",
      "@sealed class B { @double n() { return 21; } }",
      "[(B as any).sealedFlag, new B().n()]",
    ].join("\n");
    expect(await last(source, { decorators: "legacy" })).toEqual([true, 42]);
  });

  test("decorators: none rejects decorator syntax, and declare fields always strip (LB-07)", () => {
    expect(compiles("@x class A {}", { decorators: "none" })).toBe(false);
    const result = transform("class X { declare y: string; z = 1 }", {
      ...baseOptions,
      build: build({ decorators: "none" }),
    });
    expect(result.ok && result.code).not.toContain("declare");
  });

  test("pipeline, do and throw expressions need their settings", async () => {
    expect(compiles("5 |> % * 2")).toBe(false);
    expect(await last("5 |> % * 2", { pipelineOperator: true })).toBe(10);
    expect(compiles('let x = do { "yes" }; x')).toBe(false);
    expect(await last('let x = do { if (true) { "yes" } else { "no" } };\nx', { doExpressions: true })).toBe("yes");
    expect(compiles('const f = (v?: number) => v ?? throw new Error("none");')).toBe(false);
    expect(
      await last('const f = (v?: number) => v ?? throw new Error("none");\nf(3)', { throwExpressions: true }),
    ).toBe(3);
  });

  test("function.sent needs its setting", async () => {
    const source =
      'function* g() { const first = function.sent; yield first; }\nconst it = g();\nit.next("hello").value';
    expect(compiles(source)).toBe(false);
    expect(await last(source, { functionSent: true })).toBe("hello");
  });

  test("regexp modifiers and optional chaining assignment are on by default", async () => {
    expect(await last('const o: any = { a: { b: 1 } };\no?.a.b = 2;\n[/(?i:a)b/.test("Ab"), o.a.b]')).toEqual([
      true,
      2,
    ]);
    expect(compiles("const o: any = {}; o?.a = 1;", { optionalChainingAssign: false })).toBe(false);
  });
});
