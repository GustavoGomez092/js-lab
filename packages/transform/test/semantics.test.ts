import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "../src/transform";
import type { Language, TransformOptions } from "../src/types";

// Instrumentation must never change observable behavior. Each fixture prints what it observes;
// the plain and instrumented builds run in separate Bun processes and must print the same thing.

const STUB = 'Object.defineProperty(globalThis, "__jl", { value: { log: (_l, v) => v, mc: (_l, _c, v) => v } });\n';

const fixtures: Record<string, { language?: Language; source: string }> = {
  hoisting: {
    source:
      "console.log(typeof hoisted, typeof v);\nfunction hoisted() { return 1 }\nvar v = 2;\nconsole.log(hoisted(), v);",
  },
  tdz: {
    source: "try { console.log(x) } catch (e) { console.log(e.constructor.name) }\nlet x = 1;\nx",
  },
  "strict mode and this": {
    source:
      "console.log(this === undefined);\ntry { undeclared = 1 } catch (e) { console.log(e.constructor.name) }\n(function () { console.log(this === undefined) })();",
  },
  "top-level await ordering": {
    source:
      "console.log('a');\nawait null;\nconsole.log('b');\nconst v = await new Promise((r) => setTimeout(() => r('c'), 5));\nconsole.log(v);\nv",
  },
  "console ordering with results": {
    source:
      "let n = 0;\nconst inc = () => { console.log('inc', ++n); return n; };\ninc();\ninc() + inc();\nconsole.log('n', n);",
  },
  "labeled loops": {
    source:
      "const out = [];\nouter: for (let i = 0; i < 3; i++) {\n  for (let j = 0; j < 3; j++) {\n    if (j === 1) continue outer;\n    if (i === 2) break outer;\n    out.push(String(i) + j);\n  }\n}\nconsole.log(out.join(','));",
  },
  generators: {
    source:
      "function* g() { let i = 0; while (i < 3) yield i++; }\nconsole.log([...g()].join(','));\nasync function* ag() { for (const x of [1, 2]) yield x; }\nconst got = [];\nfor await (const x of ag()) got.push(x);\nconsole.log(got.join(','));",
  },
  "side effects evaluate once": {
    source: "let i = 0;\ni++;\nconst j = i++;\nconsole.log(i, j);\n[i++, i++];\nconsole.log(i);",
  },
  "classes and getters": {
    source: "class A { #p = 1; get p() { return this.#p } static s = 2; }\nnew A().p\nconsole.log(new A().p, A.s);",
  },
  destructuring: {
    source:
      "const { a, b: [c, d = 4] } = { a: 1, b: [3] };\nconsole.log(a, c, d);\nlet [e, ...rest] = [5, 6, 7];\nconsole.log(e, rest.length);",
  },
  "switch and return": {
    source:
      "function f(x) {\n  switch (x) {\n    case 1: return 'one';\n    default: return 'other';\n  }\n}\nconsole.log(f(1), f(2));",
  },
  exports: {
    source: "export const value = 1;\nexport function fn() { return 2 }\nconsole.log(value, fn());",
  },
  "typescript enums and namespaces": {
    language: "typescript",
    source:
      "enum Color { Red, Green }\nconst c: Color = Color.Green;\nconsole.log(c, Color[c]);\nnamespace NS { export const k = 3 }\nconsole.log(NS.k);",
  },
  "caught errors": {
    source: "try {\n  JSON.parse('{');\n} catch (e) {\n  console.log(e.constructor.name);\n}",
  },
};

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-semantics-"));
  await Bun.write(join(dir, "stub.mjs"), STUB);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function build(source: string, options: TransformOptions): Promise<string> {
  const result = transform(source, options);
  if (!result.ok) throw new Error(`transform failed: ${JSON.stringify(result.diagnostics)}`);
  return result.code;
}

async function execute(code: string, name: string): Promise<string> {
  const file = join(dir, `${name}-${crypto.randomUUID()}.mjs`);
  await Bun.write(file, code);
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--preload", join(dir, "stub.mjs"), file], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code_ = await proc.exited;
  if (code_ !== 0) throw new Error(`${name} exited ${code_}: ${stderr}`);
  return stdout;
}

describe("instrumentation preserves semantics", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    test(name, async () => {
      const language = fixture.language ?? "javascript";
      const lines = fixture.source.split("\n").length;
      const plain = await build(fixture.source, {
        language,
        autoLog: false,
        loopProtection: false,
        loopProtectionMaxIterations: 2000,
        logpoints: [],
      });
      const instrumented = await build(fixture.source, {
        language,
        autoLog: true,
        loopProtection: true,
        loopProtectionMaxIterations: 1_000_000,
        logpoints: Array.from({ length: lines }, (_, i) => i + 1),
      });
      const expected = await execute(plain, "plain");
      expect(expected.length).toBeGreaterThan(0);
      expect(await execute(instrumented, "instrumented")).toBe(expected);
    }, 20_000);
  }
});
