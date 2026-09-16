# JSLab M4: Browser runtimes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `browser` and `browser-node` runtimes — a per-tab web runner in an embedded webview, a `Bun.build` bundling phase with a vendor cache, the Web View tile, the `browser-node` Node API layer, and the runtime switcher — so the canvas, React, Three.js and Web Audio guides all run.

**Architecture:** Main gains a `RuntimeAdapter` seam (spec §5.1). The existing Bun path moves behind `BunAdapter` unchanged; a new `WebAdapter` owns one `<electrobun-webview>` per browser-mode tab, loaded from a new `views://runner-web` entry. A new `packages/runner-web` bootstrap mirrors the Bun runner's contract (console hooks, handle tracking, 500 ms heartbeat, `expand` registry) over an Electrobun host bridge instead of process IPC. A new Main-side bundler service runs `Bun.build({ target: 'browser' })` with a resolve plugin over `<WD>/node_modules` then `<appdata>/packages/node_modules`, a CSS-inject plugin, and a runtime-specific polyfill plugin, caching third-party chunks by `bun.lock` hash plus the import set. `browser-node`'s async Node APIs bridge to Main over RPC.

**Tech Stack:** Bun 1.4.0 (bundled) / 1.3.13 (dev), Electrobun 2.0.1, React 19, Zustand, Monaco, zod, `Bun.build`, `@tanstack/react-virtual`, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md` — §5.1 (RuntimeAdapter), §5.2 (runtimes), §5.6 (bootstrap contract to mirror), §5.7 (state machine, incl. the new Bundling phase), §5.8 (Stop/Kill/Unresponsive), §5.9 (serialization, incl. DOM values), §5.10 (event budgets), §5.11 (error presentation), §5.12 (web runners), §5.13 (`browser-node` Node API layer), §7.1 (tiles, status bar), §11.3/§11.4 (npm invalidation, install assist), §23 (budgets).

**As-built survey:** `.superpowers/sdd/2026-09-16-jslab-m4-browser-runtimes/prep-m4-asbuilt.md` — read it before Task 1. Every M4 surface is net-new: no `RuntimeAdapter`, no `Bun.build`, no `<electrobun-webview>`, no tiles, no dialog shim, no audio concept.

---

## Global Constraints

- **Clean room.** Never read RunJS binaries, `app.asar`, bundled JS, or `/Applications/RunJS.app`. Parity comes from the spec and public docs only.
- **Baseline at 69cc03c:** root `bun run test` is **927 pass / 0 fail** — shared 56, themes 8, rpc-schema 18, npm 52, serializer 31, transform 67, test-registry 5, e2e 11, runner-bun 38, ui 285 + 43, desktop 313. Default `bun run e2e` is 60 in 24 files; `bun run e2e:npm` is 4 in 1 file; `bun run test:npm` is 8 in 2 files. Every task states its own delta, and a mismatch is a STOP.
- **Never run a bare `bun test` at the repo root**; always `bun run test`.
- **Gates for every task:** `bun run lint`, `bun run typecheck`, `bun run test` on Bun 1.3.13 and on the bundled 1.4.0 via the shim.
- **No new runtime dependency** without an explicit ruling. Polyfills are the exception and must be pinned exactly and justified per package.
- **Event budgets are fixed:** 16 ms / 200 events / 256 KB, and `UI_BATCH_EVENTS = 200`. The web runner reuses these constants; it never invents new ones.
- **Serialization is shared:** `packages/serializer` is the single encoder. DOM support extends it; the web runner never encodes values itself.
- **Redaction:** anything that logs must pass through `createRedactor`, and masking happens before a value crosses an IPC or webview boundary, never after.
- **Environment:** `browser-node`'s `process.env` snapshot follows `runnerEnvironment`'s layering and its reserved-key stripping (`JSLAB_*`, `BUN_OPTIONS`). Never invent a third env builder.
- **Working directory:** fail closed exactly as `RunCoordinator.#execute` does — user code never runs against a directory that vanished after the check.
- **`JSLAB_E2E`:** every new dialog or prompt must be scriptable through the existing `JSLAB_E2E`-gated path. Nothing may show an unscriptable OS panel under `JSLAB_E2E=1`.
- **RPC discipline:** every new UI-reachable entry point goes through `createValidators`' `parse`/`message`; names are globally unique across merged handler groups.
- **Persistence:** additive migrations only — bump `SESSION_VERSION`/`SETTINGS_VERSION` and let schema defaults fill new fields.
- **Security posture for the web runner:** its own partition `persist:runner-<tabId>`; no Node integration; no access to Main's RPC except through the explicitly defined bridge methods.
- **Performance:** a re-run with a cached React vendor chunk must stay at p50 ≤ 250 ms (§23). Tasks that touch bundling report a measured number.
- **Commit hygiene:** one commit per task unless the task says otherwise, staged explicitly, with the message supplied by the controller.

---

## File Structure

**New packages and entry points**

