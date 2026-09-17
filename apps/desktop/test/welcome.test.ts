import { describe, expect, test } from "bun:test";
import { transform } from "@jslab/transform";
import { WELCOME_CODE, WELCOME_TITLE } from "../src/main/welcome";

describe("the first-run welcome sample (spec §7.5)", () => {
  test("the welcome sample demonstrates everything spec §7.5 lists", () => {
    expect(WELCOME_TITLE).toBe("Welcome");
    // Deliberately not `toContain("//?")`: the sample's own prose line -- "end a line with //? to log exactly
    // that statement" -- satisfies that even after the working marker has been deleted, so it cannot tell a
    // sample that DEMONSTRATES a magic comment from one that merely mentions it. §7.5 asks for the demonstration,
    // so require a real trailing marker on a line of code.
    const markerLines = WELCOME_CODE.split("\n").filter(
      (line) => line.trimEnd().endsWith("//?") && !line.trimStart().startsWith("//"),
    );
    expect(markerLines).toHaveLength(1);
    expect(WELCOME_CODE.toLowerCase()).toContain("logpoint");
    expect(WELCOME_CODE).toContain("fetch(");
    expect(WELCOME_CODE).toContain("function Hello");
    // R-M5a-4: the network and React samples ship commented, so pressing Run on a first launch does no I/O.
    for (const line of WELCOME_CODE.split("\n")) {
      if (line.includes("fetch(") || line.includes("<Hello")) expect(line.trimStart().startsWith("//")).toBe(true);
    }
  });

  /**
   * The sample is the very first code a new user sees, and nothing else compiles it: `welcome.ts` ships it as an
   * opaque string, and `SessionStore` writes it to a buffer byte-for-byte. A typo in the JSX -- or shipping it as
   * `typescript`, where `<p>` parses as a type assertion -- would greet a first launch with red squiggles. This
   * runs the real transform the app runs, so the sample cannot rot into something that does not compile.
   */
  test("the welcome sample really compiles as the TSX it ships as, and has something for Auto Log to log", () => {
    const result = transform(WELCOME_CODE, {
      language: "tsx",
      autoLog: true,
      loopProtection: false,
      loopProtectionMaxIterations: 100_000,
      logpoints: [],
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    // Auto Log instruments the sample's top-level statements; a sample of nothing but comments would not. And the
    // `//?` is a magic comment to the transform rather than just text: a marker compiles to `__jl.mc(`
    // (packages/transform/src/instrument.ts), where Auto Log on its own only ever emits `__jl.log(`.
    if (result.ok) {
      expect(result.code).toContain("__jl.log(");
      expect(result.code).toContain("__jl.mc(");
    }
  });
});
