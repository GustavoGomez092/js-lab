import { describe, expect, test } from "bun:test";
import { EDITOR_TS_LIB } from "../src/editor/ts-lib";

describe("EDITOR_TS_LIB", () => {
  test("has esnext, dom and dom.iterable, including dom that declares console", () => {
    expect(EDITOR_TS_LIB).toEqual(["esnext", "dom", "dom.iterable"]);
    expect(EDITOR_TS_LIB).toContain("dom");
  });
});