| Path | Responsibility |
|---|---|
| `packages/runner-web/src/bootstrap.ts` | The page bootstrap: installs `__jl`, console hooks, handle tracking, heartbeat, `expand` registry, and the host bridge. Mirrors `packages/runner-bun/src/bootstrap.ts`. |
| `packages/runner-web/src/host-bridge.ts` | The embedded↔host transport: `window.__electrobunSendToHost` out, an injected callback in. Framing, sequence numbers, and JSON only. |
| `packages/runner-web/src/handles.ts` | Web handle tracking: timers, `requestAnimationFrame` loops, `AudioContext`, `WebSocket`, `fetch` aborts, media elements. |
| `packages/runner-web/src/dialogs.ts` | The non-blocking `alert`/`confirm`/`prompt` shim with its console warning. |
| `packages/runner-web/index.html` | The bare `<div id="root"></div>` page, no stylesheet. |
| `apps/desktop/src/main/runtimes/adapter.ts` | The `RuntimeAdapter` and `RunHandle` interfaces (spec §5.1) plus the registry that picks one per tab. |
| `apps/desktop/src/main/runtimes/bun-adapter.ts` | The existing Bun path, behind the interface. Behaviour-preserving. |
| `apps/desktop/src/main/runtimes/web-adapter.ts` | Per-tab webview lifecycle, `runner.reset`, Stop/Kill (destroy and recreate), heartbeat wiring. |
| `apps/desktop/src/main/bundling/bundler.ts` | The `Bun.build` pipeline: entrypoint, plugins, sourcemap, error mapping. |
| `apps/desktop/src/main/bundling/resolve-plugin.ts` | `jslabResolve`: `<WD>/node_modules` then `<appdata>/packages/node_modules`. |
| `apps/desktop/src/main/bundling/polyfill-plugin.ts` | `nodePolyfills(runtime)`: the §5.13 module table, including the throwing stubs. |
| `apps/desktop/src/main/bundling/css-plugin.ts` | `cssInject`: CSS imports become injected `<style>`. |
| `apps/desktop/src/main/bundling/vendor-cache.ts` | Third-party chunk cache keyed by `bun.lock` hash plus the import set, with the npm-change invalidation hook. |
| `apps/desktop/src/main/rpc/web-runner-handlers.ts` | The bridge Main exposes to the web runner: bundle fetch, `fs`/`child_process`/`fetch` proxies, dialog answers. |
| `apps/ui/src/output/WebViewTile.tsx` | The Web View tile: hosts `<electrobun-webview>`, collapses to zero size when hidden. |
| `apps/ui/src/output/OutputTiles.tsx` | Tile arrangement: Console and Web View, stacked or side by side, drag to rearrange, per-tab. |

**Modified**

| Path | Change |
|---|---|
| `packages/shared/src/settings.ts` | `AVAILABLE_RUNTIMES` widens to all three. |
| `packages/shared/src/session.ts` | `tabLayoutSchema.tiles` plus `muted`; `SESSION_VERSION` 2 → 3 with an additive migration. |
| `packages/rpc-schema/src/ui-rpc.ts` | `runtime` on `runStartParamsSchema`; the web-runner bridge methods and events; the tile patch shape. |
| `packages/serializer/src/*` | DOM node encoding: tag, attributes, child count, `outerHTML` preview. |
| `apps/desktop/src/main/runs/run-coordinator.ts` | Delegates to the adapter registry; adds the `bundling` phase and its failure edge. |
| `apps/desktop/src/main/rpc-handlers.ts` | `run.start` forwards the tab's runtime. |
| `apps/ui/src/output/OutputPanel.tsx` | Becomes one tile inside `OutputTiles`. |
| `apps/ui/src/shell/StatusBar.tsx` | The Web View toggle; the runtime switcher stops being Bun-only. |
| `apps/ui/vite.config.ts` | A third entry for the runner-web page. |
| `apps/desktop/electrobun.config.ts` | A copy rule for the runner-web view. |
| `docs/parity.md`, `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, `README.md`, `docs/qa/m4-checklist.md` | Status and QA, in the final task. |

---

## Task index

Tasks are ordered so each one lands green on its own. Tasks 1–2 open the seam without changing behaviour; 3–7 build the web runner end to end; 8–9 make it visible; 10–13 complete `browser-node`; 14–17 finish the runtime, then prove and document it.

| # | Task | Deliverable |
|---|---|---|
| 1 | Runtime on the wire | `run.start` carries the tab's runtime; schema, handler and tests. No behaviour change yet. |
| 2 | The `RuntimeAdapter` seam | Bun path extracted behind the interface; `RunCoordinator` talks only to adapters. |
| 3 | `packages/runner-web` bootstrap | `__jl`, console hooks, heartbeat, `expand`, handle tracking, all unit-tested in a DOM-less harness. |
| 4 | The runner-web page and build wiring | `views://runner-web`, Vite entry, Electrobun copy rule, a smoke test that the page loads. |
| 5 | The bundler | `Bun.build` with resolve, polyfill and CSS plugins; bundle errors in the §5.11 shape. |
| 6 | The vendor cache | Keyed chunks, plus invalidation on npm change. |
| 7 | `WebAdapter` | Per-tab webview lifecycle, run, Stop, Kill, unresponsive, dispose. |
| 8 | Web View tile and arrangement | The tile, its toggle, per-tab persistence, hidden for `bun`. |
| 9 | Runtime switcher enablement | All three runtimes selectable; Monaco type libs follow the runtime. |
| 10 | Sync polyfills | The §5.13 bundled modules and the `process`/`os` snapshots. |
| 11 | The async Node bridge | `fs/promises`, callback `fs`, `child_process`; `*Sync` and the unsupported modules throw the exact messages. |
| 12 | The fetch proxy | `browser-node` fetch through Main with streaming `Response` semantics; `browser` keeps native fetch and CORS. |
| 13 | The dialog shim | Non-blocking `alert`/`confirm`/`prompt`, the console warning, and `JSLAB_E2E` scripting. |
| 14 | DOM serialization | Tag, attributes, child count, `outerHTML` preview. |
| 15 | Audio indicator and mute | Tracking, the tab icon, and per-tab persistence. |
| 16 | E2E scenarios | Web runtime basics, the tile, canvas/rAF, React, Three.js, Web Audio — the WV-04 exit — plus fetch and bridge errors. |
| 17 | Docs, parity and QA | The M4 checklist, parity and roadmap rows, README, and the full-suite run. |

