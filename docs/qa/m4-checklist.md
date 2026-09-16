# M4 Manual QA Checklist

Browser runtimes: the `browser` and `browser-node` tabs, the Web View tile, dialogs, audio and the guides.

> [!IMPORTANT]
> **Build before you run the suites. `bun run e2e` does not build anything.**
> `packages/e2e`'s `e2e` script is `bun test ./scenarios --timeout 180000` and nothing more — it drives whatever bundle is already
> on disk, however old. A stale bundle produces fast, confident, entirely misleading failures: running the suite
> against a build that predated this milestone gave **60 pass / 9 fail**, with every browser-runtime scenario
> refused at `Command is disabled: runtime.browser` in about a second, because `AVAILABLE_RUNTIMES` inside that
> bundle was still `["bun"]`. That looks exactly like a regression in core functionality and is not one.
> **Read the failure text, never the timings** — the timings are what make a stale bundle look healthy.

```bash
export PATH="$HOME/.hutch/bin:$PATH"
REPO="$(git rev-parse --show-toplevel)"
builtin cd "$REPO/apps/desktop" && hutch run build:dev && builtin cd "$REPO"
bun run e2e
```

Never run the Hutch installer, `hutch init` or `hutch upgrade`: the toolchain is pinned to Hutch 0.24.3 with
Electrobun 2.0.1, and an upgrade changes what a signed build contains.

For the packaged canary rather than the dev build, use the canary launch, warm-up and scoped-teardown procedure in
[`m2-checklist.md`](m2-checklist.md) — it is unchanged for M4.

## The opt-in suite needs a local `three@0.184.0`

`bun run e2e:npm` publishes React, React DOM, Scheduler and Three.js into a **loopback Verdaccio registry**; it
never contacts the public npm registry. React, React DOM and Scheduler are republished from this repo's own
installed copies. Three.js is not a dependency of this repo, so it is republished from a local package folder:
Bun's on-disk install cache (`~/.bun/install/cache/three@0.184.0@@@1`) by default, or `JSLAB_E2E_THREE_DIR` if you
keep it elsewhere.

If neither is present the suite **fails loudly** and names the variable, rather than skipping. That is deliberate —
a silently-skipped exit criterion is worse than a loud failure — but it means a fresh machine needs the package
staged first:

```bash
# Either: let Bun populate its cache in a scratch folder (this one call does reach the public registry;
# nothing in the suite itself ever does).
builtin cd "$(mktemp -d)" && bun add three@0.184.0

# Or: point the suite at a folder you already have (one with package.json and build/).
export JSLAB_E2E_THREE_DIR=/path/to/three-0.184.0
bun run e2e:npm
```

Each item passes only if the result matches exactly. Items marked **(E)** are also covered by an automated
scenario; this pass checks them by eye.

## Runtimes

- [ ] **Q1 Runtime switcher (EX-22, EX-24).** The status bar's runtime selector and Actions → Runtime both offer
  **Bun**, **Browser & Node APIs** and **Browser**, and each switches the active tab. (E: `layout`, `web-runtime`,
  `web-view-tile`) — **verified (E):** switching the active tab between all three runtimes, by the `EX-24` scenario
  in `packages/e2e/scenarios/layout.test.ts`, and the availability of all three in `apps/ui/test/layout.test.tsx`.
  **Pending user:** that the status-bar **menu** and the Actions → Runtime menu items are the controls doing it —
  the scenarios drive the `runtime.*` commands, not a click on the selector.
- [ ] **Q2 Default runtime (EX-23).** A new tab opens in **Bun**. Settings → General → Default Runtime changes what
  the *next* new tab opens in, and the choice survives a relaunch. — **verified (U):** `DEFAULT_RUNTIME` is `bun`
  and a new tab takes it (`packages/shared/test/session.test.ts`, `packages/shared/test/settings.test.ts`).
  **Pending user:** changing the setting through the Settings window and observing the next new tab.
