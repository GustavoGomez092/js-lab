import { describe, expect, test } from "bun:test";
import { MAX_DOTENV_BYTES, MAX_ENV_VALUE_CHARS } from "@jslab/shared";
import {
  addEnvRow,
  removeEnvRow,
  rowsFromPaste,
  rowsFromVariables,
  updateEnvRow,
  validateEnvTable,
} from "../src/env/env-table";

describe("environment table rows", () => {
  test("rows come from variables in order, and add, update and remove keep ids stable", () => {
    const rows = rowsFromVariables({ A: "1", B: "2" });
    expect(rows).toEqual([
      { id: 1, key: "A", value: "1", revealed: false },
      { id: 2, key: "B", value: "2", revealed: false },
    ]);
    const added = addEnvRow(rows, " C ", "3");
    expect(added.at(-1)).toEqual({ id: 3, key: "C", value: "3", revealed: false });
    expect(updateEnvRow(added, 2, { value: "two", revealed: true })[1]).toEqual({
      id: 2,
      key: "B",
      value: "two",
      revealed: true,
    });
    expect(removeEnvRow(added, 1).map((row) => row.key)).toEqual(["B", "C"]);

    // R-M3-T25-SAVE-1: the client enforces @jslab/shared's own limits, which its `validateEnvRows` doesn't.
    // Fix round 1 (M-5): assert the error *kinds*, not just `.ok === false`.
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ key: `K${index}`, value: "v" }));
    const tooManyResult = validateEnvTable(tooMany);
    expect(tooManyResult.ok).toBe(false);
    if (!tooManyResult.ok) expect(tooManyResult.errors.map((entry) => entry.error)).toContain("tooMany");

    const longValue = "x".repeat(MAX_ENV_VALUE_CHARS + 1);
    const longResult = validateEnvTable([{ key: "A", value: longValue }]);
    expect(longResult.ok).toBe(false);
    if (!longResult.ok) expect(longResult.errors).toContainEqual({ index: 0, error: "valueTooLong" });

    // A row with both an invalid key and an over-long value produces both error kinds.
    const bothResult = validateEnvTable([{ key: "1BAD", value: longValue }]);
    expect(bothResult.ok).toBe(false);
    if (!bothResult.ok) {
      expect(bothResult.errors.map((entry) => entry.error).sort()).toEqual(["invalidKey", "valueTooLong"]);
    }
  });

  test("rowsFromPaste parses a .env block and returns null for plain text (R25-3)", () => {
    const NL = String.fromCharCode(10);
    const pasted = rowsFromPaste([], `A=1${NL}export B="two"${NL}# c${NL}`);
    expect(pasted?.map((row) => row.key)).toEqual(["A", "B"]);
    expect(pasted?.map((row) => row.value)).toEqual(["1", "two"]);
    expect(rowsFromPaste([], "plain")).toBeNull();
    // Fix round 1 (M-4): a multi-line paste that parses to zero entries falls through to a normal paste.
    expect(rowsFromPaste([], `one${NL}two`)).toBeNull();
  });

  test("a paste over the dotenv size limit isn't parsed (fix round 1, I-1)", () => {
    const NL = String.fromCharCode(10);
    const oversize = `A=1${NL}${"x".repeat(MAX_DOTENV_BYTES)}`;
    expect(new TextEncoder().encode(oversize).length).toBeGreaterThan(MAX_DOTENV_BYTES);
    const started = performance.now();
    expect(rowsFromPaste([], oversize)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });
});
