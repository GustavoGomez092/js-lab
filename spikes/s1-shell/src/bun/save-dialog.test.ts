import { expect, test } from "bun:test";
import { buildSaveScript } from "./save-dialog";

test("escapes quotes and backslashes in names and folders", () => {
  expect(buildSaveScript({ defaultName: 'a "b"\\c.ts', defaultDir: "/tmp/x y" })).toBe(
    'POSIX path of (choose file name with prompt "Save As" default name "a \\"b\\"\\\\c.ts" default location (POSIX file "/tmp/x y"))',
  );
});

test("omits the location when no folder is given", () => {
  expect(buildSaveScript({ defaultName: "x.ts" })).toBe('POSIX path of (choose file name with prompt "Save As" default name "x.ts")');
});