- [ ] **Q3 A browser tab really runs in a page (WV-02, WV-03).** In a **Browser** tab, `document.body.append(...)`
  puts the node in the Web View tile, `document.querySelector` finds it back, and `console.log(element)` shows the
  element's own opening tag with a child count rather than a blank row. (E: `web-runtime`) — **verified (E).**
  **Pending user:** a visual read of the rendered page in the tile.
- [ ] **Q4 Browser & Node APIs (§5.13, EX-26).** In a **Browser & Node APIs** tab, `fs/promises` reads a file from
  the working directory and `child_process.exec` returns its stdout; `fs.readFileSync` refuses with
  `JSLabUnsupportedError: fs.readFileSync isn't available in "Browser & Node APIs". Use fs/promises or switch this
  tab to the Bun runtime.` (E: `web-runtime`) — **verified (E).** **Pending user:** that the refusal reads well in
  the output panel and that the offer to switch the tab is actionable.
- [ ] **Q5 fetch and CORS (EX-34).** The same cross-origin `fetch` succeeds in a **Browser & Node APIs** tab
  (routed through Main, no origin to enforce) and is refused in a **Browser** tab (real CORS). (E: `web-runtime`)
  — **verified (E).**

## Web View tile

- [ ] **Q6 Web View toggle (WV-01, TF-19).** ⌥⌘W, View → Web View and the status-bar switch all toggle the tile,
  and all three are unavailable on a **Bun** tab. The setting is per tab and survives a relaunch. (E:
  `web-view-tile`) — **verified (U, E):** the command, its chord, the View menu item's checked/enabled state, the
  status-bar button dispatching that same command, and the per-tab persistence
  (`packages/shared/test/commands.test.ts`, `apps/desktop/test/menu.test.ts`, `apps/ui/test/output-tiles.test.tsx`,
  `packages/e2e/scenarios/web-view-tile.test.ts`). **Pending user:** pressing ⌥⌘W and picking the View menu item
  by hand, and a visual read of the tile appearing.
- [ ] **Q7 Web view focusable (WV-05).** Click into the Web View tile: a focusable element in the user's own page
  (an `<input>`, say) takes focus and accepts typing. — **pending user:** nothing automated covers webview focus;
  this needs a real click and real keystrokes into a native webview surface.
- [ ] **Q8 Tile arrangement (WV-06).** **Known gap, not merely unverified.** Spec §7.1 says tiles are arranged by
  dragging their headers. **No drag affordance is implemented** — the Console and Web View tiles have no header
  drag handler, and `layout.tiles.arrangement` (`stacked` / `side-by-side`) is reachable only by hand-editing
  `session.json`. The stored value *is* honoured and does survive a relaunch. Record as not done; do not tick.
- [ ] **Q9 Overlays over the web view.** With the Web View tile visible, open the command palette (⇧⌘P) over it.
  **A native webview surface paints above HTML regardless of z-index**, so check whether the palette is occluded.
  — pending user: this is a compositor behaviour only visible on a real screen.

## Dialogs, audio and output

- [ ] **Q10 Dialogs (EX-25).** In a browser tab, `alert("hi")` shows JSLab's own non-blocking notice and returns
  immediately; `confirm()` returns `false` and `prompt()` returns `null`, both without showing anything; one
  console warning explains the limitation once per run, not once per call. — **verified (U):**
  `packages/runner-web/test/dialogs.test.ts` and `apps/ui/test/web-dialog.test.tsx` (the notice is not a blocking
  modal and queues rather than stacking). **Pending user:** no E2E scenario drives a dialog in a real build, so the
  on-screen appearance and dismissal need a person.
