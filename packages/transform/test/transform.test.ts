import { describe, expect, test } from "bun:test";
import { transform } from "../src/transform";
import { baseOptions, runInstrumented } from "./helpers";

const plain = { ...baseOptions, autoLog: false, loopProtection: false };

describe("pipeline", () => {
  test("strips TypeScript types and declare fields", () => {
    const r = transform("const a: number = 1;\nclass X { declare y: string; z = 1 }", plain);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).not.toContain(": number");
    expect(r.code).not.toContain("declare");
  });

  test("compiles TSX with the automatic JSX runtime", () => {
    const r = transform("const el = <div>{1}</div>;", { ...plain, language: "tsx" });
    expect(r.ok && r.code).toContain("react/jsx-runtime");
  });

  test("reports syntax errors with position and code frame", () => {
    const r = transform("const x = ;", plain);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "syntax",
      message: "Unexpected token",
      line: 1,
      column: 11,
    });
    expect(r.diagnostics[0]?.codeFrame).toContain("const x = ;");
  });

  // Task 18 fix round 1 (I-1): Babel quotes the whole source line in its code frame, so a syntax error on a
  // 1,000,000-character line produced a multi-megabyte frame that reached the UI twice (diagnostics and run.events).
  test("bounds the code frame and message of a syntax error on a very long line", () => {
    const r = transform(`const x = ${"a".repeat(1_000_000)} +;`, plain);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const diagnostic = r.diagnostics[0];
    const frame = diagnostic?.codeFrame ?? "";
    expect(frame.length).toBeGreaterThan(0);
    expect(frame.length).toBeLessThanOrEqual(10_001);
    expect(Math.max(...frame.split("\n").map((line) => line.length))).toBeLessThanOrEqual(1_001);
    expect(diagnostic?.message.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(10_001);
  });

  test("produces a source map", () => {
    const r = transform("const a = 1;\na", baseOptions);
    expect(r.ok && r.map.mappings.length).toBeGreaterThan(0);
  });

  test("rejects user bindings named __jl", () => {
    const r = transform("const __jl = 1;", baseOptions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ code: "reserved-identifier", line: 1 });

    const r2 = transform("function f() {\n  const __jl = 1;\n  return 1;\n}", baseOptions);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.diagnostics[0]).toMatchObject({ code: "reserved-identifier", line: 2 });
  });
});

describe("auto log", () => {
  test("logs top-level expressions with their original line", async () => {
    const { calls } = await runInstrumented("const a = 1;\n\na + 1;\n'x'.repeat(2)");
    expect(calls).toEqual([
      { kind: "log", line: 3, value: 2 },
      { kind: "log", line: 4, value: "xx" },
    ]);
  });

  test("skips assignments, updates and console calls", async () => {
    const { calls } = await runInstrumented("let a = 1;\na = 2;\na++;\nconsole.debug(a);");
    expect(calls).toEqual([]);
  });

  test("logs a leading string literal but not 'use strict'", async () => {
    expect((await runInstrumented("'hello'")).calls).toEqual([{ kind: "log", line: 1, value: "hello" }]);
    expect((await runInstrumented("'use strict'")).calls).toEqual([]);
  });

  test("logs awaited values", async () => {
    const { calls } = await runInstrumented("await Promise.resolve(5)");
    expect(calls).toEqual([{ kind: "log", line: 1, value: 5 }]);
  });

  test("only instruments top-level statements", async () => {
    const { calls } = await runInstrumented("function f() { 1 + 1 }\nf()");
    expect(calls).toEqual([{ kind: "log", line: 2, value: undefined }]);
  });

  test("can be disabled", async () => {
    expect((await runInstrumented("1 + 1", { autoLog: false })).calls).toEqual([]);
  });
});

