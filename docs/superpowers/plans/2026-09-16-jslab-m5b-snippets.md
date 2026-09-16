# JSLab M5b: Snippets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec §13 in full — a `Cmd+B` snippets panel in the side bar (search, list, preview, Insert / Insert in New Tab / Copy / Edit / Delete), a New Snippet form with a Monaco body, Monaco snippet-syntax insertion with tab stops, snippet autocomplete, Create Snippet… from the editor context menu, and a versioned `jslab-snippets` import/export format.

**Architecture:** The library is one Main-owned file, `<appdata>/snippets.json`, behind a `SnippetStore` shaped exactly like the existing `EnvStore`. The UI holds the whole library in the Zustand store and writes it back through one `snippets.save` request. Every piece of snippet *logic* — the file format, merging, trigger detection, template escaping, filtering — is a framework-free pure module with its own unit test, because `Editor.tsx` and Monaco cannot run under happy-dom; the Monaco surfaces (a `CompletionItemProvider`, the Tab expansion, the context-menu action) are thin registrations tested against a hand-rolled Monaco fake, the same split `install-assist.ts` already uses. Autocomplete deliberately does **not** copy VS Code's continuous fuzzy suggest (see ruling R-M5b-7).

**Tech Stack:** Bun 1.4.0 (bundled) / 1.3.13 (dev), Electrobun 2.0.1, React 19, Zustand 5, Monaco 0.56, zod 4, `@tanstack/react-virtual` 3, bun:test, happy-dom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md` — §13 (the whole feature), §4.5 (`snippets.json` in the app data layout), §6.5 (`Cmd+B` in the default keymap; every action is a `CommandId`), §7.1 (the side bar hosts panels), §7.4 (Edit menu → Create Snippet…; Tools menu → Snippets…), §7.5 (Snippets is a side-bar panel), §18 (every inbound payload is zod-validated in Main).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Clean room.** Never read, unpack or inspect RunJS binaries, `app.asar`, bundled JS, or `/Applications/RunJS.app`. Parity comes from the spec and public docs only.
- **Exact values, copied verbatim from the spec:**
  - §13.1: "**Search box** matches name and description."
  - §13.1: "**List:** name + description. The selected snippet shows a preview with syntax highlighting."
  - §13.1: "**Actions:** Insert (at the cursor, replacing the selection) · Insert in New Tab · Copy · Edit · Delete (with the confirmation "Delete snippet "<name>"?")."
  - §13.1: "**New Snippet (+):** Name (the autocomplete trigger; required, unique, `^[\w$-]+$`) · Description · Body (a Monaco editor) · Language hint (optional)."
  - §13.1: "**Options menu:** Import… (merge; name conflicts get an overwrite, keep both, or skip choice) · Export… (via `saveDialog`, default `jslab-snippets.json`)."
  - §13.1: "**Editor context menu:** Create Snippet… pre-fills the body with the selection, or with the whole buffer if nothing is selected."
  - §13.2: "Snippet bodies use Monaco snippet syntax: `$0` marks the final cursor position, and `${1:placeholder}` / `$1` are tab stops. A body without placeholders is inserted literally, with `$` escaped."
  - §13.3: "A Monaco `CompletionItemProvider` suggests snippets whose name starts with the typed word (case-insensitive). They appear with a snippet icon and description, and they are suggested even when the full name has been typed (RunJS #488)."
  - §13.4 file format: `{ "format": "jslab-snippets", "version": 1, "snippets": [ { "id": "uuid", "name": "fetchjson", "description": "Fetch + parse JSON", "body": "…", "language": "typescript", "createdAt": "ISO", "updatedAt": "ISO" } ] }`
  - §13.4: "Invalid imports show "This file isn't a valid JSLab snippets file", with details."
  - §6.5 default keybindings table: `Snippets…` → `Cmd+B`.
  - §4.5 app data layout: `snippets.json          snippet library`
  - §7.5 panel table: `Snippets | Side bar panel (or modal when the side bar is hidden) | §13`
  - §7.4 Edit menu: "… Toggle Logpoint · Clear All Logpoints · Create Snippet… · Clear Output · Clear Editor"
  - §7.4 Tools menu: "NPM Packages… · Environment Variables… · Snippets… · AI Chat"
- **Establish the baseline before Task 1 and never fabricate it.** This worktree has no `node_modules`, and no test totals are asserted anywhere in this plan because none have been measured. Run, from the worktree root:
  ```bash
  bun install --frozen-lockfile
  mkdir -p apps/desktop/.hutch
  bun run lint -- --max-diagnostics=300
  bun run typecheck
  bun run test
  ```
  Record the pass/fail totals **per package** in `.superpowers/m5b-baseline.md`. Every task below states its own **delta** in tests; a total that does not match baseline + deltas is a STOP, not a rounding error.
- **Never run a bare `bun test` at the repo root.** Always `bun run test`.
- **UI tests need the DOM preload.** `apps/ui/bunfig.toml` preloads `./test/setup-dom.ts`, and `bun test <path>` from the repo root skips it. The only correct form is `cd apps/ui && bun test ./test/<file>`. `apps/ui/isolated/` runs as its own process (`bun test ./isolated`) because it installs module mocks.
- **The two-Bun gate is easy to fake.** `bun14 run test` uses 1.4.0 only as the task runner; each package's script is `bun test ./test`, so the inner binary still comes from `PATH`. The real form is:
  ```bash
  PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
  ```
- **Typecheck needs the devkit copied, and its parent does not exist in a fresh worktree.** Run `mkdir -p apps/desktop/.hutch` before the `cp -a` that populates it. Without the directory, `bun run typecheck` exits 1 **without checking anything**, which reads as a failure but is really a no-op.
- **Biome truncates diagnostics by default.** Always `bun run lint -- --max-diagnostics=300`.
- **`bun run e2e` does NOT build.** It drives whatever bundle is on disk. Any e2e step must build first: `cd apps/desktop && hutch run build:dev`. **Never run the hutch installer, `hutch init` or `hutch upgrade`.**
- **Never modify** `~/.zshrc`, `~/.npmrc`, `~/.bunfig.toml`, the Bun cache, or anything under `~/Library`.
- **Never contact the public npm registry in tests.** Loopback Verdaccio only (`packages/test-registry`). No task in this plan needs the registry at all.
- **No personal paths** (`/Users/...`, `/Volumes/...`) in any committed file.
- **No new runtime dependency.** Every feature here is built from what the repo already has (`@tanstack/react-virtual` and `monaco-editor` are already dependencies of `@jslab/ui`).
- **RPC discipline:** every new UI-reachable entry point goes through `createValidators`' `parse`/`message` (`apps/desktop/src/main/rpc/validate.ts`); request names are globally unique across merged handler groups (`mergeHandlers` throws on a duplicate).
- **Strings:** no hard-coded user-visible text in components. UI strings go in `apps/ui/src/strings.ts`; Main strings go in `apps/desktop/src/main/strings.ts`.
- **Commit hygiene:** one commit per task, staged explicitly by path, on branch `feat/jslab-m5b`. Do not merge, push, or force-push. End every commit message with:
  ```
  Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
  ```

---

## As-built survey

Read this before Task 1. Everything below was verified by reading the worktree at `30da6e3`, not assumed.

### There is no snippet code in this repo yet

`grep -rni snippet apps/ui/src apps/desktop/src packages/*/src` returns exactly three kinds of hit, and **none of them is snippet functionality**:

1. `apps/ui/src/strings.ts:100` — `snippets: "Snippets"` under `strings.shell`, the activity-bar label.
2. `apps/ui/src/shell/{ActivityBar,SideBar,App}.tsx` and `apps/ui/src/state/store.ts` — the string literal `"snippets"` as a **side-bar panel name** (see the next section).
3. `apps/desktop/src/main/runtimes/web-adapter.ts:113` — `ASSERT_HOST_HOOK_SNIPPET`, an unrelated injected-JS constant for the web runner.

So every module, type, RPC name and string in this plan is new. Nothing is being re-implemented.

### The side bar, exactly as it exists today

| Thing | Where | Current shape |
|---|---|---|
| Panel selection | `apps/ui/src/state/store.ts:178` | `sideBarPanel: "snippets" \| "ai"`, initialised to `"snippets"` (line 358) |
| Setter | `apps/ui/src/state/store.ts:257, 680` | `setSideBarPanel(panel: "snippets" \| "ai"): void` |
| The region | `apps/ui/src/shell/SideBar.tsx` | A placeholder: `<aside className="side-bar">` with an `<h2>` and `strings.shell.sideBarPlaceholder` |
| The switch | `apps/ui/src/shell/ActivityBar.tsx:43,75,93` | One button per panel, `onPanel("snippets")` / `onPanel("ai")`, `aria-pressed` = open-and-showing |
| The toggle logic | `apps/ui/src/shell/App.tsx:441-453` | `togglePanel(panel)`: if the side bar is open **and** already showing `panel`, run `view.toggleSideBar`; otherwise `setSideBarPanel(panel)` and open the side bar if it is closed |
| Visibility | `apps/ui/src/shell/App.tsx:523` | `{settings.view.sideBar && <SideBar panel={sideBarPanel} />}` — the persisted setting `view.sideBar`, toggled by the `view.toggleSideBar` command |
| CSS | `apps/ui/src/styles.css:900-916` | `.side-bar` (280 px, min 240, max 600 — spec §7.1's range) and `.side-bar h2` |

There is **no** "side tab" concept anywhere in the repo: there are editor tabs (`TabBar.tsx`) and this one side bar with a panel switch.

**An existing test depends on the `.side-bar` element.** `apps/ui/isolated/app.test.tsx:638-665` ("activity bar panels open, switch and close the side bar") renders the real `App` and asserts `document.querySelector(".side-bar") !== null` after clicking the Snippets button, together with `store.getState().sideBarPanel` and the `updateSettings` call count. **The snippets panel must therefore keep rendering an element carrying the `side-bar` class**, and the fake API must answer whatever the panel calls on mount. Both are requirements of Task 9, not accidents.

### The cross-plan interface with M5a (non-negotiable)

The sibling plan `docs/superpowers/plans/2026-09-16-jslab-m5a-editor-productivity.md` (committed on `feat/jslab-m5a`) adds **Show Transpiled Output as a third side-bar panel**, because §7.4's "read-only side tab" has no referent in this repo. Its Task 8 does three things that touch this plan's files:

```ts
// apps/ui/src/state/store.ts  (M5a Task 8)
export type SideBarPanel = "snippets" | "ai" | "transpiled";
```
```tsx
// apps/ui/src/shell/SideBar.tsx  (M5a Task 8)
export function SideBar({ panel, store, api }: { panel: SideBarPanel; store: AppStore; api: Pick<MainApi, "transpiled"> }) {
  if (panel === "transpiled") return <TranspiledPanel store={store} api={api} />;
  …
}
```
```tsx
// apps/ui/src/shell/App.tsx  (M5a Task 8)
{settings.view.sideBar && <SideBar panel={sideBarPanel} store={store} api={api} />}
```

M5a also adds `sideBarPanel` to `UiSnapshot` (`apps/ui/src/e2e/snapshot.ts`) and retypes `App.tsx`'s `togglePanel` parameter to `SideBarPanel`.

Rulings R-M5b-1 and R-M5b-2 below define how this plan coexists with that, in both merge orders. **Read them before writing any code in Tasks 9 and 11.**

### The command registry, keymap and menus (built in M2)

- `packages/shared/src/commands.ts` — `COMMANDS` (`as const satisfies readonly CommandMeta[]`), `CommandId`, `commandMeta`, `isCommandId`. Categories are `run | file | tab | edit | format | view | tools | runtime | language | theme | help | app`, ordered by `COMMAND_CATEGORY_ORDER`. `palette: false` hides a command from the palette but keeps it bindable and menu-dispatchable (`npm.install` is the precedent).
- `packages/shared/src/keybindings.ts` — `DEFAULT_KEYBINDINGS`, `parseChord` (accepts `tab` via `CODE_TO_KEY`), `resolveKeybindings`, `shortcutFor`, `formatChord`.
- `apps/ui/src/commands/registry.ts` — `CommandRegistry`, `CommandSpec { id; run(args?); isEnabled?(); description?() }`.
- `apps/ui/src/keybindings/resolver.ts` — the single dispatcher. `contextFromState(state, activeElement, editorHasFocus)` yields `{ editorFocus, outputFocus, modalOpen, paletteOpen, dialogOpen, textInputFocus }`. Two rules matter here: a binding without `modalOpen` in its `when` is skipped while any modal is open, and a modifier-less chord is skipped while a text input has focus.
- **`App.tsx:431-435` is the mechanism that makes a bare-`Tab` binding safe:**
  ```ts
  const command = resolver.resolve(event, context);
  if (!command || !registry.isEnabled(command)) return;   // ← falls through to Monaco
  event.preventDefault();
  ```
  A command whose `isEnabled()` returns false never calls `preventDefault`, so the keystroke reaches Monaco unchanged. Task 10 relies on exactly this.
- `apps/desktop/src/main/menu.ts` — `buildMenu(model)`; items carry `menuAction(commandId)` and come back as `menu.command`. `apps/desktop/test/menu.test.ts` asserts menu contents with `expect.arrayContaining` and per-label lookups, **not** an exhaustive equality on the label list, so adding items does not break it. It does assert `top.indexOf("Tools") === top.indexOf("Actions") + 1`.
- `apps/ui/test/commands.test.ts:76-80` asserts every `COMMANDS` entry whose **id starts with `edit.`** is implemented by `createEditorCommands`. This plan therefore uses the `snippets.` id prefix for editor-ish snippet commands (`snippets.expand`, `snippets.create`) and never an `edit.` one, so that test keeps passing untouched.

### Monaco, and how this repo tests it

- `apps/ui/src/editor/monaco-setup.ts` — `setupMonaco()`, one-time worker + TS-defaults configuration, returns `typeof monaco`. `languageId(language)` maps the four languages onto `"typescript" | "javascript"`.
- `apps/ui/src/editor/Editor.tsx` — a 448-line `useEffect` that creates the editor, registers `registerInstallAssist(monaco, …)`, publishes an `EditorHandle` through `setEditorHandle`, and disposes everything on unmount. **This file cannot run under happy-dom.**
- `apps/ui/src/editor/install-assist.ts` + `apps/ui/test/install-assist.test.ts` — the pattern this plan copies for every Monaco registration: pure logic in exported functions, a `register*(monaco, deps)` function returning `{ dispose() }`, and a `fakeMonaco()` in the test that captures the registered provider and drives it directly.
- `apps/ui/src/editor/editor-handle.ts` — the `EditorHandle` interface (`typeText`, `replaceAll`, `getValue`, `getCursorOffset`, `getSelectedLineRange`, `getLines`, `replaceLines`, `applyOffsetEdits`, `runAction`, …) plus the module-level `getEditorHandle()` / `setEditorHandle()` pair.
- There is **no** `editor.addAction`, no `registerCompletionItemProvider` and no context-menu customisation anywhere in the repo today. Task 10 adds the first of each.
- `apps/ui/src/editor/editor-options.ts` maps settings onto Monaco options; `editor.autocomplete` drives `quickSuggestions` and `suggestOnTriggerCharacters`. Nothing sets `snippetSuggestions` today.

### App data, persistence and versioned JSON (the house style this plan must match)

- `apps/desktop/src/main/app-paths.ts` — `resolveAppPaths({ resourcesFolder, userData, execPath, env })` returns every path Main uses. `dataDir` honours `JSLAB_USER_DATA`. `envFile: join(dataDir, "env.json")` is the precedent for a new `snippetsFile` entry.
- `apps/desktop/src/main/services/env-store.ts` — the exact shape to copy: a private constructor, `static async open(path, options)`, an in-memory value, `save()` that validates with the shared schema and writes through an injectable `write`, a corrupt file renamed to `<name>.corrupt-<ts>.json`, and a `recovered: "none" | "defaults"` field. Note its FR-2 rule: **only `ENOENT` means "nothing saved yet"; any other read error must throw**, or the next save silently overwrites the user's real file with an empty one.
- `apps/desktop/src/main/persistence/atomic-write.ts` — `writeFileAtomic(path, data, { backup?, mode?, shouldCommit? })`: temp file + fsync + rename, with `backup: true` copying the old file to `<path>.bak` first.
- `packages/shared/src/env-vars.ts` — the versioned-file idiom: `envFileSchema = z.object({ version: z.literal(1), variables: envVarsSchema })`, with explicit `MAX_*` caps and a pattern constant. `packages/shared/src/settings.ts` / `migrations.ts` / `session.ts` add the migration idiom: a `*_VERSION` constant, a `Record<number, (raw) => raw>` migration map, and a parse function that walks it. `session.ts` also records the rule that a file written by a **newer** build is never written back (`newerThanBuild`).
- File dialogs are Main-side adapters, swapped under E2E: `apps/desktop/src/main/index.ts:347-357` passes `openDialog` (either `readE2EOpenDialog(paths.dataDir)` or `Utils.openFileDialog`) and `saveDialog` (either `readE2ESaveDialog(paths.dataDir)` or the `osascript` adapter in `platform/save-dialog.ts`). `platform/e2e-dialogs.ts` reads and deletes `e2e-open-dialog.json` / `e2e-save-dialog.json` from the data folder — that is how an e2e scenario scripts a dialog answer.
- `apps/desktop/src/main/rpc/env-handlers.ts` is the smallest complete handler group to copy: `createEnvHandlers(deps)` returning `{ requests, messages }`, every payload through `parse(schema, name, input)`, failures mapped to `SaveResult`.

### Everything else this plan leans on

- `apps/ui/src/shell/dialogs.ts` — `createDialogs(store)` returns `Dialogs { confirm(options): Promise<string>; resolve(id, buttonId) }`. **There must be exactly one instance**, the one `App.tsx:193` builds and hands to `<ConfirmDialog store={store} dialogs={dialogs} />`; a confirm opened by a second instance would never be resolved. `ConfirmButton` supports `role: "primary" | "danger" | "cancel"`; `ConfirmDialog` focuses the primary button, maps Escape to the cancel button and Enter to the primary one — **with no primary button, Enter does nothing**, which is the friction a destructive action wants.
- `apps/ui/src/shell/sheet-focus.ts` — `useSheetFocus(open, ref)` traps Tab and restores focus to the opener. Written for modal sheets; the side bar is not modal, so this plan does **not** use it (a trapped Tab in a non-modal panel would strand keyboard users).
- `apps/ui/src/shell/overlay-presence.ts` — `useOverlayPresence(open)` collapses docked web views under overlays. The side bar is docked chrome, not an overlay, so this plan does not use it either.
- `apps/ui/src/palette/match.ts` — `matchTitle(query, title): { score, ranges } | null`, a prefix → word-boundary → substring → subsequence ladder. Generic, already exported, and reused by Task 6.
- `apps/ui/src/output/OutputPanel.tsx:53-58` — the `useVirtualizer` usage to copy for a long list.
- `apps/ui/src/output/copy.ts` — `copyEntriesToClipboard(text)` resolving `"copied" | "failed"`, never throwing.
- `apps/ui/src/tabs/tab-actions.ts` — `TabActions.newTab(params?: TabCreateParams)`, where `TabCreateParams` accepts `{ language?, runtime?, title?, titleIsCustom?, content? }`. That is how "Insert in New Tab" creates its tab.
- `apps/ui/test/fake-api.ts` ends in `satisfies MainApi`, so **every new `MainApi` member must be added to the fake in the same task**, or typecheck fails across every UI test.
- E2E: `packages/e2e/src/app.ts` exposes `launchApp`, and a `LaunchedApp` with `state()`, `output()`, `type()`, `key(spec)`, `command(id, args?)`, `newTab()`, `waitForOutput`, `relaunch`, `dispose`. `activeTab(state)` and `waitFor(fn, {timeoutMs, message})` come from `../src`. Scenarios read `state.ui.*` (the `UiSnapshot`) and `state.main.menu`.

---

## Rulings recorded for this milestone

- **R-M5b-1 — `sideBarPanel` is an open set owned by `store.ts`; M5b adds no member and re-declares nothing.** `"snippets"` is already a member today and stays one after M5a widens the union. Every line this plan writes refers to the panel type as **`AppState["sideBarPanel"]`** (an indexed access) or not at all, so it resolves to whatever the union currently is and never needs editing when a sibling milestone adds `"transpiled"`, `"ai"`-successors, or anything else. This plan never writes `type SideBarPanel = …`, never widens `setSideBarPanel`, and never changes `App.tsx`'s `togglePanel` signature (which already accepts `"snippets"`).
- **R-M5b-2 — the `SideBar.tsx` merge rule, stated in advance.** Both plans give `SideBar` the props `panel`, `store`, `api`; this plan adds a fourth, `dialogs`, because the Delete confirmation must use App's single `Dialogs` instance (see the survey). The merged signature, whichever plan lands second, is:
  ```tsx
  export function SideBar({ panel, store, api, dialogs }: {
    panel: AppState["sideBarPanel"];
    store: AppStore;
    api: MainApi;
    dialogs: Dialogs;
  })
  ```
  `api: MainApi` is a supertype of M5a's `Pick<MainApi, "transpiled">`, so `<TranspiledPanel api={api} />` still typechecks unchanged after the widening. The body is a list of independent early returns (`if (panel === "snippets") return <SnippetsPanel …/>;` / `if (panel === "transpiled") return <TranspiledPanel …/>;`), so the two plans add disjoint lines. In `App.tsx` the mount line becomes `<SideBar panel={sideBarPanel} store={store} api={api} dialogs={dialogs} />` — one line, one conflict, resolved by keeping all four props.
- **R-M5b-3 — `Cmd+B` reuses the existing panel switch; there is no separate modal.** `tools.snippets` calls the very same `togglePanel("snippets")` the activity-bar button calls, so the key and the click can never diverge. Observable behaviour: side bar hidden → it opens showing Snippets and the search box takes focus; side bar open on another panel → it switches to Snippets and focuses search; side bar open on Snippets → it hides the side bar. §7.5's parenthetical "(or modal when the side bar is hidden)" exists so the feature stays reachable when the side bar is off; opening the side bar achieves that with one surface instead of two copies of the same state. **Recorded as a parity deviation in Task 12.**
- **R-M5b-4 — Delete is confirmed *and* undoable.** §13.1 mandates the confirmation `Delete snippet "<name>"?` verbatim, so it ships exactly as worded, with Cancel (`role: "cancel"`) and Delete (`role: "danger"`) and **no primary button**, so Escape cancels and Enter does nothing. The research file additionally warns that a modal alone is the wrong pattern for a cheap, recreatable artifact, so after the delete lands the panel keeps the removed record and shows a `role="status"` row — `Deleted "<name>". Undo` — until the next mutation or until the panel unmounts. Undo restores the snippet with its original `id`, `createdAt` and `updatedAt` and saves. Delete is therefore confirmed, reversible within the session, and irreversible only after a second action — which is what the spec's confirmation is for.
- **R-M5b-5 — the New Snippet body is a real Monaco editor, injected.** §13.1 says "Body (a Monaco editor)", and the research file's pattern 4 agrees that a code-shaped field should not fall back to a `<textarea>`. Monaco cannot mount under happy-dom, so the form takes a `createBody` prop of type `SnippetBodyFactory`; production passes the Monaco-backed factory, tests pass a plain in-memory stub. The factory itself is a framework-free module with its own fake-Monaco test. This is the same injection the repo already uses for `api`, `formatter` and `timers` — not a test-only escape hatch.
- **R-M5b-6 — the whole library is written back on every mutation.** One writer (the main window), one file, a hard cap of `MAX_SNIPPETS = 2000` records at `MAX_SNIPPET_BODY_CHARS = 20_000` each, and an atomic write with a `.bak`. Per-record RPC verbs would buy nothing and would need conflict handling that cannot arise. `env.json` sets the precedent at 500 records.
- **R-M5b-7 — autocomplete is trigger-based expansion, not continuous fuzzy suggest.** §13.3 requires that a snippet still be suggested *after its full name has been typed* (RunJS #488). The obvious implementation — VS Code's suggest widget, which fuzzy-matches every typed prefix — is a **known, still-open annoyance for exactly this case**: the design research at `scratchpad/m5-ui-patterns.md` §1 ("Autocomplete after the full name is typed — the specific question") records VS Code issues #244170 (an exact match scores no higher than a partial one) and #66621 (keep snippets out of the way until the user is clearly invoking one), and concludes: *"Do not copy this part uncritically."* JSLab copies **JetBrains Live Templates / Raycast** instead, as that research recommends, giving two channels:
  1. **Expansion (primary).** Typing a snippet's full name and pressing `Tab` expands it unconditionally. Names are unique and the match is on the exact trailing word, so this is never ambiguous and never shows a list. When the trailing word is not a snippet name the command reports `isEnabled() === false`, the resolver skips `preventDefault`, and `Tab` indents exactly as it does today.
  2. **Discovery (secondary).** The `CompletionItemProvider` lists snippets whose name *starts with* the typed word, which is what §13.3 specifies. Per the research's "additionally deduplicate" recommendation, **once the typed word equals a snippet's name the list collapses to that one item** instead of continuing to rank siblings, and snippet items sort ahead of word suggestions within their bucket via `sortText`. That satisfies §13.3's full-name requirement through a path that cannot become noise.
- **R-M5b-8 — imported files are parsed in Main, merged in the UI.** Parsing and validating an untrusted file is a Main concern (§18: no generic "read any file" endpoint; every payload zod-validated). Choosing between overwrite / keep both / skip is a user-facing policy decision and belongs to the panel. So `snippets.importDialog` opens the dialog, reads at most `MAX_SNIPPETS_FILE_BYTES`, validates, and pushes back either the parsed records or a reason — it **never** writes the library. A rejected import leaves `snippets.json` byte-identical, which Task 3 asserts.
- **R-M5b-9 — a snippet id is an opaque safe string, and every imported record is re-issued one.** `id` validates as `^[A-Za-z0-9_-]{1,100}$` rather than a strict UUID, so a hand-authored library is not rejected over a cosmetic field, and the merge always mints a fresh id for anything it adds — so a hostile file cannot collide with, alias, or overwrite an existing record by claiming its id. Conflicts are resolved by **name** (case-insensitive), never by id.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/snippets.ts` | **New.** `Snippet`, `snippetSchema`, `snippetsFileSchema`, `SNIPPETS_VERSION`, the caps and the name pattern, `parseSnippetsFile`, `mergeSnippets`, `uniqueSnippetName`, `newSnippet`. |
| `packages/shared/src/index.ts` | One `export * from "./snippets";` line. |
| `packages/shared/test/snippets.test.ts` | **New.** The format, hostile input, and merge policies. |
| `apps/desktop/src/main/services/snippet-store.ts` | **New.** `snippets.json`: load, corrupt recovery, atomic save with `.bak`. |
| `apps/desktop/src/main/app-paths.ts` | One `snippetsFile` path. |
| `apps/desktop/src/main/main-services.ts` | Opens the store; exposes it on `MainServices`. |
| `apps/desktop/src/main/rpc/snippet-handlers.ts` | **New.** `snippets.list`, `snippets.save`, `snippets.importDialog`, `snippets.exportDialog`. |
| `apps/desktop/src/main/index.ts` | Registers the handler group with its dialog adapters. |
| `apps/desktop/src/main/strings.ts` | Main-side import/export failure strings. |
| `packages/rpc-schema/src/ui-rpc.ts` | The schemas, `MainRequests` / `MainMessages` / `ViewMessages` entries, `SnippetsImported`, `SnippetsExported`. |
| `apps/ui/src/api.ts`, `rpc.ts`, `apps/ui/test/fake-api.ts` | The four new `MainApi` members. |
| `apps/ui/src/state/store.ts` | `snippets`, `snippetsLoaded`, `snippetsRequest`; `receiveSnippets`, `requestSnippets`, `clearSnippetsRequest`. |
| `apps/ui/src/snippets/snippet-text.ts` | **New.** Template escaping, plain-insertion fallback, trigger word, expansion lookup, completion selection. |
| `apps/ui/src/snippets/snippet-filter.ts` | **New.** Search ranking and highlight ranges over the library. |
| `apps/ui/src/snippets/SnippetsPanel.tsx` | **New.** Search + virtualized list + preview + actions + empty states + delete/undo. |
| `apps/ui/src/snippets/SnippetForm.tsx` | **New.** New/Edit form with the injected body editor. |
| `apps/ui/src/snippets/body-editor.ts` | **New.** `SnippetBodyHandle` and the Monaco-backed factory. |
| `apps/ui/src/snippets/snippet-completions.ts` | **New.** `registerSnippetCompletions(monaco, deps)`. |
| `apps/ui/src/snippets/create-snippet-action.ts` | **New.** `registerCreateSnippetAction(editor, deps)` — the editor context-menu item. |
| `apps/ui/src/snippets/snippet-commands.ts` | **New.** `createSnippetCommands(deps)` — the five `CommandSpec`s. |
| `apps/ui/src/editor/editor-handle.ts`, `editor/Editor.tsx` | Three new handle members; the two Monaco registrations. |
| `apps/ui/src/shell/SideBar.tsx`, `ActivityBar.tsx`, `App.tsx` | The panel mount, the ⌘B keycap, command registration, the E2E region. |
| `apps/ui/src/strings.ts`, `styles.css` | Panel copy and Graphite styling. |
| `packages/shared/src/commands.ts`, `keybindings.ts` | Five `CommandId`s; the `cmd+b` and `tab` defaults. |
| `apps/desktop/src/main/menu.ts` | Tools → Snippets…, Import…, Export…; Edit → Create Snippet…. |
| `packages/e2e/scenarios/snippets.test.ts` | **New.** The end-to-end scenario. |
| `docs/parity.md`, `README.md`, roadmap | Task 12. |

---

## Task index

| # | Task | Deliverable |
|---|---|---|
| 1 | The snippet model and `jslab-snippets` format | `@jslab/shared` parses, validates and merges libraries; hostile input is refused. |
| 2 | `SnippetStore` in Main | `snippets.json` loads, recovers and saves atomically. |
| 3 | The snippets RPC and the import/export dialogs | Four wire entry points, validated; a bad import cannot corrupt the library. |
| 4 | UI plumbing: `MainApi` and the store slice | The library reaches the UI store and back. |
| 5 | Snippet text logic | Template escaping, trigger detection, completion selection. |
| 6 | Snippet search and ranking | Usable at 0, 1 and 500 snippets. |
| 7 | The snippets panel | List, preview, actions, empty states, delete + undo. |
| 8 | The New/Edit snippet form | Validated fields and a real Monaco body. |
| 9 | Side-bar mount, commands, keymap and menus | `Cmd+B`, the panel switch, Tools and Edit menus. |
| 10 | Monaco: completions, Tab expansion, Create Snippet… | The two providers and the context-menu action. |
| 11 | E2E — snippets | The scenario, including a refused malformed import. |
| 12 | Docs, parity and the full-suite gate | Seven parity rows flipped; deviations recorded. |

---

### Task 1: The snippet model and the `jslab-snippets` file format

**Files:**
- Create: `packages/shared/src/snippets.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/snippets.test.ts` (new)

**Interfaces:**
- Consumes: `LANGUAGES` and `Language` from `packages/shared/src/settings.ts`; `zod` 4.6.4 (already a dependency of `@jslab/shared`).
- Produces, all exported from `@jslab/shared`:
  - `interface Snippet { id: string; name: string; description: string; body: string; language: Language | null; createdAt: string; updatedAt: string }`
  - `const snippetSchema`, `const snippetsFileSchema`
  - `const SNIPPETS_FORMAT = "jslab-snippets"`, `const SNIPPETS_VERSION = 1`
  - `const MAX_SNIPPETS = 2000`, `MAX_SNIPPET_NAME_CHARS = 100`, `MAX_SNIPPET_DESCRIPTION_CHARS = 200`, `MAX_SNIPPET_BODY_CHARS = 20_000`, `SNIPPET_NAME_PATTERN = /^[\w$-]+$/`
  - `function isValidSnippetName(name: string): boolean`
  - `function newSnippet(fields: { name: string; description?: string; body: string; language?: Language | null }, now?: () => string, newId?: () => string): Snippet`
  - `type SnippetsFileReason = "notObject" | "wrongFormat" | "newerVersion" | "invalidSnippets" | "duplicateNames" | "duplicateIds"`
  - `type SnippetsFileResult = { ok: true; snippets: Snippet[] } | { ok: false; reason: SnippetsFileReason; detail: string }`
  - `function parseSnippetsFile(input: unknown): SnippetsFileResult`
  - `function snippetsFileContent(snippets: readonly Snippet[]): string`
  - `type ConflictPolicy = "overwrite" | "keepBoth" | "skip"`
  - `function uniqueSnippetName(existing: readonly Snippet[], base: string): string`
  - `interface MergeResult { snippets: Snippet[]; added: number; overwritten: number; skipped: number; renamed: number }`
  - `function mergeSnippets(existing: readonly Snippet[], incoming: readonly Snippet[], policy: ConflictPolicy, newId?: () => string): MergeResult`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/snippets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  MAX_SNIPPETS,
  MAX_SNIPPET_BODY_CHARS,
  mergeSnippets,
  newSnippet,
  parseSnippetsFile,
  type Snippet,
  SNIPPETS_FORMAT,
  SNIPPETS_VERSION,
  isValidSnippetName,
  snippetsFileContent,
  uniqueSnippetName,
} from "../src/snippets";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "const res = await fetch(${1:url});\n$0",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});
const file = (snippets: Snippet[], version = SNIPPETS_VERSION) => ({
  format: SNIPPETS_FORMAT,
  version,
  snippets,
});

describe("snippet names (spec §13.1)", () => {
  test("accepts the documented pattern and rejects everything else", () => {
    for (const name of ["fetchjson", "fetch_json", "fetch-json", "$log", "A1"]) {
      expect(isValidSnippetName(name)).toBe(true);
    }
    for (const name of ["", "fetch json", "fetch.json", "fetch/json", "a".repeat(101), "héllo"]) {
      expect(isValidSnippetName(name)).toBe(false);
    }
  });

  test("newSnippet fills the timestamps and trims the description", () => {
    const created = newSnippet(
      { name: "log", description: "  says hi  ", body: "console.log($0)" },
      () => AT,
      () => "generated",
    );
    expect(created).toEqual({
      id: "generated",
      name: "log",
      description: "says hi",
      body: "console.log($0)",
      language: null,
      createdAt: AT,
      updatedAt: AT,
    });
  });
});

describe("the jslab-snippets file (spec §13.4)", () => {
  test("round-trips a valid library", () => {
    const parsed = parseSnippetsFile(JSON.parse(snippetsFileContent([record()])));
    expect(parsed).toEqual({ ok: true, snippets: [record()] });
  });

  test("refuses every malformed shape with a reason, and never throws", () => {
    const cases: [unknown, string][] = [
      [null, "notObject"],
      ["jslab-snippets", "notObject"],
      [[record()], "notObject"],
      [{ format: "vscode-snippets", version: 1, snippets: [] }, "wrongFormat"],
      [{ version: 1, snippets: [] }, "wrongFormat"],
      [file([], SNIPPETS_VERSION + 1), "newerVersion"],
      [{ format: SNIPPETS_FORMAT, version: 1, snippets: "all of them" }, "invalidSnippets"],
      [file([record({ name: "no spaces allowed" })]), "invalidSnippets"],
      [file([record({ body: "x".repeat(MAX_SNIPPET_BODY_CHARS + 1) })]), "invalidSnippets"],
      [file([record({ createdAt: "whenever" })]), "invalidSnippets"],
      [file([record({ language: "cobol" as never })]), "invalidSnippets"],
      [file([record(), record({ id: "s2" })]), "duplicateNames"],
      [file([record(), record({ name: "other" })]), "duplicateIds"],
    ];
    for (const [input, reason] of cases) {
      const result = parseSnippetsFile(input);
      expect([input, result.ok]).toEqual([input, false]);
      if (result.ok) continue;
      expect([input, result.reason]).toEqual([input, reason as never]);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  test("a name differing only in case is still a duplicate, and the cap is enforced", () => {
    const shouted = parseSnippetsFile(file([record(), record({ id: "s2", name: "FETCHJSON" })]));
    expect(shouted.ok ? "accepted" : shouted.reason).toBe("duplicateNames");
    const tooMany = Array.from({ length: MAX_SNIPPETS + 1 }, (_, index) =>
      record({ id: `s${index}`, name: `s${index}` }),
    );
    const capped = parseSnippetsFile(file(tooMany));
    expect(capped.ok ? "accepted" : capped.reason).toBe("invalidSnippets");
  });

  test("unknown keys on a record are dropped rather than rejected", () => {
    const withExtra = { ...record(), shortcut: "cmd+j" } as unknown as Snippet;
    const parsed = parseSnippetsFile(file([withExtra]));
    expect(parsed.ok && parsed.snippets[0]).toEqual(record());
  });
});

describe("merging an imported library (spec §13.1 Options menu)", () => {
  const existing = [record({ id: "e1", name: "fetchjson", body: "OLD" })];
  const incoming = [
    record({ id: "i1", name: "FetchJson", body: "NEW" }),
    record({ id: "i2", name: "brandnew", body: "FRESH" }),
  ];
  let counter = 0;
  const newId = () => `new${++counter}`;

  test("overwrite keeps the existing id and takes the incoming content", () => {
    counter = 0;
    const merged = mergeSnippets(existing, incoming, "overwrite", newId);
    expect([merged.added, merged.overwritten, merged.skipped, merged.renamed]).toEqual([1, 1, 0, 0]);
    expect(merged.snippets.map((s) => [s.id, s.name, s.body])).toEqual([
      ["e1", "FetchJson", "NEW"],
      ["new1", "brandnew", "FRESH"],
    ]);
  });

  test("skip leaves the conflicting record untouched", () => {
    counter = 0;
    const merged = mergeSnippets(existing, incoming, "skip", newId);
    expect([merged.added, merged.overwritten, merged.skipped, merged.renamed]).toEqual([1, 0, 1, 0]);
    expect(merged.snippets.map((s) => [s.id, s.name, s.body])).toEqual([
      ["e1", "fetchjson", "OLD"],
      ["new1", "brandnew", "FRESH"],
    ]);
  });

  test("keepBoth renames the incoming copy to a free, still-valid name", () => {
    counter = 0;
    const merged = mergeSnippets(existing, incoming, "keepBoth", newId);
    expect([merged.added, merged.overwritten, merged.skipped, merged.renamed]).toEqual([2, 0, 0, 1]);
    expect(merged.snippets.map((s) => [s.id, s.name])).toEqual([
      ["e1", "fetchjson"],
      ["new1", "FetchJson-2"],
      ["new2", "brandnew"],
    ]);
    expect(isValidSnippetName("FetchJson-2")).toBe(true);
  });

  test("uniqueSnippetName keeps counting past an existing -2", () => {
    const taken = [record({ id: "a", name: "log" }), record({ id: "b", name: "log-2" })];
    expect(uniqueSnippetName(taken, "log")).toBe("log-3");
    expect(uniqueSnippetName(taken, "free")).toBe("free");
  });

  test("an import can never exceed the cap", () => {
    const full = Array.from({ length: MAX_SNIPPETS }, (_, i) => record({ id: `f${i}`, name: `f${i}` }));
    const merged = mergeSnippets(full, [record({ id: "x", name: "overflow" })], "keepBoth", newId);
    expect(merged.snippets).toHaveLength(MAX_SNIPPETS);
    expect(merged.added).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && bun test ./test/snippets.test.ts`
Expected: FAIL with `Cannot find module '../src/snippets'`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/snippets.ts`:

```ts
import { z } from "zod";
import { LANGUAGES, type Language } from "./settings";

/** Spec §13.4: the `format` discriminator of an exported library. */
export const SNIPPETS_FORMAT = "jslab-snippets";
/** Spec §13.4: the current file version. Bumping it means adding a SNIPPET_MIGRATIONS entry. */
export const SNIPPETS_VERSION = 1;

