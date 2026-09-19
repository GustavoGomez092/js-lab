# M5d Manual QA Checklist

Theming (spec §9.3) and the Keybindings settings UI (spec §6.5).

Run against the packaged canary build on macOS arm64, from a fresh canary data folder (an existing one is moved into `$JSLAB_QA_DIR`, never deleted), using the M2 launch procedure:
- Copy the `.app` to internal disk first.
- Launch it with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, from a shell whose working directory is on internal disk (R-M1-14).
- Quit from the app menu. When a script must stop it, use only the scoped, zsh-safe teardown below (R-M1-13).

These items need a real theme file and a real keyboard: automated scenarios drive the same commands over a socket, which is exactly what they cannot prove about a chord a person actually presses.

```bash
export PATH="$HOME/.hutch/bin:$PATH"
REPO="$(git rev-parse --show-toplevel)"
builtin cd "$REPO/apps/desktop" && hutch run build && builtin cd "$REPO"
: "${JSLAB_QA_DIR:?set JSLAB_QA_DIR to a folder under the session scratchpad (internal disk)}"
APP="$(ls -d apps/desktop/build/canary-macos-arm64/*.app)"
# Move an existing canary data folder into the QA folder instead of deleting it (R-M2-T25-1).
[ -d "$HOME/Library/Application Support/dev.jslab.app/canary" ] && mv "$HOME/Library/Application Support/dev.jslab.app/canary" "$JSLAB_QA_DIR/canary-data-backup-$(date +%Y%m%d-%H%M%S)"
cp -R "$APP" "$JSLAB_QA_DIR/"
builtin cd "$JSLAB_QA_DIR"
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$JSLAB_QA_DIR/$(basename "$APP")/Contents/MacOS/launcher" &
JSLAB_QA_PID=$!
builtin cd "$REPO"
```

Scripted teardown (R-M1-13, FR-6: validated the same way the launch block is, and matched by tracked PID only —
never a `pgrep -f` pattern, which degenerates to matching every process on the machine when `JSLAB_QA_DIR` is
unset and can match unrelated command lines otherwise):

```bash
: "${JSLAB_QA_DIR:?set JSLAB_QA_DIR to a folder under the session scratchpad (internal disk)}"
: "${JSLAB_QA_PID:?JSLAB_QA_PID isn't set; re-run the launch block in this same shell first}"
pids=( "$JSLAB_QA_PID" $(pgrep -P "$JSLAB_QA_PID") )
for p in "${pids[@]}"; do kill -TERM "$p"; done
sleep 5
survivors=()
for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && survivors+=("$p"); done
for p in "${survivors[@]}"; do kill -KILL "$p"; done
```

Each item passes only if the result matches exactly. Items marked **(E)** are also covered by an automated scenario, which proves the mechanism; the item here is for what automation cannot see.

## Theme importer

