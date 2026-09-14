# JSLab ↔ RunJS 4.1.0 Feature Parity Checklist

This is the v1 release gate (spec §22.4). Every row must be ✅ (implemented and verified) or 📝 (approved documented deviation) before 1.0 ships.

**Clean-room note:** the RunJS column uses only public sources:
- **Docs:** runjs.app documentation pages
- **CL x.y:** CHANGELOG / GitHub release notes
- **#n:** GitHub issue or discussion
- **Strings:** the public `translations/en/translation.json` in `lukehaas/RunJS`

JSLab behavior and defaults are defined in the spec ([`2026-09-12-jslab-design.md`](superpowers/specs/2026-09-12-jslab-design.md)).

**Verify column:**
- **U:** unit
- **I:** integration
- **E:** E2E scenario
- **M:** manual QA

**Status:** ⬜ not started · 🚧 in progress · ✅ done · 📝 deviation (see the notes)

## 1. Execution

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| EX-01 | Auto Run: code runs as you type | Docs | Debounced Auto Run (`run.autoRun`, `run.autoRunDelayMs`) | §4.2, §8 | M1 | E | ✅ `apps/ui/test/logic.test.ts`, `apps/ui/test/store.test.ts` |
| EX-02 | Manual run (Cmd/Ctrl+R, activity bar) | Docs | Same | §6.5 | M1 | E | ✅ `apps/ui/test/logic.test.ts` ("maps the M1 shortcuts") |
| EX-03 | Stop (Cmd/Ctrl+Shift+R), cancels async work | Docs, CL 2.4.0 | Graceful stop, escalates to kill after 500 ms | §5.8 | M1 | I | ✅ `apps/desktop/test/runs/run-coordinator.test.ts` |
| EX-04 | Kill | CL 2.4.0, Strings | Actions → Kill (`Cmd+Alt+R`) | §5.8 | M1 | I | ✅ `apps/desktop/test/runs/run-coordinator.test.ts` |
| EX-05 | Tab Unresponsive dialog (Kill tab / Wait) | CL 3.1.0, Strings | Heartbeat-based dialog | §5.8 | M1 | I, E | ✅ `apps/desktop/test/runs/run-coordinator.test.ts`, `apps/ui/test/app.test.tsx` |
| EX-06 | State doesn't persist between runs | CL 1.2.2, 1.3.1 | Fresh process/realm per run | §5.1, §5.12 | M1 | I | 🚧 no direct test that two runs get distinct fresh runner processes with no state carryover — `run-coordinator.test.ts` "supersedes a running run and kills its runner" only asserts the *superseded* runner exits (`runners.length` check is `toBeGreaterThanOrEqual(1)`, not an exact count of two distinct processes), and `runner-bun`'s `bootstrap.test.ts` has no one-run-per-process test |
| EX-07 | Auto Log: value of each top-level expression | Docs | Auto Log instrumentation with exclusions | §5.5 | M1 | U | ✅ `packages/transform/test/transform.test.ts` |
| EX-08 | Show Undefined | Docs | `run.showUndefined` | §5.5, §8 | M1 | U, E | ✅ `apps/ui/test/output.test.ts`, `packages/shared/test/settings.test.ts` |
| EX-09 | Top-of-file string literals shown | CL 4.1.0, #733 | Non-directive strings logged | §5.5 | M1 | U | ✅ `packages/transform/test/transform.test.ts` ("logs a leading string literal but not 'use strict'") |
| EX-10 | Magic comment `//?` | Docs | Same | §5.5 | M1 | U, E | ✅ `packages/transform/test/transform.test.ts` |
| EX-11 | Inline `/*?*/` mid-expression and before block braces | Docs | Same | §5.5 | M1 | U | ✅ `packages/transform/test/transform.test.ts` |
| EX-12 | `$` expression after marker (`//? $.length`) | Docs | Same | §5.5 | M1 | U | ✅ `packages/transform/test/transform.test.ts` |
| EX-13 | Toggle Magic Comment command | CL 3.1.0, Strings | Edit menu + `Cmd+Alt+Shift+/` | §6.5, §7.4 | M2 | E | ✅ `packages/e2e/scenarios/keybindings.test.ts` ("Toggle Magic Comment adds //? to the current line") |
| EX-14 | Logpoints: gutter click / F9, clear all | Docs, CL 4.0.0 | Virtual magic comments with sticky decorations | §5.5, §6.3 | M5 | U, E | ⬜ |
| EX-15 | Logpoints are tab-local and cleared on restart | Docs | Not persisted | §10.1 | M5 | I | ⬜ |
| EX-16 | Logpoint change triggers a run | Docs | Same | §6.3 | M5 | E | ⬜ |
| EX-17 | Loop protection (2000 iterations), toggleable | Docs, #683 | Same default, configurable limit, **covers `for…of` too** (#744) | §5.5, §8 | M1 | U | ✅ `packages/transform/test/transform.test.ts`, `packages/transform/test/semantics.test.ts` |
| EX-18 | Top-level await in every language | Docs, CL 3.0.3 | Native ESM TLA | §5.3 | M1 | U, I | ✅ `packages/transform/test/semantics.test.ts` |
| EX-19 | ES modules and CommonJS, `node:` specifiers | Docs | Real ESM with `require` available | §5.3 | M1 | I | 🚧 CJS `require`/`node:` interop not yet covered by a test (M3) |
| EX-20 | Unhandled promise rejections surface as errors | Docs, CL 1.13.0 | `error` event (`unhandledRejection`) | §5.11 | M1 | I | ✅ `apps/desktop/test/runs/run-coordinator.test.ts`, `apps/ui/test/entry-row.test.tsx` |
| EX-21 | Syntax error messages | CL 1.2.1 | Squiggle + code frame; previous output dimmed | §5.11 | M1 | E | ✅ `packages/transform/test/transform.test.ts`, `apps/ui/test/logic.test.ts`, `apps/ui/test/output.test.ts` |
| EX-22 | Runtime environments per tab: Browser & Node.js (default), Node.js, Browser | Docs, CL 4.0.0 | `browser-node` (default), `bun`, `browser` | §5.2 | M1/M4 | E | 📝 Node.js → Bun (D2); `browser-node` Node APIs are async-only for fs/child_process (§5.13) |
| EX-23 | Default runtime setting | Docs | `run.defaultRuntime` | §8 | M2 | U | ✅ `packages/e2e/scenarios/settings.test.ts` |
| EX-24 | Status-bar runtime switcher | Docs | Same + Actions → Runtime | §7.1 | M2 | E | 🚧 switcher and menu in M2; browser runtimes enable in M4 |
| EX-25 | `alert` / `confirm` / `prompt` | CL 3.0.3, 3.1.0 | Native if supported, async fallback otherwise | §5.12 | M4 | E | ⬜ (📝 if M0-S4 fails) |
| EX-26 | `process.memoryUsage()` and most of `process` available | CL 1.7.0, 1.8.0 | Full in `bun`; snapshot in `browser-node` | §5.13 | M1/M4 | I | 🚧 no automated test yet (planned with the M3 runner environment work) |
| EX-27 | `console.time*`, `console.assert`, `console.clear`, `console.table` | CL 1.10–2.3 | All console methods incl. `group*`, `trace`, `count`, `dir` | §5.6, §5.10 | M1 | U, I | ✅ `apps/ui/test/entry-row.test.tsx`, `apps/ui/test/output.test.ts` |
| EX-28 | stdout/stderr output | #273 | `stdout`/`stderr` events | §5.6 | M1 | I | ✅ `packages/runner-bun/test/bootstrap.test.ts`, `packages/runner-bun/test/event-buffer.test.ts` |
| EX-29 | Loading spinner while running | CL 1.12.0 | Run state indicators | §5.7 | M1 | E | ✅ `apps/ui/test/logic.test.ts`, `apps/ui/test/app.test.tsx` |
| EX-30 | Working directory: Set Working Directory…, relative import/require/fs | Docs, CL 1.3.0, 1.5.1 | Per tab; relative imports and local `.ts` run natively | §5.3, §12.2 | M3 | I, E | ⬜ |
| EX-31 | `__dirname` / `__filename` / `module` scoped to the WD | CL 2.7.5, #519 | Same | §5.3 | M3 | I | ⬜ |
| EX-32 | `.env` files in the WD load | Docs, CL 3.2.0 | Same; Bun auto-load disabled | §5.3 | M3 | I | ⬜ |
| EX-33 | Tab label shows the WD name | #99 | Suffix "· dirname" | §12.2 | M3 | E | ⬜ |
| EX-34 | `fetch` works without CORS blocking | CL 2.7.5, #513 | `bun`: native; `browser-node`: proxied; `browser`: real CORS | §5.12 | M4 | I | 📝 `browser` runtime enforces CORS (true browser semantics) |
| EX-35 | Audio indicator + mute toggle | CL 1.9.0, Strings | Speaker icon on tab, click to mute | §5.12 | M4 | M | ⬜ |
| EX-36 | Safe recovery from hanging code on launch (Edit → Clear workaround) | #252, #548, #6 | Restored tabs never auto-run; crash-loop Safe Mode; Clear Editor | §5.14 | M1 | E | ✅ `apps/desktop/test/services/services.test.ts`, `apps/ui/test/app.test.tsx`, `apps/ui/test/logic.test.ts` |
| EX-37 | Show transpiled output | CL 1.3.0, 2.0.0 | Actions → Show Transpiled Output | §7.4 | M5 | E | ⬜ |