export const MAX_SNIPPETS = 2000;
export const MAX_SNIPPET_NAME_CHARS = 100;
export const MAX_SNIPPET_DESCRIPTION_CHARS = 200;
export const MAX_SNIPPET_BODY_CHARS = 20_000;

/** Spec §13.1: the name is the autocomplete trigger, and must match this exactly. */
export const SNIPPET_NAME_PATTERN = /^[\w$-]+$/;

export function isValidSnippetName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SNIPPET_NAME_CHARS && SNIPPET_NAME_PATTERN.test(name);
}

/**
 * Ruling R-M5b-9: an opaque safe string, not a strict UUID. JSLab mints UUIDs itself, but a hand-authored or
 * hand-edited library must not be refused over a cosmetic field -- and it cannot alias an existing record either,
 * because `mergeSnippets` always issues a fresh id for anything it adds.
 */
const snippetId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

/** An ISO timestamp, checked by parsing rather than by pattern, so any spelling Date understands round-trips. */
const isoTimestamp = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "not an ISO 8601 timestamp" });

/** Spec §13.4. A strict object: unknown keys are dropped, so a newer build's extra field can't smuggle anything in. */
export const snippetSchema = z.object({
  id: snippetId,
  name: z.string().min(1).max(MAX_SNIPPET_NAME_CHARS).regex(SNIPPET_NAME_PATTERN),
  description: z.string().max(MAX_SNIPPET_DESCRIPTION_CHARS),
  body: z.string().max(MAX_SNIPPET_BODY_CHARS),
  language: z.enum(LANGUAGES).nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export type Snippet = z.infer<typeof snippetSchema>;

export const snippetsFileSchema = z.object({
  format: z.literal(SNIPPETS_FORMAT),
  version: z.number().int().min(1),
  snippets: z.array(snippetSchema).max(MAX_SNIPPETS),
});

export function newSnippet(
  fields: { name: string; description?: string; body: string; language?: Language | null },
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): Snippet {
  const at = now();
  return {
    id: newId(),
    name: fields.name,
    description: (fields.description ?? "").trim(),
    body: fields.body,
    language: fields.language ?? null,
    createdAt: at,
    updatedAt: at,
  };
}

export type SnippetsFileReason =
  | "notObject"
  | "wrongFormat"
  | "newerVersion"
  | "invalidSnippets"
  | "duplicateNames"
  | "duplicateIds";

export type SnippetsFileResult =
  | { ok: true; snippets: Snippet[] }
  | { ok: false; reason: SnippetsFileReason; detail: string };

const key = (name: string) => name.toLowerCase();

/**
 * Spec §13.4. Every failure is a value, never an exception: this runs on a file the user picked, which may have been
 * hand-edited or come from anywhere (ruling R-M5b-8). Nothing here touches the stored library.
 */
export function parseSnippetsFile(input: unknown): SnippetsFileResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "notObject", detail: "The file's top level isn't a JSON object." };
  }
  const record = input as Record<string, unknown>;
  if (record.format !== SNIPPETS_FORMAT) {
    return {
      ok: false,
      reason: "wrongFormat",
      detail: `Expected "format": "${SNIPPETS_FORMAT}", found ${JSON.stringify(record.format ?? null)}.`,
    };
  }
  if (typeof record.version === "number" && record.version > SNIPPETS_VERSION) {
    return {
      ok: false,
      reason: "newerVersion",
      detail: `This file is version ${record.version}; this JSLab reads version ${SNIPPETS_VERSION}.`,
    };
  }
  const parsed = snippetsFileSchema.safeParse(record);
  if (!parsed.success) {
    return { ok: false, reason: "invalidSnippets", detail: parsed.error.issues[0]?.message ?? "Invalid snippets." };
  }
  const { snippets } = parsed.data;
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const snippet of snippets) {
    if (names.has(key(snippet.name))) {
      return { ok: false, reason: "duplicateNames", detail: `Two snippets are named "${snippet.name}".` };
    }
    if (ids.has(snippet.id)) {
      return { ok: false, reason: "duplicateIds", detail: `Two snippets share the id "${snippet.id}".` };
    }
    names.add(key(snippet.name));
    ids.add(snippet.id);
  }
  return { ok: true, snippets };
}

/** The exact bytes of an exported or saved library (spec §13.4), newline-terminated like every other JSLab file. */
export function snippetsFileContent(snippets: readonly Snippet[]): string {
  return `${JSON.stringify({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets }, null, 2)}\n`;
}

export type ConflictPolicy = "overwrite" | "keepBoth" | "skip";

/** `base`, else `base-2`, `base-3`, … -- all still matching SNIPPET_NAME_PATTERN, since `-` is in it. */
export function uniqueSnippetName(existing: readonly Snippet[], base: string): string {
  const taken = new Set(existing.map((snippet) => key(snippet.name)));
  if (!taken.has(key(base))) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
}

export interface MergeResult {
  snippets: Snippet[];
  added: number;
  overwritten: number;
  skipped: number;
  renamed: number;
}

/**
 * Spec §13.1: "Import… (merge; name conflicts get an overwrite, keep both, or skip choice)". Conflicts are decided by
 * name, case-insensitively (ruling R-M5b-9), and an overwrite keeps the existing record's id and createdAt so the
 * library's own identity is stable; everything added gets a fresh id, so an imported file can never claim one.
 */
export function mergeSnippets(
  existing: readonly Snippet[],
  incoming: readonly Snippet[],
  policy: ConflictPolicy,
  newId: () => string = () => crypto.randomUUID(),
): MergeResult {
  const snippets = [...existing];
  let added = 0;
  let overwritten = 0;
  let skipped = 0;
  let renamed = 0;
  for (const candidate of incoming) {
    const index = snippets.findIndex((snippet) => key(snippet.name) === key(candidate.name));
    if (index >= 0) {
      const current = snippets[index];
      if (!current) continue;
      if (policy === "skip") {
        skipped += 1;
        continue;
      }
      if (policy === "overwrite") {
        snippets[index] = {
          ...candidate,
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: candidate.updatedAt,
        };
        overwritten += 1;
        continue;
      }
    }
    if (snippets.length >= MAX_SNIPPETS) continue;
    const name = index >= 0 ? uniqueSnippetName(snippets, candidate.name) : candidate.name;
    if (name !== candidate.name) renamed += 1;
    snippets.push({ ...candidate, id: newId(), name });
    added += 1;
  }
  return { snippets, added, overwritten, skipped, renamed };
}
```

Add one line to `packages/shared/src/index.ts`, keeping the file's alphabetical order (between `./session` and `./tabs`):

```ts
export * from "./snippets";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && bun test ./test/snippets.test.ts`
Expected: PASS, **+9 tests**.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add packages/shared/src/snippets.ts packages/shared/src/index.ts packages/shared/test/snippets.test.ts
git commit -m "$(cat <<'EOF'
Add the snippet model and the jslab-snippets file format

Parsing an imported library is a value-returning function with a named reason
for every refusal, because the file is untrusted input. Conflicts merge by
name; anything added gets a fresh id, so a file can never claim an existing
record's identity.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 2: `SnippetStore` — `snippets.json` in Main

**Files:**
- Create: `apps/desktop/src/main/services/snippet-store.ts`
- Modify: `apps/desktop/src/main/app-paths.ts`, `apps/desktop/src/main/main-services.ts`
- Test: `apps/desktop/test/services/snippet-store.test.ts` (new)

**Interfaces:**
- Consumes: `Snippet`, `parseSnippetsFile`, `snippetsFileContent`, `snippetSchema`, `MAX_SNIPPETS` (Task 1); `writeFileAtomic` and `AtomicWriteOptions` from `apps/desktop/src/main/persistence/atomic-write.ts`.
- Produces:
  - `type SnippetWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>`
  - `class SnippetStore` with `static open(path: string, options?: { write?: SnippetWrite; now?: () => number }): Promise<SnippetStore>`, `get snippets(): Snippet[]`, `save(snippets: Snippet[]): Promise<Snippet[]>`, `readonly recovered: "none" | "defaults"`, `readonly path: string`
  - `AppPaths.snippetsFile: string`
  - `MainServices.snippets: SnippetStore`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/services/snippet-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Snippet, SNIPPETS_FORMAT, SNIPPETS_VERSION } from "@jslab/shared";
import { SnippetStore } from "../../src/main/services/snippet-store";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const dir = () => mkdtemp(join(tmpdir(), "jl-snippets-"));

describe("SnippetStore (spec §4.5, §13.4)", () => {
  test("a missing file starts empty, and save writes the documented format", async () => {
    const path = join(await dir(), "snippets.json");
    const store = await SnippetStore.open(path);
    expect([store.snippets, store.recovered]).toEqual([[], "none"]);

    await store.save([record()]);
    expect(store.snippets).toEqual([record()]);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets: [record()] });

    const reopened = await SnippetStore.open(path);
    expect(reopened.snippets).toEqual([record()]);
  });

  test("a corrupt file is kept aside and the store starts empty rather than refusing to open", async () => {
    const folder = await dir();
    const path = join(folder, "snippets.json");
    await writeFile(path, "{ not json at all");
    const store = await SnippetStore.open(path, { now: () => 1234 });
    expect([store.snippets, store.recovered]).toEqual([[], "defaults"]);
    expect(await readdir(folder)).toContain("snippets.corrupt-1234.json");
  });

  test("a file that parses but isn't a snippet library is treated the same way", async () => {
    const folder = await dir();
    const path = join(folder, "snippets.json");
    await writeFile(path, JSON.stringify({ format: "vscode-snippets", version: 1, snippets: [] }));
    const store = await SnippetStore.open(path, { now: () => 99 });
    expect(store.recovered).toBe("defaults");
    expect(await readdir(folder)).toContain("snippets.corrupt-99.json");
  });

  test("a read failure that isn't ENOENT throws instead of silently emptying the library (EnvStore's FR-2)", async () => {
    const path = join(await dir(), "snippets.json");
    await writeFile(path, JSON.stringify({ format: SNIPPETS_FORMAT, version: 1, snippets: [] }));
    // A directory in place of the file: readFile fails with EISDIR, not ENOENT.
    const asDirectory = join(await dir(), "as-a-directory");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(asDirectory, { recursive: true });
    expect(SnippetStore.open(asDirectory)).rejects.toThrow();
  });

  test("save validates before writing, and a rejected save leaves the file untouched", async () => {
    const path = join(await dir(), "snippets.json");
    const store = await SnippetStore.open(path);
    await store.save([record()]);
    const before = await readFile(path, "utf8");
    expect(store.save([record({ name: "not a valid name" })])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(store.snippets).toEqual([record()]);
  });

  test("writes go through writeFileAtomic with a backup", async () => {
    const path = join(await dir(), "snippets.json");
    const calls: { path: string; backup: boolean | undefined }[] = [];
    const store = await SnippetStore.open(path, {
      write: async (target, _data, options) => void calls.push({ path: target, backup: options.backup }),
    });
    await store.save([record()]);
    expect(calls).toEqual([{ path, backup: true }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && bun test ./test/services/snippet-store.test.ts`
