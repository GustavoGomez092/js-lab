import { LOCALES, SOURCE_LOCALE } from "@jslab/shared";

export interface SourceFile {
  path: string;
  text: string;
}

export interface LocaleReport {
  locale: string;
  /** In `en`, absent here. Reported, not fatal: spec §17 says missing keys fall back to `en`. */
  missing: string[];
  /** Here, absent from `en`: a typo or a key whose control was deleted. Always fatal. */
  extra: string[];
  translated: number;
  recorded: number;
}

export interface CheckInput {
  locales: Record<string, unknown>;
  sources: readonly SourceFile[];
  manifest: readonly string[];
  coverage: Record<string, number>;
}

export interface CheckReport {
  enKeys: string[];
  manifestDrift: { added: string[]; removed: string[] };
  unknownKeys: string[];
  unusedKeys: string[];
  locales: LocaleReport[];
  ok: boolean;
}

/**
 * The measured size of the two string modules this milestone sweeps: 420 leaves in `apps/ui/src/strings.ts`
 * plus 44 in `apps/desktop/src/main/strings.ts`, counted by importing both and walking their exports. The real
 * catalogue only grows from here, so a total below this means the check read the wrong path or an empty file --
 * the one failure that would otherwise look exactly like success.
 */
export const MIN_KEYS = 464;

/**
 * A call to the translator with a literal key, including a wrapped `t(\n  'some.key'\n)`. The lookbehind is
 * what stops `format(` and `split(` -- and the member call `i18next.t(` -- from reading as the translator. A
 * dynamic key is deliberately not matched: there is nothing static to check it against.
 */
const CALL_SITE = /(?<![\w$.])t\(\s*"([^"\\]+)"/g;

export function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [];
  const keys: string[] = [];
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof child === "string") keys.push(path);
    else keys.push(...flattenKeys(child, path));
  }
  return keys.sort();
}

export function collectUsedKeys(sources: readonly SourceFile[]): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    for (const match of source.text.matchAll(CALL_SITE)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

const without = (from: readonly string[], other: readonly string[]): string[] => {
  const set = new Set(other);
  return from.filter((key) => !set.has(key));
};

function valueAt(table: unknown, key: string): string | null {
  let node: unknown = table;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : null;
}

export function checkLocales(input: CheckInput): CheckReport {
  const source = input.locales[SOURCE_LOCALE];
  const enKeys = flattenKeys(source);
  const enValues = new Map<string, string>();
  for (const key of enKeys) enValues.set(key, valueAt(source, key) ?? "");
  const used = collectUsedKeys(input.sources);

  const manifestDrift = {
    added: without(enKeys, input.manifest),
    removed: without(input.manifest, enKeys),
  };
  const unknownKeys = without(used, enKeys);
  const unusedKeys = without(enKeys, used);

  const locales: LocaleReport[] = LOCALES.filter((locale) => locale !== SOURCE_LOCALE).map((locale) => {
    const table = input.locales[locale];
    const keys = flattenKeys(table);
    return {
      locale,
      missing: without(enKeys, keys),
      extra: without(keys, enKeys),
      // A key copied verbatim from English is not a translation; counting it as one would let the coverage
      // gate be satisfied by pasting en.json into ja.json. Nor is a key English does not have: coverage
      // measures progress against the source catalogue, so a stray key must not inflate it.
      translated: keys.filter((key) => {
        const value = valueAt(table, key);
        return value !== null && enValues.has(key) && value !== enValues.get(key);
      }).length,
      recorded: input.coverage[locale] ?? 0,
    };
  });

  const ok =
    enKeys.length >= MIN_KEYS &&
    enKeys.length === input.manifest.length &&
    manifestDrift.added.length === 0 &&
    manifestDrift.removed.length === 0 &&
    unknownKeys.length === 0 &&
    unusedKeys.length === 0 &&
    locales.every((entry) => entry.extra.length === 0 && entry.translated >= entry.recorded);

  return { enKeys, manifestDrift, unknownKeys, unusedKeys, locales, ok };
}
