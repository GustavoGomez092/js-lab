# JSLab M5d: VS Code theme import and keybinding editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Themes → Import VS Code Theme… (a theme `.json` or a `.vsix`, converted onto JSLab's semantic token set with contrast fallbacks and saved under `<appdata>/themes/`) and Settings → Keybindings (a searchable table with key capture, conflict warnings, per-row reset and Open keybindings.json) on top of the `keybindings.json` mechanism M2 already shipped.

**Architecture:** The converter is pure and lives in `packages/themes` (spec §22.1 puts its tests there), turning a VS Code theme's `tokenColors` and `colors` into the existing `ThemeDefinition` — the same shape `buildTheme` already produces — so an imported theme reaches the Appearance picker, the Themes menu, the command palette and Monaco through the paths that already exist. A new user-theme registry in `packages/themes` is the single seam: `listThemes()`/`getTheme()` become aware of imported themes, and every one of those four surfaces follows with no further change. Main gains a `ThemeStore` over `<appdata>/themes/` and a deliberately minimal, read-only ZIP reader (`node:zlib`, no new dependency) that never extracts a `.vsix` to disk. For keybindings, M2's resolver, `keybindings.json` schema and default keymap are reused unchanged; what M5d adds is a **write** path (`KeybindingsStore.save`), a **live** path (today's bindings are computed once at mount and never recomputed — see Finding K1), and a Settings → Keybindings pane that enumerates commands **dynamically**, never from a list this milestone maintains.

**Tech Stack:** Bun 1.4.0 (bundled) / 1.3.13 (dev), Electrobun 2.0.1, React 19, Zustand, Monaco 0.56.0, zod 4.6.4, `node:zlib`, bun:test, Biome 2.5.13.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md` — §9.1 (theme format and the semantic token set), §9.2 (built-ins), §9.3 (the VS Code importer), §6.5 (command registry, `keybindings.json`, Settings → Keybindings), §8 (the Settings window's tabs), §4.5 (app data layout), §18 (RPC validation), §22.1 (where the converter is tested), §22.3 (E2E), §22.4 (the parity gate).

---

## Global Constraints

Exact values copied verbatim from the spec. Every task's requirements implicitly include this section.

- **Clean room.** Never read, unpack or inspect RunJS binaries, `app.asar`, bundled JS, or `/Applications/RunJS.app`. Parity comes from the spec and public docs only.
- **Spec §9.3, the conversion contract, verbatim:**
  - "`tokenColors` TextMate scopes are mapped to Monaco token rules using a scope-to-token table."
  - "`colors` are passed to Monaco `colors`, and UI variables are derived from `editor.background`, `sideBar.background`, `activityBar.background`, `statusBar.background`, `focusBorder`, `errorForeground`, and so on, with contrast fallbacks."
  - "The result is saved to `<appdata>/themes/` and shows up in the Themes menu immediately."
  - "Invalid files produce a readable error."
  - Accepted inputs: "A theme `.json` file (with `tokenColors` and `colors`)." and "A `.vsix` file: JSLab extracts `extension/package.json` `contributes.themes` and lets the user pick a theme."
- **Spec §9.1, the token set that every imported theme must fill** (34 names, and the importer invents none): `bg.canvas`, `bg.chrome`, `bg.elevated`, `bg.hover`, `bg.selection`, `bg.activeRow`, `bg.errorRow`, `bg.errorRowHover`, `bg.lineHover`, `bg.lineHighlight`, `bg.accentMuted`, `bg.scrim`; `border.default`, `border.muted`, `border.accent`; `fg.default`, `fg.muted`, `fg.accent`, `fg.onAccent`, `fg.success`, `fg.warn`, `fg.error`, `fg.info`; `console.result`, `console.log`, `console.info`, `console.warn`, `console.error`; and `syntax.comment`, `syntax.keyword`, `syntax.string`, `syntax.number`, `syntax.type`, `syntax.function`. The authority in code is `TOKEN_NAMES` in `packages/themes/src/tokens.ts`; never retype the list.
- **Spec §9.1, the contrast bar, verbatim:** "Each token is a CSS variable (`bg.canvas` → `--bg-canvas`), the Monaco theme is built from the same tokens, and every text token meets WCAG AA on each surface it is drawn on." AA is 4.5 (`AA` in `packages/themes/src/contrast.ts`). **This applies to imported themes exactly as it applies to the 21 built-ins.**
- **Spec §9.1, verbatim:** "The M5 VS Code importer and `*.jslab-theme.json` files map onto this token set."
- **Spec §4.5, verbatim:** `themes/` is "user-imported themes (`*.jslab-theme.json`)" under the app data root, which is `~/Library/Application Support/dev.jslab.app/<channel>/`.
- **Spec §22.1, verbatim:** "**`packages/themes`:** the VS Code converter against 10 real theme fixtures (contrast and required tokens)." The converter is therefore pure and lives in `packages/themes`; nothing there may import `node:*`.
- **Spec §6.5, Settings → Keybindings, verbatim:**
  - "A searchable table: Command, Keybinding, When, Source (Default/User)."
  - "A key-capture editor that warns on conflicts."
  - "\"Reset to default\" per row."
  - "\"Open keybindings.json\"."
- **Spec §6.5, the override format, verbatim:** "**User overrides** are stored in `keybindings.json` as `[{ "key": "cmd+shift+enter", "command": "run.start", "when": "editorFocus" }, { "key": "cmd+k", "command": "-output.clear" }]`. The format is VS Code-style; a leading `-` removes a binding." **This shipped in M2 and must not be redesigned.**
- **Spec §8, verbatim:** "The Settings window has these tabs: **General · Editor · Formatting · Appearance · Keybindings · AI · NPM · Build · Advanced**." M5d adds **Keybindings** only; the AI tab belongs to M5's AI plan.
- **Spec §18, verbatim:** "Every inbound payload is zod-validated in Main; path parameters are normalized; there is no generic \"exec\" or \"read any file\" endpoint for the UI." Every new UI-reachable entry point goes through `createValidators`' `parse`/`message` (`apps/desktop/src/main/rpc/validate.ts`), and names must be unique across merged handler groups (`mergeHandlers` throws on a duplicate).
- **No new runtime dependency.** M4's standing constraint. A `.vsix` is a zip and the repo has no zip library; Task 5 justifies `node:zlib` against this constraint rather than adding one.
- **Never modify** `~/.zshrc`, `~/.npmrc`, `~/.bunfig.toml`, the Bun cache, or anything under `~/Library`. Never run the hutch installer, `hutch init` or `hutch upgrade`.
- **Never contact the public npm registry in tests.** Loopback Verdaccio only (`@jslab/test-registry`), and M5d needs none of it.
- **No personal paths** (`/Users/...`, `/Volumes/...`) in any committed file.
- **Commit hygiene:** one commit per task unless a task says otherwise, staged explicitly. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY`

### Environment facts every task's test steps must get right

These are not suggestions; each one has silently produced a false pass or a false failure in this repo.

- **This worktree has no `node_modules`.** `bun run test` here fails with `Cannot find module '@jslab/shared'` — that is missing installation, not a broken suite. Install before the first task and **measure your own baseline**.
- **There is no trustworthy absolute test count in this plan, by design.** M4's own self-review concluded: "A task section's absolute total is a historical estimate, not a requirement. Every implementer measures its own baseline before changing anything and reports `baseline N → after M`." Each task below states only its **delta**. A count that disagrees with this plan is information about the plan; **a test added to make a total match is a defect, not a fix.**
- **UI tests need the DOM preload.** `apps/ui/bunfig.toml` preloads `./test/setup-dom.ts`. A bare `bun test <path>` from the repo root skips it. Always: `cd apps/ui && bun test ./test/<file>`.
- **The two-Bun gate is easy to fake.** `bun14 run test` uses 1.4.0 only as the task runner; each package's script is `bun test ./test`, so the inner binary still comes from `PATH`. The real form is:
  `PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test`
- **Typecheck needs the devkit copied, and its parent does not exist in a fresh worktree.** Run `mkdir -p apps/desktop/.hutch` before the `cp -a`. Without it, typecheck exits 1 *without checking anything*.
- **Biome truncates diagnostics by default.** Use `bun run lint -- --max-diagnostics=300`.
- **`bun run e2e` does NOT build.** It drives whatever bundle is on disk. Any e2e step builds first (`cd apps/desktop && hutch run build:dev`), then runs. A stale bundle produces fast, confident, entirely misleading failures.
- **Never run a bare `bun test` at the repo root**; always `bun run test`.

---

## As-built survey

Read this before Task 1. Everything below was verified in this worktree at `30da6e3`; file paths and signatures are real and must be used rather than re-invented.

### How themes are defined and applied today

| Concern | Where | Signature / shape |
|---|---|---|
| Token names | `packages/themes/src/tokens.ts` | `TOKEN_NAMES` (34), `type TokenName`, `type ThemeTokens = Record<TokenName, string>` |
| Which surfaces each text token is drawn on | `packages/themes/src/tokens.ts` | `TEXT_SURFACES: Partial<Record<TokenName, TokenName[]>>`, and `CONTRAST_PAIRS: [TokenName, TokenName][]` flattened from it |
| CSS variable naming | `packages/themes/src/tokens.ts` | `cssVariableName(token)` → `--bg-canvas`; `toCssVariables(tokens)` → `Record<string,string>` |
| Colour maths | `packages/themes/src/contrast.ts` | `AA = 4.5`, `hexToRgb`, `rgbToHex`, `relativeLuminance`, `contrastRatio(a,b)`, `mix(a,b,t)`, `ensureContrast(fg, backgrounds, direction, min=AA)` |
| Theme construction | `packages/themes/src/build.ts` | `buildTheme(input: ThemeInput): ThemeDefinition`; `ThemeDefinition = { id, name, type, credit, tokens, monaco }`; `MonacoThemeData = { base: "vs"\|"vs-dark", inherit: true, rules, colors }` |
| Built-in palettes | `packages/themes/src/palettes.ts` | `THEME_INPUTS: readonly ThemeInput[]` (21) |
| Lookup | `packages/themes/src/index.ts` | `BUILTIN_THEMES`, `listThemes(): ThemeMeta[]`, `getTheme(id): ThemeDefinition`, `resolveThemeId(appearance, systemDark)` |
| CSS variables applied | `apps/ui/src/themes/apply.ts` | `applyThemeVariables(theme, root)`, `startThemeSync(store, { root, media })` |
| Theme commands | `apps/ui/src/themes/theme-commands.ts` | `createThemeCommands(store, api)` → `theme.select`, `theme.toggleFollowSystem` |

**How Monaco's theme API is already driven** — `apps/ui/src/editor/Editor.tsx:98-103`:

```ts
const applyMonacoTheme = (themeId: string) => {
  const theme = getTheme(themeId);
  monaco.editor.defineTheme(theme.id, theme.monaco as Monaco.editor.IStandaloneThemeData);
  monaco.editor.setTheme(theme.id);
};
applyMonacoTheme(initial.themeId);
```

and re-applied from the store subscription at `apps/ui/src/editor/Editor.tsx:364`:

```ts
if (state.themeId !== previous.themeId) applyMonacoTheme(state.themeId);
```

**Finding T1 — `getTheme` is the single seam, and it is closed over built-ins only.** `packages/themes/src/index.ts:21` builds `const BY_ID = new Map(BUILTIN_THEMES.map(...))` at module load. `getTheme` returns `BY_ID.get(id) ?? BY_ID.get(DEFAULT_DARK_THEME)`. Four separate surfaces already call `listThemes()`/`getTheme()`:

- the Appearance picker's `theme` field — `apps/ui/src/settings/SettingsApp.tsx:322`
- the Themes menu — `apps/desktop/src/main/index.ts:444` feeding `buildMenu`'s `model.themes` (`apps/desktop/src/main/menu.ts:240`)
- the command palette — `apps/ui/src/palette/items.ts:29`
- Monaco and the CSS variables — `Editor.tsx:99` and `apply.ts` via `startThemeSync`

**Teaching `listThemes`/`getTheme` about user themes (Task 4) makes an imported theme appear in all four with no edits to any of them.** That is the whole leverage of this milestone's theming half; do not thread an "imported theme" parameter through four call sites instead.

**Finding T2 — `resolveThemeId` silently rewrites unknown ids to Graphite.** `packages/themes/src/index.ts:36-38` checks `BY_ID.has(...)` on every branch. Until Task 4 registers user themes, selecting an imported theme would be silently reverted to `graphite` and look like the import failed. Task 4 must land before Task 8 for this reason.

**Finding T3 — `commandForMenuAction` constrains theme ids.** `apps/desktop/src/main/menu.ts:93` accepts a `theme.select` argument only if it matches `/^[\w-]{1,64}$/`. Imported theme ids must be slugged to that character class or they will be unclickable in the Themes menu while working everywhere else.

### The command registry, the default keymap, and the `keybindings.json` override mechanism (all shipped in M2)

| Concern | Where | Signature |
|---|---|---|
| Command catalogue | `packages/shared/src/commands.ts` | `COMMANDS` (`as const satisfies readonly CommandMeta[]`), `type CommandId`, `commandMeta(id): CommandMeta \| undefined`, `isCommandId(v): v is CommandId`, `COMMAND_CATEGORY_ORDER`, `CommandMeta = { id, title, category, context?, palette? }` |
| Runtime registry | `apps/ui/src/commands/registry.ts` | `class CommandRegistry`: `register(...specs)`, `has(id)`, `get(id)`, `isEnabled(id)`, `execute(id, args)`, **`list(): CommandSpec[]`** |
| Chords | `packages/shared/src/keybindings.ts` | `parseChord(spec): KeyChord`, `isValidChord(spec)`, `keyForCode(code)`, `chordFromEvent(event: KeyLike)`, `chordsEqual(a,b)`, `chordToSpec(chord)`, `formatChord(chord)`, `formatChordParts(chord): string[]` |
| Override file | `packages/shared/src/keybindings.ts` | `KeybindingRule = { key: string; command: string; when?: string }`, `keybindingRuleSchema`, `keybindingsFileSchema` (drops invalid entries; a non-array file means no overrides) |
| Default keymap | `packages/shared/src/keybindings.ts` | `DEFAULT_KEYBINDINGS: readonly KeybindingRule[]` (67 rules) |
| Resolution | `packages/shared/src/keybindings.ts` | `resolveKeybindings(defaults, overrides): ResolvedBinding[]`, `shortcutFor(bindings, command): KeyChord \| null`; `ResolvedBinding = { chord, key, command, when?, source: "default" \| "user" }` |
| Dispatch | `apps/ui/src/keybindings/resolver.ts` | `class KeybindingResolver`: `setBindings(bindings)`, `resolve(event, context): CommandId \| null`; `contextFromState(state, activeElement, editorHasFocus): UiContext` |
| Reading the file | `apps/desktop/src/main/services/keybindings-store.ts` | `KeybindingsStore.open(dataDir): Promise<KeybindingsStore>` → `{ path, rules: KeybindingRule[], invalid: boolean }` |

The wire today: `apps/desktop/src/main/index.ts:211` opens the store → `apps/desktop/src/main/rpc-handlers.ts:53` puts `keybindings` on the `app.bootstrap` payload → `apps/ui/src/state/store.ts:380` `hydrate` sets `state.keybindings` → `apps/ui/src/shell/App.tsx:217` resolves them.

**Finding K1 — the bindings are computed once and can never change. This is the blocking defect for an editing UI, and Task 9 exists solely to fix it.** Three independent freezes:

1. `apps/ui/src/shell/App.tsx:217` —
   ```ts
   const bindings = useMemo(() => resolveKeybindings(DEFAULT_KEYBINDINGS, store.getState().keybindings), [store]);
   ```
   The dependency array is `[store]`, and the store's identity never changes, so this memo runs **once at mount**. It reads state imperatively inside a memo that does not subscribe to it.
2. `apps/ui/src/state/store.ts` — `keybindings` is written **only** by `hydrate` (line 380). There is no action that updates it.
3. `apps/desktop/src/main/index.ts:437` — `const resolvedBindings = resolveKeybindings(DEFAULT_KEYBINDINGS, keybindings.rules);` is computed once at startup and captured by the menu builder's closure, so every menu keycap is frozen too.

Consequently a saved binding could not take effect before a relaunch. **Do not build the pane on top of this and discover it at the end.**

**Finding K2 — `KeybindingsStore` is read-only.** It has `open` and nothing else; there is no write path, no `onChange`, and no atomic-write use. Task 9 adds `save`, reusing `writeFileAtomic` (`apps/desktop/src/main/persistence/atomic-write.ts`, `{ backup?, mode?, shouldCommit? }`) exactly as `SettingsStore` and the `.npmrc` handlers do.

**Finding K3 — the resolver is already wired to react; only its input is frozen.** `apps/ui/src/shell/App.tsx:271` is `useMemo(() => new KeybindingResolver(bindings), [bindings])`, so the moment `bindings` becomes reactive (Finding K1) the resolver is rebuilt correctly with no further change. `KeybindingResolver.setBindings` (`apps/ui/src/keybindings/resolver.ts:39`) exists and is never called; Task 9 **does not** need it, and adding a call would be a second mechanism for something the memo already does. Leave it unused.

### Does a Settings UI surface already exist, and where does a Keybindings pane mount?

**Yes — a complete, separate Settings window.**

- Entry point `apps/ui/src/settings/settings-main.tsx` renders `SettingsApp` into `apps/ui/src/settings.html`; Main creates the window at `apps/desktop/src/main/index.ts:477` with its own `settingsRpc`.
- `apps/ui/src/settings/SettingsApp.tsx` renders a vertical `role="tablist"` from `SETTINGS_TABS` and a field list from `fieldsFor(tab, query)`.
- `apps/ui/src/settings/fields.ts` — `type SettingsTab = "general" | "editor" | "formatting" | "appearance" | "npm" | "build" | "advanced"` (**7 tabs; no `keybindings`**), `SETTINGS_TABS`, `SETTINGS_FIELDS: FieldDef[]`, `fieldsFor(tab, query)`, `coerceFieldValue(field, raw)`.
- Its own narrower RPC: `SettingsWindowRequests` = `settings.get`, `settings.update`, `fonts.list`, `npmrc.get`, `npmrc.save`, `npmrc.reset` (`packages/rpc-schema/src/ui-rpc.ts:309`); messages `app.command` (restricted to `SETTINGS_APP_ACTIONS`) and `e2e.response`; view messages `settings.changed`, `e2e.request`.
- Its own E2E agent: `apps/ui/src/settings/settings-agent.ts`, driven from scenarios by `app.settingsCommand(id, args)` / `app.settingsState()` (`packages/e2e/src/app.ts:263-267`).

**Where the pane mounts:** exactly where the `.npmrc` editor does. `SettingsApp.tsx:174` renders a non-field pane with

```tsx
{!query && tab === "npm" && ( <NpmrcEditor api={api} ... /> )}
```

so the Keybindings pane is a sibling `{!query && tab === "keybindings" && <KeybindingsPane ... />}`. `NpmrcEditor.tsx` is the working precedent for a non-field settings pane with its own imperative handle, confirm-then-commit buttons and status line — follow it.

**Finding S1 — the command registry lives in the main window, not in Main and not in the Settings window.** It is constructed inside `App.tsx`'s `useMemo` (line 227). The Settings window therefore cannot call `registry.list()` directly, which is why Task 10 puts a catalogue on the Settings RPC rather than reaching for the registry object. Note that `App.tsx:368` already publishes `registeredCommands: () => registry.list().map((spec) => spec.id)` to the E2E agent — proof the enumeration exists and is cheap.

### The `<appdata>` path helper and how other user data is persisted

- `apps/desktop/src/main/app-paths.ts` — `resolveAppPaths(input: AppPathsInput): AppPaths`, where `dataDir = input.env.JSLAB_USER_DATA ?? input.userData` and every other location is `join(dataDir, ...)`. **`AppPaths` has no `themesDir`; Task 7 adds one.** The doc comment is explicit: "Every filesystem location Main uses… If the M0-S1/S3 report records a different copy destination, change only this function."
- `keybindings.json` is **not** on `AppPaths` either; `KeybindingsStore.open` joins it itself (`join(dataDir, "keybindings.json")`). Task 9 leaves that as it is rather than moving it.
- Atomic writes: `apps/desktop/src/main/persistence/atomic-write.ts` — `writeFileAtomic(path, data, { backup?, mode?, shouldCommit? })`, temp file + `fsync` + rename.
- Load-with-recovery: `apps/desktop/src/main/persistence/json-store.ts` — `loadJson(path, parser, fallback)` returning `{ value, recovered, primary, corruptCopy }`, plus `createDebouncedWriter`.
- Models to imitate: `SettingsStore` (`services/settings-store.ts`, queued writes + `flush()` + `onChange`) and `createNpmrcHandlers` (`rpc/npmrc-handlers.ts`, a small read/write/reset handler group with `mode: 0o600`).

### What the repo can already do with zip archives

**Nothing.** Verified:

- `git grep -lE "zip|unzip|archive"` across `apps/` and `packages/` matches exactly one file — `packages/test-registry/src/fixtures.ts` — and that is **tar**, not zip, spawned as the system binary for npm test fixtures.
- `bun.lock` contains no `fflate`, `jszip`, `adm-zip`, `yauzl` or `unzipper` (grep count 0).
- `node:zlib` **is** already used in-repo: `apps/desktop/scripts/app-icon.ts:1` — `import { deflateSync } from "node:zlib"`.
- Confirmed on the bundled Bun 1.4.0 in this worktree: `zlib.inflateRawSync` round-trips, and `zlib.crc32` is a function.

**Ruling R-M5D-ZIP-1 — no new dependency; implement a minimal read-only ZIP reader on `node:zlib`.** Justified against the standing "No new runtime dependency" constraint:

1. A `.vsix` needs only two members read (`extension/package.json` and one theme JSON), never a full extraction. That is a central-directory walk plus `inflateRawSync` — roughly 120 lines, methods `stored` (0) and `deflate` (8) only.
2. A general-purpose zip library is a *larger* attack surface for this job, not a smaller one, and shelling out to `/usr/bin/unzip` would hand path handling to a process we cannot make fail closed. Writing the reader is what lets Task 5 enforce zip-slip rejection, entry-count, per-entry size, total-size and compression-ratio caps as first-class, tested behaviour.
3. It keeps the UI bundle untouched: the reader is Main-only (`node:zlib`), while `packages/themes` — which the UI imports — stays pure.

### Parity rows that belong to M5d

Determined by reading `docs/parity.md`, not guessed. M5's full row set is EX-14..16, EX-37, ED-20, OU-10, ST-08, ST-12, TL-12..23, XT-01..04, XT-08. **Three of those are M5d's, one of them only in part:**

| Row | Text | Status today | M5d's claim |
|---|---|---|---|
| **XT-01** | "Custom themes: VS Code theme importer (.json/.vsix), themes folder" — §9.3, M5, Verify `U, E` | ⬜ | **Fully M5d.** Flips to ✅ in Task 13. |
| **XT-02** | "Custom keybindings UI + `keybindings.json`" — §6.5, M2/M5, Verify `U, E` | 🚧 "keybindings.json overrides in M2; editing UI M5" | **The editing-UI half is M5d.** The M2 half already has `packages/e2e/scenarios/keybindings.test.ts` "keybindings.json overrides replace defaults (XT-02)". Flips to ✅ in Task 13. |
| **ST-01** | "Settings window with tabs (…)" — §8, M2, Verify `E` | 🚧 "General/Editor/Formatting/Appearance/Advanced in M2, NPM/Build in M3; Keybindings/AI M5" | **Only the Keybindings tab is M5d.** The row stays 🚧 after Task 13, with its note narrowed to "AI M5" — the AI tab belongs to M5's AI plan. **Do not flip this row to ✅.** |

Explicitly **not** M5d, despite sitting in M5: EX-14/15/16 and EX-37 (logpoints, transpiled output), ED-20 (Create Snippet…), OU-10 (entry menu / Explain Result), ST-08 (i18n), ST-12 (welcome tab), TL-12..23 (snippets, AI chat), XT-03 (CLI), XT-04 (Gist), XT-08 (Keychain).

ST-03 ("Theme picker + Themes menu with icons") is already ✅ from M2 and is **not** M5d's to claim — but Task 8's e2e scenario must show it has not regressed, because imported themes now flow through the same menu.

### A cross-plan interface this plan honours

**M5a (being written in parallel) adds new commands to the command registry — a logpoint toggle on `F9` and a clear-all on `Cmd+Shift+F9`.** M5d's keybindings editor therefore **enumerates commands dynamically and never from a hardcoded list**, so commands added by M5a — or by any later milestone — appear in the Settings → Keybindings table with **zero edits to M5d's code**.

Concretely, and stated here so no task quietly regresses it:

- The table's rows come from `COMMANDS` in `packages/shared/src/commands.ts`, which is the one catalogue every milestone must already add to (`isCommandId` gates `keybindingsFileSchema`, `resolveKeybindings`, `commandForMenuAction` and `CommandRegistry.has`, so a command that is not in `COMMANDS` cannot be bound, dispatched or menu-clicked at all).
- Live registration state is annotated from the main window's `CommandRegistry.list()` snapshot (Task 10), never re-derived.
- **Task 10 ships a regression test asserting the catalogue length equals `COMMANDS.length`.** When M5a lands `debug.toggleLogpoint` and `debug.clearLogpoints`, that test keeps passing only if the enumeration is genuinely dynamic — and both commands become bindable and resettable in the pane with no M5d change. If a future edit introduces a literal list, that test fails.
- M5d must **not** add F9 or `Cmd+Shift+F9` to `DEFAULT_KEYBINDINGS`; those rows are M5a's. M5d's conflict detection will simply see them once they exist.

---

## File Structure

**New**

| Path | Responsibility |
|---|---|
| `packages/themes/src/vscode/scopes.ts` | The TextMate-scope → Monaco-token table and `monacoRulesFrom(tokenColors)`. Pure data plus one function; no colour maths. |
| `packages/themes/src/vscode/derive.ts` | `colors` → `Palette`: the `editor.background` / `sideBar.background` / `activityBar.background` / `statusBar.background` / `focusBorder` / `errorForeground` derivation with contrast fallbacks. |
| `packages/themes/src/vscode/convert.ts` | `convertVsCodeTheme(input)`: validation, slugging, `buildTheme` reuse, readable errors. The one entry point Main calls. |
| `packages/themes/src/user-themes.ts` | The user-theme registry: `registerUserThemes`, and the lookup `listThemes`/`getTheme` consult. |
| `packages/themes/test/vscode-scopes.test.ts` | Scope-table tests. |
| `packages/themes/test/vscode-derive.test.ts` | Derivation + **the sparse-theme contrast test**. |
| `packages/themes/test/vscode-convert.test.ts` | Whole-file conversion, the 10 fixtures, readable errors. |
| `packages/themes/test/fixtures/` | 10 hand-written VS Code theme fixtures (spec §22.1). Authored here, never copied from a shipped product. |
| `packages/themes/test/user-themes.test.ts` | Registry precedence and fallback. |
| `apps/desktop/src/main/themes/zip.ts` | The minimal read-only ZIP reader: central-directory walk, `stored`/`deflate`, and every safety cap. |
| `apps/desktop/src/main/themes/vsix.ts` | `readVsixThemes(bytes)`: `extension/package.json` → `contributes.themes` → the chosen theme's JSON. |
| `apps/desktop/src/main/services/theme-store.ts` | `<appdata>/themes/`: load at startup, save a converted theme atomically, `onChange`. |
| `apps/desktop/src/main/rpc/theme-handlers.ts` | `theme.import` / `theme.importPick` handler group. |
| `apps/desktop/src/main/rpc/keybinding-handlers.ts` | `keybindings.get` / `keybindings.save` / `keybindings.reveal` handler group, served to the Settings window. |
| `apps/desktop/test/themes/zip.test.ts` | **The malicious-archive tests.** |
| `apps/desktop/test/themes/vsix.test.ts` | `contributes.themes` parsing and refusals. |
| `apps/desktop/test/services/theme-store.test.ts` | Store round-trip, recovery, bad files. |
| `apps/desktop/test/rpc/keybinding-handlers.test.ts` | Validation and save path. |
| `apps/ui/src/settings/KeybindingsPane.tsx` | The Settings → Keybindings table, its search box and its row actions. |
| `apps/ui/src/settings/key-capture.ts` | Capture state machine: arm, record, cancel, and what may not be bound. Pure, so it tests without a DOM. |
| `apps/ui/src/settings/keybinding-rows.ts` | `keybindingRows(catalogue, rules, query)`: the rows the table renders, plus conflict detection. Pure. |
| `apps/ui/test/key-capture.test.ts` | Capture and escape-hatch tests. |
| `apps/ui/test/keybinding-rows.test.ts` | Row building, search, conflicts, **the `COMMANDS.length` regression test**. |
| `apps/ui/test/keybindings-pane.test.tsx` | The pane, rendered. |
| `packages/e2e/scenarios/theme-import.test.ts` | XT-01 end to end. |
| `packages/e2e/scenarios/keybindings-ui.test.ts` | XT-02 (editing UI) end to end. |
| `docs/qa/m5d-checklist.md` | Manual QA for what a person must confirm. |

**Modified**

| Path | Change |
|---|---|
| `packages/themes/src/index.ts` | `listThemes`/`getTheme`/`resolveThemeId` consult the user-theme registry (Task 4); re-export the `vscode/` entry points. |
| `packages/shared/src/keybindings.ts` | `RESERVED_CHORDS` and `describeConflict` helpers only — the schema, defaults and resolver are untouched. |
| `packages/rpc-schema/src/ui-rpc.ts` | `theme.import*` on `MainRequests`; `keybindings.*` and `commands.catalog` on `SettingsWindowRequests`; `theme.changed` and `keybindings.changed` view messages; their zod schemas. |
| `apps/desktop/src/main/app-paths.ts` | `themesDir: join(dataDir, "themes")` on `AppPaths`. |
| `apps/desktop/src/main/services/keybindings-store.ts` | `save(rules)`, `onChange`, and the in-memory `rules` becoming mutable (Task 9). |
| `apps/desktop/src/main/index.ts` | Open the `ThemeStore`; register the two new handler groups; **recompute `resolvedBindings` and refresh the menu when keybindings change**; publish theme/keybinding changes to both windows. |
| `apps/desktop/src/main/menu.ts` | The Themes submenu gains "Import VS Code Theme…" and a separator. |
| `apps/ui/src/state/store.ts` | `setKeybindings(rules)`; `userThemes` on the bootstrap payload feeding `registerUserThemes`. |
| `apps/ui/src/shell/App.tsx` | **Finding K1's fix**: `bindings` subscribes instead of freezing; `resolver.setBindings` on change; publish the registry's ids to Main. |
| `apps/ui/src/settings/fields.ts` | `SettingsTab` gains `"keybindings"`, positioned per spec §8 (after Appearance). |
| `apps/ui/src/settings/SettingsApp.tsx` | Mount `KeybindingsPane` for the new tab, as `NpmrcEditor` is mounted for `npm`. |
| `apps/ui/src/settings/settings-rpc.ts` | `SettingsApi` gains the keybinding and catalogue calls. |
| `apps/ui/src/settings/settings-agent.ts` | New `keybindings.*` E2E command ids and snapshot fields. |
| `apps/ui/src/strings.ts` | Strings for the Keybindings tab, the pane and the importer. |
| `apps/desktop/src/main/strings.ts` | Log and error strings for the importer. |
| `apps/ui/src/styles.css` | `.keybindings` table styles, in the Graphite token vocabulary (`var(--bg-*)`, `var(--fg-*)`). |
| `apps/ui/test/fake-api.ts` | The new `MainApi` methods (it is `satisfies MainApi`, so it fails typecheck until updated). |
| `docs/parity.md` | XT-01, XT-02, and ST-01's note (Task 13). |
| `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, `README.md` | Status (Task 13). |

---

## Task index

Tasks 1–4 are pure and land in `packages/themes` with no app wiring. Tasks 5–8 make importing real. Task 9 unfreezes keybindings — **it is the prerequisite for the editor and must not be skipped or folded in**. Tasks 10–12 build the pane. Task 13 proves and documents.

| # | Task | Deliverable |
|---|---|---|
| 1 | The TextMate scope table | `monacoRulesFrom(tokenColors)` maps VS Code scopes to Monaco token rules. |
| 2 | UI derivation with contrast fallbacks | `paletteFromColors(colors, type)`; a sparse theme still produces a legible palette. |
| 3 | The converter | `convertVsCodeTheme` produces a `ThemeDefinition`; invalid input produces a readable error. |
| 4 | The user-theme registry | An imported theme is visible to `listThemes`/`getTheme`, so picker, menu, palette and Monaco all see it. |
| 5 | The safe ZIP reader | Central-directory reads with zip-slip, entry-count, size and ratio refusals. |
| 6 | `.vsix` theme extraction | `contributes.themes` parsed; one or many themes offered. |
| 7 | `ThemeStore` and `<appdata>/themes/` | Converted themes persist atomically and load at startup. |
| 8 | Themes → Import VS Code Theme… | Menu item, command, dialog, RPC, live application. |
| 9 | Keybindings become live and writable | Finding K1 fixed in all three places; `KeybindingsStore.save`; change broadcast. |
| 10 | The command catalogue on the Settings wire | Dynamic enumeration + the `COMMANDS.length` regression test that covers M5a. |
| 11 | The Keybindings table | Command / Keybinding / When / Source, searchable. |
| 12 | Key capture, conflicts and the reset paths | The escape hatch, the refusals, per-row reset, Open keybindings.json. |
| 13 | E2E, parity and docs | Two scenarios, the parity rows, the QA checklist. |

---

### Task 1: The TextMate scope table

**Files:**
- Create: `packages/themes/src/vscode/scopes.ts`
- Test: `packages/themes/test/vscode-scopes.test.ts`

**Interfaces:**
- Consumes: nothing. This task is pure data plus one function and has no dependencies.
- Produces, used by Task 3:

```ts
export interface VsCodeTokenColor {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}
export interface MonacoRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}
export const SCOPE_TO_MONACO: readonly (readonly [scope: string, token: string])[];
export function monacoTokenForScope(scope: string): string | null;
export function monacoRulesFrom(tokenColors: readonly VsCodeTokenColor[]): MonacoRule[];
export function syntaxColorsFrom(rules: readonly MonacoRule[]): Partial<Record<
  "comment" | "keyword" | "string" | "number" | "type" | "fn", string