---

### Task 1: Runtime on the wire

**Files:**
- Modify: `packages/rpc-schema/src/ui-rpc.ts:39-45` (`runStartParamsSchema`)
- Modify: `apps/desktop/src/main/runs/run-coordinator.ts:9-18` (`RunStartRequest`)
- Modify: `apps/desktop/src/main/rpc-handlers.ts:56-74` (the `"run.start"` handler)
- Modify: `apps/ui/src/rpc.ts` (the `run.start` caller) and `apps/ui/src/api.ts` if the method's type changes
- Test: `apps/desktop/test/rpc/rpc-handlers.test.ts`, `packages/rpc-schema/test/ui-rpc.test.ts`

**Interfaces:**
- Consumes: `Runtime` and `RUNTIMES` from `packages/shared/src/settings.ts:4-5`; `TabState.runtime` (`packages/shared/src/session.ts:32`).
- Produces: `RunStartRequest.runtime: Runtime` — every later task reads it. Task 2's adapter registry selects on exactly this field.

This task changes **no behaviour**: the runtime is carried, recorded and asserted, and `RunCoordinator` still runs Bun for every value. That keeps the diff reviewable and keeps the suite green while the seam opens.

- [ ] **Step 1: Write the failing schema test**

In `packages/rpc-schema/test/ui-rpc.test.ts`:

```ts
test("run.start carries the tab's runtime", () => {
  const parsed = runStartParamsSchema.parse({
    tabId: "t1", code: "1", language: "typescript", logpoints: [], reason: "manual", runtime: "browser",
  });
  expect(parsed.runtime).toBe("browser");
});

test("run.start defaults an unknown runtime to bun rather than throwing", () => {
  const parsed = runStartParamsSchema.parse({
    tabId: "t1", code: "1", language: "typescript", logpoints: [], reason: "manual", runtime: "nope",
  });
  expect(parsed.runtime).toBe("bun");
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd packages/rpc-schema && bun test ./test/ui-rpc.test.ts` — expect a failure on the unknown `runtime` key.

- [ ] **Step 3: Add the field**

In `packages/rpc-schema/src/ui-rpc.ts`, extend `runStartParamsSchema`:

```ts
export const runStartParamsSchema = z.object({
  tabId,
  code: z.string().max(MAX_TEXT_CHARS),
  language: z.enum(["typescript", "javascript", "tsx", "jsx"]),
  logpoints: z.array(z.number().int().positive()).max(10_000),
  reason: z.enum(["auto", "manual"]),
  // M4: the run's runtime. `.catch` keeps an older or malformed UI from failing the whole request, matching how
  // every other self-repairing field in this package behaves.
  runtime: z.enum(RUNTIMES).catch("bun"),
});
```

Import `RUNTIMES` from `@jslab/shared` alongside the existing imports.

- [ ] **Step 4: Carry it through Main**

`RunStartRequest` gains `runtime: Runtime` (documented as "the runtime this run executes on (spec §5.2)"). In the `"run.start"` handler, destructure `runtime` from the parsed input and prefer the **session's** value, since the tab is the source of truth and the UI's copy can lag:

```ts
const tab = deps.session.session.tabs[tabId];
return deps.coordinator.start({
  tabId, code, language, logpoints,
  runtime: effectiveRuntime(tab?.runtime ?? runtime),
  workingDirectory: tab?.workingDirectory ?? null,
  scriptName: tab ? scriptFileName({ ...tab, language }, code) : "Untitled.ts",
});
```