## 2. Languages & build

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| LB-01 | Per-tab language: TypeScript, JavaScript, TSX, JSX | Docs, CL 4.0.0 | Same | §6.1 | M1/M2 | E | ⬜ |
| LB-02 | Default Language setting | Docs | `run.defaultLanguage` | §8 | M2 | U | ✅ `packages/e2e/scenarios/settings.test.ts` |
| LB-03 | TypeScript compiled before running; types don't block execution | Docs | Babel preset-typescript | §5.4 | M1 | U | ⬜ |
| LB-04 | JSX/TSX automatic runtime (no React import) | Docs | `runtime: "automatic"` | §5.4 | M1 | U | ⬜ |
| LB-05 | Syntax proposals (decorators, pipeline, do-expressions, throw expressions, partial application, function.sent, regexp modifiers, optional chaining assignment, async do) | Docs (v3, archived), CL 1.10–2.10 | Build settings tab, except partial application and async do expressions (Babel 8 removed both plugins) | §8 | M3 | U | 📝 |
| LB-06 | Bundling for ESM imports | CL 2.6.0 | Not needed for `bun` (native ESM); `Bun.build` for browser runtimes | §5.3, §5.12 | M1/M4 | I | 📝 no toggle needed |
| LB-07 | `declare` fields (#526), legacy TS decorators (#574) | #526, #574 | `allowDeclareFields`; `build.decorators: legacy` | §5.4, §8 | M3 | U | ⬜ |

## 3. Editor

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| ED-01 | Line Wrap | Docs | `editor.lineWrap` | §6.1 | M2 | E | ✅ `packages/e2e/scenarios/appearance.test.ts` |
| ED-02 | Vim Keys | Docs | `monaco-vim`; Run works in normal mode (#652) | §6.3 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q20) |
| ED-03 | Close Brackets | Docs | `editor.closeBrackets` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q19) |
| ED-04 | Font Ligatures | Docs | `appearance.fontLigatures` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q19) |
| ED-05 | Line Numbers | Docs | `editor.lineNumbers` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q19) |
| ED-06 | Invisibles | Docs | `editor.invisibles` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q19) |
| ED-07 | Active Line | Docs | `editor.activeLine` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q19) |
| ED-08 | Autocomplete (case-insensitive, with icons), Ctrl+Space | Docs, CL 2.5, 2.7.3, 2.12 | Monaco suggestions | §6.1 | M3 | E | ⬜ |
| ED-09 | Linting (TypeScript diagnostics inline) | Docs | `editor.linting` | §6.1 | M3 | E | ⬜ |
| ED-10 | Hover info (type + docs), F1 | Docs, CL 2.4.0, 4.0.0 | `editor.hoverInfo`, configurable delay (#705) | §6.3 | M3 | E | ⬜ |
| ED-11 | Signatures (parameter hints) | Docs | `editor.signatures` | §8 | M3 | M | ⬜ |
| ED-12 | Lint tooltip (Cmd/Ctrl+F1) | CL 4.0.0 | Show Diagnostic | §6.5 | M3 | M | ⬜ |
| ED-13 | Types from installed packages and `@types/*` | Docs | Type feeder | §6.2 | M3 | I, E | ⬜ |
| ED-14 | Node types available | CL 4.0.2 | Built-in `@types/node` + `bun-types` | §6.2 | M3 | E | ⬜ |
| ED-15 | Find / Replace | CL 1.11.0, Docs | Monaco find widget | §6.5 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q17) |
| ED-16 | Go to line | Strings | `Ctrl+G` | §6.5 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q17) |
| ED-17 | Toggle line/block comment | CL 2.3.0 | Same | §6.5 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q17) |
| ED-18 | Tab indents selection | CL 1.11.0 | Monaco default | — | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q17) |
| ED-19 | Matching bracket / word highlights; fold markers | CL 1.10.0 | Monaco defaults | — | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q17) |
| ED-20 | Editor context menu (incl. Create Snippet…) | CL 1.11.0, Strings | Same | §13.1 | M2/M5 | M | 🚧 Monaco context menu in M2; Create Snippet… M5 |
| ED-21 | Line-editing shortcuts (Docs shortcut table) | Docs | Default keybindings table | §6.5 | M2 | E | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q18) |
| ED-22 | Format code with Prettier (Alt+Shift+F) | Docs | Prettier worker, minimal edits | §6.4 | M2 | U, E | ✅ `packages/e2e/scenarios/format.test.ts` |
| ED-23 | Auto Format on run | Docs | `run.formatOnRun` | §6.4 | M2 | E | ✅ `packages/e2e/scenarios/format.test.ts` |
| ED-24 | Formatting options (print width, tab width, semicolons, quotes, quote props, JSX quotes, trailing commas, bracket spacing, arrow parens) | Docs | All `prettier.*` + Use Tabs (#728) + bracketSameLine | §8 | M2 | U | ✅ `packages/e2e/scenarios/format.test.ts` |
| ED-25 | Large paste guard | CL 2.6.0 | 5 MB confirmation | §6.3 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q15) |
| ED-26 | Install assist for missing imports | CL 1.10.0, 2.7.4 | Code action + runtime error fix | §11.4 | M3 | E | ⬜ |
| ED-27 | Zoom (Cmd =/−/0) scales editor, output and sidebar | Docs, CL 3.2.0 | `appearance.uiScale` | §6.5 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q5) |

