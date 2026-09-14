# JSLab v1 Roadmap

> **For agentic workers:** This is the milestone index, not an executable plan. Each milestone gets its own detailed plan in `docs/superpowers/plans/` when it starts. Execute those with superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Ship JSLab 1.0, an open-source RunJS 4.1.0 equivalent for macOS arm64, meeting every row of `docs/parity.md`.

**Architecture:** Electrobun 2.x app. A Bun main process owns all privileged work. A React + Monaco UI runs in WKWebView. User code runs in a warm child Bun process per tab (fresh per run), instrumented by a Babel plugin. Browser-mode code runs in a WKWebView per tab.

**Tech Stack:** Electrobun 2.0.1 (`mainProcess: "bun"`), Bun, TypeScript, React 19, Vite, Monaco 0.56, `@babel/standalone` 8, Prettier 3, zod 4, zustand 5, Biome 2.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md`. Every milestone plan argues from it, and executors read both.

## Global Constraints

These apply to every milestone plan:

- Clean room: never read RunJS binaries, `app.asar` or bundled JS (spec §0).
- MIT license. Deny GPL-family dependencies (spec §22.5).
- macOS arm64 only for v1. Keep code cross-platform; no platform branches outside `apps/desktop/src/main/platform/`.
- Pin exact versions of Electrobun, Hutch and every runtime dependency.
- Bun workspaces monorepo using the layout in spec §4.4.
- User code never runs in the Main process (spec §4.1).
- Every inbound RPC payload is zod-validated in Main (spec §18).
- No hard-coded UI strings once i18n lands in M5; before M5, keep strings in one `strings.ts` per app so extraction is mechanical.
- Tests: `bun test` per package. TDD for all pure logic.
- Commits: Conventional Commits.

## Status

| Milestone | Plan | Status |
|---|---|---|
| M0 Spikes | `2026-09-12-jslab-m0-spikes.md` | Done (report: `docs/spikes/2026-09-m0-report.md`) |
| M1 Core scratchpad | `2026-09-12-jslab-m1-core-scratchpad.md` (rulings: `2026-09-12-jslab-m1-rulings.md`) | Done: 268 tests, lint/typecheck clean, dev and packaged canary boot verified by script; manual QA Q1–Q16 pending (`docs/qa/m1-checklist.md`) |
| M2 Workspace | `2026-09-13-jslab-m2-workspace.md` | In progress |
| M3 Language & packages | to be written at M2 completion | Not started |
| M4 Browser runtimes | to be written at M3 completion | Not started |
| M5 Productivity & extras | to be written at M4 completion | Not started |
| M6 Ship | to be written at M5 completion | Not started |

## Dependency graph

```mermaid
flowchart LR
  M0[M0 Spikes] --> M1[M1 Core scratchpad]
  M1 --> M2[M2 Workspace]
  M2 --> M3[M3 Language & packages]
  M3 --> M4[M4 Browser runtimes]
  M2 --> M5[M5 Productivity & extras]
  M3 --> M5
  M4 --> M6[M6 Ship]
  M5 --> M6
