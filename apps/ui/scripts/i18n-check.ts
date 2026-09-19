import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { COMMANDS, commandTitleKey, LOCALES } from "@jslab/shared";
import { checkLocales, MIN_KEYS, type SourceFile } from "../src/i18n/check";

const UI_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(UI_ROOT, "..", "..");
const I18N_DIR = join(UI_ROOT, "src", "i18n");
const LOCALES_DIR = join(I18N_DIR, "locales");

/**
 * While the extraction sweep (Tasks 8-11) was still producing the real catalogue, `en.json` was a seed of a few
 * keys, so the size floor, the committed manifest and the unused-key sweep could not be true yet. `--bootstrap`
 * skips exactly those three and nothing else: the unknown-key check, the per-locale `extra` check and the
 * coverage ratchet ran from day one. Task 11 completed the catalogue and dropped the flag from `package.json`
 * and from CI, so the default run is now full strength; the flag remains only for a partial local tree.
 */
const bootstrap = process.argv.includes("--bootstrap");
const strict = process.argv.includes("--strict");

function sourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "locales") walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push({ path: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const locales = Object.fromEntries(LOCALES.map((locale) => [locale, readJson(join(LOCALES_DIR, `${locale}.json`))]));
const manifest = bootstrap ? [] : (readJson(join(I18N_DIR, "keys.json")) as string[]);
const coverage = readJson(join(I18N_DIR, "coverage.json")) as Record<string, number>;

const report = checkLocales({
  locales,
  manifest,
  coverage,
  // Command titles are looked up as `t(commandTitleKey(id))`, which no source scan can see. The id list is the
  // authority on which keys those are, so they are derived from it rather than enumerated by hand.
  derivedKeys: COMMANDS.map((command) => commandTitleKey(command.id)),
  // Both trees, because Main reads the very same files the UI ships (spec §17).
  sources: [...sourceFiles(join(UI_ROOT, "src")), ...sourceFiles(join(REPO_ROOT, "apps", "desktop", "src"))],
});

const problems: string[] = [];

// Always checked: a key asked for but never shipped renders as the raw key -- in Main that means a window
// titled `app.settingsWindowTitle`, because its t() falls back to the key itself.
for (const key of report.unknownKeys) problems.push(`t('${key}') has no entry in en.json`);

if (!bootstrap) {
  if (report.enKeys.length < MIN_KEYS) {
    problems.push(`en.json has ${report.enKeys.length} keys, fewer than the expected minimum ${MIN_KEYS}`);
  }
  if (report.enKeys.length !== manifest.length) {
    problems.push(`en.json has ${report.enKeys.length} keys; keys.json records ${manifest.length}`);
  }
  for (const key of report.manifestDrift.added) problems.push(`key not in keys.json: ${key}`);
  for (const key of report.manifestDrift.removed) problems.push(`key in keys.json but gone from en.json: ${key}`);
  for (const key of report.unusedKeys) problems.push(`en.json key is never used: ${key}`);
}

for (const entry of report.locales) {
  for (const key of entry.extra) problems.push(`${entry.locale}.json has a key en.json does not: ${key}`);
  if (entry.translated < entry.recorded) {
    problems.push(`${entry.locale}.json translation coverage fell from ${entry.recorded} to ${entry.translated}`);
  }
  if (strict && entry.missing.length > 0) {
    problems.push(`--strict: ${entry.locale}.json is missing ${entry.missing.length} keys`);
  }
}

const summary = report.locales.map((entry) => `${entry.locale} ${entry.translated}/${report.enKeys.length}`).join("  ");
console.log(`i18n: ${report.enKeys.length} keys in en.json${bootstrap ? " (bootstrap)" : ""}`);
console.log(`i18n: coverage  ${summary}`);

if (problems.length > 0) {
  console.error(`\ni18n check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nSee docs/user/translating.md for what each of these means and how to fix it.");
  process.exit(1);
}
console.log("i18n: ok");