## 4. Output

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| OU-01 | Console output with warn/error styling | Docs | Same | §7.2 | M1 | E | ✅ `apps/ui/test/entry-row.test.tsx` ("styles console levels and indents groups") |
| OU-02 | Expandable trees for objects, arrays, Maps, Sets | Docs, CL 1.10.0 | Value tree + lazy handles | §5.9, §7.2 | M1 | U, E | ✅ `packages/serializer/test/encode.test.ts`, `apps/ui/test/value-view.test.tsx` |
| OU-03 | Expand everything | Docs | Entry menu → Expand All | §7.2 | M1 | E | 🚧 pending M1 manual QA (M2 E2E) — no unit/integration test covers the aggregate "Expand All" menu command (only per-node expand is tested, `packages/serializer/test/encode.test.ts`, `apps/ui/test/value-view.test.tsx`); the canary boot fix (R-M1-14) doesn't exercise menu clicks |
| OU-04 | Functions, classes, Promises identifiable without expanding | Docs | Encoded kinds; Promise updates in place | §5.9 | M1 | U | ✅ `packages/serializer/test/encode.test.ts` |
| OU-05 | Strings verbatim at top level, quoted when nested | Docs | Same | §7.2 | M1 | U | ✅ `packages/serializer/test/encode.test.ts`, `apps/ui/test/value-view.test.tsx` |
| OU-06 | Nested objects and `__proto__` auto-folded | CL 2.7.5, 2.9.0 | Same | §7.2 | M1 | M | 🚧 pending M1 manual QA (M2 E2E) — `Verify=M` by design; a visual-folding assertion with no unit/integration test and no scripted way to inspect rendered fold state |
| OU-07 | Side-effect-free getter values | CL 4.0.5 | Native getter allowlist eager; user getters on expand | §5.9 | M1 | U | ✅ `packages/serializer/test/encode.test.ts` (📝 user-defined getters evaluate on click) |
| OU-08 | Line number per entry; click → caret | Docs | 3px level stripe + right-edge `:n` anchor (accessible name `L<n>`) | §7.2 | M1 | E | ✅ `apps/ui/test/entry-row.test.tsx`, `apps/ui/test/logic.test.ts` |
| OU-09 | Hover entry highlights editor line | Docs | Same | §7.2 | M1 | E | ✅ `apps/ui/test/entry-row.test.tsx` |
| OU-10 | Entry menu: Copy, Explain Result | Docs | Same + Copy as JSON | §7.2 | M1/M5 | E | ⬜ |
| OU-11 | Right-click: Copy, Copy All, Clear | Strings, CL 2.11.0 | Same; Copy All copies the entries visible under the current filter chip (M2) | §7.2 | M1 | E | 🚧 Clear is tested (`apps/ui/test/store.test.ts` "run events and states flow through the output reducer" exercises `clearOutput()`; `apps/ui/test/logic.test.ts` "maps the M1 shortcuts" maps `Cmd+K` → `output.clear`), but Copy All's actual multi-entry composition (`entries.map(entryToText).join("\n")` in `OutputPanel.tsx`) has no test joining its two already-tested pieces (`entryToText` in `apps/ui/test/logic.test.ts`, `copyEntriesToClipboard` in `apps/ui/test/copy.test.ts`), and there is no right-click context menu or per-entry Copy in the current UI/tests at all |
| OU-12 | Clear output shortcut / Edit → Clear | Strings | Edit → Clear Output (`Cmd+K`) | §6.5 | M1 | E | ✅ `apps/ui/test/store.test.ts`, `apps/ui/test/logic.test.ts` |
| OU-13 | Cmd/Ctrl-click URLs in output | CL 2.3.0 | Same | §7.2 | M1 | M | 🚧 pending M1 manual QA (M2 E2E) — `Verify=M` by design; needs an actual Cmd/Ctrl-click, no unit/integration test and out of scope for the scripted canary-boot evidence |
| OU-14 | Uncaught errors with message and stack | Docs | Source-mapped, clickable frames (#722) | §5.11 | M1 | E | ✅ `apps/ui/test/entry-row.test.tsx`, `apps/ui/test/output.test.ts` |
| OU-15 | Large output handled | CL 2.2.2, 4.0.5, #567 | Virtualized list, 10k cap (configurable), truncation marker | §5.10 | M1 | I | ✅ `apps/ui/test/output.test.ts`, `apps/ui/test/logic.test.ts` |
| OU-16 | Output syntax highlighting toggle (v3) | Docs (v3, archived), CL 2.12.0 | `output.highlighting` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q28) |
| OU-17 | Map/Set, Proxy, async/generator display | CL 1.15.0 | Encoded types | §5.9 | M1 | U | ✅ `packages/serializer/test/encode.test.ts` |