```

M5 depends on M3 because snippets autocomplete, AI context and the CLI all use the Monaco and npm services. It can start alongside M4 if two people work in parallel.

---

## M0: Spikes

- **Goal:** Retire the architectural risks that could change the design before any product code exists.
- **Spec:** §24 (M0 row), §25 risks R1–R5, R9.
- **Deliverables:**
  - Throwaway code in `spikes/`.
  - `docs/spikes/2026-09-m0-report.md` with a go or fallback decision per spike.
  - Spec edits wherever a result differs from the spec.
- **Spikes:** S1 shell + workspace imports + Worker, S2 Monaco workers, S3 bundled Bun child runner, S4 embedded webview dialogs and hidden timers, S5 `Info.plist` patch + signing, S6 `osascript` save dialog, S7 RPC throughput, S8 runtime flags and `.npmrc` isolation in the packaged app.
- **Exit:** every spike has a recorded outcome; the M1 plan's Electrobun-facing tasks are updated to match.

## M1: Core scratchpad

- **Goal:** One tab where typing TypeScript shows correct results, console output and errors, and hangs are recoverable.
- **Spec:** §4.1–4.5, §5.1–5.11, §5.14, §6.1 (baseline), §7.1–7.2 (subset), §10.1 (single buffer), §20, §22.1–22.2.
- **Parity rows:** EX-01..EX-12, EX-17..EX-21, EX-26..EX-29, EX-36, OU-01..OU-09, OU-11..OU-15, OU-17, TF-13, TF-14, XT-06, XT-07, XT-09.
- **Exit:** the M1 manual QA checklist passes on a dev build; all unit and integration suites are green in CI.

## M2: Workspace

- **Goal:** Daily-driver usable for single-file scratch work.
- **Spec:** §6.4, §6.5, §7.1, §7.3, §7.4, §8 (General, Editor, Formatting, Appearance, Advanced), §9.2, §9.4, §10.
- **Feature list for the detailed plan:**
  1. Tabs store and tab bar: new, close, reopen stack, rename, context menu, middle-click, drag reorder, Cmd+1–9, next/prev.
  2. Session persistence for multiple tabs; per-tab layout and Monaco view state.
  3. Open / Save / Save As (`saveDialog` adapter per M0-S6) / drag and drop / unsaved-changes prompt / 5 MB guards.
  4. Settings schema (full §8 minus AI/NPM/Build), migrations, Settings window app.
  5. Command registry and keybinding resolver, default keymap (§6.5), application menu (§7.4) wired to commands.
  6. Prettier worker, format on run/save with minimal edits.
  7. Built-in themes, fonts, zoom, the `systemFonts` adapter.
  8. Layout toggles: activity bar, status bar, side bar, tab bar, horizontal/vertical split, output toggle.
  9. Help → Copy Debug Log, Open Logs Folder, Restart in Safe Mode; rotating logs with redaction.
- **Parity rows:** EX-13, EX-23, EX-24, ED-01..ED-07, ED-15..ED-25, ED-27, OU-16, TF-01..TF-19, TF-21, ST-01..ST-07, ST-10, XT-05, XT-11.
- **Exit:** E2E-style manual script covering tabs, files, settings and shortcuts passes.

## M3: Language & packages

- **Goal:** Install a package, import it with types and autocomplete, and use it from a working-directory file.
- **Spec:** §5.3 (WD), §6.1–6.3, §11, §12, §8 (NPM, Build).
- **Feature list:**
  1. Monaco TS compiler options per runtime; bundled `@types/node` and `bun-types`.
  2. npm service: queue, `bun add/remove/outdated`, registry search, error classification, `.npmrc` isolation per M0-S8.
  3. NPM panel UI and the Settings → NPM `.npmrc` editor.
  4. Type feeder and install assist code actions.
  5. Environment variables panel and `env.json`.
  6. Working directory: picker, chip, `NODE_PATH` resolution, `.env` loading, `__dirname`/`__filename`, local types.
  7. Build settings tab (decorators mode and proposal toggles).
  8. `docs/user/bun-vs-node.md`.
- **Parity rows:** EX-30..EX-33, LB-05, LB-07, ED-08..ED-14, ED-26, TL-01..TL-11, XT-12.
- **Exit:** zod scenario works end to end; npm integration suite green against Verdaccio.

## M4: Browser runtimes

- **Goal:** The canvas, React, Three.js and Web Audio guides from the docs work.
- **Spec:** §5.2, §5.12, §5.13, §7.1 (tiles).
- **Feature list:**
  1. `runner-web` page and bootstrap sharing `@jslab/serializer` and the console hooks.
  2. Web runner adapter in Main: `Bun.build` pipeline, vendor chunk cache, reset/reload per run.
  3. Web View tile, tile arrangement, zero-size hidden mode per M0-S4.
  4. `browser-node` polyfills, async Node bridge, fetch proxy; `JSLabUnsupportedError` hints.
  5. Dialogs (native or async fallback per M0-S4).
  6. Audio indicator and mute.
  7. Runtime switcher enabling all three runtimes.
  8. Decision record: keep `browser-node` as default or switch to `bun` (risk R8).
- **Parity rows:** EX-22, EX-25, EX-34, EX-35, LB-06, WV-01..WV-06.
- **Exit:** all four guide scenarios pass manual QA.

## M5: Productivity & extras

- **Goal:** All remaining parity rows implemented.
- **Spec:** §6.3 (logpoints UI), §9.3, §13, §14, §15, §16, §17, §7.4 (Show Transpiled Output), §7.5 (welcome).
- **Feature list:**
  1. Logpoint gutter UI (transform support already exists from M1).
  2. Snippets panel, completion provider, import/export.
  3. AI chat: provider adapters, streaming proxy, Keychain secrets, Explain Result.
  4. Gist: device flow, publish/update, open.
  5. CLI: socket server, `jslab` binary, install/uninstall menu, E2E automation methods.
  6. VS Code theme importer.
  7. Keybindings settings UI.
  8. Show Transpiled Output, first-run welcome tab.
  9. i18n extraction and five locales.
- **Parity rows:** EX-14..EX-16, EX-37, ED-20, OU-10, ST-08, ST-12, TL-12..TL-23, XT-01..XT-04, XT-08.
- **Exit:** every parity row is implemented; the E2E harness runs the full scenario list.

## M6: Ship

- **Goal:** Signed, notarized, auto-updating public beta, then 1.0.
- **Spec:** §19, §22.3–22.5, §23, §4.6 (file associations).
- **Feature list:**
  1. Updater wiring (stable and canary) and What's New.
  2. CI signing and notarization; release artifacts; Homebrew tap.
  3. File associations via the `Info.plist` hook (per M0-S5).
  4. About, credits, open-source notices.
  5. User documentation site.
  6. Performance benchmark job against §23 budgets.
  7. Parity audit and beta feedback loop.
- **Parity rows:** TF-20, ST-09, ST-11, PL-01, PL-03, PL-04.
- **Exit:** parity gate passed; auto-update from beta N to N+1 verified on a clean machine.
