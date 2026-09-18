# Translating JSLab

JSLab ships in English, Spanish, Japanese, Chinese and Portuguese. This page explains how to correct a
translation or add a language.

## Where the files are

Every user-visible string lives in `apps/ui/src/i18n/locales/<lng>.json`, keyed by a dotted, namespaced path
such as `settings.editor.lineWrap.label`. `en.json` is the source catalogue that every other file is measured
against. The Japanese, Spanish, Chinese and Portuguese files are written by people.

A key missing from your language falls back to English, so a partial translation is genuinely useful — you do
not have to finish a language before opening a pull request.

## Correcting or adding a translation

1. Find the key in `en.json`.
2. Add or edit the same key in `<lng>.json`, keeping the nesting identical.
3. Keep every `{{placeholder}}` exactly as it appears in English. They are filled in at runtime, and a renamed
   or dropped placeholder shows up as literal `{{name}}` text in the app.
4. Run `bun run i18n:check`.

### What the check enforces

`bun run i18n:check` is the same command CI runs, and it fails on:

- a key in your file that English does not have — almost always a typo or a key whose control was deleted;
- a `t("…")` call in the app with no entry in `en.json`, which would otherwise render as the raw key;
- a drop in the number of translated strings in your language, recorded in `apps/ui/src/i18n/coverage.json`.

A string copied verbatim from English does not count as translated, so pasting `en.json` into another file
cannot satisfy the coverage number. When you add translations, raise your language's count in `coverage.json`
in the same pull request — the check only refuses to let it fall.

### Plurals

Keys ending in `_one` and `_other` are plural forms, chosen by a `count` value:

```json
{ "tabsDropped_one": "{{count}} tab was skipped", "tabsDropped_other": "{{count}} tabs were skipped" }
```

Languages that do not distinguish plurals need only `_other`; Japanese and Chinese use that form alone.
Languages with more categories may add `_zero`, `_two`, `_few` or `_many` — i18next selects the right one from
the language's CLDR rules.

## Adding a new language

1. Add its code to `LOCALES` in `packages/shared/src/locale.ts` and to `UI_LANGUAGES` in
   `packages/shared/src/settings.ts`.
2. Create `apps/ui/src/i18n/locales/<lng>.json` and import it in `apps/ui/src/i18n/index.ts`.
3. Add the language's own name to the `settings.options.uiLanguage` group — in its own language, as
   `Español` and `日本語` already are.
4. Add an entry for it to `apps/ui/src/i18n/coverage.json`.
5. Run `bun run i18n:check`.

## Things the app does not translate

- **Theme and font names** (`Graphite`, `Dracula`, `JetBrains Mono`) are proper nouns.
- **Values printed in the output panel** — `undefined`, `null`, `Invalid Date`, `[Object: null prototype]` —
  are JavaScript's own notation. Translating them would make the output disagree with the runtime that produced
  it.
- **Key names** such as `Space`, `Home` and `PgUp` label physical keys, which the UI language does not change.
  This is a known v1 limitation.

## Changing the language

Settings → General → Language. JSLab must be restarted for the change to take effect, and it tells you so.