## 5. Web view

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| WV-01 | Web View tile toggle (browser runtimes only) | Docs | Same | §7.1 | M4 | E | ⬜ |
| WV-02 | Page with `#root`, no stylesheet | Docs | Same | §5.12 | M4 | E | ⬜ |
| WV-03 | DOM APIs, React `createRoot`, CSS-in-JS, `<style>`, CSS imports from the WD | Docs | `Bun.build` + cssInject | §5.12 | M4 | E | ⬜ |
| WV-04 | Canvas + rAF, Three.js, p5, Web Audio, WebGL guides work | Docs (guides) | Same, WKWebView | §5.12 | M4 | E, M | ⬜ |
| WV-05 | Web view focusable | CL 4.0.4 | Same | §5.12 | M4 | M | ⬜ |
| WV-06 | Tiles arranged by dragging headers | Docs | Same | §7.1 | M4 | M | ⬜ |

## 6. Tabs, files, layout

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| TF-01 | Multiple tabs; new/close shortcuts | Docs, CL 2.0.0 | Same | §7.3 | M2 | E | ✅ `packages/e2e/scenarios/tabs.test.ts` |
| TF-02 | Tab title from first line; Edit Tab Title | Docs, CL 2.12.0 | Same | §7.3 | M2 | E | ✅ `packages/e2e/scenarios/tab-bar.test.ts` |
| TF-03 | Middle-click closes tab | CL 2.3.0 | Same | §7.3 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q7) |
| TF-04 | Close Other Tabs / Close Tabs to the Right | CL 2.10.1 | Same | §7.3 | M2 | E | ✅ `packages/e2e/scenarios/tab-bar.test.ts` |
| TF-05 | Reopen closed tab | CL 2.11.0 | Stack of 20 | §7.3 | M2 | E | ✅ `packages/e2e/scenarios/tabs.test.ts` |
| TF-06 | Jump to tab (Cmd+1–9), next/previous tab | Docs | Same | §6.5 | M2 | E | ✅ `packages/e2e/scenarios/tabs.test.ts`, `packages/e2e/scenarios/keybindings.test.ts` |
| TF-07 | Hide tab bar when single tab | CL 2.1.0, Docs | `view.tabBarForSingleTab` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q10) |
| TF-08 | Confirm Close | CL 2.4.0, Docs | `tabs.confirmClose` | §7.3 | M2 | E | ✅ `packages/e2e/scenarios/files.test.ts` |
| TF-09 | Prompt to save a modified file on close | CL 2.7.1 | Same | §7.3 | M2 | E | ✅ `packages/e2e/scenarios/files.test.ts` |
| TF-10 | Open / Save / Save As | Docs | Open dialog + `saveDialog` adapter | §10.2 | M2 | E | ✅ `packages/e2e/scenarios/files.test.ts` |
| TF-11 | Drag and drop files opens new tabs | CL 2.7.1, 3.2.0 | Same + folder sets WD | §7.3 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q14) |
| TF-12 | Large file open guard | CL 2.6.0 | 5 MB confirmation | §10.2 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q15) |
| TF-13 | Auto-save tab contents on change; restore on restart | CL 2.11.0, #590 | Buffers + session | §10.1 | M1/M2 | I | ✅ `apps/desktop/test/persistence/persistence.test.ts`, `packages/shared/test/session.test.ts`, `packages/e2e/scenarios/tabs.test.ts`, `packages/e2e/scenarios/view-state.test.ts` (M2) |
| TF-14 | Window size/position remembered | CL 1.6.0 | Same | §10.1 | M1 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q34); the off-screen restore scenario (`packages/e2e/scenarios/files.test.ts`) covers only the clamp, and M1 evidence: `apps/desktop/test/services/services.test.ts` ("persists the window frame and ignores invalid frames"), `packages/shared/test/session.test.ts` |
| TF-15 | Tab tooltip shows file path | #644 | Same + Reveal in Finder | §7.3 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q8) |
| TF-16 | Horizontal/vertical layout; draggable divider | Docs, CL 2.1.0 | Same, per tab | §7.1 | M2 | E | ✅ `packages/e2e/scenarios/layout.test.ts` |
| TF-17 | Toggle Output, Side Bar, Activity Bar, Status Bar, Full Screen | Docs, Strings | View menu | §7.4 | M2 | E | ✅ `packages/e2e/scenarios/layout.test.ts`, `packages/e2e/scenarios/menu.test.ts` |
| TF-18 | Activity bar: Run, Stop, Snippets, NPM, AI Chat, Settings | Docs | Same | §7.1 | M2 | E | 🚧 Run/Stop/Settings in M2; Snippets/AI panels M5, NPM M3; side bar resizing (240–600 px, spec §7.1) arrives with the first side-bar panel in M5 |
| TF-19 | Status bar: runtime, language, web view toggle, split toggle | Docs | Same + WD chip, run state, vim mode | §7.1 | M2 | E | 🚧 runtime/language/split in M2; Web View toggle M4, WD chip M3 |
| TF-20 | File associations js/jsx/ts/tsx | #620 | + mjs/cjs/mts/cts via Info.plist patch | §4.6 | M6 | M | ⬜ |
| TF-21 | Closing last tab quits the app | #650 | Opens a fresh tab instead | §7.3 | M2 | E | 📝 intentional improvement; implemented (M2) |