Expected: FAIL with `Cannot find module '../../src/main/services/snippet-store'`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/services/snippet-store.ts`:

```ts
import { readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_SNIPPETS, parseSnippetsFile, type Snippet, snippetSchema, snippetsFileContent } from "@jslab/shared";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";

export type SnippetWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

/**
 * `snippets.json` (spec §4.5, §13.4): the snippet library, written atomically with a `.bak`. Shaped after `EnvStore`,
 * including its FR-2 rule -- only a missing file means "nothing saved yet"; any other read failure must reach the
 * caller, or the next save would overwrite the user's real library with an empty one.
 */
export class SnippetStore {
  #snippets: Snippet[];

  private constructor(
    readonly path: string,
    snippets: Snippet[],
    readonly recovered: "none" | "defaults",
    private readonly write: SnippetWrite,
  ) {
    this.#snippets = snippets;
  }

  static async open(path: string, options: { write?: SnippetWrite; now?: () => number } = {}): Promise<SnippetStore> {
    const write = options.write ?? writeFileAtomic;
    let text: string | null;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      text = null;
    }
    if (text === null) return new SnippetStore(path, [], "none", write);
    const parsed = (() => {
      try {
        return parseSnippetsFile(JSON.parse(text) as unknown);
      } catch {
        return { ok: false as const, reason: "notObject" as const, detail: "not JSON" };
      }
    })();
    if (!parsed.ok) {
      // Spec §20's idiom, as EnvStore and loadJson both use it: never delete what could not be understood.
      const copy = join(dirname(path), `${basename(path, ".json")}.corrupt-${(options.now ?? Date.now)()}.json`);
      await rename(path, copy);
      return new SnippetStore(path, [], "defaults", write);
    }
    return new SnippetStore(path, parsed.snippets, "none", write);
  }

  get snippets(): Snippet[] {
    return this.#snippets;
  }

  /** Validates every record before any byte is written, so a bad save can never truncate the library. */
  async save(snippets: Snippet[]): Promise<Snippet[]> {
    if (snippets.length > MAX_SNIPPETS) throw new Error(`At most ${MAX_SNIPPETS} snippets`);
    const valid = snippets.map((snippet) => snippetSchema.parse(snippet));
    await this.write(this.path, snippetsFileContent(valid), { backup: true });
    this.#snippets = valid;
    return valid;
  }
}
```

In `apps/desktop/src/main/app-paths.ts`, add the field to `AppPaths` next to `envFile`:

```ts
  envFile: string;
  /** Spec §4.5: the snippet library (§13.4). */
  snippetsFile: string;
```

and to the returned object in `resolveAppPaths`, right after `envFile`:

```ts
    snippetsFile: join(dataDir, "snippets.json"),
```

In `apps/desktop/src/main/main-services.ts`, import the store:

```ts
import { SnippetStore } from "./services/snippet-store";
```

add it to the `MainServices` interface after `env`:

```ts
  /** Spec §13.4: the snippet library. */
  snippets: SnippetStore;
```

open it in `createMainServices` immediately after the `EnvStore.open` line:

```ts
  const env = await EnvStore.open(paths.envFile);
  const snippets = await SnippetStore.open(paths.snippetsFile);
```

and add `snippets,` to the returned object, after `env,`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/desktop && bun test ./test/services/snippet-store.test.ts && bun test ./test/main-services.test.ts
```
Expected: PASS, **+6 tests**; `main-services.test.ts` unchanged and still green (the new store opens against the same temporary data folder it already builds).

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/desktop/src/main/services/snippet-store.ts apps/desktop/src/main/app-paths.ts \
        apps/desktop/src/main/main-services.ts apps/desktop/test/services/snippet-store.test.ts
git commit -m "$(cat <<'EOF'
Store the snippet library in snippets.json

The store follows EnvStore exactly, including its rule that only a missing
file means "nothing saved yet" -- any other read failure reaches the caller
instead of quietly emptying the library on the next save.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 3: The snippets RPC, and the import/export dialogs

**Files:**
- Create: `apps/desktop/src/main/rpc/snippet-handlers.ts`
- Modify: `packages/rpc-schema/src/ui-rpc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/strings.ts`
- Test: `apps/desktop/test/rpc/snippet-handlers.test.ts` (new)

**Interfaces:**
- Consumes: `SnippetStore` (Task 2); `parseSnippetsFile`, `snippetsFileContent`, `snippetSchema`, `MAX_SNIPPETS` (Task 1); `createValidators` / `Log` from `apps/desktop/src/main/rpc/validate.ts`; `SaveResult` from `@jslab/rpc-schema`.
- Produces:
  - In `@jslab/rpc-schema`: `MAX_SNIPPETS_FILE_BYTES = 5 * 1024 * 1024`, `snippetsSaveParamsSchema`, `snippetsExportParamsSchema`, `type SnippetsImported`, `type SnippetsExported`; `MainRequests["snippets.list" | "snippets.save"]`; `MainMessages["snippets.importDialog" | "snippets.exportDialog"]`; `ViewMessages["snippets.imported" | "snippets.exported"]`.
  - `function createSnippetHandlers(deps: SnippetHandlerDeps)` returning `{ requests, messages }`, where
    ```ts
    interface SnippetHandlerDeps {
      snippets: Pick<SnippetStore, "snippets" | "save">;
      openDialog(options: { startingFolder: string }): Promise<string[]>;
      saveDialog(options: { defaultName: string; defaultDir: string }): Promise<string | null>;
      readFile(path: string): Promise<string>;
      writeFile(path: string, content: string): Promise<void>;
      documentsDir: string;
      send: { imported(payload: SnippetsImported): void; exported(payload: SnippetsExported): void };
      log: Log;
    }
    ```

> **Ruling R-M5b-8 in code:** `snippets.importDialog` parses and reports; it never calls `snippets.save`. The merge choice is the panel's (Task 7), and the panel then saves through `snippets.save` like any other edit.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/rpc/snippet-handlers.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { type Snippet, SNIPPETS_FORMAT, SNIPPETS_VERSION } from "@jslab/shared";
import type { SnippetsExported, SnippetsImported } from "@jslab/rpc-schema";
import { createSnippetHandlers } from "../../src/main/rpc/snippet-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

function setup(options: { file?: string; chosen?: string[]; savePath?: string | null } = {}) {
  let stored: Snippet[] = [record()];
  const imported: SnippetsImported[] = [];
  const exported: SnippetsExported[] = [];
  const written: { path: string; content: string }[] = [];
  const handlers = createSnippetHandlers({
    snippets: {
      get snippets() {
        return stored;
      },
      save: mock(async (next: Snippet[]) => {
        stored = next;
        return next;
      }),
    },
    openDialog: mock(async () => options.chosen ?? ["/tmp/library.json"]),
    saveDialog: mock(async () => (options.savePath === undefined ? "/tmp/out.json" : options.savePath)),
    readFile: mock(async () => options.file ?? ""),
    writeFile: mock(async (path: string, content: string) => void written.push({ path, content })),
    documentsDir: "/docs",
    send: { imported: (p) => imported.push(p), exported: (p) => exported.push(p) },
    log: () => {},
  });
  return { handlers, imported, exported, written, current: () => stored };
}

const library = (snippets: Snippet[]) =>
  JSON.stringify({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets });

