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
  /**
   * Keys that no literal call site can ever show, because the key is computed: the 114 command titles are read as
   * `t(commandTitleKey(id))`, whose argument is computed. `COMMANDS` is the authority on which keys those are, so
   * the caller derives them from it and passes them here. Without this every command title reads as unused the
   * moment Task 11 drops `--bootstrap`, and the check would demand the deletion of the entire `commands.*` group.
   */
  derivedKeys?: readonly string[];
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
 * A floor, not a census. Its job is to fail the check when it reads an empty or wrong-path catalogue -- the one
 * failure that would otherwise look exactly like success.
 *
 * It was 464 through Phase B -- what the two string modules measured when that phase began (420 leaves in
 * `apps/ui/src/strings.ts` plus 44 in `apps/desktop/src/main/strings.ts`, the latter now 63). The sweep finished
 * at 760, so a 464 floor sat 296 keys below reality and would have sat silent through a catalogue that lost a
 * third of itself.
 *
 * Ratcheted to 700 here because `keys.json` does NOT already cover this case. The manifest catches a drop in
 * en.json alone, loudly and by name. What it cannot catch is a regeneration from a truncated or wrong-path tree,
 * because `bun scripts/i18n-extract.ts` rewrites the manifest FROM en.json -- the two then agree perfectly at any
 * size, every drift list is empty, and the floor is the only check left standing. That is precisely the failure
 * this constant exists for.
 *
 * Still a floor and not a census: 700 leaves ~60 keys of headroom, so legitimately deleting a control does not
 * force an edit here, while a collapse cannot pass. `keys.json` remains what pins the exact set.
 */
export const MIN_KEYS = 700;

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

/**
 * CLDR's six plural categories, which are the suffixes i18next appends.
 *
 * A plural form is never written at a call site and its base key is never in `en.json`:
 * `t("shell.runState.settled", { count })` is served by `settled_one` / `settled_other`. Matched naively,
 * every plural in the catalogue reads as BOTH an unknown key (the base) and a pair of unused ones (the
 * forms) -- measured, 9 of each the first time the sweep introduced them. English only ever ships `_one`
 * and `_other`, but a locale with richer rules supplies the rest, so all six are matched here.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const pluralBase = (key: string): string => key.replace(PLURAL_SUFFIX, "");

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
  // A derived key is asked for exactly as a literal one is; it simply cannot be seen by scanning source text.
  // Both lists feed both directions: a derived key with no entry is still unknown, and an entry a derived key
  // asks for is still used.
  const asked = [...new Set([...collectUsedKeys(input.sources), ...(input.derivedKeys ?? [])])].sort();

  const manifestDrift = {
    added: without(enKeys, input.manifest),
    removed: without(input.manifest, enKeys),
  };
  // A used key is satisfied by its own entry OR by that entry's plural forms; a plural form is used when
  // its base key is. Both directions are needed: the first keeps `t("env.saved")` from reading as unknown,
  // the second keeps `env.saved_one` / `env.saved_other` from reading as unused once Task 11 drops
  // `--bootstrap` and the unused-key sweep starts biting.
  const enKeysAndBases = new Set([...enKeys, ...enKeys.map(pluralBase)]);
  const usedSet = new Set(asked);
  const unknownKeys = asked.filter((key) => !enKeysAndBases.has(key));
  const unusedKeys = enKeys.filter((key) => !usedSet.has(key) && !usedSet.has(pluralBase(key)));

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