## 7. Settings, themes, i18n

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| ST-01 | Settings window with tabs (General, Editor, Formatting, Appearance, AI, NPM, Advanced) | Docs, Strings | + Keybindings, Build | §8 | M2 | E | 🚧 General/Editor/Formatting/Appearance/Advanced in M2; Keybindings/AI M5, NPM/Build M3 |
| ST-02 | Tooltips/help text on options | CL 2.5.0 | Help text per setting | §8, §17 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q24) |
| ST-03 | Theme picker + Themes menu with icons | Docs, CL 2.2.2 | Themes menu + Appearance tab | §9 | M2 | E | ✅ `packages/e2e/scenarios/themes.test.ts`, `packages/e2e/scenarios/menu.test.ts` |
| ST-04 | Themes (Dracula default, others) | Docs | Graphite pair + 19 built-in themes, all free | §9.2 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q25) |
| ST-05 | Font picker: pre-loaded coding fonts + installed system fonts | Docs | Bundled fonts + `systemFonts` adapter | §9.4 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q26) |
| ST-06 | Font size | Docs | `appearance.fontSize` | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q26) |
| ST-07 | Tab Bar / Activity Bar / Status Bar toggles | Docs | Same | §8 | M2 | M | 🚧 pending user manual QA (docs/qa/m2-checklist.md Q27) |
| ST-08 | UI language (English, Español, 日本語, 中文, Português), restart notice | CL 2.3.0, 3.2.0, Strings | Same | §17 | M5 | U, M | ⬜ |
| ST-09 | Auto Updates toggle; Check for Updates; Restart to Update | Docs, Strings | Same + canary channel | §19 | M6 | M | ⬜ |
| ST-10 | Copy Debug Log to Clipboard | Strings | Help → Copy Debug Log (redacted) | §20 | M2 | I | ✅ `packages/e2e/scenarios/help.test.ts` |
| ST-11 | Documentation / Report Issue / What's New | Strings | Help menu | §7.4 | M6 | M | ⬜ |
| ST-12 | Welcome message on first run | CL 1.6.0 | Welcome tab with samples | §7.5 | M5 | E | ⬜ |