describe("magic comments", () => {
  test("//? on an expression statement logs once", async () => {
    const { calls } = await runInstrumented("1 + 1 //?");
    expect(calls).toEqual([{ kind: "mc", line: 1, value: 2 }]);
  });

  test("//? on a declaration logs the declared value", async () => {
    expect((await runInstrumented("const x = 2 * 3 //?")).calls).toEqual([{ kind: "mc", line: 1, value: 6 }]);
    expect((await runInstrumented("const a = 1, b = 2 //?")).calls).toEqual([
      { kind: "mc", line: 1, value: { a: 1, b: 2 } },
    ]);
  });

  test("$ expression formats the value", async () => {
    const { calls } = await runInstrumented("[1, 2, 3] //? $.length");
    expect(calls).toEqual([{ kind: "mc", line: 1, value: 3 }]);
  });

  test("//? on a return statement logs the returned value", async () => {
    const { calls } = await runInstrumented("function f() {\n  return 4 //?\n}\nf()", { autoLog: false });
    expect(calls).toEqual([{ kind: "mc", line: 2, value: 4 }]);
  });

  test("/*?*/ logs an inline sub-expression", async () => {
    const { calls } = await runInstrumented("'abc'.toUpperCase() /*?*/ .length", { autoLog: false });
    expect(calls).toEqual([{ kind: "mc", line: 1, value: "ABC" }]);
  });

  test("/*?*/ before a for...of body logs each binding", async () => {
    const { calls } = await runInstrumented("for (const n of [1, 2]) /*?*/ { }", { autoLog: false });
    expect(calls.map((c) => c.value)).toEqual([1, 2]);
  });

  test("/*?*/ before a while body logs each test", async () => {
    const { calls } = await runInstrumented("let i = 0;\nwhile (i < 2) /*?*/ { i++ }", { autoLog: false });
    expect(calls.map((c) => c.value)).toEqual([true, true, false]);
  });

  test("markers inside strings are ignored", async () => {
    expect((await runInstrumented("const s = '//?'", { autoLog: false })).calls).toEqual([]);
  });

  test("a marker with no loggable value produces a warning", () => {
    const r = transform("if (true) {\n} //?", baseOptions);
    expect(r.ok && r.diagnostics).toEqual([expect.objectContaining({ code: "magic-comment-no-value", line: 2 })]);
  });

  test("warnings are capped at 500, followed by one summary of the rest (FA-m8)", () => {
    const source = Array.from({ length: 700 }, () => "if (true) {\n} //?").join("\n");
    const r = transform(source, baseOptions);
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toHaveLength(501);
    expect(r.diagnostics.slice(0, 500).every((d) => d.code === "magic-comment-no-value")).toBe(true);
    expect(r.diagnostics[500]).toEqual({
      severity: "warning",
      code: "too-many-warnings",
      message: "200 more warnings not shown",
      line: 1002,
      column: 3,
    });
  });

  test("an invalid $ expression warns and still logs the raw value", async () => {
    const { calls, result } = await runInstrumented("1 //? $.(");
    expect(calls).toEqual([{ kind: "mc", line: 1, value: 1 }]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "magic-comment-invalid-expression" })]);
  });

  test("never evaluates an expression twice", async () => {
    const { calls } = await runInstrumented("let i = 0;\ni++ //?\ni");
    expect(calls).toEqual([
      { kind: "mc", line: 2, value: 0 },
      { kind: "log", line: 3, value: 1 },
    ]);
  });

  test("//? on an exported declaration anchors after the export (M1 T5)", async () => {
    expect((await runInstrumented("export const x = 1, y = 2 //?")).calls).toEqual([
      { kind: "mc", line: 1, value: { x: 1, y: 2 } },
    ]);
  });
});

describe("logpoints", () => {
  test("log a declaration's value", async () => {
    const { calls } = await runInstrumented("const a = 5;\nconst b = a * 2;", { logpoints: [2] });
    expect(calls).toEqual([{ kind: "mc", line: 2, value: 10 }]);
  });

  test("log a statement inside a loop on every iteration", async () => {
    const { calls } = await runInstrumented("for (let i = 0; i < 2; i++) {\n  i;\n}", {
      autoLog: false,
      logpoints: [2],
    });
    expect(calls.map((c) => c.value)).toEqual([0, 1]);
  });

  test("on a for...of head log the binding", async () => {
    const { calls } = await runInstrumented("for (const x of [7, 8]) {\n}", { autoLog: false, logpoints: [1] });
    expect(calls.map((c) => c.value)).toEqual([7, 8]);
  });

  test("on an empty line warn", () => {
    const r = transform("const a = 1;\n\n", { ...baseOptions, logpoints: [2] });
    expect(r.ok && r.diagnostics).toEqual([expect.objectContaining({ code: "logpoint-no-value", line: 2 })]);
  });

  test("defer to a magic comment on the same line", async () => {
    const { calls } = await runInstrumented("1 + 1 //?", { logpoints: [1] });
    expect(calls).toHaveLength(1);
  });
});

describe("loop protection", () => {
  const limited = { autoLog: false, loopProtectionMaxIterations: 5 };
  const infinite: Record<string, string> = {
    for: "for (;;) {}",
    while: "while (true) {}",
    "do-while": "do {} while (true)",
    "for-in": "const o = {};\nfor (let i = 0; i < 10; i++) o['k' + i] = i;\nfor (const k in o) {}",
    "for-of": "function* g() { let n = 0; for (;;) yield n++; }\nfor (const x of g()) {}",
    "for-await": "async function* g() { let n = 0; for (;;) yield n++; }\nfor await (const x of g()) {}",
    "non-block body": "while (true) ;",
  };

  for (const [name, source] of Object.entries(infinite)) {
    test(`stops ${name} loops`, async () => {
      await expect(runInstrumented(source, limited)).rejects.toThrow("exceeded 5 iterations");
    });
  }

  test("allows exactly the limit", async () => {
    const { calls } = await runInstrumented("let n = 0;\nfor (let i = 0; i < 5; i++) n++;\nn //?", limited);
    expect(calls).toEqual([{ kind: "mc", line: 3, value: 5 }]);
  });

  test("keeps labeled continue working and resets per loop entry", async () => {
    const source =
      "let n = 0;\nouter: for (let i = 0; i < 4; i++) {\n  for (let j = 0; j < 4; j++) {\n    if (j === 3) continue outer;\n    n++;\n  }\n}\nn //?";
    const { calls } = await runInstrumented(source, limited);
    expect(calls).toEqual([{ kind: "mc", line: 8, value: 12 }]);
  });

  test("adds no guards when disabled", () => {
    const r = transform("while (true) {}", { ...baseOptions, loopProtection: false });
    expect(r.ok && r.code).not.toContain("RangeError");
  });
});
