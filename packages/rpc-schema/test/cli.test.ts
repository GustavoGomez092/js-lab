import { describe, expect, test } from "bun:test";
import {
  CLI_LANG_ALIASES,
  cliOpenParamsSchema,
  MAX_CLI_CODE_CHARS,
  MAX_CLI_FILES,
  MAX_CLI_LINE_CHARS,
  MAX_TEXT_CHARS,
} from "../src";

describe("cliOpenParamsSchema", () => {
  test("accepts the full §16.2 parameter set", () => {
    expect(
      cliOpenParamsSchema.parse({
        files: ["/tmp/a.ts", "/tmp/b.tsx"],
        run: true,
        runtime: "browser-node",
        lang: "tsx",
        cwd: "/tmp/project",
        title: "scratch",
      }),
    ).toEqual({
      files: ["/tmp/a.ts", "/tmp/b.tsx"],
      run: true,
      runtime: "browser-node",
      lang: "tsx",
      cwd: "/tmp/project",
      title: "scratch",
    });
  });

  test("accepts stdin code with no files", () => {
    expect(cliOpenParamsSchema.parse({ code: "1 + 1" }).code).toBe("1 + 1");
  });

  test("accepts every runtime the build offers, including both browser runtimes", () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      expect(cliOpenParamsSchema.parse({ code: "1", runtime }).runtime).toBe(runtime);
    }
  });

  test("rejects a request that names neither a file nor code", () => {
    expect(() => cliOpenParamsSchema.parse({ run: true })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ files: [] })).toThrow();
  });

  test("rejects relative paths: the CLI makes them absolute before sending (§16.3)", () => {
    expect(() => cliOpenParamsSchema.parse({ files: ["a.ts"] })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "1", cwd: "project" })).toThrow();
  });

  test("bounds the request so a hostile client can't exhaust Main", () => {
    expect(() =>
      cliOpenParamsSchema.parse({ files: Array.from({ length: MAX_CLI_FILES + 1 }, () => "/tmp/a.ts") }),
    ).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "x".repeat(MAX_CLI_CODE_CHARS + 1) })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "1", runtime: "deno" })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "1", lang: "ts" })).toThrow();
  });

  test("`code` is bounded to fit one NDJSON line, not to the 64 MiB in-app buffer bound", () => {
    // The whole request travels as ONE NDJSON line, and `LineBuffer` caps that at MAX_CLI_LINE_CHARS. Bounding
    // `code` at MAX_TEXT_CHARS instead made a schema-legal request undeliverable: the server threw "Request line
    // too long" and ended the socket, so `cat 6mb-bundle.js | jslab --run -` reported "The JSLab socket closed
    // before replying" (exit 1) -- the transport blamed for a size problem. These two bounds must stay ordered.
    expect(MAX_CLI_CODE_CHARS).toBeLessThan(MAX_CLI_LINE_CHARS);
    expect(MAX_CLI_LINE_CHARS).toBeLessThan(MAX_TEXT_CHARS);
    expect(cliOpenParamsSchema.parse({ code: "x".repeat(MAX_CLI_CODE_CHARS) }).code).toHaveLength(MAX_CLI_CODE_CHARS);
  });

  test("CLI_LANG_ALIASES maps the §16.2 spellings onto the internal languages", () => {
    expect(CLI_LANG_ALIASES).toEqual({ ts: "typescript", js: "javascript", tsx: "tsx", jsx: "jsx" });
  });
});