## 8. Tools

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| TL-01 | NPM Packages panel (Cmd/Ctrl+I, Tools, activity bar) | Docs | Same | §11.2 | M3 | E | ⬜ |
| TL-02 | Registry search as you type | Docs | Debounced registry search | §11.3 | M3 | I | ⬜ |
| TL-03 | Install a specific version (`name@1.2.3`, ranges) | Docs, #585 | Same + git/tarball specs (#236) | §11.2 | M3 | I | ⬜ |
| TL-04 | Scoped packages and `@types/*` | Docs, CL 1.12.0 | Same | §11 | M3 | I | ⬜ |
| TL-05 | Packages shared across tabs, available without restart | Docs | Shared project; spares recycled | §11.1, §11.3 | M3 | I | ⬜ |
| TL-06 | Installed table: Name, Installed, Latest + update, Remove | Docs, CL 2.9.0 | Same + Update all | §11.2 | M3 | E | ⬜ |
| TL-07 | Allow install scripts option | CL 4.1.0 | `npm.allowInstallScripts` → `trustedDependencies` | §11.3 | M3 | I | ⬜ |
| TL-08 | Native modules install | CL 3.0.3 | Bun N-API, scripts when allowed | §11 | M3 | M | ⬜ |
| TL-09 | npm errors logged | CL 1.4.0 | Classified errors + log drawer | §11.3 | M3 | I | ⬜ |
| TL-10 | `.npmrc` editor in Settings (Reset/Save); global `~/.npmrc` ignored | Docs, CL 2.8.0, 3.2.0, #535 | Same | §11.5 | M3 | I | ⬜ |
| TL-11 | Environment Variables panel (add/edit/save/remove, shared, persisted, strings) | Docs | Same, `env.json` 0600, masked values | §12.1 | M3 | E | ⬜ |
| TL-12 | Snippets window (Name as trigger, Description, body) | Docs | Snippets panel | §13.1 | M5 | E | ⬜ |
| TL-13 | Insert / Insert in New Tab / Copy / Search / Delete with confirm | Docs, CL 2.12.0 | Same | §13.1 | M5 | E | ⬜ |
| TL-14 | Create Snippet… from editor context menu | Docs, Strings | Same | §13.1 | M5 | E | ⬜ |
| TL-15 | Cursor placeholder in snippets | CL 2.7.1, #451 | `$0` + tab stops | §13.2 | M5 | U | ⬜ |
| TL-16 | Snippets in autocomplete, incl. full-name match | Docs, CL 2.7.3 | Completion provider | §13.3 | M5 | E | ⬜ |
| TL-17 | Snippet library import/export (JSON) | Docs, CL 2.12.0 | Documented `jslab-snippets` format | §13.4 | M5 | U | ⬜ |
| TL-18 | AI Chat sidebar (Ctrl+Cmd+I), streaming, New Chat, Stop | Docs, CL 3.0.3, 3.1.0 | Same | §14.1 | M5 | E | ⬜ |
| TL-19 | AI sees current tab code | Docs | + recent output (toggle) | §14.2 | M5 | I | ⬜ |
| TL-20 | Explain Result | Docs, CL 3.0.3 | Same | §14.2 | M5 | E | ⬜ |
| TL-21 | Insert AI code into editor | Strings, #699 | Insert at Cursor / Replace Editor | §14.1 | M5 | E | ⬜ |
| TL-22 | Providers: OpenAI, Anthropic, Gemini, Mistral, Local (Ollama), Custom OpenAI-compatible | Docs, CL 3.2.0, 4.1.0 | Same | §14.3 | M5 | I | ⬜ |
| TL-23 | Model dropdown with refresh; Base URL (blank = standard); API key with show/hide | Docs | Same; keys in Keychain | §14.3 | M5 | I | ⬜ |