- [ ] **Q11 Audio indicator and mute (EX-35).** Start a live `AudioContext` in a browser tab: the tab shows a
  speaker icon. Click it — audio silences, the icon shows muted, and the tab keeps running. Clicking the icon must
  not also switch tabs. — **verified (U):** the indicator renders only while active, its `aria-pressed` and
  accessible name both track the muted state, the click stops propagation, and muting zeroes a tracked context's
  gain without suspending it (`apps/ui/test/audio-indicator.test.tsx`,
  `packages/runner-web/test/handles.test.ts`). **Pending user:** the icon actually appearing on a tab in a real run
  and the click silencing real audio — no scenario asserts the indicator's on-screen state.
  **Note what this row does *not* claim:** an `OfflineAudioContext` render drives **no** indicator at all — it is
  referenced nowhere in `packages/runner-web`, so an offline render is untracked. Only a live `AudioContext` or a
  playing media element lights the icon, and a live context starts `suspended` under the autoplay policy until a
  gesture (the runner registers it on `state === "running"`).
- [ ] **Q12 The guides (WV-04).** Canvas + `requestAnimationFrame`, React, Three.js and Web Audio each run in a
  browser tab, and all four run together in one tab. (E: `web-guides`, and `web-package-guides` in the opt-in
  suite) — **verified (E):** the canvas guide animates ten real frames and reads its own painted pixel back; the
  audio guide renders a 4,096-sample buffer and finds a real peak; React mounts, runs an effect and re-renders;
  Three.js reports revision 184, 12 triangles and a red-dominant centre pixel; and one scenario runs all four in a
  single tab. **Pending user:** **p5 is not covered by anything** — the parity row names it and no scenario
  installs or runs it. WebGL is covered only through Three.js.

## Known limitations (record, don't fix in M4)

1. **Page code can forge an inbound command on the runner channel.** The bootstrap is delivered by
   `executeJavascript` into the same realm the user's code runs in, so `__jslabHostMessage` is reachable by that
   code: it can send a `stop` or `dispose` with the right sequence number, and consume the host's real one.
   Sequence numbers order messages; they cannot authenticate a sender. Task 3 narrowed this and Task 7 ruled it
   **accepted** — closing it needs an isolated transport, which is larger than this milestone.
   **The runner channel is not authenticated, and nothing should describe it as authenticated.**
2. **`import * as ns` over a bundled package exposes more than the module namespace.** The vendor/app join uses a
   page-global registry plus a per-package CommonJS stub, because the bundler emits CJS chunks as
   `export default require_x()` and named imports cannot link across a cached chunk boundary. A consequence is that
   a namespace object can carry the default export's own keys, so code that enumerates or spreads a namespace sees
   different results than it would under Bun. Values are identical either way; only `Object.keys(ns)` differs.
   Changing it means changing the join contract itself, which is why it is deferred rather than patched.
   **This is a known divergence: JSLab does not claim namespace parity.**
3. **Shared built-in identity is broken across `stream`, `events` and `buffer`.** Each vendored polyfill flattens
   its own private copy of the built-ins it depends on, so `new Readable() instanceof EventEmitter` can be `false`
   and a `Buffer` from one module may not be recognised by another. Task 9f measured that the prescribed fix does
   nothing: `--external` is **silently ignored for Node builtin names** under `--target=browser` (byte-identical
   output, 88,278 bytes with and without), and the plugin alternative drops CommonJS `require()` dependencies and
   produces something broken at runtime (39,245 bytes, zero imports). A real fix means building the shared
   built-ins as **one module graph** — a vendor-layer redesign, not a flag. The measurements are in
   `packages/runner-web/scripts-src/generate-vendor.sh`'s own header.
4. **`OfflineAudioContext` drives no audio indicator.** See Q11.
5. **The `scheduler` pin in the opt-in e2e suite is decorative.** `three` is genuinely version-checked
   (`if (version !== THREE_VERSION) throw`) and react/react-dom are named in their republish calls, but scheduler
   is republished via `copyInstalledPackage("scheduler", …)`, which takes whatever version this repo has installed.
   It **inherits the installed version**; it is not pinned.
6. **A bridged command's default environment is Main's `process.env`, not the runner's layered environment.** The
   Bun runner composes its environment from `env.json` plus a working directory's `.env`; the web adapter carries
   neither, so a `child_process` call from a `browser-node` tab can inherit something different from what the same
   code sees under `bun`. A caller-supplied `env` **is** honoured exactly, so this affects the default path only.