>>;
```

`MonacoRule.foreground` is **bare hex without `#`**, matching what `monacoTheme` in `packages/themes/src/build.ts:119` already emits via its local `bare(hex)` helper, and what Monaco's `IStandaloneThemeData` expects.

- [ ] **Step 1: Write the failing test**

```ts
// packages/themes/test/vscode-scopes.test.ts
import { describe, expect, test } from "bun:test";
import { monacoRulesFrom, monacoTokenForScope, syntaxColorsFrom } from "../src/vscode/scopes";

describe("monacoTokenForScope", () => {
  test("matches the longest scope prefix and ignores unknown scopes", () => {
    expect(monacoTokenForScope("comment.line.double-slash.ts")).toBe("comment");
    expect(monacoTokenForScope("keyword.control.flow")).toBe("keyword");
    expect(monacoTokenForScope("string.quoted.double")).toBe("string");
    expect(monacoTokenForScope("constant.character.escape")).toBe("string.escape");
    expect(monacoTokenForScope("constant.numeric.hex")).toBe("number");
    expect(monacoTokenForScope("entity.name.type.class")).toBe("type");
    expect(monacoTokenForScope("entity.name.function.member")).toBe("tag.function");
    expect(monacoTokenForScope("entity.name.tag.html")).toBe("tag");
    expect(monacoTokenForScope("nonsense.scope.here")).toBeNull();
  });
});

describe("monacoRulesFrom", () => {
  test("expands array scopes, keeps fontStyle, strips the # and drops unusable entries", () => {
    expect(
      monacoRulesFrom([
        { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6A9955", fontStyle: "italic" } },
        { scope: "keyword.control", settings: { foreground: "#C586C0" } },
        { scope: "string", settings: { fontStyle: "bold" } },
        { scope: "nonsense.scope", settings: { foreground: "#FFFFFF" } },
        { settings: { foreground: "#FFFFFF" } },
        { scope: "keyword.operator" },
      ]),
    ).toEqual([
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "keyword", foreground: "C586C0" },
      { token: "string", fontStyle: "bold" },
    ]);
  });

  test("a comma-separated scope string is split, and the first rule for a token wins", () => {
    expect(
      monacoRulesFrom([
        { scope: "comment, string", settings: { foreground: "#111111" } },
        { scope: "comment", settings: { foreground: "#222222" } },
      ]),
    ).toEqual([
      { token: "comment", foreground: "111111" },
      { token: "string", foreground: "111111" },
    ]);
  });
});

describe("syntaxColorsFrom", () => {
  test("reads the six syntax palette entries back out, with # restored", () => {
    const rules = monacoRulesFrom([
      { scope: "comment", settings: { foreground: "#6A9955" } },
      { scope: "keyword", settings: { foreground: "#C586C0" } },
      { scope: "string", settings: { foreground: "#CE9178" } },
      { scope: "constant.numeric", settings: { foreground: "#B5CEA8" } },
      { scope: "entity.name.type", settings: { foreground: "#4EC9B0" } },
      { scope: "entity.name.function", settings: { foreground: "#DCDCAA" } },
    ]);
    expect(syntaxColorsFrom(rules)).toEqual({
      comment: "#6A9955",
      keyword: "#C586C0",
      string: "#CE9178",
      number: "#B5CEA8",
      type: "#4EC9B0",
      fn: "#DCDCAA",
    });
  });

  test("returns only what the theme actually defined", () => {
    expect(syntaxColorsFrom(monacoRulesFrom([{ scope: "comment", settings: { foreground: "#6A9955" } }]))).toEqual({
      comment: "#6A9955",
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/themes && bun test ./test/vscode-scopes.test.ts`
Expected: FAIL — `Cannot find module '../src/vscode/scopes'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/themes/src/vscode/scopes.ts

/** One `tokenColors` entry of a VS Code theme (spec §9.3). Every field is optional: themes in the wild omit any of them. */
export interface VsCodeTokenColor {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

/** A Monaco `IStandaloneThemeData` rule. `foreground` is bare hex, as `build.ts`'s `monacoTheme` also emits. */
export interface MonacoRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/**
 * The scope-to-token table spec §9.3 calls for. Ordered longest-prefix-first within each group so
 * `monacoTokenForScope` can take the first match. Monaco token names are the ones `build.ts` already uses,
 * so an imported theme and a built-in theme drive Monaco through the same vocabulary.
 */
export const SCOPE_TO_MONACO: readonly (readonly [scope: string, token: string])[] = [
  ["punctuation.definition.comment", "comment"],
  ["comment", "comment"],

  ["constant.character.escape", "string.escape"],
  ["string.regexp", "regexp"],
  ["string", "string"],

  ["constant.numeric", "number"],
  ["constant.language", "number"],
  ["constant", "number"],

  ["keyword.operator", "delimiter"],
  ["keyword", "keyword"],
  ["storage.type", "keyword"],
  ["storage.modifier", "keyword"],
  ["storage", "keyword"],
  ["variable.language", "keyword"],

  ["entity.name.function", "tag.function"],
  ["support.function", "tag.function"],
  ["meta.function-call", "tag.function"],

  ["entity.name.type", "type"],
  ["entity.name.class", "type"],
  ["support.type", "type"],
  ["support.class", "type"],
  ["entity.other.inherited-class", "type"],

  ["entity.name.tag", "tag"],
  ["entity.other.attribute-name", "attribute.name"],

  ["punctuation", "delimiter"],
  ["meta.brace", "delimiter"],

  ["variable.parameter", "identifier"],
  ["variable", "identifier"],
];

/** The longest matching scope prefix wins; an unknown scope maps to nothing rather than to a guess. */
export function monacoTokenForScope(scope: string): string | null {
  const trimmed = scope.trim();
  if (!trimmed) return null;
  let best: { token: string; length: number } | null = null;
  for (const [prefix, token] of SCOPE_TO_MONACO) {
    const matches = trimmed === prefix || trimmed.startsWith(`${prefix}.`);
    if (matches && (best === null || prefix.length > best.length)) best = { token, length: prefix.length };
  }
  return best?.token ?? null;
}

function scopeList(scope: VsCodeTokenColor["scope"]): string[] {
  if (Array.isArray(scope)) return scope.flatMap((entry) => entry.split(","));
  if (typeof scope === "string") return scope.split(",");
  return [];
}

/** Bare hex for Monaco, or null when the value isn't a plain `#RGB`/`#RRGGBB`/`#RRGGBBAA` colour. */
function bareHex(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  const digits = match?.[1];
  if (!digits) return null;
  // Monaco takes RRGGBB; 3/4-digit forms expand and any alpha channel is dropped for a token colour.
  const expanded = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  return expanded.slice(0, 6).toUpperCase();
}

/**
 * Converts `tokenColors` to Monaco rules (spec §9.3). The first entry that claims a Monaco token wins, which
 * matches how VS Code layers general scopes before specific ones. Entries with no usable scope, or with neither a
 * foreground nor a fontStyle, contribute nothing.
 */
export function monacoRulesFrom(tokenColors: readonly VsCodeTokenColor[]): MonacoRule[] {
  const rules: MonacoRule[] = [];
  const claimed = new Set<string>();
  for (const entry of tokenColors) {
    const foreground = bareHex(entry.settings?.foreground);
    const fontStyle = typeof entry.settings?.fontStyle === "string" ? entry.settings.fontStyle.trim() : "";
    if (foreground === null && !fontStyle) continue;
    for (const scope of scopeList(entry.scope)) {
      const token = monacoTokenForScope(scope);
      if (token === null || claimed.has(token)) continue;
      claimed.add(token);
      rules.push({
        token,
        ...(foreground === null ? {} : { foreground }),
        ...(fontStyle ? { fontStyle } : {}),
      });
    }
  }
  return rules;
}

const SYNTAX_FROM_TOKEN = [
  ["comment", "comment"],
  ["keyword", "keyword"],
  ["string", "string"],
  ["number", "number"],
  ["type", "type"],
  ["tag.function", "fn"],
] as const;

type SyntaxKey = (typeof SYNTAX_FROM_TOKEN)[number][1];

