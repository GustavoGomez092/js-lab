# JSLab M5a: Editor productivity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three editor-productivity features of M5 — the logpoint gutter UI (spec §6.3), Show Transpiled Output (spec §7.4), and the first-run welcome tab (spec §7.5) — on top of the logpoint transform that already shipped in M1.

**Architecture:** Logpoints become per-tab UI state (`TabRuntime.logpoints`), never persisted, mirrored onto the active tab like `code` and `output`. A framework-free module computes gutter decorations and reads sticky line numbers back; a thin Monaco attachment owns the glyph-margin click, the decorations collection and the readback, exactly as `install-assist.ts` splits pure logic from its Monaco registration. `run.start` finally carries the lines it has always had a field for. Show Transpiled Output adds one Main request, `run.transpiled`, served from the last successful transform the `RunCoordinator` performed for that tab; hiding instrumentation re-runs the *same* transform with `autoLog: false`, `logpoints: []` and `loopProtection: false` rather than regex-stripping generated code. The welcome tab is written by `SessionStore.open` on a genuinely first launch — no session file and no backup — so it needs no new persisted flag.

**Tech Stack:** Bun 1.4.0 (bundled) / 1.3.13 (dev), Electrobun 2.0.1, React 19, Zustand 5, Monaco 0.56, zod 4, `@babel/standalone` 8, bun:test, happy-dom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md` — §5.5 (logpoints are virtual trailing `//?` markers; hollow when the line has no loggable statement), §6.3 (the logpoint gutter, `F9`, `Cmd+Shift+F9`, stickiness, Auto Run on change), §7.4 (the Edit and Actions menus; Show Transpiled Output), §7.5 (the first-run welcome tab), §10.1 (logpoints are not persisted), Appendix A (`run.start`, `run.transpiled`).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Clean room.** Never read, unpack or inspect RunJS binaries, `app.asar`, bundled JS, or `/Applications/RunJS.app`. Parity comes from the spec and public docs only.
- **Exact values, copied verbatim from the spec:**
  - §6.3: "Clicking the glyph margin toggles a logpoint, shown as a filled dot, or hollow when the line has no loggable statement."
  - §6.3: "`F9` toggles the current line, and `Cmd+Shift+F9` clears all."
  - §6.3: "Logpoints are tracked as Monaco decorations with `stickiness`, so they follow their lines through edits (fixes RunJS #731)."
  - §6.3: "Any logpoint change triggers Auto Run."
  - §6.5 default keybindings table: `Toggle Logpoint / Clear All Logpoints` → `F9` / `Cmd+Shift+F9`.
  - §5.5: "**Logpoints** are virtual trailing `//?` markers on the given lines. They reuse the magic-comment attachment on the **innermost statement that starts on that line**. A logpoint on a line with no loggable statement is shown hollow, with a tooltip."
  - §7.4: "**Show Transpiled Output** opens a read-only side tab with the latest Babel output for the current tab. It updates on each run, and a toggle hides the instrumentation calls."
  - §7.4 Edit menu: "… Toggle Line Comment · Toggle Block Comment · Toggle Magic Comment · Toggle Logpoint · Clear All Logpoints · Create Snippet… · Clear Output · Clear Editor"
  - §7.4 Actions menu: "Run · Stop · Kill · Format Code · Set Working Directory… · Clear Working Directory · Runtime ▸ … · Language ▸ … · Show Transpiled Output"
  - §7.5: "First run | A welcome tab with sample code showing Auto Log, `//?`, logpoints, fetch, and a React snippet"
  - §10.1: "Logpoints are **not** persisted, which matches RunJS's documented behavior."
  - Appendix A: `'run.transpiled': { params: { tabId: string; hideInstrumentation: boolean }; response: { code: string } }`
- **Establish the baseline before Task 1 and never fabricate it.** This worktree has no `node_modules`. Run, from the worktree root:
  ```bash
  bun install --frozen-lockfile
  bun run lint
  bun run typecheck   # see the devkit note below
  bun run test
  ```
  Record the pass/fail totals per package in `.superpowers/m5a-baseline.md`. Every task below states its own **delta** in tests; a total that does not match baseline + deltas is a STOP, not a rounding error.
- **Never run a bare `bun test` at the repo root.** Always `bun run test`.
- **UI tests need the DOM preload.** `apps/ui/bunfig.toml` preloads `./test/setup-dom.ts`, and `bun test <path>` from the repo root skips it. The only correct form is `cd apps/ui && bun test ./test/<file>`. `apps/ui/isolated/` runs as its own process (`bun test ./isolated`) because it installs module mocks.
- **The two-Bun gate is easy to fake.** `bun14 run test` uses 1.4.0 only as the task runner; each package's script is `bun test ./test`, so the inner binary still comes from `PATH`. The real form is:
  ```bash
  PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
  ```
- **Typecheck needs the devkit copied, and its parent does not exist in a fresh worktree.** Run `mkdir -p apps/desktop/.hutch` before the `cp -a` that populates it. Without the directory, `bun run typecheck` exits 1 **without checking anything**, which reads as a failure but is really a no-op.
- **Biome truncates diagnostics by default.** Always `bun run lint -- --max-diagnostics=300` (or `bunx biome check . --max-diagnostics=300`).
- **`bun run e2e` does NOT build.** It drives whatever bundle is on disk. Any e2e step must build first: `cd apps/desktop && hutch run build:dev`. **Never run the hutch installer, `hutch init` or `hutch upgrade`** — the toolchain is pinned at 0.24.3; use the absolute toolchain path when you need a specific Bun.
- **Never modify** `~/.zshrc`, `~/.npmrc`, `~/.bunfig.toml`, the Bun cache, or anything under `~/Library`.
- **Never contact the public npm registry in tests.** Loopback Verdaccio only (`packages/test-registry`). No task in this plan needs the registry at all.
- **No personal paths** (`/Users/...`, `/Volumes/...`) in any committed file.
- **No new runtime dependency.** Every feature here is built from what the repo already has.
- **RPC discipline:** every new UI-reachable entry point goes through `createValidators`' `parse`/`message` (`apps/desktop/src/main/rpc/validate.ts`); request names are globally unique across merged handler groups.
- **Persistence:** logpoints are never written to `session.json`, `buffers/`, or any other file. No `SESSION_VERSION` or `SETTINGS_VERSION` bump is needed by this milestone; if you think you need one, you have mis-designed something.
- **Strings:** no hard-coded user-visible text in components. UI strings go in `apps/ui/src/strings.ts`; Main strings go in `apps/desktop/src/main/strings.ts` (both exist for the M5 i18n extraction).
- **Commit hygiene:** one commit per task, staged explicitly by path, on branch `feat/jslab-m5a`. Do not merge, push, or force-push. End every commit message with:
  ```
  Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
  ```

---

## As-built survey

Read this before Task 1. Everything below was verified by reading the worktree at `30da6e3`, not assumed.

### The M1 logpoint transform — already shipped, do not reimplement

`packages/transform/src/index.ts` exports exactly:

```ts
export { DEFAULT_BUILD_OPTIONS, proposalPlugins } from "./build";
export { toDiagnostic, transform } from "./transform";
export type * from "./types";
export { createWorkingDirectoryPlugin } from "./working-directory";
```

The entry point is `transform(source: string, options: TransformOptions): TransformResult` (`packages/transform/src/transform.ts`), with these types (`packages/transform/src/types.ts`):

```ts
export interface TransformOptions {
  language: Language;
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  logpoints: readonly number[];
  build?: BuildOptions;
  workingDirectory?: WorkingDirectoryOptions;
}

export type DiagnosticCode =
  | "syntax" | "reserved-identifier" | "magic-comment-no-value"
  | "magic-comment-invalid-expression" | "logpoint-no-value" | "too-many-warnings";

export type TransformResult =
  | { ok: true; code: string; map: RawSourceMap; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
```

`packages/transform/src/instrument.ts` turns each requested line into a virtual line marker (`parseMarkers`, `source: "logpoint"`), defers to a real `//?` already on that line, resolves it to the innermost statement **starting** on that line (`resolveLineMarker`), and — when no statement qualifies — emits `{ severity: "warning", code: "logpoint-no-value", message: "Logpoint has no value to log on this line", line, column: 1 }`. It is covered by `packages/transform/test/transform.test.ts` (`describe("logpoints")`, 5 tests). **This milestone adds no transform code.**

That diagnostic is the hollow-dot signal: it already reaches the UI on every run as `run.diagnostics` → `AppState.diagnostics` (`DiagnosticPayload[]`, fields `severity`, `code`, `message`, `line`, `column`).

### Tabs, side tabs and the tab bar

- `packages/shared/src/session.ts` owns `tabStateSchema` / `TabState` (id, title, titleIsCustom, language, runtime, filePath, lastSavedHash, workingDirectory, gistId, layout, viewState) and `createTab(overrides)`, `defaultSession(newTab)`, `normalizeSession(session, newTab)`. `SESSION_VERSION` is 3.
- The tab **bar** is `apps/ui/src/tabs/TabBar.tsx`, driven by `TabActions` (`apps/ui/src/tabs/tab-actions.ts`).
- There is no "side tab" concept in the repo. The **side bar** is: `AppState.sideBarPanel: "snippets" | "ai"`, `setSideBarPanel`, `apps/ui/src/shell/SideBar.tsx` (a placeholder `<aside className="side-bar">`), an `ActivityBar` button per panel, and `App.tsx`'s `togglePanel`. Its visibility is the persisted setting `view.sideBar`. **Ruling R-M5a-6 below makes Show Transpiled Output a third side-bar panel rather than inventing a new region.**
- Per-tab runtime state lives in `AppState.runtimes: Record<string, TabRuntime>` (`apps/ui/src/state/store.ts`), created by `newRuntime()` and mirrored onto the active tab by `mirrorOf()`. This is the natural, non-persisted home for logpoints.

### How Auto Run is triggered today, and what the run pipeline hands back

- `apps/ui/src/state/auto-run.ts` → `startAutoRun(store, run, timers)` subscribes to the store and schedules `run()` after `settings.run.autoRunDelayMs` (default 300) when `shouldAutoRun(state)` holds and one of `state.code`, `state.tab.language`, `state.tab.runtime` changed. `shouldAutoRun` = `run.autoRun` on **and** not Safe Mode **and** `autoRunArmed`. `setRuntime` arms auto-run itself (spec §5.2); `setLanguage` does not.
- `App.tsx`'s `run(reason)` builds the request and today sends **`logpoints: []` hard-coded** (`apps/ui/src/shell/App.tsx:161`). That literal is the whole gap on the wire.
- `runStartParamsSchema` (`packages/rpc-schema/src/ui-rpc.ts:39`) already validates `logpoints: z.array(z.number().int().positive()).max(10_000)`, and `createRpcHandlers`' `run.start` already forwards them to `RunCoordinator.start`, which passes them to `transform` and to `createEventMapper(map, entry, new Set(request.logpoints))`. `apps/desktop/test/runs/run-coordinator.test.ts` already proves a logpoint result is labeled `source: "logpoint"` end to end. **Main is finished; only the UI never sends a line.**
- The pipeline hands back three streams per tab: `run.events` (`RunEvent[]`, including `{ kind: "result"; source: "logpoint" }`), `run.state`, and `run.diagnostics` (`DiagnosticPayload[]`). Nothing hands back the transpiled code — that is what Task 7 adds.

### The command registry and default keymap (built in M2)

- `packages/shared/src/commands.ts` — the `COMMANDS` catalogue (`as const satisfies readonly CommandMeta[]`), `CommandId`, `commandMeta`, `isCommandId`. Every menu item, key, palette row and E2E call dispatches one of these ids. There is **no** logpoint or transpiled command today.
- `packages/shared/src/keybindings.ts` — `DEFAULT_KEYBINDINGS`, `parseChord` (already accepts `f1`–`f12`; `packages/shared/test/keybindings.test.ts` asserts `parseChord("f9")`), `resolveKeybindings`, `shortcutFor`.
- `apps/ui/src/commands/registry.ts` — `CommandRegistry` with `CommandSpec { id; run(args?); isEnabled?(); description?() }`.
- `apps/ui/src/keybindings/resolver.ts` — the single `keydown` dispatcher, with `UiContext` `{ editorFocus, outputFocus, modalOpen, paletteOpen, dialogOpen, textInputFocus }` and `when` clauses evaluated by `apps/ui/src/keybindings/when.ts`.
- `apps/desktop/src/main/menu.ts` — `buildMenu(model)`; menu items carry `menuAction(commandId)` and are dispatched back to the UI as `menu.command`.
- **So `F9` must be registered as a `CommandId` plus a `DEFAULT_KEYBINDINGS` row, never as an ad-hoc listener.**

### Monaco decorations today

Almost none. The complete set of decoration/glyph usage in `apps/ui/src`:

- `apps/ui/src/editor/Editor.tsx:64` — `glyphMargin: true` is **already on** in the editor's construction options.
- `apps/ui/src/editor/Editor.tsx:126` — `const hover = editor.createDecorationsCollection();`, set to a single whole-line `className: "line-hover"` decoration for the output hover link, cleared with `[]`.
- `apps/ui/src/editor/markers.ts` — squiggles, but those are **markers** (`monaco.editor.setModelMarkers`), not decorations.
- No `deltaDecorations`, no `TrackedRangeStickiness`, no `onMouseDown`, no `MouseTargetType` anywhere.