7. **`process.memoryUsage()` is not available in `browser-node`.** That runtime's `process` is a page-load
   snapshot (`env`, `cwd()`, `platform`, `argv`, `versions`, plus a microtask-queue `nextTick`); `memoryUsage` is
   implemented nowhere in `packages/runner-web`. It is available in `bun`, which runs a real Bun process.
8. **Large collections still stop at 10,000 entries.** Paging for expanded collections was listed for M4 and did
   not land; entries past the first 10,000 aren't reachable (parity OU-02).

## Automated suites

- [ ] **Q13 Totals.** What each suite covers:
  - `bun run e2e` — every scenario against a **dev build you built first**, including the browser runtimes, the
    Web View tile and the package-free guides (canvas + rAF, Web Audio).
  - `bun run e2e:npm` — the opt-in guides that need packages (React, Three.js, and the WV-04 all-four-in-one-tab
    exit), against the loopback registry.
  - `bun run test:npm` — the npm service against the loopback registry (install, outdated, update, remove,
    install scripts).
  - `bun run test` — unit and integration, per package, on both Bun versions. The two-Bun gate is easy to fake:
    `bun14 run test` uses 1.4.0 only as the **task runner**, while each package's script is `bun test ./test`, so
    the inner binary still comes from `PATH`. The correct form is
    `PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test`, and the proof is the set of distinct
    `bun test v…` banners.
  - `bun run typecheck` needs the Electrobun devkit copied into `apps/desktop/.hutch`, whose **parent does not
    exist in a fresh worktree** — `mkdir -p` before the copy, or typecheck exits 1 without checking anything.
  - `bun run lint` — Biome truncates diagnostics by default; use `--max-diagnostics=300` until the printed headers
    reconcile with the summary counts.

  **Dev-build results, 2026-09-16 (branch `feat/jslab-m4`, parent `30da6e3`, against a freshly built dev app):**
  - `bun run lint`: exit 0 — 14 warnings, 16 infos (the accepted baseline; the 14th is Task 9f's
    `querystring-entry.js` arrow-function warning, left deliberately rather than regenerating all twelve vendor
    files for one style fix).
  - `bun run typecheck`: exit 0 across **13 packages**, each reporting individually.
  - `bun run test` (local Bun 1.3.13): **1334 pass, 0 fail** — desktop 524, ui 349 + 43 isolated, runner-web 109,
    transform 67, shared 62, npm 52, serializer 42, runner-bun 29, rpc-schema 24, e2e 11, runner-shared 9,
    themes 8, test-registry 5.
  - `bun run test` (Bun 1.4.0, via `PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH"`): **1334 pass,
    0 fail**, same per-package counts. Distinct banner set: `bun test v1.4.0 (34cbb9a40)` — the local run's set is
    `bun test v1.3.13 (bf2e2cec)`, so every inner binary really differed.
  - `bun run e2e` (dev build): **69 pass, 0 fail** across 27 files [657.89 s]. The baseline before this task's
    change was **68 pass / 1 fail**, the single failure being the M2-era `EX-24` assertion that Bun was the only
    selectable runtime — replaced here by a selector test covering all three.
  - `bun run e2e:npm` (opt-in, loopback registry): **7 pass, 0 fail** across 2 files [46.24 s]. `three@0.184.0`
    resolved from Bun's on-disk cache, so the fail-loudly path was never taken and the public registry was never
    contacted.
  - `bun run test:npm`: **8 pass, 0 fail** across 2 files (`@jslab/test-registry` 3, `@jslab/desktop` 5).

  **Canary totals: pending user.** As in M3, this run skips the packaged canary: warming a canary copy writes into
  `~/Library/Application Support/dev.jslab.app/canary`, which is out of scope for an unattended run. Use the canary
  launch, warm-up and teardown procedure in `docs/qa/m2-checklist.md`, then run `bun run e2e` and `bun run e2e:npm`
  against the canary copy the same way.