`effectiveRuntime` (`packages/shared/src/settings.ts:51-53`) still collapses everything to `bun` while `AVAILABLE_RUNTIMES` is `["bun"]`, which is what keeps this task behaviour-free.

- [ ] **Step 5: Assert it in the handler test**

In `apps/desktop/test/rpc/rpc-handlers.test.ts`, add one test: a session whose tab has `runtime: "browser"` produces a `coordinator.start` call whose `runtime` is `"bun"` **today**, and prove the plumbing by asserting the field exists. Use the file's existing fake-coordinator pattern; don't add a new harness.

- [ ] **Step 6: Gates and commit**

`bun run lint`, `bun run typecheck`, `bun run test` on both Bun versions. **Counts: rpc-schema 18 → 20, desktop 313 → 314, root 927 → 930.** Commit with the controller's message file.

---

### Task 2: The `RuntimeAdapter` seam

**Files:**
- Create: `apps/desktop/src/main/runtimes/adapter.ts`, `apps/desktop/src/main/runtimes/bun-adapter.ts`, `apps/desktop/src/main/runtimes/registry.ts`
- Modify: `apps/desktop/src/main/runs/run-coordinator.ts` (talk to an adapter, not `BunRunnerProcess`/`SparePool` directly)
- Modify: `apps/desktop/src/main/main-services.ts` (build the registry and pass it in)
- Test: `apps/desktop/test/runtimes/bun-adapter.test.ts` (new), `apps/desktop/test/runs/run-coordinator.test.ts` (existing, must keep passing unchanged)

**Interfaces:**
- Produces, from spec §5.1 verbatim:

```ts
export interface RuntimeAdapter {
  id: Runtime;
  prepare(tab: TabRunContext): Promise<void>;
  start(run: PreparedRun, sink: RunEventSink): Promise<RunHandle>;
  invalidate(tab: TabRunContext): void;
  dispose(tabId: string): Promise<void>;
}
export interface RunHandle {
  runId: string;
  stop(): Promise<void>;   // graceful; escalates to kill after 500 ms
  kill(): void;
  expand(handleId: string): Promise<EncodedValue | null>;
}
```

- `TabRunContext`, `PreparedRun` and `RunEventSink` are **defined in this task** and are the contract Task 7's `WebAdapter` implements. Keep them runtime-neutral: no `BunRunnerProcess`, no file paths that only a spawned process has, and no assumption that a runner is a process.

**This is a refactor with no behaviour change.** The existing `run-coordinator.test.ts` is the safety net: it must pass **unmodified**. If a change to that file seems necessary, stop and report — it means the seam is leaking Bun-specific detail.