`Editor.tsx` is a 448-line `useEffect` that cannot run under happy-dom, so every testable piece of editor behaviour in this repo lives in a framework-free module with its own unit test (`tab-view.ts`, `models.ts`, `markers.ts`, `view-state.ts`), or is tested against a hand-rolled Monaco fake (`apps/ui/test/install-assist.test.ts`). **This plan follows that split exactly.**

### Rulings recorded for this milestone

- **R-M5a-1 — a logpoint-triggered run reports `reason: "auto"`.** Spec Appendix A sketches `reason: 'auto'|'manual'|'cli'|'logpoint'`, but the shipped `runStartParamsSchema` accepts only `"auto" | "manual"`, and Main's Safe-Mode defence refuses exactly `reason === "auto"`. Adding a `"logpoint"` reason would create a run reason that Safe Mode does not refuse. Logpoint changes therefore go out as `"auto"`. **This is a spec-vs-code conflict; it is resolved in favour of the code and recorded in `docs/parity.md` deviation notes in Task 12.**
- **R-M5a-2 — hollow comes from the transform's own diagnostic.** A logpoint is hollow exactly when the latest run's diagnostics contain `code === "logpoint-no-value"` on that line. No second source of truth, and no new transform work.
- **R-M5a-3 — "hide instrumentation" re-transforms instead of stripping.** `hideInstrumentation: true` returns `transform(source, { ...sameOptions, autoLog: false, logpoints: [], loopProtection: false })`. Regex-stripping `__jl.log(...)` / `__jl.mc(...)` out of generated code cannot be done correctly (nested calls, string contents, the `__jl.mc` value pass-through) and would be untestable. The transform host is LRU-cached (`CachingTransformHost`, 50 entries), so the second transform is cheap.
- **R-M5a-4 — the welcome tab's language is `tsx`, and its `fetch` and React samples are commented.** The tab must show a React snippet, which is only valid in `tsx`. Nothing on a restored or newly created tab is ever armed for Auto Run (`autoRunArmed: false`), so nothing runs at launch — but pressing Run on a welcome tab with a live `fetch` would make a network call out of a first-run demo, and would make the e2e scenario network-dependent. Both samples ship commented, each with a one-line instruction.
- **R-M5a-5 — first run is `primary === "missing" && recovered === "none"`.** `loadJson` (`apps/desktop/src/main/persistence/json-store.ts`) returns that pair **only** when neither `session.json` nor `session.json.bak` could be read as missing files. A corrupt file returns `recovered: "defaults"`, and a file recovered from backup returns `"backup"` — neither is a first run, and neither should replace the user's tabs with a welcome tab.
- **R-M5a-6 — Show Transpiled Output is a side-bar panel.** The spec calls it a "side tab"; the repo has a side bar with a panel switch and no tab concept beyond editor tabs. A third panel (`"transpiled"`) reuses the existing region, its persisted visibility setting and its E2E region probe.
- **R-M5a-7 — the transpiled panel must show an explicit stale state.** *(Added by the controller after the plan was committed; it does **not** overturn R-M5a-3 — re-transforming stays.)* The panel refreshes on the active tab's `runId`, so it is correct immediately after a run. Between an edit and the next run it silently shows output for code the user is no longer looking at, and in Safe Mode — where nothing is armed for Auto Run (R-M5a-1) — that window is unbounded rather than one debounce interval. A silently-stale read-only mirror is this surface's worst failure mode: the user cannot tell correct output from old output, and nothing on screen says which they are reading. **Requirement:** when the active tab's current source differs from the source that produced the displayed output, the panel shows a visible header state (`Stale — run to refresh`) and the E2E scenario asserts it appears after an edit and clears after the next run. The comparison must be against the source that produced the output, not a timestamp. Design research: `m5-ui-patterns.md`, surface 4, which takes this from Chrome DevTools' Ignore List / source-map blackboxing treatment of derived views.

---

## File Structure

**New**

| Path | Responsibility |
|---|---|
| `apps/ui/src/editor/logpoints.ts` | Framework-free: decoration descriptors for a line set, which lines are hollow, and normalising line numbers read back from sticky ranges. |
| `apps/ui/src/editor/logpoint-gutter.ts` | The thin Monaco attachment: glyph-margin click, the decorations collection with `stickiness`, and the readback after edits. |
| `apps/ui/src/output/TranspiledPanel.tsx` | The read-only transpiled-output side panel with its "Hide instrumentation" toggle. |
| `apps/desktop/src/main/welcome.ts` | The first-run welcome tab's title and sample code. |
| `apps/ui/test/logpoints.test.ts` | Unit tests for both logpoint modules (the gutter against a Monaco fake). |
| `apps/ui/test/transpiled-panel.test.tsx` | Unit tests for the panel. |
| `packages/e2e/scenarios/logpoints.test.ts` | EX-14, EX-15, EX-16 against a built app. |
| `packages/e2e/scenarios/welcome.test.ts` | EX-37 and ST-12 against a built app. |

**Modified**

| Path | Change |
|---|---|
| `apps/ui/src/state/store.ts` | `TabRuntime.logpoints`; `toggleLogpoint` / `setLogpoints` / `clearLogpoints`; the `logpoints` mirror; `SideBarPanel` widened to include `"transpiled"`. |
| `apps/ui/src/state/auto-run.ts` | A logpoint change is a run trigger. |
| `apps/ui/src/shell/App.tsx` | Send the tab's logpoints in `run.start`; register the three new commands; pass `store`/`api` to `SideBar`; the new E2E region. |
| `apps/ui/src/editor/Editor.tsx` | Attach and dispose the logpoint gutter. |
| `apps/ui/src/styles.css` | `.logpoint-glyph`, `.logpoint-glyph-hollow`, `.transpiled-panel` and friends. |
| `apps/ui/src/strings.ts` | `strings.logpoints`, `strings.transpiled`. |
| `apps/ui/src/shell/SideBar.tsx`, `ActivityBar.tsx` | The widened panel union; the transpiled panel render. |
| `apps/ui/src/e2e/snapshot.ts` | `logpoints` per tab; `sideBarPanel`. |
| `apps/ui/src/api.ts`, `apps/ui/src/rpc.ts`, `apps/ui/test/fake-api.ts` | The `transpiled` request. |
| `packages/shared/src/commands.ts`, `keybindings.ts` | `edit.toggleLogpoint`, `edit.clearLogpoints`, `view.showTranspiled`; `f9` and `cmd+shift+f9`. |
| `packages/rpc-schema/src/ui-rpc.ts` | `runTranspiledParamsSchema`, `RunTranspiledParams`, the `run.transpiled` entry in `MainRequests`. |
| `apps/desktop/src/main/runs/run-coordinator.ts` | Remember each tab's last successful transform; serve `transpiled(tabId, hideInstrumentation)`. |
| `apps/desktop/src/main/rpc-handlers.ts` | The `run.transpiled` request handler. |
| `apps/desktop/src/main/menu.ts` | Edit → Toggle Logpoint / Clear All Logpoints; Actions → Show Transpiled Output. |
| `apps/desktop/src/main/services/session-store.ts`, `main-services.ts` | The first-run welcome tab. |
| `docs/parity.md`, `README.md`, `docs/superpowers/plans/2026-09-12-jslab-roadmap.md` | Status rows, in the final task. |

---

## Task index

| # | Task | Deliverable |
|---|---|---|
| 1 | Logpoint state in the store | Per-tab, non-persisted logpoints with toggle/set/clear, mirrored and snapshotted. |
| 2 | Logpoints on the wire, and Auto Run on change | `run.start` carries real lines; a logpoint change schedules a run. |
| 3 | The framework-free gutter model | Decoration descriptors, hollow detection, sticky-range readback. |
| 4 | The Monaco gutter attachment | Glyph-margin click toggles; decorations survive edits; CSS. |
| 5 | Commands, keymap and the Edit menu | `F9`, `Cmd+Shift+F9`, palette rows, menu items. |
| 6 | E2E: logpoints | EX-14, EX-15, EX-16 against a built app. |
| 7 | `run.transpiled` in Main | The last Babel output per tab, with and without instrumentation. |
| 8 | The transpiled side panel | Read-only panel, refreshed per run, with the toggle. |
| 9 | Show Transpiled Output command and Actions menu | The command, the menu item, the open-panel behaviour. |
| 10 | The first-run welcome tab | Sample code on a genuinely first launch only. |
| 11 | E2E: transpiled output and welcome | EX-37, ST-12 against a built app. |
| 12 | Docs, parity and the full-suite gate | Parity rows flipped, README, roadmap, both Bun versions. |

---

### Task 1: Logpoint state in the store

**Files:**
- Modify: `apps/ui/src/state/store.ts` (`TabRuntime` at 26-42, `newRuntime` at 46, `AppState` at 150-265, `mirrorOf` at 284-294, the returned actions)
- Modify: `apps/ui/src/e2e/snapshot.ts` (`TabSnapshot`, `snapshotState`)
- Test: `apps/ui/test/store.test.ts`

**Interfaces:**
- Consumes: `createAppStore()`, `TabRuntime`, `newRuntime()`, `updateRuntime`, `commit` — all existing in `apps/ui/src/state/store.ts`.
- Produces:
  - `TabRuntime.logpoints: number[]` — ascending, unique, **never persisted**.
  - `AppState.logpoints: number[]` — the active tab's mirror.
  - `AppState.toggleLogpoint(line: number, tabId?: string): void` — arms Auto Run.
  - `AppState.clearLogpoints(tabId?: string): void` — arms Auto Run.
  - `AppState.setLogpoints(lines: readonly number[], tabId?: string): void` — reconciliation after an edit; keeps the previous array identity when the set is unchanged, and does **not** arm Auto Run.
  - `TabSnapshot.logpoints: number[]` in `apps/ui/src/e2e/snapshot.ts`.

- [ ] **Step 1: Write the failing test**

Append to `apps/ui/test/store.test.ts`, inside the existing `describe("app store", …)`:

```ts
  test("logpoints are per tab, sorted, unique, and toggling one arms auto-run (spec §6.3, §10.1)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().openTab(createTab({ id: "t2" }), "", false);

    expect(store.getState().logpoints).toEqual([]);
    store.getState().toggleLogpoint(3);
    store.getState().toggleLogpoint(1);
    expect(store.getState().logpoints).toEqual([1, 3]);
    expect(shouldAutoRun(store.getState())).toBe(true);
    // A second toggle of the same line removes it.
    store.getState().toggleLogpoint(3);
    expect(store.getState().logpoints).toEqual([1]);
    // A background tab keeps its own set.
    store.getState().toggleLogpoint(9, "t2");
    expect(store.getState().logpoints).toEqual([1]);
    expect(store.getState().runtimes.t2?.logpoints).toEqual([9]);

    store.getState().clearLogpoints();
    expect(store.getState().logpoints).toEqual([]);
    expect(store.getState().runtimes.t2?.logpoints).toEqual([9]);
  });

  test("setLogpoints reconciles sticky lines without arming auto-run, and keeps identity when unchanged", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setLogpoints([2]);
    expect(store.getState().logpoints).toEqual([2]);
    // Reconciliation is not a user action: it must not arm Auto Run on its own.
    expect(shouldAutoRun(store.getState())).toBe(false);

    const before = store.getState().logpoints;
    store.getState().setLogpoints([2]);
    expect(store.getState().logpoints).toBe(before);
    store.getState().setLogpoints([5, 2, 5]);
    expect(store.getState().logpoints).toEqual([2, 5]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/store.test.ts`
Expected: FAIL — `store.getState().toggleLogpoint is not a function`.

- [ ] **Step 3: Write the implementation**

In `apps/ui/src/state/store.ts`, add the field to `TabRuntime` (after `audioActive`):

```ts
  /**
   * Task 1 (spec §6.3, §10.1): the tab's logpoint lines, ascending and unique. Deliberately per-tab UI state and
   * never part of `TabState`: spec §10.1 says logpoints are not persisted, so they live here with `output` and
   * `diagnostics` rather than anywhere `session.json` can see them.
   */
  logpoints: number[];
```

Extend `newRuntime`:

```ts
export const newRuntime = (): TabRuntime => ({
  output: freshOutput(),
  diagnostics: [],
  autoRunArmed: false,
  audioActive: false,
  logpoints: [],
});
```

Add a module-level constant beside `NO_DIAGNOSTICS`:

```ts
const NO_LOGPOINTS: number[] = [];
```

Add the normaliser above `createAppStore`:

```ts
/** Ascending and unique; returns `previous` unchanged when the set is identical, so subscribers don't re-run. */
function normalizeLogpoints(previous: number[], lines: readonly number[]): number[] {
  const next = [...new Set(lines)].sort((a, b) => a - b);
  if (next.length === previous.length && next.every((line, index) => line === previous[index])) return previous;
  return next;
}
```

In the `AppState` interface, add the mirror beside `diagnostics`:

```ts
  logpoints: number[];
```

and the three actions beside `clearOutput`:

```ts
  /** Spec §6.3: adds or removes a logpoint on `line` and arms Auto Run, so the change triggers a run. */
  toggleLogpoint(line: number, tabId?: string): void;
  /** Spec §6.3 (`Cmd+Shift+F9`): drops every logpoint on the tab and arms Auto Run. */
  clearLogpoints(tabId?: string): void;
  /**
   * Reconciliation from the editor's sticky decorations after an edit moved them (spec §6.3). Not a user action:
   * it never arms Auto Run, and an unchanged set keeps the previous array identity.
   */
  setLogpoints(lines: readonly number[], tabId?: string): void;
```