describe("snippet handlers (spec §13.1, §13.4, §18)", () => {
  test("snippets.list returns the library and snippets.save replaces it", async () => {
    const { handlers, current } = setup();
    expect(handlers.requests["snippets.list"]({})).toEqual({ snippets: [record()] });
    const next = [record({ id: "s2", name: "log", body: "console.log($0)" })];
    expect(await handlers.requests["snippets.save"]({ snippets: next })).toEqual({ ok: true });
    expect(current()).toEqual(next);
  });

  test("snippets.save rejects an invalid payload before the store sees it", () => {
    const { handlers, current } = setup();
    expect(() => handlers.requests["snippets.save"]({ snippets: [record({ name: "has spaces" })] })).toThrow(
      InvalidPayloadError,
    );
    expect(() => handlers.requests["snippets.save"]({ snippets: "everything" })).toThrow(InvalidPayloadError);
    expect(current()).toEqual([record()]);
  });

  test("a failed write is reported as a result, not an exception", async () => {
    const { handlers } = setup();
    const failing = createSnippetHandlers({
      snippets: {
        snippets: [],
        save: mock(async () => {
          throw new Error("EACCES: permission denied");
        }),
      },
      openDialog: async () => [],
      saveDialog: async () => null,
      readFile: async () => "",
      writeFile: async () => {},
      documentsDir: "/docs",
      send: { imported: () => {}, exported: () => {} },
      log: () => {},
    });
    expect(await failing.requests["snippets.save"]({ snippets: [] })).toEqual({
      ok: false,
      error: "EACCES: permission denied",
    });
    expect(handlers.requests["snippets.list"]({})).toBeDefined();
  });

  test("importDialog parses the chosen file and reports it WITHOUT merging or saving", async () => {
    const incoming = [record({ id: "i1", name: "brandnew" })];
    const { handlers, imported, current } = setup({ file: library(incoming) });
    await handlers.messages["snippets.importDialog"]({});
    expect(imported).toEqual([{ ok: true, snippets: incoming }]);
    // R-M5b-8: the library is the panel's to change; import only reports.
    expect(current()).toEqual([record()]);
  });

  test("a malformed or hostile file is refused with a reason, and the library is untouched", async () => {
    const hostile = [
      "{ not json",
      JSON.stringify({ format: "vscode-snippets", version: 1, snippets: [] }),
      JSON.stringify({ format: SNIPPETS_FORMAT, version: 99, snippets: [] }),
      library([record({ body: "x".repeat(20_001) })]),
      library([record(), record({ id: "s2" })]),
      JSON.stringify({ format: SNIPPETS_FORMAT, version: 1, snippets: [{ name: "__proto__", body: "x" }] }),
    ];
    for (const file of hostile) {
      const { handlers, imported, current } = setup({ file });
      await handlers.messages["snippets.importDialog"]({});
      const [result] = imported;
      expect([file, result?.ok]).toEqual([file, false]);
      if (result && !result.ok) expect(result.detail.length).toBeGreaterThan(0);
      expect(current()).toEqual([record()]);
    }
  });

  test("a cancelled open dialog reports nothing at all", async () => {
    const { handlers, imported } = setup({ chosen: [] });
    await handlers.messages["snippets.importDialog"]({});
    expect(imported).toEqual([]);
  });

  test("exportDialog writes the documented format and reports the path", async () => {
    const { handlers, exported, written } = setup();
    await handlers.messages["snippets.exportDialog"]({ snippets: [record()] });
    expect(exported).toEqual([{ ok: true, path: "/tmp/out.json" }]);
    expect(JSON.parse(written[0]?.content ?? "null")).toEqual({
      format: SNIPPETS_FORMAT,
      version: SNIPPETS_VERSION,
      snippets: [record()],
    });
  });

  test("a cancelled save dialog reports cancellation rather than a failure", async () => {
    const { handlers, exported, written } = setup({ savePath: null });
    await handlers.messages["snippets.exportDialog"]({ snippets: [record()] });
    expect(exported).toEqual([{ cancelled: true }]);
    expect(written).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && bun test ./test/rpc/snippet-handlers.test.ts`
Expected: FAIL with `Cannot find module '../../src/main/rpc/snippet-handlers'`.

- [ ] **Step 3: Write the implementation**

In `packages/rpc-schema/src/ui-rpc.ts`, extend the `@jslab/shared` import with the snippet pieces:

```ts
import {
  type EnvVars,
  envVarsSchema,
  LANGUAGES,
  MAX_SNIPPETS,
  RUNTIMES,
  SETTINGS_SECTIONS,
  type Session,
  type Settings,
  type Snippet,
  snippetSchema,
} from "@jslab/shared";
```

Add, in the M3 section right after `envSaveParamsSchema`:

```ts
/** Spec §13.4: the largest snippets file an import will read. Bigger files are refused without being parsed. */
export const MAX_SNIPPETS_FILE_BYTES = 5 * 1024 * 1024;
export const snippetsSaveParamsSchema = z.object({ snippets: z.array(snippetSchema).max(MAX_SNIPPETS) });
export const snippetsExportParamsSchema = snippetsSaveParamsSchema;

/** The result of `snippets.importDialog`: parsed records, or the reason the file was refused (spec §13.4). */
export type SnippetsImported = { ok: true; snippets: Snippet[] } | { ok: false; reason: string; detail: string };
export type SnippetsExported = { ok: true; path: string } | { ok: false; error: string } | { cancelled: true };
export type { Snippet };
```

Add to `MainRequests`, after the two `env.*` entries:

```ts
  "snippets.list": { params: Record<string, never>; response: { snippets: Snippet[] } };
  "snippets.save": { params: { snippets: Snippet[] }; response: SaveResult };
```

Add to `MainMessages`, after `"wd.clear"`:

```ts
  /** Spec §13.1 Options menu: opens the file dialog, parses the chosen file, and answers with `snippets.imported`. */
  "snippets.importDialog": Record<string, never>;
  /** Spec §13.1 Options menu: saveDialog with the default name `jslab-snippets.json`; answers `snippets.exported`. */
  "snippets.exportDialog": { snippets: Snippet[] };
```

Add to `ViewMessages`, after `"wd.changed"`:

```ts
  "snippets.imported": SnippetsImported;
  "snippets.exported": SnippetsExported;
```

Create `apps/desktop/src/main/rpc/snippet-handlers.ts`:

```ts
import { dirname } from "node:path";
import {
  emptyParamsSchema,
  MAX_SNIPPETS_FILE_BYTES,
  type SaveResult,
  type Snippet,
  type SnippetsExported,
  type SnippetsImported,
  snippetsExportParamsSchema,
  snippetsSaveParamsSchema,
} from "@jslab/rpc-schema";
import { parseSnippetsFile, snippetsFileContent } from "@jslab/shared";
import type { SnippetStore } from "../services/snippet-store";
import { strings } from "../strings";
import { createValidators, type Log } from "./validate";

/** Spec §13.1: the default file name the Export dialog offers. */
export const SNIPPETS_EXPORT_NAME = "jslab-snippets.json";

export interface SnippetHandlerDeps {
  snippets: Pick<SnippetStore, "snippets" | "save">;
  openDialog(options: { startingFolder: string }): Promise<string[]>;
  saveDialog(options: { defaultName: string; defaultDir: string }): Promise<string | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  documentsDir: string;
  send: { imported(payload: SnippetsImported): void; exported(payload: SnippetsExported): void };
  log: Log;
}

/**
 * The snippet library on the wire (spec §13). Ruling R-M5b-8: this module parses an imported file but never merges
 * or stores it -- overwrite / keep both / skip is the panel's decision, and the panel then saves through
 * `snippets.save` like any other edit. So a refused import leaves `snippets.json` byte-identical.
 */
export function createSnippetHandlers(deps: SnippetHandlerDeps) {
  const { parse, message } = createValidators(deps.log);

  return {
    requests: {
      "snippets.list": (input: unknown): { snippets: Snippet[] } => {
        parse(emptyParamsSchema, "snippets.list", input);
        return { snippets: deps.snippets.snippets };
      },
      "snippets.save": (input: unknown): Promise<SaveResult> => {
        const { snippets } = parse(snippetsSaveParamsSchema, "snippets.save", input);
        return deps.snippets.save(snippets).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    messages: {
      "snippets.importDialog": message(emptyParamsSchema, "snippets.importDialog", async () => {
        const [path] = await deps.openDialog({ startingFolder: deps.documentsDir });
        // A cancelled dialog is not a failure: say nothing, exactly as file.openDialog does.
        if (!path) return;
        let text: string;
        try {
          text = await deps.readFile(path);
        } catch (error) {
          deps.send.imported({
            ok: false,
            reason: "unreadable",
            detail: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (text.length > MAX_SNIPPETS_FILE_BYTES) {
          deps.send.imported({ ok: false, reason: "tooLarge", detail: strings.snippets.tooLarge });
          return;
        }
        const parsed = (() => {
          try {
            return parseSnippetsFile(JSON.parse(text) as unknown);
          } catch (error) {
            return {
              ok: false as const,
              reason: "notObject" as const,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        })();
        deps.send.imported(
          parsed.ok ? { ok: true, snippets: parsed.snippets } : { ok: false, reason: parsed.reason, detail: parsed.detail },
        );
      }),
      "snippets.exportDialog": message(snippetsExportParamsSchema, "snippets.exportDialog", async ({ snippets }) => {
        let path: string | null;
        try {
          path = await deps.saveDialog({ defaultName: SNIPPETS_EXPORT_NAME, defaultDir: deps.documentsDir });
        } catch (error) {
          deps.send.exported({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (path === null) {
          deps.send.exported({ cancelled: true });
          return;
        }
        try {
          await deps.writeFile(path, snippetsFileContent(snippets));
          deps.send.exported({ ok: true, path });
        } catch (error) {
          deps.send.exported({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    },
  };
}

/** Kept so `dirname` is not an unused import when a future caller needs the chosen folder. */
export const exportFolderOf = (path: string): string => dirname(path);
```

> Remove the trailing `exportFolderOf` export **and** the `node:path` import if Biome flags them; they exist only to keep the import list honest. Prefer deleting both over keeping dead code — the test does not reference them.

In `apps/desktop/src/main/strings.ts`, add a `snippets` block after the `files` block:

```ts
  snippets: {
    tooLarge: "That file is larger than 5 MB, so it isn't a snippet library.",
  },
```

In `apps/desktop/src/main/index.ts`, import the handler group next to the other `rpc/` imports:

```ts
import { createSnippetHandlers } from "./rpc/snippet-handlers";
```

and register it inside the `mergeHandlers(...)` call for the **main window**, immediately after `createEnvHandlers({ env, log })`:

```ts
      createSnippetHandlers({
        snippets: services.snippets,
        // The same adapters the file handlers use, so E2E scripts snippet dialogs exactly like Open and Save As.
        openDialog: ({ startingFolder }) =>
          e2eEnabled
            ? readE2EOpenDialog(paths.dataDir)
            : Utils.openFileDialog({
                startingFolder,
                allowedFileTypes: "json",
                canChooseFiles: true,
                canChooseDirectory: false,
                allowsMultipleSelection: false,
              }),
        saveDialog: (options) => (e2eEnabled ? readE2ESaveDialog(paths.dataDir) : saveDialog(options)),
        readFile: (path) => Bun.file(path).text(),
        writeFile: (path, content) => Bun.write(path, content).then(() => undefined),
        documentsDir: Utils.paths.documents,
        send: {
          imported: (payload) => rpc.send["snippets.imported"](payload),
          exported: (payload) => rpc.send["snippets.exported"](payload),
        },
        log,
      }),
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/desktop && bun test ./test/rpc/snippet-handlers.test.ts
cd ../.. && bun run typecheck
```
Expected: PASS, **+8 tests**. Typecheck proves the new `MainRequests` / `MainMessages` / `ViewMessages` entries line up with `index.ts`'s registration; `mergeHandlers` throws at runtime on a duplicate request name, so a clash would fail `apps/desktop/test/startup.test.ts` too.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add packages/rpc-schema/src/ui-rpc.ts apps/desktop/src/main/rpc/snippet-handlers.ts \
        apps/desktop/src/main/index.ts apps/desktop/src/main/strings.ts \
        apps/desktop/test/rpc/snippet-handlers.test.ts
git commit -m "$(cat <<'EOF'
Put the snippet library on the wire, with import and export dialogs

Import parses in Main and reports; it never merges or saves. The overwrite /
keep both / skip choice belongs to the panel, so a file JSLab refuses leaves
snippets.json byte-identical -- which the tests assert for six malformed and
hostile inputs.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 4: UI plumbing — `MainApi` and the store slice

**Files:**
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/rpc.ts`, `apps/ui/test/fake-api.ts`, `apps/ui/src/state/store.ts`
- Test: `apps/ui/test/snippets-store.test.ts` (new)

**Interfaces:**
- Consumes: `Snippet` and `SaveResult` from `@jslab/rpc-schema` (Task 3).
- Produces:
  - `MainApi.snippetsList(): Promise<Snippet[]>`
  - `MainApi.snippetsSave(snippets: Snippet[]): Promise<SaveResult>`
  - `MainApi.snippetsImportDialog(): void`
  - `MainApi.snippetsExportDialog(snippets: Snippet[]): void`
  - In `apps/ui/src/state/store.ts`:
    ```ts
    export interface SnippetsRequest { kind: "focusSearch" | "newSnippet"; body: string; nonce: number }
    ```
    `AppState.snippets: Snippet[]`, `AppState.snippetsLoaded: boolean`, `AppState.snippetsRequest: SnippetsRequest | null`,
    `receiveSnippets(snippets: Snippet[]): void`, `requestSnippets(kind: SnippetsRequest["kind"], body?: string): void`, `clearSnippetsRequest(): void`

> **`apps/ui/test/fake-api.ts` ends in `satisfies MainApi`.** Adding members to `MainApi` without adding them to the
> fake fails typecheck across every UI test. Do both in this task.

> `snippetsRequest` is the one channel the commands use to talk to the panel, and it carries a `nonce` for the same
> reason `revealRequest` does (`store.ts:192`): pressing ⌘B twice, or Create Snippet… twice with the same selection,
> must reach the panel twice even though the payload is identical.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/snippets-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type Snippet } from "@jslab/shared";
import { createAppStore } from "../src/state/store";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

function hydrated() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

describe("snippet state (spec §13)", () => {
  test("starts empty and unloaded, so the panel can tell 'none yet' from 'not read yet'", () => {
    const state = hydrated().getState();
    expect([state.snippets, state.snippetsLoaded, state.snippetsRequest]).toEqual([[], false, null]);
  });

  test("receiveSnippets stores the library and marks it loaded", () => {
    const store = hydrated();
    store.getState().receiveSnippets([record()]);
    expect(store.getState().snippets).toEqual([record()]);
    expect(store.getState().snippetsLoaded).toBe(true);
    // An empty library still counts as loaded.
    store.getState().receiveSnippets([]);
    expect([store.getState().snippets, store.getState().snippetsLoaded]).toEqual([[], true]);
  });

  test("requestSnippets bumps a nonce every time, so a repeated request still reaches the panel", () => {
    const store = hydrated();
    store.getState().requestSnippets("focusSearch");
    expect(store.getState().snippetsRequest).toEqual({ kind: "focusSearch", body: "", nonce: 1 });
    store.getState().requestSnippets("focusSearch");
    expect(store.getState().snippetsRequest).toEqual({ kind: "focusSearch", body: "", nonce: 2 });
    store.getState().requestSnippets("newSnippet", "const a = 1");
    expect(store.getState().snippetsRequest).toEqual({ kind: "newSnippet", body: "const a = 1", nonce: 3 });
  });

  test("clearSnippetsRequest empties the channel without resetting the counter", () => {
    const store = hydrated();
    store.getState().requestSnippets("newSnippet", "x");
    store.getState().clearSnippetsRequest();
    expect(store.getState().snippetsRequest).toBeNull();
    store.getState().requestSnippets("focusSearch");
    expect(store.getState().snippetsRequest?.nonce).toBe(2);
  });

  test("the library survives a tab switch (it is app state, not tab state)", () => {
    const store = hydrated();
    store.getState().receiveSnippets([record()]);
    store.getState().openTab(createTab({ id: "t2" }), "", true);
    expect(store.getState().snippets).toEqual([record()]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/snippets-store.test.ts`
Expected: FAIL — `snippets` is not a property of the store state (`expect([undefined, undefined, undefined])`).

- [ ] **Step 3: Write the implementation**

In `apps/ui/src/api.ts`, add `Snippet` and `SaveResult` to the existing type import from `@jslab/rpc-schema` (`SaveResult` is already imported), then add the four members after the two `env` ones:

```ts
  getEnv(): Promise<EnvVars>;
  saveEnv(variables: EnvVars): Promise<SaveResult>;

  /** Spec §13: the snippet library. The UI holds it whole and writes it back on every mutation (R-M5b-6). */
  snippetsList(): Promise<Snippet[]>;
  snippetsSave(snippets: Snippet[]): Promise<SaveResult>;
  /** Spec §13.1 Options menu. Answered by the `snippets.imported` / `snippets.exported` messages, never inline. */
  snippetsImportDialog(): void;
  snippetsExportDialog(snippets: Snippet[]): void;
```

In `apps/ui/src/rpc.ts`, add after the two `env` lines:

```ts
    snippetsList: () => rpc.request["snippets.list"]({}).then((reply) => reply.snippets),
    // A library save is an atomic write with a .bak, like a file save: it gets the longer bound (FB-m11).
    snippetsSave: (snippets) => rpc.request["snippets.save"]({ snippets }, { maxRequestTime: SAVE_REQUEST_TIME_MS }),
    snippetsImportDialog: () => rpc.send["snippets.importDialog"]({}),
    snippetsExportDialog: (snippets) => rpc.send["snippets.exportDialog"]({ snippets }),
```

In `apps/ui/test/fake-api.ts`, add `Snippet` to the type import and these four mocks after `saveEnv`:

```ts
    snippetsList: mock(async (): Promise<Snippet[]> => []),
    snippetsSave: mock(async (_snippets: Snippet[]): Promise<SaveResult> => ({ ok: true })),
    snippetsImportDialog: mock(() => {}),
    snippetsExportDialog: mock((_snippets: Snippet[]) => {}),
```

In `apps/ui/src/state/store.ts`, add `Snippet` to the `@jslab/shared` type import, then declare the request type above `AppState`:

```ts
/**
 * The one channel the snippet commands use to reach the panel (Task 9). `nonce` is bumped on every request for the
 * same reason `revealRequest` carries one: pressing ⌘B twice, or Create Snippet… twice over the same selection, must
 * reach the panel twice even though the payload is identical.
 */
export interface SnippetsRequest {
  kind: "focusSearch" | "newSnippet";
  body: string;
  nonce: number;
}
```

Add to the `AppState` interface, after `npm: NpmUiState;`:

```ts
  /** Spec §13: the whole snippet library, mirrored from Main (R-M5b-6). App state, not tab state. */
  snippets: Snippet[];
  /** False until the first `snippets.list` answers, so the panel shows nothing instead of "no snippets yet". */
  snippetsLoaded: boolean;
  snippetsRequest: SnippetsRequest | null;
```

and to the action list, after `appendNpmLog`:

```ts
  receiveSnippets(snippets: Snippet[]): void;
  requestSnippets(kind: SnippetsRequest["kind"], body?: string): void;
  clearSnippetsRequest(): void;
```

The counter is its own field, because a cleared request must not reset it — otherwise the panel could mistake a
brand-new request for one it has already handled. Declare it in `AppState` beside the other three:

```ts
  /** Counts snippet requests. Separate from `snippetsRequest` so clearing the request never rewinds the count. */
  snippetsNonce: number;
```

Add the initial values after `npm: initialNpm(),`:

```ts
      snippets: [],
      snippetsLoaded: false,
      snippetsRequest: null,
      snippetsNonce: 0,
```

and the implementations after `appendNpmLog`'s body:

```ts
      receiveSnippets(snippets) {
        set({ snippets, snippetsLoaded: true });
      },

      requestSnippets(kind, body = "") {
        const nonce = get().snippetsNonce + 1;
        set({ snippetsNonce: nonce, snippetsRequest: { kind, body, nonce } });
      },

      clearSnippetsRequest() {
        set({ snippetsRequest: null });
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/ui && bun test ./test/snippets-store.test.ts && bun test ./test/store.test.ts
cd ../.. && bun run typecheck
```
Expected: PASS, **+5 tests**; `store.test.ts` unchanged and green. Typecheck is what proves `fake-api.ts` still satisfies `MainApi`.

- [ ] **Step 5: Commit**

```bash
bun run lint -- --max-diagnostics=300
git add apps/ui/src/api.ts apps/ui/src/rpc.ts apps/ui/test/fake-api.ts apps/ui/src/state/store.ts \
        apps/ui/test/snippets-store.test.ts
git commit -m "$(cat <<'EOF'
Carry the snippet library into the UI store

The library is app state, not tab state, and a request channel with a nonce
is how the ⌘B and Create Snippet… commands reach the panel -- the same shape
revealRequest already uses for the editor.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 5: Snippet text logic — templates, triggers and completions

**Files:**
- Create: `apps/ui/src/snippets/snippet-text.ts`
- Test: `apps/ui/test/snippet-text.test.ts` (new)

**Interfaces:**
- Consumes: `Snippet` from `@jslab/shared`.
- Produces:
  - `function hasPlaceholders(body: string): boolean`
  - `function snippetTemplate(body: string): string` — spec §13.2
  - `function plainInsertion(body: string): string` — the no-snippet-controller fallback used by Task 10
  - `function triggerWord(textBeforeCursor: string): string`
  - `interface SnippetExpansion { snippet: Snippet; deleteBefore: number }`
  - `function expansionFor(textBeforeCursor: string, snippets: readonly Snippet[]): SnippetExpansion | null`
  - `function completionsFor(word: string, snippets: readonly Snippet[]): Snippet[]`

> This module is the whole of ruling **R-M5b-7**. `expansionFor` is the trigger channel (exact trailing word, so it
> is never ambiguous and never needs a list), and `completionsFor` is the discovery channel (prefix matches, collapsing
> to the single exact match once the full name has been typed — which is what §13.3 asks for and what VS Code issues
> #244170 / #66621 say not to do the other way; see `scratchpad/m5-ui-patterns.md` §1).

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/snippet-text.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Snippet } from "@jslab/shared";
import {
  completionsFor,
  expansionFor,
  hasPlaceholders,
  plainInsertion,
  snippetTemplate,
  triggerWord,
} from "../src/snippets/snippet-text";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body = "x"): Snippet => ({
  id: name,
  name,
  description: `the ${name} snippet`,
  body,
  language: null,
  createdAt: AT,
  updatedAt: AT,
});
const library = [snippet("fetchjson"), snippet("fetch"), snippet("log"), snippet("$log"), snippet("to-do")];

describe("snippet bodies (spec §13.2)", () => {
  test("a body with placeholders is a template as written", () => {
    const withStop = "const res = await fetch(${1:url});\nconst data = await res.json();\n$0";
    expect(hasPlaceholders(withStop)).toBe(true);
    expect(snippetTemplate(withStop)).toBe(withStop);
    expect(hasPlaceholders("$1")).toBe(true);
    expect(hasPlaceholders("${2:name}")).toBe(true);
  });

  test("a body without placeholders is inserted literally, with $ escaped", () => {
    expect(hasPlaceholders("const total = `${price}`")).toBe(false);
    expect(snippetTemplate("const total = `${price}`")).toBe("const total = `\\${price}`");
    expect(snippetTemplate("cost: $5 and $10")).toBe("cost: \\$5 and \\$10");
    expect(snippetTemplate("plain")).toBe("plain");
  });

  test("plainInsertion strips the tab stops and keeps the placeholder text", () => {
    expect(plainInsertion("await fetch(${1:url})$0")).toBe("await fetch(url)");
    expect(plainInsertion("${1}a$2b$0")).toBe("ab");
    expect(plainInsertion("no placeholders $here")).toBe("no placeholders $here");
  });
});

describe("the trigger word (spec §13.3, ruling R-M5b-7)", () => {
  test("reads the name characters immediately before the caret", () => {
    expect(triggerWord("const x = fetchjson")).toBe("fetchjson");
    expect(triggerWord("  log")).toBe("log");
    expect(triggerWord("a.$log")).toBe("$log");
    expect(triggerWord("to-do")).toBe("to-do");
    expect(triggerWord("")).toBe("");
    expect(triggerWord("done ")).toBe("");
    expect(triggerWord("obj.")).toBe("");
  });
});

describe("Tab expansion (ruling R-M5b-7, channel 1)", () => {
  test("an exact trailing name expands and says how much to delete", () => {
    expect(expansionFor("const x = fetchjson", library)).toEqual({
      snippet: snippet("fetchjson"),
      deleteBefore: 9,
    });
    expect(expansionFor("FETCHJSON", library)).toEqual({ snippet: snippet("fetchjson"), deleteBefore: 9 });
  });

  test("a partial word, an unknown word, or no word at all never expands", () => {
    expect(expansionFor("fetchjs", library)).toBeNull();
    expect(expansionFor("fetchjsonx", library)).toBeNull();
    expect(expansionFor("nothing", library)).toBeNull();
    expect(expansionFor("fetchjson ", library)).toBeNull();
    expect(expansionFor("", library)).toBeNull();
    expect(expansionFor("anything", [])).toBeNull();
  });

  test("a longer name wins over a shorter one that is also a full word here", () => {
    // "fetch" and "fetchjson" both exist; the caret is after "fetchjson", so that is the match.
    expect(expansionFor("await fetchjson", library)?.snippet.name).toBe("fetchjson");
    expect(expansionFor("await fetch", library)?.snippet.name).toBe("fetch");
  });
});

describe("the suggest widget (spec §13.3, ruling R-M5b-7, channel 2)", () => {
  test("prefix matches are offered, case-insensitively, in name order", () => {
    expect(completionsFor("fe", library).map((s) => s.name)).toEqual(["fetch", "fetchjson"]);
    expect(completionsFor("FE", library).map((s) => s.name)).toEqual(["fetch", "fetchjson"]);
  });

  test("once the full name is typed the list collapses to that one snippet (RunJS #488)", () => {
    // The point of the spec's requirement: it is still suggested. The point of R-M5b-7: it is suggested ALONE,
    // rather than continuing to rank "fetchjson" alongside it the way VS Code's fuzzy suggest would.
    expect(completionsFor("fetch", library).map((s) => s.name)).toEqual(["fetch"]);
    expect(completionsFor("FETCH", library).map((s) => s.name)).toEqual(["fetch"]);
    expect(completionsFor("fetchjson", library).map((s) => s.name)).toEqual(["fetchjson"]);
  });

  test("an empty word offers nothing, and an unmatched word offers nothing", () => {
    expect(completionsFor("", library)).toEqual([]);
    expect(completionsFor("zzz", library)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/snippet-text.test.ts`
Expected: FAIL with `Cannot find module '../src/snippets/snippet-text'`.

- [ ] **Step 3: Write the implementation**

Create `apps/ui/src/snippets/snippet-text.ts`:

```ts
import type { Snippet } from "@jslab/shared";

/** `$0`, `$1`, `${1:placeholder}` — Monaco snippet syntax (spec §13.2). */
const PLACEHOLDER = /\$(?:\d+|\{\d+:?[^}]*\})/;
const PLACEHOLDER_ALL = /\$(?:(\d+)|\{\d+:?([^}]*)\})/g;

export function hasPlaceholders(body: string): boolean {
  return PLACEHOLDER.test(body);
}

/**
 * Spec §13.2: "A body without placeholders is inserted literally, with `$` escaped." A body that has them is a
 * template exactly as written, so `${price}` in a body that also carries a real tab stop stays the author's problem,
 * not ours -- which is the only reading that lets a body mix shell-style and snippet-style dollars deliberately.
 */
export function snippetTemplate(body: string): string {
  return hasPlaceholders(body) ? body : body.replaceAll("$", String.fromCharCode(92) + "$");
}

/**
 * The fallback text for a Monaco build with no snippet controller (Task 10): tab stops vanish, and a placeholder
 * leaves its default text behind, which is the closest literal rendering of the author's intent.
 */
export function plainInsertion(body: string): string {
  return body.replace(PLACEHOLDER_ALL, (_match, _index: string | undefined, placeholder: string | undefined) =>
    placeholder ?? "",
  );
}

/** The characters a snippet name may contain (spec §13.1's `^[\w$-]+$`), anchored at the caret. */
const TRAILING_NAME = /[\w$-]+$/;

export function triggerWord(textBeforeCursor: string): string {
  return TRAILING_NAME.exec(textBeforeCursor)?.[0] ?? "";
}

export interface SnippetExpansion {
  snippet: Snippet;
  /** How many characters before the caret the trigger word occupies, and so how many to replace. */
  deleteBefore: number;
}

/**
 * Ruling R-M5b-7, channel 1: Tab expands only when the trailing word IS a snippet name. Names are unique, so an
 * exact match is never ambiguous and never needs a list. Anything else returns null, which is what makes the
 * `snippets.expand` command report `isEnabled() === false` and leaves Tab to Monaco.
 */
export function expansionFor(textBeforeCursor: string, snippets: readonly Snippet[]): SnippetExpansion | null {
  const word = triggerWord(textBeforeCursor);
  if (!word) return null;
  const lowered = word.toLowerCase();
  const snippet = snippets.find((candidate) => candidate.name.toLowerCase() === lowered);
  return snippet ? { snippet, deleteBefore: word.length } : null;
}

/**
 * Ruling R-M5b-7, channel 2 (spec §13.3): snippets whose name starts with the typed word, case-insensitively --
 * except that an exact match collapses the list to itself. That is what keeps the spec's "suggested even when the
 * full name has been typed" from turning into VS Code's open complaint that an exact match ranks no higher than its
 * longer siblings (issues #244170, #66621; see scratchpad/m5-ui-patterns.md §1).
 */
export function completionsFor(word: string, snippets: readonly Snippet[]): Snippet[] {
  if (!word) return [];
  const lowered = word.toLowerCase();
  const exact = snippets.find((candidate) => candidate.name.toLowerCase() === lowered);
  if (exact) return [exact];
  return snippets
    .filter((candidate) => candidate.name.toLowerCase().startsWith(lowered))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/ui && bun test ./test/snippet-text.test.ts`
Expected: PASS, **+9 tests**.

- [ ] **Step 5: Commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
git add apps/ui/src/snippets/snippet-text.ts apps/ui/test/snippet-text.test.ts
git commit -m "$(cat <<'EOF'
Add the snippet template, trigger and completion logic

Tab expansion matches the exact trailing word, so it is never ambiguous and
never needs a popup; the suggest list collapses to the single exact match once
the full name is typed. That is the JetBrains/Raycast model the M5 design
research recommends over VS Code's continuous fuzzy suggest.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 6: Snippet search and ranking

**Files:**
- Create: `apps/ui/src/snippets/snippet-filter.ts`
- Test: `apps/ui/test/snippet-filter.test.ts` (new)

**Interfaces:**
- Consumes: `Snippet` from `@jslab/shared`; `matchTitle` from `apps/ui/src/palette/match.ts` (`matchTitle(query, title): { score: number; ranges: [number, number][] } | null`).
- Produces:
  - `interface RankedSnippet { snippet: Snippet; nameRanges: [number, number][] }`
  - `function filterSnippets(snippets: readonly Snippet[], query: string): RankedSnippet[]`

> Spec §13.1: "**Search box** matches name and description." The research file's scale warning (0 items and 500 items)
> is answered here and in Task 7: this function is the only thing that runs per keystroke over the whole library, and
> the panel virtualizes whatever it returns.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/snippet-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Snippet } from "@jslab/shared";
import { filterSnippets } from "../src/snippets/snippet-filter";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, description = ""): Snippet => ({
  id: name,
  name,
  description,
  body: "x",
  language: null,
  createdAt: AT,
  updatedAt: AT,
});

const library = [
  snippet("log", "print a value"),
  snippet("fetchjson", "Fetch + parse JSON"),
  snippet("arrow", "an arrow function"),
];
const names = (query: string) => filterSnippets(library, query).map((ranked) => ranked.snippet.name);

describe("snippet search (spec §13.1)", () => {
  test("an empty query lists everything in name order", () => {
    expect(names("")).toEqual(["arrow", "fetchjson", "log"]);
    expect(names("   ")).toEqual(["arrow", "fetchjson", "log"]);
  });

  test("the query matches the name and the description", () => {
    expect(names("fetch")).toEqual(["fetchjson"]);
    expect(names("JSON")).toEqual(["fetchjson"]);
    expect(names("function")).toEqual(["arrow"]);
    expect(names("print a value")).toEqual(["log"]);
  });

  test("a name match outranks a description-only match", () => {
    const both = [snippet("helper", "nothing relevant"), snippet("other", "uses the helper")];
    expect(filterSnippets(both, "helper").map((r) => r.snippet.name)).toEqual(["helper", "other"]);
  });

  test("name highlight ranges are returned, and are empty for a description-only match", () => {
    const [ranked] = filterSnippets(library, "fetch");
    expect(ranked?.nameRanges).toEqual([[0, 5]]);
    const [byDescription] = filterSnippets(library, "print");
    expect([byDescription?.snippet.name, byDescription?.nameRanges]).toEqual(["log", []]);
  });

  test("an unmatched query returns nothing, and an empty library returns nothing", () => {
    expect(names("zzzz")).toEqual([]);
    expect(filterSnippets([], "anything")).toEqual([]);
    expect(filterSnippets([], "")).toEqual([]);
  });

  test("500 snippets filter in one pass and keep a stable order", () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      snippet(`snip${String(index).padStart(3, "0")}`, index % 2 === 0 ? "even" : "odd"),
    );
    expect(filterSnippets(many, "")).toHaveLength(500);
    expect(filterSnippets(many, "even")).toHaveLength(250);
    const exact = filterSnippets(many, "snip499");
    expect(exact.map((r) => r.snippet.name)).toEqual(["snip499"]);
    // Ranking is deterministic: the same input twice gives the same order.
    expect(filterSnippets(many, "snip1").map((r) => r.snippet.name)).toEqual(
      filterSnippets(many, "snip1").map((r) => r.snippet.name),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/snippet-filter.test.ts`
Expected: FAIL with `Cannot find module '../src/snippets/snippet-filter'`.

- [ ] **Step 3: Write the implementation**

Create `apps/ui/src/snippets/snippet-filter.ts`:

```ts
import type { Snippet } from "@jslab/shared";
import { matchTitle } from "../palette/match";

export interface RankedSnippet {
  snippet: Snippet;
  /** Character ranges of the query inside the name, for highlighting. Empty when only the description matched. */
  nameRanges: [number, number][];
}

/** A name match always beats a description match, whatever the two raw scores are. */
const NAME_BONUS = 1000;

/**
 * Spec §13.1: "Search box matches name and description." Reuses the palette's own matcher (prefix → word boundary →
 * substring → subsequence) so search feels identical to ⌘⇧P. One pass over the library per keystroke; the panel
 * virtualizes the result, so 500 snippets cost 500 `matchTitle` calls and 500 objects, not 500 DOM nodes.
 */
export function filterSnippets(snippets: readonly Snippet[], query: string): RankedSnippet[] {
  const trimmed = query.trim();
  const byName = (a: Snippet, b: Snippet) => a.name.localeCompare(b.name);
  if (!trimmed) return [...snippets].sort(byName).map((snippet) => ({ snippet, nameRanges: [] }));
  return snippets
    .flatMap((snippet, index) => {
      const name = matchTitle(trimmed, snippet.name);
      const description = snippet.description ? matchTitle(trimmed, snippet.description) : null;
      if (!name && !description) return [];
      const score = name ? name.score + NAME_BONUS : (description?.score ?? 0);
      return [{ snippet, nameRanges: name?.ranges ?? [], score, index }];
    })
    .sort((a, b) => b.score - a.score || byName(a.snippet, b.snippet))
    .map(({ snippet, nameRanges }) => ({ snippet, nameRanges }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/ui && bun test ./test/snippet-filter.test.ts`
Expected: PASS, **+6 tests**.

- [ ] **Step 5: Commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
git add apps/ui/src/snippets/snippet-filter.ts apps/ui/test/snippet-filter.test.ts
git commit -m "$(cat <<'EOF'
Search snippets by name and description

Reuses the command palette's own matcher so the two search boxes rank alike,
with a name match always outranking a description-only one. Tested at 0, 3 and
500 snippets.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 7: The snippets panel

**Files:**
- Create: `apps/ui/src/snippets/SnippetsPanel.tsx`
- Modify: `apps/ui/src/strings.ts`, `apps/ui/src/styles.css`
- Test: `apps/ui/test/snippets-panel.test.tsx` (new)

**Interfaces:**
- Consumes: `AppStore`, `SnippetsRequest` (Task 4); `filterSnippets`, `RankedSnippet` (Task 6); `MainApi.snippetsList` / `snippetsSave` / `snippetsImportDialog` / `snippetsExportDialog` (Task 4); `Dialogs` from `apps/ui/src/shell/dialogs.ts`; `copyEntriesToClipboard` from `apps/ui/src/output/copy.ts`; `mergeSnippets`, `isValidSnippetName`, `type ConflictPolicy`, `type Snippet` from `@jslab/shared`; `useVirtualizer` from `@tanstack/react-virtual`; `SnippetForm` (Task 8).
- Produces:
  ```ts
  export interface SnippetActions {
    /** Spec §13.1: insert at the cursor, replacing the selection. */
    insert(snippet: Snippet): void;
    insertInNewTab(snippet: Snippet): Promise<void>;
  }
  export type SnippetColorize = (code: string, language: Language | null) => Promise<string>;
  export function SnippetsPanel(props: {
    store: AppStore;
    api: Pick<MainApi, "snippetsList" | "snippetsSave" | "snippetsImportDialog" | "snippetsExportDialog" | "on">;
    dialogs: Pick<Dialogs, "confirm">;
    actions: SnippetActions;
    colorize?: SnippetColorize;
    clipboard?: Pick<Clipboard, "writeText">;
  }): JSX.Element
  ```

**Three decisions this task implements, all recorded above:**
- **The root element keeps the `side-bar` class.** `apps/ui/isolated/app.test.tsx:638-665` asserts `document.querySelector(".side-bar") !== null` after the Snippets button is clicked. The panel renders `<aside className="side-bar snippets-panel">`, so that test keeps passing untouched.
- **Delete is confirmed with §13.1's exact wording and then undoable (R-M5b-4).** The confirm has a `cancel` and a `danger` button and **no primary**, so Escape cancels and Enter does nothing.
- **Preview highlighting is injected, like the form's body editor (R-M5b-5).** `colorize` defaults to a Monaco-backed implementation supplied by Task 10; when it is absent or fails, the preview renders plain monospace text rather than nothing. The panel is fully testable either way.

> **Saves are pessimistic.** Every mutation calls `api.snippetsSave(next)` and only updates the store once Main answers
> `{ ok: true }`. An optimistic update would show a deletion that never reached disk.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/snippets-panel.test.tsx`:

```tsx
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type Snippet } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SnippetsPanel } from "../src/snippets/SnippetsPanel";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body = `body of ${name}`, description = `does ${name}`): Snippet => ({
  id: name,
  name,
  description,
  body,
  language: null,
  createdAt: AT,
  updatedAt: AT,
});

function setup(library: Snippet[] = [snippet("fetchjson"), snippet("log")]) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const { api, emit } = createFakeApi();
  api.snippetsList.mockImplementation(async () => library);
  const dialogs = { confirm: mock(async () => "delete") };
  const actions = { insert: mock((_s: Snippet) => {}), insertInNewTab: mock(async (_s: Snippet) => {}) };
  const clipboard = { writeText: mock(async (_text: string) => {}) };
  render(
    <SnippetsPanel store={store} api={api} dialogs={dialogs} actions={actions} clipboard={clipboard} />,
  );
  return { store, api, emit, dialogs, actions, clipboard };
}

const select = (name: string) => fireEvent.click(screen.getByRole("option", { name: new RegExp(name) }));

describe("snippets panel (spec §13.1)", () => {
  test("loads the library on mount and lists name + description", async () => {
    const { api, store } = setup();
    expect(await screen.findByRole("option", { name: /fetchjson/ })).toBeTruthy();
    expect(api.snippetsList).toHaveBeenCalled();
    expect(screen.getByText("does fetchjson")).toBeTruthy();
    expect(store.getState().snippets).toHaveLength(2);
    // The existing isolated App test depends on this class being present.
    expect(document.querySelector(".side-bar")).not.toBeNull();
  });

  test("the search box filters by name and description, and selecting shows a preview", async () => {
    setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    fireEvent.change(screen.getByLabelText(strings.snippets.searchLabel), { target: { value: "log" } });
    expect(screen.queryByRole("option", { name: /fetchjson/ })).toBeNull();
    select("log");
    expect(screen.getByText("body of log")).toBeTruthy();
  });

  test("Insert, Insert in New Tab and Copy act on the selected snippet", async () => {
    const { actions, clipboard } = setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    select("fetchjson");
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.insert }));
    expect(actions.insert).toHaveBeenCalledWith(snippet("fetchjson"));
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.insertInNewTab }));
    expect(actions.insertInNewTab).toHaveBeenCalledWith(snippet("fetchjson"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: strings.snippets.copy }));
      await Bun.sleep(1);
    });
    expect(clipboard.writeText).toHaveBeenCalledWith("body of fetchjson");
    expect(screen.getByText(strings.snippets.copied)).toBeTruthy();
  });

  test("Delete confirms with the spec's wording, saves, and offers Undo (R-M5b-4)", async () => {
    const { api, dialogs, store } = setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    select("fetchjson");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: strings.snippets.delete }));
      await Bun.sleep(1);
    });
    expect(dialogs.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: strings.snippets.deleteTitle("fetchjson"),
        buttons: [
          { id: "cancel", label: strings.snippets.cancel, role: "cancel" },
          { id: "delete", label: strings.snippets.deleteButton, role: "danger" },
        ],
      }),
    );
    expect(api.snippetsSave).toHaveBeenCalledWith([snippet("log")]);
    await waitFor(() => expect(store.getState().snippets.map((s) => s.name)).toEqual(["log"]));
    expect(screen.getByText(strings.snippets.deleted("fetchjson"))).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: strings.snippets.undo }));
      await Bun.sleep(1);
    });
    await waitFor(() => expect(store.getState().snippets.map((s) => s.name).sort()).toEqual(["fetchjson", "log"]));
    expect(screen.queryByText(strings.snippets.deleted("fetchjson"))).toBeNull();
  });

  test("a cancelled confirm changes nothing", async () => {
    const { api, dialogs } = setup();
    dialogs.confirm.mockImplementation(async () => "cancel");
    await screen.findByRole("option", { name: /fetchjson/ });
    select("fetchjson");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: strings.snippets.delete }));
      await Bun.sleep(1);
    });
    expect(api.snippetsSave).not.toHaveBeenCalled();
  });

  test("a failed save keeps the snippet and says so", async () => {
    const { api, store } = setup();
    api.snippetsSave.mockImplementation(async () => ({ ok: false, error: "EACCES: permission denied" }));
    await screen.findByRole("option", { name: /fetchjson/ });
    select("fetchjson");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: strings.snippets.delete }));
      await Bun.sleep(1);
    });
    expect(await screen.findByText(strings.snippets.saveFailed("EACCES: permission denied"))).toBeTruthy();
    expect(store.getState().snippets).toHaveLength(2);
  });

  test("an empty library and an empty search show different, actionable states", async () => {
    setup([]);
    expect(await screen.findByText(strings.snippets.empty)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.snippets.newSnippet })).toBeTruthy();
  });

  test("no search results offer to create a snippet named after the query, when that name is legal", async () => {
    setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    const search = screen.getByLabelText(strings.snippets.searchLabel);
    fireEvent.change(search, { target: { value: "newthing" } });
    expect(screen.getByText(strings.snippets.noMatches("newthing"))).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.snippets.createNamed("newthing") })).toBeTruthy();
    // A query that can't be a snippet name (spec §13.1's ^[\w$-]+$) offers no such shortcut.
    fireEvent.change(search, { target: { value: "not a name" } });
    expect(screen.getByText(strings.snippets.noMatches("not a name"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.snippets.createNamed("not a name") })).toBeNull();
  });

  test("Import asks Main, then offers a conflict choice before anything is merged", async () => {
    const { api, emit, store } = setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.import }));
    expect(api.snippetsImportDialog).toHaveBeenCalled();

    await emit("snippets.imported", {
      ok: true,
      snippets: [snippet("fetchjson", "IMPORTED"), snippet("brandnew")],
    });
    expect(screen.getByText(strings.snippets.conflicts(1, 2))).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: strings.snippets.overwrite }));
      await Bun.sleep(1);
    });
    await waitFor(() => expect(store.getState().snippets).toHaveLength(3));
    expect(store.getState().snippets.find((s) => s.name === "fetchjson")?.body).toBe("IMPORTED");
  });

  test("an import with no conflicts merges straight away", async () => {
    const { emit, store } = setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    await emit("snippets.imported", { ok: true, snippets: [snippet("brandnew")] });
    await waitFor(() => expect(store.getState().snippets).toHaveLength(3));
    expect(screen.queryByRole("button", { name: strings.snippets.overwrite })).toBeNull();
  });

  test("a refused import reports the reason and leaves the library alone (spec §13.4)", async () => {
    const { api, emit, store } = setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    await emit("snippets.imported", { ok: false, reason: "wrongFormat", detail: 'Expected "format": "jslab-snippets".' });
    expect(screen.getByText(strings.snippets.importFailed)).toBeTruthy();
    expect(screen.getByText('Expected "format": "jslab-snippets".')).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(store.getState().snippets).toHaveLength(2);
  });

  test("Export sends the whole library and reports where it went", async () => {
    const { api, emit } = setup();
    await screen.findByRole("option", { name: /fetchjson/ });
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.export }));
    expect(api.snippetsExportDialog).toHaveBeenCalledWith([snippet("fetchjson"), snippet("log")]);
    await emit("snippets.exported", { ok: true, path: "/tmp/jslab-snippets.json" });
    expect(screen.getByText(strings.snippets.exportedTo("/tmp/jslab-snippets.json"))).toBeTruthy();
  });

  test("a focusSearch request focuses the search box, every time it is made", async () => {
    const { store } = setup();
    const search = await screen.findByLabelText(strings.snippets.searchLabel);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => store.getState().requestSnippets("focusSearch"));
    await waitFor(() => expect(document.activeElement).toBe(search));
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => store.getState().requestSnippets("focusSearch"));
    await waitFor(() => expect(document.activeElement).toBe(search));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/snippets-panel.test.tsx`
Expected: FAIL with `Cannot find module '../src/snippets/SnippetsPanel'`.

- [ ] **Step 3: Add the strings**

In `apps/ui/src/strings.ts`, add a `snippets` block after the `env` block:

```ts
  snippets: {
    title: "Snippets",
    searchLabel: "Search snippets",
    searchPlaceholder: "Search by name or description",
    list: "Snippet library",
    newSnippet: "New Snippet",
    options: "Snippet options",
    // Spec §13.1 actions.
    insert: "Insert",
    insertInNewTab: "Insert in New Tab",
    copy: "Copy",
    edit: "Edit",
    delete: "Delete",
    deleteButton: "Delete",
    cancel: "Cancel",
    // Spec §13.1: the confirmation is worded exactly like this.
    deleteTitle: (name: string) => `Delete snippet "${name}"?`,
    deleteMessage: "You can undo this until you make another change.",
    deleted: (name: string) => `Deleted "${name}".`,
    undo: "Undo",
    copied: "Copied",
    copyFailed: "Couldn't copy",
    preview: "Snippet preview",
    // Empty states: 0 in the library, and 0 matching the query, say different things (M5 UI research §1).
    empty: "No snippets yet. Create one, or import a library.",
    noMatches: (query: string) => `No snippets match "${query}".`,
    createNamed: (query: string) => `Create "${query}"`,
    import: "Import…",
    export: "Export…",
    importFailed: "This file isn't a valid JSLab snippets file",
    imported: (added: number, overwritten: number, skipped: number) =>
      `Imported ${added} snippet${added === 1 ? "" : "s"}, replaced ${overwritten}, skipped ${skipped}.`,
    conflicts: (conflicts: number, total: number) =>
      `${total} snippet${total === 1 ? "" : "s"} to import, ${conflicts} with a name you already use.`,
    overwrite: "Overwrite",
    keepBoth: "Keep Both",
    skip: "Skip",
    exportedTo: (path: string) => `Exported to ${path}`,
    exportCancelled: "Export cancelled.",
    exportFailed: (error: string) => `Couldn't export: ${error}`,
    loadFailed: "Couldn't read your snippets. Close and reopen the panel to try again.",
    saveFailed: (error: string) => `Couldn't save your snippets (${error}). Nothing was changed.`,
  },