## 9. Platform

| ID | RunJS capability | Source | JSLab | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|---|
| PL-01 | macOS signed + notarized build | CL 1.7.0 | Same (arm64) | §19 | M6 | M | ⬜ (📝 no Intel, R12) |
| PL-02 | Windows / Linux builds | Docs | Post-v1 | §27 | — | — | 📝 deferred (D9) |
| PL-03 | Auto-update (differential) | CL 2.8.0, Docs | Electrobun bsdiff updater | §19 | M6 | M | ⬜ |
| PL-04 | Homebrew cask | #270 | `jslab` cask | §19 | M6 | M | ⬜ |
| PL-05 | License activation / paid gating | Docs | None: every feature is free | §1 | — | — | 📝 intentionally absent |
| PL-06 | `runjs://` deep-link protocol | CL 2.7.3, #500 | No URL scheme in v1 (security) | §18 | — | — | 📝 intentionally absent |

## 10. JSLab extras (beyond parity, v1 scope)

| ID | Capability | Requested in | Spec | MS | Verify | Status |
|---|---|---|---|---|---|---|
| XT-01 | Custom themes: VS Code theme importer (.json/.vsix), themes folder | #62, #616 | §9.3 | M5 | U, E | ⬜ |
| XT-02 | Custom keybindings UI + `keybindings.json` | #446, #636 | §6.5 | M2/M5 | U, E | 🚧 keybindings.json overrides in M2; editing UI M5 |
| XT-03 | `jslab` CLI (open, stdin, `--run`, `--runtime`, `--cwd`) | #23, #747, #594 | §16 | M5 | E | ⬜ |
| XT-04 | GitHub Gist publish/update/open | #115 | §15 | M5 | I, E | ⬜ |
| XT-05 | Format on save | #742 | §6.4 | M2 | E | ✅ `packages/e2e/scenarios/format.test.ts` |
| XT-06 | Loop protection covers `for…of`/`for…in`/`for await` | #744 | §5.5 | M1 | U | ✅ `packages/transform/test/transform.test.ts`, `packages/transform/test/semantics.test.ts` |
| XT-07 | Clickable, source-mapped stack frames | #722 | §5.11 | M1 | E | ✅ `apps/ui/test/entry-row.test.tsx` |
| XT-08 | Keychain-stored secrets | — | §18 | M5 | I | ⬜ |
| XT-09 | Safe Mode + crash-loop detection | #6, #178, #416 | §5.14 | M1 | E | ✅ `apps/desktop/test/services/services.test.ts`, `apps/ui/test/app.test.tsx` |
| XT-10 | Configurable Auto Run delay, loop limit, output cap, hover delay | #419, #683, #567, #705 | §8 | M1–M3 | U | ⬜ |
| XT-11 | Formatting preserves folds, scroll, cursor | #639, #654 | §6.4 | M2 | E | ✅ `packages/e2e/scenarios/format.test.ts` |
| XT-12 | Auto-install `@types` option | #629 | §11.4 | M3 | I | ⬜ |

## Deviation notes

- **EX-22 / D2:** RunJS's "Node.js" runtime is replaced by Bun (Node-compatible). Known differences are documented in `docs/user/bun-vs-node.md` (spec §26). In "Browser & Node APIs", synchronous `fs`/`child_process` APIs aren't available; errors explain this and offer to switch the tab to Bun.
- **EX-34:** the `browser` runtime enforces CORS, as a real browser does. `browser-node` and `bun` don't.
- **OU-07:** user-defined getters are evaluated only when expanded, to avoid side effects during logging.
- **TF-21:** closing the last tab keeps the app open with a fresh tab.
- **PL-02:** Windows and Linux follow v1.
- **PL-05:** there's no licensing; JSLab is MIT and fully free.
- **PL-06:** no deep links in v1, for security (RunJS #500).