In `mirrorOf`, add to the returned object:

```ts
    logpoints: runtime?.logpoints ?? NO_LOGPOINTS,
```

In the initial state object (beside `diagnostics: NO_DIAGNOSTICS`):

```ts
      logpoints: NO_LOGPOINTS,
```

And the implementations, after `clearOutput`:

```ts
      toggleLogpoint(line, tabId) {
        const id = resolve(tabId);
        if (!id || !Number.isInteger(line) || line < 1) return;
        updateRuntime(id, (runtime) => {
          const has = runtime.logpoints.includes(line);
          const lines = has ? runtime.logpoints.filter((candidate) => candidate !== line) : [...runtime.logpoints, line];
          return { ...runtime, logpoints: normalizeLogpoints(runtime.logpoints, lines), autoRunArmed: true };
        });
      },

      clearLogpoints(tabId) {
        const id = resolve(tabId);
        if (!id) return;
        updateRuntime(id, (runtime) =>
          runtime.logpoints.length === 0 ? runtime : { ...runtime, logpoints: [], autoRunArmed: true },
        );
      },

      setLogpoints(lines, tabId) {
        const id = resolve(tabId);
        if (!id) return;
        updateRuntime(id, (runtime) => {
          const logpoints = normalizeLogpoints(runtime.logpoints, lines.filter((line) => Number.isInteger(line) && line >= 1));
          return logpoints === runtime.logpoints ? runtime : { ...runtime, logpoints };
        });
      },
```

In `apps/ui/src/e2e/snapshot.ts`, add `logpoints: number[];` to `TabSnapshot` (after `autoRunArmed`) and, in the per-tab object built by `snapshotState`:

```ts
        logpoints: state.runtimes[id]?.logpoints ?? [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/ui && bun test ./test/store.test.ts`
Expected: PASS, **+2 tests**.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/state/store.ts apps/ui/src/e2e/snapshot.ts apps/ui/test/store.test.ts
git commit -m "$(cat <<'EOF'
Keep each tab's logpoints in the UI store

Logpoints are per-tab UI state and are never persisted (spec §10.1), so they
live beside output and diagnostics in TabRuntime rather than in TabState.
Toggling or clearing arms Auto Run; reconciling sticky lines after an edit
does not.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 2: Logpoints on the wire, and Auto Run on change

**Files:**
- Modify: `apps/ui/src/state/auto-run.ts` (the `changed` expression)
- Modify: `apps/ui/src/shell/App.tsx` (the `run` callback, line 157-164)
- Test: `apps/ui/test/logic.test.ts` (the existing `describe("startAutoRun", …)`)
- Test: `apps/ui/isolated/app.test.tsx` (the existing `"Cmd+R starts a manual run with the current code"`)

**Interfaces:**
- Consumes: `AppState.logpoints`, `AppState.toggleLogpoint` (Task 1); `startAutoRun(store, run, timers)`; `runStartParamsSchema`'s existing `logpoints` field.
- Produces: `run.start` requests whose `logpoints` are the active tab's lines. Per **R-M5a-1** the `reason` stays `"auto"` for a logpoint-triggered run.

- [ ] **Step 1: Write the failing tests**

Add to `apps/ui/test/logic.test.ts`, inside `describe("startAutoRun", …)`:

```ts
  test("toggling a logpoint schedules a run on its own, without a prior edit (spec §6.3)", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().toggleLogpoint(1);
    expect(clock.pending.size).toBe(1);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);

    store.getState().clearLogpoints();
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("reconciling sticky logpoint lines never schedules a run of its own", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().setLogpoints([4]);
    expect(clock.pending.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  test("toggling a logpoint in Safe Mode never schedules a run", () => {
    const run = mock(() => {});
    const clock = manualTimers();
    const safe = hydratedStore(true);
    startAutoRun(safe, run, clock.timers);
    safe.getState().toggleLogpoint(1);
    expect(clock.pending.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
```

In `apps/ui/isolated/app.test.tsx`, replace the body of `"Cmd+R starts a manual run with the current code"` with:

```ts
  test("Cmd+R starts a manual run with the current code and the tab's logpoints", () => {
    const { store, api } = renderApp();
    act(() => store.getState().toggleLogpoint(1));
    press("KeyR");
    expect(api.startRun).toHaveBeenCalledWith({
      tabId: "t1",
      code: "1 + 1",
      language: "typescript",
      logpoints: [1],
      reason: "manual",
      // DEFAULT_RUNTIME, which M4 Task 9a returned to "bun" until browser runs finish.
      runtime: "bun",
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/ui && bun test ./test/logic.test.ts && bun test ./isolated/app.test.tsx`
Expected: FAIL — the auto-run tests see `clock.pending.size === 0`, and the isolated test reports `logpoints: []` where `[1]` was expected.

- [ ] **Step 3: Write the implementation**

In `apps/ui/src/state/auto-run.ts`, extend the `changed` expression inside the subscription:

```ts
    const changed =
      state.code !== previous.code ||
      state.tab?.language !== previous.tab?.language ||
      state.tab?.runtime !== previous.tab?.runtime ||
      // Spec §6.3: "Any logpoint change triggers Auto Run." Like a runtime switch, the toggle arms auto-run
      // itself (store.ts's toggleLogpoint/clearLogpoints), so this fires without a prior edit. Reconciling
      // sticky lines after an edit keeps the previous array identity when the set is unchanged, so a plain
      // edit does not reach this twice.
      state.logpoints !== previous.logpoints;
```

In `apps/ui/src/shell/App.tsx`, inside `start()`, replace the hard-coded literal:

```ts
        void api.startRun({
          tabId,
          code,
          language: freshTab.language,
          // Spec §6.3 / §5.5: the tab's own logpoint lines, read at send time like `code` above, so a toggle
          // that landed while a format was in flight is still included.
          logpoints: fresh.runtimes[tabId]?.logpoints ?? [],
          reason,
          runtime: freshTab.runtime,
        });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/ui && bun test ./test/logic.test.ts && bun test ./isolated/app.test.tsx`
Expected: PASS, **+3 tests** in `logic.test.ts`, 0 net in `app.test.tsx` (one test rewritten).

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/state/auto-run.ts apps/ui/src/shell/App.tsx apps/ui/test/logic.test.ts apps/ui/isolated/app.test.tsx
git commit -m "$(cat <<'EOF'
Send the tab's logpoints, and run when they change

run.start has carried a logpoints field since M1 and the UI always sent an
empty array, so the shipped transform never saw a line. It now sends the tab's
own lines, and a toggle or a clear schedules a run the way a runtime switch
does (spec §6.3).

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 3: The framework-free gutter model

**Files:**
- Create: `apps/ui/src/editor/logpoints.ts`
- Modify: `apps/ui/src/strings.ts` (a new `logpoints` group, after `install`)
- Test: `apps/ui/test/logpoints.test.ts` (new)