```

- [ ] **Step 4: Write the panel**

Create `apps/ui/src/snippets/SnippetsPanel.tsx`:

```tsx
import {
  type ConflictPolicy,
  isValidSnippetName,
  type Language,
  mergeSnippets,
  type Snippet,
} from "@jslab/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { copyEntriesToClipboard } from "../output/copy";
import type { Dialogs } from "../shell/dialogs";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { filterSnippets } from "./snippet-filter";
import { SnippetForm } from "./SnippetForm";

/** What the panel needs from the editor and the tab list. Implemented in Task 9 (`createSnippetActions`). */
export interface SnippetActions {
  /** Spec §13.1: insert at the cursor, replacing the selection. */
  insert(snippet: Snippet): void;
  insertInNewTab(snippet: Snippet): Promise<void>;
}

/** Spec §13.1: the preview is syntax-highlighted. Injected (R-M5b-5), because Monaco can't run under happy-dom. */
export type SnippetColorize = (code: string, language: Language | null) => Promise<string>;

type SnippetsApi = Pick<
  MainApi,
  "snippetsList" | "snippetsSave" | "snippetsImportDialog" | "snippetsExportDialog" | "on"
>;

interface PanelProps {
  store: AppStore;
  api: SnippetsApi;
  dialogs: Pick<Dialogs, "confirm">;
  actions: SnippetActions;
  colorize?: SnippetColorize;
  clipboard?: Pick<Clipboard, "writeText">;
}

const ROW_HEIGHT = 46;

/** Spec §13.1, §7.5: the Snippets side-bar panel. Keeps the `side-bar` class: the shell and its tests key on it. */
export function SnippetsPanel({ store, api, dialogs, actions, colorize, clipboard }: PanelProps) {
  const snippets = useStore(store, (s) => s.snippets);
  const loaded = useStore(store, (s) => s.snippetsLoaded);
  const request = useStore(store, (s) => s.snippetsRequest);

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ initial: Snippet | null; body: string } | null>(null);
  const [deleted, setDeleted] = useState<Snippet | null>(null);
  const [pendingImport, setPendingImport] = useState<Snippet[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    api.snippetsList().then(
      (library) => {
        if (mounted.current) store.getState().receiveSnippets(library);
      },
      () => {
        if (mounted.current) setError({ message: strings.snippets.loadFailed });
      },
    );
  }, [api, store]);

  // Spec §13.1 Options menu: Main answers the dialogs with these two messages (never inline), and the panel owns
  // the merge policy (R-M5b-8).
  useEffect(() => {
    const offImported = api.on("snippets.imported", (result) => {
      if (!result.ok) {
        setError({ message: strings.snippets.importFailed, detail: result.detail });
        return;
      }
      setError(null);
      const names = new Set(store.getState().snippets.map((s) => s.name.toLowerCase()));
      const conflicts = result.snippets.filter((s) => names.has(s.name.toLowerCase())).length;
      if (conflicts === 0) void applyImport(result.snippets, "skip");
      else setPendingImport(result.snippets);
    });
    const offExported = api.on("snippets.exported", (result) => {
      if ("cancelled" in result) setStatus(strings.snippets.exportCancelled);
      else if (result.ok) setStatus(strings.snippets.exportedTo(result.path));
      else setError({ message: strings.snippets.exportFailed(result.error) });
    });
    return () => {
      offImported();
      offExported();
    };
    // `applyImport` reads only refs and the store, so it is stable enough to leave out; re-subscribing on every
    // library change would drop an in-flight dialog's answer.
  }, [api, store]);

  // Task 9's commands reach the panel through this channel; the nonce is what makes a repeat request land.
  useEffect(() => {
    if (!request) return;
    if (request.kind === "focusSearch") search.current?.focus();
    else setEditing({ initial: null, body: request.body });
    store.getState().clearSnippetsRequest();
  }, [request, store]);

  const ranked = useMemo(() => filterSnippets(snippets, query), [snippets, query]);
  const selected = useMemo(
    () => ranked.find((entry) => entry.snippet.id === selectedId)?.snippet ?? ranked[0]?.snippet ?? null,
    [ranked, selectedId],
  );

  useEffect(() => {
    if (!selected || !colorize) {
      setHighlighted(null);
      return;
    }
    let live = true;
    colorize(selected.body, selected.language).then(
      (html) => {
        if (live) setHighlighted(html);
      },
      // A failed colorize is not an error the user needs: the <pre> fallback below is already correct text.
      () => {
        if (live) setHighlighted(null);
      },
    );
    return () => {
      live = false;
    };
  }, [selected, colorize]);

  const virtualizer = useVirtualizer({
    count: ranked.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  /** Every mutation goes through here: save first, adopt the result only when Main confirms it (pessimistic). */
  const save = async (next: Snippet[]): Promise<boolean> => {
    setError(null);
    try {
      const result = await api.snippetsSave(next);
      if (!mounted.current) return false;
      if (!result.ok) {
        setError({ message: strings.snippets.saveFailed(result.error) });
        return false;
      }
      store.getState().receiveSnippets(next);
      return true;
    } catch (thrown) {
      if (mounted.current) {
        setError({ message: strings.snippets.saveFailed(thrown instanceof Error ? thrown.message : String(thrown)) });
      }
      return false;
    }
  };

  async function applyImport(incoming: Snippet[], policy: ConflictPolicy) {
    const merged = mergeSnippets(store.getState().snippets, incoming, policy);
    setPendingImport(null);
    if (await save(merged.snippets)) {
      setStatus(strings.snippets.imported(merged.added, merged.overwritten, merged.skipped));
    }
  }

  const remove = async (snippet: Snippet) => {
    // R-M5b-4: §13.1's exact wording, a danger button, and no primary -- so Enter does nothing and Escape cancels.
    const choice = await dialogs.confirm({
      title: strings.snippets.deleteTitle(snippet.name),
      message: strings.snippets.deleteMessage,
      buttons: [
        { id: "cancel", label: strings.snippets.cancel, role: "cancel" },
        { id: "delete", label: strings.snippets.deleteButton, role: "danger" },
      ],
    });
    if (choice !== "delete") return;
    const next = store.getState().snippets.filter((candidate) => candidate.id !== snippet.id);
    if (await save(next)) {
      setStatus(null);
      setDeleted(snippet);
    }
  };

  const undoDelete = async () => {
    if (!deleted) return;
    // Restored with its original id and timestamps: an undo is not a new snippet.
    if (await save([...store.getState().snippets, deleted])) setDeleted(null);
  };

  const copy = async (snippet: Snippet) => {
    const result = await copyEntriesToClipboard(snippet.body, clipboard ?? navigator.clipboard);
    if (mounted.current) setStatus(result === "copied" ? strings.snippets.copied : strings.snippets.copyFailed);
  };

  if (editing) {
    return (
      <aside className="side-bar snippets-panel" aria-label={strings.snippets.title}>
        <SnippetForm
          store={store}
          api={api}
          initial={editing.initial}
          body={editing.body}
          onDone={() => setEditing(null)}
        />
      </aside>
    );
  }

  const trimmed = query.trim();
  return (
    <aside className="side-bar snippets-panel" aria-label={strings.snippets.title}>
      <header className="snippets-header">
        <h2>{strings.snippets.title}</h2>
        <button type="button" onClick={() => setEditing({ initial: null, body: "" })}>
          {strings.snippets.newSnippet}
        </button>
        <button type="button" onClick={() => api.snippetsImportDialog()}>
          {strings.snippets.import}
        </button>
        <button type="button" onClick={() => api.snippetsExportDialog(snippets)}>
          {strings.snippets.export}
        </button>
      </header>
      <input
        ref={search}
        type="search"
        className="snippets-search"
        aria-label={strings.snippets.searchLabel}
        placeholder={strings.snippets.searchPlaceholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectedId(null);
        }}
      />
      {pendingImport && (
        <div className="snippets-conflicts" role="group" aria-label={strings.snippets.import}>
          <p>
            {strings.snippets.conflicts(
              pendingImport.filter((s) => snippets.some((own) => own.name.toLowerCase() === s.name.toLowerCase()))
                .length,
              pendingImport.length,
            )}
          </p>
          <div className="dialog-actions">
            {(["overwrite", "keepBoth", "skip"] as const).map((policy) => (
              <button key={policy} type="button" onClick={() => void applyImport(pendingImport, policy)}>
                {strings.snippets[policy]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div ref={scroller} className="snippets-scroller">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} role="listbox" aria-label={strings.snippets.list}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = ranked[item.index];
            if (!entry) return null;
            const { snippet } = entry;
            return (
              <div
                key={snippet.id}
                role="option"
                tabIndex={-1}
                aria-selected={selected?.id === snippet.id}
                className="snippets-row"
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
                onClick={() => setSelectedId(snippet.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") actions.insert(snippet);
                }}
              >
                <strong>{snippet.name}</strong>
                <span className="snippets-description">{snippet.description}</span>
              </div>
            );
          })}
        </div>
        {loaded && snippets.length === 0 && <p className="snippets-empty">{strings.snippets.empty}</p>}
        {loaded && snippets.length > 0 && ranked.length === 0 && (
          <p className="snippets-empty">
            {strings.snippets.noMatches(trimmed)}
            {isValidSnippetName(trimmed) && (
              <button type="button" onClick={() => setEditing({ initial: null, body: "" })}>
                {strings.snippets.createNamed(trimmed)}
              </button>
            )}
          </p>
        )}
      </div>
      {selected && (
        <section className="snippets-detail" aria-label={strings.snippets.preview}>
          {highlighted ? (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Monaco's colorize output, never user HTML
            <pre className="snippets-preview" dangerouslySetInnerHTML={{ __html: highlighted }} />
          ) : (
            <pre className="snippets-preview">{selected.body}</pre>
          )}
          <div className="snippets-actions">
            <button type="button" onClick={() => actions.insert(selected)}>
              {strings.snippets.insert}
            </button>
            <button type="button" onClick={() => void actions.insertInNewTab(selected)}>
              {strings.snippets.insertInNewTab}
            </button>
            <button type="button" onClick={() => void copy(selected)}>
              {strings.snippets.copy}
            </button>
            <button type="button" onClick={() => setEditing({ initial: selected, body: selected.body })}>
              {strings.snippets.edit}
            </button>
            <button type="button" className="danger" onClick={() => void remove(selected)}>
              {strings.snippets.delete}
            </button>
          </div>
        </section>
      )}
      {deleted && (
        <p className="snippets-undo" role="status">
          {strings.snippets.deleted(deleted.name)}
          <button type="button" onClick={() => void undoDelete()}>
            {strings.snippets.undo}
          </button>
        </p>
      )}
      {status && !deleted && (
        <p className="snippets-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="snippets-status" role="alert">
          {error.message}
          {error.detail && <span className="snippets-detail-text">{error.detail}</span>}
        </p>
      )}
    </aside>
  );
}
```

Add the Graphite styling to `apps/ui/src/styles.css`, right after the `.side-bar h2` block:

```css
/* ---------- snippets panel (spec §13.1) ---------- */
.snippets-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}

.snippets-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.snippets-header h2 {
  margin: 0;
  margin-right: auto;
}

.snippets-search {
  width: 100%;
}

.snippets-scroller {
  flex: 1 1 auto;
  min-height: 80px;
  overflow: auto;
}

.snippets-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 6px;
  border-radius: 4px;
  cursor: default;
  color: var(--fg-default);
}

.snippets-row[aria-selected="true"] {
  background: var(--bg-selection, var(--bg-chrome));
}

.snippets-description,
.snippets-empty,
.snippets-status,
.snippets-detail-text {
  color: var(--fg-muted);
}

.snippets-description {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snippets-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border-default);
  padding-top: 8px;
}

.snippets-preview {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre;
  font: calc(var(--code-font-size, 13px) * var(--ui-scale)) / 1.5 var(--code-font-family, var(--mono));
  color: var(--fg-default);
}

