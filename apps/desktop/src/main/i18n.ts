import { join } from "node:path";
import { type Locale, SOURCE_LOCALE } from "@jslab/shared";
import { readBoundedTextSync } from "./fs/bounded-read";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface TranslatorOptions {
  /** `AppPaths.localesDir`: Resources/app/locales in a packaged build. */
  dir: string;
  locale: Locale;
  /** Injectable for tests; defaults to the shared bounded reader, capped at `MAX_LOCALE_FILE_BYTES`. */
  read?: (path: string) => string;
}

/**
 * A locale file is JSLab's own shipped JSON (`Resources/app/locales`, or `JSLAB_LOCALES_DIR` in dev and tests). The
 * five seeded files are under 100 bytes each, and the Phase B extraction sweep grows them by keys rather than by
 * orders of magnitude, so this is a real refusal and not a waiver wearing a number -- the same bound
 * `MAX_SETTINGS_BYTES` and `MAX_DOTENV_BYTES` put on JSLab's other small owned files.
 *
 * Reading these through `readBoundedTextSync` rather than a bare `readFileSync` is required by
 * `test/fs/no-unbounded-reads.test.ts`: the bundle directory is user-writable, so the size bound is only half the
 * point -- the reader's `O_NONBLOCK` open and `isFile` check are what keep a FIFO at `<lng>.json` from parking Main
 * forever while the window and the native menu are being built.
 */
const MAX_LOCALE_FILE_BYTES = 1024 * 1024;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Replaces `{{name}}`. An unknown placeholder is left verbatim, so a gap shows up in a bug report. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

function lookup(table: Record<string, unknown> | null, key: string): string | null {
  if (!table) return null;
  let node: unknown = table;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  // A key naming an interior node ("menu") resolves to an object: that is a miss, not a value. Returning it
  // would hand a non-string to `interpolate` and throw while the menu is being built.
  return typeof node === "string" ? node : null;
}

function load(dir: string, locale: Locale, read: (path: string) => string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(read(join(dir, `${locale}.json`)));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A missing or corrupt locale file costs a translation, never the app: this runs while the window and
    // the native menu are being built.
    return null;
  }
}

/**
 * Spec §17's "small `t()` in Main". Reads the same `<lng>.json` files the UI ships (see `AppPaths.localesDir`),
 * falls back to `en` key by key, and returns the key itself when neither locale has it -- a visible mistake
 * rather than an invisible blank menu item.
 *
 * Plurals use the same `_one` / `_other` suffixes i18next does, so one set of locale files serves both sides.
 * Only English plural rules are applied here, which is all Main's seven pluralized strings need; a locale with
 * richer rules supplies `_other` and the UI side (real i18next) handles its own.
 *
 * Both files are read once, here, rather than per call: `t()` is called once per menu item on every menu rebuild.
 */
export function createTranslator(options: TranslatorOptions): Translate {
  const read = options.read ?? ((path: string) => readBoundedTextSync(path, MAX_LOCALE_FILE_BYTES));
  const primary = load(options.dir, options.locale, read);
  const fallback = options.locale === SOURCE_LOCALE ? primary : load(options.dir, SOURCE_LOCALE, read);

  return (key, vars = {}) => {
    // The plural form is tried first, then the plain key -- a counted string need not be pluralized.
    const candidates = typeof vars.count === "number" ? [`${key}_${vars.count === 1 ? "one" : "other"}`, key] : [key];
    for (const table of [primary, fallback]) {
      for (const candidate of candidates) {
        const value = lookup(table, candidate);
        if (value !== null) return interpolate(value, vars);
      }
    }
    return key;
  };
}