- [ ] **Q1 Import a real VS Code theme `.json`.** Download a theme you did not write (any published VS Code theme's `themes/*.json`) and import it with Import VS Code Theme…. The editor, the output pane, the side bar and the status bar all re-colour together, and every one of them stays readable — no grey-on-grey text, no invisible selection, no unreadable status bar. **(E for the mechanism:** `packages/e2e/scenarios/theme-import.test.ts` proves the file is converted, saved and applied; only a person can judge "looks right".**)**
- [ ] **Q2 Import a `.vsix` containing SEVERAL themes.** The picker lists every theme the extension contributes, and the one you choose is the one that applies. **This is the one importer path with no automated coverage at all** — the e2e `.vsix` scenario uses a single-theme package, which takes the one-theme shortcut in `importFrom` and never opens the picker. Cancel the picker too: nothing should change.
- [ ] **Q3 Import a light theme with Follow System Appearance on.** Set the imported light theme as the light half of the pair, then switch macOS between Light and Dark (System Settings → Appearance). JSLab follows, and the imported theme is the one used for the light side.
- [ ] **Q4 An imported theme is a first-class theme.** It appears in the **Themes menu** and in the command palette, and the menu item actually applies it (Finding T3's slug rule: the menu action carries the slugged id). It also appears in Settings → Appearance's picker.

## Keybindings editor

- [ ] **Q5 Record a chord with the mouse, then with the keyboard.** In Settings → Keybindings, click **Change** on a row and press a chord; then reach the same field by keyboard and do it again. Escape leaves an armed field without binding anything, <kbd>⇥</kbd> still moves focus out of it, and a bare letter is refused with a visible message rather than silently ignored. **(E for the capture rules:** `apps/ui/test/key-capture.test.ts` covers the decisions; only a real window proves the field is reachable and escapable.**)**
- [ ] **Q6 Bind a chord that already exists.** The conflict warning appears and **names the other command** by its title.
- [ ] **Q7 Open keybindings.json.** The button opens the file in your editor. Hand-edit it, save, and the change takes effect in the running app — the menu bar's shortcut text included — **without** relaunching. **(E for the live-apply path:** `packages/e2e/scenarios/keybindings-ui.test.ts` proves a capture reaches the running app; this item covers the hand-edit route and the "opens in your editor" half, which no scenario can drive.**)**
- [ ] **Q8 The structural escape hatch.** Save a deliberately awkward binding (for example, bind something to <kbd>⌘,</kbd>), then confirm **JSLab → Settings…** from the **menu bar** still opens Settings, so the keymap can never lock you out of the editor that repairs it. Then use **Reset All Keybindings** and confirm the defaults come back.

## Known limitations (record, don't fix in M5d)

- **`include` is not followed.** `convertVsCodeTheme` converts a theme using only what the file itself defines, plus the contrast fallbacks. A theme that inherits most of its colours from a sibling file via `include` converts to something legible but not identical to VS Code.
- **A theme whose name slugs onto a built-in id is refused** at import rather than silently shadowed, with a readable message. Renaming the theme's `name` is the way in.
- **Semantic highlighting is not imported.** Only `tokenColors` (TextMate scopes) and `colors` are mapped; a theme's `semanticTokenColors` are dropped, and the import says so in its status line when it drops them.

## Automated suites

What the automated side already proves, so these manual items stay scoped to what it cannot:

- `packages/themes/test/vscode-convert.test.ts` — the scope-to-token table and the palette derivation, against real theme fixtures.
- `apps/desktop/test/themes/zip.test.ts` — the hand-written zip reader, including refusals.
- `apps/desktop/test/rpc/theme-handlers.test.ts`, `apps/desktop/test/services/theme-store.test.ts` — the import round trip and the themes folder.
- `apps/ui/test/keybinding-rows.test.ts`, `apps/ui/test/key-capture.test.ts`, `apps/ui/test/keybindings-pane.test.tsx` — the table, the capture rules and the reset paths.
- `packages/e2e/scenarios/theme-import.test.ts`, `packages/e2e/scenarios/keybindings-ui.test.ts` — the two end-to-end scenarios this milestone added.

Record: `bun run test` per package (local Bun and the Bun 1.4.0 shim); `bun run e2e` on the dev build.

**Dev-build results, 2026-09-17 (BASE `4cbd7f0`):**

- `bun run typecheck`: exit 0 (13 packages). Repo-wide `bun run lint`: exit 0 — 574 files, 0 errors, 15 warnings, 18 infos.
- `bun run test` (local Bun 1.3.13): **exit 1** — 1766 tests across 183 files, 1765 pass / 1 fail. The single failure is `apps/desktop/test/bundling/bundler.test.ts` ("a `browser` map entry of `false` bundles an empty module instead of the package"). It **predates this milestone** — no M5d commit touches `apps/desktop/src/main/bundling` or `apps/desktop/test/bundling` — and it is a toolchain artifact rather than a defect: the test asks `Bun.build({ target: "browser" })` itself what a `false`-mapped entry produces, so the oracle's own answer changed with the Bun version.
- `bun run test` (Bun 1.4.0 shim): **exit 0** — the same 1766 tests across 183 files, 0 fail. That contrast is what identifies the 1.3.13 failure as a Bun difference.
- Per package, from the 1.3.13 run (14 totals lines; the 1.4.0 run reconciles to the same 1766/183): shared 65/8, themes 83/5, rpc-schema 48/3, runner-shared 9/1, npm 52/7, serializer 42/2, transform 67/4, test-registry 5/4, runner-web 129/14, e2e 11/4, runner-bun 33/2, ui 486/58 **+** 51/1 (two runs, both counted), desktop 685/70.
- `bun run e2e` (dev build): **82 pass, 0 fail across 32 files**, exit 0. Before this task's two scenarios the same suite measured **77 pass, 0 fail across 30 files**, and the two new files measured on their own are **5 pass, 0 fail across 2 files** — so 77 + 5 = 82 and 30 + 2 = 32.
- **Mutation check on the live-apply path.** `packages/e2e/scenarios/keybindings-ui.test.ts` is the only test of any kind that exercises `apps/desktop/src/main/index.ts`'s `keybindings.onChange` → main-window broadcast; `main/index.ts` has no unit test. Deleting that one `rpc.send["keybindings.changed"]` line and rebuilding makes the scenario fail on "the newly bound chord did not take effect without a relaunch"; restoring it (verified byte-identical) makes it pass again. The wiring is pinned by a real run, not by a unit test.