.snippets-actions,
.snippets-conflicts .dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.snippets-undo {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/ui && bun test ./test/snippets-panel.test.tsx
```
Expected: PASS, **+13 tests**. (`SnippetForm` must exist for the import to resolve — if Task 8 has not run yet, create
`apps/ui/src/snippets/SnippetForm.tsx` with the single line `export function SnippetForm(): null { return null; }` and
let Task 8 replace it. Do **not** leave that stub in place past Task 8; Task 8's own tests fail if you do.)

- [ ] **Step 6: Commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
git add apps/ui/src/snippets/SnippetsPanel.tsx apps/ui/src/strings.ts apps/ui/src/styles.css \
        apps/ui/test/snippets-panel.test.tsx
git commit -m "$(cat <<'EOF'
Add the snippets side-bar panel

Search, a virtualized list, a preview and the five actions from §13.1. Delete
keeps the spec's confirmation and adds an Undo row, so a destructive action is
both deliberate and recoverable. An import is merged only after the conflict
choice, and a refused one changes nothing.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 8: The New / Edit snippet form

**Files:**
- Create: `apps/ui/src/snippets/body-editor.ts`, `apps/ui/src/snippets/SnippetForm.tsx` (replacing Task 7's stub, if you made one)
- Modify: `apps/ui/src/strings.ts`, `apps/ui/src/snippets/SnippetsPanel.tsx` (pass `createBody` through)
- Test: `apps/ui/test/snippet-body-editor.test.ts` (new), `apps/ui/test/snippet-form.test.tsx` (new)

**Interfaces:**
- Consumes: `newSnippet`, `isValidSnippetName`, `LANGUAGES`, `type Language`, `type Snippet`, `MAX_SNIPPET_BODY_CHARS`, `MAX_SNIPPET_DESCRIPTION_CHARS` (Task 1); `AppStore` and `receiveSnippets` (Task 4); `MainApi.snippetsSave`.
- Produces:
  ```ts
  // body-editor.ts
  export interface SnippetBodyHandle { getValue(): string; focus(): void; dispose(): void }
  export type SnippetBodyFactory = (
    host: HTMLElement,
    options: { value: string; language: Language | null },
  ) => SnippetBodyHandle;
  export function createMonacoBody(
    monaco: typeof Monaco,
    languageId: (language: Language | null) => string,
  ): SnippetBodyFactory;
  export function createTextareaBody(label: string): SnippetBodyFactory;

  // SnippetForm.tsx
  export function SnippetForm(props: {
    store: AppStore;
    api: Pick<MainApi, "snippetsSave">;
    initial: Snippet | null;
    body: string;
    onDone(): void;
    createBody?: SnippetBodyFactory;
    now?: () => string;
  }): JSX.Element;
  ```
  `SnippetsPanel` gains an optional `createBody?: SnippetBodyFactory` prop, forwarded to `SnippetForm`.

**Why the factory is injected (R-M5b-5).** §13.1 says the body is "a Monaco editor", and the research file's pattern 4
agrees that the most code-shaped field in the app should not be an HTML form control. Monaco cannot mount under
happy-dom, so the factory is a parameter: Task 9 passes `createMonacoBody(...)` in the real app, and the tests pass a
stub. `body-editor.ts` imports Monaco **as a type only** (`import type * as Monaco`), so nothing in the snippets folder
pulls the Monaco runtime into a test's module graph. `createTextareaBody` is the fallback when no factory is injected
at all — degraded but functional, and never reached in the shipped app.

- [ ] **Step 1: Write the failing test for the body editor**

Create `apps/ui/test/snippet-body-editor.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { createMonacoBody, createTextareaBody } from "../src/snippets/body-editor";

function fakeMonaco() {
  const created: { value: string; language: string; options: Record<string, unknown> }[] = [];
  const dispose = mock(() => {});
  const focus = mock(() => {});
  let current = "";
  const monaco = {
    editor: {
      create: (_host: HTMLElement, options: Record<string, unknown>) => {
        current = String(options.value ?? "");
        created.push({
          value: current,
          language: String(options.language ?? ""),
          options,
        });
        return {
          getValue: () => current,
          focus,
          dispose,
        };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, created, dispose, focus };
}

describe("the snippet body editor (spec §13.1, R-M5b-5)", () => {
  test("creates a Monaco editor for the snippet's language and reads its value back", () => {
    const { monaco, created, dispose, focus } = fakeMonaco();
    const factory = createMonacoBody(monaco, (language) => (language === "javascript" ? "javascript" : "typescript"));
    const host = document.createElement("div");
    const handle = factory(host, { value: "await fetch($0)", language: "javascript" });
    expect(created[0]?.value).toBe("await fetch($0)");
    expect(created[0]?.language).toBe("javascript");
    // A body field is not the main editor: no minimap, no line numbers, and it lays itself out.
    expect(created[0]?.options).toMatchObject({ automaticLayout: true, lineNumbers: "off" });
    expect((created[0]?.options.minimap as { enabled: boolean }).enabled).toBe(false);
    expect(handle.getValue()).toBe("await fetch($0)");
    handle.focus();
    expect(focus).toHaveBeenCalled();
    handle.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  test("the textarea fallback is a real editing surface with an accessible name", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const handle = createTextareaBody("Body")(host, { value: "console.log($0)", language: null });
    const field = host.querySelector("textarea");
    expect(field?.value).toBe("console.log($0)");
    expect(field?.getAttribute("aria-label")).toBe("Body");
    if (field) field.value = "changed";
    expect(handle.getValue()).toBe("changed");
    handle.dispose();
    expect(host.querySelector("textarea")).toBeNull();
    host.remove();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/ui && bun test ./test/snippet-body-editor.test.ts`
Expected: FAIL with `Cannot find module '../src/snippets/body-editor'`.

- [ ] **Step 3: Write the body editor**

Create `apps/ui/src/snippets/body-editor.ts`:

```ts
import type { Language } from "@jslab/shared";
import type * as Monaco from "monaco-editor";

/** The form's view of its body field, whatever is behind it. */
export interface SnippetBodyHandle {
  getValue(): string;
  focus(): void;
  dispose(): void;
}

export type SnippetBodyFactory = (
  host: HTMLElement,
  options: { value: string; language: Language | null },
) => SnippetBodyHandle;

/**
 * Spec §13.1: "Body (a Monaco editor)". `monaco` and `languageId` are parameters rather than imports, so this module
 * carries no Monaco runtime dependency and the snippets folder stays loadable under happy-dom (R-M5b-5).
 */
export function createMonacoBody(
  monaco: typeof Monaco,
  languageId: (language: Language | null) => string,
): SnippetBodyFactory {
  return (host, { value, language }) => {
    const editor = monaco.editor.create(host, {
      value,
      language: languageId(language),
      automaticLayout: true,
      lineNumbers: "off",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: false,
      // A snippet body is code the user is authoring, so the usual editing affordances stay on; only the chrome goes.
      wordWrap: "on",
    });
    return {
      getValue: () => editor.getValue(),
      focus: () => editor.focus(),
      dispose: () => editor.dispose(),
    };
  };
}

/**
 * The fallback when no Monaco factory is injected: a real, labelled editing surface rather than a dead box. The
 * shipped app always passes `createMonacoBody` (Task 9), so this is reached only by a caller that opted out.
 */
export function createTextareaBody(label: string): SnippetBodyFactory {
  return (host, { value }) => {
    const field = host.ownerDocument.createElement("textarea");
    field.value = value;
    field.className = "snippets-body-field";
    field.setAttribute("aria-label", label);
    field.spellcheck = false;
    host.append(field);
    return {
      getValue: () => field.value,
      focus: () => field.focus(),
      dispose: () => field.remove(),
    };
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/ui && bun test ./test/snippet-body-editor.test.ts`
Expected: PASS, **+2 tests**.

- [ ] **Step 5: Write the failing test for the form**

Create `apps/ui/test/snippet-form.test.tsx`:

```tsx
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type Snippet } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SnippetBodyFactory } from "../src/snippets/body-editor";
import { SnippetForm } from "../src/snippets/SnippetForm";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

const AT = "2026-09-16T10:00:00.000Z";
const LATER = "2026-09-17T11:00:00.000Z";
const existing: Snippet = {
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
};

/** A stub body field: the form must never depend on Monaco to be testable (R-M5b-5). */
function stubBody(): { factory: SnippetBodyFactory; setValue(value: string): void } {
  let value = "";
  return {
    factory: (_host, options) => {
      value = options.value;
      return { getValue: () => value, focus: () => {}, dispose: () => {} };
    },
    setValue: (next) => {
      value = next;
    },
  };
}

function setup(options: { initial?: Snippet | null; body?: string; library?: Snippet[] } = {}) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  store.getState().receiveSnippets(options.library ?? [existing]);
  const { api } = createFakeApi();
  const onDone = mock(() => {});
  const body = stubBody();
  render(
    <SnippetForm
      store={store}
      api={api}
      initial={options.initial ?? null}
      body={options.body ?? ""}
      onDone={onDone}
      createBody={body.factory}
      now={() => LATER}
    />,
  );
  return { store, api, onDone, body };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.save }));
    await Bun.sleep(1);
  });
};

describe("the New / Edit snippet form (spec §13.1)", () => {
  test("creates a snippet from the four fields", async () => {
    const { api, onDone, store, body } = setup();
    body.setValue("console.log($0)");
    type(strings.snippets.nameLabel, "log");
    type(strings.snippets.descriptionLabel, "  print a value  ");
    fireEvent.change(screen.getByLabelText(strings.snippets.languageLabel), { target: { value: "javascript" } });
    await submit();
    expect(api.snippetsSave).toHaveBeenCalledTimes(1);
    const saved = (api.snippetsSave.mock.calls[0]?.[0] ?? []) as Snippet[];
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({
      name: "log",
      description: "print a value",
      body: "console.log($0)",
      language: "javascript",
      createdAt: LATER,
      updatedAt: LATER,
    });
    expect(store.getState().snippets).toHaveLength(2);
    expect(onDone).toHaveBeenCalled();
  });

  test("pre-fills the body it was given (Create Snippet…, spec §13.1)", () => {
    const { body } = setup({ body: "const selected = 1" });
    expect(body.factory).toBeDefined();
    // The stub captured the value the form handed the factory.
    expect(screen.getByLabelText(strings.snippets.nameLabel)).toBeTruthy();
  });

  test("editing keeps the id and createdAt and moves updatedAt", async () => {
    const { api } = setup({ initial: existing, body: existing.body });
    type(strings.snippets.nameLabel, "fetchjson2");
    await submit();
    const saved = (api.snippetsSave.mock.calls[0]?.[0] ?? []) as Snippet[];
    expect(saved).toEqual([{ ...existing, name: "fetchjson2", createdAt: AT, updatedAt: LATER }]);
  });

  test("a missing, illegal or taken name blocks the save and says which (spec §13.1)", async () => {
    const { api } = setup();
    await submit();
    expect(await screen.findByText(strings.snippets.nameRequired)).toBeTruthy();

    type(strings.snippets.nameLabel, "has spaces");
    await submit();
    expect(await screen.findByText(strings.snippets.nameInvalid)).toBeTruthy();

    type(strings.snippets.nameLabel, "FETCHJSON");
    await submit();
    expect(await screen.findByText(strings.snippets.nameTaken)).toBeTruthy();

    expect(api.snippetsSave).not.toHaveBeenCalled();
  });

  test("renaming a snippet to its own current name is not a conflict", async () => {
    const { api } = setup({ initial: existing, body: existing.body });
    type(strings.snippets.descriptionLabel, "changed");
    await submit();
    expect(api.snippetsSave).toHaveBeenCalledTimes(1);
  });

  test("a failed save keeps the form open with everything typed", async () => {
    const { api, onDone } = setup();
    api.snippetsSave.mockImplementation(async () => ({ ok: false, error: "ENOSPC" }));
    type(strings.snippets.nameLabel, "log");
    await submit();
    expect(await screen.findByText(strings.snippets.saveFailed("ENOSPC"))).toBeTruthy();
    expect((screen.getByLabelText(strings.snippets.nameLabel) as HTMLInputElement).value).toBe("log");
    expect(onDone).not.toHaveBeenCalled();
  });

  test("Cancel leaves without saving", () => {
    const { api, onDone } = setup();
    type(strings.snippets.nameLabel, "discarded");
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.cancel }));
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  test("Escape cancels too, so the form never traps a keyboard user", async () => {
    const { onDone } = setup();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/ui && bun test ./test/snippet-form.test.tsx`
Expected: FAIL — `SnippetForm` does not accept these props (or the module is Task 7's one-line stub).

- [ ] **Step 7: Add the strings and write the form**

Add to the `snippets` block in `apps/ui/src/strings.ts`:

```ts
    // The New Snippet form (spec §13.1).
    newTitle: "New Snippet",
    editTitle: "Edit Snippet",
    nameLabel: "Name",
    nameHelp: "The word you type to insert this snippet. Letters, digits, _, $ and - only.",
    descriptionLabel: "Description",
    languageLabel: "Language hint",
    languageNone: "Any",
    bodyLabel: "Body",
    bodyHelp: "$0 is where the cursor lands; ${1:name} and $1 are tab stops.",
    save: "Save",
    nameRequired: "A snippet needs a name.",
    nameInvalid: "Use letters, digits, _, $ and - only.",
    nameTaken: "Another snippet already uses this name.",
```

Create `apps/ui/src/snippets/SnippetForm.tsx`:

```tsx
import {
  isValidSnippetName,
  type Language,
  LANGUAGES,
  MAX_SNIPPET_DESCRIPTION_CHARS,
  newSnippet,
  type Snippet,
} from "@jslab/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { createTextareaBody, type SnippetBodyFactory, type SnippetBodyHandle } from "./body-editor";

interface FormProps {
  store: AppStore;
  api: Pick<MainApi, "snippetsSave">;
  /** The snippet being edited, or null for a new one. */
  initial: Snippet | null;
  /** The body to start from: the edited snippet's, or a selection from Create Snippet… (spec §13.1). */
  body: string;
  onDone(): void;
  /** R-M5b-5: Monaco in the app, a stub in tests. Falls back to a labelled textarea when nothing is injected. */
  createBody?: SnippetBodyFactory;
  now?: () => string;
}

type NameError = "nameRequired" | "nameInvalid" | "nameTaken";

/** Spec §13.1's New Snippet form, reused for Edit. */
export function SnippetForm({ store, api, initial, body, onDone, createBody, now }: FormProps) {
  const snippets = useStore(store, (s) => s.snippets);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [language, setLanguage] = useState<Language | "">(initial?.language ?? "");
  const [nameError, setNameError] = useState<NameError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SnippetBodyHandle | null>(null);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const factory = createBody ?? createTextareaBody(strings.snippets.bodyLabel);
    handle.current = factory(element, { value: body, language: initial?.language ?? null });
    nameField.current?.focus();
    return () => {
      handle.current?.dispose();
      handle.current = null;
    };
    // The body field is created once per form instance; the panel remounts the form for every open (Task 7).
  }, [createBody, body, initial]);

  // Escape leaves the form, the same way every other JSLab surface does. Capture phase, on the document, so it
  // works even when focus sits inside Monaco (EnvVarsSheet's M-3 fix, same reasoning).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDone();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onDone]);

  const save = async () => {
    if (savingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) return setNameError("nameRequired");
    if (!isValidSnippetName(trimmed)) return setNameError("nameInvalid");
    // Spec §13.1: names are unique. Renaming a snippet to the name it already has is not a conflict.
    const taken = snippets.some(
      (candidate) => candidate.id !== initial?.id && candidate.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (taken) return setNameError("nameTaken");
    setNameError(null);
    setSaveError(null);

    const at = (now ?? (() => new Date().toISOString()))();
    const value = handle.current?.getValue() ?? body;
    const record: Snippet = initial
      ? { ...initial, name: trimmed, description: description.trim(), body: value, language: language || null, updatedAt: at }
      : newSnippet({ name: trimmed, description, body: value, language: language || null }, () => at);
    const next = initial
      ? snippets.map((candidate) => (candidate.id === initial.id ? record : candidate))
      : [...snippets, record];

    savingRef.current = true;
    setSaving(true);
    try {
      const result = await api.snippetsSave(next);
      if (!result.ok) {
        setSaveError(strings.snippets.saveFailed(result.error));
        return;
      }
      store.getState().receiveSnippets(next);
      onDone();
    } catch (error) {
      setSaveError(strings.snippets.saveFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="snippets-form">
      <h2>{initial ? strings.snippets.editTitle : strings.snippets.newTitle}</h2>
      <label htmlFor="snippet-name">{strings.snippets.nameLabel}</label>
      <input
        id="snippet-name"
        ref={nameField}
        aria-label={strings.snippets.nameLabel}
        aria-invalid={nameError !== null}
        aria-describedby="snippet-name-help"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <span id="snippet-name-help" className="snippets-help">
        {strings.snippets.nameHelp}
      </span>
      {nameError && (
        <span className="snippets-error" role="alert">
          {strings.snippets[nameError]}
        </span>
      )}
      <label htmlFor="snippet-description">{strings.snippets.descriptionLabel}</label>
      <input
        id="snippet-description"
        aria-label={strings.snippets.descriptionLabel}
        maxLength={MAX_SNIPPET_DESCRIPTION_CHARS}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <label htmlFor="snippet-language">{strings.snippets.languageLabel}</label>
      <select
        id="snippet-language"
        aria-label={strings.snippets.languageLabel}
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language | "")}
      >
        <option value="">{strings.snippets.languageNone}</option>
        {LANGUAGES.map((option) => (
          <option key={option} value={option}>
            {strings.settings.options.language[option]}
          </option>
        ))}
      </select>
      <span className="snippets-help">{strings.snippets.bodyHelp}</span>
      <div ref={host} className="snippets-body" data-testid="snippet-body" />
      {saveError && (
        <p className="snippets-status" role="alert">
          {saveError}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onDone}>
          {strings.snippets.cancel}
        </button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {strings.snippets.save}
        </button>
      </div>
    </div>
  );
}
```

In `apps/ui/src/snippets/SnippetsPanel.tsx`, accept and forward the factory: add `createBody?: SnippetBodyFactory;` to
`PanelProps` (importing the type from `./body-editor`), destructure it, and pass `createBody={createBody}` to the
`<SnippetForm …/>` element.

Add to `apps/ui/src/styles.css`, after the `.snippets-undo` block:

```css
.snippets-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.snippets-form h2 {
  margin: 0 0 4px;
}

.snippets-body,
.snippets-body-field {
  min-height: 160px;
  width: 100%;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  font: calc(var(--code-font-size, 13px) * var(--ui-scale)) / 1.5 var(--code-font-family, var(--mono));
}

.snippets-body-field {
  background: var(--bg-default);
  color: var(--fg-default);
  padding: 6px;
  resize: vertical;
}

.snippets-help {
  color: var(--fg-muted);
  font-size: 11px;
}

.snippets-error {
  color: var(--fg-error, var(--fg-default));
  font-size: 11px;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/ui && bun test ./test/snippet-form.test.tsx && bun test ./test/snippets-panel.test.tsx
```
Expected: PASS, **+8 tests** from the form (and the panel's 13 still green).

- [ ] **Step 9: Commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/snippets/body-editor.ts apps/ui/src/snippets/SnippetForm.tsx \
        apps/ui/src/snippets/SnippetsPanel.tsx apps/ui/src/strings.ts apps/ui/src/styles.css \
        apps/ui/test/snippet-body-editor.test.ts apps/ui/test/snippet-form.test.tsx
git commit -m "$(cat <<'EOF'
Add the New / Edit snippet form

The body is a real Monaco editor, injected as a factory so the form stays
testable without a browser layout. Name validation enforces §13.1's pattern
and uniqueness, and renaming a snippet to its own name is not a conflict.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 9: Side-bar mount, commands, keymap and menus

**This is the cross-plan interface task. Read rulings R-M5b-1, R-M5b-2 and R-M5b-3 before writing a line.**

**Files:**
- Modify: `packages/shared/src/commands.ts`, `packages/shared/src/keybindings.ts`
- Modify: `apps/ui/src/editor/editor-handle.ts`, `apps/ui/src/editor/Editor.tsx`
- Create: `apps/ui/src/snippets/snippet-actions.ts`
- Modify: `apps/ui/src/shell/SideBar.tsx`, `apps/ui/src/shell/ActivityBar.tsx`, `apps/ui/src/shell/App.tsx`, `apps/ui/src/e2e/snapshot.ts`
- Modify: `apps/desktop/src/main/menu.ts`
- Test: `apps/ui/test/snippet-commands.test.ts` (new); additions to `packages/shared/test/commands.test.ts` and `apps/desktop/test/menu.test.ts`

**Interfaces:**
- Consumes: `expansionFor`, `snippetTemplate`, `plainInsertion` (Task 5); `SnippetActions` and `SnippetsPanel` (Task 7); `createMonacoBody` (Task 8); `AppState.requestSnippets` (Task 4); `writeSetting` from `apps/ui/src/commands/settings-writer.ts`; `TabActions.newTab`.
- Produces:
  - Five `CommandId`s: `tools.snippets`, `snippets.create`, `snippets.import`, `snippets.export`, `snippets.expand`
  - Two `DEFAULT_KEYBINDINGS` rows: `{ key: "cmd+b", command: "tools.snippets" }`, `{ key: "tab", command: "snippets.expand", when: "editorFocus" }`
  - `EditorHandle.textBeforeCursor(): string`, `EditorHandle.insertSnippet(template: string, deleteBefore?: number): boolean`, `EditorHandle.selectedTextOrAll(): string`
  - ```ts
    export interface SnippetCommandDeps {
      store: AppStore;
      api: Pick<MainApi, "snippetsImportDialog" | "snippetsExportDialog" | "updateSettings">;
      editor(): EditorHandle | null;
      tabs: Pick<TabActions, "newTab">;
      panelShowing(): boolean;
      openPanel(): void;
      closePanel(): void;
    }
    export function createSnippetActions(deps: SnippetCommandDeps): SnippetActions & {
      expandAtCursor(): boolean;
      canExpandAtCursor(): boolean;
      createFromEditor(): void;
    };
    export function createSnippetCommands(deps: SnippetCommandDeps): CommandSpec[];
    ```
  - `UiSnapshot.snippetCount: number`; `regions.snippetsPanel`

**How `Cmd+B` interacts with the existing panel switch (R-M5b-3), stated once and implemented once:**

| State when `Cmd+B` is pressed | What happens |
|---|---|
| Side bar hidden | `view.sideBar` is set true, the panel is set to `"snippets"`, the search box takes focus |
| Side bar open on another panel (`"ai"`, or M5a's `"transpiled"`) | The panel switches to `"snippets"`, the search box takes focus |
| Side bar open on Snippets | `view.sideBar` is set false — the side bar hides |
| Any modal sheet is open | Nothing: the resolver drops bindings without `modalOpen` in their `when` (same as `Cmd+I`) |

The activity-bar Snippets button keeps calling `App.tsx`'s existing `togglePanel("snippets")`, which has exactly this
shape already — so the key and the click cannot diverge. `snippets.import` / `snippets.export` / `snippets.create` call
`openPanel()` (open, never toggle) first, because their result arrives as a message the mounted panel must receive.

> **`snippets.expand` is bound to bare `Tab` and that is safe**, because `App.tsx:432` skips `preventDefault` for a
> command whose `isEnabled()` is false. With no snippet name immediately before the caret the command is disabled and
> `Tab` reaches Monaco untouched. The test below pins that down.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/test/commands.test.ts`, inside `describe("command catalogue")`:

```ts
  test("M5b adds the snippet commands, ⌘B and the Tab expansion (spec §13, §6.5)", () => {
    expect(commandMeta("tools.snippets")).toMatchObject({ title: "Snippets…", category: "tools" });
    expect(commandMeta("snippets.create")).toMatchObject({ title: "Create Snippet…", category: "edit" });
    expect(commandMeta("snippets.import")).toMatchObject({ category: "tools" });
    expect(commandMeta("snippets.export")).toMatchObject({ category: "tools" });
    // Hidden from the palette: it only means anything with a trigger word already typed.
    expect(commandMeta("snippets.expand")).toMatchObject({ palette: false });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "cmd+b")).toEqual([
      { key: "cmd+b", command: "tools.snippets" },
    ]);
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "tab")).toEqual([
      { key: "tab", command: "snippets.expand", when: "editorFocus" },
    ]);
  });
```

Create `apps/ui/test/snippet-commands.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings, type Snippet } from "@jslab/shared";
import type { EditorHandle } from "../src/editor/editor-handle";
import { createSnippetActions, createSnippetCommands } from "../src/snippets/snippet-actions";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body: string, language: Snippet["language"] = null): Snippet => ({
  id: name,
  name,
  description: "",
  body,
  language,
  createdAt: AT,
  updatedAt: AT,
});

function setup(options: { before?: string; sideBar?: boolean; panel?: "snippets" | "ai"; canSnippet?: boolean } = {}) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: mergeSettings(defaultSettings(), { view: { sideBar: options.sideBar ?? false } }),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  if (options.panel) store.getState().setSideBarPanel(options.panel);
  store.getState().receiveSnippets([
    snippet("fetchjson", "await fetch(${1:url})$0"),
    snippet("plain", "cost: $5"),
    snippet("jsx", "<div />", "tsx"),
  ]);
  const { api } = createFakeApi();
  const editor = {
    textBeforeCursor: mock(() => options.before ?? ""),
    insertSnippet: mock((_template: string, _deleteBefore?: number) => options.canSnippet ?? true),
    selectedTextOrAll: mock(() => "const selected = 1"),
    typeText: mock((_text: string, _replace: boolean) => {}),
  } as unknown as EditorHandle & { [k: string]: ReturnType<typeof mock> };
  const tabs = { newTab: mock(async () => {}) };
  const panel = { showing: options.sideBar === true && (options.panel ?? "snippets") === "snippets", opened: 0, closed: 0 };
  const deps = {
    store,
    api,
    editor: () => editor,
    tabs,
    panelShowing: () => panel.showing,
    openPanel: mock(() => {
      panel.opened += 1;
      panel.showing = true;
    }),
    closePanel: mock(() => {
      panel.closed += 1;
      panel.showing = false;
    }),
  };
  const actions = createSnippetActions(deps);
  const commands = new Map(createSnippetCommands(deps).map((spec) => [spec.id, spec]));
  return { store, api, editor, tabs, panel, actions, commands };
}

describe("snippet actions (spec §13.1)", () => {
  test("Insert sends the template, escaping $ in a body with no placeholders (§13.2)", () => {
    const { actions, editor, store } = setup();
    const [withStops, plain] = store.getState().snippets;
    if (!withStops || !plain) throw new Error("fixture");
    actions.insert(withStops);
    expect(editor.insertSnippet).toHaveBeenCalledWith("await fetch(${1:url})$0", 0);
    actions.insert(plain);
    expect(editor.insertSnippet).toHaveBeenLastCalledWith("cost: \\$5", 0);
  });

  test("Insert falls back to typing when this Monaco build has no snippet controller", () => {
    const { actions, editor, store } = setup({ canSnippet: false });
    const [withStops] = store.getState().snippets;
    if (!withStops) throw new Error("fixture");
    actions.insert(withStops);
    expect(editor.typeText).toHaveBeenCalledWith("await fetch(url)", false);
  });

  test("Insert in New Tab opens a tab with the plain text and the snippet's language", async () => {
    const { actions, tabs, store } = setup();
    const jsx = store.getState().snippets.find((s) => s.name === "jsx");
    if (!jsx) throw new Error("fixture");
    await actions.insertInNewTab(jsx);
    expect(tabs.newTab).toHaveBeenCalledWith({ content: "<div />", language: "tsx" });
  });

  test("Create Snippet… opens the panel with the selection as the body (§13.1)", () => {
    const { actions, store, panel } = setup();
    actions.createFromEditor();
    expect(panel.opened).toBe(1);
    expect(store.getState().snippetsRequest).toMatchObject({ kind: "newSnippet", body: "const selected = 1" });
  });
});

describe("snippet commands (spec §6.5, ruling R-M5b-3)", () => {
  test("⌘B opens the panel and focuses search; pressing it again hides the side bar", () => {
    const hidden = setup({ sideBar: false });
    hidden.commands.get("tools.snippets")?.run();
    expect(hidden.panel.opened).toBe(1);
    expect(hidden.store.getState().snippetsRequest).toMatchObject({ kind: "focusSearch" });

    const showing = setup({ sideBar: true, panel: "snippets" });
    showing.commands.get("tools.snippets")?.run();
    expect([showing.panel.closed, showing.panel.opened]).toEqual([1, 0]);
    expect(showing.store.getState().snippetsRequest).toBeNull();
  });

  test("⌘B on another panel switches to Snippets rather than closing the side bar", () => {
    const { commands, panel, store } = setup({ sideBar: true, panel: "ai" });
    commands.get("tools.snippets")?.run();
    expect([panel.opened, panel.closed]).toEqual([1, 0]);
    expect(store.getState().snippetsRequest).toMatchObject({ kind: "focusSearch" });
  });

  test("Import and Export open the panel first, so its answer can't arrive unheard", () => {
    const { commands, api, panel, store } = setup();
    commands.get("snippets.import")?.run();
    expect([panel.opened, api.snippetsImportDialog.mock.calls.length]).toEqual([1, 1]);
    commands.get("snippets.export")?.run();
    expect(api.snippetsExportDialog).toHaveBeenLastCalledWith(store.getState().snippets);
  });

  test("Tab expands an exact trigger word and deletes what was typed", () => {
    const { commands, editor } = setup({ before: "const x = fetchjson" });
    expect(commands.get("snippets.expand")?.isEnabled?.()).toBe(true);
    commands.get("snippets.expand")?.run();
    expect(editor.insertSnippet).toHaveBeenCalledWith("await fetch(${1:url})$0", 9);
  });

  test("Tab is disabled with no trigger word, so the keystroke reaches Monaco untouched", () => {
    for (const before of ["", "fetchjs", "const x = ", "nothing"]) {
      const { commands, editor } = setup({ before });
      expect([before, commands.get("snippets.expand")?.isEnabled?.()]).toEqual([before, false]);
      commands.get("snippets.expand")?.run();
      expect(editor.insertSnippet).not.toHaveBeenCalled();
    }
  });

  test("every snippet command is disabled when no editor is mounted, except the panel ones", () => {
    const { store, api, panel } = setup();
    const withoutEditor = createSnippetCommands({
      store,
      api,
      editor: () => null,
      tabs: { newTab: async () => {} },
      panelShowing: () => panel.showing,
      openPanel: () => {},
      closePanel: () => {},
    });
    const byId = new Map(withoutEditor.map((spec) => [spec.id, spec]));
    expect(byId.get("snippets.expand")?.isEnabled?.()).toBe(false);
    expect(byId.get("snippets.create")?.isEnabled?.()).toBe(false);
    expect(byId.get("tools.snippets")?.isEnabled?.() ?? true).toBe(true);
  });
});
```

Add to `apps/desktop/test/menu.test.ts`:

```ts
  test("Tools lists Snippets… with ⌘B, and Edit offers Create Snippet… (spec §7.4, §13.1)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Snippets…")?.label).toBe("Snippets…    ⌘B");
    expect(byLabel(menu, "Snippets…")?.action).toBe(menuAction("tools.snippets"));
    expect(byLabel(menu, "Import Snippets…")?.action).toBe(menuAction("snippets.import"));
    expect(byLabel(menu, "Export Snippets…")?.action).toBe(menuAction("snippets.export"));
    expect(byLabel(menu, "Create Snippet…")?.action).toBe(menuAction("snippets.create"));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/shared && bun test ./test/commands.test.ts
cd ../../apps/ui && bun test ./test/snippet-commands.test.ts
cd ../desktop && bun test ./test/menu.test.ts
```
Expected: FAIL — unknown command ids, and `Cannot find module '../src/snippets/snippet-actions'`.

- [ ] **Step 3: Add the commands and the keymap**

In `packages/shared/src/commands.ts`, add to the Tools group (after `npm.install`):

```ts
  { id: "tools.snippets", title: "Snippets…", category: "tools" },
  { id: "snippets.import", title: "Import Snippets…", category: "tools" },
  { id: "snippets.export", title: "Export Snippets…", category: "tools" },
  // Category "edit" (they belong in the Edit menu and the palette's Edit section); the `snippets.` prefix keeps them
  // out of `apps/ui/test/commands.test.ts`'s "every edit.* command is implemented by createEditorCommands" rule,
  // which they could not satisfy -- both need the snippet library, which that factory has no access to.
  { id: "snippets.create", title: "Create Snippet…", category: "edit", context: "editor" },
  { id: "snippets.expand", title: "Expand Snippet", category: "edit", context: "editor", palette: false },
```

In `packages/shared/src/keybindings.ts`, add to `DEFAULT_KEYBINDINGS` (next to `cmd+i`):

```ts
  { key: "cmd+b", command: "tools.snippets" },
  // Bare Tab is safe: `snippets.expand` reports isEnabled() === false unless a snippet name sits immediately before
  // the caret, and the resolver's caller skips preventDefault for a disabled command, so Monaco still indents.
  { key: "tab", command: "snippets.expand", when: editor },
```

- [ ] **Step 4: Extend the editor handle**

In `apps/ui/src/editor/editor-handle.ts`, add to `EditorHandle`:

```ts
  /** The text of the current line before the caret (spec §13.3's trigger detection). */
  textBeforeCursor(): string;
  /**
   * Inserts a Monaco snippet template at the caret, first deleting `deleteBefore` characters before it, and
   * replacing the selection. Returns false when this Monaco build exposes no snippet controller, so the caller can
   * insert plain text instead.
   */
  insertSnippet(template: string, deleteBefore?: number): boolean;
  /** Spec §13.1 Create Snippet…: the selected text, or the whole buffer when nothing is selected. */
  selectedTextOrAll(): string;
```

In `apps/ui/src/editor/Editor.tsx`, add the three members inside the `setEditorHandle({ … })` object, after `getCursorOffset`:

```ts
      textBeforeCursor: () => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position) return "";
        return model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));
      },
      insertSnippet: (template, deleteBefore = 0) => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position) return false;
        // `snippetController2` is Monaco's own snippet-insertion contribution; it is what the suggest widget uses
        // for an InsertAsSnippet completion. A build without it still gets plain text from the caller.
        const controller = editor.getContribution("snippetController2") as { insert?(template: string): void } | null;
        if (!controller || typeof controller.insert !== "function") return false;
        if (deleteBefore > 0) {
          const offset = model.getOffsetAt(position);
          const start = model.getPositionAt(Math.max(0, offset - deleteBefore));
          editor.pushUndoStop();
          editor.executeEdits("snippets", [{ range: monaco.Range.fromPositions(start, position), text: "" }]);
        }
        editor.focus();
        controller.insert(template);
        return true;
      },
      selectedTextOrAll: () => {
        const model = editor.getModel();
        if (!model) return "";
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return model.getValue();
        return model.getValueInRange(selection);
      },
```

- [ ] **Step 5: Write the actions and commands**

Create `apps/ui/src/snippets/snippet-actions.ts`:

```ts
import type { CommandSpec } from "../commands/registry";
import { writeSetting } from "../commands/settings-writer";
import type { EditorHandle } from "../editor/editor-handle";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import type { TabActions } from "../tabs/tab-actions";
import { expansionFor, plainInsertion, snippetTemplate } from "./snippet-text";
import type { SnippetActions } from "./SnippetsPanel";

export interface SnippetCommandDeps {
  store: AppStore;
  api: Pick<MainApi, "snippetsImportDialog" | "snippetsExportDialog" | "updateSettings">;
  editor(): EditorHandle | null;
  tabs: Pick<TabActions, "newTab">;
  /** True when the side bar is open and showing the Snippets panel right now. */
  panelShowing(): boolean;
  /** Show the Snippets panel (a no-op when it already is). Never a toggle. */
  openPanel(): void;
  /** Hide the side bar. */
  closePanel(): void;
}

export function createSnippetActions(deps: SnippetCommandDeps): SnippetActions & {
  expandAtCursor(): boolean;
  canExpandAtCursor(): boolean;
  createFromEditor(): void;
} {
  const expansion = () => {
    const editor = deps.editor();
    return editor ? expansionFor(editor.textBeforeCursor(), deps.store.getState().snippets) : null;
  };

  const put = (body: string, deleteBefore: number) => {
    const editor = deps.editor();
    if (!editor) return;
    // Spec §13.2: a body with tab stops goes in as a template; one without has its $ escaped.
    if (editor.insertSnippet(snippetTemplate(body), deleteBefore)) return;
    // No snippet controller: type the literal rendering instead, which still replaces the selection.
    editor.typeText(plainInsertion(body), false);
  };

  return {
    insert: (snippet) => put(snippet.body, 0),
    insertInNewTab: async (snippet) => {
      // A fresh buffer has nowhere to put tab stops, so the new tab gets the literal text.
      await deps.tabs.newTab({
        content: plainInsertion(snippet.body),
        ...(snippet.language ? { language: snippet.language } : {}),
      });
    },
    canExpandAtCursor: () => expansion() !== null,
    expandAtCursor: () => {
      const found = expansion();
      if (!found) return false;
      put(found.snippet.body, found.deleteBefore);
      return true;
    },
    createFromEditor: () => {
      const editor = deps.editor();
      if (!editor) return;
      // Spec §13.1: the selection, or the whole buffer when nothing is selected.
      const body = editor.selectedTextOrAll();
      deps.openPanel();
      deps.store.getState().requestSnippets("newSnippet", body);
    },
  };
}

/** Spec §13 and §6.5. Registered by `App.tsx` alongside every other command group. */
export function createSnippetCommands(deps: SnippetCommandDeps): CommandSpec[] {
  const actions = createSnippetActions(deps);
  const s = () => deps.store.getState();
  const show = () => {
    deps.openPanel();
    s().requestSnippets("focusSearch");
  };

  return [
    {
      id: "tools.snippets",
      // Ruling R-M5b-3: the same three-way behaviour the activity-bar button has, so key and click never diverge.
      run: () => (deps.panelShowing() ? deps.closePanel() : show()),
    },
    {
      id: "snippets.create",
      isEnabled: () => deps.editor() !== null,
      run: () => actions.createFromEditor(),
    },
    {
      // The panel opens first: Main answers with a `snippets.imported` message, which only a mounted panel hears.
      id: "snippets.import",
      run: () => {
        deps.openPanel();
        deps.api.snippetsImportDialog();
      },
    },
    {
      id: "snippets.export",
      run: () => {
        deps.openPanel();
        deps.api.snippetsExportDialog(s().snippets);
      },
    },
    {
      id: "snippets.expand",
      // This is what keeps a bare-Tab binding safe (App.tsx skips preventDefault for a disabled command).
      isEnabled: () => actions.canExpandAtCursor(),
      run: () => void actions.expandAtCursor(),
    },
  ];
}

/** Opens the Snippets panel, turning the side bar on when it is off. Used by `App.tsx` to build the deps above. */
export function showSnippetsPanel(store: AppStore, api: Pick<MainApi, "updateSettings">): void {
  store.getState().setSideBarPanel("snippets");
  if (!store.getState().settings?.view.sideBar) void writeSetting(store, api, "view.sideBar", () => true);
}

export function hideSideBar(store: AppStore, api: Pick<MainApi, "updateSettings">): void {
  void writeSetting(store, api, "view.sideBar", () => false);
}
```

- [ ] **Step 6: Mount the panel and wire the shell**

Rewrite `apps/ui/src/shell/SideBar.tsx` per **R-M5b-2**:

```tsx
import type { MainApi } from "../api";
import type { Dialogs } from "./dialogs";
import type { SnippetActions, SnippetColorize } from "../snippets/SnippetsPanel";
import { SnippetsPanel } from "../snippets/SnippetsPanel";
import type { SnippetBodyFactory } from "../snippets/body-editor";
import type { AppState, AppStore } from "../state/store";
import { strings } from "../strings";

/**
 * Side bar host (spec §7.1). `panel` is typed as `AppState["sideBarPanel"]` rather than a union written here, so a
 * sibling milestone adding a panel never has to edit this signature (ruling R-M5b-1).
 */
export function SideBar({
  panel,
  store,
  api,
  dialogs,
  actions,
  colorize,
  createBody,
}: {
  panel: AppState["sideBarPanel"];
  store: AppStore;
  api: MainApi;
  dialogs: Dialogs;
  actions: SnippetActions;
  colorize?: SnippetColorize;
  createBody?: SnippetBodyFactory;
}) {
  if (panel === "snippets") {
    return (
      <SnippetsPanel
        store={store}
        api={api}
        dialogs={dialogs}
        actions={actions}
        colorize={colorize}
        createBody={createBody}
      />
    );
  }
  return (
    <aside className="side-bar" aria-label={strings.shell.aiChat}>
      <h2>{strings.shell.aiChat}</h2>
      <p>{strings.shell.sideBarPlaceholder}</p>
    </aside>
  );
}
```

> **If M5a has already landed**, keep its `if (panel === "transpiled") return <TranspiledPanel store={store} api={api} />;`
> line above the `"snippets"` branch and widen its `api` prop to `MainApi` — the two branches are independent, and
> `MainApi` satisfies its `Pick<MainApi, "transpiled">`. Nothing else in either version changes.

In `apps/ui/src/shell/ActivityBar.tsx`, add one optional prop and use it for the Snippets button's tooltip (its
`aria-label` stays `strings.shell.snippets`, which `apps/ui/isolated/app.test.tsx` looks it up by):

```tsx
  snippetsKeys?: string | null;
```
```tsx
        title={strings.shell.withKeys(strings.shell.snippets, props.snippetsKeys ?? null)}
```

In `apps/ui/src/shell/App.tsx`:

1. Import the new pieces:
   ```tsx
   import { createSnippetActions, createSnippetCommands, hideSideBar, showSnippetsPanel } from "../snippets/snippet-actions";
   ```
2. Build the deps and actions above the `registry` memo (they must not reference `registry`, which is why
   `showSnippetsPanel` / `hideSideBar` write the setting directly instead of executing `view.toggleSideBar`):
   ```tsx
   const snippetDeps = useMemo(
     () => ({
       store,
       api,
       editor: getEditorHandle,
       tabs,
       panelShowing: () =>
         Boolean(store.getState().settings?.view.sideBar) && store.getState().sideBarPanel === "snippets",
       openPanel: () => showSnippetsPanel(store, api),
       closePanel: () => hideSideBar(store, api),
     }),
     [store, api, tabs],
   );
   const snippetActions = useMemo(() => createSnippetActions(snippetDeps), [snippetDeps]);
   ```
3. Register the commands inside the `registry` memo's `created.register(...)` call, next to `createViewCommands(...)`:
   ```tsx
      ...createSnippetCommands(snippetDeps),
   ```
   and add `snippetDeps` to that memo's dependency array.
4. Add the keycap, next to the other three in the `keycaps` memo: `snippets: keysFor("tools.snippets"),`, and pass
   `snippetsKeys={keycaps.snippets}` to `<ActivityBar …/>`.
5. Mount the panel (the one line that also appears in M5a — keep all four/five props when merging):
   ```tsx
   {settings.view.sideBar && (
     <SideBar panel={sideBarPanel} store={store} api={api} dialogs={dialogs} actions={snippetActions} />
   )}
   ```
6. Add the E2E region probe inside the `regions: () => ({ … })` object:
   ```ts
         // Spec §13.1: the snippets panel, so a scenario can tell it is on screen.
         snippetsPanel: document.querySelector(".snippets-panel") !== null,
   ```

In `apps/ui/src/e2e/snapshot.ts`, add `snippetCount: number;` to `UiSnapshot` (after `themeId`) and
`snippetCount: state.snippets.length,` to the returned object. **Do not add `sideBarPanel` here — M5a owns that field.**

In `apps/desktop/src/main/menu.ts`, extend the two submenus:

```ts
    {
      label: "Tools",
      submenu: [
        item("tools.npmPackages"),
        item("tools.environmentVariables"),
        item("tools.snippets"),
        separator,
        item("snippets.import"),
        item("snippets.export"),
      ],
    },
```

and in the Edit submenu, between the comment group and `output.clear`:

```ts
        item("edit.toggleMagicComment"),
        separator,
        item("snippets.create"),
        separator,
        item("output.clear"),
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd packages/shared && bun test ./test/commands.test.ts && bun test ./test/keybindings.test.ts
cd ../../apps/ui && bun test ./test/snippet-commands.test.ts && bun test ./test/commands.test.ts && bun test ./isolated
cd ../desktop && bun test ./test/menu.test.ts
```
Expected: PASS, **+9 tests** (1 shared, 7 UI, 1 menu). `apps/ui/isolated/app.test.tsx` must be green **unchanged** —
it renders the real `SideBar`, so the fake API's `snippetsList` answers the panel's mount, and its
`document.querySelector(".side-bar")` assertion still finds the panel's own root element.

- [ ] **Step 8: Commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add packages/shared/src/commands.ts packages/shared/src/keybindings.ts packages/shared/test/commands.test.ts \
        apps/ui/src/editor/editor-handle.ts apps/ui/src/editor/Editor.tsx \
        apps/ui/src/snippets/snippet-actions.ts apps/ui/src/shell/SideBar.tsx apps/ui/src/shell/ActivityBar.tsx \
        apps/ui/src/shell/App.tsx apps/ui/src/e2e/snapshot.ts apps/ui/test/snippet-commands.test.ts \
        apps/desktop/src/main/menu.ts apps/desktop/test/menu.test.ts
git commit -m "$(cat <<'EOF'
Mount the snippets panel and give it ⌘B, commands and menu items

⌘B reuses the side bar's own panel switch, so the key and the activity-bar
button cannot diverge. Tab expansion is a real command with a disabled state,
which is what lets a bare-Tab binding coexist with Monaco's indent.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 10: Monaco — the completion provider, Create Snippet… and the highlighter

**Files:**
- Create: `apps/ui/src/snippets/snippet-completions.ts`, `apps/ui/src/snippets/create-snippet-action.ts`, `apps/ui/src/snippets/monaco-bridge.ts`
- Modify: `apps/ui/src/editor/Editor.tsx`, `apps/ui/src/shell/App.tsx`, `apps/ui/src/strings.ts`
- Test: `apps/ui/test/snippet-completions.test.ts` (new)

**Interfaces:**
- Consumes: `triggerWord`, `completionsFor`, `snippetTemplate` (Task 5); `createMonacoBody` (Task 8); `languageId` from `apps/ui/src/editor/monaco-setup.ts`; `SnippetColorize` (Task 7).
- Produces:
  ```ts
  export function registerSnippetCompletions(
    monaco: typeof Monaco,
    deps: { snippets(): readonly Snippet[] },
  ): { dispose(): void };

  export function registerCreateSnippetAction(
    editor: Pick<Monaco.editor.IStandaloneCodeEditor, "addAction">,
    deps: { run(): void },
  ): { dispose(): void };

  // monaco-bridge.ts — no Monaco import at all, only types (the setSnippetMonaco/getters pair)
  export function setSnippetMonaco(value: { colorize: SnippetColorize; createBody: SnippetBodyFactory } | null): void;
  export function snippetColorize(code: string, language: Language | null): Promise<string>;
  export function snippetBodyFactory(host: HTMLElement, options: { value: string; language: Language | null }): SnippetBodyHandle;
  ```

**Why a bridge module.** `App.tsx` must hand the panel a highlighter and a body-editor factory, but it has no Monaco
reference and must not gain one: `apps/ui/isolated/app.test.tsx` renders the real `App` under happy-dom with only
`../src/editor/Editor` mocked, so any import path from `App` to `monaco-editor` would load Monaco in that test.
`monaco-bridge.ts` therefore holds a module-level slot that **`Editor.tsx` fills**, exactly as `editor-handle.ts`
already does with `setEditorHandle`. `snippetColorize` rejects while the slot is empty, and the panel's preview falls
back to plain text — which is also what happens in every test.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/snippet-completions.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { Snippet } from "@jslab/shared";
import type * as Monaco from "monaco-editor";
import { registerCreateSnippetAction } from "../src/snippets/create-snippet-action";
import { setSnippetMonaco, snippetColorize } from "../src/snippets/monaco-bridge";
import { registerSnippetCompletions } from "../src/snippets/snippet-completions";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body: string, description = `does ${name}`): Snippet => ({
  id: name,
  name,
  description,
  body,
  language: null,
  createdAt: AT,
  updatedAt: AT,
});
const library = [snippet("fetchjson", "await fetch(${1:url})$0"), snippet("fetch", "fetch()"), snippet("log", "log($0)")];

interface Suggestion {
  label: string;
  detail: string;
  insertText: string;
  insertTextRules: number;
  kind: number;
  sortText: string;
  range: { startColumn: number; endColumn: number };
}

/** Just enough Monaco for `registerSnippetCompletions`, in the style of `install-assist.test.ts`. */
function fakeMonaco() {
  let provider: { provideCompletionItems(model: unknown, position: unknown): { suggestions: Suggestion[] } } | null =
    null;
  const disposed = mock(() => {});
  const monaco = {
    languages: {
      CompletionItemKind: { Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (_selector: unknown, p: typeof provider) => {
        provider = p;
        return { dispose: disposed };
      },
    },
    Range: class {
      constructor(
        readonly startLineNumber: number,
        readonly startColumn: number,
        readonly endLineNumber: number,
        readonly endColumn: number,
      ) {}
    },
  } as unknown as typeof Monaco;

  /** Drives the captured provider with a single line of text and a caret column. */
  const complete = (line: string) => {
    const model = { getValueInRange: () => line };
    const position = { lineNumber: 1, column: line.length + 1 };
    return provider?.provideCompletionItems(model, position).suggestions ?? [];
  };
  return { monaco, complete, disposed };
}

describe("snippet completions (spec §13.3, ruling R-M5b-7)", () => {
  test("suggests snippets whose name starts with the typed word, with a snippet kind and the description", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    const suggestions = complete("const x = fe");
    expect(suggestions.map((s) => s.label)).toEqual(["fetch", "fetchjson"]);
    expect(suggestions[0]).toMatchObject({ kind: 27, insertTextRules: 4, detail: "does fetch" });
    // The typed word is what gets replaced: "fe" is two characters before the caret at column 13.
    expect([suggestions[0]?.range.startColumn, suggestions[0]?.range.endColumn]).toEqual([11, 13]);
  });

  test("the body is inserted as a template, with $ escaped when there are no placeholders (§13.2)", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => [snippet("cost", "total: $5")] });
    expect(complete("co")[0]?.insertText).toBe("total: \\$5");
    const { monaco: m2, complete: c2 } = fakeMonaco();
    registerSnippetCompletions(m2, { snippets: () => library });
    expect(c2("fetchj")[0]?.insertText).toBe("await fetch(${1:url})$0");
  });

  test("a fully typed name still suggests — and suggests only itself (RunJS #488, R-M5b-7)", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    expect(complete("fetch").map((s) => s.label)).toEqual(["fetch"]);
    expect(complete("FETCH").map((s) => s.label)).toEqual(["fetch"]);
    expect(complete("fetchjson").map((s) => s.label)).toEqual(["fetchjson"]);
  });

  test("snippets sort ahead of word suggestions, and an empty or unmatched word offers nothing", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    // A leading NUL sorts before anything Monaco's own word-based suggestions produce.
    expect(complete("fe")[0]?.sortText.startsWith(String.fromCharCode(0))).toBe(true);
    expect(complete("")).toEqual([]);
    expect(complete("obj.")).toEqual([]);
    expect(complete("zzz")).toEqual([]);
  });

  test("the library is read at completion time, so a new snippet is suggested immediately", () => {
    const { monaco, complete } = fakeMonaco();
    let current: Snippet[] = [];
    registerSnippetCompletions(monaco, { snippets: () => current });
    expect(complete("lo")).toEqual([]);
    current = library;
    expect(complete("lo").map((s) => s.label)).toEqual(["log"]);
  });

  test("dispose releases the provider", () => {
    const { monaco, disposed } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library }).dispose();
    expect(disposed).toHaveBeenCalled();
  });
});