/** The six syntax palette entries a converted theme needs, read back out of the rules (Task 3 fills the rest). */
export function syntaxColorsFrom(rules: readonly MonacoRule[]): Partial<Record<SyntaxKey, string>> {
  const byToken = new Map(rules.map((rule) => [rule.token, rule.foreground]));
  const colors: Partial<Record<SyntaxKey, string>> = {};
  for (const [token, key] of SYNTAX_FROM_TOKEN) {
    const foreground = byToken.get(token);
    if (foreground) colors[key] = `#${foreground}`;
  }
  return colors;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/themes && bun test ./test/vscode-scopes.test.ts`
Expected: PASS. **Delta: themes +4 tests.**

- [ ] **Step 5: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add packages/themes/src/vscode/scopes.ts packages/themes/test/vscode-scopes.test.ts
git commit -m "feat(themes): map TextMate scopes to Monaco token rules

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 2: UI derivation with contrast fallbacks

**Files:**
- Create: `packages/themes/src/vscode/derive.ts`
- Test: `packages/themes/test/vscode-derive.test.ts`

**Interfaces:**
- Consumes: `Palette` from `packages/themes/src/build.ts`; `contrastRatio`, `mix`, `hexToRgb`, `rgbToHex`, `relativeLuminance` from `packages/themes/src/contrast.ts`.
- Produces, used by Task 3:

```ts
export function normalizeHex(value: unknown, over: string): string | null;
export function themeTypeFrom(colors: Record<string, unknown>, declared: unknown): "dark" | "light";
export function paletteFromColors(
  colors: Record<string, unknown>,
  type: "dark" | "light",
  syntax: Partial<Record<"comment" | "keyword" | "string" | "number" | "type" | "fn", string>>,
): Palette;
```

**Why `normalizeHex` takes an `over` background.** `hexToRgb` in `packages/themes/src/contrast.ts:6` throws on anything that is not `#RRGGBB`, and real VS Code themes use 8-digit hex constantly — `"editor.selectionBackground": "#264F7840"` is typical. An alpha colour is composited over the surface it is drawn on so every value that reaches `buildTheme` is an opaque `#RRGGBB`. **A converter that passes 8-digit hex through will throw at import time on most real themes.**

**Spec §9.3 names the keys this task must read:** `editor.background`, `sideBar.background`, `activityBar.background`, `statusBar.background`, `focusBorder`, `errorForeground`, "and so on, with contrast fallbacks".

- [ ] **Step 1: Write the failing test**

```ts
// packages/themes/test/vscode-derive.test.ts
import { describe, expect, test } from "bun:test";
import { buildTheme } from "../src/build";
import { contrastRatio } from "../src/contrast";
import { CONTRAST_PAIRS, TOKEN_NAMES } from "../src/tokens";
import { normalizeHex, paletteFromColors, themeTypeFrom } from "../src/vscode/derive";

describe("normalizeHex", () => {
  test("expands short forms, uppercases, and composites alpha over the given surface", () => {
    expect(normalizeHex("#abc", "#000000")).toBe("#AABBCC");
    expect(normalizeHex("#1E1E1E", "#000000")).toBe("#1E1E1E");
    // 50% white over black is mid grey; the alpha channel must actually be applied, not sliced off.
    expect(normalizeHex("#FFFFFF80", "#000000")).toBe("#808080");
    expect(normalizeHex("#FFFFFF00", "#123456")).toBe("#123456");
    expect(normalizeHex("not a color", "#000000")).toBeNull();
    expect(normalizeHex(undefined, "#000000")).toBeNull();
    expect(normalizeHex(42, "#000000")).toBeNull();
  });
});

describe("themeTypeFrom", () => {
  test("honours a declared type and otherwise infers from the background's luminance", () => {
    expect(themeTypeFrom({}, "light")).toBe("light");
    expect(themeTypeFrom({}, "vs-dark")).toBe("dark");
    expect(themeTypeFrom({ "editor.background": "#FFFFFF" }, undefined)).toBe("light");
    expect(themeTypeFrom({ "editor.background": "#1E1E1E" }, undefined)).toBe("dark");
    expect(themeTypeFrom({}, undefined)).toBe("dark");
  });
});

describe("paletteFromColors", () => {
  test("reads the spec §9.3 keys when the theme provides them", () => {
    const palette = paletteFromColors(
      {
        "editor.background": "#1E1E1E",
        "editor.foreground": "#D4D4D4",
        "sideBar.background": "#252526",
        "activityBar.background": "#333333",
        "statusBar.background": "#007ACC",
        focusBorder: "#007FD4",
        errorForeground: "#F48771",
        "editor.selectionBackground": "#264F78",
      },
      "dark",
      { comment: "#6A9955", keyword: "#C586C0" },
    );
    expect(palette.canvas).toBe("#1E1E1E");
    expect(palette.fg).toBe("#D4D4D4");
    expect(palette.chrome).toBe("#252526");
    expect(palette.accent).toBe("#007FD4");
    expect(palette.error).toBe("#F48771");
    expect(palette.selection).toBe("#264F78");
    expect(palette.comment).toBe("#6A9955");
    expect(palette.keyword).toBe("#C586C0");
  });

  test("every field is an opaque #RRGGBB even when the theme defines nothing", () => {
    const palette = paletteFromColors({}, "dark", {});
    for (const [key, value] of Object.entries(palette)) {
      expect(`${key}=${value}`).toMatch(/=#[0-9A-F]{6}$/);
    }
  });
});

// The spec requires contrast fallbacks, so the guarantee is asserted against the same bar the 21 built-in
// themes already meet in themes.test.ts — not against the theme file's own good intentions.
describe("a deliberately sparse theme is still legible", () => {
  const sparse = { "editor.background": "#101010" };

  test("derives a complete palette whose built theme meets WCAG AA on every surface (spec §9.1)", () => {
    const theme = buildTheme({
      id: "sparse",
      name: "Sparse",
      type: "dark",
      credit: "test",
      palette: paletteFromColors(sparse, "dark", {}),
    });
    expect(Object.keys(theme.tokens).sort()).toEqual([...TOKEN_NAMES].sort());
    const failures: string[] = [];
    for (const [fg, bg] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(theme.tokens[fg], theme.tokens[bg]);
      if (ratio < 4.5) failures.push(`${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  test("the same holds for a sparse light theme, and for a theme that defines nothing at all", () => {
    for (const [type, colors] of [
      ["light", { "editor.background": "#FFFFFF" }],
      ["dark", {}],
      ["light", {}],
    ] as const) {
      const theme = buildTheme({
        id: "sparse",
        name: "Sparse",
        type,
        credit: "test",
        palette: paletteFromColors(colors, type, {}),
      });
      const failures = CONTRAST_PAIRS.filter(([fg, bg]) => contrastRatio(theme.tokens[fg], theme.tokens[bg]) < 4.5);
      expect(`${type}:${failures.map(([fg, bg]) => `${fg}/${bg}`).join()}`).toBe(`${type}:`);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/themes && bun test ./test/vscode-derive.test.ts`
Expected: FAIL — `Cannot find module '../src/vscode/derive'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/themes/src/vscode/derive.ts
import type { Palette } from "../build";
import { hexToRgb, mix, relativeLuminance, rgbToHex } from "../contrast";

/**
 * A VS Code colour as an opaque `#RRGGBB`, or null when it isn't a colour at all.
 *
 * `#RGB`/`#RGBA` expand; an alpha channel is composited over `over`, because `hexToRgb` (contrast.ts) accepts
 * only `#RRGGBB` and real themes use 8-digit hex for selections and overlays constantly.
 */
export function normalizeHex(value: unknown, over: string): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  const digits = match?.[1];
  if (!digits) return null;
  const expanded = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  const opaque = `#${expanded.slice(0, 6).toUpperCase()}`;
  if (expanded.length === 6) return opaque;
  const alpha = Number.parseInt(expanded.slice(6, 8), 16) / 255;
  return alpha >= 1 ? opaque : mix(over, opaque, alpha);
}

/** `type: "light"` / `"vs"` wins; otherwise the editor background's luminance decides. Unknown means dark. */
export function themeTypeFrom(colors: Record<string, unknown>, declared: unknown): "dark" | "light" {
  if (typeof declared === "string") {
    const value = declared.trim().toLowerCase();
    if (value === "light" || value === "vs") return "light";
    if (value === "dark" || value === "vs-dark" || value === "hc-black") return "dark";
  }
  const background = normalizeHex(colors["editor.background"], "#000000");
  if (background === null) return "dark";
  return relativeLuminance(background) > 0.5 ? "light" : "dark";
}

type SyntaxKey = "comment" | "keyword" | "string" | "number" | "type" | "fn";

/**
 * `colors` → a complete `Palette`, with a fallback behind every field (spec §9.3: "UI variables are derived from
 * `editor.background`, `sideBar.background`, `activityBar.background`, `statusBar.background`, `focusBorder`,
 * `errorForeground`, and so on, with contrast fallbacks").
 *
 * This function guarantees only that every field is a real opaque colour and that foregrounds start on the correct
 * side of their background. The WCAG AA guarantee itself is `buildTheme`'s: it runs `ensureContrast` over
 * `TEXT_SURFACES` for every token, which is why an imported theme gets the same bar as the 21 built-ins for free —
 * provided nothing here ever emits `undefined`.
 */
export function paletteFromColors(
  colors: Record<string, unknown>,
  type: "dark" | "light",
  syntax: Partial<Record<SyntaxKey, string>>,
): Palette {
  const dark = type === "dark";
  const canvas = normalizeHex(colors["editor.background"], dark ? "#000000" : "#FFFFFF") ?? (dark ? "#1B1E23" : "#F7F8FA");
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = normalizeHex(colors[key], canvas);
      if (value !== null) return value;
    }
    return null;
  };
  // Toward the extreme of the theme's own polarity: chrome sits slightly behind the canvas, foregrounds ahead of it.
  const deeper = (base: string, amount: number) => mix(base, dark ? "#000000" : "#FFFFFF", amount);
  const forward = (base: string, amount: number) => mix(base, dark ? "#FFFFFF" : "#000000", amount);

  const fg = pick("editor.foreground", "foreground") ?? forward(canvas, dark ? 0.85 : 0.9);
  const chrome = pick("sideBar.background", "activityBar.background", "statusBar.background") ?? deeper(canvas, 0.25);
  const elevated = pick("editorWidget.background", "dropdown.background", "menu.background") ?? forward(canvas, 0.06);
  const accent = pick("focusBorder", "textLink.foreground", "button.background", "progressBar.background")
    ?? (dark ? "#6F9BFF" : "#2F52C9");
  const error = pick("errorForeground", "editorError.foreground", "list.errorForeground") ?? (dark ? "#F07178" : "#B42330");
  const warn = pick("editorWarning.foreground", "list.warningForeground") ?? (dark ? "#E5C07B" : "#8A5A00");
  const info = pick("editorInfo.foreground", "textLink.activeForeground") ?? (dark ? "#7FD1C7" : "#0B6E78");
  const success = pick("gitDecoration.addedResourceForeground", "terminal.ansiGreen") ?? (dark ? "#5CC28A" : "#1F7A45");

  return {
    canvas,
    chrome,
    elevated,
    border: pick("panel.border", "editorGroup.border", "contrastBorder", "widget.border") ?? forward(canvas, 0.12),
    fg,
    muted: pick("descriptionForeground", "editorLineNumber.foreground") ?? mix(fg, canvas, 0.35),
    accent,
    error,
    warn,
    success,
    info,
    string: syntax.string ?? (dark ? "#C3E88D" : "#2E7D32"),
    number: syntax.number ?? (dark ? "#F5A97F" : "#A2551A"),
    keyword: syntax.keyword ?? accent,
    fn: syntax.fn ?? (dark ? "#FFD580" : "#8A5A00"),
    type: syntax.type ?? info,
    comment: syntax.comment ?? mix(fg, canvas, 0.45),
    selection: pick("editor.selectionBackground", "selection.background") ?? mix(canvas, accent, dark ? 0.3 : 0.2),
    lineHighlight: pick("editor.lineHighlightBackground") ?? forward(canvas, 0.05),
  };
}
```

**Note for the implementer:** `rgbToHex` and `hexToRgb` are imported above for their normalising side effect on `mix`'s output; if Biome reports either as unused after you finish, delete that import rather than adding a suppression.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/themes && bun test ./test/vscode-derive.test.ts`
Expected: PASS, including both sparse-theme contrast tests. **Delta: themes +5 tests.**

If a sparse case fails AA, the fix belongs **here** — widen the starting separation in `deeper`/`forward` — not in the test's threshold. 4.5 is spec §9.1's bar.

- [ ] **Step 5: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add packages/themes/src/vscode/derive.ts packages/themes/test/vscode-derive.test.ts
git commit -m "feat(themes): derive UI palette from VS Code colors with contrast fallbacks

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 3: The converter

**Files:**
- Create: `packages/themes/src/vscode/convert.ts`, `packages/themes/test/fixtures/` (10 fixtures)
- Modify: `packages/themes/src/index.ts` (re-export `./vscode/convert`)
- Test: `packages/themes/test/vscode-convert.test.ts`

**Interfaces:**
- Consumes: `monacoRulesFrom`, `syntaxColorsFrom` (Task 1); `paletteFromColors`, `themeTypeFrom`, `normalizeHex` (Task 2); `buildTheme`, `ThemeDefinition` (`packages/themes/src/build.ts`).
- Produces, used by Tasks 6, 7 and 8:

```ts
export interface VsCodeThemeFile {
  name?: string;
  type?: string;
  colors?: Record<string, unknown>;
  tokenColors?: VsCodeTokenColor[];
  semanticTokenColors?: Record<string, unknown>;
  include?: string;
}
export type ConvertResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; error: string };
export function slugThemeId(name: string): string;
export function convertVsCodeTheme(input: unknown, options?: { fallbackName?: string }): ConvertResult;
```

`ConvertResult.error` is the **readable error** spec §9.3 requires ("Invalid files produce a readable error"); it is shown to the user verbatim, so it never contains a file path, a stack, or a JSON pointer.

`slugThemeId` must produce an id matching `/^[\w-]{1,64}$/` — **Finding T3**: `commandForMenuAction` (`apps/desktop/src/main/menu.ts:93`) rejects anything else, and the Themes menu item would silently do nothing.

- [ ] **Step 1: Write the fixtures**

Create ten small, hand-authored `packages/themes/test/fixtures/*.json` files (spec §22.1 asks for 10). **Author them from the documented VS Code colour-theme format; do not copy files out of any shipped product.** Cover, one concern each: `dark-full.json` (every §9.3 key present), `light-full.json`, `dark-minimal.json` (only `editor.background`), `alpha-colors.json` (8-digit hex in selection and overlays), `array-scopes.json` (array and comma-joined scopes), `no-type.json` (type inferred from background), `font-styles.json` (italic/bold/underline), `unknown-scopes.json` (mostly scopes with no mapping), `empty-tokencolors.json` (`"tokenColors": []`), `weird-name.json` (a name needing slugging, e.g. `"  Ayu  Mirage!! "`).

- [ ] **Step 2: Write the failing test**

```ts
// packages/themes/test/vscode-convert.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "../src/contrast";
import { CONTRAST_PAIRS, TOKEN_NAMES } from "../src/tokens";
import { convertVsCodeTheme, slugThemeId } from "../src/vscode/convert";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("slugThemeId", () => {
  test("produces an id the Themes menu accepts (menu.ts's /^[\\w-]{1,64}$/)", () => {
    expect(slugThemeId("  Ayu  Mirage!! ")).toBe("ayu-mirage");
    expect(slugThemeId("Dracula")).toBe("dracula");
    expect(slugThemeId("日本語")).toBe("imported-theme");
    expect(slugThemeId("")).toBe("imported-theme");
    expect(slugThemeId("x".repeat(200))).toHaveLength(64);
    for (const name of ["  Ayu  Mirage!! ", "Dracula", "日本語", "", "x".repeat(200)]) {
      expect(slugThemeId(name)).toMatch(/^[\w-]{1,64}$/);
    }
  });
});

describe("convertVsCodeTheme", () => {
  test("converts every fixture into a complete, AA-clean theme (spec §22.1)", () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(10);
    for (const file of files) {
      const raw = JSON.parse(Bun.file(join(FIXTURES, file)).text() as unknown as string) as unknown;
      const result = convertVsCodeTheme(raw, { fallbackName: file.replace(/\.json$/, "") });
      if (!result.ok) throw new Error(`${file}: ${result.error}`);
      const { theme } = result;
      expect(theme.id).toMatch(/^[\w-]{1,64}$/);
      expect(Object.keys(theme.tokens).sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) expect(`${file}:${theme.tokens[name]}`).toMatch(/:#[0-9A-F]{6}$/);
      expect(theme.monaco.base).toBe(theme.type === "dark" ? "vs-dark" : "vs");
      expect(theme.monaco.inherit).toBe(true);
      const failures = CONTRAST_PAIRS.filter(([fg, bg]) => contrastRatio(theme.tokens[fg], theme.tokens[bg]) < 4.5);
      expect(`${file}:${failures.map(([fg, bg]) => `${fg}/${bg}`).join()}`).toBe(`${file}:`);
    }
  });

  test("passes the theme's own colors through to Monaco, normalised (spec §9.3)", () => {
    const result = convertVsCodeTheme({
      name: "Alpha",
      type: "dark",
      colors: { "editor.background": "#1E1E1E", "editor.selectionBackground": "#264F7840" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#6A9955" } }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.theme.monaco.colors["editor.selectionBackground"]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result.theme.monaco.colors["editor.background"]).toBe("#1E1E1E");
    expect(result.theme.monaco.rules).toContainEqual({ token: "comment", foreground: "6A9955" });
    // build.ts's own rules stay underneath, so a token the theme never styled still has a colour.
    expect(result.theme.monaco.rules[0]?.token).toBe("");
  });

  test("invalid input produces a readable error and never throws (spec §9.3)", () => {
    for (const bad of [null, 42, "a string", [], { colors: "not an object" }]) {
      const result = convertVsCodeTheme(bad);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a failure");
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).not.toMatch(/[/\\]|Error:|undefined/);
    }
  });

  test("a theme with no colors and no tokenColors is still importable", () => {
    const result = convertVsCodeTheme({ name: "Bare" });
    if (!result.ok) throw new Error(result.error);
    expect(result.theme.name).toBe("Bare");
    expect(result.theme.credit).toBe("Imported VS Code theme");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/themes && bun test ./test/vscode-convert.test.ts`
Expected: FAIL — `Cannot find module '../src/vscode/convert'`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/themes/src/vscode/convert.ts
import { buildTheme, type ThemeDefinition } from "../build";
import { normalizeHex, paletteFromColors, themeTypeFrom } from "./derive";
import { monacoRulesFrom, syntaxColorsFrom, type VsCodeTokenColor } from "./scopes";

export interface VsCodeThemeFile {
  name?: string;
  type?: string;
  colors?: Record<string, unknown>;
  tokenColors?: VsCodeTokenColor[];
  semanticTokenColors?: Record<string, unknown>;
  include?: string;
}

export type ConvertResult = { ok: true; theme: ThemeDefinition } | { ok: false; error: string };

const FALLBACK_ID = "imported-theme";

/** An id the Appearance picker, the palette and `commandForMenuAction`'s /^[\w-]{1,64}$/ all accept (Finding T3). */
export function slugThemeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : FALLBACK_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A VS Code colour theme → a JSLab `ThemeDefinition` (spec §9.3). Pure: no filesystem, no network.
 *
 * `include` is deliberately not followed. Resolving it means reading a sibling file out of the archive or folder,
 * which would drag a path resolver into a pure package; a theme that relies on it still converts, using whatever it
 * defines itself plus this module's fallbacks.
 */
export function convertVsCodeTheme(input: unknown, options: { fallbackName?: string } = {}): ConvertResult {
  if (!isRecord(input)) return { ok: false, error: "That file isn't a VS Code colour theme." };
  const file = input as VsCodeThemeFile;
  if (file.colors !== undefined && !isRecord(file.colors)) {
    return { ok: false, error: "That theme's “colors” section isn't valid." };
  }
  if (file.tokenColors !== undefined && !Array.isArray(file.tokenColors)) {
    return { ok: false, error: "That theme's “tokenColors” section isn't valid." };
  }
  const colors = isRecord(file.colors) ? file.colors : {};
  const tokenColors = Array.isArray(file.tokenColors) ? (file.tokenColors as VsCodeTokenColor[]) : [];
  const name = (typeof file.name === "string" && file.name.trim()) || options.fallbackName?.trim() || "Imported Theme";
  const type = themeTypeFrom(colors, file.type);
  const rules = monacoRulesFrom(tokenColors);
  const palette = paletteFromColors(colors, type, syntaxColorsFrom(rules));

  // buildTheme fills every token, then lifts each text token to WCAG AA over each surface it's drawn on
  // (TEXT_SURFACES). That is where spec §9.1's guarantee comes from for imported themes, exactly as for built-ins.
  const theme = buildTheme({
    id: slugThemeId(name),
    name,
    type,
    credit: "Imported VS Code theme",
    palette,
  });

  // Spec §9.3: "`colors` are passed to Monaco `colors`". The theme's own values win over the derived ones, but only
  // after normalising — Monaco rejects 8-digit hex in several keys, and `editor.background` must stay opaque.
  const passthrough: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    const normalized = normalizeHex(value, palette.canvas);
    if (normalized !== null) passthrough[key] = normalized;
  }

  return {
    ok: true,
    theme: {
      ...theme,
      monaco: {
        ...theme.monaco,
        // build.ts's rules first so a token this theme never styled keeps a readable colour underneath.
        rules: [...theme.monaco.rules, ...rules],
        colors: { ...theme.monaco.colors, ...passthrough },
      },
    },
  };
}
```

Then in `packages/themes/src/index.ts`, alongside the existing re-exports:

```ts
export * from "./vscode/convert";
export * from "./vscode/derive";
export * from "./vscode/scopes";
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd packages/themes && bun test ./test` — the existing themes tests must also still pass untouched.
Expected: PASS. **Delta: themes +4 tests.**

- [ ] **Step 6: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add packages/themes/src/vscode/convert.ts packages/themes/src/index.ts packages/themes/test/vscode-convert.test.ts packages/themes/test/fixtures
git commit -m "feat(themes): convert a VS Code colour theme into a JSLab theme

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 4: The user-theme registry

**Files:**
- Create: `packages/themes/src/user-themes.ts`
- Modify: `packages/themes/src/index.ts`
- Test: `packages/themes/test/user-themes.test.ts`

**Interfaces:**
- Consumes: `ThemeDefinition` (Task 3's output shape), `BUILTIN_THEMES`.
- Produces, used by Tasks 7, 8 and the UI:

```ts
export function registerUserThemes(themes: readonly ThemeDefinition[]): void;
export function userThemes(): readonly ThemeDefinition[];
```

and the **existing** `listThemes()`, `getTheme(id)` and `resolveThemeId(appearance, systemDark)` in `packages/themes/src/index.ts` change behaviour to include registered user themes. Their signatures do not change, which is the point — see **Finding T1**: the Appearance picker, the Themes menu, the command palette and Monaco all call them already.

**This task must land before Task 8**, or selecting an imported theme is silently rewritten to Graphite by `resolveThemeId` (**Finding T2**).

- [ ] **Step 1: Write the failing test**

```ts
// packages/themes/test/user-themes.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { buildTheme } from "../src/build";
import { getTheme, listThemes, registerUserThemes, resolveThemeId, userThemes } from "../src";

const make = (id: string, name: string, type: "dark" | "light" = "dark") =>
  buildTheme({
    id,
    name,
    type,
    credit: "Imported VS Code theme",
    palette: {
      canvas: "#101010", chrome: "#0A0A0A", elevated: "#181818", border: "#2A2A2A",
      fg: "#E0E0E0", muted: "#909090", accent: "#6F9BFF", error: "#F07178",
      warn: "#E5C07B", success: "#5CC28A", info: "#7FD1C7", string: "#C3E88D",
      number: "#F5A97F", keyword: "#8FB4FF", fn: "#FFD580", type: "#7FD1C7",
      comment: "#6B7480", selection: "#2A3A5E", lineHighlight: "#181818",
    },
  });

afterEach(() => registerUserThemes([]));

describe("the user-theme registry", () => {
  test("starts empty and leaves the built-ins exactly as they were", () => {
    expect(userThemes()).toEqual([]);
    expect(listThemes()).toHaveLength(21);
    expect(getTheme("graphite").id).toBe("graphite");
  });

  test("a registered theme is listed after the built-ins and is retrievable by id", () => {
    registerUserThemes([make("dracula-pro", "Dracula Pro")]);
    const all = listThemes();
    expect(all).toHaveLength(22);
    expect(all[21]).toEqual({ id: "dracula-pro", name: "Dracula Pro", type: "dark" });
    expect(getTheme("dracula-pro").name).toBe("Dracula Pro");
  });

  test("registering replaces the previous set rather than accumulating", () => {
    registerUserThemes([make("one", "One")]);
    registerUserThemes([make("two", "Two")]);
    expect(listThemes().map((theme) => theme.id)).not.toContain("one");
    expect(getTheme("one").id).toBe("graphite");
    expect(getTheme("two").id).toBe("two");
  });

  test("a built-in id can never be shadowed by an imported theme", () => {
    registerUserThemes([make("graphite", "Not Graphite")]);
    expect(getTheme("graphite").name).toBe("Graphite");
    expect(listThemes().filter((theme) => theme.id === "graphite")).toHaveLength(1);
  });

  // Finding T2: without this, choosing an imported theme silently reverts to Graphite and looks like a failed import.
  test("resolveThemeId accepts an imported id, for the direct and the follow-system paths", () => {
    registerUserThemes([make("nord-light", "Nord Light", "light"), make("nord-deep", "Nord Deep")]);
    expect(resolveThemeId({ theme: "nord-deep", followSystem: false, lightTheme: "x", darkTheme: "y" }, true))
      .toBe("nord-deep");
    expect(resolveThemeId({ theme: "x", followSystem: true, lightTheme: "nord-light", darkTheme: "nord-deep" }, false))
      .toBe("nord-light");
    expect(resolveThemeId({ theme: "x", followSystem: true, lightTheme: "nord-light", darkTheme: "nord-deep" }, true))
      .toBe("nord-deep");
    expect(resolveThemeId({ theme: "gone", followSystem: false, lightTheme: "x", darkTheme: "y" }, true))
      .toBe("graphite");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/themes && bun test ./test/user-themes.test.ts`
Expected: FAIL — `registerUserThemes` is not exported.

- [ ] **Step 3: Write the implementation**

```ts
// packages/themes/src/user-themes.ts
import type { ThemeDefinition } from "./build";

let registered: readonly ThemeDefinition[] = [];

/**
 * Replaces the set of imported themes (spec §9.3). Main loads `<appdata>/themes/` at startup and calls this in both
 * windows; a later import calls it again with the whole set, never a delta.
 *
 * Deliberately module-level state, mirroring `BUILTIN_THEMES`' own module-level `BY_ID` map: `listThemes` and
 * `getTheme` are plain functions called from four separate surfaces (Finding T1), and threading a registry object
 * through all of them would change four signatures to achieve the same thing.
 */
export function registerUserThemes(themes: readonly ThemeDefinition[]): void {
  registered = [...themes];
}

export function userThemes(): readonly ThemeDefinition[] {
  return registered;
}
```

Then in `packages/themes/src/index.ts`, replace the module-level `BY_ID` const and the three lookups with versions that consult the registry. A built-in always wins, so an imported theme can never shadow `graphite`:

```ts
import { userThemes } from "./user-themes";

export * from "./user-themes";

const BUILTIN_BY_ID = new Map(BUILTIN_THEMES.map((theme) => [theme.id, theme]));

/** Built-ins first, then imported themes; a built-in id is never shadowed. */
function themeIndex(): Map<string, ThemeDefinition> {
  const index = new Map(BUILTIN_BY_ID);
  for (const theme of userThemes()) if (!index.has(theme.id)) index.set(theme.id, theme);
  return index;
}

export function listThemes(): ThemeMeta[] {
  return [...themeIndex().values()].map(({ id, name, type }) => ({ id, name, type }));
}

export function getTheme(id: string): ThemeDefinition {
  return themeIndex().get(id) ?? (BUILTIN_BY_ID.get(DEFAULT_DARK_THEME) as ThemeDefinition);
}

export function resolveThemeId(
  appearance: { theme: string; followSystem: boolean; lightTheme: string; darkTheme: string },
  systemDark: boolean,
): string {
  const index = themeIndex();
  if (!appearance.followSystem) return index.has(appearance.theme) ? appearance.theme : DEFAULT_DARK_THEME;
  if (systemDark) return index.has(appearance.darkTheme) ? appearance.darkTheme : DEFAULT_DARK_THEME;
  return index.has(appearance.lightTheme) ? appearance.lightTheme : DEFAULT_LIGHT_THEME;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/themes && bun test ./test`
Expected: PASS, and the existing `themes.test.ts` still passes — note its assertions `expect(BUILTIN_THEMES).toHaveLength(21)` and `listThemes().map(...).slice(0, 2)` rely on built-ins coming first, which the ordering above preserves.

Then confirm nothing downstream broke, since four surfaces call these functions:
`cd apps/ui && bun test ./test/themes.test.ts ./test/palette.test.tsx ./test/settings-app.test.ts 2>/dev/null; cd ../desktop && bun test ./test/menu.test.ts`
**Delta: themes +5 tests.**

- [ ] **Step 5: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add packages/themes/src/user-themes.ts packages/themes/src/index.ts packages/themes/test/user-themes.test.ts
git commit -m "feat(themes): make listThemes and getTheme aware of imported themes

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 5: The safe ZIP reader

**Files:**
- Create: `apps/desktop/src/main/themes/zip.ts`
- Test: `apps/desktop/test/themes/zip.test.ts`

**Interfaces:**
- Consumes: `node:zlib`'s `inflateRawSync` only. Nothing from `@jslab/themes` — this module knows nothing about themes.
- Produces, used by Task 6:

```ts
export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
}
export const ZIP_LIMITS: ZipLimits;
export class ZipError extends Error {}
export function isSafeEntryName(name: string): boolean;
export interface ZipArchive {
  names(): string[];
  has(name: string): boolean;
  read(name: string): Uint8Array;
}
export function openZip(bytes: Uint8Array, limits?: ZipLimits): ZipArchive;
```

**This task is the security boundary of the milestone. A `.vsix` is an untrusted zip downloaded from the internet, and it is treated as hostile input, not as a container we trust.** Four rules, each of which is a test below:

1. **Zip-slip.** Entry names are validated before anything else. Rejected: an empty name, a leading `/`, a Windows drive prefix (`C:`), any backslash, a NUL or control byte, any `.` or `..` path segment, and any name longer than 512 bytes. **Nothing is written to disk at any point** — `read` returns bytes in memory — so path safety here protects the *matching* of a declared theme path (Task 6), not a write. Both matter: a name like `../../../../etc/passwd` must never be selectable as "the theme file".
2. **Entry count.** At most `maxEntries` (2,000) central-directory records.
3. **Size.** Each entry's declared uncompressed size is checked *before* allocating (`maxEntryBytes`, 2 MiB), the sum is capped (`maxTotalBytes`, 16 MiB), and the inflated result is re-checked against the declaration — a lying header does not get to allocate.
4. **Compression ratio.** An entry whose uncompressed size exceeds its compressed size by more than `maxRatio` (200:1) is refused unread. That is the zip-bomb guard.

Only methods `0` (stored) and `8` (deflate) are supported; anything else is refused by name rather than attempted.

- [ ] **Step 1: Write the failing test**

The tests build archives byte by byte, because the point is to produce archives a normal zip tool will not emit.

```ts
// apps/desktop/test/themes/zip.test.ts
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { isSafeEntryName, openZip, ZipError } from "../../src/main/themes/zip";

interface Member { name: string; data: Uint8Array; store?: boolean; declaredSize?: number }

/** Builds a minimal but real zip: local headers, then a central directory, then an EOCD. */
function buildZip(members: Member[], entryCountOverride?: number): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const body = member.store ? member.data : new Uint8Array(deflateRawSync(member.data));
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, member.store ? 0 : 8, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, member.declaredSize ?? member.data.length, true);
    local.setUint16(26, name.length, true);
    const localBytes = new Uint8Array(30 + name.length + body.length);
    localBytes.set(new Uint8Array(local.buffer), 0);
    localBytes.set(name, 30);
    localBytes.set(body, 30 + name.length);
    locals.push(localBytes);

    const central = new DataView(new ArrayBuffer(46 + name.length));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, member.store ? 0 : 8, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, member.declaredSize ?? member.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(46 + name.length);
    centralBytes.set(new Uint8Array(central.buffer), 0);
    centralBytes.set(name, 46);
    centrals.push(centralBytes);
    offset += localBytes.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entryCountOverride ?? members.length, true);
  eocd.setUint16(10, entryCountOverride ?? members.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

describe("isSafeEntryName", () => {
  test("accepts ordinary archive paths", () => {
    for (const name of ["extension/package.json", "extension/themes/dark.json", "a", "a/b/c.json"]) {
      expect(`${name}:${isSafeEntryName(name)}`).toBe(`${name}:true`);
    }
  });

  test("rejects every traversal and absolute form", () => {
    for (const name of [
      "",
      "../evil.json",
      "extension/../../evil.json",
      "extension/./dark.json",
      "/etc/passwd",
      "//server/share/x",
      "C:/Windows/system32",
      "c:\\Windows\\system32",
      "extension\\themes\\dark.json",
      "extension/themes/\u0000dark.json",
      "extension/themes/\u0001dark.json",
      "..",
      `${"a".repeat(600)}.json`,
    ]) {
      expect(`${JSON.stringify(name)}:${isSafeEntryName(name)}`).toBe(`${JSON.stringify(name)}:false`);
    }
  });
});

describe("openZip", () => {
  test("reads stored and deflated members", () => {
    const zip = openZip(buildZip([
      { name: "extension/package.json", data: text('{"name":"x"}') },
      { name: "extension/themes/dark.json", data: text('{"name":"Dark"}'), store: true },
    ]));
    expect(zip.names()).toEqual(["extension/package.json", "extension/themes/dark.json"]);
    expect(zip.has("extension/package.json")).toBe(true);
    expect(zip.has("nope")).toBe(false);
    expect(new TextDecoder().decode(zip.read("extension/themes/dark.json"))).toBe('{"name":"Dark"}');
  });

  // The headline test: a malicious entry path must be refused, and must never become readable.
  test("refuses an archive containing a zip-slip entry", () => {
    const evil = buildZip([
      { name: "extension/package.json", data: text("{}") },
      { name: "../../../../etc/jslab-pwned.json", data: text("owned") },
    ]);
    expect(() => openZip(evil)).toThrow(ZipError);
    try {
      openZip(evil);
    } catch (error) {
      expect((error as Error).message).toContain("unsafe path");
    }
  });

  test("refuses absolute and backslash entry names too", () => {
    expect(() => openZip(buildZip([{ name: "/etc/passwd", data: text("x") }]))).toThrow(ZipError);
    expect(() => openZip(buildZip([{ name: "extension\\themes\\a.json", data: text("x") }]))).toThrow(ZipError);
  });

  test("caps the entry count", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `extension/${index}.json`, data: text("{}") }));
    expect(() => openZip(buildZip(many), {
      maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 4096, maxRatio: 200,
    })).toThrow(/too many entries/);
  });

  test("caps a single entry's declared size before inflating", () => {
    const big = buildZip([{ name: "extension/big.json", data: text("x".repeat(4096)) }]);
    expect(() => openZip(big, { maxEntries: 10, maxEntryBytes: 128, maxTotalBytes: 65536, maxRatio: 200 }))
      .toThrow(/too large/);
  });

  test("caps the total uncompressed size across entries", () => {
    const parts = Array.from({ length: 5 }, (_, index) => ({ name: `extension/${index}.json`, data: text("y".repeat(300)) }));
    expect(() => openZip(buildZip(parts), { maxEntries: 50, maxEntryBytes: 4096, maxTotalBytes: 1000, maxRatio: 500 }))
      .toThrow(/too large/);
  });

  test("refuses a zip bomb by compression ratio", () => {
    const bomb = buildZip([{ name: "extension/bomb.json", data: text("\u0000".repeat(200_000)) }]);
    expect(() => openZip(bomb, { maxEntries: 10, maxEntryBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxRatio: 50 }))
      .toThrow(/compression ratio/);
  });

  test("refuses a member whose real inflated size disagrees with its header", () => {
    const lying = buildZip([{ name: "extension/a.json", data: text("hello world"), declaredSize: 4 }]);
    const zip = openZip(lying);
    expect(() => zip.read("extension/a.json")).toThrow(/didn't match/);
  });

  test("refuses junk, a truncated archive, and an unknown compression method", () => {
    expect(() => openZip(text("not a zip at all"))).toThrow(ZipError);
    expect(() => openZip(new Uint8Array(0))).toThrow(ZipError);
    const good = buildZip([{ name: "extension/a.json", data: text("{}") }]);
    expect(() => openZip(good.slice(0, good.length - 10))).toThrow(ZipError);
    const unsupported = buildZip([{ name: "extension/a.json", data: text("{}") }]);
    // Method 9 (deflate64) in the central directory record: refused by name, never attempted.
    new DataView(unsupported.buffer).setUint16(unsupported.length - 22 - 46 - 20 + 10, 9, true);
    expect(() => openZip(unsupported)).toThrow(ZipError);
  });

  test("reading an entry that doesn't exist throws rather than returning empty bytes", () => {
    const zip = openZip(buildZip([{ name: "extension/a.json", data: text("{}") }]));
    expect(() => zip.read("extension/missing.json")).toThrow(ZipError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/desktop && bun test ./test/themes/zip.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/themes/zip'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/themes/zip.ts
import { inflateRawSync } from "node:zlib";

/**
 * A deliberately minimal, read-only ZIP reader for `.vsix` import (spec §9.3).
 *
 * Ruling R-M5D-ZIP-1: no zip dependency is added. A `.vsix` needs two members read and nothing extracted, so this
 * is a central-directory walk plus `inflateRawSync`. Writing it — rather than taking a library or shelling out to
 * `unzip` — is what makes the refusals below testable, mandatory and fail-closed.
 *
 * Everything here treats the archive as hostile: names are validated before use, sizes are checked before
 * allocation, and no byte is ever written to disk.
 */
export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxEntryBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRatio: 200,
};

export class ZipError extends Error {}

const MAX_NAME_BYTES = 512;
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Zip-slip and friends. An entry name is usable only if it is a plain relative POSIX path: no absolute form, no
 * drive letter, no backslash, no `.`/`..` segment, no control characters.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_BYTES) return false;
  if (name.startsWith("/") || name.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes in an entry name are exactly what we refuse
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  const segments = name.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipArchive {
  names(): string[];
  has(name: string): boolean;
  read(name: string): Uint8Array;
}

function findEocd(view: DataView, length: number): number {
  const earliest = Math.max(0, length - 22 - 0xffff);
  for (let at = length - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === SIG_EOCD) return at;
  }
  throw new ZipError("That file isn't a valid .vsix archive.");
}

export function openZip(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): ZipArchive {
  if (bytes.length < 22) throw new ZipError("That file isn't a valid .vsix archive.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count > limits.maxEntries) throw new ZipError(`That archive has too many entries (limit ${limits.maxEntries}).`);
  if (directoryOffset >= bytes.length) throw new ZipError("That .vsix archive is damaged.");

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries = new Map<string, Entry>();
  let at = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ZipError("That .vsix archive is damaged.");
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    if (at + 46 + nameLength > bytes.length) throw new ZipError("That .vsix archive is damaged.");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // Directory records end in "/" and carry no data; skip them without judging their (always unsafe) trailing segment.
    const isDirectory = name.endsWith("/");
    if (!isDirectory) {
      if (!isSafeEntryName(name)) throw new ZipError(`That archive contains an entry with an unsafe path: ${name}`);
      if (method !== 0 && method !== 8) throw new ZipError(`That archive uses an unsupported compression method (${method}).`);
      if (uncompressedSize > limits.maxEntryBytes) throw new ZipError(`An entry in that archive is too large: ${name}`);
      total += uncompressedSize;
      if (total > limits.maxTotalBytes) throw new ZipError("That archive is too large to read.");
      if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxRatio) {
        throw new ZipError(`An entry in that archive has a suspicious compression ratio: ${name}`);
      }
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }

  const read = (name: string): Uint8Array => {
    const entry = entries.get(name);
    if (!entry) throw new ZipError(`That archive has no entry named ${name}.`);
    const start = entry.localHeaderOffset;
    if (start + 30 > bytes.length || view.getUint32(start, true) !== SIG_LOCAL) {
      throw new ZipError("That .vsix archive is damaged.");
    }
    const nameLength = view.getUint16(start + 26, true);
    const extraLength = view.getUint16(start + 28, true);
    const dataStart = start + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) throw new ZipError("That .vsix archive is damaged.");
    const raw = bytes.subarray(dataStart, dataEnd);
    const out = entry.method === 0 ? raw : new Uint8Array(inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes }));
    // A header that lied about its size does not get to be trusted after the fact either.
    if (out.length !== entry.uncompressedSize) {
      throw new ZipError(`An entry's size didn't match its header: ${name}`);
    }
    return out;
  };

  return { names: () => [...entries.keys()], has: (name) => entries.has(name), read };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/desktop && bun test ./test/themes/zip.test.ts`
Expected: PASS, and specifically the zip-slip test must fail *closed* — `openZip` throws rather than returning an archive whose `names()` contains the traversal path. **Delta: desktop +11 tests.**

- [ ] **Step 5: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add apps/desktop/src/main/themes/zip.ts apps/desktop/test/themes/zip.test.ts
git commit -m "feat(desktop): add a fail-closed read-only zip reader for .vsix import

Refuses zip-slip entry names, oversized entries, oversized archives and
zip bombs. Nothing is extracted to disk.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 6: `.vsix` theme extraction

**Files:**
- Create: `apps/desktop/src/main/themes/vsix.ts`
- Test: `apps/desktop/test/themes/vsix.test.ts`

**Interfaces:**
- Consumes: `openZip`, `ZipError`, `isSafeEntryName` (Task 5); `convertVsCodeTheme` (Task 3).
- Produces, used by Tasks 7 and 8:

```ts
export interface VsixThemeEntry {
  label: string;
  uiTheme: string;
  path: string;
}
export type VsixResult =
  | { ok: true; themes: VsixThemeEntry[] }
  | { ok: false; error: string };
export function listVsixThemes(bytes: Uint8Array): VsixResult;
export function readVsixTheme(bytes: Uint8Array, path: string): { ok: true; json: unknown } | { ok: false; error: string };
```

Spec §9.3: "A `.vsix` file: JSLab extracts `extension/package.json` `contributes.themes` and lets the user pick a theme."

A `contributes.themes` entry's `path` is relative to `extension/` and is written as `"./themes/dark.json"` in practice. Resolving it is a **string** operation against the archive's entry names — never a filesystem path join — and the resolved name is re-checked with `isSafeEntryName` before it is looked up.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/themes/vsix.test.ts
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { listVsixThemes, readVsixTheme } from "../../src/main/themes/vsix";

// Reuse the byte-level builder from zip.test.ts by copying it here; these two suites deliberately do not share a
// helper module, so a change to one archive builder can never silently weaken the other suite's assertions.
function buildZip(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const body = new Uint8Array(deflateRawSync(member.data));
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, 8, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, member.data.length, true);
    local.setUint16(26, name.length, true);
    const localBytes = new Uint8Array(30 + name.length + body.length);
    localBytes.set(new Uint8Array(local.buffer), 0);
    localBytes.set(name, 30);
    localBytes.set(body, 30 + name.length);
    locals.push(localBytes);
    const central = new DataView(new ArrayBuffer(46 + name.length));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, 8, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, member.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(46 + name.length);
    centralBytes.set(new Uint8Array(central.buffer), 0);
    centralBytes.set(name, 46);
    centrals.push(centralBytes);
    offset += localBytes.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, members.length, true);
  eocd.setUint16(10, members.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);
const manifest = (contributes: unknown) => text(JSON.stringify({ name: "pack", contributes }));

describe("listVsixThemes", () => {
  test("reads contributes.themes and defaults a missing label and uiTheme", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [
        { label: "Deep Dark", uiTheme: "vs-dark", path: "./themes/deep.json" },
        { path: "themes/plain.json" },
      ] }) },
      { name: "extension/themes/deep.json", data: text("{}") },
      { name: "extension/themes/plain.json", data: text("{}") },
    ]);
    const result = listVsixThemes(vsix);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([
      { label: "Deep Dark", uiTheme: "vs-dark", path: "extension/themes/deep.json" },
      { label: "plain", uiTheme: "vs-dark", path: "extension/themes/plain.json" },
    ]);
  });

  test("refuses a manifest whose theme path escapes the extension folder", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ label: "Evil", path: "../../../../etc/passwd" }] }) },
    ]);
    const result = listVsixThemes(vsix);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/theme/i);
  });

  test("reports readable errors for a missing manifest, bad JSON and no themes", () => {
    expect(listVsixThemes(buildZip([{ name: "extension/readme.md", data: text("hi") }]))).toEqual({
      ok: false,
      error: "That .vsix doesn't contain an extension manifest.",
    });
    expect(listVsixThemes(buildZip([{ name: "extension/package.json", data: text("{oops") }])).ok).toBe(false);
    expect(listVsixThemes(buildZip([{ name: "extension/package.json", data: manifest({}) }]))).toEqual({
      ok: false,
      error: "That extension doesn't contain any colour themes.",
    });
  });

  test("a damaged archive produces a readable error rather than throwing", () => {
    expect(listVsixThemes(text("not a zip")).ok).toBe(false);
  });
});

describe("readVsixTheme", () => {
  test("reads a declared theme file", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ label: "D", path: "./themes/d.json" }] }) },
      { name: "extension/themes/d.json", data: text('{"name":"D","type":"dark"}') },
    ]);
    const result = readVsixTheme(vsix, "extension/themes/d.json");
    if (!result.ok) throw new Error(result.error);
    expect(result.json).toEqual({ name: "D", type: "dark" });
  });

  test("refuses a path that was never declared by the manifest", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ label: "D", path: "./themes/d.json" }] }) },
      { name: "extension/themes/d.json", data: text("{}") },
      { name: "extension/secret.json", data: text('{"secret":true}') },
    ]);
    expect(readVsixTheme(vsix, "extension/secret.json").ok).toBe(false);
    expect(readVsixTheme(vsix, "../../../../etc/passwd").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/desktop && bun test ./test/themes/vsix.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/themes/vsix.ts
import { isSafeEntryName, openZip, ZipError } from "./zip";

/** One `contributes.themes` entry, with its `path` already resolved to an archive entry name. */
export interface VsixThemeEntry {
  label: string;
  uiTheme: string;
  path: string;
}

export type VsixResult = { ok: true; themes: VsixThemeEntry[] } | { ok: false; error: string };

const MANIFEST = "extension/package.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `"./themes/dark.json"` → `"extension/themes/dark.json"`. A string operation on archive names, never a path join. */
function resolveThemePath(declared: string): string | null {
  const trimmed = declared.trim().replace(/^\.\//, "");
  const full = trimmed.startsWith("extension/") ? trimmed : `extension/${trimmed}`;
  return isSafeEntryName(full) ? full : null;
}

function withArchive<T>(bytes: Uint8Array, use: (read: (name: string) => Uint8Array, has: (name: string) => boolean) => T):
  T | { ok: false; error: string } {
  try {
    const zip = openZip(bytes);
    return use(zip.read, zip.has);
  } catch (error) {
    return { ok: false, error: error instanceof ZipError ? error.message : "That .vsix file couldn't be read." };
  }
}

/** Spec §9.3: extract `extension/package.json` `contributes.themes` so the user can pick one. */
export function listVsixThemes(bytes: Uint8Array): VsixResult {
  return withArchive(bytes, (read, has): VsixResult => {
    if (!has(MANIFEST)) return { ok: false, error: "That .vsix doesn't contain an extension manifest." };
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(read(MANIFEST)));
    } catch {
      return { ok: false, error: "That extension's manifest isn't valid JSON." };
    }
    const contributes = isRecord(manifest) ? manifest.contributes : undefined;
    const declared = isRecord(contributes) ? contributes.themes : undefined;
    if (!Array.isArray(declared) || declared.length === 0) {
      return { ok: false, error: "That extension doesn't contain any colour themes." };
    }
    const themes: VsixThemeEntry[] = [];
    for (const entry of declared) {
      if (!isRecord(entry) || typeof entry.path !== "string") continue;
      const path = resolveThemePath(entry.path);
      if (path === null) return { ok: false, error: "That extension declares a theme outside the package." };
      if (!has(path)) continue;
      const fileName = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/i, "");
      themes.push({
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : fileName,
        uiTheme: typeof entry.uiTheme === "string" && entry.uiTheme.trim() ? entry.uiTheme.trim() : "vs-dark",
        path,
      });
    }
    if (themes.length === 0) return { ok: false, error: "That extension doesn't contain any colour themes." };
    return { ok: true, themes };
  });
}

/**
 * Reads one theme file out of a `.vsix`. The path must be one the manifest itself declared — a caller cannot name an
 * arbitrary archive member, so a UI round trip can't be talked into reading something else out of the package.
 */
export function readVsixTheme(bytes: Uint8Array, path: string): { ok: true; json: unknown } | { ok: false; error: string } {
  const listed = listVsixThemes(bytes);
  if (!listed.ok) return listed;
  if (!listed.themes.some((theme) => theme.path === path)) {
    return { ok: false, error: "That theme isn't part of the selected extension." };
  }
  return withArchive(bytes, (read): { ok: true; json: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, json: JSON.parse(new TextDecoder().decode(read(path))) };
    } catch {
      return { ok: false, error: "That theme file isn't valid JSON." };
    }
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/desktop && bun test ./test/themes/vsix.test.ts`
Expected: PASS. **Delta: desktop +6 tests.**

- [ ] **Step 5: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add apps/desktop/src/main/themes/vsix.ts apps/desktop/test/themes/vsix.test.ts
git commit -m "feat(desktop): read contributes.themes out of a .vsix package

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 7: `ThemeStore` and `<appdata>/themes/`

**Files:**
- Create: `apps/desktop/src/main/services/theme-store.ts`
- Modify: `apps/desktop/src/main/app-paths.ts`
- Test: `apps/desktop/test/services/theme-store.test.ts`, `apps/desktop/test/platform/app-paths.test.ts` (existing — add the `themesDir` assertion)

**Interfaces:**
- Consumes: `convertVsCodeTheme`, `ThemeDefinition` (Task 3); `writeFileAtomic` from `apps/desktop/src/main/persistence/atomic-write.ts`.
- Produces, used by Task 8:

```ts
export class ThemeStore {
  static open(themesDir: string, log: (message: string, detail?: unknown) => void): Promise<ThemeStore>;
  readonly dir: string;
  get themes(): readonly ThemeDefinition[];
  save(theme: ThemeDefinition): Promise<void>;
  onChange(listener: (themes: readonly ThemeDefinition[]) => void): () => void;
}
```

and on `AppPaths` (`apps/desktop/src/main/app-paths.ts`): `themesDir: string`.

Spec §4.5 fixes the location and the extension: `themes/` holds "user-imported themes (`*.jslab-theme.json`)".

**A file in `<appdata>/themes/` is user-editable and therefore untrusted at load.** A theme that fails to parse is skipped and logged; it never prevents startup and never replaces the others.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/services/theme-store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertVsCodeTheme } from "@jslab/themes";
import { ThemeStore } from "../../src/main/services/theme-store";

let dir = "";
const logged: string[] = [];
const log = (message: string) => { logged.push(message); };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-themes-"));
  logged.length = 0;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function theme(name: string) {
  const result = convertVsCodeTheme({ name, type: "dark", colors: { "editor.background": "#101010" } });
  if (!result.ok) throw new Error(result.error);
  return result.theme;
}

describe("ThemeStore", () => {
  test("a missing folder means no themes, and creates nothing until a save", async () => {
    const store = await ThemeStore.open(join(dir, "themes"), log);
    expect(store.themes).toEqual([]);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  test("saves as <id>.jslab-theme.json and reloads it on the next open (spec §4.5)", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    await store.save(theme("Deep Dark"));
    expect(await readdir(themesDir)).toEqual(["deep-dark.jslab-theme.json"]);
    const written = JSON.parse(await readFile(join(themesDir, "deep-dark.jslab-theme.json"), "utf8"));
    expect(written).toMatchObject({ id: "deep-dark", name: "Deep Dark", type: "dark" });
    expect(written.tokens["bg.canvas"]).toMatch(/^#[0-9A-F]{6}$/);

    const reopened = await ThemeStore.open(themesDir, log);
    expect(reopened.themes.map((entry) => entry.id)).toEqual(["deep-dark"]);
  });

  test("re-saving the same id replaces it instead of adding a duplicate", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    await store.save(theme("Deep Dark"));
    await store.save(theme("Deep Dark"));
    expect(store.themes).toHaveLength(1);
    expect(await readdir(themesDir)).toHaveLength(1);
  });

  test("notifies listeners on save and stops after unsubscribe", async () => {
    const store = await ThemeStore.open(join(dir, "themes"), log);
    const seen: number[] = [];
    const stop = store.onChange((themes) => seen.push(themes.length));
    await store.save(theme("A"));
    stop();
    await store.save(theme("B"));
    expect(seen).toEqual([1]);
  });

  test("an unreadable or invalid theme file is skipped and logged, never fatal", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    await store.save(theme("Good"));
    await writeFile(join(themesDir, "broken.jslab-theme.json"), "{not json");
    await writeFile(join(themesDir, "wrong-shape.jslab-theme.json"), JSON.stringify({ id: "x" }));
    await writeFile(join(themesDir, "ignored.txt"), "not a theme");
    const reopened = await ThemeStore.open(themesDir, log);
    expect(reopened.themes.map((entry) => entry.id)).toEqual(["good"]);
    expect(logged).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/desktop && bun test ./test/services/theme-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `themesDir` to `AppPaths`**

In `apps/desktop/src/main/app-paths.ts`, add the field to the `AppPaths` interface with a doc comment, and the value in `resolveAppPaths`'s returned object beside the other `join(dataDir, ...)` entries:

```ts
  /** Spec §4.5: user-imported themes (`*.jslab-theme.json`), written by the VS Code importer (§9.3). */
  themesDir: string;
```

```ts
    themesDir: join(dataDir, "themes"),
```

Add the matching assertion to the existing app-paths test so the layout stays pinned:

```ts
    expect(paths.themesDir).toBe(join(paths.dataDir, "themes"));
```

- [ ] **Step 4: Write the store**

```ts
// apps/desktop/src/main/services/theme-store.ts
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThemeDefinition } from "@jslab/themes";
import { TOKEN_NAMES } from "@jslab/themes";
import { writeFileAtomic } from "../persistence/atomic-write";

const SUFFIX = ".jslab-theme.json";

type Log = (message: string, detail?: unknown) => void;

/** A file under `<appdata>/themes/` is user-editable, so it is validated on load like any other untrusted input. */
function parseTheme(raw: unknown): ThemeDefinition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const theme = raw as Partial<ThemeDefinition>;
  if (typeof theme.id !== "string" || !/^[\w-]{1,64}$/.test(theme.id)) return null;
  if (typeof theme.name !== "string" || !theme.name.trim()) return null;
  if (theme.type !== "dark" && theme.type !== "light") return null;
  if (typeof theme.tokens !== "object" || theme.tokens === null) return null;
  const tokens = theme.tokens as Record<string, unknown>;
  for (const name of TOKEN_NAMES) {
    if (typeof tokens[name] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(tokens[name] as string)) return null;
  }
  const monaco = theme.monaco as ThemeDefinition["monaco"] | undefined;
  if (!monaco || (monaco.base !== "vs" && monaco.base !== "vs-dark") || !Array.isArray(monaco.rules)) return null;
  return theme as ThemeDefinition;
}

/** `<appdata>/themes/` (spec §4.5): the imported themes the Themes menu and the Appearance picker offer (spec §9.3). */
export class ThemeStore {
  readonly #listeners = new Set<(themes: readonly ThemeDefinition[]) => void>();
  #themes: ThemeDefinition[];

  private constructor(
    readonly dir: string,
    themes: ThemeDefinition[],
    private readonly log: Log,
  ) {
    this.#themes = themes;
  }

  static async open(themesDir: string, log: Log): Promise<ThemeStore> {
    let files: string[];
    try {
      files = (await readdir(themesDir)).filter((name) => name.endsWith(SUFFIX)).sort();
    } catch {
      // No folder yet: a fresh install has imported nothing. Nothing is created until the first save.
      return new ThemeStore(themesDir, [], log);
    }
    const themes: ThemeDefinition[] = [];
    for (const file of files) {
      let parsed: ThemeDefinition | null = null;
      try {
        parsed = parseTheme(JSON.parse(await readFile(join(themesDir, file), "utf8")));
      } catch {
        parsed = null;
      }
      if (parsed) themes.push(parsed);
      else log(`Skipped an unreadable theme file: ${file}`);
    }
    return new ThemeStore(themesDir, themes, log);
  }

  get themes(): readonly ThemeDefinition[] {
    return this.#themes;
  }

  async save(theme: ThemeDefinition): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(join(this.dir, `${theme.id}${SUFFIX}`), `${JSON.stringify(theme, null, 2)}\n`);
    this.#themes = [...this.#themes.filter((existing) => existing.id !== theme.id), theme];
    for (const listener of this.#listeners) listener(this.#themes);
  }

  onChange(listener: (themes: readonly ThemeDefinition[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd apps/desktop && bun test ./test/services/theme-store.test.ts ./test/platform/app-paths.test.ts`
Expected: PASS. **Delta: desktop +5 tests (and +1 assertion in the existing app-paths test).**

- [ ] **Step 6: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add apps/desktop/src/main/services/theme-store.ts apps/desktop/src/main/app-paths.ts apps/desktop/test/services/theme-store.test.ts apps/desktop/test/platform/app-paths.test.ts
git commit -m "feat(desktop): persist imported themes under <appdata>/themes

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 8: Themes → Import VS Code Theme…

**Files:**
- Create: `apps/desktop/src/main/rpc/theme-handlers.ts`
- Modify: `packages/shared/src/commands.ts`, `packages/rpc-schema/src/ui-rpc.ts`, `apps/desktop/src/main/menu.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/strings.ts`, `apps/ui/src/api.ts`, `apps/ui/src/rpc.ts`, `apps/ui/src/state/store.ts`, `apps/ui/src/themes/theme-commands.ts`, `apps/ui/src/strings.ts`, `apps/ui/test/fake-api.ts`
- Test: `apps/desktop/test/rpc/theme-handlers.test.ts` (new), `apps/desktop/test/menu.test.ts` (existing), `apps/ui/test/themes.test.ts` (existing), `packages/shared/test/commands.test.ts` (existing)

**Interfaces:**
- Consumes: `ThemeStore` (Task 7), `listVsixThemes`/`readVsixTheme` (Task 6), `convertVsCodeTheme` (Task 3), `registerUserThemes` (Task 4).
- Produces:

```ts
// packages/shared/src/commands.ts — one new entry in COMMANDS
{ id: "theme.import", title: "Import VS Code Theme…", category: "theme" }

// packages/rpc-schema/src/ui-rpc.ts
export interface ImportedTheme { id: string; name: string; type: "dark" | "light" }
export interface VsixChoice { label: string; path: string }
export type ThemeImportResult =
  | { ok: true; theme: ImportedTheme }
  | { ok: true; choices: VsixChoice[]; token: string }
  | { ok: false; error: string };
export const themeImportPickParamsSchema: z.ZodType<{ token: string; path: string }>;
// MainRequests:  "theme.import": { params: Record<string, never>; response: ThemeImportResult }
//                "theme.importPick": { params: { token: string; path: string }; response: ThemeImportResult }
// ViewMessages:  "theme.changed": { themes: ThemeDefinition[] }
// BootstrapPayload: userThemes?: ThemeDefinition[]

// apps/ui/src/api.ts — MainApi
importTheme(): Promise<ThemeImportResult>;
importThemePick(token: string, path: string): Promise<ThemeImportResult>;
```

**Why a token for the `.vsix` pick.** A multi-theme `.vsix` needs a second round trip after the user chooses. Main keeps the archive bytes against a `crypto.randomUUID()` token with a 5-minute TTL — the same token idiom `FileService` already uses for large files and Save As (`apps/desktop/src/main/files/file-service.ts:132-146`). **The UI never sends a filesystem path**, which keeps spec §18's "no generic read any file endpoint" intact.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/rpc/theme-handlers.test.ts
import { describe, expect, mock, test } from "bun:test";
import { createThemeHandlers } from "../../src/main/rpc/theme-handlers";

const singleThemeJson = JSON.stringify({ name: "Deep Dark", type: "dark", colors: { "editor.background": "#101010" } });

function deps(overrides: Partial<Parameters<typeof createThemeHandlers>[0]> = {}) {
  const saved: { id: string }[] = [];
  return {
    saved,
    deps: {
      store: { save: mock(async (theme: { id: string }) => { saved.push(theme); }), themes: [] },
      openDialog: mock(async () => ["/tmp/theme.json"]),
      readFileBytes: mock(async () => new TextEncoder().encode(singleThemeJson)),
      onChanged: mock(() => {}),
      log: mock(() => {}),
      ...overrides,
    } as Parameters<typeof createThemeHandlers>[0],
  };
}

describe("theme.import", () => {
  test("converts and saves a .json theme, then reports it", async () => {
    const { deps: d, saved } = deps();
    const result = await createThemeHandlers(d).requests["theme.import"]({});
    expect(result).toEqual({ ok: true, theme: { id: "deep-dark", name: "Deep Dark", type: "dark" } });
    expect(saved.map((theme) => theme.id)).toEqual(["deep-dark"]);
    expect(d.onChanged).toHaveBeenCalled();
  });

  test("a cancelled dialog is not an error and saves nothing", async () => {
    const { deps: d, saved } = deps({ openDialog: mock(async () => []) });
    expect(await createThemeHandlers(d).requests["theme.import"]({})).toEqual({ ok: false, error: "" });
    expect(saved).toEqual([]);
  });

  test("an unreadable file and an invalid theme both produce readable errors (spec §9.3)", async () => {
    const unreadable = deps({ readFileBytes: mock(async () => { throw new Error("EACCES: /opt/data/theme.json"); }) });
    const failed = await createThemeHandlers(unreadable.deps).requests["theme.import"]({});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).not.toMatch(/[/\\]/);

    const garbage = deps({ readFileBytes: mock(async () => new TextEncoder().encode("{not json")) });
    const bad = await createThemeHandlers(garbage.deps).requests["theme.import"]({});
    expect(bad.ok).toBe(false);
  });

  test("theme.importPick refuses an unknown or expired token", async () => {
    const handlers = createThemeHandlers(deps().deps);
    const result = await handlers.requests["theme.importPick"]({ token: crypto.randomUUID(), path: "extension/a.json" });
    expect(result.ok).toBe(false);
  });

  test("theme.importPick rejects a malformed payload", async () => {
    const handlers = createThemeHandlers(deps().deps);
    await expect(handlers.requests["theme.importPick"]({ token: "not-a-uuid", path: 42 })).rejects.toThrow();
  });
});
```

Add to the existing `apps/desktop/test/menu.test.ts`:

```ts
  test("the Themes menu offers Import VS Code Theme… (spec §9.3)", () => {
    const themes = buildMenu(model()).find((entry) => entry.label === "Themes");
    const labels = (themes?.submenu ?? []).map((entry) => entry.label);
    expect(labels).toContain("Import VS Code Theme…");
    const item = (themes?.submenu ?? []).find((entry) => entry.label === "Import VS Code Theme…");
    expect(item?.action).toBe("command:theme.import");
  });
```

and to the existing `apps/ui/test/themes.test.ts`:

```ts
  test("theme.import asks Main to import and does not touch settings itself", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.importTheme.mockImplementation(async () => ({ ok: true, theme: { id: "deep", name: "Deep", type: "dark" } }));
    const commands = new Map(createThemeCommands(store, api).map((spec) => [spec.id, spec]));
    await commands.get("theme.import")?.run();
    expect(api.importTheme).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/desktop && bun test ./test/rpc/theme-handlers.test.ts ./test/menu.test.ts
cd ../ui && bun test ./test/themes.test.ts
```
Expected: FAIL — the handler module is missing, `theme.import` is not a `CommandId`, and `fake-api.ts` has no `importTheme`.

- [ ] **Step 3: Add the command id and the schema**

In `packages/shared/src/commands.ts`, beside the other `theme` entries:

```ts
  { id: "theme.import", title: "Import VS Code Theme…", category: "theme" },
```

In `packages/rpc-schema/src/ui-rpc.ts`, the types above plus:

```ts
export const themeImportPickParamsSchema = z.object({
  token: z.uuid(),
  // An archive entry name the manifest declared, never a filesystem path (spec §18).
  path: z.string().min(1).max(512),
});
```

and the three `MainRequests`/`ViewMessages`/`BootstrapPayload` additions listed under **Interfaces**.

- [ ] **Step 4: Write the handler group**

```ts
// apps/desktop/src/main/rpc/theme-handlers.ts
import { emptyParamsSchema, type ThemeImportResult, themeImportPickParamsSchema } from "@jslab/rpc-schema";
import { convertVsCodeTheme, type ThemeDefinition } from "@jslab/themes";
import { listVsixThemes, readVsixTheme } from "../themes/vsix";
import type { ThemeStore } from "../services/theme-store";
import { strings } from "../strings";
import { createValidators, type Log } from "./validate";

export interface ThemeHandlerDeps {
  store: Pick<ThemeStore, "save" | "themes">;
  /** Main's own open dialog (or the E2E script); the UI never supplies a path. */
  openDialog(): Promise<string[]>;
  readFileBytes(path: string): Promise<Uint8Array>;
  onChanged(themes: readonly ThemeDefinition[]): void;
  log: Log;
}

const PICK_TTL_MS = 5 * 60_000;
/** A .vsix larger than this is refused before it is read into memory. */
const MAX_VSIX_BYTES = 64 * 1024 * 1024;

/** Themes → Import VS Code Theme… (spec §9.3). */
export function createThemeHandlers(deps: ThemeHandlerDeps) {
  const { parse } = createValidators(deps.log);
  const pending = new Map<string, { bytes: Uint8Array; expiresAt: number }>();

  const sweep = () => {
    const now = Date.now();
    for (const [token, entry] of pending) if (entry.expiresAt < now) pending.delete(token);
  };

  const commit = async (json: unknown, fallbackName: string): Promise<ThemeImportResult> => {
    const converted = convertVsCodeTheme(json, { fallbackName });
    if (!converted.ok) return { ok: false, error: converted.error };
    await deps.store.save(converted.theme);
    deps.onChanged(deps.store.themes);
    const { id, name, type } = converted.theme;
    return { ok: true, theme: { id, name, type } };
  };

  const importFrom = async (path: string): Promise<ThemeImportResult> => {
    let bytes: Uint8Array;
    try {
      bytes = await deps.readFileBytes(path);
    } catch (error) {
      // The raw message can carry an absolute path; log it, show the user a readable line (spec §9.3, §18).
      deps.log("Couldn't read the selected theme file", String(error));
      return { ok: false, error: strings.themes.unreadable };
    }
    if (bytes.length > MAX_VSIX_BYTES) return { ok: false, error: strings.themes.tooLarge };
    const fileName = path.slice(path.lastIndexOf("/") + 1).replace(/\.(json|vsix)$/i, "");

    if (path.toLowerCase().endsWith(".vsix")) {
      const listed = listVsixThemes(bytes);
      if (!listed.ok) return { ok: false, error: listed.error };
      const [only] = listed.themes;
      if (listed.themes.length === 1 && only) {
        const read = readVsixTheme(bytes, only.path);
        return read.ok ? commit(read.json, only.label) : { ok: false, error: read.error };
      }
      sweep();
      const token = crypto.randomUUID();
      pending.set(token, { bytes, expiresAt: Date.now() + PICK_TTL_MS });
      return { ok: true, token, choices: listed.themes.map(({ label, path: entry }) => ({ label, path: entry })) };
    }

    try {
      return await commit(JSON.parse(new TextDecoder().decode(bytes)), fileName);
    } catch {
      return { ok: false, error: strings.themes.notJson };
    }
  };

  return {
    requests: {
      "theme.import": async (input: unknown): Promise<ThemeImportResult> => {
        parse(emptyParamsSchema, "theme.import", input);
        const [path] = await deps.openDialog();
        // A cancelled dialog is not a failure: an empty error means "say nothing".
        if (!path) return { ok: false, error: "" };
        return importFrom(path);
      },
      "theme.importPick": async (input: unknown): Promise<ThemeImportResult> => {
        const { token, path } = parse(themeImportPickParamsSchema, "theme.importPick", input);
        sweep();
        const entry = pending.get(token);
        pending.delete(token);
        if (!entry) return { ok: false, error: strings.themes.pickExpired };
        const read = readVsixTheme(entry.bytes, path);
        if (!read.ok) return { ok: false, error: read.error };
        const label = listVsixThemes(entry.bytes);
        const chosen = label.ok ? label.themes.find((theme) => theme.path === path)?.label : undefined;
        return commit(read.json, chosen ?? "Imported Theme");
      },
    },
    messages: {},
  };
}
```

Add to `apps/desktop/src/main/strings.ts`:

```ts
  themes: {
    unreadable: "That theme file couldn't be read.",
    tooLarge: "That file is too large to import.",
    notJson: "That file isn't a valid VS Code theme.",
    pickExpired: "That import expired. Choose the file again.",
  },
```

- [ ] **Step 5: Wire it up in `index.ts`**

Open the store beside the other services, register the handler group in `mergeHandlers`, and broadcast changes to both windows and the menu. Mirror the existing `createFileHandlers` dialog branch exactly, including its `e2eEnabled` path (`apps/desktop/src/main/index.ts:343-356`), so the E2E suite can script the file choice:

```ts
const themes = await ThemeStore.open(paths.themesDir, log);
registerUserThemes(themes.themes);
```

```ts
      createThemeHandlers({
        store: themes,
        openDialog: async () =>
          e2eEnabled
            ? await readE2EOpenDialog(paths.dataDir)
            : await Utils.openFileDialog({
                startingFolder: Utils.paths.documents,
                allowedFileTypes: "json,vsix",
                canChooseFiles: true,
                canChooseDirectory: false,
                allowsMultipleSelection: false,
              }),
        readFileBytes: (path) => Bun.file(path).bytes(),
        onChanged: (all) => {
          registerUserThemes(all);
          rpc.send["theme.changed"]({ themes: [...all] });
          menu.refresh();
        },
        log,
      }),
```

`registerUserThemes` is called in **Main** so `listThemes()` at `index.ts:444` includes imported themes in the Themes menu, and in the **UI** on `theme.changed` and at bootstrap so the picker, palette and Monaco see them (Finding T1).

Add the menu item in `apps/desktop/src/main/menu.ts`'s Themes submenu, after the theme list and before the follow-system toggle:

```ts
        separator,
        item("theme.import"),
```

- [ ] **Step 6: Wire the UI side**

- `apps/ui/src/api.ts` + `apps/ui/src/rpc.ts`: the two new methods.
- `apps/ui/test/fake-api.ts`: `importTheme` and `importThemePick` mocks — it is `satisfies MainApi`, so typecheck fails until they exist.
- `apps/ui/src/state/store.ts`: in `hydrate`, `registerUserThemes(payload.userThemes ?? [])`.
- `apps/ui/src/shell/App.tsx`: subscribe to `theme.changed` alongside the other `api.on` calls, calling `registerUserThemes(themes)` and then `store.getState().setThemeId(...)`'s existing sync path via `startThemeSync`'s settings subscription — simplest correct form:

```ts
      api.on("theme.changed", ({ themes }) => {
        registerUserThemes(themes);
        // The theme list changed underneath the picker and Monaco; re-apply the current selection.
        const settings = store.getState().settings;
        if (settings) store.getState().updateSettings({ ...settings });
      }),
```

- `apps/ui/src/themes/theme-commands.ts`: add the command, and **replace the module-level `KNOWN` set** — it is computed once at import (`const KNOWN = new Set(listThemes().map(...))`) and would reject every imported id:

```ts
    {
      id: "theme.import",
      run: async () => {
        const result = await api.importTheme();
        if (result.ok && "theme" in result) {
          await writeSettings(store, api, { appearance: { theme: result.theme.id, followSystem: false } });
          store.getState().setStatusMessage(strings.themes.imported(result.theme.name));
          return;
        }
        if (!result.ok && result.error) store.getState().setStatusMessage(result.error);
        if (result.ok && "choices" in result) store.getState().openModal({ kind: "themePick", ...result });
      },
    },
```

and in `theme.select`, swap `KNOWN.has(themeId)` for a live check, since `listThemes()` now grows at runtime:

```ts
        if (typeof themeId !== "string" || !listThemes().some((theme) => theme.id === themeId)) return;
```

The `themePick` modal is a small list dialog in the existing `Modal` union (`apps/ui/src/state/store.ts:71`) rendered beside `RenameDialog`; it calls `api.importThemePick(token, path)` and applies the result the same way.

- [ ] **Step 7: Run everything and watch it pass**

```bash
cd apps/desktop && bun test ./test
cd ../ui && bun test ./test
cd ../../packages/shared && bun test ./test
```
Expected: PASS. **Delta: desktop +6, ui +1, shared +0.** `packages/shared/test/commands.test.ts` asserts id uniqueness, non-empty titles and known categories — it has **no** length assertion — so adding `theme.import` requires no edit there.

- [ ] **Step 8: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add -A
git commit -m "feat: import a VS Code theme from a .json or .vsix file

Themes -> Import VS Code Theme... converts the file onto JSLab's semantic
token set, saves it under <appdata>/themes and offers it immediately in the
Themes menu, the Appearance picker and the command palette.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 9: Keybindings become live and writable

**Files:**
- Modify: `apps/desktop/src/main/services/keybindings-store.ts`, `apps/desktop/src/main/index.ts`, `apps/ui/src/state/store.ts`, `apps/ui/src/shell/App.tsx`, `packages/rpc-schema/src/ui-rpc.ts`
- Test: `apps/desktop/test/services/keybindings-store.test.ts` (existing), `apps/ui/test/keybindings-live.test.tsx` (new)

**Interfaces:**
- Consumes: `keybindingsFileSchema`, `keybindingRuleSchema`, `resolveKeybindings`, `DEFAULT_KEYBINDINGS` (`packages/shared/src/keybindings.ts`); `writeFileAtomic`.
- Produces, used by Tasks 10–12:

```ts
// apps/desktop/src/main/services/keybindings-store.ts
export class KeybindingsStore {
  static open(dataDir: string): Promise<KeybindingsStore>;
  readonly path: string;
  readonly invalid: boolean;
  get rules(): readonly KeybindingRule[];
  save(rules: readonly KeybindingRule[]): Promise<void>;
  onChange(listener: (rules: readonly KeybindingRule[]) => void): () => void;
}

// packages/rpc-schema/src/ui-rpc.ts
export const keybindingsSaveParamsSchema: z.ZodType<{ rules: KeybindingRule[] }>;
// ViewMessages + SettingsViewMessages: "keybindings.changed": { rules: KeybindingRule[] }

// apps/ui/src/state/store.ts — AppState
setKeybindings(rules: KeybindingRule[]): void;
```

**This task fixes Finding K1 and nothing else. It ships no UI.** Its deliverable is: a saved `keybindings.json` takes effect in the running app — in the key dispatcher, in the palette's keycaps, in the chrome's keycaps and in the native menu's shortcut text — without a relaunch. Tasks 11 and 12 are unbuildable until this is true, and building them first would hide the defect behind a UI that appears to work until someone restarts.

`rules` changes from a public readonly field to a getter over private state. That is a **breaking change for `rpc-handlers.ts:33`**, which declares `keybindings?: { rules: KeybindingRule[] }` — widen it to `{ rules: readonly KeybindingRule[] }` and spread at the call site.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/test/services/keybindings-store.test.ts`:

```ts
  test("saves rules atomically, keeps them in memory and notifies listeners", async () => {
    const store = await KeybindingsStore.open(dir);
    const seen: number[] = [];
    const stop = store.onChange((rules) => seen.push(rules.length));
    await store.save([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect([...store.rules]).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect(JSON.parse(await readFile(join(dir, "keybindings.json"), "utf8"))).toEqual([
      { key: "cmd+shift+k", command: "output.clear" },
    ]);
    stop();
    await store.save([]);
    expect(seen).toEqual([1]);
    expect([...store.rules]).toEqual([]);
  });

  test("a save drops rules the read path would reject, so the file can never hold what we'd ignore", async () => {
    const store = await KeybindingsStore.open(dir);
    await store.save([
      { key: "cmd+shift+k", command: "output.clear" },
      { key: "cmd+??", command: "run.start" },
      { key: "cmd+j", command: "not.a.command" },
    ] as never);
    expect([...store.rules]).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect((await KeybindingsStore.open(dir)).rules).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
  });

  test("a reopened store sees what the previous one saved", async () => {
    const first = await KeybindingsStore.open(dir);
    await first.save([{ key: "cmd+k", command: "-output.clear" }]);
    expect([...(await KeybindingsStore.open(dir)).rules]).toEqual([{ key: "cmd+k", command: "-output.clear" }]);
  });
```

New `apps/ui/test/keybindings-live.test.tsx` — the regression test for Finding K1:

```tsx
import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, render } from "@testing-library/react";
import { App } from "../src/shell/App";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
    keybindings: [],
  });
  const { api, emit } = createFakeApi();
  return { store, api, emit };
}

const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });

describe("keybindings apply without a relaunch (Finding K1)", () => {
  test("a rebound chord dispatches to the new command as soon as the store changes", async () => {
    const { store, api } = setup();
    render(<App store={store} api={api} />);
    // ⌘R is run.start by default; rebinding it to run.stop must take effect immediately.
    await press({ code: "KeyR", metaKey: true });
    expect(api.startRun).toHaveBeenCalledTimes(1);

    act(() => store.getState().setKeybindings([{ key: "cmd+r", command: "run.stop" }]));
    await press({ code: "KeyR", metaKey: true });
    expect(api.startRun).toHaveBeenCalledTimes(1);
    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  test("a removal rule stops the default chord from firing at all", async () => {
    const { store, api } = setup();
    render(<App store={store} api={api} />);
    act(() => store.getState().setKeybindings([{ key: "cmd+r", command: "-run.start" }]));
    await press({ code: "KeyR", metaKey: true });
    expect(api.startRun).not.toHaveBeenCalled();
  });

  test("a keybindings.changed broadcast from Main updates the store", async () => {
    const { store, api, emit } = setup();
    render(<App store={store} api={api} />);
    await emit("keybindings.changed", { rules: [{ key: "cmd+r", command: "run.stop" }] });
    expect(store.getState().keybindings).toEqual([{ key: "cmd+r", command: "run.stop" }]);
    await press({ code: "KeyR", metaKey: true });
    expect(api.stop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/desktop && bun test ./test/services/keybindings-store.test.ts
cd ../ui && bun test ./test/keybindings-live.test.tsx
```
Expected: FAIL — `store.save is not a function`, `setKeybindings is not a function`, and (the point of the task) the rebound chord still dispatching `run.start`.

- [ ] **Step 3: Make the store writable**

```ts
// apps/desktop/src/main/services/keybindings-store.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type KeybindingRule, keybindingsFileSchema } from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";

/** User keybinding overrides in keybindings.json (spec §4.5, §6.5), read at startup and written by Settings → Keybindings. */
export class KeybindingsStore {
  #rules: KeybindingRule[];
  readonly #listeners = new Set<(rules: readonly KeybindingRule[]) => void>();

  private constructor(
    readonly path: string,
    rules: KeybindingRule[],
    readonly invalid: boolean,
  ) {
    this.#rules = rules;
  }

  static async open(dataDir: string): Promise<KeybindingsStore> {
    const path = join(dataDir, "keybindings.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return new KeybindingsStore(path, [], false);
    }
    try {
      return new KeybindingsStore(path, keybindingsFileSchema.parse(JSON.parse(text)), false);
    } catch {
      return new KeybindingsStore(path, [], true);
    }
  }

  get rules(): readonly KeybindingRule[] {
    return this.#rules;
  }

  /**
   * Replaces the whole override set. The incoming rules go through `keybindingsFileSchema` — the same validator the
   * read path uses — so the file can never end up holding a rule that a later launch would silently drop.
   */
  async save(rules: readonly KeybindingRule[]): Promise<void> {
    const valid = keybindingsFileSchema.parse(rules);
    await writeFileAtomic(this.path, `${JSON.stringify(valid, null, 2)}\n`, { backup: true });
    this.#rules = valid;
    for (const listener of this.#listeners) listener(valid);
  }

  onChange(listener: (rules: readonly KeybindingRule[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
```

- [ ] **Step 4: Unfreeze the UI (the core of Finding K1)**

In `apps/ui/src/state/store.ts`, add the action to `AppState` and its implementation:

```ts
      setKeybindings(keybindings) {
        set({ keybindings });
      },
```

In `apps/ui/src/shell/App.tsx`, replace line 217. `useStore` is already imported:

```ts
  // Finding K1: this used to be useMemo(..., [store]) reading state imperatively, so it ran once at mount and a
  // saved binding could never take effect before a relaunch. Subscribing is what makes Settings → Keybindings work.
  const keybindingRules = useStore(store, (s) => s.keybindings);
  const bindings = useMemo(() => resolveKeybindings(DEFAULT_KEYBINDINGS, keybindingRules), [keybindingRules]);
```

Everything downstream is already reactive: `keysFor` depends on `bindings`, `resolver` is `useMemo(..., [bindings])` (Finding K3), and `keycaps` depends on `keysFor`. Add the broadcast subscription beside the other `api.on` calls:

```ts
      api.on("keybindings.changed", ({ rules }) => store.getState().setKeybindings(rules)),
```

- [ ] **Step 5: Unfreeze Main's menu keycaps**

In `apps/desktop/src/main/index.ts`, `resolvedBindings` (line 437) is a `const` captured by the menu builder. Make it reassignable and refresh on change:

```ts
  let resolvedBindings = resolveKeybindings(DEFAULT_KEYBINDINGS, keybindings.rules);
```

```ts
  keybindings.onChange((rules) => {
    resolvedBindings = resolveKeybindings(DEFAULT_KEYBINDINGS, rules);
    menu.refresh();
    if (mainWindow.isOpen()) rpc.send["keybindings.changed"]({ rules: [...rules] });
    if (settingsWindow.isOpen()) settingsRpc.send["keybindings.changed"]({ rules: [...rules] });
  });
```

Place this after `menu` and both windows are declared. Also widen `RpcHandlerDeps.keybindings` in `apps/desktop/src/main/rpc-handlers.ts:33` to `{ rules: readonly KeybindingRule[] }` and spread at the bootstrap call site:

```ts
        ...(deps.keybindings ? { keybindings: [...deps.keybindings.rules] } : {}),
```

- [ ] **Step 6: Run them and watch them pass**

```bash
cd apps/desktop && bun test ./test
cd ../ui && bun test ./test/keybindings-live.test.tsx ./test/keybindings.test.ts ./test/palette.test.tsx
```
Expected: PASS. **Delta: desktop +3, ui +3.**

- [ ] **Step 7: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add -A
git commit -m "fix(keybindings): apply saved bindings without a relaunch

The UI resolved bindings once at mount and Main captured them once at
startup, so a keybindings.json change could not take effect in a running
app. Bindings are now reactive in the dispatcher, the palette, the chrome
and the native menu, and KeybindingsStore can write the file.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 10: The command catalogue on the Settings wire

**Files:**
- Create: `apps/desktop/src/main/rpc/keybinding-handlers.ts`
- Modify: `packages/rpc-schema/src/ui-rpc.ts`, `apps/desktop/src/main/index.ts`, `apps/ui/src/shell/App.tsx`, `apps/ui/src/settings/settings-rpc.ts`, `apps/desktop/src/main/rpc/app-handlers.ts`
- Test: `apps/desktop/test/rpc/keybinding-handlers.test.ts` (new)

**Interfaces:**
- Consumes: `COMMANDS`, `commandMeta` (`packages/shared/src/commands.ts`); `KeybindingsStore` (Task 9); `CommandRegistry.list()`.
- Produces, used by Tasks 11–12:

```ts
// packages/rpc-schema/src/ui-rpc.ts
export interface CommandCatalogEntry {
  id: CommandId;
  title: string;
  category: CommandCategory;
  /** True when the running main window has this command registered. */
  registered: boolean;
}
export const commandsPublishedSchema: z.ZodType<{ ids: string[] }>;
export const keybindingsSaveParamsSchema: z.ZodType<{ rules: KeybindingRule[] }>;
// MainMessages:            "commands.published": { ids: string[] }
// SettingsWindowRequests:  "commands.catalog":   { params: {}; response: { commands: CommandCatalogEntry[] } }
//                          "keybindings.get":    { params: {}; response: { rules: KeybindingRule[]; defaults: KeybindingRule[]; path: string } }
//                          "keybindings.save":   { params: { rules: KeybindingRule[] }; response: SaveResult }
// SETTINGS_APP_ACTIONS += "openKeybindingsFile"
```

**This is the task that honours the cross-plan interface with M5a.** The catalogue's rows come from `COMMANDS` — the one list every milestone must already extend, because `isCommandId` gates `keybindingsFileSchema`, `resolveKeybindings`, `commandForMenuAction` and `CommandRegistry.has`. **M5d maintains no list of its own**, so M5a's `F9` logpoint toggle and `Cmd+Shift+F9` clear-all appear in Settings → Keybindings, and become reboundable and resettable, with zero edits to M5d's code.

`registered` is annotated from the main window's live `CommandRegistry.list()`, published to Main — **Finding S1**: the registry lives in the main window's React tree, so the Settings window cannot reach it directly. `App.tsx:368` already computes exactly this list for the E2E agent; this reuses that expression rather than inventing a second one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/rpc/keybinding-handlers.test.ts
import { describe, expect, mock, test } from "bun:test";
import { COMMANDS } from "@jslab/shared";
import { createKeybindingHandlers } from "../../src/main/rpc/keybinding-handlers";

function setup(published: string[] = []) {
  const saved: unknown[] = [];
  const deps = {
    store: {
      path: "/data/keybindings.json",
      rules: [{ key: "cmd+k", command: "-output.clear" }],
      save: mock(async (rules: unknown) => { saved.push(rules); }),
    },
    registeredCommands: () => published,
    log: mock(() => {}),
  };
  return { deps, saved, handlers: createKeybindingHandlers(deps as never) };
}

describe("commands.catalog", () => {
  // The cross-plan guarantee: the catalogue is COMMANDS, not a list this milestone maintains. When M5a adds
  // debug.toggleLogpoint and debug.clearLogpoints, this test keeps passing only if the enumeration stays dynamic.
  test("lists every command in the shared catalogue, and nothing else", async () => {
    const { handlers } = setup();
    const { commands } = await handlers.requests["commands.catalog"]({});
    expect(commands).toHaveLength(COMMANDS.length);
    expect(commands.map((entry) => entry.id).sort()).toEqual(COMMANDS.map((entry) => entry.id).sort());
    for (const entry of commands) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.registered).toBe("boolean");
    }
  });

  test("annotates which commands the running window actually registered", async () => {
    const { handlers } = setup(["run.start", "not.a.real.command"]);
    const { commands } = await handlers.requests["commands.catalog"]({});
    const byId = new Map(commands.map((entry) => [entry.id, entry]));
    expect(byId.get("run.start")?.registered).toBe(true);
    expect(byId.get("run.kill")?.registered).toBe(false);
    expect(byId.has("not.a.real.command" as never)).toBe(false);
  });
});

describe("keybindings.get / keybindings.save", () => {
  test("returns the user rules, the defaults and the file path", async () => {
    const { handlers } = setup();
    const result = await handlers.requests["keybindings.get"]({});
    expect(result.rules).toEqual([{ key: "cmd+k", command: "-output.clear" }]);
    expect(result.defaults.length).toBeGreaterThan(0);
    expect(result.path).toBe("/data/keybindings.json");
  });

  test("saves valid rules and reports a write failure as a readable result", async () => {
    const { handlers, saved, deps } = setup();
    expect(await handlers.requests["keybindings.save"]({ rules: [{ key: "cmd+j", command: "run.start" }] }))
      .toEqual({ ok: true });
    expect(saved).toEqual([[{ key: "cmd+j", command: "run.start" }]]);
    deps.store.save.mockImplementation(async () => { throw new Error("EACCES: /opt/data/keybindings.json"); });
    const failed = await handlers.requests["keybindings.save"]({ rules: [] });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).not.toMatch(/[/\\]/);
  });

  test("rejects a malformed payload rather than writing it", async () => {
    const { handlers, saved } = setup();
    await expect(handlers.requests["keybindings.save"]({ rules: "nope" })).rejects.toThrow();
    await expect(handlers.requests["keybindings.save"]({})).rejects.toThrow();
    expect(saved).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/desktop && bun test ./test/rpc/keybinding-handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the schemas**

In `packages/rpc-schema/src/ui-rpc.ts`:

```ts
export const commandsPublishedSchema = z.object({ ids: z.array(z.string().min(1).max(100)).max(1000) });

export const keybindingsSaveParamsSchema = z.object({
  rules: z.array(keybindingRuleSchema).max(500),
});
```

`keybindingRuleSchema` is already exported from `@jslab/shared`; import it beside the existing `KeybindingRule` type import at the top of the file. Add `"openKeybindingsFile"` to `APP_ACTIONS` and to `SETTINGS_APP_ACTIONS`.

- [ ] **Step 4: Write the handler group**

```ts
// apps/desktop/src/main/rpc/keybinding-handlers.ts
import {
  type CommandCatalogEntry,
  emptyParamsSchema,
  keybindingsSaveParamsSchema,
  type SaveResult,
} from "@jslab/rpc-schema";
import { COMMANDS, DEFAULT_KEYBINDINGS, type KeybindingRule } from "@jslab/shared";
import type { KeybindingsStore } from "../services/keybindings-store";
import { strings } from "../strings";
import { createValidators, type Log } from "./validate";

export interface KeybindingHandlerDeps {
  store: Pick<KeybindingsStore, "path" | "rules" | "save">;
  /** Ids the running main window has registered, published by App.tsx. Empty when no window is open. */
  registeredCommands(): readonly string[];
  log: Log;
}

/** Settings → Keybindings (spec §6.5), served to the Settings window. */
export function createKeybindingHandlers(deps: KeybindingHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      /**
       * The command catalogue the table renders.
       *
       * Rows come from `COMMANDS` in @jslab/shared — the single list every milestone already extends, since
       * `isCommandId` gates binding, dispatch and menu clicks. Nothing here enumerates commands by hand, so a
       * command added by another milestone (M5a's logpoint toggle, for example) appears with no change to this file.
       */
      "commands.catalog": (input: unknown): { commands: CommandCatalogEntry[] } => {
        parse(emptyParamsSchema, "commands.catalog", input);
        const registered = new Set(deps.registeredCommands());
        return {
          commands: COMMANDS.map((command) => ({
            id: command.id,
            title: command.title,
            category: command.category,
            registered: registered.has(command.id),
          })),
        };
      },
      "keybindings.get": (
        input: unknown,
      ): { rules: KeybindingRule[]; defaults: KeybindingRule[]; path: string } => {
        parse(emptyParamsSchema, "keybindings.get", input);
        return { rules: [...deps.store.rules], defaults: [...DEFAULT_KEYBINDINGS], path: deps.store.path };
      },
      "keybindings.save": async (input: unknown): Promise<SaveResult> => {
        const { rules } = parse(keybindingsSaveParamsSchema, "keybindings.save", input);
        try {
          await deps.store.save(rules);
          return { ok: true };
        } catch (error) {
          // The raw message can carry an absolute path (EACCES). Log it; show the user a readable line (spec §18).
          deps.log("Couldn't write keybindings.json", String(error));
          return { ok: false, error: strings.keybindings.saveFailed };
        }
      },
    },
    messages: {},
  };
}
```

Add to `apps/desktop/src/main/strings.ts`:

```ts
  keybindings: {
    saveFailed: "Couldn't save your keybindings. Your changes are still here.",
  },
```

- [ ] **Step 5: Publish the registry's ids, and wire the group**

In `apps/ui/src/shell/App.tsx`, publish once per registry build — the same expression the E2E agent already uses at line 368:

```ts
  useEffect(() => {
    api.publishCommands(registry.list().map((spec) => spec.id));
  }, [api, registry]);
```

with `publishCommands(ids: string[]): void` on `MainApi` (and on `apps/ui/test/fake-api.ts`, which is `satisfies MainApi`).

In `apps/desktop/src/main/index.ts`: hold the published ids, handle the message in the main RPC, and register the handler group on the **Settings** RPC:

```ts
  let publishedCommands: readonly string[] = [];
```

```ts
      createKeybindingHandlers({
        store: keybindings,
        registeredCommands: () => publishedCommands,
        log,
      }),
```

and in `runAppAction` (`apps/desktop/src/main/rpc/app-handlers.ts`), the new action — spec §6.5's "Open keybindings.json":

```ts
    case "openKeybindingsFile":
      deps.openPath(deps.paths.keybindingsFile);
      return;
```

adding `keybindingsFile: string` to `AppHandlerDeps.paths` and passing `join(paths.dataDir, "keybindings.json")` at the call site. **Main must ensure the file exists before opening it**, or the user gets a "no such file" dialog on a fresh install — write `[]` through `keybindings.save` first when `store.rules` is empty and the file is absent.

- [ ] **Step 6: Run it and watch it pass**

Run: `cd apps/desktop && bun test ./test/rpc/keybinding-handlers.test.ts ./test/rpc` then `cd ../ui && bun test ./test`
Expected: PASS. **Delta: desktop +5.**

- [ ] **Step 7: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add -A
git commit -m "feat(settings): serve the command catalogue and keybindings to the Settings window

The catalogue is derived from COMMANDS, so commands added by other
milestones appear without changes here.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 11: The Keybindings table

**Files:**
- Create: `apps/ui/src/settings/keybinding-rows.ts`, `apps/ui/src/settings/KeybindingsPane.tsx`
- Modify: `apps/ui/src/settings/fields.ts`, `apps/ui/src/settings/SettingsApp.tsx`, `apps/ui/src/settings/settings-rpc.ts`, `apps/ui/src/settings/settings-agent.ts`, `apps/ui/src/strings.ts`, `apps/ui/src/styles.css`
- Test: `apps/ui/test/keybinding-rows.test.ts` (new), `apps/ui/test/keybindings-pane.test.tsx` (new)

**Interfaces:**
- Consumes: `CommandCatalogEntry`, `keybindings.get` (Task 10); `resolveKeybindings`, `formatChord` (`packages/shared/src/keybindings.ts`).
- Produces, used by Task 12:

```ts
// apps/ui/src/settings/keybinding-rows.ts
export interface KeybindingRow {
  command: CommandId;
  title: string;
  category: CommandCategory;
  /** The chord spec ("cmd+r"), or null when the command is unbound. */
  key: string | null;
  /** The keycap text ("⌘R"), or null when unbound. */
  keyLabel: string | null;
  when: string | null;
  source: "default" | "user" | "none";
  /** Other commands bound to the same chord in the same `when` context. */
  conflicts: CommandId[];
  registered: boolean;
}
export function keybindingRows(
  catalogue: readonly CommandCatalogEntry[],
  defaults: readonly KeybindingRule[],
  rules: readonly KeybindingRule[],
  query: string,
): KeybindingRow[];
```

Spec §6.5: "A searchable table: Command, Keybinding, When, Source (Default/User)."

`keybindingRows` is pure and is where the whole table's behaviour is decided, so it tests without a DOM. The component renders it and nothing more.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ui/test/keybinding-rows.test.ts
import { describe, expect, test } from "bun:test";
import { COMMANDS, DEFAULT_KEYBINDINGS } from "@jslab/shared";
import { keybindingRows } from "../src/settings/keybinding-rows";

const catalogue = COMMANDS.map((command) => ({
  id: command.id,
  title: command.title,
  category: command.category,
  registered: true,
}));

const rows = (rules: Parameters<typeof keybindingRows>[2] = [], query = "") =>
  keybindingRows(catalogue, DEFAULT_KEYBINDINGS, rules, query);

describe("keybindingRows", () => {
  // The cross-plan guarantee, asserted on the UI side too: one row per catalogue entry, never a curated subset.
  test("renders one row per command in the catalogue (M5a's commands included, once they exist)", () => {
    expect(rows()).toHaveLength(COMMANDS.length);
    expect(new Set(rows().map((row) => row.command)).size).toBe(COMMANDS.length);
  });

  test("shows the default chord, its keycap and Default as the source", () => {
    const run = rows().find((row) => row.command === "run.start");
    expect(run).toMatchObject({ key: "cmd+r", keyLabel: "⌘R", when: null, source: "default" });
  });

  test("a user rule overrides the default and reports User", () => {
    const run = rows([{ key: "cmd+shift+enter", command: "run.start" }]).find((row) => row.command === "run.start");
    expect(run).toMatchObject({ key: "cmd+shift+enter", keyLabel: "⇧⌘↩", source: "user" });
  });

  test("a removal rule leaves the command unbound", () => {
    const clear = rows([{ key: "cmd+k", command: "-output.clear" }]).find((row) => row.command === "output.clear");
    expect(clear).toMatchObject({ key: null, keyLabel: null, source: "none" });
  });

  test("carries the when clause through", () => {
    expect(rows().find((row) => row.command === "edit.toggleLineComment")?.when).toBe("editorFocus");
  });

  test("reports conflicts in both directions, and only within the same when context", () => {
    const withConflict = rows([{ key: "cmd+r", command: "run.stop" }]);
    expect(withConflict.find((row) => row.command === "run.stop")?.conflicts).toEqual(["run.start"]);
    expect(withConflict.find((row) => row.command === "run.start")?.conflicts).toEqual(["run.stop"]);
    // ⌘/ is editorFocus-only, so a global binding on the same chord is not a conflict.
    const different = rows([{ key: "cmd+/", command: "run.stop" }]);
    expect(different.find((row) => row.command === "run.stop")?.conflicts).toEqual([]);
    expect(rows().every((row) => row.conflicts.length === 0)).toBe(true);
  });

  test("search matches the title, the command id and the keycap, case-insensitively", () => {
    expect(rows([], "reopen").map((row) => row.command)).toEqual(["tab.reopenClosed"]);
    expect(rows([], "run.kill").map((row) => row.command)).toEqual(["run.kill"]);
    expect(rows([], "⌘R").map((row) => row.command)).toContain("run.start");
    expect(rows([], "zzzz")).toEqual([]);
  });

  test("an unregistered command is still listed, and says so", () => {
    const partial = catalogue.map((entry) => ({ ...entry, registered: entry.id !== "run.kill" }));
    const built = keybindingRows(partial, DEFAULT_KEYBINDINGS, [], "");
    expect(built).toHaveLength(COMMANDS.length);
    expect(built.find((row) => row.command === "run.kill")?.registered).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/ui && bun test ./test/keybinding-rows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the row builder**

```ts
// apps/ui/src/settings/keybinding-rows.ts
import type { CommandCatalogEntry } from "@jslab/rpc-schema";
import {
  type CommandCategory,
  type CommandId,
  formatChord,
  type KeybindingRule,
  resolveKeybindings,
} from "@jslab/shared";

export interface KeybindingRow {
  command: CommandId;
  title: string;
  category: CommandCategory;
  key: string | null;
  keyLabel: string | null;
  when: string | null;
  source: "default" | "user" | "none";
  conflicts: CommandId[];
  registered: boolean;
}

/**
 * The rows Settings → Keybindings renders (spec §6.5: Command, Keybinding, When, Source).
 *
 * One row per catalogue entry — the catalogue is `COMMANDS`, so a command added by any other milestone appears
 * here automatically. `resolveKeybindings` does the precedence work, so the table can never disagree with what the
 * dispatcher actually does.
 */
export function keybindingRows(
  catalogue: readonly CommandCatalogEntry[],
  defaults: readonly KeybindingRule[],
  rules: readonly KeybindingRule[],
  query: string,
): KeybindingRow[] {
  const resolved = resolveKeybindings(defaults, rules);
  // The highest-precedence binding per command is the one the user sees, matching `shortcutFor`'s rule.
  const effective = new Map<string, (typeof resolved)[number]>();
  for (const binding of resolved) effective.set(binding.command, binding);

  // Conflicts are per chord *and* when-context: ⌘/ in the editor and a global ⌘/ are different bindings.
  const byChord = new Map<string, CommandId[]>();
  for (const binding of effective.values()) {
    const slot = `${binding.key} ${binding.when ?? ""}`;
    byChord.set(slot, [...(byChord.get(slot) ?? []), binding.command]);
  }

  const needle = query.trim().toLowerCase();
  const rowsOut: KeybindingRow[] = [];
  for (const entry of catalogue) {
    const binding = effective.get(entry.id);
    const keyLabel = binding ? formatChord(binding.chord) : null;
    const slot = binding ? `${binding.key} ${binding.when ?? ""}` : null;
    const row: KeybindingRow = {
      command: entry.id,
      title: entry.title,
      category: entry.category,
      key: binding?.key ?? null,
      keyLabel,
      when: binding?.when ?? null,
      source: binding ? binding.source : "none",
      conflicts: slot ? (byChord.get(slot) ?? []).filter((id) => id !== entry.id) : [],
      registered: entry.registered,
    };
    if (needle) {
      const haystack = [row.title, row.command, row.keyLabel ?? "", row.key ?? ""].join(" ").toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rowsOut.push(row);
  }
  return rowsOut;
}
```

Task 12 builds the rule it saves inline from a captured row (`{ key, command: row.command, ...(row.when ? { when: row.when } : {}) }`); there is deliberately no helper here for it, because the row already carries everything the rule needs.

- [ ] **Step 4: Add the tab and mount the pane**

In `apps/ui/src/settings/fields.ts`, add `"keybindings"` to `SettingsTab` and to the `SETTINGS_TABS` array **after `appearance`**, matching spec §8's order. `fieldsFor` returns `[]` for it, which is correct — the pane is not field-driven, exactly like the `.npmrc` editor's tab.

In `apps/ui/src/strings.ts`, add `settings.tabs.keybindings: "Keybindings"` and a `settings.keybindings` group with: `title`, `help`, `search`, `columns: { command, keybinding, when, source }`, `source: { default: "Default", user: "User", none: "Not bound" }`, `unregistered: "Not available in this window"`, `conflict: (titles: string) => \`Also bound to ${titles}\``, `openFile: "Open keybindings.json"`, `resetRow: "Reset to default"`, `resetAll: "Reset All Keybindings"`, `empty: "No commands match this search"`.

In `apps/ui/src/settings/SettingsApp.tsx`, beside the `npm` pane:

```tsx
        {!query && tab === "keybindings" && <KeybindingsPane api={api} onReady={(handle) => { keys.current = handle; }} />}
```

`KeybindingsPane` loads its data with `api.keybindings()` and `api.commandCatalog()` in one effect, renders a `<table>` with the four columns plus an actions cell, and a `<input type="search">` bound to a local query. Follow `NpmrcEditor.tsx`'s structure: an imperative handle published through `onReady` for the E2E agent, a `mounted` ref guarding post-unmount `setState`, and a status line.

- [ ] **Step 5: Write the pane test**

```tsx
// apps/ui/test/keybindings-pane.test.tsx
import { describe, expect, mock, test } from "bun:test";
import { COMMANDS, DEFAULT_KEYBINDINGS } from "@jslab/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KeybindingsPane } from "../src/settings/KeybindingsPane";

function api(rules: { key: string; command: string }[] = []) {
  return {
    keybindings: mock(async () => ({ rules, defaults: [...DEFAULT_KEYBINDINGS], path: "/data/keybindings.json" })),
    commandCatalog: mock(async () => ({
      commands: COMMANDS.map((c) => ({ id: c.id, title: c.title, category: c.category, registered: true })),
    })),
    saveKeybindings: mock(async () => ({ ok: true as const })),
    appCommand: mock(() => {}),
  };
}

describe("KeybindingsPane", () => {
  test("renders a row per command with its chord, when-clause and source", async () => {
    render(<KeybindingsPane api={api() as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(COMMANDS.length - 1));
    const run = screen.getByRole("row", { name: /^Run\b/ });
    expect(run.textContent).toContain("⌘R");
    expect(run.textContent).toContain("Default");
    expect(screen.getByRole("row", { name: /Toggle Line Comment/ }).textContent).toContain("editorFocus");
  });

  test("the search box filters the table", async () => {
    render(<KeybindingsPane api={api() as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "reopen" } });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2)); // header + one match
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText("No commands match this search")).toBeTruthy());
  });

  test("a user override reports User and warns about a conflict", async () => {
    render(<KeybindingsPane api={api([{ key: "cmd+r", command: "run.stop" }]) as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    expect(screen.getByRole("row", { name: /^Stop\b/ }).textContent).toContain("User");
    expect(screen.getAllByText(/Also bound to/).length).toBeGreaterThan(0);
  });

  test("Open keybindings.json asks Main to open the file (spec §6.5)", async () => {
    const fake = api();
    render(<KeybindingsPane api={fake as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Open keybindings.json" }));
    expect(fake.appCommand).toHaveBeenCalledWith("openKeybindingsFile");
  });
});
```

- [ ] **Step 6: Run everything and watch it pass**

Run: `cd apps/ui && bun test ./test/keybinding-rows.test.ts ./test/keybindings-pane.test.tsx ./test/settings-app.test.tsx`
Expected: PASS. **Delta: ui +11.**

- [ ] **Step 7: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
git add -A
git commit -m "feat(settings): add the Keybindings tab with a searchable command table

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 12: Key capture, conflicts and the reset paths

**Files:**
- Create: `apps/ui/src/settings/key-capture.ts`
- Modify: `apps/ui/src/settings/KeybindingsPane.tsx`, `apps/ui/src/settings/settings-agent.ts`, `apps/ui/src/strings.ts`
- Test: `apps/ui/test/key-capture.test.ts` (new), `apps/ui/test/keybindings-pane.test.tsx` (extend)

**Interfaces:**
- Consumes: `chordFromEvent`, `chordToSpec`, `formatChord`, `KeyChord`, `KeyLike` (`packages/shared/src/keybindings.ts`); `KeybindingRow`, `keybindingRows` (Task 11).
- Produces:

```ts
// apps/ui/src/settings/key-capture.ts
export type CaptureOutcome =
  | { kind: "ignored" }
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: "bareKey" | "reserved" }
  | { kind: "captured"; key: string; label: string };
export function captureKey(event: KeyLike): CaptureOutcome;
export function isBindable(chord: KeyChord): boolean;
```

**Judgment call: a capture field that swallows every keystroke must not be able to trap the user.** Four rules, each a test:

1. **Escape always cancels and can never be bound.** It is the universal out, so it is handled before anything else and is never returned as a capture. A user who arms capture by accident always has a way back.
2. **Bare `Tab` is ignored, not captured.** Keyboard navigation must keep working while the field is armed, or a keyboard-only user cannot leave the cell. `Tab` with a modifier is bindable.
3. **A bare printable key is refused with a visible reason,** not silently swallowed. Binding `k` alone would make typing `k` in the editor run a command. Function keys are the deliberate exception — the spec's own defaults bind `F1` and `F5`, and M5a binds `F9`.
4. **The reset paths are always available and never depend on a keybinding.** Per-row "Reset to default", a global "Reset All Keybindings", and "Open keybindings.json" (all spec §6.5), plus the file itself is plain JSON the user can delete.

**Why the app cannot be made unreachable by rebinding.** Settings is reachable from the native application menu (JSLab → Settings…), and `dispatchMenuAction` (`apps/desktop/src/main/menu.ts:301`) special-cases `app.settings` so Main opens the window **even when the main window is closed** — it never goes through the keybinding resolver. A user who binds something ruinous can therefore always reopen Settings → Keybindings from the menu bar and reset. This is why the reserved set stays minimal rather than trying to enumerate "dangerous" chords: the structural escape hatch already exists, and an over-eager blocklist would only stop legitimate rebinding (the spec's own defaults include `⌘,` and `⌘W`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/ui/test/key-capture.test.ts
import { describe, expect, test } from "bun:test";
import { captureKey, isBindable } from "../src/settings/key-capture";

const key = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe("captureKey", () => {
  test("captures a modifier chord and reports its spec and keycap", () => {
    expect(captureKey(key("KeyR", { metaKey: true, shiftKey: true })))
      .toEqual({ kind: "captured", key: "cmd+shift+r", label: "⇧⌘R" });
    expect(captureKey(key("Digit1", { ctrlKey: true, altKey: true })))
      .toEqual({ kind: "captured", key: "ctrl+alt+1", label: "⌃⌥1" });
  });

  // The escape hatch: a field that swallows every keystroke must always be leaveable.
  test("Escape cancels and is never captured, with or without modifiers", () => {
    expect(captureKey(key("Escape"))).toEqual({ kind: "cancelled" });
    expect(captureKey(key("Escape", { metaKey: true }))).toEqual({ kind: "cancelled" });
    expect(captureKey(key("Escape", { shiftKey: true, altKey: true }))).toEqual({ kind: "cancelled" });
  });

  test("bare Tab is ignored so keyboard navigation still works, but a Tab chord is bindable", () => {
    expect(captureKey(key("Tab"))).toEqual({ kind: "ignored" });
    expect(captureKey(key("Tab", { shiftKey: true }))).toEqual({ kind: "ignored" });
    expect(captureKey(key("Tab", { ctrlKey: true }))).toEqual({ kind: "captured", key: "ctrl+tab", label: "⌃⇥" });
  });

  test("a lone modifier press is ignored rather than captured", () => {
    for (const code of ["MetaLeft", "ShiftRight", "ControlLeft", "AltLeft"]) {
      expect(captureKey(key(code, { metaKey: true }))).toEqual({ kind: "ignored" });
    }
  });

  test("a bare printable key is refused with a reason, never silently swallowed", () => {
    expect(captureKey(key("KeyK"))).toEqual({ kind: "rejected", reason: "bareKey" });
    expect(captureKey(key("Digit4"))).toEqual({ kind: "rejected", reason: "bareKey" });
    expect(captureKey(key("Space"))).toEqual({ kind: "rejected", reason: "bareKey" });
    // Shift alone doesn't make a printable key safe: ⇧K is still typing.
    expect(captureKey(key("KeyK", { shiftKey: true }))).toEqual({ kind: "rejected", reason: "bareKey" });
  });

  test("function keys are bindable bare, because the default keymap already binds F1 and F5", () => {
    expect(captureKey(key("F9"))).toEqual({ kind: "captured", key: "f9", label: "F9" });
    expect(captureKey(key("F5"))).toEqual({ kind: "captured", key: "f5", label: "F5" });
    expect(captureKey(key("F5", { metaKey: true }))).toEqual({ kind: "captured", key: "cmd+f5", label: "⌘F5" });
  });

  test("an unknown key produces nothing at all", () => {
    expect(captureKey(key("Fn"))).toEqual({ kind: "ignored" });
  });
});

describe("isBindable", () => {
  test("agrees with captureKey about what may be bound", () => {
    expect(isBindable({ key: "r", meta: true, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isBindable({ key: "f9", meta: false, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isBindable({ key: "k", meta: false, ctrl: false, alt: false, shift: false })).toBe(false);
    expect(isBindable({ key: "escape", meta: false, ctrl: false, alt: false, shift: false })).toBe(false);
    expect(isBindable({ key: "escape", meta: true, ctrl: false, alt: false, shift: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/ui && bun test ./test/key-capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the capture state machine**

```ts
// apps/ui/src/settings/key-capture.ts
import { chordFromEvent, chordToSpec, formatChord, type KeyChord, type KeyLike } from "@jslab/shared";

export type CaptureOutcome =
  | { kind: "ignored" }
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: "bareKey" | "reserved" }
  | { kind: "captured"; key: string; label: string };

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;

/** Escape is the way out of an armed capture field, so it is never bindable from the capture editor. */
const RESERVED_KEYS = new Set(["escape"]);

function hasModifier(chord: KeyChord): boolean {
  return chord.meta || chord.ctrl || chord.alt;
}

/**
 * Whether a chord may be bound from the capture editor.
 *
 * A bare printable key is refused: binding `k` alone would fire a command every time the user typed `k`. Function
 * keys are the exception, because the shipped default keymap already binds `F1` and `F5` bare (spec §6.5).
 */
export function isBindable(chord: KeyChord): boolean {
  if (RESERVED_KEYS.has(chord.key)) return false;
  if (FUNCTION_KEY.test(chord.key)) return true;
  return hasModifier(chord);
}

/**
 * One keydown inside an armed capture field.
 *
 * Ordering matters and is the escape hatch: Escape is answered before anything else, and bare Tab is passed through
 * so a keyboard-only user can always leave the field. Nothing here silently swallows a key — every outcome either
 * captures, cancels, explains, or deliberately lets the browser handle it.
 */
export function captureKey(event: KeyLike): CaptureOutcome {
  const chord = chordFromEvent(event);
  // A lone modifier press, or a key with no mapping, is not an event worth reacting to.
  if (!chord) return { kind: "ignored" };
  if (chord.key === "escape") return { kind: "cancelled" };
  // Keyboard navigation must survive an armed field; ⇧⇥ is still navigation.
  if (chord.key === "tab" && !hasModifier(chord)) return { kind: "ignored" };
  if (!isBindable(chord)) {
    return { kind: "rejected", reason: RESERVED_KEYS.has(chord.key) ? "reserved" : "bareKey" };
  }
  return { kind: "captured", key: chordToSpec(chord), label: formatChord(chord) };
}
```

- [ ] **Step 4: Wire capture and the reset paths into the pane**

In `KeybindingsPane.tsx`, each row's keybinding cell gets a button that arms capture for that row. While armed:

- the cell renders an `<input readOnly>` with `aria-label={strings.settings.keybindings.capturing(row.title)}`, focused on arm;
- its `onKeyDown` calls `event.preventDefault()` then `captureKey(event.nativeEvent)` and acts on the outcome — `captured` writes the rule and saves, `cancelled` disarms, `rejected` disarms nothing and shows `strings.settings.keybindings.rejected[reason]`, `ignored` does nothing (and does **not** `preventDefault`, so Tab still moves focus);
- `onBlur` disarms, so clicking elsewhere is also a way out.

Saving writes the **whole** rule set through `api.saveKeybindings(rules)`: the existing user rules with this command's entry replaced by `{ key, command, ...(row.when ? { when: row.when } : {}) }`. "Reset to default" for a row removes that command's user rules and saves. "Reset All Keybindings" saves `[]` behind a confirm-then-commit button, following `NpmrcEditor`'s two-click Reset idiom (`apps/ui/src/settings/NpmrcEditor.tsx:219-233`) including its disarm-on-outside-interaction effect.

Add the E2E command ids to `apps/ui/src/settings/settings-agent.ts`'s `execute` switch — `keybindings.capture` (`{ command, key }`), `keybindings.resetRow` (`{ command }`), `keybindings.resetAll` — and add `keybindings: { rows: number; query: string; capturing: string | null }` to `SettingsSnapshot` so scenarios can assert against the table.

- [ ] **Step 5: Extend the pane test**

```tsx
  test("capturing a chord saves it, and Escape leaves the field without binding anything", async () => {
    const fake = api();
    render(<KeybindingsPane api={fake as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Change the shortcut for Run" }));
    const field = screen.getByLabelText("Recording a shortcut for Run");
    fireEvent.keyDown(field, { code: "KeyJ", metaKey: true });
    await waitFor(() =>
      expect(fake.saveKeybindings).toHaveBeenCalledWith([{ key: "cmd+j", command: "run.start" }]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change the shortcut for Stop" }));
    fireEvent.keyDown(screen.getByLabelText("Recording a shortcut for Stop"), { code: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Recording a shortcut for Stop")).toBeNull());
    expect(fake.saveKeybindings).toHaveBeenCalledTimes(1);
  });

  test("a bare key is refused with a visible reason and nothing is saved", async () => {
    const fake = api();
    render(<KeybindingsPane api={fake as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Change the shortcut for Run" }));
    fireEvent.keyDown(screen.getByLabelText("Recording a shortcut for Run"), { code: "KeyK" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("modifier"));
    expect(fake.saveKeybindings).not.toHaveBeenCalled();
  });

  test("Reset to default drops the row's user rules; Reset All needs a second click", async () => {
    const fake = api([{ key: "cmd+j", command: "run.start" }, { key: "cmd+y", command: "run.stop" }]);
    render(<KeybindingsPane api={fake as never} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Reset Run to its default shortcut" }));
    await waitFor(() => expect(fake.saveKeybindings).toHaveBeenCalledWith([{ key: "cmd+y", command: "run.stop" }]));

    fireEvent.click(screen.getByRole("button", { name: "Reset All Keybindings" }));
    expect(fake.saveKeybindings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    await waitFor(() => expect(fake.saveKeybindings).toHaveBeenLastCalledWith([]));
  });
```

- [ ] **Step 6: Run everything and watch it pass**

Run: `cd apps/ui && bun test ./test`
Expected: PASS. **Delta: ui +11 (8 in `key-capture.test.ts`, 3 more in `keybindings-pane.test.tsx`).**

- [ ] **Step 7: Gates and commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add -A
git commit -m "feat(settings): capture keybindings, warn on conflicts and offer resets

Escape always leaves an armed capture field, bare Tab still navigates, and
a bare printable key is refused with a reason rather than swallowed.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

---

### Task 13: E2E scenarios, parity and docs

**Files:**
- Create: `packages/e2e/scenarios/theme-import.test.ts`, `packages/e2e/scenarios/keybindings-ui.test.ts`, `docs/qa/m5d-checklist.md`
- Modify: `docs/parity.md`, `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, `README.md`

**Interfaces:**
- Consumes: the whole milestone, driven through the harness in `packages/e2e/src` — `launchApp`, `createUserData`, `waitFor`, `app.command`, `app.key`, `app.state`, `app.settingsCommand`, `app.settingsState`, `app.relaunch`.
- Produces: no code. Parity evidence.

**`bun run e2e` does NOT build.** Build first, every time:

```bash
cd apps/desktop && hutch run build:dev && cd ../.. && bun run e2e
```

A stale bundle fails these scenarios in about a second with `Command is disabled: theme.import` and looks exactly like a regression in work that is actually fine.

**Scripting the file dialog.** Native dialogs can't be driven over the socket, so the harness writes the answer and Main consumes it once: `writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([path]))` before the command, per `readE2EOpenDialog` (`apps/desktop/src/main/platform/e2e-dialogs.ts:16`). `packages/e2e/scenarios/files.test.ts:23` is the existing precedent.

- [ ] **Step 1: Write the theme-import scenario**

```ts
// packages/e2e/scenarios/theme-import.test.ts
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const THEME = JSON.stringify({
  name: "Test Deep",
  type: "dark",
  colors: { "editor.background": "#101014", "editor.foreground": "#D4D4D4", focusBorder: "#7AA2F7" },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#6A9955", fontStyle: "italic" } },
    { scope: ["keyword", "storage"], settings: { foreground: "#C586C0" } },
  ],
});

test("importing a VS Code theme .json applies it, persists it and survives a relaunch (XT-01)", async () => {
  const userData = await createUserData();
  const themeFile = join(userData, "test-deep.json");
  await writeFile(themeFile, THEME);
  app = await launchApp({ userData });

  expect((await app.state()).ui.themeId).toBe("graphite");
  await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([themeFile]));
  await app.command("theme.import");

  await waitFor(async () => ((await app?.state())?.ui.themeId === "test-deep" ? true : null), {
    message: "the imported theme never became active",
  });
  await app.screenshot("theme-imported");

  // Spec §4.5: saved under <appdata>/themes/ as *.jslab-theme.json.
  const saved = join(userData, "themes", "test-deep.jslab-theme.json");
  expect(existsSync(saved)).toBe(true);
  const written = JSON.parse(await readFile(saved, "utf8"));
  expect(written).toMatchObject({ id: "test-deep", name: "Test Deep", type: "dark" });
  expect(written.tokens["bg.canvas"]).toMatch(/^#[0-9A-F]{6}$/);
  expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).appearance.theme).toBe("test-deep");

  // It is a real theme afterwards: still selectable after a relaunch, and the built-ins still work (ST-03).
  const relaunched = await app.relaunch();
  app = relaunched;
  expect((await relaunched.state()).ui.themeId).toBe("test-deep");
  await relaunched.command("theme.select", { themeId: "dracula" });
  await waitFor(async () => ((await relaunched.state()).ui.themeId === "dracula" ? true : null));
  await relaunched.command("theme.select", { themeId: "test-deep" });
  await waitFor(async () => ((await relaunched.state()).ui.themeId === "test-deep" ? true : null));
});

test("importing a .vsix reads contributes.themes out of a real archive (XT-01)", async () => {
  const userData = await createUserData();
  const staging = join(userData, "vsix-src");
  await mkdir(join(staging, "extension", "themes"), { recursive: true });
  await writeFile(
    join(staging, "extension", "package.json"),
    JSON.stringify({ name: "pack", contributes: { themes: [{ label: "Packed", uiTheme: "vs-dark", path: "./themes/packed.json" }] } }),
  );
  await writeFile(join(staging, "extension", "themes", "packed.json"), THEME.replace("Test Deep", "Packed"));
  const vsix = join(userData, "pack.vsix");
  // A real zip from the system tool, so the hand-written reader is checked against a genuine producer.
  const zipped = Bun.spawnSync(["zip", "-qr", vsix, "extension"], { cwd: staging });
  expect(zipped.exitCode).toBe(0);

  app = await launchApp({ userData });
  await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([vsix]));
  await app.command("theme.import");
  await waitFor(async () => ((await app?.state())?.ui.themeId === "packed" ? true : null), {
    message: "the .vsix theme never became active",
  });
  expect(existsSync(join(userData, "themes", "packed.jslab-theme.json"))).toBe(true);
});

test("an invalid theme file reports a readable error and changes nothing (spec §9.3)", async () => {
  const userData = await createUserData();
  const bad = join(userData, "broken.json");
  await writeFile(bad, "{ this is not json");
  app = await launchApp({ userData });
  await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([bad]));
  await app.command("theme.import");
  const state = await waitFor(async () => {
    const current = await app?.state();
    return current?.ui.statusMessage ? current : null;
  }, { message: "no error was reported" });
  expect(String(state.ui.statusMessage)).not.toMatch(/[/\\]/);
  expect(state.ui.themeId).toBe("graphite");
  expect(existsSync(join(userData, "themes"))).toBe(false);
});
```

- [ ] **Step 2: Write the keybindings-UI scenario**

```ts
// packages/e2e/scenarios/keybindings-ui.test.ts
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

async function openKeybindings() {
  await current().key("cmd+,");
  await waitFor(async () => ((await current().settingsState())?.ready ? true : null), { timeoutMs: 45_000 });
  await current().settingsCommand("settings.tab", { tab: "keybindings" });
  return waitFor(async () => {
    const state = await current().settingsState();
    const rows = (state?.keybindings as { rows?: number } | undefined)?.rows ?? 0;
    return rows > 0 ? state : null;
  }, { message: "the keybindings table never rendered" });
}

test("the Keybindings tab lists commands and rebinding applies live, then resets (XT-02, ST-01)", async () => {
  app = await launchApp();
  const table = await openKeybindings();
  // The table is the whole catalogue, not a curated subset — so commands added by other milestones appear here.
  expect((table.keybindings as { rows: number }).rows).toBeGreaterThan(60);

  await current().type("1 + 1");
  await current().waitForOutput((entries) => entries.length === 1);

  // Rebind Clear Output from ⌘K to ⇧⌘K through the capture editor.
  await current().settingsCommand("keybindings.capture", { command: "output.clear", key: "cmd+shift+k" });
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(join(current().userData, "keybindings.json"), "utf8"));
    return Array.isArray(saved) && saved.some((rule) => rule.key === "cmd+shift+k" && rule.command === "output.clear")
      ? saved
      : null;
  }, { message: "keybindings.json never recorded the new chord" });

  // Finding K1's end-to-end proof: the new chord works in the running app, with no relaunch.
  await current().key("cmd+shift+k");
  await waitFor(async () => (activeTab(await current().state()).entryCount === 0 ? true : null), {
    message: "the newly bound chord did not take effect without a relaunch",
  });

  // Reset All puts the defaults back, in the file and in the running app.
  await current().type("2 + 2");
  await current().waitForOutput((entries) => entries.length === 1);
  await current().settingsCommand("keybindings.resetAll");
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(join(current().userData, "keybindings.json"), "utf8"));
    return Array.isArray(saved) && saved.length === 0 ? saved : null;
  }, { message: "Reset All never cleared keybindings.json" });
  await current().key("cmd+k");
  await waitFor(async () => (activeTab(await current().state()).entryCount === 0 ? true : null), {
    message: "the default chord did not come back after a reset",
  });
});

test("a per-row reset restores just that command's default (spec §6.5)", async () => {
  app = await launchApp();
  await openKeybindings();
  await current().settingsCommand("keybindings.capture", { command: "run.start", key: "cmd+shift+enter" });
  await current().settingsCommand("keybindings.capture", { command: "output.clear", key: "cmd+shift+k" });
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(join(current().userData, "keybindings.json"), "utf8"));
    return saved.length === 2 ? saved : null;
  });
  await current().settingsCommand("keybindings.resetRow", { command: "run.start" });
  const remaining = await waitFor(async () => {
    const saved = JSON.parse(await readFile(join(current().userData, "keybindings.json"), "utf8"));
    return saved.length === 1 ? saved : null;
  }, { message: "the per-row reset never landed" });
  expect(remaining).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
});
```

- [ ] **Step 3: Build and run both suites**

```bash
cd apps/desktop && hutch run build:dev
cd "$(git rev-parse --show-toplevel)" && bun run e2e
```
Expected: the full scenario suite passes. **Delta: e2e +5 scenarios** (3 theme, 2 keybindings). Report the real before/after numbers.

- [ ] **Step 4: Update `docs/parity.md`**

Exactly three rows change, and **only** to what is actually verified:

- **XT-01** → `✅ packages/themes/test/vscode-convert.test.ts, apps/desktop/test/themes/zip.test.ts, packages/e2e/scenarios/theme-import.test.ts`
- **XT-02** → `✅ apps/ui/test/keybinding-rows.test.ts, apps/ui/test/key-capture.test.ts, packages/e2e/scenarios/keybindings-ui.test.ts` (the M2 half keeps its existing `packages/e2e/scenarios/keybindings.test.ts` evidence)
- **ST-01** stays `🚧`, with its note narrowed to: "General/Editor/Formatting/Appearance/Advanced in M2, NPM/Build in M3, Keybindings in M5; AI M5". **Do not flip ST-01 to ✅** — the AI tab is not M5d's and does not exist yet.

Leave every other row alone. ST-03 is already ✅ and the theme-import scenario's `theme.select` round trip shows it has not regressed.

- [ ] **Step 5: Write `docs/qa/m5d-checklist.md`**

Follow `docs/qa/m3-checklist.md`'s structure: the same canary launch block and scoped teardown, then items that need a person, each marked **(E)** where an automated scenario also covers it. Items to include, and nothing that automation already proves on its own:

1. Import a real VS Code theme `.json` downloaded by hand; confirm the editor, output, side bar and status bar all re-colour and stay readable **(E for the mechanism, manual for "looks right")**.
2. Import a `.vsix` that contains **several** themes; confirm the picker lists them and the chosen one applies. **The multi-theme picker is the one importer path with no automated coverage** — the e2e `.vsix` scenario uses a single-theme package.
3. Import a light theme while Follow System Appearance is on; confirm the light/dark pair still switches with macOS.
4. Confirm an imported theme appears in the **Themes menu** and in the command palette, and that its menu item actually applies it (Finding T3's slug rule).
5. In Settings → Keybindings, record a chord with the mouse, then with the keyboard; confirm Escape leaves the field, ⇥ still moves focus, and a bare letter is refused with a visible message.
6. Bind a chord that already exists; confirm the conflict warning names the other command.
7. Use **Open keybindings.json**; confirm it opens in the user's editor and that hand-editing it takes effect **without** relaunching.
8. With a deliberately awkward binding saved, confirm JSLab → Settings… from the **menu bar** still opens Settings (the structural escape hatch), then Reset All.

- [ ] **Step 6: Update the roadmap and README**

Add the M5d row to the roadmap's status table naming this plan, and mention the VS Code theme importer and the Keybindings editor in the README's feature list.

- [ ] **Step 7: Full gates and the final commit**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
cd apps/desktop && hutch run build:dev && cd "$(git rev-parse --show-toplevel)" && bun run e2e
git add -A
git commit -m "docs: record M5d theming and keybinding parity

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY"
```

Report real numbers for every suite. **A test added to make a total match this plan is a defect, not a fix.**

---

## Self-review

Run against the spec with fresh eyes after writing. Issues found were fixed inline; they are listed here so the executor knows what changed and why.

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| §9.3 "`tokenColors` TextMate scopes are mapped to Monaco token rules using a scope-to-token table" | 1 |
| §9.3 "UI variables are derived from `editor.background`, `sideBar.background`, `activityBar.background`, `statusBar.background`, `focusBorder`, `errorForeground`, and so on, **with contrast fallbacks**" | 2 (derivation + the sparse-theme AA tests) |
| §9.3 "`colors` are passed to Monaco `colors`" | 3 (`passthrough` merge) |
| §9.3 accepts "a theme `.json` file (with `tokenColors` and `colors`)" | 3, 8 |
| §9.3 accepts "a `.vsix` file: JSLab extracts `extension/package.json` `contributes.themes` and lets the user pick a theme" | 5, 6, 8 |
| §9.3 "The result is saved to `<appdata>/themes/`" | 7 |
| §9.3 "and shows up in the Themes menu immediately" | 4 (the registry), 8 (`menu.refresh()` + `theme.changed`) |
| §9.3 "Invalid files produce a readable error" | 3, 6, 8, and the e2e scenario in 13 |
| §9.1 the 34-token set, and AA on every surface | 2, 3 (via `buildTheme`'s `ensureContrast`) |
| §4.5 `themes/` holding `*.jslab-theme.json` | 7 |
| §22.1 "the VS Code converter against 10 real theme fixtures" | 3 |
| §6.5 "A searchable table: Command, Keybinding, When, Source (Default/User)" | 11 |
| §6.5 "A key-capture editor that warns on conflicts" | 11 (conflicts), 12 (capture) |
| §6.5 "\"Reset to default\" per row" | 12 |
| §6.5 "\"Open keybindings.json\"" | 10 (the app action), 11 (the button) |
| §8 the Keybindings tab | 11 |
| §18 zod validation at every new RPC entry point | 8, 10 |
| §22.3 E2E scenarios | 13 |
| §22.4 the parity gate | 13 |
| Parity XT-01, XT-02, ST-01 (Keybindings tab only) | 13 |

**One gap, deliberate and recorded rather than closed:** spec §9.3's `.vsix` flow says JSLab "lets the user pick a theme". Task 8 builds the `themePick` modal and Task 13's manual checklist item 2 covers it, but **no automated test drives the multi-theme picker end to end** — the e2e `.vsix` scenario uses a single-theme package, which takes the one-theme shortcut in `importFrom`. The picker's *data* path (`listVsixThemes` returning several entries, `theme.importPick` validating the token) is unit-tested in Tasks 6 and 8. Flagged in the checklist as the one importer path a person must confirm.

**A second deliberate limitation:** `convertVsCodeTheme` does not follow a theme's `include` field. A theme that inherits most of its colours from a sibling file converts using only what it defines itself, plus the fallbacks. Recorded in the function's doc comment. Following `include` would require a path resolver inside a package that must stay pure, and the contrast fallbacks make the result legible regardless.

### 2. Placeholder scan

Searched for the forbidden patterns. Every code step contains real code; no "TBD", no "add appropriate error handling", no "similar to Task N" (Task 6's test deliberately repeats the archive builder rather than sharing it, and says why). Three hedges found and fixed:

- Task 8 Step 7 said "the existing `commands.test.ts` count assertions, if any". Verified: `packages/shared/test/commands.test.ts` asserts uniqueness, titles and categories, and has **no** length assertion. Rewritten as a definite statement.
- Task 11 defined a `ruleFor` helper whose body was `key: chord.key ? key : key` — a no-op conditional that returns the same value either way, importing `parseChord` solely to compute a value it discarded. **Removed**; Task 12 constructs the rule inline, which is what it already did.
- Finding K3 originally instructed Task 9 to call `KeybindingResolver.setBindings`. Verified that `App.tsx:271` already rebuilds the resolver via `useMemo(..., [bindings])`, so once `bindings` is reactive nothing else is needed. Rewritten to say so and to leave `setBindings` unused, rather than adding a second mechanism for one behaviour.

### 3. Type consistency

Names checked across task boundaries; producers and consumers agree.

- `ThemeDefinition` / `MonacoThemeData` / `Palette` / `ThemeInput` — defined in `packages/themes/src/build.ts` (existing), consumed unchanged by Tasks 2, 3, 4, 7.
- `VsCodeTokenColor` and `MonacoRule` — Task 1 produces; Task 3 imports both from `./scopes`.
- `monacoRulesFrom` → `syntaxColorsFrom` → `paletteFromColors(colors, type, syntax)`: the `syntax` parameter's key set (`comment | keyword | string | number | type | fn`) is the same union in Tasks 1 and 2, and matches `Palette`'s field names exactly, so Task 2's spread lands on real fields.
- `convertVsCodeTheme(input, { fallbackName })` → `ConvertResult` — Task 3 produces; Tasks 7 (test helper) and 8 (`commit`) consume the same shape, always checking `ok` before `.theme`.
- `registerUserThemes(themes)` — Task 4 produces; called in Main (Task 8's `onChanged` and startup) and in the UI (`hydrate`, `theme.changed`). `listThemes`/`getTheme`/`resolveThemeId` keep their existing signatures, which is what lets the four untouched call sites work.
- `openZip(bytes, limits?) → ZipArchive` with `names`/`has`/`read`, plus `ZipError` and `isSafeEntryName` — Task 5 produces; Task 6 consumes all four.
- `listVsixThemes` / `readVsixTheme` — Task 6 produces; Task 8 consumes. `VsixThemeEntry.path` is an **archive entry name**, not a filesystem path, in both.
- `ThemeStore.save(theme)` / `.themes` / `.onChange` — Task 7 produces; Task 8's handler deps use exactly `Pick<ThemeStore, "save" | "themes">`.
- `KeybindingsStore.save(rules)` / `.rules` (now a getter) / `.onChange` / `.path` — Task 9 produces; Task 10's deps use `Pick<KeybindingsStore, "path" | "rules" | "save">`. Task 9 also widens `RpcHandlerDeps.keybindings` to `readonly KeybindingRule[]`, which is the one breaking change the getter forces.
- `CommandCatalogEntry { id, title, category, registered }` — Task 10 produces; Task 11's `keybindingRows` takes `readonly CommandCatalogEntry[]` as its first parameter and the pane test builds the same shape from `COMMANDS`.
- `KeybindingRow` — Task 11 produces; Task 12 reads `row.command`, `row.when` and `row.title`, all present.
- `captureKey(event) → CaptureOutcome` and `isBindable(chord)` — Task 12 produces; the outcome union's four `kind` values are each handled in the pane wiring.
- `setKeybindings(rules)` (store, Task 9), `publishCommands(ids)` (Task 10), `importTheme()` / `importThemePick(token, path)` (Task 8), and the Settings-side `keybindings()` / `saveKeybindings(rules)` / `commandCatalog()` (Tasks 10–11) — each added to `MainApi` or `SettingsApi` **and** to `apps/ui/test/fake-api.ts`, which is declared `satisfies MainApi` and therefore fails typecheck until it is updated. Tasks 8, 10 and 11 each say so.
- Chord vocabulary is `packages/shared`'s throughout: a `key` is always a chord **spec** (`"cmd+shift+k"`), a `keyLabel` is always **keycap text** (`"⇧⌘K"`). No task invents a third representation.

### 4. Ordering constraints worth restating

- **Task 4 before Task 8**, or `resolveThemeId` silently rewrites an imported id to Graphite (Finding T2) and the import looks broken.
- **Task 9 before Tasks 11 and 12**, or the pane saves bindings that cannot take effect until a relaunch (Finding K1), and the defect hides behind a UI that appears to work.
- **Task 5 before Task 6**, and **Task 1–3 before Task 7's test helper**, which calls `convertVsCodeTheme`.