**Interfaces:**
- Consumes: `DiagnosticPayload` from `@jslab/rpc-schema` (`{ severity, code, message, line, column }`); `AppState.diagnostics` (Task 1's neighbour, unchanged).
- Produces, from `apps/ui/src/editor/logpoints.ts`:
  - `const LOGPOINT_GLYPH = "logpoint-glyph"` and `const LOGPOINT_GLYPH_HOLLOW = "logpoint-glyph logpoint-glyph-hollow"`
  - `interface LogpointDecoration { line: number; hollow: boolean; glyphMarginClassName: string; hoverMessage: string }`
  - `function hollowLogpointLines(diagnostics: readonly DiagnosticPayload[]): ReadonlySet<number>`
  - `function logpointDecorations(lines: readonly number[], hollow: ReadonlySet<number>): LogpointDecoration[]`
  - `function linesFromRanges(ranges: readonly { startLineNumber: number }[]): number[]`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/logpoints.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { DiagnosticPayload } from "@jslab/rpc-schema";
import {
  hollowLogpointLines,
  LOGPOINT_GLYPH,
  LOGPOINT_GLYPH_HOLLOW,
  linesFromRanges,
  logpointDecorations,
} from "../src/editor/logpoints";
import { strings } from "../src/strings";

const diagnostic = (overrides: Partial<DiagnosticPayload>): DiagnosticPayload => ({
  severity: "warning",
  code: "logpoint-no-value",
  message: "Logpoint has no value to log on this line",
  line: 1,
  column: 1,
  ...overrides,
});

describe("logpoint model (spec §5.5, §6.3)", () => {
  test("a line the transform reported as having no value to log is hollow", () => {
    const hollow = hollowLogpointLines([
      diagnostic({ line: 2 }),
      diagnostic({ line: 7 }),
      // Any other diagnostic on a line leaves it filled: only logpoint-no-value means "nothing to log here".
      diagnostic({ code: "magic-comment-no-value", line: 4 }),
      diagnostic({ code: "syntax", severity: "error", line: 5 }),
    ]);
    expect([...hollow].sort((a, b) => a - b)).toEqual([2, 7]);
    expect(hollowLogpointLines([])).toEqual(new Set());
  });

  test("decorations are filled by default and hollow with a tooltip where there is nothing to log", () => {
    expect(logpointDecorations([1, 2], new Set([2]))).toEqual([
      { line: 1, hollow: false, glyphMarginClassName: LOGPOINT_GLYPH, hoverMessage: strings.logpoints.tooltip },
      {
        line: 2,
        hollow: true,
        glyphMarginClassName: LOGPOINT_GLYPH_HOLLOW,
        hoverMessage: strings.logpoints.noValue,
      },
    ]);
    expect(logpointDecorations([], new Set([2]))).toEqual([]);
  });

  test("lines read back from sticky ranges are ascending, unique and 1-based", () => {
    expect(linesFromRanges([{ startLineNumber: 5 }, { startLineNumber: 2 }, { startLineNumber: 5 }])).toEqual([2, 5]);
    expect(linesFromRanges([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/logpoints.test.ts`
Expected: FAIL — `Cannot find module '../src/editor/logpoints'`.

- [ ] **Step 3: Write the implementation**

Add to `apps/ui/src/strings.ts`, immediately after the `install` group:

```ts
  logpoints: {
    /** Spec §6.3: the glyph-margin dot's tooltip. */
    tooltip: "Logpoint — this line's value is shown in the output",
    /** Spec §5.5: "A logpoint on a line with no loggable statement is shown hollow, with a tooltip." */
    noValue: "Logpoint has no value to log on this line",
    toggle: "Toggle Logpoint",
    clearAll: "Clear All Logpoints",
  },
```

Create `apps/ui/src/editor/logpoints.ts`:

```ts
import type { DiagnosticPayload } from "@jslab/rpc-schema";
import { strings } from "../strings";

/** The filled dot in the glyph margin (spec §6.3). */
export const LOGPOINT_GLYPH = "logpoint-glyph";
/** The hollow dot: a logpoint on a line with nothing to log (spec §5.5). */
export const LOGPOINT_GLYPH_HOLLOW = "logpoint-glyph logpoint-glyph-hollow";

/** The transform's own "nothing to log here" warning (packages/transform/src/instrument.ts). */
const NO_VALUE_CODE = "logpoint-no-value";

export interface LogpointDecoration {
  line: number;
  hollow: boolean;
  glyphMarginClassName: string;
  hoverMessage: string;
}

/**
 * Which logpoint lines are hollow, per R-M5a-2: exactly the lines the latest run's transform reported as having
 * no loggable statement. The transform is the single source of truth — the UI never re-parses the code to guess.
 */
export function hollowLogpointLines(diagnostics: readonly DiagnosticPayload[]): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === NO_VALUE_CODE) lines.add(diagnostic.line);
  }
  return lines;
}

/** One decoration descriptor per logpoint line, in the order given. Framework-free, so it is unit-tested. */
export function logpointDecorations(
  lines: readonly number[],
  hollow: ReadonlySet<number>,
): LogpointDecoration[] {
  return lines.map((line) => {
    const isHollow = hollow.has(line);
    return {
      line,
      hollow: isHollow,
      glyphMarginClassName: isHollow ? LOGPOINT_GLYPH_HOLLOW : LOGPOINT_GLYPH,
      hoverMessage: isHollow ? strings.logpoints.noValue : strings.logpoints.tooltip,
    };
  });
}

/**
 * The line numbers a decorations collection currently holds, after Monaco's `stickiness` moved them through an
 * edit (spec §6.3, RunJS #731). Ascending and unique: two logpoints can be pushed onto the same line by a join.
 */
export function linesFromRanges(ranges: readonly { startLineNumber: number }[]): number[] {
  return [...new Set(ranges.map((range) => range.startLineNumber))].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/ui && bun test ./test/logpoints.test.ts`
Expected: PASS, **+3 tests**.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/editor/logpoints.ts apps/ui/src/strings.ts apps/ui/test/logpoints.test.ts
git commit -m "$(cat <<'EOF'
Model the logpoint gutter without Monaco

Decoration descriptors, hollow detection and sticky-range readback are pure
functions with their own tests, the same split install-assist.ts uses. A
logpoint is hollow exactly when the transform warned there is nothing to log
on that line, so the UI never re-parses the code to guess.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 4: The Monaco gutter attachment

**Files:**
- Create: `apps/ui/src/editor/logpoint-gutter.ts`
- Modify: `apps/ui/src/editor/Editor.tsx` (beside the `hover` collection at 126-134, the store subscription at 363-421, and the cleanup at 425-444)
- Modify: `apps/ui/src/styles.css` (after `.line-hover`)
- Test: `apps/ui/test/logpoints.test.ts` (extend)

**Interfaces:**
- Consumes: `logpointDecorations`, `hollowLogpointLines`, `linesFromRanges` (Task 3); `AppState.logpoints`, `setLogpoints`, `toggleLogpoint` (Task 1).
- Produces, from `apps/ui/src/editor/logpoint-gutter.ts`:
  ```ts
  export interface LogpointGutterDeps {
    lines(): readonly number[];
    hollow(): ReadonlySet<number>;
    toggle(line: number): void;
    reconcile(lines: number[]): void;
  }
  export interface LogpointGutter {
    render(): void;
    dispose(): void;
  }
  export function attachLogpointGutter(
    monaco: typeof Monaco,
    editor: Monaco.editor.IStandaloneCodeEditor,
    deps: LogpointGutterDeps,
  ): LogpointGutter;
  ```

- [ ] **Step 1: Write the failing test**

Append to `apps/ui/test/logpoints.test.ts`:

```ts
import type * as Monaco from "monaco-editor";
import { attachLogpointGutter } from "../src/editor/logpoint-gutter";

/**
 * A minimal `monaco` fake: the two enum members the gutter reads, a Range constructor, a decorations collection
 * that remembers what it was handed, and an `onMouseDown` we can drive. The same shape as `fakeMonaco()` in
 * install-assist.test.ts — enough to run the attachment, nothing more.
 */
function fakeEditorHost() {
  const collection = {
    decorations: [] as { range: { startLineNumber: number }; options: Record<string, unknown> }[],
    ranges: [] as { startLineNumber: number }[],
    set(next: { range: { startLineNumber: number }; options: Record<string, unknown> }[]) {
      this.decorations = next;
      this.ranges = next.map((decoration) => decoration.range);
    },
    getRanges() {
      return this.ranges;
    },
    clear() {
      this.decorations = [];
      this.ranges = [];
    },
  };
  let mouseDown: ((event: unknown) => void) | null = null;
  let contentChanged: (() => void) | null = null;
  const disposed: string[] = [];
  const editor = {
    createDecorationsCollection: () => collection,
    onMouseDown: (listener: (event: unknown) => void) => {
      mouseDown = listener;
      return { dispose: () => disposed.push("mouseDown") };
    },
    onDidChangeModelContent: (listener: () => void) => {
      contentChanged = listener;
      return { dispose: () => disposed.push("content") };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const monaco = {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    },
  } as unknown as typeof Monaco;
  return {
    monaco,
    editor,
    collection,
    disposed,
    clickGutter: (lineNumber: number) => mouseDown?.({ target: { type: 2, position: { lineNumber } } }),
    clickText: (lineNumber: number) => mouseDown?.({ target: { type: 6, position: { lineNumber } } }),
    edit: () => contentChanged?.(),
  };
}

describe("logpoint gutter (spec §6.3)", () => {
  test("a glyph-margin click toggles that line, and a click in the text does nothing", () => {
    const host = fakeEditorHost();
    const toggled: number[] = [];
    attachLogpointGutter(host.monaco, host.editor, {
      lines: () => [],
      hollow: () => new Set(),
      toggle: (line) => toggled.push(line),
      reconcile: () => {},
    });
    host.clickGutter(4);
    host.clickText(9);
    expect(toggled).toEqual([4]);
  });

  test("render() sets one sticky decoration per line, hollow where there is nothing to log", () => {
    const host = fakeEditorHost();
    let lines: number[] = [2, 5];
    const gutter = attachLogpointGutter(host.monaco, host.editor, {
      lines: () => lines,
      hollow: () => new Set([5]),
      toggle: () => {},
      reconcile: () => {},
    });
    gutter.render();
    expect(
      host.collection.decorations.map((decoration) => [
        decoration.range.startLineNumber,
        decoration.options.glyphMarginClassName,
        decoration.options.stickiness,
      ]),
    ).toEqual([
      [2, LOGPOINT_GLYPH, 1],
      [5, LOGPOINT_GLYPH_HOLLOW, 1],
    ]);
    lines = [];
    gutter.render();
    expect(host.collection.decorations).toEqual([]);
  });

  test("an edit reconciles the store with where the sticky decorations actually moved to", () => {
    const host = fakeEditorHost();
    const reconciled: number[][] = [];
    const gutter = attachLogpointGutter(host.monaco, host.editor, {
      lines: () => [2],
      hollow: () => new Set(),
      toggle: () => {},
      reconcile: (next) => reconciled.push(next),
    });
    gutter.render();
    // Monaco moved the decoration down two lines while the user typed above it.
    host.collection.ranges = [{ startLineNumber: 4 }];
    host.edit();
    expect(reconciled).toEqual([[4]]);
    gutter.dispose();
    expect(host.disposed.sort()).toEqual(["content", "mouseDown"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/logpoints.test.ts`
Expected: FAIL — `Cannot find module '../src/editor/logpoint-gutter'`.

- [ ] **Step 3: Write the implementation**

Create `apps/ui/src/editor/logpoint-gutter.ts`:

```ts
import type * as Monaco from "monaco-editor";
import { hollowLogpointLines, linesFromRanges, logpointDecorations } from "./logpoints";

export interface LogpointGutterDeps {
  /** The tab's logpoint lines right now (the store's `logpoints` mirror). */
  lines(): readonly number[];
  /** Lines the latest run reported as having nothing to log (`hollowLogpointLines`). */
  hollow(): ReadonlySet<number>;
  /** A glyph-margin click on `line`. */
  toggle(line: number): void;
  /** Where the sticky decorations ended up after an edit; the store adopts these as the new line set. */
  reconcile(lines: number[]): void;
}

export interface LogpointGutter {
  /** Rewrites the decorations from `deps.lines()` and `deps.hollow()`. */
  render(): void;
  dispose(): void;
}

/**
 * The logpoint glyph margin (spec §6.3). All the decision-making lives in `./logpoints.ts`; this file owns only
 * the Monaco objects — the collection, the mouse listener and the content listener — so it stays thin enough to
 * run against a fake in tests, exactly as `registerInstallAssist` does.
 *
 * Decorations carry `stickiness: NeverGrowsWhenTypingAtEdges`, so Monaco moves each dot with its line through
 * edits (spec §6.3, RunJS #731) instead of leaving it pinned to a line number. After each edit the decorations,
 * not the store, are the truth about where the logpoints now are, so their ranges are read back and reconciled.
 */
export function attachLogpointGutter(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  deps: LogpointGutterDeps,
): LogpointGutter {
  const collection = editor.createDecorationsCollection();

  const render = () => {
    collection.set(
      logpointDecorations(deps.lines(), deps.hollow()).map((decoration) => ({
        range: new monaco.Range(decoration.line, 1, decoration.line, 1),
        options: {
          glyphMarginClassName: decoration.glyphMarginClassName,
          glyphMarginHoverMessage: { value: decoration.hoverMessage },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  };

  const mouse = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = event.target.position?.lineNumber;
    if (line !== undefined) deps.toggle(line);
  });

  // After an edit, report where the dots actually are. `setLogpoints` keeps the previous array identity when the
  // set is unchanged (store.ts), so a plain edit that moved nothing does not schedule a second run.
  const content = editor.onDidChangeModelContent(() => {
    if (deps.lines().length === 0) return;
    deps.reconcile(linesFromRanges(collection.getRanges()));
  });

  return {
    render,
    dispose: () => {
      mouse.dispose();
      content.dispose();
      collection.clear();
    },
  };
}

export { hollowLogpointLines };
```

In `apps/ui/src/editor/Editor.tsx`, add the import beside the other editor imports:

```ts
import { attachLogpointGutter } from "./logpoint-gutter";
import { hollowLogpointLines } from "./logpoints";
```

Immediately after `const hover = editor.createDecorationsCollection();` (line 126), add:

```ts
    // Spec §6.3: the logpoint glyph margin. `glyphMargin: true` is already set in the editor options above.
    const logpoints = attachLogpointGutter(monaco, editor, {
      lines: () => store.getState().logpoints,
      hollow: () => hollowLogpointLines(store.getState().diagnostics),
      toggle: (line) => store.getState().toggleLogpoint(line),
      reconcile: (lines) => store.getState().setLogpoints(lines),
    });
```

Inside `onShown`, beside the existing `applyMarkers(store.getState());` line (a new model starts with no decorations either):

```ts
        logpoints.render();
```

Inside the store subscription, after the `hoveredLine` line:

```ts
      // A logpoint set change (a toggle, a clear, a tab switch) or a new run's diagnostics (which decide
      // filled vs hollow) both change what the margin should draw.
      if (state.logpoints !== previous.logpoints || state.diagnostics !== previous.diagnostics) {
        logpoints.render();
      }
```

And in the cleanup, beside `removePasteGuard();`:

```ts
      logpoints.dispose();
```

In `apps/ui/src/styles.css`, after the `.line-hover` rule:

```css
/* ---------- logpoint gutter (spec §6.3) ---------- */
/* Monaco sizes the glyph margin itself and applies this class to that line's margin cell; the dot is drawn with
   a radial background so no pseudo-element is needed (Monaco owns the cell's own ::before/::after). */
.logpoint-glyph {
  background: radial-gradient(circle at center, var(--fg-accent) 0 4px, transparent 4px);
  cursor: pointer;
}

/* Spec §5.5: a logpoint on a line with no loggable statement is hollow. */
.logpoint-glyph-hollow {
  background:
    radial-gradient(circle at center, transparent 0 2.5px, var(--fg-muted) 2.5px 4px, transparent 4px);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/ui && bun test ./test/logpoints.test.ts`
Expected: PASS, **+3 tests** (6 in the file).

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/editor/logpoint-gutter.ts apps/ui/src/editor/Editor.tsx apps/ui/src/styles.css apps/ui/test/logpoints.test.ts
git commit -m "$(cat <<'EOF'
Draw logpoints in the glyph margin, and keep them on their lines

Clicking the glyph margin toggles a logpoint; the dot is filled, or hollow when
the transform reported nothing to log on that line. Decorations carry
stickiness, so an edit above a logpoint moves the dot with its line instead of
stranding it (RunJS #731), and the store adopts where they actually landed.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 5: Commands, keymap and the Edit menu

**Files:**
- Modify: `packages/shared/src/commands.ts` (the `edit.*` block of `COMMANDS`)
- Modify: `packages/shared/src/keybindings.ts` (`DEFAULT_KEYBINDINGS`)
- Modify: `apps/ui/src/commands/editor-commands.ts` (`createEditorCommands`)
- Modify: `apps/ui/src/shell/App.tsx` (pass the store to `createEditorCommands`)
- Modify: `apps/desktop/src/main/menu.ts` (the Edit submenu)
- Test: `packages/shared/test/commands.test.ts`, `apps/ui/test/commands.test.ts`, `apps/desktop/test/menu.test.ts`

**Interfaces:**
- Consumes: `CommandSpec` (`apps/ui/src/commands/registry.ts`); `AppState.toggleLogpoint` / `clearLogpoints` (Task 1); `EditorHandle` (`apps/ui/src/editor/editor-handle.ts`); `item(command)` inside `buildMenu`.
- Produces:
  - `CommandId`s `"edit.toggleLogpoint"` (title `"Toggle Logpoint"`) and `"edit.clearLogpoints"` (title `"Clear All Logpoints"`), both `category: "edit"`, `context: "editor"`.
  - `DEFAULT_KEYBINDINGS` rows `{ key: "f9", command: "edit.toggleLogpoint", when: "editorFocus" }` and `{ key: "cmd+shift+f9", command: "edit.clearLogpoints" }`.
  - `createEditorCommands(editor: () => EditorHandle | null, store: AppStore): CommandSpec[]` — **the signature gains a second parameter**; `App.tsx` is its only caller.
  - `EditorHandle.getCursorLine(): number | null` — a new method on the handle, implemented in `Editor.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/test/commands.test.ts`, inside `describe("command catalogue", …)`:

```ts
  test("M5a adds the logpoint commands with the spec's chords (spec §6.3, §6.5)", () => {
    expect(commandMeta("edit.toggleLogpoint")).toMatchObject({
      title: "Toggle Logpoint",
      category: "edit",
      context: "editor",
    });
    expect(commandMeta("edit.clearLogpoints")).toMatchObject({
      title: "Clear All Logpoints",
      category: "edit",
      context: "editor",
    });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command.endsWith("Logpoint") || rule.command.endsWith("Logpoints"))).toEqual([
      { key: "f9", command: "edit.toggleLogpoint", when: "editorFocus" },
      { key: "cmd+shift+f9", command: "edit.clearLogpoints" },
    ]);
  });
```

Add to `apps/ui/test/commands.test.ts`, inside `describe("editor commands", …)`:

```ts
  test("F9's command toggles the cursor's line, and Clear All drops every logpoint (spec §6.3)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "const a = 1\nconst b = 2" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    let cursorLine: number | null = 2;
    const handle = { getCursorLine: () => cursorLine } as unknown as EditorHandle;
    const registry = new CommandRegistry();
    registry.register(...createEditorCommands(() => handle, store));

    expect(registry.execute("edit.toggleLogpoint")).toBe("executed");
    expect(store.getState().logpoints).toEqual([2]);
    registry.execute("edit.toggleLogpoint");
    expect(store.getState().logpoints).toEqual([]);

    store.getState().toggleLogpoint(1);
    store.getState().toggleLogpoint(2);
    registry.execute("edit.clearLogpoints");
    expect(store.getState().logpoints).toEqual([]);

    // With no cursor (no editor mounted) the toggle is disabled rather than guessing a line.
    cursorLine = null;
    expect(registry.execute("edit.toggleLogpoint")).toBe("executed");
    expect(store.getState().logpoints).toEqual([]);
  });
```

Add to `apps/desktop/test/menu.test.ts`, inside `describe("application menu", …)`:

```ts
  test("Edit lists Toggle Logpoint and Clear All Logpoints with their chords (spec §7.4)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Toggle Logpoint")?.label).toBe("Toggle Logpoint    F9");
    expect(byLabel(menu, "Clear All Logpoints")?.label).toBe("Clear All Logpoints    ⇧⌘F9");
    expect(byLabel(menu, "Toggle Logpoint")?.action).toBe(menuAction("edit.toggleLogpoint"));
    const labels = flatten(menu).map((item) => item.label?.split("    ")[0]);
    // Spec §7.4 orders them right after Toggle Magic Comment.
    expect(labels.indexOf("Toggle Logpoint")).toBe(labels.indexOf("Toggle Magic Comment") + 1);
    expect(labels.indexOf("Clear All Logpoints")).toBe(labels.indexOf("Toggle Logpoint") + 1);
  });
```

`apps/ui/test/commands.test.ts` needs these imports added at the top: `createTab`, `defaultSession`, `defaultSettings` are already imported from `@jslab/shared`; add `import { createAppStore } from "../src/state/store";` if it is not already present (it is imported today).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/shared && bun test ./test/commands.test.ts
cd ../../apps/ui && bun test ./test/commands.test.ts
cd ../desktop && bun test ./test/menu.test.ts
```
Expected: FAIL — `commandMeta("edit.toggleLogpoint")` is `undefined`; `createEditorCommands` takes one argument; `byLabel(menu, "Toggle Logpoint")` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `packages/shared/src/commands.ts`, after the `edit.toggleMagicComment` entry:

```ts
  { id: "edit.toggleLogpoint", title: "Toggle Logpoint", category: "edit", context: "editor" },
  { id: "edit.clearLogpoints", title: "Clear All Logpoints", category: "edit", context: "editor" },
```

In `packages/shared/src/keybindings.ts`, after the `cmd+alt+shift+/` row:

```ts
  { key: "f9", command: "edit.toggleLogpoint", when: editor },
  { key: "cmd+shift+f9", command: "edit.clearLogpoints" },
```

In `apps/ui/src/editor/editor-handle.ts`, add to the `EditorHandle` interface (after `getSelectedLineRange`):

```ts
  /** The 1-based line the caret is on, or null when nothing is mounted (spec §6.3: `F9` toggles the current line). */
  getCursorLine(): number | null;
```

In `apps/ui/src/editor/Editor.tsx`, add to the `setEditorHandle({ … })` object, beside `getCursorOffset`:

```ts
      getCursorLine: () => editor.getPosition()?.lineNumber ?? null,
```

In `apps/ui/src/commands/editor-commands.ts`, change the signature and add the two specs:

```ts
import type { CommandId } from "@jslab/shared";
import type { EditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import type { CommandSpec } from "./registry";
import { sortLinesCaseInsensitive, toggleMagicCommentLines } from "./text-edits";
```

```ts
export function createEditorCommands(editor: () => EditorHandle | null, store: AppStore): CommandSpec[] {
```

and, in the returned array after the `lineEdit("edit.toggleMagicComment", …)` entry:

```ts
    // Spec §6.3: "`F9` toggles the current line, and `Cmd+Shift+F9` clears all."
    {
      id: "edit.toggleLogpoint",
      isEnabled,
      run: () => {
        const line = editor()?.getCursorLine();
        if (line !== null && line !== undefined) store.getState().toggleLogpoint(line);
      },
    },
    {
      id: "edit.clearLogpoints",
      isEnabled: () => store.getState().logpoints.length > 0,
      run: () => store.getState().clearLogpoints(),
    },
```

In `apps/ui/src/shell/App.tsx`, update the single call site inside the registry `useMemo`:

```ts
      ...createEditorCommands(getEditorHandle, store),
```

In `apps/desktop/src/main/menu.ts`, in the Edit submenu after `item("edit.toggleMagicComment"),`:

```ts
        item("edit.toggleLogpoint"),
        item("edit.clearLogpoints"),
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/shared && bun test ./test/commands.test.ts
cd ../../apps/ui && bun test ./test/commands.test.ts
cd ../desktop && bun test ./test/menu.test.ts
```
Expected: PASS, **+1 test** each (3 total).

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add packages/shared/src/commands.ts packages/shared/src/keybindings.ts packages/shared/test/commands.test.ts \
        apps/ui/src/commands/editor-commands.ts apps/ui/src/editor/editor-handle.ts apps/ui/src/editor/Editor.tsx \
        apps/ui/src/shell/App.tsx apps/ui/test/commands.test.ts \
        apps/desktop/src/main/menu.ts apps/desktop/test/menu.test.ts
git commit -m "$(cat <<'EOF'
Bind F9 and Clear All Logpoints through the command registry

Both are CommandIds with default chords, so they reach the palette, the Edit
menu and E2E automation, and a user keybindings.json can rebind them — none of
which an ad-hoc key listener would give.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 6: E2E — logpoints

**Files:**
- Create: `packages/e2e/scenarios/logpoints.test.ts`

**Interfaces:**
- Consumes: `launchApp`, `activeTab`, `waitFor` (`packages/e2e/src`); `app.command(id)`, `app.key(spec)`, `app.type(text)`, `app.output()`, `app.state()`; `TabSnapshot.logpoints` (Task 1); the commands and chords from Task 5.
- Produces: the E2E evidence for parity rows EX-14, EX-15 and EX-16.

- [ ] **Step 1: Write the failing test**

Create `packages/e2e/scenarios/logpoints.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

describe("logpoints", () => {
  test("F9 logs the line's value, and the toggle itself triggers the run (EX-14, EX-16)", async () => {
    const app = await launchApp();
    apps.push(app);
    // Auto Log is on, so the second line reports 10 on its own; clear the output so the next entries can only
    // have come from the logpoint run.
    await app.type("const a = 5\nconst b = a * 2\nb");
    await app.waitForOutput((all) => all.some((entry) => entry.text === "10"));
    await app.command("output.clear");
    await waitFor(async () => activeTab(await app.state()).entryCount === 0 || null);

    // The caret is on the last line after typing; put a logpoint on line 2 through the real chord.
    await app.command("edit.gotoLine");
    await app.command("edit.toggleLogpoint");
    const withLogpoint = await waitFor(async () => {
      const state = await app.state();
      return activeTab(state).logpoints.length === 1 ? state : null;
    }, { message: "the logpoint never reached the store" });
    expect(activeTab(withLogpoint).logpoints).toEqual([3]);

    // EX-16: no edit happened, and output appeared anyway.
    await app.waitForOutput((all) => all.length > 0);

    // EX-14: F9 is bound to the same command and removes it again.
    await app.key("f9");
    await waitFor(async () => activeTab(await app.state()).logpoints.length === 0 || null, {
      message: "F9 never removed the logpoint",
    });
  });

  test("Clear All Logpoints empties the set, and logpoints never survive a relaunch (EX-14, EX-15)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.type("const a = 5\nconst b = a * 2");
    await app.waitForOutput((all) => all.length > 0);
    await app.command("edit.toggleLogpoint");
    await waitFor(async () => activeTab(await app.state()).logpoints.length === 1 || null);

    await app.key("cmd+shift+f9");
    await waitFor(async () => activeTab(await app.state()).logpoints.length === 0 || null, {
      message: "⇧⌘F9 never cleared the logpoints",
    });

    // EX-15: set one again, quit, and relaunch into the same data folder.
    await app.command("edit.toggleLogpoint");
    await waitFor(async () => activeTab(await app.state()).logpoints.length === 1 || null);
    await app.quit();

    const again = await launchApp({ userData: app.userData });
    apps.push(again);
    const restored = await again.state();
    expect(restored.ui.tabs.map((tab) => tab.logpoints)).toEqual([[]]);
    expect(activeTab(restored).code).toBe("const a = 5\nconst b = a * 2");
  });
});
```

- [ ] **Step 2: Build, then run the test to verify it fails**

`bun run e2e` drives whatever bundle is on disk, so build first:

```bash
cd apps/desktop && hutch run build:dev && cd ../..
bun run --cwd packages/e2e e2e -- ./scenarios/logpoints.test.ts
```
Expected: FAIL before the build exists, or — with a pre-M5a bundle — at `activeTab(...).logpoints` being `undefined`.

- [ ] **Step 3: No implementation needed; re-verify against a current build**

Tasks 1-5 supply the behaviour. Rebuild so the bundle contains them:

```bash
cd apps/desktop && hutch run build:dev && cd ../..
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd packages/e2e e2e -- ./scenarios/logpoints.test.ts`
Expected: PASS, **+2 e2e tests**.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/scenarios/logpoints.test.ts
git commit -m "$(cat <<'EOF'
Prove logpoints work in a built app

Covers the three parity rows end to end: a logpoint logs its line, the toggle
alone triggers the run with no edit, ⇧⌘F9 clears the set, and a relaunch comes
back with none — logpoints are not persisted (spec §10.1).

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 7: `run.transpiled` in Main

**Files:**
- Modify: `packages/rpc-schema/src/ui-rpc.ts` (beside `runExpandParamsSchema`; `MainRequests`)
- Modify: `apps/desktop/src/main/runs/run-coordinator.ts` (`#execute`, `disposeTab`, a new `transpiled` method)
- Modify: `apps/desktop/src/main/rpc-handlers.ts` (`RpcHandlerDeps.coordinator`, the `requests` map)
- Test: `apps/desktop/test/runs/run-coordinator.test.ts`, `apps/desktop/test/rpc-handlers.test.ts`

**Interfaces:**
- Consumes: `RunCoordinatorDeps.transform(source, options): Promise<TransformResult>`; `TransformOptions` from `@jslab/transform`; `createValidators(log).parse`.
- Produces:
  - `runTranspiledParamsSchema = z.object({ tabId, hideInstrumentation: z.boolean() })` and `type RunTranspiledParams = z.infer<typeof runTranspiledParamsSchema>` in `packages/rpc-schema/src/ui-rpc.ts`.
  - `MainRequests["run.transpiled"]: { params: RunTranspiledParams; response: { code: string } | null }`.
  - `RunCoordinator.transpiled(tabId: string, hideInstrumentation: boolean): Promise<{ code: string } | null>` — `null` when the tab has never transpiled successfully.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/test/runs/run-coordinator.test.ts`:

```ts
  test("transpiled() returns the last Babel output, and re-transforms without instrumentation on request", async () => {
    const h = harness();
    h.coordinator.start({
      tabId: "t1",
      code: "const a = 5;\na;",
      language: "typescript",
      logpoints: [1],
    });
    await waitFor(() => h.states.includes("evaluating"));

    const instrumented = await h.coordinator.transpiled("t1", false);
    expect(instrumented?.code).toContain("__jl.");

    const plain = await h.coordinator.transpiled("t1", true);
    expect(plain?.code).not.toContain("__jl.");
    expect(plain?.code).toContain("const a = 5");

    expect(await h.coordinator.transpiled("never-ran", false)).toBeNull();
  });
```

> Use this file's own existing harness helper and its `waitFor`/state helpers; the assertions above are the new
> part. If the harness names differ, keep the assertions and adapt the three setup lines to them.

Add to `apps/desktop/test/rpc-handlers.test.ts`, inside `describe("requests", …)`:

```ts
  test("run.transpiled validates its payload and forwards it to the coordinator", async () => {
    const { handlers, deps } = setup();
    expect(await handlers.requests["run.transpiled"]({ tabId: "t1", hideInstrumentation: true })).toEqual({
      code: "const a = 5;",
    });
    expect(deps.coordinator.transpiled).toHaveBeenCalledWith("t1", true);
    expect(() => handlers.requests["run.transpiled"]({ tabId: "t1" })).toThrow(InvalidPayloadError);
    expect(() => handlers.requests["run.transpiled"]({ tabId: "../escape", hideInstrumentation: false })).toThrow(
      InvalidPayloadError,
    );
  });
```

and add to that file's `setup()` coordinator mock:

```ts
      transpiled: mock(async () => ({ code: "const a = 5;" })),
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/desktop && bun test ./test/runs/run-coordinator.test.ts ./test/rpc-handlers.test.ts
```
Expected: FAIL — `h.coordinator.transpiled is not a function`; `handlers.requests["run.transpiled"] is not a function`.

- [ ] **Step 3: Write the implementation**

In `packages/rpc-schema/src/ui-rpc.ts`, after `runExpandParamsSchema`:

```ts
/** Spec §7.4 / Appendix A: the latest Babel output for a tab, optionally without the instrumentation calls. */
export const runTranspiledParamsSchema = z.object({ tabId, hideInstrumentation: z.boolean() });
```

beside the other inferred types:

```ts
export type RunTranspiledParams = z.infer<typeof runTranspiledParamsSchema>;
```

and in `MainRequests`, after `run.expand`:

```ts
  "run.transpiled": { params: RunTranspiledParams; response: { code: string } | null };
```

In `apps/desktop/src/main/runs/run-coordinator.ts`, add the remembered-transform map beside `#runs`:

```ts
  /**
   * Spec §7.4: the source and options of each tab's most recent **successful** transform, so Show Transpiled
   * Output can hand back that run's Babel output, and can re-derive it without instrumentation (R-M5a-3).
   * One entry per tab, replaced on every successful transform and dropped with the tab.
   */
  readonly #transpiled = new Map<string, { source: string; options: TransformOptions; code: string }>();
```

In `#execute`, immediately after `if (!this.#isCurrent(run)) return;` that follows the `await this.deps.transform(...)` call, capture the options into a local first. Replace the transform call and the guard with:

```ts
      const transformOptions: TransformOptions = {
        language: request.language,
        autoLog: settings.autoLog,
        loopProtection: settings.loopProtection,
        loopProtectionMaxIterations: settings.loopProtectionMaxIterations,
        logpoints: request.logpoints,
        ...(settings.build ? { build: settings.build } : {}),
        ...(workingDirectory
          ? {
              workingDirectory: {
                dir: workingDirectory,
                filename: join(workingDirectory, request.scriptName ?? "Untitled.ts"),
              },
            }
          : {}),
      };
      const result = await this.deps.transform(request.code, transformOptions);
      if (!this.#isCurrent(run)) return;
      if (result.ok) {
        this.#transpiled.set(run.tabId, { source: request.code, options: transformOptions, code: result.code });
      }
```

Add the public method after `expand`:

```ts
  /**
   * Spec §7.4: the latest Babel output for a tab. `hideInstrumentation` re-runs the same transform with Auto Log,
   * logpoints and loop protection off (R-M5a-3) rather than stripping `__jl` calls out of generated code, which
   * cannot be done correctly. The transform host is LRU-cached, so the second call is cheap and repeatable.
   */
  async transpiled(tabId: string, hideInstrumentation: boolean): Promise<{ code: string } | null> {
    const entry = this.#transpiled.get(tabId);
    if (!entry) return null;
    if (!hideInstrumentation) return { code: entry.code };
    const plain = await this.deps.transform(entry.source, {
      ...entry.options,
      autoLog: false,
      logpoints: [],
      loopProtection: false,
    });
    return plain.ok ? { code: plain.code } : null;
  }
```

In `disposeTab`, after `this.#runs.delete(tabId);`:

```ts
    this.#transpiled.delete(tabId);
```

In `apps/desktop/src/main/rpc-handlers.ts`, widen the dependency `Pick`:

```ts
  coordinator: Pick<RunCoordinator, "start" | "stop" | "kill" | "wait" | "expand" | "mute" | "transpiled">;
```

import the schema:

```ts
  runTranspiledParamsSchema,
```

and add the handler after `run.expand`:

```ts
      "run.transpiled": (input: unknown): Promise<{ code: string } | null> => {
        const { tabId, hideInstrumentation } = parse(runTranspiledParamsSchema, "run.transpiled", input);
        return deps.coordinator.transpiled(tabId, hideInstrumentation);
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/desktop && bun test ./test/runs/run-coordinator.test.ts ./test/rpc-handlers.test.ts
```
Expected: PASS, **+2 tests**.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add packages/rpc-schema/src/ui-rpc.ts apps/desktop/src/main/runs/run-coordinator.ts \
        apps/desktop/src/main/rpc-handlers.ts apps/desktop/test/runs/run-coordinator.test.ts \
        apps/desktop/test/rpc-handlers.test.ts
git commit -m "$(cat <<'EOF'
Serve each tab's latest Babel output over run.transpiled

The coordinator remembers the source and options of a tab's last successful
transform, so the output can be handed back and re-derived without
instrumentation by transforming again with Auto Log, logpoints and loop
protection off — rather than stripping __jl calls out of generated code, which
cannot be done correctly.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 8: The transpiled side panel

**Files:**
- Create: `apps/ui/src/output/TranspiledPanel.tsx`
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/rpc.ts`, `apps/ui/test/fake-api.ts`
- Modify: `apps/ui/src/state/store.ts` (`SideBarPanel`), `apps/ui/src/shell/SideBar.tsx`, `apps/ui/src/shell/ActivityBar.tsx`, `apps/ui/src/shell/App.tsx`
- Modify: `apps/ui/src/strings.ts`, `apps/ui/src/styles.css`, `apps/ui/src/e2e/snapshot.ts`
- Test: `apps/ui/test/transpiled-panel.test.tsx` (new)

**Interfaces:**
- Consumes: `MainRequests["run.transpiled"]` (Task 7); `AppStore`; `strings`.
- Produces:
  - `MainApi.transpiled(tabId: string, hideInstrumentation: boolean): Promise<{ code: string } | null>`
  - `type SideBarPanel = "snippets" | "ai" | "transpiled"` exported from `apps/ui/src/state/store.ts`; `AppState.sideBarPanel: SideBarPanel`; `setSideBarPanel(panel: SideBarPanel)`
  - `function TranspiledPanel({ store, api }: { store: AppStore; api: Pick<MainApi, "transpiled"> }): JSX.Element` — renders `<section className="transpiled-panel">`
  - `UiSnapshot.sideBarPanel: SideBarPanel` in `apps/ui/src/e2e/snapshot.ts`

> **`apps/ui/test/fake-api.ts` ends in `satisfies MainApi`.** Adding `transpiled` to `MainApi` without adding it
> to the fake fails typecheck across every UI test. Do both in this task.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/transpiled-panel.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TranspiledPanel } from "../src/output/TranspiledPanel";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "const a = 5" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const { api } = createFakeApi();
  api.transpiled.mockImplementation(async (_tabId: string, hideInstrumentation: boolean) => ({
    code: hideInstrumentation ? "const a = 5;" : "__jl.log(1, const a = 5);",
  }));
  return { store, api };
}

describe("transpiled output panel (spec §7.4)", () => {
  test("shows the latest Babel output and refreshes when a new run starts", async () => {
    const { store, api } = setup();
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    expect(screen.getByText("__jl.log(1, const a = 5);")).toBeTruthy();
    expect(api.transpiled).toHaveBeenCalledWith("t1", false);

    api.transpiled.mockImplementation(async () => ({ code: "__jl.log(1, 42);" }));
    await act(async () => {
      store.getState().receiveState("run-2", "evaluating");
      await Bun.sleep(1);
    });
    expect(screen.getByText("__jl.log(1, 42);")).toBeTruthy();
  });

  test("the toggle re-requests the output without instrumentation", async () => {
    const { store, api } = setup();
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: strings.transpiled.hideInstrumentation }));
      await Bun.sleep(1);
    });
    expect(api.transpiled).toHaveBeenLastCalledWith("t1", true);
    expect(screen.getByText("const a = 5;")).toBeTruthy();
  });

  test("a tab that has never run says so instead of showing an empty box", async () => {
    const { store, api } = setup();
    api.transpiled.mockImplementation(async () => null);
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    expect(screen.getByText(strings.transpiled.empty)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ui && bun test ./test/transpiled-panel.test.tsx`
Expected: FAIL — `Cannot find module '../src/output/TranspiledPanel'`.

- [ ] **Step 3: Write the implementation**

`apps/ui/src/api.ts` — add to `MainApi`, after `expand`:

```ts
  /** Spec §7.4: the latest Babel output for a tab, or null when it has never transpiled successfully. */
  transpiled(tabId: string, hideInstrumentation: boolean): Promise<{ code: string } | null>;
```

`apps/ui/src/rpc.ts` — add to the returned object, after `expand`:

```ts
    transpiled: (tabId, hideInstrumentation) => rpc.request["run.transpiled"]({ tabId, hideInstrumentation }),
```

`apps/ui/test/fake-api.ts` — add after `expand`:

```ts
    transpiled: mock(async (_tabId: string, _hideInstrumentation: boolean) => ({ code: "" })),
```

`apps/ui/src/strings.ts` — after the `logpoints` group:

```ts
  transpiled: {
    title: "Transpiled Output",
    /** Spec §7.4: "a toggle hides the instrumentation calls". */
    hideInstrumentation: "Hide instrumentation",
    empty: "Run this tab to see its transpiled output.",
    failed: "Couldn't read the transpiled output.",
  },
```

`apps/ui/src/state/store.ts` — export the union and use it in the three places that name the panel literals:

```ts
/** Which panel the side bar shows (Task 16, M4). M5a adds the read-only transpiled output (spec §7.4). */
export type SideBarPanel = "snippets" | "ai" | "transpiled";
```

```ts
  sideBarPanel: SideBarPanel;
```

```ts
  setSideBarPanel(panel: SideBarPanel): void;
```

`apps/ui/src/shell/ActivityBar.tsx` — widen the prop (no new button: the spec puts this in the Actions menu):

```ts
import type { SideBarPanel } from "../state/store";
```

```ts
  panel: SideBarPanel;
```

Create `apps/ui/src/output/TranspiledPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

/**
 * Show Transpiled Output (spec §7.4): "a read-only side tab with the latest Babel output for the current tab. It
 * updates on each run, and a toggle hides the instrumentation calls." The side bar is this app's side-panel
 * region (R-M5a-6), so it lives there rather than inventing a second one.
 *
 * Refresh trigger: the active tab's `runId`. A new run means a new transform in Main, and `run.transpiled` reads
 * whatever that run produced — so re-requesting on `runId` is exactly "updates on each run", with no polling.
 */
export function TranspiledPanel({ store, api }: { store: AppStore; api: Pick<MainApi, "transpiled"> }) {
  const tabId = useStore(store, (s) => s.activeTabId);
  const runId = useStore(store, (s) => s.output.runId);
  const [hideInstrumentation, setHideInstrumentation] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!tabId) {
      setCode(null);
      return;
    }
    let current = true;
    setFailed(false);
    api.transpiled(tabId, hideInstrumentation).then(
      (result) => {
        if (current) setCode(result?.code ?? null);
      },
      () => {
        if (current) {
          setCode(null);
          setFailed(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api, tabId, runId, hideInstrumentation]);

  return (
    <section className="side-bar transpiled-panel" aria-label={strings.transpiled.title}>
      <header className="transpiled-header">
        <h2>{strings.transpiled.title}</h2>
        <label className="transpiled-toggle">
          <input
            type="checkbox"
            checked={hideInstrumentation}
            onChange={(event) => setHideInstrumentation(event.target.checked)}
          />
          {strings.transpiled.hideInstrumentation}
        </label>
      </header>
      {code === null ? (
        <p className="transpiled-empty">{failed ? strings.transpiled.failed : strings.transpiled.empty}</p>
      ) : (
        // Read-only by construction: a <pre>, never an editor (spec §7.4).
        <pre className="transpiled-code">{code}</pre>
      )}
    </section>
  );
}
```

`apps/ui/src/shell/SideBar.tsx` — render the new panel:

```tsx
import type { MainApi } from "../api";
import { TranspiledPanel } from "../output/TranspiledPanel";
import type { AppStore, SideBarPanel } from "../state/store";
import { strings } from "../strings";

/** Side bar host (spec §7.1). Snippets and AI Chat arrive later in M5; Transpiled Output ships in M5a (§7.4). */
export function SideBar({
  panel,
  store,
  api,
}: {
  panel: SideBarPanel;
  store: AppStore;
  api: Pick<MainApi, "transpiled">;
}) {
  if (panel === "transpiled") return <TranspiledPanel store={store} api={api} />;
  return (
    <aside className="side-bar" aria-label={panel === "snippets" ? strings.shell.snippets : strings.shell.aiChat}>
      <h2>{panel === "snippets" ? strings.shell.snippets : strings.shell.aiChat}</h2>
      <p>{strings.shell.sideBarPlaceholder}</p>
    </aside>
  );
}
```

`apps/ui/src/shell/App.tsx` — pass the new props, and expose the region for E2E:

```tsx
        {settings.view.sideBar && <SideBar panel={sideBarPanel} store={store} api={api} />}
```

and in the `regions: () => ({ … })` object inside the E2E effect:

```ts
        // M5a (spec §7.4): the read-only transpiled-output panel, so a scenario can tell it is on screen.
        transpiledPanel: document.querySelector(".transpiled-panel") !== null,
```

`apps/ui/src/e2e/snapshot.ts` — add `sideBarPanel: AppState["sideBarPanel"];` to `UiSnapshot` (after `modal`) and, in the returned object:

```ts
    sideBarPanel: state.sideBarPanel,
```

`apps/ui/src/styles.css` — after the `.output` block:

```css
/* ---------- transpiled output panel (spec §7.4) ---------- */
.transpiled-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.transpiled-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.transpiled-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
}

.transpiled-code {
  flex: 1;
  margin: 0;
  overflow: auto;
  white-space: pre;
  font: calc(var(--code-font-size, 13px) * var(--ui-scale)) / 1.5 var(--code-font-family, var(--mono));
  color: var(--fg-default);
}

.transpiled-empty {
  color: var(--fg-muted);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/ui && bun test ./test/transpiled-panel.test.tsx`
Expected: PASS, **+3 tests**.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/ui/src/output/TranspiledPanel.tsx apps/ui/src/api.ts apps/ui/src/rpc.ts apps/ui/test/fake-api.ts \
        apps/ui/src/state/store.ts apps/ui/src/shell/SideBar.tsx apps/ui/src/shell/ActivityBar.tsx \
        apps/ui/src/shell/App.tsx apps/ui/src/strings.ts apps/ui/src/styles.css apps/ui/src/e2e/snapshot.ts \
        apps/ui/test/transpiled-panel.test.tsx
git commit -m "$(cat <<'EOF'
Show the transpiled output in a read-only side panel

The panel re-requests on each run's id, so it always shows the latest Babel
output, and the toggle asks Main for the same code without instrumentation. It
is a <pre>, not an editor: read-only by construction.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 9: Show Transpiled Output — command and Actions menu

**Files:**
- Modify: `packages/shared/src/commands.ts`
- Modify: `apps/ui/src/shell/App.tsx` (an `openPanel` helper and the inline command registration)
- Modify: `apps/desktop/src/main/menu.ts` (the Actions submenu)
- Test: `packages/shared/test/commands.test.ts`, `apps/ui/isolated/app.test.tsx`, `apps/desktop/test/menu.test.ts`

**Interfaces:**
- Consumes: `CommandRegistry`; `AppState.setSideBarPanel` and `SideBarPanel` (Task 8); `registry.execute("view.toggleSideBar")`.
- Produces: `CommandId` `"view.showTranspiled"`, title `"Show Transpiled Output"`, `category: "view"`. No default chord (spec §6.5's table does not list one).

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/test/commands.test.ts`:

```ts
  test("M5a adds Show Transpiled Output with no default chord (spec §7.4)", () => {
    expect(commandMeta("view.showTranspiled")).toMatchObject({
      title: "Show Transpiled Output",
      category: "view",
    });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command === "view.showTranspiled")).toEqual([]);
  });
```

Add to `apps/ui/isolated/app.test.tsx`, inside `describe("App shell", …)`:

```ts
  test("Show Transpiled Output opens the side bar on the transpiled panel (spec §7.4)", async () => {
    const { store, api, emit } = renderApp();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(store.getState().settings ?? defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    expect(store.getState().sideBarPanel).toBe("snippets");
    await emit("menu.command", { command: "view.showTranspiled" });
    expect(store.getState().sideBarPanel).toBe("transpiled");
    expect(api.updateSettings).toHaveBeenCalledWith({ view: { sideBar: true } });
    // Already open on that panel: the command re-opens rather than toggling it shut.
    await emit("menu.command", { command: "view.showTranspiled" });
    expect(store.getState().sideBarPanel).toBe("transpiled");
    expect(api.updateSettings.mock.calls.length).toBe(1);
  });
```

Add to `apps/desktop/test/menu.test.ts`:

```ts
  test("Actions ends with Show Transpiled Output (spec §7.4)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Show Transpiled Output")?.action).toBe(menuAction("view.showTranspiled"));
    const actions = menu.find((item) => item.label === "Actions")?.submenu ?? [];
    expect(actions[actions.length - 1]?.label?.split("    ")[0]).toBe("Show Transpiled Output");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/shared && bun test ./test/commands.test.ts
cd ../../apps/ui && bun test ./isolated/app.test.tsx
cd ../desktop && bun test ./test/menu.test.ts
```
Expected: FAIL — `commandMeta("view.showTranspiled")` is `undefined`; the menu item is missing; the emitted command reaches no handler.

- [ ] **Step 3: Write the implementation**

In `packages/shared/src/commands.ts`, after `{ id: "view.toggleWebView", … }`:

```ts
  { id: "view.showTranspiled", title: "Show Transpiled Output", category: "view" },
```

In `apps/ui/src/shell/App.tsx`, add an `openPanel` helper beside `togglePanel`:

```ts
  // Unlike togglePanel, this always *opens* the panel: spec §7.4 says Show Transpiled Output "opens a read-only
  // side tab", so invoking it while that panel is already open must not close it.
  const openPanel = useCallback(
    (panel: SideBarPanel) => {
      const state = store.getState();
      state.setSideBarPanel(panel);
      if (!state.settings?.view.sideBar) registry.execute("view.toggleSideBar");
    },
    [store, registry],
  );
```

`openPanel` uses `registry`, which is declared above it — keep it after the `registry` `useMemo`, next to `togglePanel`. Because the command must be registered *inside* that same `useMemo`, register it there with the body inline rather than through `openPanel`:

```ts
      {
        id: "view.showTranspiled",
        run: () => {
          const state = store.getState();
          state.setSideBarPanel("transpiled");
          if (!state.settings?.view.sideBar) created.execute("view.toggleSideBar");
        },
      },
```

and import the type:

```ts
import type { AppStore, SideBarPanel } from "../state/store";
```

> `created` is the `CommandRegistry` instance being built in that `useMemo` — the same pattern `view.commandPalette`
> already uses to reach the store. If `openPanel` ends up unused after this, delete it rather than leaving dead code.

In `apps/desktop/src/main/menu.ts`, at the end of the Actions submenu (after the Language submenu entry):

```ts
        separator,
        item("view.showTranspiled"),
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/shared && bun test ./test/commands.test.ts
cd ../../apps/ui && bun test ./isolated/app.test.tsx
cd ../desktop && bun test ./test/menu.test.ts
```
Expected: PASS, **+1 test** each (3 total).

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add packages/shared/src/commands.ts packages/shared/test/commands.test.ts apps/ui/src/shell/App.tsx \
        apps/ui/isolated/app.test.tsx apps/desktop/src/main/menu.ts apps/desktop/test/menu.test.ts
git commit -m "$(cat <<'EOF'
Open the transpiled output from Actions and the palette

The command always opens the panel rather than toggling it, which is what
"Show Transpiled Output" means, and it reaches the menu, the palette and E2E
through the one command registry.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 10: The first-run welcome tab

**Files:**
- Create: `apps/desktop/src/main/welcome.ts`
- Modify: `apps/desktop/src/main/services/session-store.ts` (`SessionStoreOptions`, `open`)
- Modify: `apps/desktop/src/main/main-services.ts` (the `SessionStore.open` call)
- Test: `apps/desktop/test/services/session-tabs.test.ts`

**Interfaces:**
- Consumes: `loadJson` → `{ value, recovered, primary, corruptCopy }` with `Recovery = "none" | "backup" | "defaults"` and `PrimaryFile = "ok" | "missing" | "corrupt"`; `createTab(overrides)`; `writeFileAtomic`.
- Produces:
  - `apps/desktop/src/main/welcome.ts`: `export const WELCOME_TITLE = "Welcome"` and `export const WELCOME_CODE: string`.
  - `SessionStoreOptions.firstRun?: { title: string; content: string; language: Language }` — applied **only** when `primary === "missing" && recovered === "none"` (R-M5a-5).

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/test/services/session-tabs.test.ts`:

```ts
  test("a genuinely first launch opens the welcome tab, and later launches never do", async () => {
    const firstRun = { title: "Welcome", content: "// hello\n", language: "tsx" as const };
    const store = await SessionStore.open(dir, { delayMs: 10, firstRun });
    stores.push(store);
    const [onlyId] = store.session.tabOrder;
    if (!onlyId) throw new Error("expected one tab");
    expect(store.session.tabs[onlyId]).toMatchObject({ title: "Welcome", titleIsCustom: true, language: "tsx" });
    expect(await store.readBuffer(onlyId)).toBe("// hello\n");
    await store.flush();

    // Second launch: a real session.json exists, so nothing is replaced.
    const second = await SessionStore.open(dir, { delayMs: 10, firstRun });
    stores.push(second);
    expect(second.session.tabOrder).toEqual(store.session.tabOrder);
    expect(await second.readBuffer(onlyId)).toBe("// hello\n");
  });

  test("a corrupt session.json is not treated as a first run", async () => {
    await writeFile(join(dir, "session.json"), "{ not json");
    const store = await SessionStore.open(dir, {
      delayMs: 10,
      newTab: () => createTab({ id: "t1" }),
      firstRun: { title: "Welcome", content: "// hello\n", language: "tsx" },
    });
    stores.push(store);
    const [onlyId] = store.session.tabOrder;
    if (!onlyId) throw new Error("expected one tab");
    // Recovered to defaults, not a first launch: an empty scratch tab, no welcome content.
    expect(store.session.tabs[onlyId]?.titleIsCustom).toBe(false);
    expect(await store.readBuffer(onlyId)).toBe("");
  });
```

Add to `apps/desktop/test/build-wiring.test.ts` (or, if that file is not the right home, keep it here) a guard that the sample really demonstrates what §7.5 requires:

```ts
  test("the welcome sample demonstrates everything spec §7.5 lists", async () => {
    const { WELCOME_CODE } = await import("../src/main/welcome");
    expect(WELCOME_CODE).toContain("//?");
    expect(WELCOME_CODE.toLowerCase()).toContain("logpoint");
    expect(WELCOME_CODE).toContain("fetch(");
    expect(WELCOME_CODE).toContain("function Hello");
    // R-M5a-4: the network and React samples ship commented, so pressing Run on a first launch does no I/O.
    for (const line of WELCOME_CODE.split("\n")) {
      if (line.includes("fetch(") || line.includes("<Hello")) expect(line.trimStart().startsWith("//")).toBe(true);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/desktop && bun test ./test/services/session-tabs.test.ts ./test/build-wiring.test.ts
```
Expected: FAIL — `firstRun` is not a known option (the welcome tab is a plain empty tab), and `../src/main/welcome` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/welcome.ts`:

```ts
/**
 * The first-run welcome tab (spec §7.5): "A welcome tab with sample code showing Auto Log, `//?`, logpoints,
 * fetch, and a React snippet."
 *
 * R-M5a-4: the language is `tsx`, because a React snippet is not valid TypeScript, and the `fetch` and React
 * samples ship commented. Nothing on a newly created tab is armed for Auto Run, so nothing executes at launch —
 * but a live `fetch` would make a network call the first time the user pressed Run, out of a demo, and would
 * make the e2e scenario depend on the network. Uncommenting either line is the demonstration.
 */
export const WELCOME_TITLE = "Welcome";

export const WELCOME_CODE = `// Welcome to JSLab. Code runs as you type — edit anything below.

// 1. Auto Log: the value of each top-level expression appears on its line.
const versions = { app: "JSLab", language: "TypeScript" }
Object.keys(versions)

// 2. Magic comments: end a line with //? to log exactly that statement.
const total = [1, 2, 3, 4].reduce((sum, n) => sum + n, 0) //?

// 3. Logpoints: click the gutter left of a line number, or press F9, to log
//    that line without editing it. Shift+Cmd+F9 clears them all.
const doubled = total * 2

// 4. fetch works here. Uncomment the next line to try it.
// const joke = await fetch("https://api.github.com/zen").then((r) => r.text())

// 5. React: switch the runtime to Browser in the status bar, then uncomment.
function Hello({ name }: { name: string }) {
  return <p>Hello, {name}!</p>
}
// document.body.append(Object.assign(document.createElement("div"), { id: "root" }))
// const { createRoot } = await import("react-dom/client")
// createRoot(document.getElementById("root")!).render(<Hello name="JSLab" />)
`;
```

In `apps/desktop/src/main/services/session-store.ts`, add the option:

```ts
  /**
   * Spec §7.5: the welcome tab's content, applied only on a genuinely first launch — no session.json and no
   * backup (R-M5a-5). A corrupt or recovered file is never a first run, so a user's tabs are never replaced.
   */
  firstRun?: { title: string; content: string; language: Language };
```

In `SessionStore.open`, after the existing `const session = normalizeSession(value, newTab);` line, and before the `new SessionStore(...)` construction, replace nothing — instead add, immediately after the store is constructed and before the repaired-buffer loop:

```ts
    // R-M5a-5: `loadJson` reports this exact pair only when neither session.json nor session.json.bak existed.
    const isFirstRun = primary === "missing" && recovered === "none";
    if (isFirstRun && options.firstRun) {
      const [onlyId] = session.tabOrder;
      const tab = onlyId ? session.tabs[onlyId] : undefined;
      // Only ever the single tab `defaultSession` just created for an empty folder.
      if (onlyId && tab && session.tabOrder.length === 1) {
        const welcome: TabState = {
          ...tab,
          title: options.firstRun.title,
          titleIsCustom: true,
          language: options.firstRun.language,
        };
        session.tabs[onlyId] = welcome;
        await writeFileAtomic(join(dataDir, "buffers", bufferFileName(welcome)), options.firstRun.content);
      }
    }
```

> `store.session` is the same object graph, so mutating `session.tabs[onlyId]` before the first `#commit`/write is
> safe here and nowhere else. If that reads as too subtle when you get there, pass `firstRun` into `newTab` instead
> and write the buffer straight after — same outcome, same condition.

In `apps/desktop/src/main/main-services.ts`, extend the `SessionStore.open` call:

```ts
  const session = await SessionStore.open(paths.dataDir, {
    firstRun: { title: WELCOME_TITLE, content: WELCOME_CODE, language: "tsx" },
    tabDefaults: () => ({
```

with the import:

```ts
import { WELCOME_CODE, WELCOME_TITLE } from "./welcome";
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/desktop && bun test ./test/services/session-tabs.test.ts ./test/build-wiring.test.ts
```
Expected: PASS, **+3 tests**.

- [ ] **Step 5: Gate and commit**

```bash
bun run lint -- --max-diagnostics=300
bun run typecheck
bun run test
git add apps/desktop/src/main/welcome.ts apps/desktop/src/main/services/session-store.ts \
        apps/desktop/src/main/main-services.ts apps/desktop/test/services/session-tabs.test.ts \
        apps/desktop/test/build-wiring.test.ts
git commit -m "$(cat <<'EOF'
Open a welcome tab on a genuinely first launch

First run means no session.json and no backup — a corrupt or recovered file is
not a first run, so a user's tabs are never replaced by samples. The tab is TSX
so the React snippet is valid, and its fetch and React lines ship commented so
a first Run does no network I/O.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 11: E2E — transpiled output and the welcome tab

**Files:**
- Create: `packages/e2e/scenarios/welcome.test.ts`

**Interfaces:**
- Consumes: `launchApp`, `activeTab`, `waitFor`; `app.command("view.showTranspiled")`; `UiSnapshot.sideBarPanel` and `regions.transpiledPanel` (Task 8); `WELCOME_CODE`'s observable markers (Task 10).
- Produces: E2E evidence for EX-37 and ST-12.

- [ ] **Step 1: Write the failing test**

Create `packages/e2e/scenarios/welcome.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

describe("welcome tab and transpiled output", () => {
  test("a first launch opens one welcome tab, and a relaunch keeps it as the user left it (ST-12)", async () => {
    const app = await launchApp();
    apps.push(app);
    const state = await app.state();
    expect(state.ui.tabOrder).toHaveLength(1);
    const tab = activeTab(state);
    expect(tab.language).toBe("tsx");
    expect(tab.code).toContain("//?");
    expect(tab.code).toContain("F9");
    expect(tab.code).toContain("fetch(");
    // Nothing ran: a newly created tab is never armed for Auto Run (spec §5.14).
    expect(tab.runState).toBeNull();

    await app.type("const mine = 1", true);
    await app.waitForOutput((all) => all.length > 0);
    await app.quit();

    const again = await launchApp({ userData: app.userData });
    apps.push(again);
    const restored = await again.state();
    expect(restored.ui.tabOrder).toHaveLength(1);
    expect(activeTab(restored).code).toBe("const mine = 1");
  });

  test("Show Transpiled Output opens the panel with this run's Babel output (EX-37)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.type("const a = 5", true);
    await app.waitForOutput((all) => all.length > 0);

    await app.command("view.showTranspiled");
    const opened = await waitFor(
      async () => {
        const state = await app.state();
        const regions = state.ui.regions as Record<string, boolean>;
        return state.ui.sideBarPanel === "transpiled" && regions.transpiledPanel ? state : null;
      },
      { message: "the transpiled panel never appeared" },
    );
    expect(opened.ui.sideBarPanel).toBe("transpiled");
  });
});
```

- [ ] **Step 2: Build, then run the test to verify it fails**

```bash
cd apps/desktop && hutch run build:dev && cd ../..
bun run --cwd packages/e2e e2e -- ./scenarios/welcome.test.ts
```
Expected: FAIL against a pre-M5a bundle — one empty scratch tab instead of a welcome tab, and no `sideBarPanel` in the snapshot.

- [ ] **Step 3: No implementation needed; re-verify against a current build**

```bash
cd apps/desktop && hutch run build:dev && cd ../..
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd packages/e2e e2e -- ./scenarios/welcome.test.ts`
Expected: PASS, **+2 e2e tests**.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/scenarios/welcome.test.ts
git commit -m "$(cat <<'EOF'
Prove the welcome tab and the transpiled panel in a built app

A first launch opens exactly one TSX welcome tab that has not run anything, a
relaunch keeps whatever the user made of it, and Show Transpiled Output really
opens the panel on a tab that has run.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 12: Docs, parity and the full-suite gate

**Files:**
- Modify: `docs/parity.md` (rows EX-14, EX-15, EX-16, EX-37, ST-12; the deviation notes)
- Modify: `README.md` (the feature list, if it enumerates editor features)
- Modify: `docs/superpowers/plans/2026-09-12-jslab-roadmap.md` (the M5 row)

**Interfaces:**
- Consumes: the test files written by Tasks 1-11, cited by path in the parity Status column exactly as existing rows do.
- Produces: the five parity rows this milestone is allowed to flip, and nothing else.

**Which parity rows actually belong to M5a** — verified against `docs/parity.md`, not assumed:

| Row | Belongs? | Why |
|---|---|---|
| EX-14 Logpoints: gutter click / F9, clear all | **Yes** | Exactly §6.3's gutter UI. |
| EX-15 Logpoints are tab-local and cleared on restart | **Yes** | Task 1 puts them in `TabRuntime`; Task 6 proves the relaunch. |
| EX-16 Logpoint change triggers a run | **Yes** | Task 2. |
| EX-37 Show transpiled output | **Yes** | Tasks 7-9, 11. |
| ST-12 Welcome message on first run | **Yes — and it was missing from the brief's list.** | `docs/parity.md:181`, spec §7.5, M5. Tasks 10-11. |
| ED-20 Editor context menu (incl. Create Snippet…) | **No** | Marked `M2/M5`, but its M5 half is *Create Snippet…*, which belongs to the snippets feature, not to any of these three. |
| OU-10 Entry menu: Copy, Explain Result | **No** | Its M5 half is *Explain Result*, which is AI chat. |

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
Expected: green on both Bun versions. The unit total equals the recorded baseline **+ 25** — Task 1 +2, Task 2 +3, Task 3 +3, Task 4 +3, Task 5 +3, Task 7 +2, Task 8 +3, Task 9 +3, Task 10 +3 — and the e2e suite gains **+ 4** (Task 6 +2, Task 11 +2). Task 2 also rewrites one existing test in `apps/ui/isolated/app.test.tsx` without changing that file's count. Reconcile both numbers before continuing; a mismatch is a STOP.

- [ ] **Step 2: Update `docs/parity.md`**

Replace the five rows' Status cells (keep every other column byte-for-byte):

```markdown
| EX-14 | Logpoints: gutter click / F9, clear all | Docs, CL 4.0.0 | Virtual magic comments with sticky decorations | §5.5, §6.3 | M5 | U, E | ✅ `apps/ui/test/logpoints.test.ts`, `packages/e2e/scenarios/logpoints.test.ts` |
| EX-15 | Logpoints are tab-local and cleared on restart | Docs | Not persisted | §10.1 | M5 | I | ✅ `apps/ui/test/store.test.ts`, `packages/e2e/scenarios/logpoints.test.ts` |
| EX-16 | Logpoint change triggers a run | Docs | Same | §6.3 | M5 | E | ✅ `apps/ui/test/logic.test.ts`, `packages/e2e/scenarios/logpoints.test.ts` |
```

```markdown
| EX-37 | Show transpiled output | CL 1.3.0, 2.0.0 | Actions → Show Transpiled Output | §7.4 | M5 | E | ✅ `apps/desktop/test/runs/run-coordinator.test.ts`, `apps/ui/test/transpiled-panel.test.tsx`, `packages/e2e/scenarios/welcome.test.ts` |
```

```markdown
| ST-12 | Welcome message on first run | CL 1.6.0 | Welcome tab with samples | §7.5 | M5 | E | ✅ `apps/desktop/test/services/session-tabs.test.ts`, `packages/e2e/scenarios/welcome.test.ts` |
```

Append to the **Deviation notes** section at the end of the file:

```markdown
- **Logpoint runs report `reason: "auto"` (spec Appendix A sketches a `"logpoint"` reason).** The shipped
  `runStartParamsSchema` accepts `"auto" | "manual"`, and Main refuses exactly `reason === "auto"` while Safe Mode
  is active (spec §5.14). A separate `"logpoint"` reason would be a run reason Safe Mode does not refuse, so
  logpoint-triggered runs go out as automatic runs. No user-visible difference.
- **"Show Transpiled Output" is a side-bar panel, not a separate tab kind.** Spec §7.4 calls it a "read-only side
  tab"; JSLab's side region is the side bar, with a panel switch (§7.1). The panel is read-only, updates on each
  run, and carries the instrumentation toggle, which is everything §7.4 requires of it.
- **"Hide instrumentation" re-transforms rather than stripping calls.** The toggle returns the same source
  transformed with Auto Log, logpoints and loop protection off, which is exact; pattern-stripping `__jl` calls out
  of generated output is not.
- **The welcome tab's `fetch` and React samples ship commented.** They demonstrate both APIs without a first Run
  making a network request or needing a runtime switch to avoid an error.
```

- [ ] **Step 3: Update the roadmap and README**

In `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, change the M5 row's status cell to:

```markdown
| M5 Productivity & extras | docs/superpowers/plans/2026-09-16-jslab-m5a-editor-productivity.md (M5a: logpoint gutter, Show Transpiled Output, welcome tab) | M5a done; snippets, AI chat, Gist, CLI, theme importer, keybindings UI and i18n outstanding |
```

In `README.md`, add to the feature list, beside the existing editor bullets:

```markdown
- Logpoints: click the gutter or press `F9` to log a line without editing it.
- Actions → Show Transpiled Output: the Babel output for the current tab, with or without instrumentation.
```

- [ ] **Step 4: Verify the docs claim nothing untrue**

```bash
/usr/bin/grep -n "EX-14\|EX-15\|EX-16\|EX-37\|ST-12" docs/parity.md
/usr/bin/grep -rn "/Users/\|/Volumes/" docs/parity.md README.md docs/superpowers/plans/2026-09-16-jslab-m5a-editor-productivity.md
```
Expected: the five rows read ✅ with the test paths above; the second grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add docs/parity.md README.md docs/superpowers/plans/2026-09-12-jslab-roadmap.md
git commit -m "$(cat <<'EOF'
Flip the five M5a parity rows and record the deviations

EX-14, EX-15, EX-16, EX-37 and ST-12 are implemented and covered. ED-20 and
OU-10 stay open: their M5 halves are Create Snippet… and Explain Result, which
belong to snippets and AI chat.

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
| §6.3 "Clicking the glyph margin toggles a logpoint" | 4 |
| §6.3 "shown as a filled dot, or hollow when the line has no loggable statement" | 3 (model), 4 (CSS + attachment) |
| §6.3 "`F9` toggles the current line, and `Cmd+Shift+F9` clears all" | 5 |
| §6.3 "Monaco decorations with `stickiness`, so they follow their lines through edits" | 4 |
| §6.3 "Any logpoint change triggers Auto Run" | 2 |
| §5.5 logpoint semantics (virtual `//?`, innermost statement, hollow + tooltip) | Shipped in M1; consumed by 2 (wire) and 3 (tooltip). No new transform code — verified by reading `packages/transform/src/instrument.ts`. |
| §10.1 "Logpoints are **not** persisted" | 1 (state lives in `TabRuntime`), 6 (relaunch proof) |
| §7.4 Edit menu: Toggle Logpoint · Clear All Logpoints | 5 |
| §7.4 Actions menu: Show Transpiled Output | 9 |
| §7.4 "read-only side tab with the latest Babel output … updates on each run … a toggle hides the instrumentation calls" | 7 (Main), 8 (panel) |
| §7.5 "A welcome tab with sample code showing Auto Log, `//?`, logpoints, fetch, and a React snippet" | 10 (all five demonstrated; asserted by the sample guard test) |
| Appendix A `run.transpiled` | 7 |
| Parity EX-14, EX-15, EX-16, EX-37, ST-12 | 6, 11, 12 |

No gap found. §6.5's full keymap table, §7.4's other menu items and the rest of M5 (snippets, AI chat, Gist, CLI, theme importer, keybindings UI, i18n) are explicitly out of this plan's scope.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "add appropriate error handling", "handle edge cases", "write tests for the above" or "similar to Task N" appears. Every code step carries the actual code. Two steps say "no implementation needed" (Tasks 6 and 11, Step 3) — those are e2e tasks whose behaviour was implemented by earlier tasks, and each still states the build command and the verification. Three inline notes hedge on details that depend on the file's exact state when reached (`run-coordinator.test.ts`'s harness helper names in Task 7, the `session.tabs` mutation point in Task 10, and `openPanel` in Task 9); each names the alternative to use, rather than leaving the choice open.

**3. Type consistency**

- `logpoints` is `number[]` in `TabRuntime`, `AppState`, `TabSnapshot` and `run.start` — one name, one shape, everywhere.
- `setLogpoints(lines: readonly number[])` takes `readonly`; `linesFromRanges` returns `number[]`, which satisfies it.
- `toggleLogpoint` / `clearLogpoints` / `setLogpoints` are spelled identically in Tasks 1, 2, 4 and 5.
- `LogpointGutterDeps` in Task 4's implementation matches the four members Task 4's test drives (`lines`, `hollow`, `toggle`, `reconcile`).
- `hollowLogpointLines` is defined in Task 3 (`logpoints.ts`) and re-exported from `logpoint-gutter.ts` in Task 4, so `Editor.tsx`'s import in Task 4 resolves either way — it imports from `./logpoints`, the definition site.
- `transpiled(tabId, hideInstrumentation)` has the same parameter order and the same `{ code: string } | null` result in `RunCoordinator` (7), `MainRequests` (7), `MainApi` (8), `rpc.ts` (8) and `fake-api.ts` (8).
- `SideBarPanel` is defined once (Task 8, `store.ts`) and imported by `SideBar`, `ActivityBar` and `App`.
- `EditorHandle.getCursorLine(): number | null` is declared in Task 5 and used only there.
- Command ids `edit.toggleLogpoint`, `edit.clearLogpoints`, `view.showTranspiled` are spelled identically in `commands.ts`, `keybindings.ts`, `editor-commands.ts`, `App.tsx`, `menu.ts`, the tests and the e2e scenarios.
