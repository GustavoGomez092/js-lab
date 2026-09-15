import { describe, expect, test } from "bun:test";
import { MAX_ENV_VALUE_CHARS } from "@jslab/shared";
import {
  addEnvRow,
  removeEnvRow,
  rowsFromPaste,
  rowsFromVariables,
  updateEnvRow,
  validateEnvRows,
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
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ key: `K${index}`, value: "v" }));
    expect(validateEnvRows(tooMany).ok).toBe(false);
    const longValue = "x".repeat(MAX_ENV_VALUE_CHARS + 1);
    expect(validateEnvRows([{ key: "A", value: longValue }]).ok).toBe(false);
  });

  test("rowsFromPaste parses a .env block and returns null for plain text (R25-3)", () => {
    const NL = String.fromCharCode(10);
    const pasted = rowsFromPaste([], `A=1${NL}export B="two"${NL}# c${NL}`);
    expect(pasted?.map((row) => row.key)).toEqual(["A", "B"]);
    expect(pasted?.map((row) => row.value)).toEqual(["1", "two"]);
    expect(rowsFromPaste([], "plain")).toBeNull();
  });
});
