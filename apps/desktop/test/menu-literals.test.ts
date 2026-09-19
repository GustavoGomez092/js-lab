import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MENU = join(import.meta.dir, "..", "src", "main", "menu.ts");

/**
 * `noJsxLiterals` cannot see these: menu labels are object fields, not JSX. This is the syntactic
 * counterpart for the one file that builds user-visible text outside a component.
 */
describe("menu.ts has no hard-coded labels (spec §17)", () => {
  const source = readFileSync(MENU, "utf8");

  test("no label:, text: or title: field is assigned a bare string literal", () => {
    const literals = [...source.matchAll(/\b(label|text|title):\s*"([^"]+)"/g)].map((match) => match[2]);
    expect(literals).toEqual([]);
  });

  test("the scan can actually see this file — control", () => {
    // Without this, a renamed file or an unreadable path would make the assertion above pass vacuously.
    expect(source.length).toBeGreaterThan(5000);
    expect(source).toContain("export function buildMenu");
    expect([...source.matchAll(/\b(label|text|title):/g)].length).toBeGreaterThan(20);
  });

  test("the scan would catch a reintroduced literal — mutation control", () => {
    // The control above proves the fields exist; this proves the pattern actually fires on the shape it is
    // meant to forbid. Without it, a regex that matched nothing at all would pass both tests above.
    const mutated = source.replace('label: t("menu.file")', 'label: "File"');
    expect(mutated).not.toBe(source);
    expect([...mutated.matchAll(/\b(label|text|title):\s*"([^"]+)"/g)].map((match) => match[2])).toEqual(["File"]);
  });
});