- [ ] **Step 1:** Write `adapter.ts` with the interfaces above and short doc comments citing spec §5.1.
- [ ] **Step 2:** Write `bun-adapter.ts`, moving the spare-pool take, the `run` message, Stop's 500 ms escalation, `expand` and dispose out of `RunCoordinator` behind `RuntimeAdapter`. Keep every existing constant (`stopGraceMs`, `EXIT_KILL_GRACE_MS`, `UI_BATCH_EVENTS`) where it is; this task moves code, it does not retune it.
- [ ] **Step 3:** Write `registry.ts`: `createRuntimeRegistry({ bun })` returning `get(runtime: Runtime): RuntimeAdapter`, falling back to the Bun adapter for any runtime with no implementation yet, with a comment naming Task 7 as the one that registers `WebAdapter`.
- [ ] **Step 4:** Rewire `RunCoordinator` to resolve an adapter from `request.runtime` (Task 1's field) and call only interface methods.
- [ ] **Step 5:** New unit test for the Bun adapter covering take, stop escalation and expand against a fake runner process. **Counts: desktop 314 → 318 (+4), root 930 → 934.**
- [ ] **Step 6:** Gates and commit.

---

### Task 3: `packages/runner-web` bootstrap

**Files:**
- Create: `packages/runner-web/{package.json,tsconfig.json}`, `src/{bootstrap.ts,host-bridge.ts,handles.ts,console-hook.ts,index.ts}`
- Test: `packages/runner-web/test/{bootstrap,handles,host-bridge}.test.ts`

**Interfaces:**
- Consumes: `packages/serializer` (the same encoder as the Bun runner), and the event shapes in `packages/rpc-schema/src/events.ts` and `runner-ipc.ts`.
- Produces: a `WebToHost`/`HostToWeb` envelope, added to `packages/rpc-schema/src/runner-ipc.ts` beside the Bun pair. Task 7's `WebAdapter` is its only consumer.

**Mirror, don't reinvent.** `packages/runner-bun/src/bootstrap.ts` is the reference:
- the same console methods (`log, info, warn, error, debug, table, dir, dirxml, assert, count, countReset, time, timeLog, timeEnd, group, groupCollapsed, groupEnd, trace, clear`), each capturing the calling position from a lightweight stack capture, with **Main** doing the source mapping;
- the same error limits (`MAX_ERROR_MESSAGE_BYTES = 16 KB`, `MAX_ERROR_NAME_BYTES = 1 KB`, `MAX_ERROR_FRAMES = 50`, `MAX_FRAME_TEXT_BYTES = 1 KB`);
- `EventBuffer` reused verbatim from `@jslab/runner-bun` if it imports cleanly in a DOM context, otherwise moved to a shared package in this task — **never** copied with different thresholds;
- the same 500 ms heartbeat and the same `RunnerState` values;
- an `expand` registry scoped to the run.

**Differences the web runner owns:**
- `uncaughtException`/`unhandledRejection` become `window.addEventListener("error"|"unhandledrejection")`.
- Handle tracking adds `requestAnimationFrame` loops, `AudioContext`, media elements and `WebSocket`, and drops the Node server and child-process wrappers.
- There is no `process.stdout`; console hooks carry everything.
- `stop` cancels rAF loops and closes AudioContexts (spec §5.12).

- [ ] **Step 1:** Write `test/handles.test.ts` first: a fake `globalThis` with `setTimeout`, `requestAnimationFrame` and a stub `AudioContext`, asserting that a tracked rAF loop and an open AudioContext each keep the count above zero and that `dispose` cancels and closes them.
- [ ] **Step 2:** Run it; it fails (no module).
- [ ] **Step 3:** Implement `handles.ts`, modelled on `packages/runner-bun/src/handles.ts` (`HandleTracker`, `installHandleTracking`, `handleCountAction`).
- [ ] **Step 4:** Implement `console-hook.ts` and `bootstrap.ts` against the same `RunnerState` transitions: `evaluating → settled → idle`, `stopped` on stop.
- [ ] **Step 5:** Implement `host-bridge.ts` over `window.__electrobunSendToHost(value)` outbound and an injected `window.__jslabHostMessage(message)` inbound (the host calls it through `executeJavascript`). JSON only, with a monotonic sequence number and an explicit `ready` message.
- [ ] **Step 6:** Tests for the bootstrap's run lifecycle and the bridge's framing, with a fake host. **Counts: a new package with 18 tests; root 934 → 952.**
- [ ] **Step 7:** Gates and commit.

---

### Task 4: The runner-web page and build wiring

**Files:**
- Create: `packages/runner-web/index.html` (bare `<div id="root"></div>`, no stylesheet, per spec §5.12)
- Modify: `apps/ui/vite.config.ts` (a third rollup input), `apps/desktop/electrobun.config.ts` (a copy rule)
- Test: `apps/desktop/test/build-wiring.test.ts` (new): the config lists the entry, and the copy source exists

**Why this is its own task:** `hutch electrobun dev/build` fails with `CopySourceMissing` when a `build.copy` source is absent (M0 report). The page and its wiring must land before anything tries to load `views://runner-web/index.html`.

- [ ] **Step 1:** Add the page and the Vite input; confirm the build emits it.
- [ ] **Step 2:** Add the Electrobun copy rule.
- [ ] **Step 3:** A unit test asserting the config's entry and copy paths agree with the files on disk (a string-level test, no build).
- [ ] **Step 4:** Run `hutch run build:dev` once to prove the app still builds, and report its exit status. **Counts: desktop +2; root 952 → 954.**
- [ ] **Step 5:** Gates and commit.

---

### Task 5: The bundler

**Files:**
- Create: `apps/desktop/src/main/bundling/{bundler.ts,resolve-plugin.ts,polyfill-plugin.ts,css-plugin.ts}`
- Test: `apps/desktop/test/bundling/{bundler,resolve-plugin,css-plugin}.test.ts`

**Interfaces:**
- Produces: `bundleForWeb({ entry, runtime, workingDirectory, packagesNodeModules }): Promise<BundleResult>` where `BundleResult = { code: string; map: string; imports: string[] } | { error: BundleError }`, and `BundleError` carries `{ message, specifier?, line?, column? }` so `specifier` feeds install assist (spec §11.4).

- `Bun.build({ entrypoints, target: 'browser', format: 'esm', sourcemap: 'external', plugins })`, exactly as spec §5.12.
- `jslabResolve`: `<WD>/node_modules` first, then `<appdata>/packages/node_modules` — the same precedence `runnerEnvironment` gives `NODE_PATH` (`apps/desktop/src/main/app-paths.ts:90-106`). A bare specifier that resolves nowhere produces a `BundleError` with `specifier` set.
- `cssInject`: a `.css` import becomes a module that appends a `<style>` element.
- `nodePolyfills(runtime)`: for `browser`, every Node builtin is unresolvable and produces the install-assist-shaped error; for `browser-node`, Task 10's table applies.
- **Failure presentation** follows spec §5.11: one error entry with a code frame, the previous output kept and dimmed.

- [ ] Steps: failing test per plugin (resolve precedence, WD wins; CSS injection; a missing package yields `specifier`), then the implementation, then a bundler test that builds a two-module fixture from a temp dir and asserts the code runs under `new Function`. **Counts: desktop +12; root 954 → 966.**

---

### Task 6: The vendor cache

**Files:**
- Create: `apps/desktop/src/main/bundling/vendor-cache.ts`
- Modify: the npm-change path that already invalidates the type feeder and recycles spares (spec §11.3)
- Test: `apps/desktop/test/bundling/vendor-cache.test.ts`

- Key: the `bun.lock` hash plus the sorted import set, exactly as spec §5.12.
- Store under `<appdata>/cache/vendor/<key>.js` with its map; evict by age and total size, with both limits named as constants.
- Invalidate on any npm change, beside the existing type-feeder invalidation.
- **Budget:** a re-run with a cached React vendor chunk must hit p50 ≤ 250 ms (§23). The task reports a measured local number; it is evidence, not a gate, since machines vary.

- [ ] Steps: failing test for key stability and invalidation, implementation, a timing measurement in the report. **Counts: desktop +6; root 966 → 972.**

---

### Task 7: `WebAdapter`

**Files:**
- Create: `apps/desktop/src/main/runtimes/web-adapter.ts`, `apps/desktop/src/main/rpc/web-runner-handlers.ts`
- Modify: `apps/desktop/src/main/runtimes/registry.ts` (register it), `apps/ui/src/output/WebViewTile.tsx` is Task 8 — this task drives the webview through a thin UI-side host module created here
- Test: `apps/desktop/test/runtimes/web-adapter.test.ts`

**The lifecycle, per spec §5.12:** one `<electrobun-webview>` per browser-mode tab, partition `persist:runner-<tabId>`, loading `views://runner-web/index.html`. For each run Main sends `runner.reset`; the page reloads for a fresh realm and DOM; the bootstrap requests the bundle over the bridge and runs it with `import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))`.

- **Stop** follows §5.8: graceful, escalating after 500 ms. **Kill** destroys and recreates the webview, and appends the "Run killed" entry.
- **Unresponsive** reuses the coordinator's existing watchdog against the web runner's 500 ms heartbeat: no new timer, no new threshold.
- **Fail closed on the working directory** the way `RunCoordinator.#execute` does: compare the scope Main handed the bundler against the tab's current WD before running, since a webview has no OS `cwd`.

- [ ] Steps: failing adapter test with a fake webview host (reset, run, stop escalation, kill-and-recreate, dispose), then the implementation, then registry wiring. **Counts: desktop +10; root 972 → 982.**

---

### Task 8: Web View tile and arrangement

**Files:**
- Create: `apps/ui/src/output/{OutputTiles.tsx,WebViewTile.tsx}`
- Modify: `apps/ui/src/shell/App.tsx` (render `OutputTiles` where `OutputPanel` was), `apps/ui/src/shell/StatusBar.tsx` (the Web View toggle), `packages/shared/src/session.ts` (`tabLayoutSchema.tiles`, `SESSION_VERSION` 2 → 3), `packages/rpc-schema/src/ui-rpc.ts` (the layout patch shape)
- Test: `apps/ui/test/output-tiles.test.tsx`, `packages/shared/test/session.test.ts`

**Interfaces:**
- Produces: `tiles: { arrangement: "stacked" | "side-by-side"; order: ("console" | "webview")[]; webviewVisible: boolean; consoleSize: number }`, matching the spec's Appendix C sketch. Task 15 adds `muted` beside it.

- Reuse `SplitPane` (`apps/ui/src/shell/SplitPane.tsx`) for the tile split; don't write a second resizer.
- The Web View tile hosts the webview element and **collapses to zero size when hidden, staying alive** — M0-S4 measured timers and rAF continuing at full rate, so nothing may unmount it.
- The tile is **unavailable in the `bun` runtime** (spec §7.1): the toggle is disabled with a reason, and a `bun` tab never creates a webview.
- Per-tab persistence through the additive migration; a session written by an older build loads with defaults.

- [ ] Steps: failing schema test for the migration, failing UI test for the toggle and arrangement, implementation, then a check that a `bun` tab shows no tile. **Counts: ui +8, shared +2; root 982 → 992.**

---

### Task 9: Runtime switcher enablement

**Files:**
- Modify: `packages/shared/src/settings.ts` (`AVAILABLE_RUNTIMES`), the Monaco type-lib wiring from M3 (`apps/ui/vite-plugins/type-libs-plugin.ts` consumers and the feeder)
- Test: `packages/shared/test/settings.test.ts`, `apps/ui/test/types-*.test.ts`

- `AVAILABLE_RUNTIMES` becomes all three; `effectiveRuntime` stops collapsing to Bun. The status-bar control needs no change (it already renders every runtime and disables the unavailable ones).
- **Types follow the runtime** (spec §5.2): `bun` gets `bun-types` + `@types/node` and no `dom`; `browser` gets `dom` only; `browser-node` gets `dom` + `@types/node`. Switching a tab's runtime re-feeds Monaco.
- Switching runtime triggers a run when Auto Run is on.

**Carried from Task 1 (R-M4-T1-MINOR-1).** Task 1's precedence test could not distinguish tab-wins from request-wins, because every runtime collapsed to `bun`. This task is the first where they diverge, so add the assertion here: a tab whose `runtime` is `"browser"`, driven by a `run.start` request carrying `"bun"`, must start on **`"browser"`** — the tab is the source of truth. Put it beside the existing precedence test in `apps/desktop/test/rpc-handlers.test.ts` and count it in this task's delta.

- [ ] Steps: failing tests for availability, for the per-runtime lib set, and for the carried precedence assertion; implementation; and a check that `strings.shell.laterMilestone` no longer appears for these three. **Counts: shared +2, ui +6, desktop +1; root 992 → 1001.**

---

### Task 10: Sync polyfills for `browser-node`

**Files:**
- Create: `packages/runner-web/src/polyfills/{index.ts,process.ts,os.ts,crypto.ts}`
- Modify: `apps/desktop/src/main/bundling/polyfill-plugin.ts` (the module table)
- Test: `packages/runner-web/test/polyfills.test.ts`

Per spec §5.13: `buffer, path, events, util, url, querystring, string_decoder, assert, stream, punycode` bundled sync and full; `process` with `env`, `cwd()`, `platform`, `argv`, `versions` from a page-load snapshot and `nextTick` on the microtask queue; `crypto` with `randomUUID`, `getRandomValues`, `webcrypto`, plus polyfilled `createHash`/`createHmac`; `os` from snapshot values.

- The `process.env` snapshot follows `runnerEnvironment`'s layering **and its reserved-key stripping** — no `JSLAB_*`, no `BUN_OPTIONS`.
- Each polyfill dependency is pinned exactly, and the task's report justifies each one and states the added bundle size, against the ≤ 80 MB DMG budget.

- [ ] Steps: a failing test per surface, implementation, a size report. **Counts: runner-web +10; root 1000 → 1010.**

---

### Task 11: The async Node bridge

**Files:**
- Create: `packages/runner-web/src/node-bridge.ts`, `apps/desktop/src/main/rpc/web-node-handlers.ts`
- Test: `packages/runner-web/test/node-bridge.test.ts`, `apps/desktop/test/rpc/web-node-handlers.test.ts`

- `fs/promises` and callback-style `fs.*` bridge over RPC to Main, **scoped to the tab's permissions** and refusing paths outside them the way the WD guard does.
- `child_process.exec/execFile/spawn` bridge and stream `stdout`/`stderr` events.
- `fs.*Sync` and `child_process.*Sync` throw exactly: `JSLabUnsupportedError: fs.readFileSync isn't available in "Browser & Node APIs". Use fs/promises or switch this tab to the Bun runtime.` — the message text is spec-mandated; use it verbatim, with the method name substituted.
- `http, net, tls, dgram, worker_threads, vm` throw `JSLabUnsupportedError` with the switch-to-Bun hint.
- Every bridged call is validated by `createValidators`; output that could carry credentials passes through `createRedactor` **before** crossing the bridge.

- [ ] Steps: failing tests for each throw message and for one round-trip read, implementation, a path-escape refusal test. **Counts: runner-web +8, desktop +6; root 1010 → 1024.**

---

### Task 12: The fetch proxy

**Files:**
- Create: `apps/desktop/src/main/rpc/web-fetch-handlers.ts`, `packages/runner-web/src/fetch-proxy.ts`
- Test: both sides, plus an E2E case in Task 16

- `browser`: native `fetch`, CORS enforced — **do not** proxy it (spec §5.12: true browser semantics are the point).
- `browser-node`: route through Main, stream the response back, preserve `Response` semantics (status, headers, body streaming, `ok`).
- Abort propagates: an aborted `AbortController` in the page cancels the Main-side request, and the handle tracker releases it.
- Redaction applies to anything logged about the request.

- [ ] Steps: failing tests for streaming and abort, implementation. **Counts: runner-web +6, desktop +6; root 1024 → 1036.**

---

### Task 13: The dialog shim

**Files:**
- Create: `packages/runner-web/src/dialogs.ts`, plus the UI-side non-blocking dialog
- Test: `packages/runner-web/test/dialogs.test.ts`, `apps/ui/test/web-dialog.test.tsx`

Per spec §5.12 and M0-S4: `alert` shows JSLab's own non-blocking dialog and returns immediately; `confirm` returns `false`; `prompt` returns `null`; each logs a console warning explaining the limitation once per run, not once per call.

- Under `JSLAB_E2E=1` the dialog is scriptable through the existing gated path — nothing unscriptable may appear.
- **Open UX question, decided here:** if a native panel flashes behind the shim, suppress it by overriding the globals **before** any user code runs, in the bootstrap's first statement. The task reports whether a flash was observed.

- [ ] Steps: failing tests for return values and the once-per-run warning, implementation, E2E scripting hook. **Counts: runner-web +4, ui +4; root 1036 → 1044.**

---

### Task 14: DOM value serialization

**Files:**
- Modify: `packages/serializer/src/*`
- Test: `packages/serializer/test/dom.test.ts`

Per spec §5.9, a DOM node encodes as tag, attributes, child count and an `outerHTML` preview. Respect the existing limits: the preview counts toward the 10,000-character string bound, and a large node becomes a handle. No DOM API is called during encoding beyond reading those four things, so a detached or exotic node can't throw.

- [ ] Steps: failing tests including a detached node and one with 1,000 children, implementation. **Counts: serializer +6; root 1044 → 1050.**

---

### Task 15: Audio indicator and mute

**Files:**
- Modify: `packages/runner-web/src/handles.ts` (report audio activity), `packages/shared/src/session.ts` (`muted` per tab), the tab UI
- Test: `apps/ui/test/audio-indicator.test.tsx`, `packages/runner-web/test/handles.test.ts`

While an `AudioContext` is running or a media element is playing, the tab shows a speaker icon; clicking it toggles mute (spec §5.12, parity EX-35). Mute is per tab and persists. Muting sets every tracked `AudioContext`'s destination gain to zero and pauses media, rather than suspending the context, so a running animation keeps its timing.

- [ ] Steps: failing tests for activity reporting and the toggle, implementation. **Counts: runner-web +4, ui +4, shared +2; root 1050 → 1060.**

---

### Task 16: E2E scenarios

**Files:**
- Create: `packages/e2e/scenarios/web-runtime.test.ts`, `web-view-tile.test.ts`, `web-guides.test.ts`
- Test: the scenarios themselves

Cover, against a dev build:
1. A `browser` tab runs `document.title = "x"` and logs a DOM node; output shows the encoded node.
2. The Web View tile toggles, persists per tab, and is absent for a `bun` tab.
3. **The WV-04 exit:** canvas + `requestAnimationFrame`, React, Three.js and Web Audio guides each run. Pin every third-party package used, and install them from the **local test registry**, never the public one — reuse the `e2e:npm` harness rather than adding network access to the default suite.
4. `browser-node`: `fs/promises` reads a file in the working directory; `fs.readFileSync` throws the exact message; `fetch` reaches a loopback server with no CORS error, while the same call in `browser` is blocked.
5. Stop cancels a rAF loop, and Kill recreates the webview.

Scenarios that need packages belong in the opt-in suite (`e2e:npm`), not the default 60.

- [ ] Steps: one scenario at a time, each run before moving on. **Counts: default e2e 60 → 66 in 27 files; `e2e:npm` 4 → 8 in 2 files. Unit counts unchanged.**

---

### Task 17: Docs, parity and QA

**Files:**
- Create: `docs/qa/m4-checklist.md`
- Modify: `docs/parity.md` (EX-22, EX-23, EX-24, EX-26, EX-34, EX-35, LB-06, WV-01, WV-04, WV-05, TF-19), `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, `README.md`, `docs/user/bun-vs-node.md` (a runtimes section), the spec where M4 decisions need recording
- Test: the full suites

- Every parity row flips **only** to what is actually verified, with the M3 rule applied from the start: a row or checklist item may not claim automated coverage it doesn't have, and anything needing a person is marked pending with what remains.
- Run every suite: unit on both Bun versions, `bun run e2e`, `bun run e2e:npm`, `bun run test:npm`, and report real numbers.

- [ ] Steps: docs, then the runs, then the commit. **Counts: unchanged; the task reports the final totals.**

---

## Self-review

**Spec coverage.** §5.1 → Task 2. §5.2 → Tasks 1, 9. §5.6's contract → Task 3. §5.7's Bundling phase → Tasks 5, 7. §5.8 → Task 7. §5.9's DOM values → Task 14. §5.10's budgets → Task 3 (reused constants). §5.11 → Task 5. §5.12 → Tasks 3, 4, 5, 6, 7, 12, 13, 15. §5.13 → Tasks 10, 11. §7.1's tiles and toggle → Task 8. §11.3's vendor invalidation → Task 6. §11.4's install assist → Task 5. §23's budget → Task 6. Parity WV-04 → Task 16.

**Type consistency.** `RunStartRequest.runtime` (Task 1) is what `registry.get()` selects on (Task 2) and what `bundleForWeb` receives (Task 5). `RuntimeAdapter`/`RunHandle` (Task 2) is implemented by `BunAdapter` (Task 2) and `WebAdapter` (Task 7). `tiles` (Task 8) and `muted` (Task 15) both live in `tabLayoutSchema` under one `SESSION_VERSION` bump — Task 15 must not bump it a second time.

**Running count.** 927 → 930 → 934 → 952 → 954 → 966 → 972 → 982 → 992 → 1000 → 1010 → 1024 → 1036 → 1044 → 1050 → 1060, with E2E 60 → 66 and `e2e:npm` 4 → 8. These are targets, not promises: a task that lands a different number states why, and the controller rules.
