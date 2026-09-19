import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, SOURCE_LOCALE } from "@jslab/shared";
import { flattenKeys } from "../src/i18n/check";

const UI_ROOT = join(import.meta.dir, "..");
const I18N_DIR = join(UI_ROOT, "src", "i18n");
const LOCALES_DIR = join(I18N_DIR, "locales");

/** Every string leaf, by dotted path. Function leaves are skipped: they are converted by hand (Task 9). */
export function plainLeaves(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof child === "string") out[path] = child;
    else if (typeof child === "object" && child !== null) Object.assign(out, plainLeaves(child, path));
  }
  return out;
}

/**
 * Spec §17 writes the convention as `settings.editor.lineWrap.label`. The strings module nests those under a
 * `fields` object, so the segment is dropped when the key is formed. Only the key changes; the TypeScript
 * path keeps `fields`.
 */
export function remapSettingsFields(keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(keys)) {
    out[key.startsWith("settings.fields.") ? `settings.${key.slice("settings.fields.".length)}` : key] = value;
  }
  return out;
}

/**
 * Dotted keys -> the nested object `en.json` holds. A key that is both a translation and the parent of
 * another key cannot be represented — JSON and i18next each allow only one — so it is a loud ERROR.
 * Do not "fix" this by letting the last writer win: the naive version replaced the string leaf with `{}`
 * and destroyed that translation with no output at all, which is the worse failure of the two.
 */
export function nest(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const key of Object.keys(flat).sort()) {
    const segments = key.split(".");
    let node = root;
    for (const [depth, segment] of segments.slice(0, -1).entries()) {
      const existing = node[segment];
      if (typeof existing === "string") {
        throw new Error(
          `i18n key collision: "${segments.slice(0, depth + 1).join(".")}" is already a translation, ` +
            `so "${key}" cannot nest under it. Rename one of the two.`,
        );
      }
      if (typeof existing !== "object" || existing === null) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    const existing = node[leaf];
    if (typeof existing === "object" && existing !== null) {
      throw new Error(
        `i18n key collision: "${key}" is already a group of keys, so it cannot also be a translation. ` +
          `Rename one of the two.`,
      );
    }
    node[leaf] = flat[key] as string;
  }
  return root;
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Everything below runs only when this file is the entry point. Without the guard, the unit test's
 * `import { nest, plainLeaves, remapSettingsFields } from "../scripts/i18n-extract"` regenerates
 * `keys.json` and `coverage.json` as a side effect of `bun test` — measured, it printed
 * "i18n: keys.json now records 2 keys" from the test run. That is not merely untidy: from Task 11 on,
 * `keys.json` is the committed manifest the key check diffs `en.json` against, so a test that silently
 * rewrites it would let any unreviewed key change sail through the very check the manifest exists for.
 */
if (import.meta.main) {
  // The `--from <module>` migration mode is gone: it existed to merge a module that still held English literals
  // into en.json, and after Task 11 no such module remains. What is left is the permanent path -- regenerating
  // the manifest and the coverage record from the locale files -- which is what the key check's failure message
  // tells you to run.
  const enPath = join(LOCALES_DIR, `${SOURCE_LOCALE}.json`);
  const en = readJson(enPath);
  const enKeys = flattenKeys(en);
  writeJson(join(I18N_DIR, "keys.json"), enKeys);

  const enFlat = plainLeaves(en);
  const coverage: Record<string, number> = {};
  for (const locale of LOCALES) {
    if (locale === SOURCE_LOCALE) continue;
    const flat = plainLeaves(readJson(join(LOCALES_DIR, `${locale}.json`)));
    // A string copied verbatim from English is not a translation.
    coverage[locale] = Object.entries(flat).filter(([key, value]) => value !== enFlat[key]).length;
  }
  writeJson(join(I18N_DIR, "coverage.json"), coverage);
  console.log(`i18n: keys.json now records ${enKeys.length} keys`);
}