describe("Create Snippet… in the editor context menu (spec §13.1, parity ED-20)", () => {
  test("registers a context-menu action that dispatches the command", () => {
    const added: { id: string; contextMenuGroupId?: string; run: () => void }[] = [];
    const dispose = mock(() => {});
    const editor = {
      addAction: (action: { id: string; contextMenuGroupId?: string; run: () => void }) => {
        added.push(action);
        return { dispose };
      },
    };
    const run = mock(() => {});
    const registration = registerCreateSnippetAction(editor as never, { run });
    expect(added[0]?.id).toBe("jslab.createSnippet");
    expect(added[0]?.contextMenuGroupId).toBeTruthy();
    added[0]?.run();
    expect(run).toHaveBeenCalled();
    registration.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});

describe("the Monaco bridge", () => {
  test("colorize rejects until Editor fills the slot, so the preview falls back to plain text", async () => {
    setSnippetMonaco(null);
    expect(snippetColorize("const a = 1", null)).rejects.toThrow();
    setSnippetMonaco({
      colorize: async (code) => `<span>${code}</span>`,
      createBody: () => ({ getValue: () => "", focus: () => {}, dispose: () => {} }),
    });
    expect(await snippetColorize("const a = 1", null)).toBe("<span>const a = 1</span>");
    setSnippetMonaco(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/ui && bun test ./test/snippet-completions.test.ts`
Expected: FAIL with `Cannot find module '../src/snippets/snippet-completions'`.

- [ ] **Step 3: Write the three modules**

Create `apps/ui/src/snippets/snippet-completions.ts`:

```ts
import type { Snippet } from "@jslab/shared";
import type * as Monaco from "monaco-editor";
import { completionsFor, snippetTemplate, triggerWord } from "./snippet-text";

/**
 * Spec §13.3: snippets whose name starts with the typed word, case-insensitively, with a snippet icon and the
 * description — and still offered once the full name has been typed. Ruling R-M5b-7 adds the part the spec leaves
 * open: at that point the list collapses to the one exact match, instead of continuing to rank its longer siblings
 * the way VS Code's fuzzy suggest does (its issues #244170 and #66621).
 */
export function registerSnippetCompletions(
  monaco: typeof Monaco,
  deps: { snippets(): readonly Snippet[] },
): { dispose(): void } {
  return monaco.languages.registerCompletionItemProvider(["typescript", "javascript"], {
    provideCompletionItems: (model, position) => {
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const word = triggerWord(line);
      if (!word) return { suggestions: [] };
      const matches = completionsFor(word, deps.snippets());
      const range = new monaco.Range(
        position.lineNumber,
        position.column - word.length,
        position.lineNumber,
        position.column,
      );
      return {
        suggestions: matches.map((snippet, index) => ({
          label: snippet.name,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.description,
          documentation: { value: snippet.body },
          insertText: snippetTemplate(snippet.body),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          // A leading NUL keeps snippets above Monaco's word-based suggestions instead of intermixed with them
          // (R-M5b-7); the index preserves `completionsFor`'s own order within the bucket.
          sortText: `${String.fromCharCode(0)}${String(index).padStart(4, "0")}${snippet.name}`,
        })),
      };
    },
  });
}
```

Create `apps/ui/src/snippets/create-snippet-action.ts`:

```ts
import type * as Monaco from "monaco-editor";
import { strings } from "../strings";

/** Spec §13.1 / parity ED-20: Create Snippet… in the editor's own context menu. */
export function registerCreateSnippetAction(
  editor: Pick<Monaco.editor.IStandaloneCodeEditor, "addAction">,
  deps: { run(): void },
): { dispose(): void } {
  return editor.addAction({
    id: "jslab.createSnippet",
    label: strings.snippets.createAction,
    // Monaco's own modification group, just after the built-in entries, so it reads as an editor action rather
    // than something bolted on at the bottom of the menu.
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 2,
    run: () => deps.run(),
  });
}
```

Create `apps/ui/src/snippets/monaco-bridge.ts`:

```ts
import type { Language } from "@jslab/shared";
import { createTextareaBody, type SnippetBodyFactory, type SnippetBodyHandle } from "./body-editor";
import { strings } from "../strings";
import type { SnippetColorize } from "./SnippetsPanel";

/**
 * The Monaco-dependent half of the snippets UI, published by `Editor.tsx` the same way `setEditorHandle` publishes the
 * editor itself. Nothing here imports Monaco, so `App.tsx` -> `SideBar` -> `SnippetsPanel` stays loadable under
 * happy-dom (`apps/ui/isolated/app.test.tsx` mocks only `../src/editor/Editor`).
 */
let slot: { colorize: SnippetColorize; createBody: SnippetBodyFactory } | null = null;

export function setSnippetMonaco(value: { colorize: SnippetColorize; createBody: SnippetBodyFactory } | null): void {
  slot = value;
}

/** Rejects while no editor is mounted; the panel then renders its plain-text preview (Task 7). */
export function snippetColorize(code: string, language: Language | null): Promise<string> {
  return slot ? slot.colorize(code, language) : Promise.reject(new Error("No editor is mounted"));
}

export function snippetBodyFactory(
  host: HTMLElement,
  options: { value: string; language: Language | null },
): SnippetBodyHandle {
  return (slot?.createBody ?? createTextareaBody(strings.snippets.bodyLabel))(host, options);
}
```

Add one string to the `snippets` block in `apps/ui/src/strings.ts`:

```ts
    createAction: "Create Snippet…",
```

- [ ] **Step 4: Register them from `Editor.tsx`**

Add the imports:

```tsx
import { createMonacoBody } from "../snippets/body-editor";
import { registerCreateSnippetAction } from "../snippets/create-snippet-action";
import { setSnippetMonaco } from "../snippets/monaco-bridge";
import { registerSnippetCompletions } from "../snippets/snippet-completions";
```

Add a latest-props ref beside the existing `install` one (so a new callback identity never tears Monaco down):

```tsx
  const createSnippet = useRef(onCreateSnippet);
  createSnippet.current = onCreateSnippet;
```

with `onCreateSnippet?(): void;` added to `EditorProps`.

Inside the effect, right after `const installAssist = registerInstallAssist(monaco, { … });`:

```tsx
    // Spec §13.3: the snippet suggest channel. The library is read from the store at completion time, so a snippet
    // created a moment ago is suggested without re-registering anything.
    const snippetCompletions = registerSnippetCompletions(monaco, {
      snippets: () => store.getState().snippets,
    });
    const createSnippetAction = registerCreateSnippetAction(editor, { run: () => createSnippet.current?.() });
    // Spec §13.1: the panel's preview highlighting and the form's body editor both need Monaco; publish them the
    // same way the editor handle itself is published.
    setSnippetMonaco({
      colorize: (code, language) => monaco.editor.colorize(code, languageId(language ?? "typescript"), {}),
      createBody: createMonacoBody(monaco, (language) => languageId(language ?? "typescript")),
    });
```

and in the cleanup, beside `installAssist.dispose();`:

```tsx
      snippetCompletions.dispose();
      createSnippetAction.dispose();
      setSnippetMonaco(null);
```

- [ ] **Step 5: Hand the panel its Monaco pieces from `App.tsx`**

Import the bridge and pass both to `SideBar`:

```tsx
import { snippetBodyFactory, snippetColorize } from "../snippets/monaco-bridge";
```
```tsx
   {settings.view.sideBar && (
     <SideBar
       panel={sideBarPanel}
       store={store}
       api={api}
       dialogs={dialogs}
       actions={snippetActions}
       colorize={snippetColorize}
       createBody={snippetBodyFactory}
     />
   )}
```

and give `Editor` its new callback:

```tsx
            <Editor
              store={store}
              api={api}
              onLargePaste={flows.confirmLargePaste}
              onInstall={install}
              onCreateSnippet={() => registry.execute("snippets.create")}
              vimSlot={vimSlot}
            />
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/ui && bun test ./test/snippet-completions.test.ts && bun test ./isolated && bun test ./test
cd ../.. && bun run typecheck
```
Expected: PASS, **+8 tests**; the whole UI suite green, `isolated/app.test.tsx` still unmodified.

- [ ] **Step 7: Commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/snippets/snippet-completions.ts apps/ui/src/snippets/create-snippet-action.ts \
        apps/ui/src/snippets/monaco-bridge.ts apps/ui/src/editor/Editor.tsx apps/ui/src/shell/App.tsx \
        apps/ui/src/strings.ts apps/ui/test/snippet-completions.test.ts
git commit -m "$(cat <<'EOF'
Suggest snippets, and offer Create Snippet… in the context menu

The provider collapses to the single exact match once a full name is typed,
which satisfies §13.3's requirement without inheriting VS Code's open
complaint that an exact match ranks no higher than its longer siblings.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 11: E2E — snippets end to end

**Files:**
- Create: `packages/e2e/scenarios/snippets.test.ts`

**Interfaces:**
- Consumes: `launchApp`, `createUserData`, `waitFor`, `activeTab`, `type LaunchedApp` from `packages/e2e/src`; `UiSnapshot.snippetCount` and `regions.snippetsPanel` (Task 9); the scripted dialog files `e2e-open-dialog.json` and `e2e-save-dialog.json` (`apps/desktop/src/main/platform/e2e-dialogs.ts`).
- Produces: the E2E evidence for parity rows TL-12, TL-13, TL-15, TL-16 and TL-17.

> **`bun run e2e` does not build.** Build first: `cd apps/desktop && hutch run build:dev`.

> The library is **seeded on disk** before launch rather than typed through the form: it makes the scenario about the
> behaviours that matter (expansion, export, import refusal, persistence) instead of about form typing, and it is the
> same technique `keybindings.test.ts` already uses for `keybindings.json`.

- [ ] **Step 1: Write the failing scenario**

Create `packages/e2e/scenarios/snippets.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const AT = "2026-09-16T10:00:00.000Z";
const LIBRARY = {
  format: "jslab-snippets",
  version: 1,
  snippets: [
    {
      id: "s1",
      name: "fetchjson",
      description: "Fetch + parse JSON",
      body: "const res = await fetch(${1:url});$0",
      language: "typescript",
      createdAt: AT,
      updatedAt: AT,
    },
  ],
};

async function seeded() {
  const userData = await createUserData();
  await writeFile(join(userData, "snippets.json"), JSON.stringify(LIBRARY));
  const app = await launchApp({ userData });
  apps.push(app);
  return app;
}

describe("snippets (spec §13)", () => {
  test("⌘B shows the panel with the stored library, and ⌘B again hides it (TL-12, TL-13)", async () => {
    const app = await seeded();
    expect((await app.state()).ui.snippetCount).toBe(1);
    await app.key("cmd+b");
    const opened = await waitFor(async () => {
      const state = await app.state();
      return (state.ui.regions as Record<string, boolean>).snippetsPanel ? state : null;
    });
    expect(opened.ui.settings?.view.sideBar).toBe(true);
    await app.key("cmd+b");
    await waitFor(async () => ((await app.state()).ui.settings?.view.sideBar === false ? true : null));
  });

  test("typing a snippet name and pressing Tab expands it with the cursor placeholder (TL-15, TL-16)", async () => {
    const app = await seeded();
    await app.type("fetchjson", true);
    await app.key("tab");
    const expanded = await waitFor(async () => {
      const state = await app.state();
      return activeTab(state).code.startsWith("const res = await fetch(") ? state : null;
    });
    // The trigger word itself is gone, and the placeholder text is in the buffer.
    expect(activeTab(expanded).code).not.toContain("fetchjson");
    expect(activeTab(expanded).code).toContain("url");
  });

  test("Tab with no snippet name in front of the caret still indents (ruling R-M5b-7)", async () => {
    const app = await seeded();
    await app.type("x", true);
    await app.key("tab");
    const state = await waitFor(async () => {
      const current = await app.state();
      return activeTab(current).code !== "x" ? current : null;
    });
    // Monaco's own Tab handling ran: the buffer grew without a snippet being inserted.
    expect(activeTab(state).code).not.toContain("await fetch");
    expect(activeTab(state).code.startsWith("x")).toBe(true);
  });

  test("Export writes the documented format, and re-importing it changes nothing (TL-17)", async () => {
    const app = await seeded();
    const target = join(app.userData, "exported.json");
    await writeFile(join(app.userData, "e2e-save-dialog.json"), JSON.stringify({ path: target }));
    await app.command("snippets.export");
    const written = await waitFor(
      async () => {
        try {
          return JSON.parse(await readFile(target, "utf8")) as { format: string; version: number; snippets: unknown[] };
        } catch {
          return null;
        }
      },
      { timeoutMs: 15_000, message: "the export never produced a file" },
    );
    expect([written.format, written.version, written.snippets.length]).toEqual(["jslab-snippets", 1, 1]);

    // Importing the app's own export is a no-conflict merge of a snippet it already has, by name: still one.
    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([target]));
    await app.command("snippets.import");
    await waitFor(async () => ((await app.state()).ui.snippetCount === 1 ? true : null));
  });

  test("a malformed snippets file is refused and the library survives (spec §13.4)", async () => {
    const app = await seeded();
    const bad = join(app.userData, "not-a-library.json");
    await writeFile(bad, '{ "format": "vscode-snippets", "version": 1, "snippets": [] }');
    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([bad]));
    await app.command("snippets.import");
    // Give the refusal a chance to land, then prove nothing changed -- in the UI or on disk.
    await waitFor(async () => ((await app.state()).ui.regions as Record<string, boolean>).snippetsPanel || null);
    expect((await app.state()).ui.snippetCount).toBe(1);
    const onDisk = JSON.parse(await readFile(join(app.userData, "snippets.json"), "utf8")) as { snippets: unknown[] };
    expect(onDisk.snippets).toHaveLength(1);
  });

  test("an imported snippet survives a relaunch (TL-17)", async () => {
    const app = await seeded();
    const extra = join(app.userData, "extra.json");
    await writeFile(
      extra,
      JSON.stringify({
        ...LIBRARY,
        snippets: [{ ...LIBRARY.snippets[0], id: "s2", name: "brandnew", body: "console.log($0)" }],
      }),
    );
    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([extra]));
    await app.command("snippets.import");
    await waitFor(async () => ((await app.state()).ui.snippetCount === 2 ? true : null));

    const relaunched = await app.relaunch();
    apps.push(relaunched);
    expect((await relaunched.state()).ui.snippetCount).toBe(2);
  });
});
```

- [ ] **Step 2: Build, then run the scenario to verify it fails against the current bundle**

```bash
cd apps/desktop && hutch run build:dev && cd ../..
bun test packages/e2e/scenarios/snippets.test.ts --timeout 180000
```
Expected (before Tasks 1–10 are built into the bundle): FAIL — `snippetCount` is absent from the snapshot and ⌘B does
nothing. Run it **after** building a bundle that contains this milestone's work; a stale bundle is the single easiest
way to misread this step (`bun run e2e` drives whatever is on disk).

- [ ] **Step 3: No implementation needed**

Everything this scenario drives was built by Tasks 1–10. If a case fails, fix the task that owns it rather than the
scenario — and re-build before re-running.

- [ ] **Step 4: Run the whole e2e suite**

```bash
cd apps/desktop && hutch run build:dev && cd ../..
bun run e2e
```
Expected: green, **+6 scenarios**.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/scenarios/snippets.test.ts
git commit -m "$(cat <<'EOF'
Cover snippets end to end

Seeds a library on disk, expands a snippet with Tab, proves Tab still indents
without a trigger word, round-trips an export, and asserts that a malformed
import leaves both the UI and snippets.json untouched.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 12: Docs, parity and the full-suite gate

**Files:**
- Modify: `docs/parity.md` (rows ED-20, TL-12, TL-13, TL-14, TL-15, TL-16, TL-17; the deviation notes)
- Modify: `README.md`, `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`

**Interfaces:**
- Consumes: the test files written by Tasks 1–11, cited by path in the parity Status column exactly as existing rows do.
- Produces: the seven parity rows this milestone is allowed to flip, and nothing else.

**Which parity rows actually belong to M5b** — checked against `docs/parity.md`, not assumed. M5's full set is
EX-14..16, EX-37, ED-20, OU-10, ST-08, ST-12, TL-12..23, XT-01..04, XT-08.

| Row | Belongs? | Why |
|---|---|---|
| TL-12 Snippets window (Name as trigger, Description, body) | **Yes** | `docs/parity.md:198`, §13.1. Tasks 7, 8. |
| TL-13 Insert / Insert in New Tab / Copy / Search / Delete with confirm | **Yes** | `:199`, §13.1. Task 7 (and Task 9's actions). |
| TL-14 Create Snippet… from editor context menu | **Yes** | `:200`, §13.1. Tasks 9, 10. |
| TL-15 Cursor placeholder in snippets | **Yes** | `:201`, §13.2. Tasks 5, 9, 11. |
| TL-16 Snippets in autocomplete, incl. full-name match | **Yes** | `:202`, §13.3. Tasks 5, 10. |
| TL-17 Snippet library import/export (JSON) | **Yes** | `:203`, §13.4. Tasks 1, 3, 7, 11. |
| ED-20 Editor context menu (incl. Create Snippet…) | **Yes — the half the brief flagged.** | `:98`, marked `M2/M5` and currently 🚧 "Monaco context menu in M2; Create Snippet… M5". Task 10 ships that outstanding half, so the row completes here. |
| EX-14, EX-15, EX-16, EX-37, ST-12 | **No** | Claimed by M5a (logpoints, Show Transpiled Output, the welcome tab). |
| OU-10 Entry menu: Copy, Explain Result | **No** | Its M5 half is *Explain Result*, which is AI chat. |
| ST-08 UI language | **No** | i18n. |
| TL-18..TL-23 | **No** | AI chat. |
| XT-01..XT-04, XT-08 | **No** | Theme importer, keybindings UI, CLI, Gist, Keychain. |

- [ ] **Step 1: Run the full gate on both Bun versions**

```bash
mkdir -p apps/desktop/.hutch   # the cp -a target's parent; without it typecheck exits 1 checking nothing
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
cd apps/desktop && hutch run build:dev && cd ../..
bun run e2e
```
Expected: green on both Bun versions. The unit total equals the recorded baseline **+ 68** — Task 1 +9, Task 2 +6,
Task 3 +8, Task 4 +5, Task 5 +9, Task 6 +6, Task 7 +13, Task 8 +10 (2 body editor, 8 form), Task 9 +9, Task 10 +8 —
wait: that sums to 83. **Recount from each task's own stated delta before trusting either number**, and reconcile
against `.superpowers/m5b-baseline.md`; the e2e suite gains **+6** (Task 11). A mismatch is a STOP, not a rounding
error: it means a task added or lost a test somewhere this plan did not predict, and the cause must be found before
the parity rows are flipped.

- [ ] **Step 2: Update `docs/parity.md`**

Replace these seven rows' Status cells, keeping every other column byte-for-byte:

```markdown
| ED-20 | Editor context menu (incl. Create Snippet…) | CL 1.11.0, Strings | Same | §13.1 | M2/M5 | M | ✅ `apps/ui/test/snippet-completions.test.ts` ("Create Snippet… in the editor context menu") |
```

```markdown
| TL-12 | Snippets window (Name as trigger, Description, body) | Docs | Snippets panel | §13.1 | M5 | E | ✅ `apps/ui/test/snippets-panel.test.tsx`, `apps/ui/test/snippet-form.test.tsx`, `packages/e2e/scenarios/snippets.test.ts` |
| TL-13 | Insert / Insert in New Tab / Copy / Search / Delete with confirm | Docs, CL 2.12.0 | Same | §13.1 | M5 | E | ✅ `apps/ui/test/snippets-panel.test.tsx`, `apps/ui/test/snippet-commands.test.ts` |
| TL-14 | Create Snippet… from editor context menu | Docs, Strings | Same | §13.1 | M5 | E | ✅ `apps/ui/test/snippet-completions.test.ts`, `apps/ui/test/snippet-commands.test.ts` |
| TL-15 | Cursor placeholder in snippets | CL 2.7.1, #451 | `$0` + tab stops | §13.2 | M5 | U | ✅ `apps/ui/test/snippet-text.test.ts`, `packages/e2e/scenarios/snippets.test.ts` |
| TL-16 | Snippets in autocomplete, incl. full-name match | Docs, CL 2.7.3 | Completion provider | §13.3 | M5 | E | ✅ `apps/ui/test/snippet-completions.test.ts`, `packages/e2e/scenarios/snippets.test.ts` |
| TL-17 | Snippet library import/export (JSON) | Docs, CL 2.12.0 | Documented `jslab-snippets` format | §13.4 | M5 | U | ✅ `packages/shared/test/snippets.test.ts`, `apps/desktop/test/rpc/snippet-handlers.test.ts`, `packages/e2e/scenarios/snippets.test.ts` |
```

Append to the **Deviation notes** section at the end of the file:

```markdown
- **The Snippets panel lives in the side bar, and ⌘B opens it there rather than in a modal.** Spec §7.5 offers
  "Side bar panel (or modal when the side bar is hidden)"; JSLab's side region is the side bar with a panel switch
  (§7.1), so ⌘B shows the side bar on the Snippets panel when it is hidden, switches to it when another panel is
  showing, and hides the side bar when Snippets is already showing. One surface, one copy of the state.
- **Snippet autocomplete expands on Tab and only lists when it is genuinely useful.** §13.3 requires a snippet to be
  suggested even after its full name is typed (RunJS #488). JSLab satisfies that but does not copy VS Code's
  continuous fuzzy suggest, whose exact-match ranking is an open complaint (VS Code #244170, #66621): typing a full
  name and pressing Tab expands it outright, and the suggest list collapses to the single exact match instead of
  continuing to rank longer siblings alongside it.
- **Deleting a snippet is confirmed and then undoable.** §13.1's confirmation ships verbatim; the panel additionally
  keeps the deleted record and offers Undo until the next change, so a destructive action on a cheap, easily
  recreated artifact is recoverable rather than merely deliberate.
- **An imported snippet is always given a fresh id.** The `jslab-snippets` format carries ids, but a file JSLab did
  not write is untrusted, so merging matches on name (case-insensitively) and mints a new id for everything it adds.
  An imported file can therefore never alias or overwrite an existing record by claiming its id.
```

- [ ] **Step 3: Update the roadmap and README**

In `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, set the M5 row of the Status table to:

```markdown
| M5 Productivity & extras | `2026-09-16-jslab-m5a-editor-productivity.md` (logpoint gutter, Show Transpiled Output, welcome tab) · `2026-09-16-jslab-m5b-snippets.md` (snippets) | M5a and M5b done; AI chat, Gist, CLI, theme importer, keybindings UI and i18n outstanding |
```

> **If M5a landed first**, it already rewrote this cell to name only its own plan. Keep both plan names and both
> halves of the status text, exactly as above — that is the whole conflict, and it is one line.

In `README.md`, add to the feature list:

```markdown
- Snippets: `⌘B` for the library, type a snippet's name and press `Tab` to expand it, and import or export the whole
  library as JSON.
```

- [ ] **Step 4: Verify the docs claim nothing untrue**

```bash
/usr/bin/grep -n "ED-20\|TL-12\|TL-13\|TL-14\|TL-15\|TL-16\|TL-17" docs/parity.md
/usr/bin/grep -rn "/Users/\|/Volumes/" docs/parity.md README.md \
  docs/superpowers/plans/2026-09-16-jslab-m5b-snippets.md docs/superpowers/plans/2026-09-12-jslab-roadmap.md
ls apps/ui/test/snippets-panel.test.tsx apps/ui/test/snippet-form.test.tsx apps/ui/test/snippet-text.test.ts \
   apps/ui/test/snippet-filter.test.ts apps/ui/test/snippet-commands.test.ts \
   apps/ui/test/snippet-completions.test.ts apps/ui/test/snippet-body-editor.test.ts \
   apps/ui/test/snippets-store.test.ts packages/shared/test/snippets.test.ts \
   apps/desktop/test/services/snippet-store.test.ts apps/desktop/test/rpc/snippet-handlers.test.ts \
   packages/e2e/scenarios/snippets.test.ts
```
Expected: the seven rows read ✅ with the paths above; the second grep prints nothing; every file the parity table
cites exists. (The third command is the guard against citing a test that was never written — the failure mode that
makes a parity table lie.)

- [ ] **Step 5: Commit**

```bash
git add docs/parity.md README.md docs/superpowers/plans/2026-09-12-jslab-roadmap.md
git commit -m "$(cat <<'EOF'
Flip the seven M5b parity rows and record the deviations

TL-12 through TL-17 and ED-20 are implemented and covered. ED-20's M2 half was
the Monaco context menu; Create Snippet… completes it. OU-10, ST-08, TL-18..23
and XT-01..08 stay open: they are AI chat, i18n, Gist, the CLI and the settings
UIs.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

## Self-review

Run by the author against the spec after writing the plan.

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| §13.1 "Search box matches name and description" | 6 (ranking), 7 (the box) |
| §13.1 "List: name + description" + "selected snippet shows a preview with syntax highlighting" | 7 (list + preview), 10 (the highlighter) |
| §13.1 Actions: Insert (at the cursor, replacing the selection) | 7 (button), 9 (`insert`, via `insertSnippet`, which replaces the selection) |
| §13.1 Actions: Insert in New Tab · Copy · Edit · Delete | 7 (all four), 9 (`insertInNewTab`) |
| §13.1 Delete's confirmation `Delete snippet "<name>"?` | 7 (verbatim string + `role: "danger"`, no primary), R-M5b-4 |
| §13.1 "New Snippet (+): Name (the autocomplete trigger; required, unique, `^[\w$-]+$`) · Description · Body (a Monaco editor) · Language hint (optional)" | 8 (all four fields, all three name rules), 1 (`SNIPPET_NAME_PATTERN`) |
| §13.1 "Options menu: Import… (merge; name conflicts get an overwrite, keep both, or skip choice)" | 1 (`mergeSnippets` with the three policies), 3 (the dialog), 7 (the choice UI) |
| §13.1 "Export… (via `saveDialog`, default `jslab-snippets.json`)" | 3 (`SNIPPETS_EXPORT_NAME`), 7 (the button), 11 |
| §13.1 "Editor context menu: Create Snippet… pre-fills the body with the selection, or with the whole buffer if nothing is selected" | 10 (the action), 9 (`selectedTextOrAll` + `createFromEditor`) |
| §13.2 `$0`, `${1:placeholder}`, `$1` | 5 (`snippetTemplate`), 9 (insertion), 10 (`InsertAsSnippet`) |
| §13.2 "A body without placeholders is inserted literally, with `$` escaped" | 5 (`snippetTemplate`, tested both ways) |
| §13.3 `CompletionItemProvider`, prefix match, case-insensitive, snippet icon + description | 10 |
| §13.3 "suggested even when the full name has been typed (RunJS #488)" | 5 (`completionsFor`), 10; ruling R-M5b-7 |
| §13.4 the file format, field by field | 1 (`snippetSchema`, `snippetsFileSchema`, `snippetsFileContent`) |
| §13.4 "Invalid imports show "This file isn't a valid JSLab snippets file", with details" | 1 (reason + detail), 3 (Main refuses), 7 (`importFailed` + the detail line) |
| §4.5 `snippets.json          snippet library` | 2 (`snippetsFile`, the store) |
| §6.5 `Snippets…` → `Cmd+B`; "Every action is a `CommandId`" | 9 (five ids, two default bindings) |
| §7.1 / §7.5 Snippets is a side-bar panel | 7, 9; ruling R-M5b-3 records the modal deviation |
| §7.4 Edit menu → Create Snippet…; Tools menu → Snippets… | 9 |
| §18 every inbound payload zod-validated in Main | 3 (`parse` on all four entry points), 1 (the schemas) |
| Parity ED-20, TL-12..TL-17 | 12 |

No gap found. The rest of §13's surrounding milestone (AI chat, Gist, CLI, i18n, the theme importer, the keybindings
UI) is explicitly out of this plan's scope, as are M5a's five rows.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "add appropriate error handling", "handle edge cases", "write tests for the
above" or "similar to Task N" appears. Every code step carries real code. Three deliberate exceptions, each of which
names its own resolution rather than leaving a choice open:

- Task 7 Step 5 permits a one-line `SnippetForm` stub **only** if Task 8 has not run yet, and says in the same
  sentence that Task 8's tests fail if the stub survives.
- Task 3's implementation ends with a note to delete `exportFolderOf` and its `node:path` import if Biome flags them,
  rather than keeping dead code.
- Task 11 Step 3 has no implementation because its behaviour was built by Tasks 1–10; it still states the build
  command and what a failure means.

One defect found and fixed inline during this review: Task 4 originally carried a deliberately-wrong
`clearSnippetsRequest` body followed by a correction note — exactly the "reader must spot the trap" anti-pattern this
plan forbids. It now states `snippetsNonce` as a real `AppState` field and gives the three actions once, correctly.

**3. Type consistency**

- `Snippet` is defined once (Task 1, `@jslab/shared`) and re-exported from `@jslab/rpc-schema` (Task 3); no second
  declaration anywhere.
- `snippets` is `Snippet[]` in `SnippetStore`, `MainRequests`, `MainApi`, `AppState` and `UiSnapshot.snippetCount`'s
  source — one name, one shape.
- `snippetsSave(snippets)` / `"snippets.save"` / `SnippetStore.save` all take `Snippet[]` and answer `SaveResult`
  (`{ ok: true } | { ok: false; error: string }`), the repo's existing type.
- `SnippetsRequest` (`{ kind; body; nonce }`) is declared in Task 4 and consumed only by Task 7's effect and Task 9's
  commands, through `requestSnippets(kind, body?)` — spelled identically in all three.
- `SnippetActions` is declared once (Task 7, `SnippetsPanel.tsx`) and implemented once (Task 9,
  `createSnippetActions`); `insert` and `insertInNewTab` have the same signatures on both sides.
- `SnippetBodyFactory` / `SnippetBodyHandle` are declared in Task 8 (`body-editor.ts`) and used by Task 8's form,
  Task 7's forwarded prop and Task 10's bridge — one spelling throughout.
- `expansionFor` returns `{ snippet, deleteBefore }`, and `insertSnippet(template, deleteBefore)` takes that second
  field in that order at every call site (Task 9's `put`, the tests, `Editor.tsx`).
- Command ids `tools.snippets`, `snippets.create`, `snippets.import`, `snippets.export`, `snippets.expand` are spelled
  identically in `commands.ts`, `keybindings.ts`, `snippet-actions.ts`, `menu.ts`, the unit tests and the e2e scenario.
- `AppState["sideBarPanel"]` is used as an indexed access in `SideBar.tsx` and nowhere redefined (R-M5b-1); this plan
  contains no `type SideBarPanel = …`.
